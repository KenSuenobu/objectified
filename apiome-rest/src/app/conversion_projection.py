"""Catalog → OpenAPI conversion projection manifest — CPDO-1.3 (#4800).

The fidelity report (:mod:`app.fidelity`, MFI-22.3) already aggregates a conversion: a
checklist row per load-bearing OpenAPI construct, the projection's enumerated losses, and
a rolled-up score. What it cannot answer is the *traceable* question a user actually asks
in front of a converted spec — **which source construct became which OpenAPI construct,
why a construct was dropped, and whether the input itself was incomplete**. A checklist row
saying "responses: partial" names no operation; a loss saying "graphql-subscription" names
no pointer; and neither says anything about the X12 segments or copybook fields the
analyzer never got to see.

This module is that missing relationship for the conversion side — the **conversion
projection manifest**. It is the catalog-to-OpenAPI counterpart of
:mod:`app.export_projection` (EFP-1.1), which generalized this shape across every export
emitter: a deterministic graph of **nodes** (source constructs on one side, OpenAPI JSON
Pointers on the other) joined by **edges** that each carry a
:class:`~app.projection_taxonomy.ConversionStatus`, a
:class:`~app.projection_taxonomy.ProjectionReason` code, evidence references, a severity,
and a remediation hint.

**Four edge scopes, four sources of truth.** Each :class:`ConversionEdgeScope` is derived
from a different input, and mixing them in one graph is what makes the manifest able to
answer all three questions at once:

* :attr:`~ConversionEdgeScope.CHECKLIST` — one edge per :class:`~app.fidelity.ChecklistItem`.
  These are the rows that **reconcile** with the report: their per-status tally must equal
  the report's ``coverage_counts`` mapped through :data:`STATUS_FOR_COVERAGE`, and
  :func:`reconcile_with_fidelity` raises rather than let the two disagree.
* :attr:`~ConversionEdgeScope.CONSTRUCT` — one edge per canonical operation, channel, named
  type, and record field, resolved to the JSON Pointer the emitter would have written it to.
  This is the "which became which" lane.
* :attr:`~ConversionEdgeScope.LOSS` — one edge per :class:`~app.emitter.Loss`, so a
  subscription or a pub/sub action stays visible with its own reason code.
* :attr:`~ConversionEdgeScope.ANALYSIS` — what the CPDO-1.1/1.2 payload analysis says it
  could **not** describe: the analyzer's declared ``unsupported`` constructs, a bounded
  tree, or the absence of an analysis altogether. This is the "was the input incomplete"
  lane, and it is the reason a manifest can distinguish "the source had no such construct"
  from "apiome never looked".

**Nothing is guessed.** A construct's OpenAPI location is never inferred from its name: an
operation's route is re-resolved through the very :class:`~app.projection.ProjectionStrategy`
the emitter used (against a scratch :class:`~app.emitter.LossTracker`, so re-resolution
cannot pollute the real loss list), and types/fields go through
:func:`~app.export_projection.target_location_for_construct` — the shared locator seam — so a
manifest entity and an export projection node can never claim different addresses. Every
pointer is then *resolved against the emitted document*. A pointer that does not resolve
yields :attr:`~app.projection_taxonomy.ConversionStatus.UNAVAILABLE`, never ``dropped``:
apiome could not place the construct, which is not the same as proving it absent.

**Determinism.** :func:`build_conversion_manifest` is pure — no I/O, no clock — so identical
``(source revision, defaults, tool versions)`` inputs yield identical node/edge IDs, ordering,
counts, and :attr:`~ConversionManifest.manifest_hash`. The hash is *content-addressed*: it
folds the contract version, source/target format, conversion mode, tool versions and
normalized defaults over the already-ordered nodes and edges, but **not** the tenant/project
/revision ids, so re-converting the same bytes with the same defaults is recognizably the
same snapshot.

**Bounded.** A large source cannot produce an unbounded graph: construct edges are admitted
worst-status-first up to :data:`MAX_CONSTRUCT_EDGES` and analysis edges up to
:data:`MAX_ANALYSIS_EDGES`, with :attr:`~ConversionManifest.truncated` and
:attr:`~ConversionManifest.dropped_edge_count` stating what was left out — a bounded manifest
says so rather than reading as a complete one. Checklist and loss edges are never bounded away,
because they are what reconciles. Readers page the graph with
:func:`paginate_conversion_evidence`, which shares its cursor codec with the export manifest.
"""

from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical_model import CanonicalApi, Operation, Service
from .emitter import EmitResult, LossKind, LossTracker, Provenance, ProvenanceTracker
from .export_projection import (
    NATIVE_ID_EXTRA_KEYS,
    SOURCE_LOCATION_EXTRA_KEYS,
    TargetLocation,
    decode_page_cursor,
    encode_page_cursor,
    first_extra,
    target_location_for_construct,
)
from .fidelity import ChecklistItem, Coverage, FidelityReport
from .lossiness import LossinessSeverity
from .payload_analysis import PayloadAnalysisDocument, SourceLocation
from .projection_taxonomy import ConversionStatus, ProjectionReason

__all__ = [
    "CONVERSION_MANIFEST_SCHEMA_VERSION",
    "MAX_CONSTRUCT_EDGES",
    "MAX_ANALYSIS_EDGES",
    "DEFAULT_EVIDENCE_PAGE_SIZE",
    "MAX_EVIDENCE_PAGE_SIZE",
    "STATUS_FOR_COVERAGE",
    "STATUS_FOR_LOSS_KIND",
    "CONVERSION_REMEDIATION",
    "ConversionNodeKind",
    "ConversionEdgeScope",
    "EvidenceRef",
    "SourceEvidence",
    "ConversionNode",
    "ConversionEdge",
    "ConversionAnalysisRef",
    "ConversionManifestSource",
    "ConversionManifest",
    "ConversionManifestSummary",
    "ConversionEvidencePage",
    "ConversionReconciliationError",
    "build_conversion_manifest",
    "summarize_conversion_manifest",
    "reconcile_with_fidelity",
    "paginate_conversion_evidence",
    "normalize_defaults_for_hash",
]


#: Contract version of the manifest document. Bumped when the node/edge shape changes in a
#: way a stored manifest's reader must notice; folded into :attr:`ConversionManifest.manifest_hash`.
CONVERSION_MANIFEST_SCHEMA_VERSION = "1.0.0"

#: Most construct-scoped edges one manifest carries. Beyond this the graph is bounded
#: worst-status-first (see :func:`_admit_construct_edges`) and declares itself truncated.
MAX_CONSTRUCT_EDGES = 2000

#: Most analysis-scoped edges one manifest carries (an analyzer's ``unsupported`` list is
#: short by construction, so this only guards a pathological declaration).
MAX_ANALYSIS_EDGES = 200

#: Default and hard-cap page sizes for :func:`paginate_conversion_evidence`. Match the export
#: manifest's (:mod:`app.export_projection`) so one client paginates both surfaces identically.
DEFAULT_EVIDENCE_PAGE_SIZE = 50
MAX_EVIDENCE_PAGE_SIZE = 500


# ===========================================================================
# Vocabulary
# ===========================================================================


class ConversionNodeKind(str, Enum):
    """Which side of the source → OpenAPI projection a node sits on."""

    SOURCE = "source"  # a construct in the source artifact (or its analysis)
    TARGET = "target"  # a location in the emitted OpenAPI document


class ConversionEdgeScope(str, Enum):
    """Which input an edge was derived from — see the module docstring.

    The scope is not decoration: :func:`reconcile_with_fidelity` checks only
    :attr:`CHECKLIST` and :attr:`LOSS` edges against the report, because those are the two
    scopes in one-to-one correspondence with it. :attr:`CONSTRUCT` and :attr:`ANALYSIS`
    edges add detail the report has no counterpart for, and are bounded independently.
    """

    CHECKLIST = "checklist"  # one fidelity checklist row (reconciles with the report)
    CONSTRUCT = "construct"  # one canonical construct → its OpenAPI location
    LOSS = "loss"  # one projection loss (reconciles with the report)
    ANALYSIS = "analysis"  # a source-analysis limit: what the analyzer could not describe


#: :class:`~app.fidelity.Coverage` → :class:`~app.projection_taxonomy.ConversionStatus`. The
#: bijection reconciliation depends on: every checklist row maps to exactly one status, and no
#: two coverages map to the same one, so a per-status tally is losslessly comparable with the
#: report's ``coverage_counts``.
STATUS_FOR_COVERAGE: Dict[Coverage, ConversionStatus] = {
    Coverage.PRESENT: ConversionStatus.RETAINED,
    Coverage.INFERRED: ConversionStatus.INFERRED,
    Coverage.PARTIAL: ConversionStatus.TRANSFORMED,
    Coverage.MISSING: ConversionStatus.DROPPED,
    Coverage.NA: ConversionStatus.NOT_APPLICABLE,
}

#: :class:`~app.emitter.LossKind` → status. An ``n/a`` loss is a construct with no OpenAPI
#: form at all (dropped); an ``inferred`` loss is one the projection had to synthesize.
STATUS_FOR_LOSS_KIND: Dict[LossKind, ConversionStatus] = {
    LossKind.NA: ConversionStatus.DROPPED,
    LossKind.INFERRED: ConversionStatus.INFERRED,
}

#: What a user can *do* about each cause category, phrased for the conversion surface.
#:
#: Deliberately separate from :func:`app.capability_registry.reason_explanation`'s
#: ``remediation``, which speaks in export terms ("re-export", "change the export option").
#: The taxonomy is shared; the imperative sentence is not, because telling someone to
#: re-export when they are converting a catalog item is advice they cannot follow.
CONVERSION_REMEDIATION: Dict[ProjectionReason, str] = {
    ProjectionReason.DESTINATION_UNSUPPORTED: (
        "OpenAPI has no equivalent construct; keep the source artifact as the system of "
        "record for this detail."
    ),
    ProjectionReason.EMITTER_UNSUPPORTED: (
        "apiome's converter does not yet place this construct in the OpenAPI document; "
        "the source detail is intact and a later converter version can carry it."
    ),
    ProjectionReason.SOURCE_INCOMPLETE: (
        "Supply the missing detail — re-convert with --title / --api-version / --server, or "
        "complete the source artifact and re-import it."
    ),
    ProjectionReason.SOURCE_PARSE_LIMIT: (
        "apiome's analyzer could not fully read this from the source; the source data itself "
        "may be intact. Re-import once analyzer support lands."
    ),
    ProjectionReason.OPTION_EXCLUDED: (
        "A conversion option excluded this construct; change the option and preview again."
    ),
    ProjectionReason.SECURITY_REDACTED: (
        "A redaction policy withheld this construct; adjust the policy if it should be converted."
    ),
    ProjectionReason.TARGET_TOOL_UNAVAILABLE: (
        "The toolchain this conversion path needs is unavailable; install or enable it and "
        "re-convert."
    ),
    ProjectionReason.NOT_APPLICABLE: "No action needed — the source has no such construct.",
}

# Checklist rows whose ``n/a`` is an *apiome canonical-model* limit rather than an absent
# source construct. OpenAPI can carry contact, license, security schemes, examples and
# external docs perfectly well; the canonical model simply does not retain them, so the
# truthful cause is ``emitter_unsupported`` — the status still reconciles as ``not-applicable``
# (that is what the report counted), while the reason code stops the manifest from implying
# the source had none.
_MODEL_LIMIT_CHECKLIST_KEYS = frozenset(
    {"info.contact", "info.license", "security", "examples", "externalDocs"}
)

# The checklist row that reports an OpenAPI 3.2 source narrowing onto the 3.1 target. Its
# non-``present`` coverage is a target-version limit, not a source gap.
_TARGET_VERSION_CHECKLIST_KEY = "source.openapi-version"

# Weight at or above which a checklist row counts as load-bearing for severity purposes
# (``paths`` 15, ``responses`` 12, ``components.schemas`` 10, ``requestBody`` 8).
_LOAD_BEARING_WEIGHT = 8

# Display/sort rank so a manifest serializes deterministically regardless of build order.
_NODE_KIND_ORDER: Dict[ConversionNodeKind, int] = {
    ConversionNodeKind.SOURCE: 0,
    ConversionNodeKind.TARGET: 1,
}
_SCOPE_ORDER: Dict[ConversionEdgeScope, int] = {
    ConversionEdgeScope.CHECKLIST: 0,
    ConversionEdgeScope.CONSTRUCT: 1,
    ConversionEdgeScope.LOSS: 2,
    ConversionEdgeScope.ANALYSIS: 3,
}

# Worst-first status rank. Used to decide which construct edges survive bounding, so a
# truncated manifest keeps the losses and drops the uneventful ``retained`` rows.
_STATUS_ORDER: Dict[ConversionStatus, int] = {
    ConversionStatus.DROPPED: 0,
    ConversionStatus.UNAVAILABLE: 1,
    ConversionStatus.INFERRED: 2,
    ConversionStatus.TRANSFORMED: 3,
    ConversionStatus.NOT_APPLICABLE: 4,
    ConversionStatus.RETAINED: 5,
}

# Every status except ``retained`` must name a cause; enforced on the model itself so no
# construction path (builder, constructor, or ``model_validate`` of stored JSON) can bypass
# it. This is the AC "every dropped node has a reason code", widened to every non-preserved
# outcome because an unexplained ``inferred`` is just as unactionable as an unexplained drop.
_REASON_REQUIRED_STATUSES = frozenset(
    status for status in ConversionStatus if status is not ConversionStatus.RETAINED
)


class ConversionReconciliationError(Exception):
    """Raised when a manifest's edge tallies disagree with the fidelity report it describes.

    The contract guarantee behind the AC "manifest schema validates and reconciles with
    fidelity report counts": :func:`build_conversion_manifest` asserts it defensively before
    returning, so a builder bug surfaces as a hard error rather than as two surfaces quietly
    telling the user different numbers.
    """


# ===========================================================================
# Node / edge value types
# ===========================================================================


class EvidenceRef(BaseModel):
    """One citation backing an edge — where a reader can go to check the claim.

    Three kinds, each resolvable by an existing surface: ``analysis-node`` cites a node id in
    the revision's payload analysis (CPDO-1.1, ``GET .../analysis``), ``document-pointer``
    cites an RFC 6901 pointer into the emitted OpenAPI document, and ``source-construct``
    cites a canonical construct key. A reference is only emitted when it is real — an edge
    with nothing to cite carries an empty list rather than a placeholder.
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(
        description="``analysis-node`` / ``document-pointer`` / ``source-construct``.",
    )
    ref: str = Field(description="The citation itself: a node id, a JSON Pointer, or a key.")
    location: Optional[SourceLocation] = Field(
        default=None,
        description="Where in the raw source the citation sits, when the analyzer captured it.",
    )


class SourceEvidence(BaseModel):
    """Source-native detail for a construct, recovered best-effort and never fabricated.

    Read from the canonical construct's ``extras`` bag with the same accessors the export
    manifest uses (:func:`~app.export_projection.first_extra` over
    :data:`~app.export_projection.NATIVE_ID_EXTRA_KEYS` /
    :data:`~app.export_projection.SOURCE_LOCATION_EXTRA_KEYS`), so provenance extraction
    cannot drift between the two manifest surfaces. Every field is optional: a normalizer
    that captured no native detail leaves a bare node instead of an invented one.
    """

    model_config = ConfigDict(extra="forbid")

    native_id: Optional[str] = Field(
        default=None, description="Source-native stable identifier, when the parser captured one."
    )
    native_name: Optional[str] = Field(
        default=None, description="The construct's name in the source document."
    )
    source_location: Optional[str] = Field(
        default=None, description="Source location (line/range/pointer), when captured."
    )
    construct_kind: Optional[str] = Field(
        default=None,
        description="Coarse class: operation / channel / type / field / checklist / analysis.",
    )


class ConversionNode(BaseModel):
    """One node in the conversion graph: a source construct, or an OpenAPI location.

    A single model with a :attr:`kind` discriminator so a renderer (CPDO-3.1) can lay the
    graph out in two lanes from one homogeneous list. :attr:`id` is deterministic — derived
    from the node kind plus the construct key or JSON Pointer — so the same source revision
    and defaults always produce the same ids.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Deterministic, stable node id (unique within a manifest).")
    kind: ConversionNodeKind = Field(description="Which side of the projection this node is on.")
    label: str = Field(description="Short human label: a construct key, name, or JSON Pointer.")
    construct_key: Optional[str] = Field(
        default=None, description="The source construct key this node concerns, when it has one."
    )
    source: Optional[SourceEvidence] = Field(
        default=None, description="Source-native evidence, on a ``source`` node."
    )
    target: Optional[TargetLocation] = Field(
        default=None, description="The emitted-document location, on a ``target`` node."
    )


class ConversionEdge(BaseModel):
    """One source-construct → OpenAPI outcome, with its cause, evidence and remedy.

    :attr:`target` is ``None`` when nothing in the emitted document corresponds — a dropped
    construct, or one whose fate could not be determined. Every non-``retained`` edge carries
    a :attr:`reason`; the model itself enforces that, so an unexplained outcome cannot be
    constructed, serialized, or read back from storage.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Deterministic, stable edge id (unique within a manifest).")
    scope: ConversionEdgeScope = Field(description="Which input this edge was derived from.")
    source: str = Field(description="Id of the source node this edge starts at.")
    target: Optional[str] = Field(
        default=None,
        description="Id of the target node this edge ends at; null when nothing in the "
        "emitted document corresponds.",
    )
    status: ConversionStatus = Field(description="What became of the construct.")
    reason: Optional[ProjectionReason] = Field(
        default=None,
        description="Cause category; required for every status other than ``retained``.",
    )
    severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="How much the outcome matters (info / warn / critical).",
    )
    detail: str = Field(description="Human-readable explanation of this specific outcome.")
    remediation: Optional[str] = Field(
        default=None,
        description="What the user can do about it (from :data:`CONVERSION_REMEDIATION`); "
        "absent on a ``retained`` edge, which needs no remedy.",
    )
    evidence: List[EvidenceRef] = Field(
        default_factory=list,
        description="Citations backing the outcome, in a deterministic order.",
    )
    count: int = Field(
        default=1,
        ge=0,
        description="How many source instances this edge summarizes — 1 for a construct or "
        "loss edge, the checklist row's ``count`` for an aggregate row.",
    )

    @model_validator(mode="after")
    def _require_reason(self) -> "ConversionEdge":
        """Enforce that every non-``retained`` outcome names a cause (the CPDO-1.3 AC)."""
        if self.status in _REASON_REQUIRED_STATUSES and self.reason is None:
            raise ValueError(
                f"conversion edge {self.id!r} with status {self.status.value!r} requires a "
                "reason code"
            )
        return self


# ===========================================================================
# Manifest provenance blocks
# ===========================================================================


class ConversionAnalysisRef(BaseModel):
    """What the source-side payload analysis (CPDO-1.1/1.2) contributed, or why it did not.

    Always present on a manifest, including when there is no analysis at all: a reader must
    never have to infer whether the ``analysis``-scoped edges are absent because the source
    was fully understood or because nothing ever looked at it. :attr:`available` answers that
    in one boolean, and :attr:`status` / :attr:`status_reason` say which of the two it is.
    """

    model_config = ConfigDict(extra="forbid")

    available: bool = Field(
        description="True when an analysis backed this manifest's source-side evidence."
    )
    status: str = Field(
        description="The analysis record's status (available / partial / unavailable / failed)."
    )
    status_reason: Optional[str] = Field(
        default=None, description="Reason code when the status is not ``available``."
    )
    analyzer_key: Optional[str] = Field(default=None, description="Analyzer that produced it.")
    analyzer_version: Optional[str] = Field(default=None, description="Analyzer version.")
    node_count: int = Field(default=0, ge=0, description="Nodes in the analysed native tree.")
    truncated: bool = Field(
        default=False, description="True when bounding dropped nodes the source actually had."
    )
    unsupported_constructs: List[str] = Field(
        default_factory=list,
        description="Construct keys the analyzer declares it does not model, sorted.",
    )


class ConversionManifestSource(BaseModel):
    """The source coordinates a manifest describes.

    Carried for reference and **excluded from the manifest hash** on purpose: the hash is
    content-addressed, so converting the same bytes with the same defaults in another project
    is recognizably the same snapshot rather than a spuriously different one.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: Optional[str] = Field(
        default=None, description="Catalog item id (a project id) that was converted."
    )
    version_record_id: Optional[str] = Field(
        default=None, description="Source revision row id (``versions.id``) that was converted."
    )
    source_format: Optional[str] = Field(default=None, description="Source format key.")
    source_protocol: Optional[str] = Field(default=None, description="Source protocol.")
    source_version_label: Optional[str] = Field(
        default=None, description="Source-declared API version label."
    )
    paradigm: Optional[str] = Field(default=None, description="Canonical paradigm of the source.")
    analysis: ConversionAnalysisRef = Field(
        description="What the payload analysis contributed, or why it did not."
    )


class ConversionManifest(BaseModel):
    """The full source → OpenAPI conversion graph for one conversion (CPDO-1.3).

    Ordering and counts are invariants of the model — re-sorted and re-derived on every
    validation — so a manifest built by :func:`build_conversion_manifest`, constructed
    directly, or read back from persisted JSON serializes identically. The heavy graph lives
    here; :class:`ConversionManifestSummary` is the bounded form that rides in a dry-run or
    commit response.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(
        default=CONVERSION_MANIFEST_SCHEMA_VERSION,
        description="Manifest contract version, folded into the hash.",
    )
    manifest_hash: str = Field(
        default="",
        description="Content-addressed snapshot hash; set by the builder. Identical inputs "
        "(source bytes, defaults, tool versions) yield an identical hash.",
    )
    source: ConversionManifestSource = Field(description="The source coordinates described.")
    target_format: str = Field(description="Emit target the conversion produced (``openapi-3.1``).")
    conversion_mode: str = Field(
        description="How the document was produced: ``passthrough`` / ``typespec_native`` / ``lossy``."
    )
    tool_versions: Dict[str, str] = Field(
        default_factory=dict,
        description="Converter tool versions that produced the conversion (MFI-22.5), so a "
        "manifest states what made it.",
    )
    defaults: Dict[str, Any] = Field(
        default_factory=dict,
        description="Normalized user-supplied conversion defaults folded into the hash; a "
        "different set of gap-filling defaults is a different snapshot.",
    )
    nodes: List[ConversionNode] = Field(
        default_factory=list, description="Graph nodes in a deterministic canonical order."
    )
    edges: List[ConversionEdge] = Field(
        default_factory=list, description="Graph edges in a deterministic canonical order."
    )
    status_counts: Dict[str, int] = Field(
        default_factory=dict, description="Edge count per status, zero-filled. Derived."
    )
    reason_counts: Dict[str, int] = Field(
        default_factory=dict, description="Edge count per reason code, zero-filled. Derived."
    )
    scope_counts: Dict[str, int] = Field(
        default_factory=dict, description="Edge count per scope, zero-filled. Derived."
    )
    total_constructs: int = Field(
        default=0, description="Distinct source constructs the manifest projects. Derived."
    )
    truncated: bool = Field(
        default=False, description="True when bounding left construct/analysis edges out."
    )
    dropped_edge_count: int = Field(
        default=0, ge=0, description="How many edges bounding left out, when truncated."
    )
    bounds: Dict[str, int] = Field(
        default_factory=dict,
        description="The budgets in force when the manifest was built, so a bounded manifest "
        "is distinguishable from a small one.",
    )

    @model_validator(mode="after")
    def _order_and_count(self) -> "ConversionManifest":
        """Sort nodes/edges canonically and re-derive the status/reason/scope tallies."""
        self.nodes.sort(key=lambda node: (_NODE_KIND_ORDER[node.kind], node.id))
        self.edges.sort(key=lambda edge: (_SCOPE_ORDER[edge.scope], edge.id))

        status_counts = {status.value: 0 for status in ConversionStatus}
        reason_counts = {reason.value: 0 for reason in ProjectionReason}
        scope_counts = {scope.value: 0 for scope in ConversionEdgeScope}
        for edge in self.edges:
            status_counts[edge.status.value] += 1
            scope_counts[edge.scope.value] += 1
            if edge.reason is not None:
                reason_counts[edge.reason.value] += 1

        self.status_counts = status_counts
        self.reason_counts = reason_counts
        self.scope_counts = scope_counts
        self.total_constructs = sum(
            1 for node in self.nodes if node.kind is ConversionNodeKind.SOURCE
        )
        return self

    def edges_in_scope(self, scope: ConversionEdgeScope) -> List[ConversionEdge]:
        """Return this manifest's edges for one :class:`ConversionEdgeScope`, in canonical order."""
        return [edge for edge in self.edges if edge.scope is scope]

    @property
    def worst_severity(self) -> Optional[LossinessSeverity]:
        """Worst severity among non-``retained`` edges, or ``None`` when everything was retained."""
        rank = {LossinessSeverity.CRITICAL: 0, LossinessSeverity.WARN: 1, LossinessSeverity.INFO: 2}
        worst: Optional[LossinessSeverity] = None
        worst_rank = len(rank)
        for edge in self.edges:
            if edge.status is ConversionStatus.RETAINED:
                continue
            if rank[edge.severity] < worst_rank:
                worst_rank = rank[edge.severity]
                worst = edge.severity
        return worst


class ConversionManifestSummary(BaseModel):
    """The bounded manifest reference a dry-run / commit response embeds.

    Everything a caller needs to *identify and size* a snapshot — the hash, the tool versions
    that made it, the aggregate tallies — without the (potentially thousands of rows) graph,
    which is fetched page by page. Because it is derived from the deterministic manifest, a
    preview, a committed conversion and a CLI JSON dump all describe the same snapshot.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(description="Manifest contract version.")
    manifest_hash: str = Field(description="The content-addressed snapshot id.")
    source: ConversionManifestSource = Field(description="The source coordinates described.")
    target_format: str = Field(description="Emit target the conversion produced.")
    conversion_mode: str = Field(description="passthrough / typespec_native / lossy.")
    tool_versions: Dict[str, str] = Field(description="Converter tool versions that made it.")
    defaults: Dict[str, Any] = Field(description="Normalized defaults folded into the hash.")
    status_counts: Dict[str, int] = Field(description="Edge count per status, zero-filled.")
    reason_counts: Dict[str, int] = Field(description="Edge count per reason code, zero-filled.")
    scope_counts: Dict[str, int] = Field(description="Edge count per scope, zero-filled.")
    node_count: int = Field(description="Total nodes in the full manifest.")
    edge_count: int = Field(description="Total edges in the full manifest.")
    total_constructs: int = Field(description="Distinct source constructs projected.")
    is_lossless: bool = Field(description="True when every edge is ``retained``.")
    worst_severity: Optional[LossinessSeverity] = Field(
        default=None, description="Worst severity among non-retained edges; null when lossless."
    )
    truncated: bool = Field(default=False, description="True when the graph was bounded.")
    dropped_edge_count: int = Field(default=0, ge=0, description="Edges bounding left out.")


class ConversionEvidencePage(BaseModel):
    """One cursor-paginated page of a manifest's edges plus the nodes they reference.

    Deterministic: pages are sliced from the manifest's canonical edge order, so paging the
    same manifest twice yields identical pages. The cursor codec is shared with the export
    manifest (:func:`~app.export_projection.encode_page_cursor`), so one client understands
    both surfaces' cursors.
    """

    model_config = ConfigDict(extra="forbid")

    manifest_hash: str = Field(description="The manifest this page belongs to.")
    edges: List[ConversionEdge] = Field(description="This page's edges, in canonical order.")
    nodes: List[ConversionNode] = Field(description="The nodes this page's edges reference.")
    next_cursor: Optional[str] = Field(
        default=None, description="Opaque cursor for the next page; null on the last page."
    )
    total: int = Field(description="Total edges across the whole manifest.")


# ===========================================================================
# Small pure helpers
# ===========================================================================


def normalize_defaults_for_hash(defaults: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """Normalize conversion defaults into a stable dict for the manifest hash.

    Blank strings and empty server lists are dropped rather than recorded as present, so
    ``{"title": ""}`` and ``{}`` are the same snapshot — they fill the same (zero) gaps.

    Args:
        defaults: The user's gap-filling defaults (title / version / servers), or ``None``.

    Returns:
        A dict with only the defaults that would actually be applied, servers sorted.
    """
    if not defaults:
        return {}
    normalized: Dict[str, Any] = {}
    title = str(defaults.get("title") or "").strip()
    if title:
        normalized["title"] = title
    version = str(defaults.get("version") or "").strip()
    if version:
        normalized["version"] = version
    servers = [str(url).strip() for url in (defaults.get("servers") or []) if str(url).strip()]
    if servers:
        normalized["servers"] = sorted(set(servers))
    return normalized


def _resolve_pointer(document: Mapping[str, Any], pointer: str) -> bool:
    """Return True when ``pointer`` (RFC 6901) addresses something in ``document``.

    Used to check a construct actually landed where the locator said it would. Only object
    traversal is needed — every location this module builds addresses a mapping key — so an
    array index or a malformed token simply reports "not found" rather than raising.

    Args:
        document: The emitted OpenAPI document.
        pointer: An RFC 6901 JSON Pointer, e.g. ``/paths/~1pets/get``.

    Returns:
        True when the pointer resolves.
    """
    if not pointer or not pointer.startswith("/"):
        return False
    current: Any = document
    for raw_token in pointer.lstrip("/").split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, Mapping) or token not in current:
            return False
        current = current[token]
    return True


def _source_evidence(extras: Mapping[str, Any], name: Optional[str], kind: str) -> SourceEvidence:
    """Recover best-effort native evidence for a construct from its ``extras`` bag."""
    bag = dict(extras or {})
    return SourceEvidence(
        native_id=first_extra(bag, NATIVE_ID_EXTRA_KEYS),
        native_name=name,
        source_location=first_extra(bag, SOURCE_LOCATION_EXTRA_KEYS),
        construct_kind=kind,
    )


def _checklist_reason(item: ChecklistItem, status: ConversionStatus) -> Optional[ProjectionReason]:
    """Derive the truthful cause category for one checklist row's outcome.

    Three distinct causes hide behind the report's coverage tags, and only the reason code
    tells them apart:

    * the target-version row's non-``present`` outcome is an OpenAPI 3.1 limit
      (``destination_unsupported``) — a 3.2 source's QUERY methods have no 3.1 form;
    * an ``n/a`` on a row the canonical model simply does not retain (contact, license,
      security, examples, external docs) is an apiome limit (``emitter_unsupported``), not a
      statement that the source had none; every other ``n/a`` genuinely is ``not_applicable``;
    * everything else non-``present`` traces back to what the source did or did not declare
      (``source_incomplete``).

    Args:
        item: The checklist row being classified.
        status: The row's coverage mapped through :data:`STATUS_FOR_COVERAGE`.

    Returns:
        The cause category, or ``None`` for a ``retained`` row (which needs none).
    """
    if status is ConversionStatus.RETAINED:
        return None
    if item.key == _TARGET_VERSION_CHECKLIST_KEY:
        if status is ConversionStatus.NOT_APPLICABLE:
            return ProjectionReason.NOT_APPLICABLE
        return ProjectionReason.DESTINATION_UNSUPPORTED
    if status is ConversionStatus.NOT_APPLICABLE:
        if item.key in _MODEL_LIMIT_CHECKLIST_KEYS:
            return ProjectionReason.EMITTER_UNSUPPORTED
        return ProjectionReason.NOT_APPLICABLE
    return ProjectionReason.SOURCE_INCOMPLETE


def _checklist_severity(item: ChecklistItem, status: ConversionStatus) -> LossinessSeverity:
    """Rank a checklist row's outcome by how load-bearing the construct is.

    A dropped ``paths`` or ``responses`` row means the converted spec cannot describe the API
    at all — critical. The same status on a light metadata row is a footnote. ``retained`` and
    ``not-applicable`` are always informational: nothing was lost.
    """
    if status in (ConversionStatus.RETAINED, ConversionStatus.NOT_APPLICABLE):
        return LossinessSeverity.INFO
    load_bearing = item.weight >= _LOAD_BEARING_WEIGHT
    if status is ConversionStatus.DROPPED:
        return LossinessSeverity.CRITICAL if load_bearing else LossinessSeverity.WARN
    return LossinessSeverity.WARN if load_bearing else LossinessSeverity.INFO


def _construct_severity(kind: str, status: ConversionStatus) -> LossinessSeverity:
    """Rank one construct edge: losing an operation or a named type outranks losing a field."""
    if status is ConversionStatus.RETAINED:
        return LossinessSeverity.INFO
    if status is ConversionStatus.DROPPED:
        return LossinessSeverity.CRITICAL if kind in ("operation", "type") else LossinessSeverity.WARN
    if status is ConversionStatus.NOT_APPLICABLE:
        return LossinessSeverity.INFO
    return LossinessSeverity.WARN


# ===========================================================================
# Builder internals
# ===========================================================================


class _GraphBuilder:
    """Accumulates nodes and edges while the builder walks its four inputs.

    Exists so node de-duplication (several edges can cite one source construct, several
    constructs can land under one pointer) happens in one place, and so the caller never has
    to remember to register a node before referencing it from an edge.
    """

    def __init__(self) -> None:
        self._nodes: Dict[str, ConversionNode] = {}
        self.edges: List[ConversionEdge] = []

    def source_node(
        self,
        node_id: str,
        *,
        label: str,
        construct_key: Optional[str] = None,
        evidence: Optional[SourceEvidence] = None,
    ) -> str:
        """Register (once) a source-side node and return its id."""
        if node_id not in self._nodes:
            self._nodes[node_id] = ConversionNode(
                id=node_id,
                kind=ConversionNodeKind.SOURCE,
                label=label,
                construct_key=construct_key,
                source=evidence,
            )
        return node_id

    def target_node(self, pointer: str, *, construct_key: Optional[str] = None) -> str:
        """Register (once) a target-side node for an emitted JSON Pointer and return its id."""
        node_id = f"target:{pointer}"
        if node_id not in self._nodes:
            self._nodes[node_id] = ConversionNode(
                id=node_id,
                kind=ConversionNodeKind.TARGET,
                label=pointer,
                construct_key=construct_key,
                target=TargetLocation(json_pointer=pointer),
            )
        return node_id

    def has_node(self, node_id: str) -> bool:
        """True when ``node_id`` has already been registered."""
        return node_id in self._nodes

    def prune_unreferenced(self, edges: Sequence[ConversionEdge]) -> List[ConversionNode]:
        """Return only the nodes ``edges`` still reference.

        Bounding drops edges, and a node left behind by a dropped edge would inflate
        ``total_constructs`` with constructs the manifest no longer describes.
        """
        referenced = set()
        for edge in edges:
            referenced.add(edge.source)
            if edge.target:
                referenced.add(edge.target)
        return [node for node in self._nodes.values() if node.id in referenced]


def _edge(
    *,
    edge_id: str,
    scope: ConversionEdgeScope,
    source: str,
    target: Optional[str],
    status: ConversionStatus,
    reason: Optional[ProjectionReason],
    severity: LossinessSeverity,
    detail: str,
    evidence: Optional[List[EvidenceRef]] = None,
    count: int = 1,
) -> ConversionEdge:
    """Build one edge, attaching the reason's conversion-phrased remediation automatically.

    Centralized so remediation can never be forgotten on a non-preserved outcome, and never
    invented on a ``retained`` one (which needs no remedy).
    """
    return ConversionEdge(
        id=edge_id,
        scope=scope,
        source=source,
        target=target,
        status=status,
        reason=reason,
        severity=severity,
        detail=detail,
        remediation=CONVERSION_REMEDIATION[reason] if reason is not None else None,
        evidence=evidence or [],
        count=count,
    )


def _checklist_edges(builder: _GraphBuilder, report: FidelityReport, document: Mapping[str, Any]) -> None:
    """Add one edge per fidelity checklist row — the rows that reconcile with the report.

    A row's ``examples`` are heterogeneous by design (``/info/title`` for a document field,
    ``GET /pets`` for an operation-scoped row), so a target node is created only for an example
    that both *looks* like a JSON Pointer and *resolves* in the emitted document. Anything else
    leaves the edge without a target rather than pointing somewhere that does not exist.
    """
    for item in report.items:
        status = STATUS_FOR_COVERAGE[item.coverage]
        reason = _checklist_reason(item, status)
        source_id = builder.source_node(
            f"source:checklist:{item.key}",
            label=item.title,
            construct_key=item.key,
            evidence=SourceEvidence(native_name=item.title, construct_kind="checklist"),
        )

        target_id: Optional[str] = None
        evidence: List[EvidenceRef] = []
        for example in item.examples:
            if example.startswith("/") and _resolve_pointer(document, example):
                evidence.append(EvidenceRef(kind="document-pointer", ref=example))
                if target_id is None:
                    target_id = builder.target_node(example, construct_key=item.key)

        builder.edges.append(
            _edge(
                edge_id=f"checklist:{item.key}",
                scope=ConversionEdgeScope.CHECKLIST,
                source=source_id,
                target=target_id,
                status=status,
                reason=reason,
                severity=_checklist_severity(item, status),
                detail=item.reason,
                evidence=evidence,
                count=item.count,
            )
        )


def _loss_edges(builder: _GraphBuilder, report: FidelityReport) -> None:
    """Add one edge per projection loss — the second scope that reconciles with the report.

    A loss's ``pointer`` is either a canonical construct key or an emitted JSON Pointer. When
    it names a construct the construct lane already registered, the edge reuses that node so
    the graph shows one source construct with both its outcome and its loss, rather than two
    unrelated nodes describing the same thing.
    """
    for index, loss in enumerate(report.losses):
        status = STATUS_FOR_LOSS_KIND[loss.kind]
        reason = (
            ProjectionReason.DESTINATION_UNSUPPORTED
            if loss.kind is LossKind.NA
            else ProjectionReason.SOURCE_INCOMPLETE
        )
        pointer = (loss.pointer or "").strip()
        construct_node_id = f"source:construct:{pointer}" if pointer else ""
        if construct_node_id and builder.has_node(construct_node_id):
            source_id = construct_node_id
        else:
            source_id = builder.source_node(
                f"source:loss:{index}",
                label=pointer or loss.subject,
                construct_key=pointer or None,
                evidence=SourceEvidence(native_name=pointer or loss.subject, construct_kind="loss"),
            )
        evidence = [EvidenceRef(kind="source-construct", ref=pointer)] if pointer else []
        builder.edges.append(
            _edge(
                edge_id=f"loss:{index:04d}:{loss.subject}",
                scope=ConversionEdgeScope.LOSS,
                source=source_id,
                target=None,
                status=status,
                reason=reason,
                severity=(
                    LossinessSeverity.CRITICAL if loss.kind is LossKind.NA else LossinessSeverity.WARN
                ),
                detail=loss.detail,
                evidence=evidence,
            )
        )


def _operation_pointer(
    api: CanonicalApi, operation: Operation, service: Service
) -> Optional[str]:
    """Return the JSON Pointer the emitter would write ``operation`` to, or ``None``.

    Re-resolves the binding through the very :class:`~app.projection.ProjectionStrategy` the
    emitter used, against a **scratch** :class:`~app.emitter.LossTracker` whose records are
    discarded — the real losses already came through the
    :class:`~app.fidelity.FidelityReport`, and re-running the strategy must not double-count
    them. Deriving the route from the operation key instead would be wrong for every non-REST
    paradigm, where the key is ``Query.user`` or ``acme.PetService.GetPet`` and the route is
    synthesized.

    Returns ``None`` when the strategy reports the operation has no OpenAPI representation.
    """
    from .projection import get_projection

    strategy = get_projection(api.paradigm)
    binding = strategy.route(operation, service, LossTracker())
    if binding is None:
        return None
    return ProvenanceTracker.child("/paths", binding.path, binding.method)


def _status_from_provenance(
    result: Optional[EmitResult], pointer: str
) -> Tuple[ConversionStatus, Optional[ProjectionReason], str]:
    """Classify an emitted construct from the emitter's provenance note at ``pointer``.

    No note means the emitter copied the value straight across (it only records the *departures*
    from the source), so the absence of a note is itself evidence of fidelity. ``inferred`` and
    ``default`` both mean the conversion supplied what the source did not, which is
    ``source_incomplete`` either way — the distinction between "derived from structure" and
    "system fallback" is carried in the detail sentence rather than the status.
    """
    note = None
    if result is not None:
        for record in result.provenance:
            if record.pointer == pointer:
                note = record
                break
    if note is None or note.provenance is Provenance.SOURCE:
        return ConversionStatus.RETAINED, None, "carried from the source into the emitted document"
    detail = note.detail or (
        "derived by the conversion from the model's structure"
        if note.provenance is Provenance.INFERRED
        else "supplied by the conversion as a fallback; the source declared none"
    )
    return ConversionStatus.INFERRED, ProjectionReason.SOURCE_INCOMPLETE, detail


def _construct_rows(
    api: CanonicalApi, document: Mapping[str, Any], result: Optional[EmitResult]
) -> List[Tuple[str, str, Optional[str], str, ConversionStatus, Optional[ProjectionReason], str]]:
    """Resolve every canonical construct to its OpenAPI outcome.

    Walks operations, channels, named types and record fields — the same constructs the export
    manifest indexes — and returns one row per construct as
    ``(key, kind, pointer, native_name, status, reason, detail)``. Pointer resolution is
    *verified against the emitted document*: a construct whose expected location is not there is
    ``unavailable`` (apiome could not place it), never ``dropped`` (which would claim a loss the
    manifest has not established). Channels are the one exception — OpenAPI has no channel
    object at all, so their absence is a proven destination limit.
    """
    rows: List[
        Tuple[str, str, Optional[str], str, ConversionStatus, Optional[ProjectionReason], str]
    ] = []

    for service in api.services:
        for operation in service.operations:
            pointer = _operation_pointer(api, operation, service)
            if pointer is None:
                rows.append(
                    (
                        operation.key,
                        "operation",
                        None,
                        operation.name,
                        ConversionStatus.DROPPED,
                        ProjectionReason.DESTINATION_UNSUPPORTED,
                        "the projection found no OpenAPI path/method this operation can bind to",
                    )
                )
                continue
            if not _resolve_pointer(document, pointer):
                rows.append(
                    (
                        operation.key,
                        "operation",
                        None,
                        operation.name,
                        ConversionStatus.UNAVAILABLE,
                        ProjectionReason.EMITTER_UNSUPPORTED,
                        f"expected at {pointer}, but the emitted document has nothing there",
                    )
                )
                continue
            status, reason, detail = _status_from_provenance(result, pointer)
            rows.append((operation.key, "operation", pointer, operation.name, status, reason, detail))

    for channel in api.channels:
        rows.append(
            (
                channel.key,
                "channel",
                None,
                channel.name or channel.key,
                ConversionStatus.DROPPED,
                ProjectionReason.DESTINATION_UNSUPPORTED,
                "OpenAPI has no channel object; the event address has no counterpart",
            )
        )

    for type_ in api.types:
        rows.append(_addressable_row(document, result, type_.key, "type", type_.name))
        for field in type_.fields:
            rows.append(_addressable_row(document, result, field.key, "field", field.name))

    return rows


def _addressable_row(
    document: Mapping[str, Any],
    result: Optional[EmitResult],
    key: str,
    kind: str,
    name: str,
) -> Tuple[str, str, Optional[str], str, ConversionStatus, Optional[ProjectionReason], str]:
    """Resolve one key-addressable construct (a named type or a record field) to its outcome.

    Uses :func:`~app.export_projection.target_location_for_construct` — the shared locator seam
    — so this manifest and an export projection can never claim different OpenAPI addresses for
    the same construct.
    """
    from .openapi_emitter import OpenApiEmitter

    location = target_location_for_construct(OpenApiEmitter, key, kind)
    pointer = location.json_pointer if location is not None else None
    if not pointer or not _resolve_pointer(document, pointer):
        # A field can legitimately live inside its owner's schema without being addressable as
        # a named property (a union variant, an enum member, a composed schema). We cannot see
        # where it went, and saying "dropped" would assert a loss we have not established.
        return (
            key,
            kind,
            None,
            name,
            ConversionStatus.UNAVAILABLE,
            ProjectionReason.EMITTER_UNSUPPORTED,
            "the emitted document has no addressable location for this construct",
        )
    status, reason, detail = _status_from_provenance(result, pointer)
    return key, kind, pointer, name, status, reason, detail


def _admit_construct_edges(
    builder: _GraphBuilder,
    api: CanonicalApi,
    document: Mapping[str, Any],
    result: Optional[EmitResult],
) -> int:
    """Add construct edges, bounded worst-status-first, and return how many were left out.

    Bounding admits by ``(status rank, kind, key)`` so a truncated manifest keeps every drop and
    every unresolved construct and sheds the uneventful ``retained`` rows — the opposite of a
    head-of-list truncation, which would hide exactly the rows a user opened the manifest for.
    """
    rows = _construct_rows(api, document, result)
    kind_rank = {"operation": 0, "channel": 1, "type": 2, "field": 3}
    rows.sort(key=lambda row: (_STATUS_ORDER[row[4]], kind_rank.get(row[1], 9), row[0]))

    admitted = rows[:MAX_CONSTRUCT_EDGES]
    extras_by_key = _extras_index(api)

    for key, kind, pointer, name, status, reason, detail in admitted:
        source_id = builder.source_node(
            f"source:construct:{key}",
            label=name or key,
            construct_key=key,
            evidence=_source_evidence(extras_by_key.get(key, {}), name or key, kind),
        )
        target_id = builder.target_node(pointer, construct_key=key) if pointer else None
        evidence = [EvidenceRef(kind="source-construct", ref=key)]
        if pointer:
            evidence.append(EvidenceRef(kind="document-pointer", ref=pointer))
        builder.edges.append(
            _edge(
                edge_id=f"construct:{kind}:{key}",
                scope=ConversionEdgeScope.CONSTRUCT,
                source=source_id,
                target=target_id,
                status=status,
                reason=reason,
                severity=_construct_severity(kind, status),
                detail=detail,
                evidence=evidence,
            )
        )
    return len(rows) - len(admitted)


def _extras_index(api: CanonicalApi) -> Dict[str, Dict[str, Any]]:
    """Index every walked construct's ``extras`` bag by key, for native-evidence recovery."""
    index: Dict[str, Dict[str, Any]] = {}
    for operation in api.operations():
        index[operation.key] = dict(operation.extras or {})
    for channel in api.channels:
        index[channel.key] = dict(channel.extras or {})
    for type_ in api.types:
        index[type_.key] = dict(type_.extras or {})
        for field in type_.fields:
            index[field.key] = dict(field.extras or {})
    return index


def _analysis_ref(analysis: Optional[PayloadAnalysisDocument]) -> ConversionAnalysisRef:
    """Summarize what the payload analysis contributed — including "nothing, and here is why"."""
    if analysis is None:
        return ConversionAnalysisRef(
            available=False,
            status="unavailable",
            status_reason="not_analyzed",
        )
    return ConversionAnalysisRef(
        available=analysis.status == "available",
        status=analysis.status,
        status_reason=analysis.status_reason,
        analyzer_key=analysis.analyzer.key,
        analyzer_version=analysis.analyzer.version,
        node_count=analysis.metrics.node_count,
        truncated=analysis.metrics.truncated,
        unsupported_constructs=list(analysis.capabilities.unsupported[:MAX_ANALYSIS_EDGES]),
    )


def _analysis_edges(
    builder: _GraphBuilder, analysis: Optional[PayloadAnalysisDocument]
) -> int:
    """Add the "was the input incomplete" edges, and return how many were left out by bounding.

    Four genuinely different admissions, each ``unavailable`` because none of them is a
    statement about the *conversion* — they are statements about how much of the source apiome
    ever saw:

    * no analysis at all, or one that is not ``available`` → one edge naming which;
    * a bounded tree → one edge, ``source_parse_limit``, naming the dropped-node floor;
    * each construct the analyzer declares ``unsupported`` → one edge, ``source_parse_limit``:
      a construct absent from the tree is absent from the *analysis*, not necessarily from the
      source, and this is what tells the two apart;
    * each analysis warning that names a node → one edge citing that node, so a reader can open
      the source viewer at the place the analyzer stumbled.
    """
    if analysis is None:
        source_id = builder.source_node(
            "source:analysis:absent",
            label="source analysis",
            evidence=SourceEvidence(native_name="source analysis", construct_kind="analysis"),
        )
        builder.edges.append(
            _edge(
                edge_id="analysis:absent",
                scope=ConversionEdgeScope.ANALYSIS,
                source=source_id,
                target=None,
                status=ConversionStatus.UNAVAILABLE,
                reason=ProjectionReason.SOURCE_INCOMPLETE,
                severity=LossinessSeverity.INFO,
                detail=(
                    "no payload analysis exists for this revision, so the manifest cannot say "
                    "which native source constructs were seen"
                ),
            )
        )
        return 0

    dropped = 0
    if analysis.status != "available":
        source_id = builder.source_node(
            "source:analysis:status",
            label="source analysis",
            evidence=SourceEvidence(native_name="source analysis", construct_kind="analysis"),
        )
        builder.edges.append(
            _edge(
                edge_id="analysis:status",
                scope=ConversionEdgeScope.ANALYSIS,
                source=source_id,
                target=None,
                status=ConversionStatus.UNAVAILABLE,
                reason=(
                    ProjectionReason.SOURCE_PARSE_LIMIT
                    if analysis.status in ("partial", "failed")
                    else ProjectionReason.SOURCE_INCOMPLETE
                ),
                severity=LossinessSeverity.INFO,
                detail=(
                    f"the source analysis is {analysis.status!r}"
                    + (f" ({analysis.status_reason})" if analysis.status_reason else "")
                ),
            )
        )

    if analysis.metrics.truncated:
        source_id = builder.source_node(
            "source:analysis:bounds",
            label="source analysis bounds",
            evidence=SourceEvidence(native_name="source analysis", construct_kind="analysis"),
        )
        builder.edges.append(
            _edge(
                edge_id="analysis:bounds",
                scope=ConversionEdgeScope.ANALYSIS,
                source=source_id,
                target=None,
                status=ConversionStatus.UNAVAILABLE,
                reason=ProjectionReason.SOURCE_PARSE_LIMIT,
                severity=LossinessSeverity.WARN,
                detail=(
                    "the source analysis was bounded; at least "
                    f"{analysis.metrics.dropped_node_count} native node(s) were not recorded"
                ),
            )
        )

    # One budget across both per-construct lanes, so a pathological declaration cannot crowd
    # the node-scoped warnings out entirely (or vice versa). Both lanes are de-duplicated first:
    # ``analyzer_capabilities`` normally collapses duplicates, but a directly-constructed record
    # need not have, and two edges sharing an id would break both the stable-id guarantee and the
    # node lookup pagination does.
    unsupported = list(dict.fromkeys(analysis.capabilities.unsupported))
    node_warnings: List[Any] = []
    seen_warnings: set = set()
    for warning in analysis.warnings:
        if not warning.node_id:
            continue
        signature = (warning.code, warning.node_id)
        if signature in seen_warnings:
            continue
        seen_warnings.add(signature)
        node_warnings.append(warning)
    half = max(1, MAX_ANALYSIS_EDGES // 2)
    unsupported_budget = MAX_ANALYSIS_EDGES - min(len(node_warnings), half)
    admitted = unsupported[:unsupported_budget]
    admitted_warnings = node_warnings[: MAX_ANALYSIS_EDGES - len(admitted)]
    dropped += (len(unsupported) - len(admitted)) + (len(node_warnings) - len(admitted_warnings))

    for construct in admitted:
        source_id = builder.source_node(
            f"source:analysis:{construct}",
            label=construct,
            construct_key=construct,
            evidence=SourceEvidence(native_name=construct, construct_kind="analysis"),
        )
        builder.edges.append(
            _edge(
                edge_id=f"analysis:unsupported:{construct}",
                scope=ConversionEdgeScope.ANALYSIS,
                source=source_id,
                target=None,
                status=ConversionStatus.UNAVAILABLE,
                reason=ProjectionReason.SOURCE_PARSE_LIMIT,
                severity=LossinessSeverity.INFO,
                detail=(
                    f"the {analysis.analyzer.key} analyzer does not model {construct}, so the "
                    "conversion could not have carried it even if the source declared it"
                ),
            )
        )

    for warning in admitted_warnings:
        source_id = builder.source_node(
            f"source:analysis:node:{warning.node_id}",
            label=warning.node_id,
            evidence=SourceEvidence(native_name=warning.node_id, construct_kind="analysis"),
        )
        builder.edges.append(
            _edge(
                edge_id=f"analysis:warning:{warning.code}:{warning.node_id}",
                scope=ConversionEdgeScope.ANALYSIS,
                source=source_id,
                target=None,
                status=ConversionStatus.UNAVAILABLE,
                reason=ProjectionReason.SOURCE_PARSE_LIMIT,
                severity=(
                    LossinessSeverity.WARN if warning.severity == "error" else LossinessSeverity.INFO
                ),
                detail=warning.message or warning.code,
                evidence=[
                    EvidenceRef(
                        kind="analysis-node", ref=warning.node_id, location=warning.location
                    )
                ],
            )
        )

    return dropped


def _compute_manifest_hash(
    *,
    source_format: Optional[str],
    target_format: str,
    conversion_mode: str,
    tool_versions: Mapping[str, str],
    defaults: Mapping[str, Any],
    nodes: Sequence[ConversionNode],
    edges: Sequence[ConversionEdge],
) -> str:
    """Compute the content-addressed snapshot hash over the manifest's identity-bearing content.

    Folds the contract version, the source/target formats, the conversion mode, the converter
    tool versions and the normalized defaults over the already-ordered nodes and edges. A
    converter upgrade or a changed default is therefore a *different* snapshot, while the same
    bytes converted the same way — in any project, at any time — is the same one.
    """
    payload = {
        "schema_version": CONVERSION_MANIFEST_SCHEMA_VERSION,
        "source_format": source_format,
        "target_format": target_format,
        "conversion_mode": conversion_mode,
        "tool_versions": dict(sorted(tool_versions.items())),
        "defaults": defaults,
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ===========================================================================
# Public builder
# ===========================================================================


def build_conversion_manifest(
    *,
    api: CanonicalApi,
    document: Mapping[str, Any],
    report: FidelityReport,
    target_format: str,
    conversion_mode: str,
    tool_versions: Mapping[str, str],
    emit_result: Optional[EmitResult] = None,
    defaults: Optional[Mapping[str, Any]] = None,
    analysis: Optional[PayloadAnalysisDocument] = None,
    project_id: Optional[str] = None,
    version_record_id: Optional[str] = None,
    source_format: Optional[str] = None,
    source_protocol: Optional[str] = None,
    source_version_label: Optional[str] = None,
) -> ConversionManifest:
    """Build the deterministic conversion projection manifest for one catalog → OpenAPI conversion.

    Pure: no I/O and no clock, so identical inputs yield an equal manifest with an equal
    :attr:`~ConversionManifest.manifest_hash`. The result is reconciled against ``report``
    before it is returned (:func:`reconcile_with_fidelity`), so a divergence between the
    manifest and the fidelity report a user is looking at is a hard error, not a silent
    inconsistency.

    Args:
        api: The source canonical model that was converted.
        document: The emitted OpenAPI document (every target pointer is verified against it).
        report: The fidelity report for this conversion — the reconciliation authority.
        target_format: The resolved emit target (``openapi-3.1``).
        conversion_mode: ``passthrough`` / ``typespec_native`` / ``lossy`` (MFI-22.7).
        tool_versions: Converter tool versions (:func:`app.conversion_job.converter_tool_versions`).
        emit_result: The emitter's result, when the lossy path produced one. Supplies the
            per-pointer provenance that separates *retained* from *inferred*; ``None`` on the
            passthrough/native paths, where an emitted value has no provenance note and a
            resolvable pointer is faithful by construction.
        defaults: The user's gap-filling defaults; normalized into the hash so a different set
            of defaults is a different snapshot.
        analysis: The revision's payload analysis (CPDO-1.1/1.2), when one exists. Drives the
            ``analysis``-scoped edges and the manifest's analysis provenance block.
        project_id: Catalog item id being converted (recorded, not hashed).
        version_record_id: Source revision row id (recorded, not hashed).
        source_format: Source format key; defaults to the model's ``format``.
        source_protocol: Source protocol; defaults to the model's ``protocol``.
        source_version_label: Source-declared API version; defaults to the model's ``version``.

    Returns:
        The :class:`ConversionManifest`.

    Raises:
        ConversionReconciliationError: If the built manifest's checklist/loss tallies disagree
            with ``report``.
    """
    builder = _GraphBuilder()
    normalized_defaults = normalize_defaults_for_hash(defaults)

    _checklist_edges(builder, report, document)
    dropped = _admit_construct_edges(builder, api, document, emit_result)
    _loss_edges(builder, report)
    dropped += _analysis_edges(builder, analysis)

    manifest = ConversionManifest(
        source=ConversionManifestSource(
            project_id=project_id,
            version_record_id=version_record_id,
            source_format=source_format or api.format,
            source_protocol=source_protocol or api.protocol,
            source_version_label=source_version_label or api.version,
            paradigm=api.paradigm.value,
            analysis=_analysis_ref(analysis),
        ),
        target_format=target_format,
        conversion_mode=conversion_mode,
        tool_versions=dict(tool_versions),
        defaults=normalized_defaults,
        nodes=builder.prune_unreferenced(builder.edges),
        edges=builder.edges,
        truncated=dropped > 0,
        dropped_edge_count=dropped,
        bounds={
            "maxConstructEdges": MAX_CONSTRUCT_EDGES,
            "maxAnalysisEdges": MAX_ANALYSIS_EDGES,
        },
    )
    manifest.manifest_hash = _compute_manifest_hash(
        source_format=manifest.source.source_format,
        target_format=target_format,
        conversion_mode=conversion_mode,
        tool_versions=manifest.tool_versions,
        defaults=normalized_defaults,
        nodes=manifest.nodes,
        edges=manifest.edges,
    )
    reconcile_with_fidelity(manifest, report)
    return manifest


def summarize_conversion_manifest(manifest: ConversionManifest) -> ConversionManifestSummary:
    """Reduce a full manifest to the bounded summary a dry-run / commit response embeds."""
    return ConversionManifestSummary(
        schema_version=manifest.schema_version,
        manifest_hash=manifest.manifest_hash,
        source=manifest.source,
        target_format=manifest.target_format,
        conversion_mode=manifest.conversion_mode,
        tool_versions=dict(manifest.tool_versions),
        defaults=dict(manifest.defaults),
        status_counts=dict(manifest.status_counts),
        reason_counts=dict(manifest.reason_counts),
        scope_counts=dict(manifest.scope_counts),
        node_count=len(manifest.nodes),
        edge_count=len(manifest.edges),
        total_constructs=manifest.total_constructs,
        is_lossless=all(
            edge.status is ConversionStatus.RETAINED for edge in manifest.edges
        ),
        worst_severity=manifest.worst_severity,
        truncated=manifest.truncated,
        dropped_edge_count=manifest.dropped_edge_count,
    )


# ===========================================================================
# Reconciliation
# ===========================================================================


def reconcile_with_fidelity(manifest: ConversionManifest, report: FidelityReport) -> None:
    """Assert a manifest's checklist and loss tallies reconcile with its fidelity report.

    Checks the two scopes that are in one-to-one correspondence with the report:

    * one ``checklist`` edge per :class:`~app.fidelity.ChecklistItem`, with the same key set,
      and a per-status tally equal to ``report.coverage_counts`` mapped through
      :data:`STATUS_FOR_COVERAGE`; and
    * one ``loss`` edge per :class:`~app.emitter.Loss`, with a matching per-kind tally.

    ``construct`` and ``analysis`` edges are deliberately excluded: they carry detail the report
    has no counterpart for, and folding them into the comparison would make the check
    meaningless.

    Args:
        manifest: The manifest to check.
        report: The fidelity report it was built from.

    Raises:
        ConversionReconciliationError: When any tally disagrees.
    """
    checklist = manifest.edges_in_scope(ConversionEdgeScope.CHECKLIST)
    expected_keys = {item.key for item in report.items}
    actual_keys = {edge.source.split("source:checklist:", 1)[-1] for edge in checklist}
    if actual_keys != expected_keys:
        raise ConversionReconciliationError(
            f"manifest checklist rows {sorted(actual_keys)} do not match the report's "
            f"{sorted(expected_keys)}"
        )

    tally = {status.value: 0 for status in ConversionStatus}
    for edge in checklist:
        tally[edge.status.value] += 1
    expected = {status.value: 0 for status in ConversionStatus}
    for coverage_value, count in report.coverage_counts.items():
        expected[STATUS_FOR_COVERAGE[Coverage(coverage_value)].value] += count
    if tally != expected:
        raise ConversionReconciliationError(
            f"manifest checklist status counts {tally} do not reconcile with the report's "
            f"coverage counts {expected}"
        )

    losses = manifest.edges_in_scope(ConversionEdgeScope.LOSS)
    if len(losses) != len(report.losses):
        raise ConversionReconciliationError(
            f"manifest loss edge count {len(losses)} does not match the report's "
            f"{len(report.losses)}"
        )
    loss_tally: Dict[str, int] = {status.value: 0 for status in ConversionStatus}
    for edge in losses:
        loss_tally[edge.status.value] += 1
    expected_loss_tally: Dict[str, int] = {status.value: 0 for status in ConversionStatus}
    for loss in report.losses:
        expected_loss_tally[STATUS_FOR_LOSS_KIND[loss.kind].value] += 1
    if loss_tally != expected_loss_tally:
        raise ConversionReconciliationError(
            f"manifest loss status counts {loss_tally} do not reconcile with the report's "
            f"{expected_loss_tally}"
        )


# ===========================================================================
# Pagination
# ===========================================================================


def paginate_conversion_evidence(
    manifest: ConversionManifest,
    *,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_EVIDENCE_PAGE_SIZE,
    scope: Optional[ConversionEdgeScope] = None,
) -> ConversionEvidencePage:
    """Return one deterministic, cursor-paginated page of a manifest's edges.

    Pages over the manifest's edges in their canonical order (checklist, then construct, then
    loss, then analysis), bundling each page with the nodes it references. ``limit`` is clamped
    to ``[1, MAX_EVIDENCE_PAGE_SIZE]`` regardless of what the caller asks for, so a client
    cannot turn pagination off.

    Args:
        manifest: The manifest to page.
        cursor: Opaque cursor from a previous page, or ``None`` to start at the beginning.
        limit: Maximum edges per page (clamped to the hard cap).
        scope: Restrict the page to one edge scope; ``None`` pages every scope.

    Returns:
        The :class:`ConversionEvidencePage`.

    Raises:
        ValueError: When ``cursor`` is malformed.
    """
    limit = max(1, min(int(limit), MAX_EVIDENCE_PAGE_SIZE))
    start = decode_page_cursor(cursor) if cursor else 0
    edges = manifest.edges if scope is None else manifest.edges_in_scope(scope)
    total = len(edges)
    page_edges = edges[start : start + limit]

    node_by_id = {node.id: node for node in manifest.nodes}
    wanted: List[str] = []
    seen: set = set()
    for edge in page_edges:
        for node_id in (edge.source, edge.target):
            if node_id and node_id not in seen and node_id in node_by_id:
                seen.add(node_id)
                wanted.append(node_id)

    next_start = start + limit
    return ConversionEvidencePage(
        manifest_hash=manifest.manifest_hash,
        edges=page_edges,
        nodes=[node_by_id[node_id] for node_id in wanted],
        next_cursor=encode_page_cursor(next_start) if next_start < total else None,
        total=total,
    )
