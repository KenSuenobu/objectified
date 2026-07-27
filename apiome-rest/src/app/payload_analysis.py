"""Revision-scoped payload analysis contract — CPDO-1.1 (#4794).

A catalog read today reconstructs the imported source and reduces it to generic entity/field
rows. The structures that make a mainframe or EDI payload worth cataloguing — X12 interchange
and functional-group envelopes, delimiters, segment positions, copybook level numbers, PICTURE
clauses, OCCURS bounds, 88-level conditions — are derived, rendered, and discarded. Nothing can
cite them afterwards, and nothing notices when a parser upgrade changes them.

This module is the contract for keeping them: a **payload analysis** is one immutable record of
what an analyzer observed in one source revision. Its persistent home is ``apiome.payload_analysis``
(apiome-db V209/V210); the extractors that fill it are :mod:`app.payload_analyzer` and its per-format
modules (CPDO-1.2), and the projection manifest that cites it arrives with CPDO-1.3.

Three properties the contract is built around
---------------------------------------------

**It is revision-scoped and immutable.** The analysis of a revision never changes underneath a
reader. A re-import mints a new revision and therefore a new analysis; an analyzer upgrade *appends*
a new sequence to the same revision rather than rewriting the old one, so an evidence reference
stays resolvable.

**It never fabricates.** Absence has a vocabulary. A legacy revision that predates analysis, a
source that was never captured, a format with no analyzer — each yields a declared
:data:`STATUS_UNAVAILABLE` record with a reason code and an empty tree, produced by
:func:`unavailable_document`. An analysis that describes source bytes must name them
(``source_hash``). The database enforces both as CHECK constraints; this module is where the two
layers agree on what the values mean.

**It is not a second copy of the payload.** The analysis stores *structure*. Whether a node may
carry the value it observed is governed by a :class:`ValueVisibility` policy, applied by
:func:`apply_value_visibility` and reported in the record's own ``redaction`` block — so "no values
here" is always a stated policy rather than something a reader has to infer. Under the default
policy a node carries whether a value was *present* and how long it was, never what it said. Raw
source material stays where it already lives (``GET /v1/catalog/{tenant}/{item}/source``); this
record points at it with :class:`SourceLocation` rather than duplicating it.

Bounds
------
A native tree is unbounded in principle — a large X12 interchange has hundreds of thousands of
elements. :func:`bound_tree` applies the node/depth budgets and marks what it dropped, so a record
is always a complete statement about a bounded view rather than a truncated statement about
everything. A bounded record is :data:`STATUS_PARTIAL`, never :data:`STATUS_AVAILABLE`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "AnalysisMetrics",
    "AnalysisWarning",
    "AnalyzerCapabilities",
    "AnalyzerInfo",
    "AnalysisNode",
    "MAX_TREE_DEPTH",
    "MAX_TREE_NODES",
    "MAX_VALUE_PREVIEW_CHARS",
    "PAYLOAD_ANALYSIS_SCHEMA_VERSION",
    "PayloadAnalysisDocument",
    "PayloadAnalysisRecord",
    "PayloadAnalysisSummary",
    "REASON_ANALYZER_FAILED",
    "REASON_BOUNDS_EXCEEDED",
    "REASON_NOT_ANALYZED",
    "REASON_NO_SOURCE_CAPTURED",
    "REASON_UNSUPPORTED_FORMAT",
    "RedactionInfo",
    "SEVERITY_ERROR",
    "SEVERITY_INFO",
    "SEVERITY_WARNING",
    "STATUS_AVAILABLE",
    "STATUS_FAILED",
    "STATUS_PARTIAL",
    "STATUS_UNAVAILABLE",
    "SourceLocation",
    "ValueVisibility",
    "analysis_content_fingerprint",
    "analyzer_capabilities",
    "bound_tree",
    "apply_value_visibility",
    "document_from_row",
    "document_json_schema",
    "record_from_row",
    "source_digest",
    "summarize_document",
    "summary_from_row",
    "unavailable_document",
]


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

#: Version of this contract. Bumped when a stored record's shape changes in a way a reader must
#: know about; a record always states the version it was written under, so a reader can refuse
#: rather than misread a record from a future contract.
#:
#: ``1.1.0`` (CPDO-1.2) added :class:`AnalyzerCapabilities` — a minor bump because it is additive:
#: a ``1.0.0`` record reads back with empty capabilities, which is the truthful statement that its
#: analyzer declared none.
PAYLOAD_ANALYSIS_SCHEMA_VERSION = "1.1.0"

#: The analyzer described the whole source within budget.
STATUS_AVAILABLE = "available"
#: The analyzer described some of the source and said which parts it could not (bounds applied,
#: unsupported grammar, ambiguous layout).
STATUS_PARTIAL = "partial"
#: Nothing was analysed — a legacy revision, no captured source, or no analyzer for the format.
#: The tree is empty and a reason code says which.
STATUS_UNAVAILABLE = "unavailable"
#: The analyzer ran and errored. The tree is empty; the reason names the failure.
STATUS_FAILED = "failed"

#: The complete status vocabulary, in the order the API documents it. Must stay in lock-step with
#: ``payload_analysis_status_check`` in apiome-db V209.
ANALYSIS_STATUSES: Tuple[str, ...] = (
    STATUS_AVAILABLE,
    STATUS_PARTIAL,
    STATUS_UNAVAILABLE,
    STATUS_FAILED,
)

#: Statuses whose record must name the bytes it analysed.
_STATUSES_REQUIRING_SOURCE_HASH = frozenset({STATUS_AVAILABLE, STATUS_PARTIAL})
#: Statuses whose record must carry an empty tree.
_STATUSES_REQUIRING_EMPTY_TREE = frozenset({STATUS_UNAVAILABLE, STATUS_FAILED})

# Reason codes. Closed on purpose: a UI that must explain *why* there is no detail cannot do it
# from free text, and "no details" conflating five different causes is the problem CPDO-2.4 exists
# to fix. Extenders add a code here rather than inventing a string at the call site.

#: The revision predates payload analysis, or no analyzer has run for it yet.
REASON_NOT_ANALYZED = "not_analyzed"
#: No source material was captured for the revision, so there is nothing to analyse.
REASON_NO_SOURCE_CAPTURED = "no_source_captured"
#: The source format has no native analyzer. Not a parse failure — a capability boundary.
REASON_UNSUPPORTED_FORMAT = "unsupported_format"
#: The native tree exceeded the node/depth budget and was bounded. The record is real, and partial.
REASON_BOUNDS_EXCEEDED = "bounds_exceeded"
#: The analyzer raised. The record exists so the failure is visible rather than silent.
REASON_ANALYZER_FAILED = "analyzer_failed"

#: The complete reason vocabulary, in rough order of how often a reader will meet it.
ANALYSIS_REASONS: Tuple[str, ...] = (
    REASON_NOT_ANALYZED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_UNSUPPORTED_FORMAT,
    REASON_BOUNDS_EXCEEDED,
    REASON_ANALYZER_FAILED,
)

#: Warning severities, weakest first.
SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_ERROR = "error"
WARNING_SEVERITIES: Tuple[str, ...] = (SEVERITY_INFO, SEVERITY_WARNING, SEVERITY_ERROR)


class ValueVisibility:
    """How much of an observed payload value an analysis may carry.

    The analysis exists to describe *structure*. A record that copied every observed value would be
    a second, less-guarded copy of the payload — with the same credentials, account numbers and
    claim data in it, reachable through a different endpoint. So value visibility is a policy, the
    policy is recorded on the record, and the default withholds.

    * :data:`NONE` — no value material at all. Not even a length.
    * :data:`STRUCTURAL` — the default: whether a value was present, and how long it was. Enough to
      distinguish an empty X12 element from an absent one, or a filled copybook field from a
      space-padded one, without carrying what it said.
    * :data:`FULL` — the observed value, truncated to :data:`MAX_VALUE_PREVIEW_CHARS`. Only for
      material a tenant has explicitly decided is safe to store; never a default.
    """

    NONE = "none"
    STRUCTURAL = "structural"
    FULL = "full"

    #: The complete vocabulary, most restrictive first.
    ALL: Tuple[str, ...] = (NONE, STRUCTURAL, FULL)

    #: What an analysis carries unless a policy says otherwise.
    DEFAULT = STRUCTURAL


#: Maximum number of nodes a stored tree may carry. Beyond this :func:`bound_tree` stops and the
#: record becomes :data:`STATUS_PARTIAL` with :data:`REASON_BOUNDS_EXCEEDED`.
MAX_TREE_NODES = 5000
#: Maximum node depth a stored tree may carry.
MAX_TREE_DEPTH = 32
#: Maximum characters of an observed value kept under :data:`ValueVisibility.FULL`.
MAX_VALUE_PREVIEW_CHARS = 120


# ---------------------------------------------------------------------------
# Contract models
# ---------------------------------------------------------------------------


class SourceLocation(BaseModel):
    """Where in the original source a node came from.

    A pointer, never a copy: the fields address a range in the raw source the catalog already
    serves, so a UI can open the source viewer at the right place (CPDO-2.1) without the analysis
    carrying the bytes. Every field is optional because source-location quality differs by format —
    a copybook parser knows the line, an X12 parser knows the segment ordinal and byte offset, and a
    JSON-derived analyzer may know only a path.

    Attributes:
        file: Path within a multi-file source layout, when the source was a fileset.
        line: 1-based line number.
        column: 1-based column number.
        offset: 0-based byte offset from the start of the source.
        length: Length in bytes of the addressed range.
        ordinal: Position among sibling constructs (e.g. the segment index within an interchange).
        path: Analyzer-specific path expression (e.g. ``ISA/GS[0]/ST[2]/NM1[4]``).
    """

    model_config = ConfigDict(extra="forbid")

    file: Optional[str] = None
    line: Optional[int] = Field(default=None, ge=1)
    column: Optional[int] = Field(default=None, ge=1)
    offset: Optional[int] = Field(default=None, ge=0)
    length: Optional[int] = Field(default=None, ge=0)
    ordinal: Optional[int] = Field(default=None, ge=0)
    path: Optional[str] = None


class AnalysisWarning(BaseModel):
    """Something the analyzer could not do, stated rather than hidden.

    The difference between "this construct is not in the source" and "this parser does not
    understand this construct" is the whole point of CPDO-2.4, and it is carried here. A warning is
    never an error in the request — a record with warnings is still a usable record.

    Attributes:
        code: Stable machine code (e.g. ``copybook.redefines_unsupported``).
        severity: One of :data:`WARNING_SEVERITIES`.
        message: Human-readable explanation, free of payload values.
        node_id: Id of the node the warning is about, when it is about one.
        location: Where in the source it applies, when known.
    """

    model_config = ConfigDict(extra="forbid")

    code: str
    severity: str = SEVERITY_WARNING
    message: str = ""
    node_id: Optional[str] = Field(default=None, serialization_alias="nodeId")
    location: Optional[SourceLocation] = None


class AnalysisNode(BaseModel):
    """One node of the native tree, in the analyzer's own vocabulary.

    Deliberately format-neutral in *shape* and format-specific in *content*: ``kind`` is the
    analyzer's own term (``interchange``, ``functional_group``, ``transaction_set``, ``segment``,
    ``element`` for X12; ``group``, ``field``, ``condition`` for a copybook), and ``attributes``
    carries the semantics that term implies (PIC, USAGE, OCCURS bounds, segment id, element
    position). One renderer can therefore walk any analyzer's output while nothing is flattened into
    a lowest common denominator on the way in.

    ``value`` is governed by :class:`ValueVisibility` and is ``None`` under the default policy;
    ``value_present`` and ``value_length`` describe the observed value without disclosing it.

    Attributes:
        id: Stable id within the record, so warnings and (later) projection evidence can cite it.
        kind: The analyzer's term for what this node is.
        name: The construct's name in the source (segment id, field name, element reference).
        label: Optional human-facing label when ``name`` alone reads poorly.
        ordinal: Position among its siblings, preserving source order.
        attributes: Format-specific semantics; JSON scalars and small containers only.
        location: Where the construct sits in the source.
        value_present: Whether the source carried a value here (an X12 element can be present and
            empty — that is not the same as absent).
        value_length: Length of the observed value in characters, when known.
        value: The observed value; only under :data:`ValueVisibility.FULL`, truncated to
            :data:`MAX_VALUE_PREVIEW_CHARS`.
        redacted: True when a value was observed and withheld by policy.
        children: Child nodes, in source order.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    kind: str
    name: Optional[str] = None
    label: Optional[str] = None
    ordinal: Optional[int] = Field(default=None, ge=0)
    attributes: Dict[str, Any] = Field(default_factory=dict)
    location: Optional[SourceLocation] = None
    value_present: Optional[bool] = Field(default=None, serialization_alias="valuePresent")
    value_length: Optional[int] = Field(default=None, ge=0, serialization_alias="valueLength")
    value: Optional[str] = None
    redacted: bool = False
    children: List["AnalysisNode"] = Field(default_factory=list)


class AnalysisMetrics(BaseModel):
    """Derived counts over the tree, so a reader can size it before fetching it.

    Attributes:
        node_count: Total nodes in the stored tree (after bounding).
        max_depth: Deepest nesting level in the stored tree (a root-only tree is depth 1).
        truncated: True when bounding dropped nodes the source actually had.
        dropped_node_count: How many nodes bounding dropped, when known.
        kind_counts: Node count per ``kind``, the cheap summary a detail header renders.
        warning_count: Number of warnings on the record.
    """

    model_config = ConfigDict(extra="forbid")

    node_count: int = Field(default=0, ge=0, serialization_alias="nodeCount")
    max_depth: int = Field(default=0, ge=0, serialization_alias="maxDepth")
    truncated: bool = False
    dropped_node_count: int = Field(default=0, ge=0, serialization_alias="droppedNodeCount")
    kind_counts: Dict[str, int] = Field(default_factory=dict, serialization_alias="kindCounts")
    warning_count: int = Field(default=0, ge=0, serialization_alias="warningCount")


class RedactionInfo(BaseModel):
    """What the record withheld, and under which policy.

    Present on every record — including records that withheld nothing — so a reader never has to
    infer whether an absent value was withheld or simply not there.

    Attributes:
        value_visibility: The :class:`ValueVisibility` level in force.
        redacted_node_count: How many nodes carried a value that was withheld.
        policy_source: Where the level came from (``default``, ``tenant``, ``format``, ``request``).
        value_preview_limit: Character limit applied to any retained value.
    """

    model_config = ConfigDict(extra="forbid")

    value_visibility: str = Field(
        default=ValueVisibility.DEFAULT, serialization_alias="valueVisibility"
    )
    redacted_node_count: int = Field(default=0, ge=0, serialization_alias="redactedNodeCount")
    policy_source: str = Field(default="default", serialization_alias="policySource")
    value_preview_limit: int = Field(
        default=MAX_VALUE_PREVIEW_CHARS, ge=0, serialization_alias="valuePreviewLimit"
    )


class AnalyzerInfo(BaseModel):
    """Which analyzer produced the record, and what it was built on.

    ``key`` plus ``version`` is what makes a stale record detectable: an analysis produced by
    ``edix12@1.0.0`` is not interchangeable with one produced by ``edix12@2.0.0``, even for the same
    bytes.

    Attributes:
        key: Analyzer key (usually the import adapter key, or ``generic``).
        version: Analyzer version.
        tool_versions: Underlying parser/library versions it leaned on.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = "generic"
    version: str = "0.0.0"
    tool_versions: Dict[str, str] = Field(
        default_factory=dict, serialization_alias="toolVersions"
    )


class AnalyzerCapabilities(BaseModel):
    """What the analyzer that wrote this record can and cannot describe — CPDO-1.2 (#4795).

    A record's warnings say what went wrong *in this source*. Capabilities say what would have gone
    wrong in **any** source: the constructs this analyzer models, the ones it knowingly does not, and
    the numeric bounds it was working under. Both are needed to answer "why is there no detail here?"
    — a construct absent from the tree is either absent from the source or outside the analyzer, and
    only ``unsupported`` distinguishes them.

    Construct keys are the analyzer's own dotted vocabulary (``x12.functional_group``,
    ``copybook.redefines``), stable enough to cite from a UI. Both lists are sorted and de-duplicated
    by :func:`analyzer_capabilities` so a record's serialization — and therefore its
    ``content_fingerprint`` — does not depend on the order an analyzer happened to declare them in.

    This is the *per-record* statement, written by the analyzer that ran. The cross-format registry
    that answers the same question before an import runs is CPDO-2.4's.

    Attributes:
        supported: Construct keys this analyzer models, sorted.
        unsupported: Construct keys it knowingly does not model, sorted. An entry here is a
            capability boundary, not a defect in the source.
        limits: Numeric bounds in force when the record was produced (node/depth budgets, value
            preview length), so a reader can tell a bounded record from a small one.
    """

    model_config = ConfigDict(extra="forbid")

    supported: List[str] = Field(default_factory=list)
    unsupported: List[str] = Field(default_factory=list)
    limits: Dict[str, int] = Field(default_factory=dict)


def analyzer_capabilities(
    *,
    supported: Iterable[str] = (),
    unsupported: Iterable[str] = (),
    limits: Optional[Mapping[str, int]] = None,
) -> AnalyzerCapabilities:
    """Build a deterministic :class:`AnalyzerCapabilities`.

    The single constructor, so every analyzer's declaration is normalized the same way: blank keys
    dropped, duplicates collapsed, both lists sorted, limits coerced to ``int``. Determinism matters
    here more than convenience — the capabilities block is part of the canonicalized document that
    :func:`analysis_content_fingerprint` hashes, so an unsorted declaration would make an otherwise
    identical re-analysis look like a new one and append a redundant sequence.

    Args:
        supported: Construct keys the analyzer models.
        unsupported: Construct keys it knowingly does not model.
        limits: Numeric bounds in force (e.g. ``{"maxNodes": 5000}``).

    Returns:
        The normalized :class:`AnalyzerCapabilities`.
    """
    return AnalyzerCapabilities(
        supported=sorted({key.strip() for key in supported if key and key.strip()}),
        unsupported=sorted({key.strip() for key in unsupported if key and key.strip()}),
        limits={str(name): int(value) for name, value in sorted((limits or {}).items())},
    )


class PayloadAnalysisDocument(BaseModel):
    """The full analysis of one source revision — the persisted contract.

    This is what ``apiome.payload_analysis`` stores (column-per-field, not a blob) and what
    ``GET /v1/catalog/{tenant_slug}/{item_id}/analysis`` returns. Its invariants mirror the V209
    CHECK constraints exactly, and :meth:`contract_violations` states them in one place so the API
    can refuse to *write* a record the database would refuse to store.

    Attributes:
        schema_version: Contract version the record was written under.
        status: One of :data:`ANALYSIS_STATUSES`.
        status_reason: Reason code; required unless ``status`` is :data:`STATUS_AVAILABLE`.
        source_format: Adapter key of the analysed source.
        source_hash: ``sha256:<hex>`` of the analysed bytes; required for available/partial.
        analyzer: Which analyzer produced the record.
        capabilities: What that analyzer models and does not model (CPDO-1.2).
        tree: Root nodes of the native structure; empty for unavailable/failed.
        metrics: Derived counts over ``tree``.
        warnings: What the analyzer could not do.
        redaction: The value-visibility policy in force and what it withheld.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(
        default=PAYLOAD_ANALYSIS_SCHEMA_VERSION, serialization_alias="schemaVersion"
    )
    status: str = STATUS_UNAVAILABLE
    status_reason: Optional[str] = Field(default=None, serialization_alias="statusReason")
    source_format: Optional[str] = Field(default=None, serialization_alias="sourceFormat")
    source_hash: Optional[str] = Field(default=None, serialization_alias="sourceHash")
    analyzer: AnalyzerInfo = Field(default_factory=AnalyzerInfo)
    capabilities: AnalyzerCapabilities = Field(default_factory=AnalyzerCapabilities)
    tree: List[AnalysisNode] = Field(default_factory=list)
    metrics: AnalysisMetrics = Field(default_factory=AnalysisMetrics)
    warnings: List[AnalysisWarning] = Field(default_factory=list)
    redaction: RedactionInfo = Field(default_factory=RedactionInfo)

    def contract_violations(self) -> List[str]:
        """Return the record's contract violations, empty when it is storable.

        Checks the same three truthfulness invariants apiome-db V209 enforces, so a caller finds out
        at the boundary rather than as an opaque ``CheckViolation`` from the driver:

        1. An ``available``/``partial`` record names the bytes it analysed.
        2. An ``unavailable``/``failed`` record carries an empty tree.
        3. Anything other than ``available`` names a reason.

        Plus three the database cannot see: the status must be in the vocabulary; a bounded
        (``metrics.truncated``) record must not claim to be ``available``; and a record must not
        carry payload values its own declared ``redaction.value_visibility`` forbids.

        That last one is what stops a raw analyzer document — values still in it, redaction block
        still at its default — from being stored as though a policy had been applied. Such a
        document is non-storable until :func:`apply_value_visibility` has actually run over it.

        Returns:
            A list of human-readable violation messages; empty when the record is storable.
        """
        problems: List[str] = []

        if self.status not in ANALYSIS_STATUSES:
            problems.append(
                f"status {self.status!r} is not one of {', '.join(ANALYSIS_STATUSES)}"
            )
        if self.status in _STATUSES_REQUIRING_SOURCE_HASH and not self.source_hash:
            problems.append(f"status {self.status!r} requires a source_hash")
        if self.status in _STATUSES_REQUIRING_EMPTY_TREE and self.tree:
            problems.append(f"status {self.status!r} requires an empty tree")
        if self.status != STATUS_AVAILABLE and not (self.status_reason or "").strip():
            problems.append(f"status {self.status!r} requires a status_reason")
        if self.metrics.truncated and self.status == STATUS_AVAILABLE:
            problems.append("a truncated analysis cannot be reported as available")

        visibility = self.redaction.value_visibility
        if visibility != ValueVisibility.FULL:
            leaked = sum(1 for node in _walk(self.tree) if node.value is not None)
            if leaked:
                problems.append(
                    f"{leaked} node(s) carry a value that value_visibility {visibility!r} forbids"
                )
        if visibility == ValueVisibility.NONE:
            exposed = sum(
                1
                for node in _walk(self.tree)
                if node.value_present is not None or node.value_length is not None
            )
            if exposed:
                problems.append(
                    f"{exposed} node(s) carry value metadata that value_visibility 'none' forbids"
                )
        return problems

    @property
    def is_storable(self) -> bool:
        """True when the record satisfies every contract invariant (see :meth:`contract_violations`)."""
        return not self.contract_violations()


class PayloadAnalysisSummary(BaseModel):
    """The small projection embedded in a catalog detail read.

    The detail response carries this rather than the tree: the tree can be five thousand nodes, and
    the detail screen needs only enough to decide whether to offer the *Format details* tab and what
    to say when it cannot. Fetching the tree is a separate, explicit request.

    Attributes:
        available: True only when a real tree is fetchable (``available`` or ``partial``).
        status: One of :data:`ANALYSIS_STATUSES`.
        status_reason: Reason code, when the status has one.
        schema_version: Contract version of the underlying record.
        source_format: Adapter key of the analysed source.
        analyzer_key: Which analyzer produced it.
        analyzer_version: That analyzer's version.
        node_count: Nodes in the stored tree.
        max_depth: Depth of the stored tree.
        truncated: Whether bounding dropped nodes.
        warning_count: Number of analyzer warnings.
        kind_counts: Node count per kind — the detail header's summary metrics.
        capabilities: What the analyzer models and does not model, so the detail screen can explain
            a missing construct without fetching the tree (CPDO-1.2).
        value_visibility: The value-visibility level the record was stored under.
        analysis_id: Id of the underlying record, for a direct evidence reference.
        version_record_id: The source revision the analysis describes.
        analyzed_at: When the analysis was recorded.
    """

    model_config = ConfigDict(extra="forbid")

    available: bool = False
    status: str = STATUS_UNAVAILABLE
    status_reason: Optional[str] = Field(default=None, serialization_alias="statusReason")
    schema_version: str = Field(
        default=PAYLOAD_ANALYSIS_SCHEMA_VERSION, serialization_alias="schemaVersion"
    )
    source_format: Optional[str] = Field(default=None, serialization_alias="sourceFormat")
    analyzer_key: Optional[str] = Field(default=None, serialization_alias="analyzerKey")
    analyzer_version: Optional[str] = Field(default=None, serialization_alias="analyzerVersion")
    node_count: int = Field(default=0, ge=0, serialization_alias="nodeCount")
    max_depth: int = Field(default=0, ge=0, serialization_alias="maxDepth")
    truncated: bool = False
    warning_count: int = Field(default=0, ge=0, serialization_alias="warningCount")
    kind_counts: Dict[str, int] = Field(default_factory=dict, serialization_alias="kindCounts")
    capabilities: AnalyzerCapabilities = Field(default_factory=AnalyzerCapabilities)
    value_visibility: str = Field(
        default=ValueVisibility.DEFAULT, serialization_alias="valueVisibility"
    )
    analysis_id: Optional[str] = Field(default=None, serialization_alias="analysisId")
    version_record_id: Optional[str] = Field(default=None, serialization_alias="versionRecordId")
    analyzed_at: Optional[str] = Field(default=None, serialization_alias="analyzedAt")


class PayloadAnalysisRecord(BaseModel):
    """A stored analysis: the document plus the identity of the row that holds it.

    Returned by the full-analysis endpoint. The identity half is what makes the record citable — a
    projection manifest (CPDO-1.3) references ``analysis_id`` and ``content_fingerprint``, not "the
    analysis of this item", which would drift.

    Attributes:
        analysis_id: Row id.
        tenant_id: Owning tenant.
        project_id: Catalog project the analysed revision belongs to.
        version_record_id: The analysed source revision.
        analysis_sequence: Monotonic sequence within the revision; highest is in force.
        content_fingerprint: SHA-256 over the canonicalized document.
        analyzed_at: When the record was written.
        analysis: The document itself.
    """

    model_config = ConfigDict(extra="forbid")

    analysis_id: Optional[str] = Field(default=None, serialization_alias="analysisId")
    tenant_id: Optional[str] = Field(default=None, serialization_alias="tenantId")
    project_id: Optional[str] = Field(default=None, serialization_alias="projectId")
    version_record_id: Optional[str] = Field(default=None, serialization_alias="versionRecordId")
    analysis_sequence: int = Field(default=0, ge=0, serialization_alias="analysisSequence")
    content_fingerprint: Optional[str] = Field(
        default=None, serialization_alias="contentFingerprint"
    )
    analyzed_at: Optional[str] = Field(default=None, serialization_alias="analyzedAt")
    analysis: PayloadAnalysisDocument = Field(default_factory=PayloadAnalysisDocument)


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def unavailable_document(
    reason: str = REASON_NOT_ANALYZED,
    *,
    source_format: Optional[str] = None,
    message: Optional[str] = None,
    analyzer: Optional[AnalyzerInfo] = None,
    capabilities: Optional[AnalyzerCapabilities] = None,
    failed: bool = False,
) -> PayloadAnalysisDocument:
    """Build the declared "no analysis" record.

    The single constructor for absence, so every caller says it the same way and none of them is
    tempted to return an empty ``available`` tree instead — an empty tree that claims to be complete
    is a lie about the source, and it is the failure mode this ticket exists to prevent.

    Args:
        reason: One of :data:`ANALYSIS_REASONS`, naming why there is nothing.
        source_format: Adapter key of the source, when it is known despite the absence.
        message: Optional human-readable elaboration, recorded as an ``info`` warning. Must not
            contain payload values.
        analyzer: The analyzer that would have run / did fail, when identifiable.
        capabilities: What that analyzer models, when identifiable. Worth carrying even on an
            absence record: "no analyzer understands this format" and "the analyzer understands it
            but crashed" are different answers to the same user question.
        failed: True when an analyzer ran and errored (:data:`STATUS_FAILED`); False when there was
            simply nothing to analyse (:data:`STATUS_UNAVAILABLE`).

    Returns:
        A storable :class:`PayloadAnalysisDocument` with an empty tree and a stated reason.
    """
    warnings: List[AnalysisWarning] = []
    if message:
        warnings.append(
            AnalysisWarning(
                code=reason,
                severity=SEVERITY_ERROR if failed else SEVERITY_INFO,
                message=message,
            )
        )
    return PayloadAnalysisDocument(
        status=STATUS_FAILED if failed else STATUS_UNAVAILABLE,
        status_reason=reason,
        source_format=source_format,
        analyzer=analyzer or AnalyzerInfo(),
        capabilities=capabilities or AnalyzerCapabilities(),
        tree=[],
        metrics=AnalysisMetrics(warning_count=len(warnings)),
        warnings=warnings,
        redaction=RedactionInfo(value_visibility=ValueVisibility.NONE),
    )


def source_digest(content: Any) -> str:
    """Return the algorithm-prefixed digest of analysed source material.

    Args:
        content: The analysed source, as ``str`` or ``bytes``. A ``str`` is encoded UTF-8 so the
            same text always digests identically regardless of how it reached the analyzer.

    Returns:
        ``sha256:<64 hex chars>``, the shape the V209 ``source_hash`` CHECK requires.
    """
    raw = content.encode("utf-8") if isinstance(content, str) else bytes(content)
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def analysis_content_fingerprint(document: PayloadAnalysisDocument) -> str:
    """SHA-256 over the canonicalized analysis document.

    Canonicalization is ``json.dumps(sort_keys=True, separators=(",", ":"))`` — the same shape
    :func:`app.import_export_quality_policy.policy_content_fingerprint` uses — so identical analysis
    content always fingerprints identically. That is what lets a re-analysis that changed nothing be
    recognised rather than appended, and what a later projection manifest cites.

    Args:
        document: The analysis document.

    Returns:
        The 64-character hex digest.
    """
    canonical = json.dumps(
        document.model_dump(mode="json", by_alias=False),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Bounds and redaction
# ---------------------------------------------------------------------------


def _walk(nodes: Iterable[AnalysisNode]) -> Iterable[AnalysisNode]:
    """Yield every node in ``nodes`` depth-first, parents before children.

    Iterative rather than recursive: this runs over *raw analyzer output*, before any depth budget
    has been applied, and a pathologically nested source must not become a ``RecursionError``.
    """
    stack: List[AnalysisNode] = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node.children))


def bound_tree(
    tree: List[AnalysisNode],
    *,
    max_nodes: int = MAX_TREE_NODES,
    max_depth: int = MAX_TREE_DEPTH,
) -> Tuple[List[AnalysisNode], AnalysisMetrics]:
    """Apply the node/depth budgets to a native tree and describe the result.

    A native tree is unbounded in principle — a large X12 interchange has hundreds of thousands of
    elements, and storing all of them would make the analysis a liability rather than an asset. This
    keeps a breadth-first prefix: whole levels are kept in order until the budget runs out, so what
    survives is the top of the structure (envelopes, groups, transaction sets) rather than an
    arbitrary deep slice of one branch.

    Bounding is *reported*, never silent: ``metrics.truncated`` and ``metrics.dropped_node_count``
    say what happened, and a caller must record the result as :data:`STATUS_PARTIAL` (which
    :meth:`PayloadAnalysisDocument.contract_violations` enforces).

    Args:
        tree: The analyzer's root nodes. Not mutated.
        max_nodes: Maximum nodes to keep, across the whole tree.
        max_depth: Maximum depth to keep; nodes below it are dropped with their subtrees.

    Returns:
        ``(bounded_roots, metrics)`` — the kept tree and the metrics describing it, including how
        many nodes were dropped.
    """
    total = sum(1 for _ in _walk(tree))
    kept_ids: set = set()
    budget = max(0, int(max_nodes))

    # Breadth-first admission: level 1 first, then level 2, and so on. Whatever the budget covers is
    # therefore a complete top-of-tree rather than one branch followed to its leaves.
    level: List[AnalysisNode] = list(tree)
    depth = 0
    while level and depth < max(0, int(max_depth)) and budget > 0:
        depth += 1
        admitted: List[AnalysisNode] = []
        for node in level:
            if budget <= 0:
                break
            kept_ids.add(id(node))
            budget -= 1
            admitted.append(node)
        level = [child for node in admitted for child in node.children]

    def rebuild(nodes: List[AnalysisNode]) -> List[AnalysisNode]:
        """Copy the admitted nodes, dropping any child that did not make the budget."""
        out: List[AnalysisNode] = []
        for node in nodes:
            if id(node) not in kept_ids:
                continue
            out.append(node.model_copy(update={"children": rebuild(node.children)}))
        return out

    bounded = rebuild(list(tree))
    kept = sum(1 for _ in _walk(bounded))
    metrics = AnalysisMetrics(
        node_count=kept,
        max_depth=_tree_depth(bounded),
        truncated=kept < total,
        dropped_node_count=max(0, total - kept),
        kind_counts=_kind_counts(bounded),
    )
    return bounded, metrics


def _tree_depth(nodes: List[AnalysisNode]) -> int:
    """Return the deepest nesting level in ``nodes`` (a flat list of roots is depth 1).

    Iterative for the same reason as :func:`_walk` — it is used on unbounded analyzer output.
    """
    depth = 0
    level: List[AnalysisNode] = list(nodes)
    while level:
        depth += 1
        level = [child for node in level for child in node.children]
    return depth


def _kind_counts(nodes: List[AnalysisNode]) -> Dict[str, int]:
    """Tally nodes by ``kind``, in first-appearance order."""
    counts: Dict[str, int] = {}
    for node in _walk(nodes):
        counts[node.kind] = counts.get(node.kind, 0) + 1
    return counts


def apply_value_visibility(
    document: PayloadAnalysisDocument,
    visibility: str,
    *,
    policy_source: str = "default",
) -> PayloadAnalysisDocument:
    """Return a copy of ``document`` with its observed values reduced to ``visibility``.

    Applied twice, deliberately: once before the record is written (so the store never holds more
    than policy allows) and once on read (so a stored record can only ever be *further* restricted,
    never widened, by a request). Restriction is monotonic — asking for ``full`` on a record stored
    at ``structural`` returns the structural record, because the values are not there to return.

    Under :data:`ValueVisibility.STRUCTURAL` a node keeps ``value_present`` and ``value_length`` and
    loses ``value``; under :data:`ValueVisibility.NONE` it loses all three. Every node whose value is
    dropped is marked ``redacted`` and counted into ``redaction.redacted_node_count``, so the count
    is a fact about the record rather than a guess.

    Args:
        document: The analysis document. Not mutated.
        visibility: One of :attr:`ValueVisibility.ALL`. An unknown value is treated as
            :data:`ValueVisibility.NONE` — an unrecognised policy withholds rather than discloses.
        policy_source: Where the level came from (``default``, ``tenant``, ``format``, ``request``),
            recorded on the result.

    Returns:
        A new :class:`PayloadAnalysisDocument` with the policy applied and its ``redaction`` block
        describing the outcome.
    """
    level = visibility if visibility in ValueVisibility.ALL else ValueVisibility.NONE
    redacted_count = 0

    def reduce_node(node: AnalysisNode) -> AnalysisNode:
        nonlocal redacted_count
        had_value = node.value is not None
        update: Dict[str, Any] = {"children": [reduce_node(child) for child in node.children]}

        if level == ValueVisibility.FULL:
            if had_value and len(node.value or "") > MAX_VALUE_PREVIEW_CHARS:
                update["value"] = (node.value or "")[:MAX_VALUE_PREVIEW_CHARS]
        elif level == ValueVisibility.STRUCTURAL:
            if had_value:
                # Keep the shape of the observed value, drop the value: presence and length are what
                # distinguish an empty X12 element from an absent one.
                update["value"] = None
                update["value_present"] = (
                    True if node.value_present is None else node.value_present
                )
                update["value_length"] = (
                    len(node.value or "") if node.value_length is None else node.value_length
                )
                update["redacted"] = True
                redacted_count += 1
        else:  # ValueVisibility.NONE
            if had_value or node.value_present is not None or node.value_length is not None:
                update["value"] = None
                update["value_present"] = None
                update["value_length"] = None
                # Presence metadata is itself information, so it is always stripped here; but a node
                # whose value was *observed absent* had nothing to withhold, so it is not counted.
                if had_value or node.value_present or node.value_length:
                    update["redacted"] = True
                    redacted_count += 1

        return node.model_copy(update=update)

    tree = [reduce_node(node) for node in document.tree]
    already_redacted = document.redaction.redacted_node_count
    return document.model_copy(
        update={
            "tree": tree,
            "redaction": RedactionInfo(
                value_visibility=level,
                redacted_node_count=already_redacted + redacted_count,
                policy_source=policy_source,
                value_preview_limit=MAX_VALUE_PREVIEW_CHARS,
            ),
        }
    )


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------


def summarize_document(
    document: PayloadAnalysisDocument,
    *,
    analysis_id: Optional[str] = None,
    version_record_id: Optional[str] = None,
    analyzed_at: Optional[str] = None,
) -> PayloadAnalysisSummary:
    """Project a full document onto the summary a catalog detail read embeds.

    Args:
        document: The analysis document.
        analysis_id: Id of the underlying row, when the summary came from one.
        version_record_id: The analysed source revision.
        analyzed_at: When the record was written, ISO-8601.

    Returns:
        The :class:`PayloadAnalysisSummary`. ``available`` is True only for ``available``/``partial``
        — the two statuses for which a tree is actually fetchable.
    """
    return PayloadAnalysisSummary(
        available=document.status in (STATUS_AVAILABLE, STATUS_PARTIAL),
        status=document.status,
        status_reason=document.status_reason,
        schema_version=document.schema_version,
        source_format=document.source_format,
        analyzer_key=document.analyzer.key,
        analyzer_version=document.analyzer.version,
        node_count=document.metrics.node_count,
        max_depth=document.metrics.max_depth,
        truncated=document.metrics.truncated,
        warning_count=document.metrics.warning_count or len(document.warnings),
        kind_counts=dict(document.metrics.kind_counts),
        capabilities=document.capabilities,
        value_visibility=document.redaction.value_visibility,
        analysis_id=analysis_id,
        version_record_id=version_record_id,
        analyzed_at=analyzed_at,
    )


def summary_from_row(row: Mapping[str, Any]) -> PayloadAnalysisSummary:
    """Project a stored row onto the detail summary **without hydrating its tree**.

    A catalog detail read needs status and counts, not structure, and a stored tree can be thousands
    of nodes — so the summary is built from the row's scalar columns plus its ``metrics`` blob, and
    the ``tree`` column is never read. That is what keeps the detail endpoint's cost independent of
    how large the analysed payload was.

    Args:
        row: A row from ``apiome.payload_analysis``; ``tree`` may be absent.

    Returns:
        The :class:`PayloadAnalysisSummary`.
    """
    metrics = AnalysisMetrics.model_validate(_as_mapping(row.get("metrics")))
    redaction = RedactionInfo.model_validate(_as_mapping(row.get("redaction")))
    capabilities = AnalyzerCapabilities.model_validate(_as_mapping(row.get("capabilities")))
    status = str(row.get("status") or STATUS_UNAVAILABLE)
    analyzed_at = row.get("created_at")

    return PayloadAnalysisSummary(
        available=status in (STATUS_AVAILABLE, STATUS_PARTIAL),
        status=status,
        status_reason=row.get("status_reason"),
        schema_version=str(row.get("schema_version") or PAYLOAD_ANALYSIS_SCHEMA_VERSION),
        source_format=row.get("source_format"),
        analyzer_key=row.get("analyzer_key"),
        analyzer_version=row.get("analyzer_version"),
        node_count=metrics.node_count,
        max_depth=metrics.max_depth,
        truncated=metrics.truncated,
        warning_count=metrics.warning_count,
        kind_counts=dict(metrics.kind_counts),
        capabilities=capabilities,
        value_visibility=redaction.value_visibility,
        analysis_id=row.get("id"),
        version_record_id=row.get("version_id"),
        analyzed_at=analyzed_at.isoformat() if hasattr(analyzed_at, "isoformat") else analyzed_at,
    )


def _as_mapping(value: Any) -> Dict[str, Any]:
    """Return ``value`` as a dict — JSONB columns arrive as dicts, but degrade defensively."""
    return dict(value) if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> List[Any]:
    """Return ``value`` as a list — JSONB arrays arrive as lists, but degrade defensively."""
    return list(value) if isinstance(value, (list, tuple)) else []


def document_from_row(row: Mapping[str, Any]) -> PayloadAnalysisDocument:
    """Rebuild a :class:`PayloadAnalysisDocument` from an ``apiome.payload_analysis`` row.

    Args:
        row: The row as :meth:`app.database.Database.get_payload_analysis_for_version` returns it.

    Returns:
        The document. Malformed JSONB degrades to the field's default rather than raising: a record
        that cannot be fully read is still better than a detail read that 500s.
    """
    analyzer = AnalyzerInfo(
        key=str(row.get("analyzer_key") or "generic"),
        version=str(row.get("analyzer_version") or "0.0.0"),
        tool_versions={
            str(k): str(v) for k, v in _as_mapping(row.get("tool_versions")).items()
        },
    )
    tree = [AnalysisNode.model_validate(node) for node in _as_list(row.get("tree"))]
    warnings = [
        AnalysisWarning.model_validate(item) for item in _as_list(row.get("warnings"))
    ]
    metrics = AnalysisMetrics.model_validate(_as_mapping(row.get("metrics")))
    redaction = RedactionInfo.model_validate(_as_mapping(row.get("redaction")))
    # Absent for a record written under contract 1.0.0 — it degrades to "this analyzer declared no
    # capabilities", which is exactly what was true of it.
    capabilities = AnalyzerCapabilities.model_validate(_as_mapping(row.get("capabilities")))

    return PayloadAnalysisDocument(
        schema_version=str(row.get("schema_version") or PAYLOAD_ANALYSIS_SCHEMA_VERSION),
        status=str(row.get("status") or STATUS_UNAVAILABLE),
        status_reason=row.get("status_reason"),
        source_format=row.get("source_format"),
        source_hash=row.get("source_hash"),
        analyzer=analyzer,
        capabilities=capabilities,
        tree=tree,
        metrics=metrics,
        warnings=warnings,
        redaction=redaction,
    )


def record_from_row(row: Mapping[str, Any]) -> PayloadAnalysisRecord:
    """Rebuild a full :class:`PayloadAnalysisRecord` (identity + document) from a stored row.

    Args:
        row: The row as the data layer returns it.

    Returns:
        The record, with ``analyzed_at`` rendered as an ISO-8601 string.
    """
    analyzed_at = row.get("created_at")
    return PayloadAnalysisRecord(
        analysis_id=row.get("id"),
        tenant_id=row.get("tenant_id"),
        project_id=row.get("project_id"),
        version_record_id=row.get("version_id"),
        analysis_sequence=int(row.get("analysis_sequence") or 0),
        content_fingerprint=row.get("content_fingerprint"),
        analyzed_at=analyzed_at.isoformat() if hasattr(analyzed_at, "isoformat") else analyzed_at,
        analysis=document_from_row(row),
    )


def document_json_schema() -> Dict[str, Any]:
    """Return the JSON Schema of :class:`PayloadAnalysisDocument`.

    The published contract for anyone who is not a Pydantic caller — the CLI, the UI's fixture
    corpus (CPDO-4.1), and the docs. Generated from the model rather than hand-maintained, so it
    cannot drift from what the API actually validates.

    Returns:
        The JSON Schema, in the field names the API serializes (camelCase aliases).
    """
    return PayloadAnalysisDocument.model_json_schema(by_alias=True, mode="serialization")


AnalysisNode.model_rebuild()
