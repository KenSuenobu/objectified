"""Export preview manifest — IXH-4.1 (#5109).

`ArtifactPreviewCard`, `BundleExplorer`, and `ReadOnlyCodeViewer` present the emitted
artifact as files and text. To answer "which of my operations made it into this
Protobuf?" a user had to read the generated code — precisely the work the canonical
model should do for them. This module makes the export preview *structural*: a
deterministic **manifest of the emitted artifact** listing every canonical entity with

* its stable **canonical key** (the provenance coordinate shared with the import
  manifest, CPDO-1.3),
* its per-entity **fidelity status** — the shared
  :class:`~app.projection_taxonomy.ProjectionStatus` /
  :class:`~app.projection_taxonomy.ProjectionReason` taxonomy, never a fourth
  vocabulary — with the drop reason stated for every entity the artifact does not
  carry, and
* its **location in the bundle** — the emitted file plus, where resolvable, the
  1-based line in that file's serialized text and/or a target pointer.

**Artifact-derived locations.** Lines are computed against the *actually emitted*
bundle, serialized exactly as the download packages it
(:func:`app.export_job_engine.serialize_file_content`), so a line the manifest claims
is the line the code viewer shows. JSON-document targets resolve locations through a
pointer→line walk of the serialized text; text targets (proto3, GraphQL SDL) resolve
declaration lines with per-family scanners; other JSON targets fall back to a
name-keyed search. An entity whose location cannot be established carries ``None`` —
a truthful "cannot point there", never a guess. This deliberately does **not** extend
the projection graph's :data:`~app.export_projection._TARGET_LOCATORS` registry (its
corpus resolution gate stays authoritative for pointer claims).

**One status derivation.** Statuses come from the EFP-1.1 projection manifest
(:func:`~app.export_projection.build_projection_manifest`) built from the same
fidelity report the preview returns — which reconciles against the report by hard
invariant — aggregated worst-first per construct. A service (absent from the report's
construct walk) aggregates the worst status of its operations.

**Determinism.** The manifest hash folds the target's format, emitter version,
apiome version, capability-registry version, and normalized options
(:func:`~app.export_projection.normalize_options_for_hash`) into a digest over the
ordered entity rows and file table — identical (revision, target, options) yield an
identical hash; an emitter or registry upgrade is a different snapshot. The emit runs
read-only (``persistence=None``, the verify route's discipline) so building a manifest
never mutates tenant state.

**Bounded output.** Entities are cursor-paginated (codec shared with the import
manifest and evidence pages); the file table and counts describe the **full**
manifest on every page, and ``truncated`` is declared whenever a page omits rows.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi
from .emitter import EmitResult, Emitter, get_emitter
from .export_dispatch import dispatch_from_source
from .export_job_engine import serialize_file_content
from .export_projection import (
    NATIVE_ID_EXTRA_KEYS,
    SOURCE_LOCATION_EXTRA_KEYS,
    ManifestTarget,
    build_projection_manifest,
    decode_page_cursor,
    encode_page_cursor,
    first_extra,
    normalize_options_for_hash,
    target_location_for_construct,
)
from .export_service import ExportError, resolve_emit_format
from .export_source import ExportSource
from .lossiness import LossinessReport, LossinessSeverity
from .projection_taxonomy import ProjectionReason, ProjectionStatus

__all__ = [
    "ArtifactEntityLocation",
    "ExportPreviewEntity",
    "ExportManifestFile",
    "ExportPreviewManifest",
    "ExportPreviewManifestRequest",
    "ExportPreviewManifestResponse",
    "build_export_preview_manifest",
    "paginate_export_preview_manifest",
    "run_export_preview_manifest",
    "clear_export_manifest_cache",
    "export_manifest_cache_size",
    "DEFAULT_ENTITY_PAGE_SIZE",
    "MAX_ENTITY_PAGE_SIZE",
    "EXPORT_MANIFEST_CACHE_MAX_ENTRIES",
]

#: Default / maximum entities per page — the same bounds the IXH-3.1 import preview
#: manifest applies, so both manifest surfaces page identically.
DEFAULT_ENTITY_PAGE_SIZE = 200
MAX_ENTITY_PAGE_SIZE = 1000

#: Per-process bound on cached full manifests (mirrors the import manifest cache).
EXPORT_MANIFEST_CACHE_MAX_ENTRIES = 32

#: Statuses under which a construct is present in the emitted artifact.
_REPRESENTED_STATUSES = frozenset(
    {
        ProjectionStatus.RETAINED,
        ProjectionStatus.TRANSFORMED,
        ProjectionStatus.APPROXIMATED,
        ProjectionStatus.SYNTHESIZED,
    }
)

#: Worst-first precedence used to pick one representative outcome per construct
#: (a construct can carry several report items) and to aggregate a service from its
#: operations. Lower index = worse.
_STATUS_PRECEDENCE: Tuple[ProjectionStatus, ...] = (
    ProjectionStatus.DROPPED,
    ProjectionStatus.UNAVAILABLE,
    ProjectionStatus.APPROXIMATED,
    ProjectionStatus.SYNTHESIZED,
    ProjectionStatus.TRANSFORMED,
    ProjectionStatus.RETAINED,
    ProjectionStatus.NOT_APPLICABLE,
)
_STATUS_RANK = {status: rank for rank, status in enumerate(_STATUS_PRECEDENCE)}


# ===========================================================================
# Wire models
# ===========================================================================


class ArtifactEntityLocation(BaseModel):
    """Where one entity lands in the emitted bundle.

    ``file`` is always present (bundle-relative, exactly the path the download
    manifest and zip use). ``line`` is the 1-based line of the entity's declaration
    in that file's serialized text, when a locator resolved one; ``pointer`` is the
    RFC 6901 JSON Pointer for JSON-document targets, when derivable. Either may be
    ``None`` independently — stated, never guessed.
    """

    model_config = ConfigDict(extra="forbid")

    file: str = Field(description="Bundle-relative path of the emitted file the entity lands in.")
    line: Optional[int] = Field(
        default=None,
        description="1-based line of the entity's declaration in the file's serialized text, "
        "when resolvable; null otherwise.",
    )
    pointer: Optional[str] = Field(
        default=None,
        description="RFC 6901 JSON Pointer into the emitted document (JSON targets), when "
        "derivable; null otherwise.",
    )


class ExportPreviewEntity(BaseModel):
    """One canonical entity row of the export preview manifest (IXH-4.1).

    A flat row of the entity tree — services → operations, channels, and
    types → fields, in the model's deterministic declaration order. ``order`` is the
    row's stable index in the *full* tree so a paginated client can interleave pages
    without re-sorting. Every row carries the fidelity outcome; a row the artifact
    does not carry (``emitted`` false) states its reason — AC: entities that exist in
    the source but not the artifact are listed with their drop reason.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Stable canonical key (``acme.PetService``, ``GET /pets/{id}``, ``User``).")
    name: str = Field(description="Source-visible name of the entity.")
    entity_kind: str = Field(description="service | operation | channel | type | field.")
    parent_key: Optional[str] = Field(
        default=None,
        description="The owning service's key on an operation, the owning type's key on a "
        "field; null elsewhere.",
    )
    order: int = Field(description="Stable 0-based index of this row in the full tree.")
    description: Optional[str] = Field(
        default=None, description="Entity description, when the source carried one."
    )
    deprecated: bool = Field(default=False, description="Whether the source marks the entity deprecated.")
    status: ProjectionStatus = Field(
        description="The entity's fidelity outcome (shared CPDO-1.3 taxonomy), worst-first "
        "over the construct's report items; a service aggregates its operations."
    )
    reason: Optional[ProjectionReason] = Field(
        default=None,
        description="Shared reason code for a non-preserved status; always present on a "
        "dropped/unavailable/approximated/synthesized entity (the drop reason).",
    )
    severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="How much the outcome matters (info / warn / critical), from the report.",
    )
    detail: str = Field(description="Human-readable explanation of the outcome.")
    target_mapping: Optional[str] = Field(
        default=None,
        description="How the construct landed in the target when not dropped (from the report).",
    )
    emitted: bool = Field(
        description="True when the artifact carries this entity (status retained / transformed "
        "/ approximated / synthesized)."
    )
    location: Optional[ArtifactEntityLocation] = Field(
        default=None,
        description="Where the entity lands in the bundle; null for a non-emitted entity or "
        "when no locator can truthfully place it.",
    )
    aggregated: bool = Field(
        default=False,
        description="True when the status was aggregated from child constructs (a service row "
        "— the fidelity report walks operations, not services).",
    )
    reported: bool = Field(
        default=True,
        description="True when the fidelity report carries an explicit outcome for this "
        "construct. False when the report is silent about it — the report is exception-"
        "based, so silence means no loss was recorded, and the row defaults to retained "
        "with this flag stating the difference.",
    )
    native_name: Optional[str] = Field(
        default=None, description="The construct's name in the source document, when recovered."
    )
    native_id: Optional[str] = Field(
        default=None, description="Source-native stable identifier, when the parser captured one."
    )
    source_location: Optional[str] = Field(
        default=None,
        description="Source location the entity came from, when the parser captured one — the "
        "same extras keys the import manifest reads (CPDO-1.3); never fabricated.",
    )


class ExportManifestFile(BaseModel):
    """One emitted file of the bundle, as the manifest addresses it."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Bundle-relative path (identical to the download manifest's).")
    media_type: Optional[str] = Field(default=None, description="The file's media type, when declared.")
    line_count: int = Field(description="Line count of the file's serialized text.")
    entity_count: int = Field(description="How many manifest entities locate into this file.")


class ExportPreviewManifest(BaseModel):
    """One page of the export preview manifest (IXH-4.1).

    Identity fields (``manifest_hash``, ``target``, counts, ``files``) always describe
    the **full** manifest; ``entities`` carries the requested page. ``truncated``
    states whether this response omits rows — truncation is declared, never silent.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(
        description="Stable content hash over the full manifest (target + versions + options "
        "+ entities + files). Identical for a fixed revision, target, and options."
    )
    target: ManifestTarget = Field(
        description="The target + version provenance block (shared with the projection manifest)."
    )
    status_counts: Dict[str, int] = Field(
        description="Full-manifest entity count per shared ProjectionStatus, zero-filled."
    )
    reason_counts: Dict[str, int] = Field(
        description="Full-manifest entity count per shared ProjectionReason, zero-filled."
    )
    entities: List[ExportPreviewEntity] = Field(
        default_factory=list, description="This page's entity rows, in stable tree order."
    )
    total_entities: int = Field(description="Entity count in the full manifest.")
    dropped_entities: int = Field(
        description="Full-manifest count of entities the artifact does not carry "
        "(status dropped or unavailable)."
    )
    files: List[ExportManifestFile] = Field(
        default_factory=list,
        description="The emitted bundle's file table (full list on every page — bounded by "
        "the bundle's file count).",
    )
    page_size: int = Field(description="The applied (clamped) entity page size.")
    next_cursor: Optional[str] = Field(
        default=None,
        description="Opaque cursor for the next entity page; null on the last page. Codec "
        "shared with the import preview manifest and the evidence pages.",
    )
    truncated: bool = Field(
        description="True when this response omits rows the full manifest has (more pages exist)."
    )


class ExportPreviewManifestRequest(BaseModel):
    """The preview-manifest request: source coordinates + target + options + page window."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id to describe.")
    version: Optional[str] = Field(
        default=None,
        description="A revision UUID, a version label (``1.0.0``), or null for the latest revision.",
    )
    target: str = Field(description="Target emitter key (``openapi``) or format key (``openapi-3.1``).")
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Per-target emit options; null/empty applies the target defaults. Folded "
        "(normalized) into the manifest hash, so different options are a different snapshot.",
    )
    cursor: Optional[str] = Field(
        default=None,
        description="Opaque entity-page cursor from a previous response; null for the first page.",
    )
    page_size: int = Field(
        default=DEFAULT_ENTITY_PAGE_SIZE,
        ge=1,
        description=f"Maximum entities per page; clamped to {MAX_ENTITY_PAGE_SIZE}.",
    )


class ExportPreviewManifestResponse(BaseModel):
    """The preview-manifest endpoint's response (IXH-4.1)."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the manifest describes.")
    version: Optional[str] = Field(default=None, description="The requested version selector, echoed.")
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label, when it has one."
    )
    manifest: ExportPreviewManifest = Field(description="The requested manifest page.")


# ===========================================================================
# Serialized-text location resolution
# ===========================================================================


def _escape_pointer_segment(segment: str) -> str:
    """RFC 6901-escape one pointer segment (``~`` → ``~0``, ``/`` → ``~1``)."""
    return segment.replace("~", "~0").replace("/", "~1")


def _unescape_pointer_segment(segment: str) -> str:
    """Reverse :func:`_escape_pointer_segment` (order matters: ``~1`` before ``~0``)."""
    return segment.replace("~1", "/").replace("~0", "~")


@dataclass
class _JsonLineIndex:
    """Line coordinates of a serialized JSON document: pointer → line, scalar values."""

    #: RFC 6901 pointer → 1-based line the pointed value's first character is on.
    lines: Dict[str, int]
    #: pointer → scalar string value, for name-keyed searches (e.g. Avro ``"name": "User"``).
    scalars: Dict[str, str]


def _index_json_lines(content: Any) -> _JsonLineIndex:
    """Map every JSON Pointer in ``content`` to its line in the serialized download text.

    Mirrors :func:`app.export_job_engine.serialize_file_content`'s layout —
    ``json.dumps(content, indent=2, ensure_ascii=False)`` — by walking the value tree
    with the same rendering rules (dict/list children each on their own line; a
    container value opens on its key's line; empty containers and scalars stay
    inline). Because the walk re-derives the exact same layout, the recorded line for
    a pointer is the line the downloaded file shows.

    Args:
        content: The emitted file's JSON-serializable content.

    Returns:
        The pointer→line index, plus a pointer→value map for string scalars.
    """
    index = _JsonLineIndex(lines={}, scalars={})

    def walk(value: Any, pointer: str, start_line: int) -> int:
        """Record ``value``'s coordinates; return the line its last character is on."""
        index.lines[pointer] = start_line
        if isinstance(value, dict) and value:
            current = start_line
            for key, child in value.items():
                current += 1  # each key opens a new line
                child_pointer = f"{pointer}/{_escape_pointer_segment(str(key))}"
                current = walk(child, child_pointer, current)
            return current + 1  # closing brace line
        if isinstance(value, list) and value:
            current = start_line
            for position, child in enumerate(value):
                current += 1
                current = walk(child, f"{pointer}/{position}", current)
            return current + 1
        if isinstance(value, str):
            index.scalars[pointer] = value
        return start_line

    walk(content, "", 1)
    return index


def _match_token(name: str) -> str:
    """Normalize a name for loose declaration matching (alnum only, casefolded)."""
    return re.sub(r"[^a-z0-9]", "", name.casefold())


@dataclass
class _EmittedFileText:
    """One emitted file with its download-serialized text and (for JSON) line index."""

    path: str
    media_type: Optional[str]
    content: Any
    text: str
    lines: List[str]
    json_index: Optional[_JsonLineIndex]


def _prepare_files(emit: EmitResult) -> List[_EmittedFileText]:
    """Serialize every emitted file exactly as the download does and index JSON content."""
    prepared: List[_EmittedFileText] = []
    for emitted in emit.files:
        text = serialize_file_content(emitted.content)
        prepared.append(
            _EmittedFileText(
                path=emitted.path,
                media_type=emitted.media_type,
                content=emitted.content,
                text=text,
                lines=text.splitlines(),
                json_index=_index_json_lines(emitted.content)
                if isinstance(emitted.content, dict)
                else None,
            )
        )
    return prepared


# --- per-family locators ----------------------------------------------------
#
# Each locator answers "where does this entity land?" against the prepared files and
# returns None when it cannot truthfully say. All scans are deterministic: files are
# visited in the emitter's (path-sorted) order and the first match wins.


def _locate_by_pointer(
    entity_kind: str, key: str, name: str, files: List[_EmittedFileText], emitter_cls: type[Emitter]
) -> Optional[ArtifactEntityLocation]:
    """JSON-document targets with a registered locator (OpenAPI): pointer → line."""
    location = target_location_for_construct(emitter_cls, key, entity_kind)
    pointer = location.json_pointer if location is not None else None
    if pointer is None:
        return None
    for file in files:
        if file.json_index is not None and pointer in file.json_index.lines:
            return ArtifactEntityLocation(
                file=file.path, line=file.json_index.lines[pointer], pointer=pointer
            )
    return None


#: proto3 declaration patterns per entity kind (module scope: compiled once).
_PROTO_PATTERNS = {
    "service": re.compile(r"^\s*service\s+(\w+)"),
    "operation": re.compile(r"^\s*rpc\s+(\w+)"),
    "type": re.compile(r"^\s*(?:message|enum)\s+(\w+)"),
    "field": re.compile(r"^\s*(?:repeated\s+|optional\s+)?[\w.<>, ]+\s(\w+)\s*=\s*\d+"),
}


def _locate_proto(
    entity_kind: str, key: str, name: str, files: List[_EmittedFileText], emitter_cls: type[Emitter]
) -> Optional[ArtifactEntityLocation]:
    """proto3: scan for ``message`` / ``enum`` / ``service`` / ``rpc`` declarations."""
    pattern = _PROTO_PATTERNS.get(entity_kind)
    if pattern is None:
        return None
    wanted = _match_token(name)
    if not wanted:
        return None
    for file in files:
        for line_number, line in enumerate(file.lines, start=1):
            match = pattern.match(line)
            if match and _match_token(match.group(1)) == wanted:
                return ArtifactEntityLocation(file=file.path, line=line_number)
    return None


_GRAPHQL_TYPE_PATTERN = re.compile(r"^(?:type|input|enum|interface|union|scalar)\s+(\w+)")
_GRAPHQL_ROOT_PATTERN = re.compile(r"^type\s+(Query|Mutation|Subscription)\b")
_GRAPHQL_FIELD_PATTERN = re.compile(r"^\s{2}(\w+)\s*[(:]")


def _locate_graphql(
    entity_kind: str, key: str, name: str, files: List[_EmittedFileText], emitter_cls: type[Emitter]
) -> Optional[ArtifactEntityLocation]:
    """GraphQL SDL: type declarations at column 0; operations as root-type fields."""
    wanted = _match_token(name)
    if not wanted:
        return None
    for file in files:
        if entity_kind == "type":
            for line_number, line in enumerate(file.lines, start=1):
                match = _GRAPHQL_TYPE_PATTERN.match(line)
                if match and _match_token(match.group(1)) == wanted:
                    return ArtifactEntityLocation(file=file.path, line=line_number)
        elif entity_kind == "operation":
            in_root = False
            for line_number, line in enumerate(file.lines, start=1):
                if _GRAPHQL_ROOT_PATTERN.match(line):
                    in_root = True
                    continue
                if in_root and line.startswith("}"):
                    in_root = False
                    continue
                if in_root:
                    match = _GRAPHQL_FIELD_PATTERN.match(line)
                    if match and _match_token(match.group(1)) == wanted:
                        return ArtifactEntityLocation(file=file.path, line=line_number)
    return None


#: Section prefixes an entity kind's declaration is expected under in a JSON document
#: target (AsyncAPI's layout; harmless elsewhere). A candidate outside every preferred
#: section still matches — it just ranks after in-section candidates.
_JSON_SECTION_PREFERENCE: Dict[str, Tuple[str, ...]] = {
    "operation": ("/operations",),
    "channel": ("/channels",),
    "type": ("/components", "/definitions"),
    "field": ("/components", "/definitions"),
}


def _locate_json_by_name(
    entity_kind: str, key: str, name: str, files: List[_EmittedFileText], emitter_cls: type[Emitter]
) -> Optional[ArtifactEntityLocation]:
    """Generic JSON-document fallback (AsyncAPI, Avro, …): name-keyed search.

    Two honest strategies, in order: a pointer whose **final segment** token-matches
    the entity's name or key (a channel/type keyed object member — emitters sanitize
    member names, so matching is over alnum-casefolded tokens), then a ``name``-keyed
    string scalar equal to the entity's name (an Avro record/field declaration).
    Candidates under the kind's expected document section rank first, then shallower
    pointers, so a nested re-use never shadows the declaration.
    """
    wanted = {_match_token(name), _match_token(key)} - {""}
    if not wanted:
        return None
    preferred = _JSON_SECTION_PREFERENCE.get(entity_kind, ())
    # (out-of-section, depth, path, line, pointer)
    candidates: List[Tuple[int, int, str, int, str]] = []

    def _add(pointer: str, line: int, path: str) -> None:
        in_section = any(pointer.startswith(prefix) for prefix in preferred) if preferred else True
        candidates.append((0 if in_section else 1, pointer.count("/"), path, line, pointer))

    for file in files:
        if file.json_index is None:
            continue
        for pointer, line in file.json_index.lines.items():
            segment = _unescape_pointer_segment(pointer.rsplit("/", 1)[-1]) if pointer else ""
            if segment and _match_token(segment) in wanted:
                _add(pointer, line, file.path)
        for pointer, value in file.json_index.scalars.items():
            if value == name and pointer.rsplit("/", 1)[-1] == "name":
                owner = pointer.rsplit("/", 1)[0]
                owner_line = file.json_index.lines.get(owner)
                if owner_line is not None:
                    _add(owner, owner_line, file.path)
    if not candidates:
        return None
    _, _, path, line, pointer = min(candidates)
    return ArtifactEntityLocation(file=path, line=line, pointer=pointer or None)


_Locator = Callable[
    [str, str, str, List[_EmittedFileText], type[Emitter]], Optional[ArtifactEntityLocation]
]

#: format-key prefix → ordered locator strategies. Only families with a verified
#: strategy appear; every other target truthfully carries no location.
_ARTIFACT_LOCATORS: Dict[str, Tuple[_Locator, ...]] = {
    "openapi": (_locate_by_pointer,),
    "proto3": (_locate_proto,),
    "graphql": (_locate_graphql,),
    "asyncapi": (_locate_json_by_name,),
    "avro": (_locate_json_by_name,),
}


def _locators_for(emitter_cls: type[Emitter]) -> Tuple[_Locator, ...]:
    """Return the artifact-locator strategies registered for ``emitter_cls``'s format."""
    fmt = emitter_cls.format or ""
    for prefix, locators in _ARTIFACT_LOCATORS.items():
        if fmt.startswith(prefix):
            return locators
    return ()


def _locate_entity(
    entity_kind: str,
    key: str,
    name: str,
    files: List[_EmittedFileText],
    emitter_cls: type[Emitter],
) -> Optional[ArtifactEntityLocation]:
    """Resolve one emitted entity's bundle location, or ``None`` when unaddressable."""
    for locator in _locators_for(emitter_cls):
        location = locator(entity_kind, key, name, files, emitter_cls)
        if location is not None:
            return location
    return None


# ===========================================================================
# Builder
# ===========================================================================


@dataclass
class _EdgeFacts:
    """The representative (worst-first) outcome for one construct key."""

    status: ProjectionStatus
    reason: Optional[ProjectionReason]
    severity: LossinessSeverity
    detail: str
    target_mapping: Optional[str]


@dataclass
class _FullExportManifest:
    """The complete (unpaginated) manifest; paginate with :func:`paginate_export_preview_manifest`."""

    manifest_hash: str
    target: ManifestTarget
    entities: List[ExportPreviewEntity]
    files: List[ExportManifestFile]
    status_counts: Dict[str, int]
    reason_counts: Dict[str, int]
    dropped_entities: int

    @property
    def total_entities(self) -> int:
        return len(self.entities)


def _severity_rank(severity: LossinessSeverity) -> int:
    """Worst-first severity rank for tie-breaking representative outcomes."""
    order = {LossinessSeverity.CRITICAL: 0, LossinessSeverity.WARN: 1, LossinessSeverity.INFO: 2}
    return order.get(severity, 3)


def _collect_edge_facts(projection_edges: Any) -> Dict[str, _EdgeFacts]:
    """Reduce the projection's outcome edges to one worst-first fact set per construct."""
    facts: Dict[str, _EdgeFacts] = {}
    for edge in projection_edges:
        key = edge.source[len("canonical:"):] if edge.source.startswith("canonical:") else edge.source
        candidate = _EdgeFacts(
            status=edge.status,
            reason=edge.reason,
            severity=edge.severity,
            detail=edge.detail,
            target_mapping=edge.target_mapping,
        )
        current = facts.get(key)
        if current is None or (
            _STATUS_RANK[candidate.status],
            _severity_rank(candidate.severity),
        ) < (_STATUS_RANK[current.status], _severity_rank(current.severity)):
            facts[key] = candidate
    return facts


def _aggregate_service_facts(operation_facts: List[_EdgeFacts]) -> _EdgeFacts:
    """A service's outcome: the worst of its operations (the report walks operations only)."""
    if not operation_facts:
        return _EdgeFacts(
            status=ProjectionStatus.RETAINED,
            reason=None,
            severity=LossinessSeverity.INFO,
            detail="structural grouping with no operations",
            target_mapping=None,
        )
    worst = min(
        operation_facts,
        key=lambda f: (_STATUS_RANK[f.status], _severity_rank(f.severity)),
    )
    return _EdgeFacts(
        status=worst.status,
        reason=worst.reason,
        severity=worst.severity,
        detail=f"aggregated from {len(operation_facts)} operation(s): {worst.detail}",
        target_mapping=None,
    )


def _default_facts(key: str) -> _EdgeFacts:
    """Fallback for a construct the report is silent about.

    The lossiness report is exception-based — a rule pack records the outcomes it has
    something to say about, and silence means no loss was recorded for the construct.
    The truthful default is therefore ``retained``; the entity row's ``reported`` flag
    (set false by the builder) states that this is a default, not an explicit claim.
    """
    return _EdgeFacts(
        status=ProjectionStatus.RETAINED,
        reason=None,
        severity=LossinessSeverity.INFO,
        detail=f"no loss recorded for {key!r} (not an explicit report outcome)",
        target_mapping=None,
    )


def _compute_export_manifest_hash(
    *,
    target: ManifestTarget,
    options: Dict[str, Any],
    entities: List[ExportPreviewEntity],
    files: List[ExportManifestFile],
) -> str:
    """Fold target/version/options + ordered entities + file table into a stable digest."""
    payload = {
        "target_format": target.format,
        "emitter_version": target.emitter_version,
        "apiome_version": target.apiome_version,
        "registry_version": target.registry_version,
        "options": options,
        "entities": [entity.model_dump(mode="json") for entity in entities],
        "files": [file.model_dump(mode="json") for file in files],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def build_export_preview_manifest(
    api: CanonicalApi,
    emitter: Union[Emitter, type[Emitter]],
    emit: EmitResult,
    *,
    options: Optional[Dict[str, Any]] = None,
    report: Optional[LossinessReport] = None,
) -> _FullExportManifest:
    """Build the complete export preview manifest for one emitted artifact.

    Pure and deterministic — no I/O, no clock. Statuses come from the projection
    manifest built for the same (api, emitter, options, report), which reconciles
    against the fidelity report by hard invariant; locations are resolved against the
    emitted files serialized exactly as the download serializes them.

    Args:
        api: The source canonical model that was exported.
        emitter: The target emitter (instance or class).
        emit: The emitter's actual output bundle for the same inputs.
        options: Per-target emit options; folded (normalized) into the manifest hash.
        report: A pre-computed lossiness report for the same inputs; recomputed when None.

    Returns:
        The internal full-manifest form; paginate with
        :func:`paginate_export_preview_manifest`.
    """
    emitter_cls: type[Emitter] = emitter if isinstance(emitter, type) else type(emitter)
    projection = build_projection_manifest(api, emitter_cls, options=options, report=report)
    facts_by_key = _collect_edge_facts(projection.projects_edges)
    files = _prepare_files(emit)

    entities: List[ExportPreviewEntity] = []
    order = 0

    def _row(
        *,
        key: str,
        name: str,
        entity_kind: str,
        extras: Dict[str, Any],
        description: Optional[str],
        deprecated: bool,
        parent_key: Optional[str],
        facts: _EdgeFacts,
        aggregated: bool = False,
        reported: bool = True,
    ) -> None:
        nonlocal order
        emitted = facts.status in _REPRESENTED_STATUSES
        location = (
            _locate_entity(entity_kind, key, name, files, emitter_cls) if emitted else None
        )
        entities.append(
            ExportPreviewEntity(
                key=key,
                name=name,
                entity_kind=entity_kind,
                parent_key=parent_key,
                order=order,
                description=description,
                deprecated=deprecated,
                status=facts.status,
                reason=facts.reason,
                severity=facts.severity,
                detail=facts.detail,
                target_mapping=facts.target_mapping,
                emitted=emitted,
                location=location,
                aggregated=aggregated,
                reported=reported,
                native_name=name,
                native_id=first_extra(extras, NATIVE_ID_EXTRA_KEYS),
                source_location=first_extra(extras, SOURCE_LOCATION_EXTRA_KEYS),
            )
        )
        order += 1

    for service in api.services:
        operation_facts = [
            facts_by_key.get(operation.key) or _default_facts(operation.key)
            for operation in service.operations
        ]
        _row(
            key=service.key,
            name=service.name,
            entity_kind="service",
            extras=service.extras,
            description=service.description,
            deprecated=False,
            parent_key=None,
            facts=_aggregate_service_facts(operation_facts),
            aggregated=True,
            reported=any(operation.key in facts_by_key for operation in service.operations),
        )
        for operation in service.operations:
            _row(
                key=operation.key,
                name=operation.name,
                entity_kind="operation",
                extras=operation.extras,
                description=operation.description,
                deprecated=operation.deprecated,
                parent_key=service.key,
                facts=facts_by_key.get(operation.key) or _default_facts(operation.key),
                reported=operation.key in facts_by_key,
            )
    for channel in api.channels:
        _row(
            key=channel.key,
            name=channel.name or channel.address,
            entity_kind="channel",
            extras=channel.extras,
            description=channel.description,
            deprecated=False,
            parent_key=None,
            facts=facts_by_key.get(channel.key) or _default_facts(channel.key),
            reported=channel.key in facts_by_key,
        )
    for type_ in api.types:
        _row(
            key=type_.key,
            name=type_.name,
            entity_kind="type",
            extras=type_.extras,
            description=type_.description,
            deprecated=type_.deprecated,
            parent_key=None,
            facts=facts_by_key.get(type_.key) or _default_facts(type_.key),
            reported=type_.key in facts_by_key,
        )
        for field in type_.fields:
            _row(
                key=field.key,
                name=field.name,
                entity_kind="field",
                extras=field.extras,
                description=field.description,
                deprecated=field.deprecated,
                parent_key=type_.key,
                facts=facts_by_key.get(field.key) or _default_facts(field.key),
                reported=field.key in facts_by_key,
            )

    located_counts: Dict[str, int] = {}
    for entity in entities:
        if entity.location is not None:
            located_counts[entity.location.file] = located_counts.get(entity.location.file, 0) + 1
    file_rows = [
        ExportManifestFile(
            path=file.path,
            media_type=file.media_type,
            line_count=len(file.lines),
            entity_count=located_counts.get(file.path, 0),
        )
        for file in files
    ]

    status_counts = {status.value: 0 for status in ProjectionStatus}
    reason_counts = {reason.value: 0 for reason in ProjectionReason}
    dropped = 0
    for entity in entities:
        status_counts[entity.status.value] += 1
        if entity.reason is not None:
            reason_counts[entity.reason.value] += 1
        if entity.status in (ProjectionStatus.DROPPED, ProjectionStatus.UNAVAILABLE):
            dropped += 1

    manifest_hash = _compute_export_manifest_hash(
        target=projection.target,
        options=normalize_options_for_hash(emitter_cls, options),
        entities=entities,
        files=file_rows,
    )

    return _FullExportManifest(
        manifest_hash=manifest_hash,
        target=projection.target,
        entities=entities,
        files=file_rows,
        status_counts=status_counts,
        reason_counts=reason_counts,
        dropped_entities=dropped,
    )


def paginate_export_preview_manifest(
    full: _FullExportManifest,
    *,
    cursor: Optional[str] = None,
    page_size: int = DEFAULT_ENTITY_PAGE_SIZE,
) -> ExportPreviewManifest:
    """Slice one deterministic entity page out of a full manifest.

    Args:
        full: The full manifest from :func:`build_export_preview_manifest`.
        cursor: Opaque cursor from a previous page, or ``None`` for the first page.
        page_size: Maximum entities per page (clamped to ``[1, MAX_ENTITY_PAGE_SIZE]``).

    Returns:
        The page as the wire :class:`ExportPreviewManifest`.

    Raises:
        ValueError: When ``cursor`` is malformed.
    """
    limit = max(1, min(int(page_size), MAX_ENTITY_PAGE_SIZE))
    start = decode_page_cursor(cursor) if cursor else 0
    page = full.entities[start : start + limit]
    next_start = start + limit
    next_cursor = encode_page_cursor(next_start) if next_start < full.total_entities else None
    return ExportPreviewManifest(
        manifest_hash=full.manifest_hash,
        target=full.target,
        status_counts=dict(full.status_counts),
        reason_counts=dict(full.reason_counts),
        entities=page,
        total_entities=full.total_entities,
        dropped_entities=full.dropped_entities,
        files=list(full.files),
        page_size=limit,
        next_cursor=next_cursor,
        truncated=next_cursor is not None or start > 0,
    )


# ===========================================================================
# Cache + orchestration
# ===========================================================================

#: Per-process cache of full manifests keyed by (tenant, resolved revision, target
#: format, normalized options). The resolved revision id pins the content — a new
#: revision is a different key — so no fingerprint re-validation is needed; the bound
#: keeps large manifests from pinning memory. Paging re-runs nothing.
_manifest_cache: "OrderedDict[str, _FullExportManifest]" = OrderedDict()


def clear_export_manifest_cache() -> None:
    """Drop every cached full manifest (tests and process-level reloads)."""
    _manifest_cache.clear()


def export_manifest_cache_size() -> int:
    """Return how many full manifests are currently cached in this process."""
    return len(_manifest_cache)


def _cache_key(
    tenant_id: str, version_record_id: str, target_format: str, emitter_cls: type[Emitter],
    options: Optional[Dict[str, Any]],
) -> str:
    """The manifest cache key — everything that can change the built manifest."""
    normalized = normalize_options_for_hash(emitter_cls, options)
    blob = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "|".join((tenant_id, version_record_id, target_format, blob))


def _cache_store(key: str, full: _FullExportManifest) -> None:
    """Insert a full manifest, evicting the least recently used when over the bound."""
    _manifest_cache[key] = full
    _manifest_cache.move_to_end(key)
    while len(_manifest_cache) > EXPORT_MANIFEST_CACHE_MAX_ENTRIES:
        _manifest_cache.popitem(last=False)


def run_export_preview_manifest(
    source: ExportSource,
    request: ExportPreviewManifestRequest,
    *,
    tenant_id: str,
) -> ExportPreviewManifestResponse:
    """Produce the export preview manifest for one (source, target) pair (IXH-4.1).

    Emits the artifact **read-only** (``persistence=None`` — the verify route's
    discipline, so building a manifest never persists field identities or blocks on a
    severe conversion), builds the full manifest, caches it per (tenant, revision,
    target, options), and returns the requested page. A repeat request for another
    page is served from the cache without re-emitting.

    Args:
        source: The loaded export source (the caller resolves tenant/artifact/version).
        request: Target + options + page window.
        tenant_id: The authenticated tenant id (cache scoping).

    Returns:
        The response with the requested manifest page.

    Raises:
        ExportError: When the target is unknown (400), its options are invalid (422),
            or the emitter produced no document (422).
        ValueError: When the request's ``cursor`` is malformed.
    """
    target_format = resolve_emit_format(request.target)
    emitter_cls = get_emitter(target_format)
    key = _cache_key(tenant_id, source.version_record_id, target_format, emitter_cls, request.options)

    full = _manifest_cache.get(key)
    if full is not None:
        _manifest_cache.move_to_end(key)
    else:
        # confirm=True: a severe conversion is *described* here, not blocked — the
        # manifest exists precisely to show what such an export would lose.
        dispatch = dispatch_from_source(
            source,
            request.target,
            options=request.options,
            dry_run=False,
            confirm=True,
            persistence=None,
        )
        if dispatch.emit is None:  # pragma: no cover - a real dispatch always emits
            raise ExportError(
                f"Target {request.target!r} produced no document for this source.",
                status_code=422,
            )
        full = build_export_preview_manifest(
            source.api,
            emitter_cls,
            dispatch.emit,
            options=request.options,
            report=dispatch.fidelity.report,
        )
        _cache_store(key, full)

    page = paginate_export_preview_manifest(
        full, cursor=request.cursor, page_size=request.page_size
    )
    return ExportPreviewManifestResponse(
        artifact=source.artifact_id,
        version=request.version,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
        manifest=page,
    )
