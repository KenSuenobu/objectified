"""Multi-file and archive intake explorer — IXH-3.5 (#5107).

The IXH-3.1 preview manifest answers *what an import would create*. For a bundle —
an uploaded ``.zip``/``.tar.gz`` or a git selection packed as one (MFI-29.1 / 29.2 /
29.3) — that answer is incomplete in a way that matters: a single grade and a single
entity tree cannot say which of the thirty files failed, which were never read, which
import could not be resolved, or that the entry point the detector picked is the wrong
one. That is the failure mode which makes multi-file gRPC imports frustrating today.

This module adds the missing half: a **bundle inventory** for the preview step.

``POST /v1/tenants/{tenant}/import/bundle-inventory`` unpacks the candidate through the
*same* MFI-29.1 archive intake the commit uses (this module re-implements no archive
handling), runs the *same* IXH-2.1 pre-flight the quality step already ran — so the run
is served from the pre-flight's own cache rather than parsing the bundle twice — and
returns, for every file the upload contained:

* its **role** — entry point, dependency, unreferenced, ignored, unreadable — where an
  *ignored* file always states **why** it was ignored (resource fork, VCS metadata,
  dotfile, non-regular entry), because a file the user put in the archive is never
  allowed to simply vanish;
* its **verdict** and, when the parse reported a diagnostic naming it, that file's
  **error** verbatim — lifted out of the compiler's single error string
  (:func:`~app.intake_bundle_graph.diagnostics_by_member`) so the failing file is
  marked rather than the whole upload blamed;
* its **import/include edges**, resolved against the bundle, and its incoming edges;
* the **canonical entities it appears to contribute**, by declaration scan
  (:data:`~app.intake_bundle_graph.ATTRIBUTION_METHOD` — evidence, not parser
  provenance, and every surface says so).

Alongside the files it returns every **unresolved** import with *the search paths that
were tried, in order*, and the ranked **entry-point candidates** — the same ranking
:func:`~app.archive_intake.resolve_fileset_root` decides with, so the user's override
picks from what auto-detection actually considered. Overriding is then a plain re-run:
the client sends the chosen member as ``archive_root`` and the pre-flight, manifest, and
inventory all re-derive from it. Nothing here writes.

**Degradation is the point.** A bundle whose root is ambiguous, or whose parse failed,
is exactly the bundle a user needs this panel for — so root-resolution failure and
pre-flight failure both still return the full file list, with the reason attached,
instead of collapsing to an error. Only an archive that cannot be *unpacked* has no
inventory to give.

**Bounded.** Files are cursor-paginated (the cursor codec is shared with the export
evidence pages and the import manifest); unresolved imports ride the first page and are
capped with the full total always stated; and one process-wide LRU keeps the built
inventory so paging a few hundred files never re-unpacks the archive.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .archive_intake import (
    ArchiveIntakeError,
    IgnoredMember,
    is_archive_payload,
    rank_root_candidates,
    resolve_fileset_root,
    unpack_archive_members,
)
from .export_projection import decode_page_cursor, encode_page_cursor
from .import_preflight import run_import_preflight
from .import_source_pipeline import ImportRunArtifacts, build_job_error
from .intake_bundle_graph import (
    ATTRIBUTION_METHOD,
    MAX_ENTITY_KEYS_PER_FILE,
    BundleFileRole,
    BundleFileVerdict,
    EntityRef,
    ImportResolution,
    ResolvedImport,
    attribute_entities,
    classify_roles,
    diagnostics_by_member,
    resolve_bundle_imports,
    unreadable_reason,
)
from .models import ImportPreflightRequest, SpecImportJobError

logger = logging.getLogger(__name__)

__all__ = [
    "BundleFileEntry",
    "BundleImportEdge",
    "BundleRootCandidate",
    "DEFAULT_FILE_PAGE_SIZE",
    "ImportBundleInventory",
    "ImportBundleInventoryRequest",
    "ImportBundleInventoryResponse",
    "MAX_FILE_PAGE_SIZE",
    "MAX_UNRESOLVED_LISTED",
    "BUNDLE_INVENTORY_CACHE_MAX_ENTRIES",
    "bundle_inventory_cache_size",
    "build_bundle_inventory",
    "clear_bundle_inventory_cache",
    "paginate_bundle_inventory",
    "run_import_bundle_inventory",
]

#: Default and hard-cap file page sizes. A "few hundred files" bundle — the scale the
#: ticket names — therefore arrives in a single page at the default.
DEFAULT_FILE_PAGE_SIZE = 250
MAX_FILE_PAGE_SIZE = 1000

#: Unresolved imports enumerated on the first page. The total is always exact, so a
#: bundle with thousands of broken references states the number even when it lists a
#: prefix of them.
MAX_UNRESOLVED_LISTED = 200

#: Entry-point candidates offered to the picker. Beyond a handful the list stops being
#: a choice and starts being the file list, which the panel already shows.
MAX_ROOT_CANDIDATES = 25

#: Built inventories held per process (they carry one entry per bundle file, so the
#: bound matches the preview manifest cache's order of magnitude).
BUNDLE_INVENTORY_CACHE_MAX_ENTRIES = 16


# ===========================================================================
# Wire models
# ===========================================================================


class BundleImportEdge(BaseModel):
    """One import/include reference a bundle file declares, and how it resolved."""

    model_config = ConfigDict(extra="forbid")

    from_path: str = Field(description="Bundle-relative path of the file declaring the reference.")
    directive: str = Field(description="The directive as the format names it (import, include, $ref, …).")
    target: str = Field(description="The reference exactly as the source document wrote it.")
    to_path: Optional[str] = Field(
        default=None, description="The bundle member it resolved to, when it resolved to one."
    )
    resolution: ImportResolution = Field(
        description="member (resolved inside the bundle), provided (supplied by the format's "
        "own toolchain, e.g. the protobuf well-known types), or unresolved."
    )
    provider: Optional[str] = Field(
        default=None,
        description="What supplies a 'provided' reference; null for every other resolution.",
    )
    search_paths: List[str] = Field(
        default_factory=list,
        description="Every bundle-relative path tried, in the order tried. This is the answer "
        "to 'where did you look?' for an unresolved reference.",
    )
    line: int = Field(description="1-based line of the directive within its file.")


class BundleFileEntry(BaseModel):
    """One file the bundle contained, with its role, verdict, and contribution."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Bundle-relative path (POSIX, never absolute).")
    role: BundleFileRole = Field(
        description="entry-point, dependency, unreferenced, ignored, or unreadable."
    )
    verdict: BundleFileVerdict = Field(
        description="analysed, failed (a parse diagnostic names this file), or not-analysed."
    )
    bytes: int = Field(description="Size of the decoded member in UTF-8 bytes; 0 for an ignored entry.")
    lines: int = Field(description="Line count of the decoded member; 0 when it was not analysed.")
    ignored_reason: Optional[str] = Field(
        default=None,
        description="Why an ignored file was excluded (resource-fork, vcs-metadata, os-metadata, "
        "hidden-file, not-a-regular-file). Always set when role is 'ignored'.",
    )
    error: Optional[str] = Field(
        default=None,
        description="The parse diagnostic naming this file, or why an unreadable file could not "
        "be read. Null when the file has no fault of its own.",
    )
    imports: List[BundleImportEdge] = Field(
        default_factory=list, description="Outgoing import/include references this file declares."
    )
    imported_by: List[str] = Field(
        default_factory=list, description="Bundle members whose resolved references point at this file."
    )
    entity_keys: List[str] = Field(
        default_factory=list,
        description=f"Canonical entity keys attributed to this file, capped at "
        f"{MAX_ENTITY_KEYS_PER_FILE}; entity_count is always the exact total.",
    )
    entity_count: int = Field(
        default=0, description="Exact number of canonical entities attributed to this file."
    )


class BundleRootCandidate(BaseModel):
    """One member that could serve as the bundle's entry point."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Bundle-relative member path.")
    format: Optional[str] = Field(default=None, description="Detected format key, when recognised.")
    confidence: float = Field(description="Detection confidence for this member, 0–1.")
    selected: bool = Field(description="Whether this candidate is the entry point in use.")


class ImportBundleInventory(BaseModel):
    """One page of the bundle inventory (IXH-3.5)."""

    model_config = ConfigDict(extra="forbid")

    entry_point: Optional[str] = Field(
        default=None,
        description="The root document the import parses from, or null when no root could be "
        "resolved (entry_point_error then says why).",
    )
    entry_point_pinned: bool = Field(
        description="True when the request named the entry point (archive_root); false when it "
        "was auto-detected.",
    )
    entry_point_error: Optional[str] = Field(
        default=None,
        description="Why root resolution failed — an ambiguous bundle, or one with no "
        "recognisable document. The file list is still complete.",
    )
    entry_point_candidates: List[BundleRootCandidate] = Field(
        default_factory=list,
        description="Ranked members that could be the entry point, best first — the same "
        f"ranking auto-detection uses, capped at {MAX_ROOT_CANDIDATES}.",
    )
    attribution: str = Field(
        description="How per-file entity contribution was derived. 'declaration-scan' means the "
        "file declares a symbol matching the entity's name — evidence, not parser provenance.",
    )
    files: List[BundleFileEntry] = Field(
        default_factory=list, description="This page of the file list, in path order."
    )
    total_files: int = Field(description="Files in the whole bundle (members plus ignored entries).")
    role_counts: Dict[str, int] = Field(
        default_factory=dict, description="Whole-bundle tally per role, zero-filled."
    )
    verdict_counts: Dict[str, int] = Field(
        default_factory=dict, description="Whole-bundle tally per verdict, zero-filled."
    )
    unresolved: List[BundleImportEdge] = Field(
        default_factory=list,
        description=f"Unresolved import/include references, capped at {MAX_UNRESOLVED_LISTED} and "
        "carried on the first page only.",
    )
    total_unresolved: int = Field(description="Unresolved references in the whole bundle.")
    total_edges: int = Field(description="Import/include references in the whole bundle.")
    total_entities: int = Field(description="Canonical entities the import would create.")
    unattributed_entities: int = Field(
        description="Canonical entities no file's declarations matched. Non-zero is normal for "
        "synthesized names — it is stated rather than hidden.",
    )
    page_size: int = Field(description="The applied (clamped) page size.")
    next_cursor: Optional[str] = Field(
        default=None, description="Opaque cursor for the next page, or null on the last page."
    )
    truncated: bool = Field(description="True whenever this response omits part of the inventory.")


class ImportBundleInventoryRequest(ImportPreflightRequest):
    """The candidate to inventory: the IXH-2.1 pre-flight intake payload plus paging."""

    cursor: Optional[str] = Field(
        default=None, description="Opaque cursor from a previous page; omit for the first page."
    )
    page_size: int = Field(
        default=DEFAULT_FILE_PAGE_SIZE,
        ge=1,
        le=MAX_FILE_PAGE_SIZE,
        description=f"Files per page (default {DEFAULT_FILE_PAGE_SIZE}, max {MAX_FILE_PAGE_SIZE}).",
    )


class ImportBundleInventoryResponse(BaseModel):
    """The bundle-inventory endpoint's response (IXH-3.5).

    ``kind`` is the first thing a client reads: a single document is not a bundle, and
    saying so is not an error — the panel simply has nothing to show. ``ok`` is false
    only when an archive could not be unpacked at all, in which case ``error`` carries
    the intake-taxonomy code.
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(
        description="True when an inventory was produced; false only when the archive "
        "could not be unpacked.",
    )
    kind: str = Field(description="'archive' for a bundle payload, 'single-document' otherwise.")
    inventory: Optional[ImportBundleInventory] = Field(
        default=None, description="The inventory page; null when ok is false or kind is single-document."
    )
    error: Optional[SpecImportJobError] = Field(
        default=None, description="Stable intake-taxonomy error when the archive could not be unpacked."
    )


# ===========================================================================
# Build
# ===========================================================================


@dataclass
class _FullInventory:
    """The complete, unpaginated inventory one build produces (cached per content hash)."""

    entry_point: Optional[str]
    entry_point_pinned: bool
    entry_point_error: Optional[str]
    candidates: List[BundleRootCandidate]
    files: List[BundleFileEntry]
    role_counts: Dict[str, int]
    verdict_counts: Dict[str, int]
    unresolved: List[BundleImportEdge] = field(default_factory=list)
    total_edges: int = 0
    total_entities: int = 0
    unattributed_entities: int = 0


def _edge_model(edge: ResolvedImport) -> BundleImportEdge:
    """Project one resolved edge onto its wire model."""
    return BundleImportEdge(
        from_path=edge.from_path,
        directive=edge.directive,
        target=edge.target,
        to_path=edge.to_path,
        resolution=edge.resolution,
        provider=edge.provider,
        search_paths=list(edge.search_paths),
        line=edge.line,
    )


def _entity_refs(model: object) -> List[EntityRef]:
    """Flatten a canonical model into the identities attribution matches against.

    Typed loosely so this module does not have to import the canonical model just to
    read four attributes off it; a model missing any of them simply contributes none.
    """
    refs: List[EntityRef] = []
    for service in getattr(model, "services", ()) or ():
        refs.append(EntityRef(key=service.key, name=service.name or service.key))
        for operation in getattr(service, "operations", ()) or ():
            refs.append(EntityRef(key=operation.key, name=operation.name or operation.key))
    for channel in getattr(model, "channels", ()) or ():
        refs.append(
            EntityRef(key=channel.key, name=channel.name or channel.address or channel.key)
        )
    for type_ in getattr(model, "types", ()) or ():
        refs.append(EntityRef(key=type_.key, name=type_.name or type_.key))
    return refs


def build_bundle_inventory(
    members: Dict[str, str],
    ignored: List[IgnoredMember],
    *,
    entry_point: Optional[str],
    entry_point_pinned: bool,
    entry_point_error: Optional[str],
    parse_error: Optional[str] = None,
    model: object = None,
) -> _FullInventory:
    """Assemble the complete inventory for one unpacked bundle.

    Pure: every input is already materialised, so the build does no I/O and no clock
    read, and a fixed bundle always produces the same inventory (which is what makes
    caching it and paging over it safe).

    Args:
        members: Decoded member text keyed by bundle-relative path.
        ignored: Entries the unpack skipped, each with its reason.
        entry_point: The resolved root document, or ``None``.
        entry_point_pinned: Whether the caller named the entry point.
        entry_point_error: Why root resolution failed, when it did.
        parse_error: The pre-flight's error message, when the parse failed — mined for
            per-file diagnostics.
        model: The canonical model the pre-flight produced, when it produced one.

    Returns:
        The :class:`_FullInventory`, ordered by path.
    """
    unreadable: Dict[str, str] = {}
    for path, text in members.items():
        reason = unreadable_reason(path, text)
        if reason is not None:
            unreadable[path] = reason
    readable = sorted(set(members) - set(unreadable))

    edges = resolve_bundle_imports(members, entry_point=entry_point, readable=readable)
    roles = classify_roles(
        members, entry_point=entry_point, edges=edges, unreadable=unreadable.keys()
    )

    outgoing: Dict[str, List[BundleImportEdge]] = {}
    incoming: Dict[str, List[str]] = {}
    unresolved: List[BundleImportEdge] = []
    for edge in edges:
        wire = _edge_model(edge)
        outgoing.setdefault(edge.from_path, []).append(wire)
        if edge.resolution is ImportResolution.MEMBER and edge.to_path:
            bucket = incoming.setdefault(edge.to_path, [])
            if edge.from_path not in bucket:
                bucket.append(edge.from_path)
        elif edge.resolution is ImportResolution.UNRESOLVED:
            unresolved.append(wire)

    refs = _entity_refs(model) if model is not None else []
    keys_by_path, count_by_path, unattributed = attribute_entities(
        members, refs, readable=readable
    )
    diagnostics = diagnostics_by_member(parse_error or "", members)

    files: List[BundleFileEntry] = []
    for path in sorted(members):
        role = roles[path]
        text = members[path]
        unreadable_note = unreadable.get(path)
        diagnostic = diagnostics.get(path)
        if unreadable_note is not None:
            verdict = BundleFileVerdict.NOT_ANALYSED
        elif diagnostic is not None:
            verdict = BundleFileVerdict.FAILED
        else:
            verdict = BundleFileVerdict.ANALYSED
        files.append(
            BundleFileEntry(
                path=path,
                role=role,
                verdict=verdict,
                bytes=len(text.encode("utf-8", errors="replace")),
                lines=0 if unreadable_note is not None else text.count("\n") + 1,
                error=diagnostic or unreadable_note,
                imports=outgoing.get(path, []),
                imported_by=incoming.get(path, []),
                entity_keys=keys_by_path.get(path, []),
                entity_count=count_by_path.get(path, 0),
            )
        )
    for entry in ignored:
        files.append(
            BundleFileEntry(
                path=entry.path,
                role=BundleFileRole.IGNORED,
                verdict=BundleFileVerdict.NOT_ANALYSED,
                bytes=0,
                lines=0,
                ignored_reason=entry.reason,
            )
        )
    files.sort(key=lambda entry: entry.path)

    role_counts = {role.value: 0 for role in BundleFileRole}
    verdict_counts = {verdict.value: 0 for verdict in BundleFileVerdict}
    for entry in files:
        role_counts[entry.role.value] += 1
        verdict_counts[entry.verdict.value] += 1

    candidates = [
        BundleRootCandidate(
            path=candidate.path,
            format=candidate.format,
            confidence=candidate.confidence,
            selected=candidate.path == entry_point,
        )
        for candidate in rank_root_candidates(members)[:MAX_ROOT_CANDIDATES]
    ]
    # A pinned entry point that scores below the cut-off must still appear selected in
    # the picker, or the control would render as if nothing were chosen.
    if entry_point is not None and not any(candidate.selected for candidate in candidates):
        candidates.insert(
            0,
            BundleRootCandidate(path=entry_point, format=None, confidence=0.0, selected=True),
        )

    return _FullInventory(
        entry_point=entry_point,
        entry_point_pinned=entry_point_pinned,
        entry_point_error=entry_point_error,
        candidates=candidates,
        files=files,
        role_counts=role_counts,
        verdict_counts=verdict_counts,
        unresolved=unresolved,
        total_edges=len(edges),
        total_entities=len(refs),
        unattributed_entities=len(unattributed),
    )


def paginate_bundle_inventory(
    full: _FullInventory,
    *,
    cursor: Optional[str] = None,
    page_size: int = DEFAULT_FILE_PAGE_SIZE,
) -> ImportBundleInventory:
    """Slice one deterministic file page out of a full inventory.

    Unresolved references ride the **first** page only — the same rule the preview
    manifest uses for its document-scope rows — so a client walking every page sees
    each of them exactly once.

    Args:
        full: The inventory from :func:`build_bundle_inventory`.
        cursor: Opaque cursor from a previous page, or ``None`` for the first page.
        page_size: Maximum files per page (clamped to ``[1, MAX_FILE_PAGE_SIZE]``).

    Returns:
        The page as the wire :class:`ImportBundleInventory`.

    Raises:
        ValueError: When ``cursor`` is malformed.
    """
    limit = max(1, min(int(page_size), MAX_FILE_PAGE_SIZE))
    start = decode_page_cursor(cursor) if cursor else 0
    page = full.files[start : start + limit]
    next_start = start + limit
    next_cursor = encode_page_cursor(next_start) if next_start < len(full.files) else None
    unresolved = full.unresolved[:MAX_UNRESOLVED_LISTED] if start == 0 else []

    return ImportBundleInventory(
        entry_point=full.entry_point,
        entry_point_pinned=full.entry_point_pinned,
        entry_point_error=full.entry_point_error,
        entry_point_candidates=full.candidates,
        attribution=ATTRIBUTION_METHOD,
        files=page,
        total_files=len(full.files),
        role_counts=dict(full.role_counts),
        verdict_counts=dict(full.verdict_counts),
        unresolved=unresolved,
        total_unresolved=len(full.unresolved),
        total_edges=full.total_edges,
        total_entities=full.total_entities,
        unattributed_entities=full.unattributed_entities,
        page_size=limit,
        next_cursor=next_cursor,
        truncated=next_cursor is not None
        or start > 0
        or len(full.unresolved) > MAX_UNRESOLVED_LISTED,
    )


# ===========================================================================
# Cache + run
# ===========================================================================

_inventory_cache: "OrderedDict[str, _FullInventory]" = OrderedDict()


def clear_bundle_inventory_cache() -> None:
    """Drop every cached inventory (test hook, and a deployment-level reset)."""
    _inventory_cache.clear()


def bundle_inventory_cache_size() -> int:
    """Return how many full inventories are currently cached in this process."""
    return len(_inventory_cache)


def _cache_key(tenant_id: str, content_hash: str, request: ImportPreflightRequest) -> str:
    """The inventory cache key — everything that can change the built inventory."""
    return "|".join(
        (
            tenant_id,
            content_hash,
            (request.source_kind or "").strip().lower() or "auto",
            request.import_target or "",
            (request.archive_root or "").strip(),
        )
    )


def _cache_store(key: str, full: _FullInventory) -> None:
    """Insert a full inventory, evicting the least recently used when over the bound."""
    _inventory_cache[key] = full
    _inventory_cache.move_to_end(key)
    while len(_inventory_cache) > BUNDLE_INVENTORY_CACHE_MAX_ENTRIES:
        _inventory_cache.popitem(last=False)


def _resolve_entry_point(
    members: Dict[str, str], requested: Optional[str]
) -> Tuple[Optional[str], bool, Optional[str]]:
    """Choose the bundle's entry point, degrading to "none, and here is why".

    An ambiguous bundle is the case the picker exists for, so a resolution failure is
    reported and the inventory continues — the file list is what the user needs in
    order to choose.

    Args:
        members: Decoded member text keyed by bundle-relative path.
        requested: The caller-pinned root (``archive_root``), when given.

    Returns:
        ``(entry_point, pinned, error)``.
    """
    pinned = bool((requested or "").strip())
    try:
        root, _detection, _ambiguous = resolve_fileset_root(
            members, explicit_root=requested, where=""
        )
        return root, pinned, None
    except ArchiveIntakeError as exc:
        return None, pinned, str(exc)


def _bundle_members(
    raw: bytes, filename: Optional[str]
) -> Tuple[Dict[str, str], List[IgnoredMember]]:
    """Unpack the payload into members plus the entries the unpack skipped.

    Raises:
        ArchiveIntakeError: When the archive is invalid or breaches a sandbox limit.
    """
    ignored: List[IgnoredMember] = []
    members = unpack_archive_members(raw, source_label=filename, ignored=ignored)
    return members, ignored


async def run_import_bundle_inventory(
    request: ImportBundleInventoryRequest,
    *,
    tenant_id: str,
    tenant_slug: str,
    user_id: Optional[str] = None,
) -> ImportBundleInventoryResponse:
    """Produce the bundle inventory for one candidate payload (IXH-3.5).

    Args:
        request: The candidate payload, its intake hints (including a pinned
            ``archive_root``), and the page window.
        tenant_id: The tenant the run is scoped to (cache key + pre-flight scope).
        tenant_slug: The tenant's slug, recorded on the pipeline payload.
        user_id: The requesting user (provenance only; nothing is written).

    Returns:
        The response. ``kind`` is ``single-document`` for a payload that is not a
        bundle; ``ok`` is false only when the archive could not be unpacked.

    Raises:
        ValueError: When the request's ``cursor`` is malformed.
    """
    try:
        raw = base64.standard_b64decode(request.document_base64)
    except (binascii.Error, ValueError):
        return ImportBundleInventoryResponse(
            ok=False,
            kind="single-document",
            error=build_job_error(
                "INPUT_ENCODING_INVALID", "The payload is not valid base64 and could not be read."
            ),
        )

    if not is_archive_payload(raw, request.filename):
        return ImportBundleInventoryResponse(ok=True, kind="single-document")

    content_hash = hashlib.sha256(raw).hexdigest()
    preflight_request = ImportPreflightRequest(
        **request.model_dump(exclude={"cursor", "page_size"}, exclude_none=True)
    )
    cache_key = _cache_key(tenant_id, content_hash, preflight_request)
    cached = _inventory_cache.get(cache_key)
    if cached is not None:
        _inventory_cache.move_to_end(cache_key)
        return ImportBundleInventoryResponse(
            ok=True,
            kind="archive",
            inventory=paginate_bundle_inventory(
                cached, cursor=request.cursor, page_size=request.page_size
            ),
        )

    try:
        members, ignored = _bundle_members(raw, request.filename)
    except ArchiveIntakeError as exc:
        return ImportBundleInventoryResponse(
            ok=False,
            kind="archive",
            error=build_job_error(exc.code, str(exc)),
        )

    entry_point, pinned, entry_point_error = _resolve_entry_point(
        members, request.archive_root
    )

    # The same pre-flight the quality step already ran for these bytes: it is cached
    # per tenant and content hash, so the inventory rides that run rather than parsing
    # the bundle a second time. A failed pre-flight is not fatal here — its error
    # message is precisely what names the failing file.
    artifacts = ImportRunArtifacts()
    parse_error: Optional[str] = None
    model: object = None
    try:
        report = await run_import_preflight(
            preflight_request,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            user_id=user_id,
            artifacts=artifacts,
        )
        model = artifacts.model
        if not report.ok and report.error is not None:
            parse_error = report.error.message
    except Exception:  # noqa: BLE001 - the inventory must survive any pre-flight fault
        logger.warning("bundle inventory pre-flight failed; continuing without it", exc_info=True)

    full = build_bundle_inventory(
        members,
        ignored,
        entry_point=entry_point,
        entry_point_pinned=pinned,
        entry_point_error=entry_point_error,
        parse_error=parse_error,
        model=model,
    )
    _cache_store(cache_key, full)
    return ImportBundleInventoryResponse(
        ok=True,
        kind="archive",
        inventory=paginate_bundle_inventory(
            full, cursor=request.cursor, page_size=request.page_size
        ),
    )
