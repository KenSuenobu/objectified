"""Cross-target export projection manifest — EFP-1.1 (#4810).

The export fidelity surface already predicts *what* an export loses: MFX-2.2
(:mod:`app.fidelity_engine`) walks a :class:`~app.canonical_model.CanonicalApi`
against a target's :class:`~app.emitter.CapabilityProfile` and returns a
:class:`~app.lossiness.LossinessReport` — one ``OK`` / ``APPROX`` / ``SYNTH`` /
``DROP`` outcome per construct. What it does **not** give is a *traceable
relationship*: a user reading "``User.email`` was approximated" cannot see the
source evidence it came from, the canonical construct it maps to, or where (if
anywhere) it lands in the generated artifact, nor *why* the change happened.

This module is that missing relationship — the **projection manifest**. It
generalizes CPDO-1.3's catalog-to-OpenAPI manifest across *every* registered
export emitter: for a source revision, a target, and an option set it produces a
deterministic graph of **nodes** (native source evidence → canonical construct →
target location) and **edges** (each carrying a projection *status* and a *reason
code*), reconciled construct-for-construct with the existing
:class:`~app.lossiness.LossinessReport` so the two can never disagree.

**Status + reason taxonomy** (the shared export-fidelity contract):

* :class:`ProjectionStatus` — the fate of a construct in the target:
  ``retained`` / ``transformed`` / ``approximated`` / ``synthesized`` /
  ``dropped`` / ``unavailable`` / ``not-applicable``. The four the
  :class:`~app.lossiness.LossinessReport` produces map one-to-one
  (``ok→retained``, ``approx→approximated``, ``synth→synthesized``,
  ``drop→dropped``); ``transformed`` / ``unavailable`` / ``not-applicable`` extend
  the vocabulary for richer emitter rule packs and the capability registry
  (EFP-1.2).
* :class:`ProjectionReason` — the *cause category* of a non-preserved status:
  ``destination_unsupported`` / ``emitter_unsupported`` / ``source_incomplete`` /
  ``source_parse_limit`` / ``option_excluded`` / ``security_redacted`` /
  ``target_tool_unavailable`` / ``not_applicable``. Because the default report is
  driven by the *destination's* capability profile, a capability-driven loss is
  truthfully ``destination_unsupported`` — the manifest never blames the
  destination format for what is really an emitter or source-analysis gap.

**Determinism.** :func:`build_projection_manifest` is pure — no I/O, no clock —
and derives everything from the (deterministic) report plus the source model, so
identical ``(revision, target, options, emitter version)`` inputs yield identical
node/edge IDs, ordering, status counts, and a stable :attr:`~ProjectionManifest.manifest_hash`.
The hash folds the target format, the emitter version, the apiome version, and the
normalized options into the digest, so an emitter upgrade or an option change is a
*different* snapshot. :func:`build_export_projection_summary` reduces a manifest to
the bounded :class:`ProjectionManifestSummary` embedded in the shared
:class:`~app.export_fidelity.ExportFidelity` envelope, so a preview, a verify, a CLI
JSON dump, and a completed job all reference the same snapshot hash without carrying
the (potentially large) node/edge graph inline — that is retrieved page by page via
:func:`paginate_evidence`.

**Truthful fallback.** A target for which no detailed target-location adapter is
registered still gets a manifest: every construct's status and reason come from the
report, and the target location is simply left ``None`` (an honest "we cannot point
to where this landed") rather than a fabricated pointer — the manifest never
pretends an export is lossless when the report says otherwise.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections import defaultdict
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import __version__
from .canonical_model import ApiParadigm, CanonicalApi
from .capability_registry import (
    REGISTRY_VERSION,
    DestinationAvailability,
    DocumentationEvidence,
    capability_for,
    documentation_for,
    explanation_for,
)
from .emitter import (
    CapabilityProfile,
    EmitOptionsError,
    Emitter,
    EmitterDescriptor,
    coerce_emit_options,
)
from .fidelity_engine import compute_lossiness_for_emitter
from .lossiness import (
    LossinessKind,
    LossinessReport,
    LossinessSeverity,
)
from .projection_taxonomy import ProjectionReason, ProjectionStatus

#: The apiome-rest package version stamped into every manifest's provenance and hash.
APIOME_VERSION = __version__

__all__ = [
    "ProjectionStatus",
    "ProjectionReason",
    "ProjectionNodeKind",
    "ProjectionEdgeRelation",
    "NativeEvidence",
    "TargetLocation",
    "DocumentationEvidence",
    "ProjectionNode",
    "ProjectionEdge",
    "ManifestTarget",
    "ProjectionManifest",
    "ProjectionManifestSummary",
    "ProjectionEvidencePage",
    "ProjectionReconciliationError",
    "build_projection_manifest",
    "summarize_manifest",
    "build_export_projection_summary",
    "reconcile_with_report",
    "paginate_evidence",
    "encode_page_cursor",
    "decode_page_cursor",
    "SOURCE_LOCATION_EXTRA_KEYS",
    "NATIVE_ID_EXTRA_KEYS",
    "first_extra",
    "DEFAULT_EVIDENCE_PAGE_SIZE",
    "MAX_EVIDENCE_PAGE_SIZE",
    "EVIDENCE_BUILD_SOFT_BUDGET_SECONDS",
    "UI_AGGREGATION_THRESHOLD_ROWS",
]


# ===========================================================================
# Vocabulary
# ===========================================================================


class ProjectionNodeKind(str, Enum):
    """Which layer of the source→target projection a node belongs to."""

    NATIVE = "native"  # source-native evidence (native name/id, source location)
    CANONICAL = "canonical"  # the canonical construct the source normalized into
    TARGET = "target"  # where the construct lands in the emitted artifact


class ProjectionEdgeRelation(str, Enum):
    """The relationship a :class:`ProjectionEdge` expresses."""

    DERIVES = "derives"  # native evidence → canonical construct (provenance)
    PROJECTS = "projects"  # canonical construct → target location (the outcome edge)


# ``LossinessKind`` ↔ ``ProjectionStatus`` — the reconciliation bijection. The report
# has exactly four kinds; the manifest's default build uses only the four statuses
# they map to, so counts reconcile exactly.
_STATUS_FOR_KIND: Dict[LossinessKind, ProjectionStatus] = {
    LossinessKind.OK: ProjectionStatus.RETAINED,
    LossinessKind.APPROX: ProjectionStatus.APPROXIMATED,
    LossinessKind.SYNTH: ProjectionStatus.SYNTHESIZED,
    LossinessKind.DROP: ProjectionStatus.DROPPED,
}

# Reverse mapping used by reconciliation. ``transformed`` also reconciles to ``ok``
# (a documented transformation preserves meaning); ``unavailable`` / ``not-applicable``
# have no report counterpart and are excluded from the count comparison.
_KIND_FOR_STATUS: Dict[ProjectionStatus, Optional[LossinessKind]] = {
    ProjectionStatus.RETAINED: LossinessKind.OK,
    ProjectionStatus.TRANSFORMED: LossinessKind.OK,
    ProjectionStatus.APPROXIMATED: LossinessKind.APPROX,
    ProjectionStatus.SYNTHESIZED: LossinessKind.SYNTH,
    ProjectionStatus.DROPPED: LossinessKind.DROP,
    ProjectionStatus.UNAVAILABLE: None,
    ProjectionStatus.NOT_APPLICABLE: None,
}

# Statuses whose construct is present in the emitted artifact, so a target location is
# meaningful. A dropped / unavailable / not-applicable construct has none.
_REPRESENTED_STATUSES = frozenset(
    {
        ProjectionStatus.RETAINED,
        ProjectionStatus.TRANSFORMED,
        ProjectionStatus.APPROXIMATED,
        ProjectionStatus.SYNTHESIZED,
    }
)

# Statuses that MUST carry a reason code (AC: every drop/approx/synth/unavailable has
# a reason). ``retained`` needs none; ``transformed`` / ``not-applicable`` may omit it.
_REASON_REQUIRED_STATUSES = frozenset(
    {
        ProjectionStatus.APPROXIMATED,
        ProjectionStatus.SYNTHESIZED,
        ProjectionStatus.DROPPED,
        ProjectionStatus.UNAVAILABLE,
    }
)

# Display/sort rank for node kinds so a manifest serializes deterministically.
_NODE_KIND_ORDER: Dict[ProjectionNodeKind, int] = {
    ProjectionNodeKind.NATIVE: 0,
    ProjectionNodeKind.CANONICAL: 1,
    ProjectionNodeKind.TARGET: 2,
}

# Worst-first severity rank, mirroring :mod:`app.lossiness`.
_SEVERITY_ORDER: Dict[LossinessSeverity, int] = {
    LossinessSeverity.CRITICAL: 0,
    LossinessSeverity.WARN: 1,
    LossinessSeverity.INFO: 2,
}

#: Default and hard-cap page sizes for :func:`paginate_evidence`.
DEFAULT_EVIDENCE_PAGE_SIZE = 50
MAX_EVIDENCE_PAGE_SIZE = 500

#: Soft wall-clock budget (seconds) for building one projection manifesto in CI
#: (EFP-3.2). Exceeding this is a signal to investigate, not a hard abort in prod.
EVIDENCE_BUILD_SOFT_BUDGET_SECONDS = 2.0

#: UI aggregation threshold mirrored for REST ``large_manifest`` telemetry
#: (see apiome-ui ``GRAPH_AGGREGATION_THRESHOLD`` — EFP-3.2).
UI_AGGREGATION_THRESHOLD_ROWS = 48


# ===========================================================================
# Node / edge value types
# ===========================================================================


class NativeEvidence(BaseModel):
    """Source-native evidence for a construct, where safely available (EFP-1.1).

    Populated best-effort from the canonical construct's source name and its
    ``extras`` bag (format-specific): a native identifier, the native/source name,
    and a source location (line/range) when the parser captured one. Every field is
    optional — a construct with no recoverable native detail carries a bare node
    rather than a fabricated one.
    """

    model_config = ConfigDict(extra="forbid")

    native_id: Optional[str] = Field(
        default=None,
        description="Source-native stable identifier (e.g. a native element id), when captured.",
    )
    native_name: Optional[str] = Field(
        default=None,
        description="The construct's name in the source document (e.g. a source field name).",
    )
    source_location: Optional[str] = Field(
        default=None,
        description="Source location (line/range/pointer) the construct came from, when captured.",
    )


class TargetLocation(BaseModel):
    """Where a construct lands in the emitted artifact, when a locator can place it.

    Exactly one addressing scheme is used per target: a :attr:`json_pointer` for
    JSON/YAML-document targets (OpenAPI, AsyncAPI) or a :attr:`native_path` for
    text/schema targets (a GraphQL type path, a Protobuf message field, an Avro
    record field). ``None`` for both when the target has no registered locator — a
    truthful "we cannot point to where this landed" rather than a guess.
    """

    model_config = ConfigDict(extra="forbid")

    json_pointer: Optional[str] = Field(
        default=None,
        description="RFC 6901 JSON Pointer into the emitted document (JSON/YAML targets).",
    )
    native_path: Optional[str] = Field(
        default=None,
        description="Target-native path into the emitted artifact (SDL/schema/proto targets).",
    )

    def render(self) -> str:
        """Return the single addressing string this location carries (pointer or path)."""
        return self.json_pointer or self.native_path or ""


class ProjectionNode(BaseModel):
    """One node in the projection graph: native evidence, canonical construct, or target.

    A single model with a :attr:`kind` discriminator and kind-specific optional
    payloads, so the UI (EFP-2.2) can group nodes into source/native, canonical, and
    target lanes from one homogeneous list. Node :attr:`id` is deterministic — derived
    from the construct key and node kind — so identical inputs yield identical IDs.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Deterministic, stable node id (unique within a manifest).")
    kind: ProjectionNodeKind = Field(description="Which projection layer this node belongs to.")
    label: str = Field(description="Short human label for the node (a construct key, name, or path).")
    construct_key: Optional[str] = Field(
        default=None,
        description="The canonical construct key this node concerns (present on every node kind).",
    )
    canonical_kind: Optional[str] = Field(
        default=None,
        description="Coarse construct class on a canonical node: operation / channel / type / field.",
    )
    native: Optional[NativeEvidence] = Field(
        default=None, description="Source-native evidence, on a ``native`` node."
    )
    target: Optional[TargetLocation] = Field(
        default=None, description="Target location, on a ``target`` node."
    )


class ProjectionEdge(BaseModel):
    """One edge in the projection graph.

    A ``derives`` edge links a native-evidence node to its canonical construct
    (provenance); a ``projects`` edge links a canonical construct to its target
    location (or to nothing, for a dropped construct) and carries the projection
    outcome — :attr:`status`, :attr:`reason`, :attr:`severity`, and the human
    :attr:`detail`. Exactly one ``projects`` edge exists per
    :class:`~app.lossiness.LossItem`, which is what makes the manifest reconcile
    construct-for-construct with the report.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Deterministic, stable edge id (unique within a manifest).")
    relation: ProjectionEdgeRelation = Field(description="derives (provenance) or projects (outcome).")
    source: str = Field(description="Id of the node this edge starts at.")
    target: Optional[str] = Field(
        default=None,
        description="Id of the node this edge ends at; null for a projects edge to a dropped "
        "construct (no target node exists).",
    )
    status: ProjectionStatus = Field(description="The projection outcome this edge records.")
    reason: Optional[ProjectionReason] = Field(
        default=None,
        description="Cause category for a non-preserved status; required for "
        "drop/approx/synth/unavailable.",
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
    explanation: Optional[str] = Field(
        default=None,
        description="Reviewed, reason-specific explanation from the capability registry (EFP-1.2), "
        "naming the construct. Present on non-preserved outcome edges.",
    )
    documentation: Optional[DocumentationEvidence] = Field(
        default=None,
        description="Reason-scoped documentation evidence from the capability registry (EFP-1.2): a "
        "destination-format link only when the reason is a genuine destination limit, otherwise a "
        "truthful documentation-unavailable fallback. Present on non-preserved outcome edges.",
    )

    @model_validator(mode="after")
    def _require_reason(self) -> "ProjectionEdge":
        """Enforce the AC: every drop/approx/synth/unavailable edge carries a reason code."""
        if self.status in _REASON_REQUIRED_STATUSES and self.reason is None:
            raise ValueError(
                f"projection edge {self.id!r} with status {self.status.value!r} requires a reason code"
            )
        return self


class ManifestTarget(BaseModel):
    """The target descriptor + version provenance a manifest was built for (EFP-1.1)."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Stable target key (e.g. ``openapi``).")
    format: str = Field(description="Output format key (e.g. ``openapi-3.1``).")
    label: str = Field(description="Human label for the target.")
    paradigm: ApiParadigm = Field(description="The canonical paradigm this emitter targets.")
    emitter_version: str = Field(description="The emitter implementation version (folded into the hash).")
    apiome_version: str = Field(description="The apiome-rest package version that built the manifest.")
    capability_profile: CapabilityProfile = Field(
        description="The target's static capability profile the report was computed against."
    )
    needs_toolchain: bool = Field(description="Whether emit hard-requires an external toolchain.")
    available: bool = Field(description="Whether this emitter can run in the current runtime.")
    availability: DestinationAvailability = Field(
        description="The capability registry's availability state (available / experimental / "
        "unavailable) — a finer classification than ``available`` alone (EFP-1.2).",
    )
    registry_version: str = Field(
        description="The capability-registry contract version this manifest's documentation and "
        "reason evidence were resolved against (EFP-1.2). Folded into the manifest hash.",
    )
    documentation: DocumentationEvidence = Field(
        description="Destination-format documentation metadata from the capability registry "
        "(EFP-1.2), with a safe fallback."
    )


class ProjectionManifest(BaseModel):
    """The full source→target projection graph for one export (EFP-1.1).

    An ordered set of :class:`ProjectionNode`s and :class:`ProjectionEdge`s plus
    derived status/reason counts and a stable :attr:`manifest_hash`. Like
    :class:`~app.lossiness.LossinessReport`, ordering and counts are invariants of the
    model — sorted and recomputed on every (re)validation — so a manifest built via
    :func:`build_projection_manifest`, a direct constructor, or ``model_validate`` of
    persisted JSON serializes identically. The heavy graph lives here; the bounded
    :class:`ProjectionManifestSummary` is what rides in the fidelity envelope.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(
        default="",
        description="Stable content hash over target/version/options + nodes + edges. Set by the "
        "builder; deterministic for identical (revision, target, options, emitter version).",
    )
    target: ManifestTarget = Field(description="The target + version provenance this manifest is for.")
    nodes: List[ProjectionNode] = Field(
        default_factory=list, description="Projection nodes, in a deterministic canonical order."
    )
    edges: List[ProjectionEdge] = Field(
        default_factory=list, description="Projection edges, in a deterministic canonical order."
    )
    status_counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Count of projects-edges per ProjectionStatus, zero-filled. Derived from edges.",
    )
    reason_counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Count of projects-edges per ProjectionReason, zero-filled. Derived from edges.",
    )
    total_constructs: int = Field(
        default=0, description="Distinct canonical constructs the manifest projects."
    )
    truncated: bool = Field(
        default=False,
        description="True when the node/edge graph was bounded (aggregated) rather than complete.",
    )

    @model_validator(mode="after")
    def _order_and_count(self) -> "ProjectionManifest":
        """Sort nodes/edges deterministically and (re)derive the status/reason counts."""
        self.nodes.sort(key=lambda n: (_NODE_KIND_ORDER[n.kind], n.id))
        self.edges.sort(key=lambda e: e.id)
        status_counts = {status.value: 0 for status in ProjectionStatus}
        reason_counts = {reason.value: 0 for reason in ProjectionReason}
        constructs = set()
        for edge in self.edges:
            if edge.relation is not ProjectionEdgeRelation.PROJECTS:
                continue
            status_counts[edge.status.value] += 1
            if edge.reason is not None:
                reason_counts[edge.reason.value] += 1
        for node in self.nodes:
            if node.kind is ProjectionNodeKind.CANONICAL and node.construct_key:
                constructs.add(node.construct_key)
        self.status_counts = status_counts
        self.reason_counts = reason_counts
        self.total_constructs = len(constructs)
        return self

    @property
    def projects_edges(self) -> List[ProjectionEdge]:
        """The outcome (``projects``) edges — the evidence rows — in canonical order."""
        return [e for e in self.edges if e.relation is ProjectionEdgeRelation.PROJECTS]

    @property
    def is_lossless(self) -> bool:
        """True when every outcome edge is ``retained`` (or there are none)."""
        return all(e.status is ProjectionStatus.RETAINED for e in self.projects_edges)

    @property
    def worst_severity(self) -> Optional[LossinessSeverity]:
        """The worst severity among non-``retained`` outcome edges, or ``None`` when lossless."""
        worst: Optional[LossinessSeverity] = None
        worst_rank = len(_SEVERITY_ORDER)
        for edge in self.projects_edges:
            if edge.status is ProjectionStatus.RETAINED:
                continue
            rank = _SEVERITY_ORDER[edge.severity]
            if rank < worst_rank:
                worst_rank = rank
                worst = edge.severity
        return worst


class ProjectionManifestSummary(BaseModel):
    """The bounded projection summary embedded in the fidelity envelope (EFP-1.1).

    Everything a preview/verify/CLI/job needs to *reference* a snapshot — the
    :attr:`manifest_hash`, the target/version provenance, and the aggregate
    status/reason counts — **without** the (potentially large) node/edge graph, which
    is fetched page by page via :func:`paginate_evidence`. Because the summary is
    derived from the deterministic manifest, the same inputs produce the same summary
    across every surface, so they all describe the same snapshot.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(description="The manifest's stable content hash — the snapshot id.")
    target: ManifestTarget = Field(description="The target + version provenance the manifest is for.")
    status_counts: Dict[str, int] = Field(
        description="Count of projected constructs per ProjectionStatus, zero-filled."
    )
    reason_counts: Dict[str, int] = Field(
        description="Count of non-preserved constructs per ProjectionReason, zero-filled."
    )
    total_constructs: int = Field(description="Distinct canonical constructs the manifest projects.")
    node_count: int = Field(description="Total projection nodes in the full manifest.")
    edge_count: int = Field(description="Total projection edges in the full manifest.")
    evidence_count: int = Field(description="Total outcome (projects) edges — the evidence rows.")
    is_lossless: bool = Field(description="True when every construct was retained.")
    worst_severity: Optional[LossinessSeverity] = Field(
        default=None, description="Worst severity among non-retained constructs, or null when lossless."
    )
    truncated: bool = Field(
        default=False, description="True when the underlying graph was aggregated rather than complete."
    )


class ProjectionEvidencePage(BaseModel):
    """One cursor-paginated page of projection evidence (EFP-1.1).

    A bounded slice of the manifest's outcome (``projects``) edges together with the
    nodes those edges reference, plus an opaque :attr:`next_cursor` for the following
    page (``None`` at the end). Deterministic: the edges are page-sliced from the
    manifest's canonical order, so paging the same manifest twice yields identical
    pages.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(description="The manifest hash this page belongs to (the snapshot id).")
    edges: List[ProjectionEdge] = Field(description="This page's outcome edges, in canonical order.")
    nodes: List[ProjectionNode] = Field(description="The nodes referenced by this page's edges.")
    next_cursor: Optional[str] = Field(
        default=None, description="Opaque cursor for the next page, or null when this is the last page."
    )
    total: int = Field(description="Total outcome edges across the whole manifest.")


class ProjectionReconciliationError(Exception):
    """Raised when a manifest's status counts disagree with its fidelity report.

    The contract guarantee (AC: "manifest status totals reconcile with the fidelity
    report; divergence fails the contract test"): the builder asserts it defensively,
    and the cross-format contract corpus (EFP-1.3) asserts it for every fixture.
    """


# ===========================================================================
# Target-location adapters (best-effort; truthful ``None`` fallback)
# ===========================================================================


def _escape_pointer_token(token: str) -> str:
    """Escape a JSON Pointer reference token per RFC 6901 (``~``→``~0``, ``/``→``~1``)."""
    return token.replace("~", "~0").replace("/", "~1")


def _openapi_target_location(construct_key: str, canonical_kind: str) -> Optional[TargetLocation]:
    """Best-effort JSON Pointer into an emitted OpenAPI document for a construct.

    Mirrors the OpenAPI emitter's document shape: an operation ``"GET /pets/{id}"``
    lands at ``/paths/~1pets~1{id}/get``; a named type ``"User"`` at
    ``/components/schemas/User``; a record field ``"User.email"`` at
    ``/components/schemas/User/properties/email``. Channels have no OpenAPI location.
    Returns ``None`` for a shape it cannot address, so the manifest falls back to a
    truthful "no target location" rather than a wrong pointer.

    Args:
        construct_key: The canonical construct key (e.g. ``"GET /pets/{id}"``).
        canonical_kind: The coarse construct class (``operation`` / ``type`` / ``field``).

    Returns:
        A :class:`TargetLocation` with a JSON Pointer, or ``None`` when unaddressable.
    """
    if canonical_kind == "operation":
        parts = construct_key.split(" ", 1)
        if len(parts) != 2:
            return None
        method, path = parts[0].lower(), parts[1]
        pointer = f"/paths/{_escape_pointer_token(path)}/{method}"
        return TargetLocation(json_pointer=pointer)
    if canonical_kind == "type":
        return TargetLocation(json_pointer=f"/components/schemas/{_escape_pointer_token(construct_key)}")
    if canonical_kind == "field":
        owner, _, prop = construct_key.rpartition(".")
        if not owner or not prop:
            return None
        return TargetLocation(
            json_pointer=(
                f"/components/schemas/{_escape_pointer_token(owner)}"
                f"/properties/{_escape_pointer_token(prop)}"
            )
        )
    return None


# format-key prefix → target-location adapter. Only formats with a verified adapter
# appear; every other target falls back to ``None`` (truthful aggregate).
_TARGET_LOCATORS: Dict[str, Callable[[str, str], Optional[TargetLocation]]] = {
    "openapi": _openapi_target_location,
}


def _target_locator_for(
    emitter_cls: type[Emitter],
) -> Optional[Callable[[str, str], Optional[TargetLocation]]]:
    """Return the target-location adapter for ``emitter_cls``'s format, or ``None``."""
    fmt = emitter_cls.format or ""
    for prefix, locator in _TARGET_LOCATORS.items():
        if fmt.startswith(prefix):
            return locator
    return None


# ===========================================================================
# Source construct index
# ===========================================================================

# Extras keys, in priority order, a normalizer may use for a construct's source
# location and native id. Read best-effort — absent keys leave the field ``None``.
# Public (no underscore alias needed): the IXH-3.1 import preview manifest reads the same
# keys so both manifests recover provenance identically (CPDO-1.3 shared contract).
SOURCE_LOCATION_EXTRA_KEYS = ("source_location", "source_range", "source_span", "location", "line")
NATIVE_ID_EXTRA_KEYS = ("native_id", "source_id", "id")
_SOURCE_LOCATION_KEYS = SOURCE_LOCATION_EXTRA_KEYS
_NATIVE_ID_KEYS = NATIVE_ID_EXTRA_KEYS


class _ConstructInfo:
    """Cached source facts for one canonical construct key (name, kind, native evidence)."""

    __slots__ = ("kind", "name", "extras")

    def __init__(self, kind: str, name: Optional[str], extras: Dict[str, Any]) -> None:
        self.kind = kind
        self.name = name
        self.extras = extras


def first_extra(extras: Dict[str, Any], keys: tuple) -> Optional[str]:
    """Return the first present, stringifiable extras value among ``keys``, else ``None``.

    Public: the IXH-3.1 import preview manifest recovers native evidence with the same
    accessor over the same key tuples, so provenance extraction cannot drift between the
    two manifest surfaces.
    """
    for key in keys:
        value = extras.get(key)
        if value is not None and not isinstance(value, (dict, list)):
            return str(value)
    return None


def _index_constructs(api: CanonicalApi) -> Dict[str, _ConstructInfo]:
    """Index every construct the report walks by key → (coarse kind, name, extras).

    Walks the same constructs the rule pack's :meth:`~app.fidelity_rulepack.FidelityRulePack.evaluate`
    does — operations, channels, named types, and record fields — so every report
    item has a matching entry (a missing entry degrades to ``unknown`` kind, never an
    error).
    """
    index: Dict[str, _ConstructInfo] = {}
    for operation in api.operations():
        index[operation.key] = _ConstructInfo("operation", operation.name, operation.extras)
    for channel in api.channels:
        index[channel.key] = _ConstructInfo("channel", channel.name or channel.key, channel.extras)
    for type_ in api.types:
        index[type_.key] = _ConstructInfo("type", type_.name, type_.extras)
        for field in type_.fields:
            index[field.key] = _ConstructInfo("field", field.name, field.extras)
    return index


def _native_evidence(info: Optional[_ConstructInfo], construct_key: str) -> NativeEvidence:
    """Build best-effort :class:`NativeEvidence` for a construct from its source facts."""
    if info is None:
        return NativeEvidence(native_name=construct_key)
    return NativeEvidence(
        native_id=first_extra(info.extras, _NATIVE_ID_KEYS),
        native_name=info.name or construct_key,
        source_location=first_extra(info.extras, _SOURCE_LOCATION_KEYS),
    )


# ===========================================================================
# Reason derivation
# ===========================================================================


def _default_reason(status: ProjectionStatus) -> Optional[ProjectionReason]:
    """Derive the truthful cause category for a status from a capability-driven report.

    The default :class:`~app.lossiness.LossinessReport` is computed against the
    *destination's* :class:`~app.emitter.CapabilityProfile`, so a
    drop/approx/synth is genuinely a destination-format limitation
    (``destination_unsupported``) — never mis-attributed to the emitter or source.
    ``unavailable`` reflects source analysis (``source_incomplete``);
    ``not-applicable`` maps to ``not_applicable``; ``retained`` / ``transformed`` need
    no reason.
    """
    if status in (
        ProjectionStatus.DROPPED,
        ProjectionStatus.APPROXIMATED,
        ProjectionStatus.SYNTHESIZED,
    ):
        return ProjectionReason.DESTINATION_UNSUPPORTED
    if status is ProjectionStatus.UNAVAILABLE:
        return ProjectionReason.SOURCE_INCOMPLETE
    if status is ProjectionStatus.NOT_APPLICABLE:
        return ProjectionReason.NOT_APPLICABLE
    return None


# ===========================================================================
# Builder
# ===========================================================================


def _manifest_target(emitter_cls: type[Emitter], descriptor: EmitterDescriptor) -> ManifestTarget:
    """Assemble the target + version provenance block for a manifest.

    Sources the destination documentation, availability state, and registry version from
    the EFP-1.2 capability registry (:func:`app.capability_registry.capability_for`), so a
    manifest's target-level evidence carries reviewed, versioned data rather than an ad hoc
    seed.
    """
    capability = capability_for(emitter_cls)
    return ManifestTarget(
        key=descriptor.key,
        format=descriptor.format,
        label=descriptor.label,
        paradigm=descriptor.paradigm,
        emitter_version=emitter_cls.version,
        apiome_version=APIOME_VERSION,
        capability_profile=emitter_cls.capability_profile(),
        needs_toolchain=descriptor.needs_toolchain,
        available=descriptor.available,
        availability=capability.availability,
        registry_version=REGISTRY_VERSION,
        documentation=capability.documentation,
    )


def _normalize_options_for_hash(
    emitter_cls: type[Emitter], options: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Normalize emit options into a deterministic dict for the manifest hash.

    Coerces ``options`` to the emitter's validated defaults so a preview (no options)
    and a default dispatch (``{}``) share one snapshot. Invalid options are **not**
    rejected here — the manifest is descriptive, and options validity is enforced at
    emit time (a 422 from the export service). An invalid set is still hashed
    deterministically (under a raw key) so the manifest builds and stays a distinct
    snapshot from the valid default.
    """
    try:
        return coerce_emit_options(emitter_cls, options).model_dump(mode="json")
    except EmitOptionsError:
        return {"__unvalidated__": options}


def _compute_manifest_hash(
    *,
    target_format: str,
    emitter_version: str,
    options: Dict[str, Any],
    nodes: List[ProjectionNode],
    edges: List[ProjectionEdge],
) -> str:
    """Compute the stable content hash over the manifest's identity-bearing content.

    Folds the target format, emitter version, apiome version, capability-registry
    version, and normalized options into a digest over the (already deterministically
    ordered) nodes and edges, so an emitter upgrade, a registry revision, or an option
    change yields a different snapshot while identical inputs yield an identical hash.
    """
    payload = {
        "target_format": target_format,
        "emitter_version": emitter_version,
        "apiome_version": APIOME_VERSION,
        "registry_version": REGISTRY_VERSION,
        "options": options,
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def build_projection_manifest(
    api: CanonicalApi,
    emitter: Union[Emitter, type[Emitter]],
    *,
    options: Optional[Dict[str, Any]] = None,
    report: Optional[LossinessReport] = None,
) -> ProjectionManifest:
    """Build the deterministic projection manifest for exporting ``api`` to ``emitter``.

    Derives a source→target graph from the fidelity :class:`~app.lossiness.LossinessReport`
    (computed here when not supplied, so a caller that already has the envelope's report
    can pass it to avoid recomputation) plus the source model: one canonical node and
    one native-evidence node per construct, a target node where a locator can place it,
    a ``derives`` edge for provenance, and one ``projects`` edge per report item carrying
    the mapped status, its reason code, severity, and detail. The result is reconciled
    against the report before return (:func:`reconcile_with_report`), so a divergence is
    a hard error rather than a silent inconsistency.

    Pure and deterministic: no I/O, and identical ``(api, emitter, options)`` yield an
    equal manifest with a stable :attr:`~ProjectionManifest.manifest_hash`.

    Args:
        api: The source canonical model to be exported.
        emitter: The target emitter (instance or class).
        options: Per-target emit options; ``None``/``{}`` applies the target defaults. Folded
            into the manifest hash (normalized) so different options are a different snapshot.
        report: A pre-computed lossiness report for the same inputs; recomputed when ``None``.

    Returns:
        The :class:`ProjectionManifest` for the export.

    Raises:
        ProjectionReconciliationError: If the built manifest's status totals disagree with
            the report (a builder bug or an inconsistent injected report).
    """
    emitter_cls: type[Emitter] = emitter if isinstance(emitter, type) else type(emitter)
    if report is None:
        report = compute_lossiness_for_emitter(api, emitter_cls)
    normalized_options = _normalize_options_for_hash(emitter_cls, options)

    lookup = _index_constructs(api)
    locator = _target_locator_for(emitter_cls)
    descriptor = emitter_cls.descriptor()

    nodes: Dict[str, ProjectionNode] = {}
    edges: List[ProjectionEdge] = []
    derives_seen: set = set()
    ordinal: Dict[str, int] = defaultdict(int)

    for item in report.items:
        key = item.construct_key
        info = lookup.get(key)
        canonical_kind = info.kind if info is not None else "unknown"
        status = _STATUS_FOR_KIND[item.kind]
        reason = _default_reason(status)

        # Canonical node (one per construct).
        canonical_id = f"canonical:{key}"
        if canonical_id not in nodes:
            nodes[canonical_id] = ProjectionNode(
                id=canonical_id,
                kind=ProjectionNodeKind.CANONICAL,
                label=key,
                construct_key=key,
                canonical_kind=canonical_kind,
            )

        # Native-evidence node + its provenance (derives) edge (one per construct).
        native_id = f"native:{key}"
        if native_id not in nodes:
            evidence = _native_evidence(info, key)
            nodes[native_id] = ProjectionNode(
                id=native_id,
                kind=ProjectionNodeKind.NATIVE,
                label=evidence.native_name or key,
                construct_key=key,
                native=evidence,
            )
        if key not in derives_seen:
            derives_seen.add(key)
            edges.append(
                ProjectionEdge(
                    id=f"derives:{key}",
                    relation=ProjectionEdgeRelation.DERIVES,
                    source=native_id,
                    target=canonical_id,
                    status=ProjectionStatus.RETAINED,
                    detail="source construct normalized into the canonical model",
                )
            )

        # Target node, when the construct is represented and a locator can place it.
        target_node_id: Optional[str] = None
        if status in _REPRESENTED_STATUSES and locator is not None:
            location = locator(key, canonical_kind)
            if location is not None:
                target_node_id = f"target:{key}"
                if target_node_id not in nodes:
                    nodes[target_node_id] = ProjectionNode(
                        id=target_node_id,
                        kind=ProjectionNodeKind.TARGET,
                        label=location.render() or key,
                        construct_key=key,
                        target=location,
                    )

        # The outcome (projects) edge — exactly one per report item. A non-preserved
        # outcome carries the registry's reviewed, reason-scoped explanation and
        # documentation (EFP-1.2): a destination-format link only when the reason is a
        # genuine destination limit, otherwise a truthful documentation-unavailable
        # fallback that never blames the destination for an emitter/source/option cause.
        explanation: Optional[str] = None
        documentation: Optional[DocumentationEvidence] = None
        if reason is not None:
            explanation = explanation_for(reason, key)
            documentation = documentation_for(emitter_cls, reason)

        index = ordinal[key]
        ordinal[key] += 1
        edges.append(
            ProjectionEdge(
                id=f"projects:{key}#{index}",
                relation=ProjectionEdgeRelation.PROJECTS,
                source=canonical_id,
                target=target_node_id,
                status=status,
                reason=reason,
                severity=item.severity,
                detail=item.message,
                target_mapping=item.target_mapping,
                explanation=explanation,
                documentation=documentation,
            )
        )

    manifest = ProjectionManifest(
        target=_manifest_target(emitter_cls, descriptor),
        nodes=list(nodes.values()),
        edges=edges,
    )
    manifest.manifest_hash = _compute_manifest_hash(
        target_format=descriptor.format,
        emitter_version=emitter_cls.version,
        options=normalized_options,
        nodes=manifest.nodes,
        edges=manifest.edges,
    )
    reconcile_with_report(manifest, report)
    return manifest


def summarize_manifest(manifest: ProjectionManifest) -> ProjectionManifestSummary:
    """Reduce a full :class:`ProjectionManifest` to its bounded envelope summary."""
    return ProjectionManifestSummary(
        manifest_hash=manifest.manifest_hash,
        target=manifest.target,
        status_counts=dict(manifest.status_counts),
        reason_counts=dict(manifest.reason_counts),
        total_constructs=manifest.total_constructs,
        node_count=len(manifest.nodes),
        edge_count=len(manifest.edges),
        evidence_count=len(manifest.projects_edges),
        is_lossless=manifest.is_lossless,
        worst_severity=manifest.worst_severity,
        truncated=manifest.truncated,
    )


def build_export_projection_summary(
    api: CanonicalApi,
    emitter: Union[Emitter, type[Emitter]],
    *,
    options: Optional[Dict[str, Any]] = None,
    report: Optional[LossinessReport] = None,
) -> ProjectionManifestSummary:
    """Build the bounded projection summary for the fidelity envelope in one call.

    The convenience the export surface uses: build the manifest (reusing the envelope's
    already-computed ``report`` when passed) and summarize it, so a preview, a verify,
    a CLI JSON dump, and a completed job all embed the same snapshot summary.
    """
    manifest = build_projection_manifest(api, emitter, options=options, report=report)
    return summarize_manifest(manifest)


# ===========================================================================
# Reconciliation
# ===========================================================================


def reconcile_with_report(manifest: ProjectionManifest, report: LossinessReport) -> None:
    """Assert a manifest's outcome counts reconcile with its fidelity report (AC).

    Maps every outcome (``projects``) edge's status back to a
    :class:`~app.lossiness.LossinessKind` (``retained``/``transformed``→``ok``,
    ``approximated``→``approx``, ``synthesized``→``synth``, ``dropped``→``drop``;
    ``unavailable``/``not-applicable`` excluded, having no report counterpart) and
    requires the resulting per-kind tally to equal the report's ``kind_counts``, and
    the number of reconcilable edges to equal the report's total. Any disagreement is
    a :class:`ProjectionReconciliationError` — the guarantee the contract corpus
    (EFP-1.3) enforces for every source/target pair.

    Args:
        manifest: The projection manifest to check.
        report: The fidelity report the manifest was built from.

    Raises:
        ProjectionReconciliationError: When the tallies disagree.
    """
    kind_tally: Dict[str, int] = {kind.value: 0 for kind in LossinessKind}
    reconcilable = 0
    for edge in manifest.projects_edges:
        kind = _KIND_FOR_STATUS.get(edge.status)
        if kind is None:
            continue
        kind_tally[kind.value] += 1
        reconcilable += 1

    expected = {kind.value: report.kind_counts.get(kind.value, 0) for kind in LossinessKind}
    if kind_tally != expected:
        raise ProjectionReconciliationError(
            f"manifest status counts {kind_tally} do not reconcile with report kind counts {expected}"
        )
    if reconcilable != report.total:
        raise ProjectionReconciliationError(
            f"manifest reconcilable edge count {reconcilable} does not match report total {report.total}"
        )


# ===========================================================================
# Pagination
# ===========================================================================


def _encode_cursor(index: int) -> str:
    """Encode a page start index into an opaque, URL-safe cursor token."""
    return base64.urlsafe_b64encode(str(index).encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> int:
    """Decode an opaque cursor back into a page start index.

    Raises:
        ValueError: When the cursor is malformed (not a non-negative integer token).
    """
    try:
        index = int(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
    except (ValueError, TypeError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
        raise ValueError(f"malformed evidence cursor: {cursor!r}") from exc
    if index < 0:
        raise ValueError(f"malformed evidence cursor: {cursor!r}")
    return index


#: Public aliases of the cursor codec, shared with the IXH-3.1 import preview manifest so
#: both manifest surfaces speak one cursor format (part of the CPDO-1.3 shared contract).
encode_page_cursor = _encode_cursor
decode_page_cursor = _decode_cursor


def paginate_evidence(
    manifest: ProjectionManifest,
    *,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_EVIDENCE_PAGE_SIZE,
) -> ProjectionEvidencePage:
    """Return one deterministic, cursor-paginated page of a manifest's evidence.

    Pages over the manifest's outcome (``projects``) edges in their canonical order,
    bundling each page's edges with the nodes they reference (source construct and, when
    present, its native and target nodes). The ``limit`` is clamped to
    ``[1, MAX_EVIDENCE_PAGE_SIZE]``; the returned :attr:`~ProjectionEvidencePage.next_cursor`
    is ``None`` on the last page.

    Args:
        manifest: The manifest to page.
        cursor: Opaque cursor from a previous page, or ``None`` to start at the beginning.
        limit: Maximum edges per page (clamped to the hard cap).

    Returns:
        The :class:`ProjectionEvidencePage`.

    Raises:
        ValueError: When ``cursor`` is malformed.
    """
    limit = max(1, min(int(limit), MAX_EVIDENCE_PAGE_SIZE))
    start = _decode_cursor(cursor) if cursor else 0
    evidence = manifest.projects_edges
    total = len(evidence)
    page_edges = evidence[start : start + limit]

    node_by_id = {node.id: node for node in manifest.nodes}
    wanted: List[str] = []
    seen: set = set()
    for edge in page_edges:
        for node_id in (edge.source, edge.target):
            if node_id and node_id not in seen and node_id in node_by_id:
                seen.add(node_id)
                wanted.append(node_id)
    # A projects edge's source is the canonical node; surface its native provenance too.
    for edge in page_edges:
        for prov in manifest.edges:
            if (
                prov.relation is ProjectionEdgeRelation.DERIVES
                and prov.target == edge.source
                and prov.source not in seen
                and prov.source in node_by_id
            ):
                seen.add(prov.source)
                wanted.append(prov.source)
    page_nodes = [node_by_id[node_id] for node_id in wanted]

    next_start = start + limit
    next_cursor = _encode_cursor(next_start) if next_start < total else None
    return ProjectionEvidencePage(
        manifest_hash=manifest.manifest_hash,
        edges=page_edges,
        nodes=page_nodes,
        next_cursor=next_cursor,
        total=total,
    )
