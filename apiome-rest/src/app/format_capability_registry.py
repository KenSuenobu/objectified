"""Source-format capability & parsing-limit registry — CPDO-2.4 (#4796).

CPDO-1.1 gave a payload analysis a *status* and a closed *reason code*, and CPDO-1.2 gave
each stored record the analyzer's own :class:`~app.payload_analysis.AnalyzerCapabilities`.
Both are **per record**: they describe one revision that was actually analysed. Neither can
answer the question a reader asks *before* — or *instead of* — reading a record: "what can
apiome ever tell me about this format, and what will it never tell me?"

Without that, one sentence has to cover five unrelated situations: the format has no native
analyzer, the source bytes were never captured, the parser hit a grammar it does not read,
a value-visibility policy withheld the value, and the construct genuinely is not in the
source. Collapsed into "no details", they are indistinguishable — and the fourth and fifth
readings are the only ones that say anything about the *source*. Reporting the first three
as though the source were missing is a lie about the customer's data.

This module is the versioned registry that separates them.

**Per format** it publishes a :class:`FormatCapability`: the native hierarchy its analyzer
models, the quality of the source locations it can point at, the value visibility it can
ever carry, the grammar it knowingly does not read, how much of what it observes survives
the projection onto the canonical model, and whether the format participates in the
conversion graph at all — each stamped with the analyzer key, analyzer version and
underlying tool versions that back the claim, so an entry is evidence rather than assertion.

**Every registered catalog format resolves to an entry.** A format with a reviewed seed gets
it (``provenance = reviewed``); every other registered adapter gets one *derived* from the
adapter itself (``provenance = derived``) — its declared capabilities, its analyzer identity,
its normalizers — with pessimistic defaults wherever the adapter does not say. A key no
adapter is registered under still resolves, to an entry that claims nothing at all
(``provenance = unknown_format``), because a catalog item whose adapter was later retired
must still render an honest explanation instead of a dead end.

**Absence has a closed vocabulary.** :class:`AbsenceCategory` names the eight ways a detail
can be missing, each with one reviewed :class:`AbsenceExplanation`. Exactly one of them —
:attr:`AbsenceCategory.SOURCE_MISSING` — sets ``source_missing``, and it is reachable only
from the ``no_source_captured`` analysis reason. Every other route (an unsupported format, a
bounds/grammar parse limit, an analyzer failure, an unmodelled construct, a registry with no
statement to make) resolves to an explanation whose ``source_missing`` is ``False``. That
invariant is the machine-checkable form of the ticket's "the UI never reports unparsed data
as source-missing": :func:`explain_analysis_absence` and :func:`explain_construct` are the
only two ways to phrase an absence, and neither can produce a source-missing claim from a
parser limitation.

**Version coverage is declared, not inferred.** FMT-3.8 hangs a
:class:`~app.format_version_coverage.VersionCoverage` on every entry: which versions of the format
are read, which are written, which one an export produces by default, and a note wherever a version
is reached through a projection or a downgrade rather than head-on. The declaration lives in
:mod:`app.format_version_coverage` and is checked against fixtures — every declared read version
must have a corpus entry that detects at its key, every declared write version a round-trip matrix
row — so a version cannot be claimed here without evidence that it works.

The whole registry is exposed as a deterministic, versioned
:class:`FormatCapabilitySnapshot` for the REST contract and the UI, mirroring its sibling
:mod:`app.capability_registry` (EFP-1.2), which does the same job for export *destinations*.
The language-neutral half of the vocabulary is committed at
``scripts/format_capabilities/vocabulary.json``; contract tests on both sides assert that the
Python registry and its TypeScript mirror still match it, so a registry change that lands in
one language and not the other turns a suite red.
"""

from __future__ import annotations

import logging
import re
from enum import Enum
from typing import TYPE_CHECKING, Dict, Iterable, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .format_version_coverage import (
    UNDECLARED_VERSION_COVERAGE,
    FormatVersion,
    VersionCoverage,
    VersionSupport,
    version_coverage_for,
)
from .payload_analysis import (
    ANALYSIS_REASONS,
    PAYLOAD_ANALYSIS_SCHEMA_VERSION,
    REASON_ANALYZER_FAILED,
    REASON_BOUNDS_EXCEEDED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_NOT_ANALYZED,
    REASON_UNSUPPORTED_FORMAT,
    STATUS_AVAILABLE,
    AnalyzerCapabilities,
    ValueVisibility,
)
from .payload_analyzer import GENERIC_ANALYZER_KEY

if TYPE_CHECKING:  # pragma: no cover - typing only
    # Imported lazily at every call site: :mod:`app.import_source` imports the analysis
    # machinery this module also uses, and a module-level import here would make the registry
    # part of the adapter-loading cycle.
    from .import_source import ImportSource

logger = logging.getLogger(__name__)

__all__ = [
    "FORMAT_KEY_PATTERN",
    "REGISTRY_VERSION",
    "REVIEW_DATE",
    "AbsenceCategory",
    "AbsenceExplanation",
    "AnalyzerEvidence",
    "CanonicalProjectionSupport",
    "CapabilityProvenance",
    "ConstructAvailability",
    "ConstructExplanation",
    "ConversionSupport",
    "ConversionSupportEntry",
    "FormatAvailability",
    "FormatCapability",
    "FormatCapabilitySnapshot",
    "FormatVersion",
    "NativeHierarchy",
    "ProjectionCoverage",
    "REASON_ABSENCE_CATEGORIES",
    "SourceLocationQuality",
    "SourceLocationSupport",
    "ValueVisibilitySupport",
    "VersionCoverage",
    "VersionSupport",
    "absence_explanation",
    "absence_explanations",
    "capability_for",
    "explain_analysis_absence",
    "explain_construct",
    "format_capabilities",
    "is_valid_format_key",
    "registry_snapshot",
    "render_absence",
    "version_coverage_for",
]


# ===========================================================================
# Vocabulary
# ===========================================================================

#: The registry contract version. Bumped whenever an entry, a reviewed seed, an absence
#: explanation, or a vocabulary member changes, so a consumer can detect a stale contract and
#: a cached snapshot can be keyed by it. Mirrored in the committed vocabulary snapshot.
REGISTRY_VERSION = "11"

#: The date the current seeds and absence explanations were last reviewed. Recorded as
#: provenance on every entry, so a claim about a format carries the date somebody checked it.
REVIEW_DATE = "2026-08-22"

#: Accepted shape of a format key. The registry resolves an *arbitrary caller-supplied* string
#: (a stored ``source_format`` whose adapter may have been retired), so the key is constrained
#: before it is echoed back in an entry: lowercase alphanumerics plus ``.``/``_``/``-``, at most
#: 64 characters. Anything else is not a format key that could ever have been registered.
FORMAT_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class CapabilityProvenance(str, Enum):
    """Where a :class:`FormatCapability` entry's claims come from (CPDO-2.4).

    The single field that tells a reader how much weight an entry carries. It is not a quality
    grade — a ``derived`` entry is as *true* as a reviewed one, because everything in it was
    read off the adapter — but a reviewed entry additionally states boundaries nobody could
    derive, and an ``unknown_format`` entry deliberately states nothing.
    """

    #: A hand-reviewed seed: boundaries and projection coverage were checked against the
    #: format's parser and normalizer by a person on :data:`REVIEW_DATE`.
    REVIEWED = "reviewed"
    #: Derived from the registered adapter — its analyzer identity, its declared capabilities,
    #: its normalizers — with pessimistic defaults wherever the adapter does not say. This is
    #: the safe fallback every registered format is guaranteed.
    DERIVED = "derived"
    #: No adapter is registered under this key. The entry asserts nothing about the format; it
    #: exists so a catalog item naming a retired adapter still renders an honest explanation.
    UNKNOWN_FORMAT = "unknown_format"


class FormatAvailability(str, Enum):
    """Whether this format can actually be imported and analysed in the current runtime."""

    #: Registered, runnable, and persisted to the catalog.
    AVAILABLE = "available"
    #: Registered, but a hard-required toolchain is missing here (MFI-5.2), so nothing this
    #: entry describes can currently be produced.
    TOOL_UNAVAILABLE = "tool_unavailable"
    #: Registered, but the adapter never persists (the internal acceptance adapter), so no
    #: analysis is ever stored for it.
    PREVIEW_ONLY = "preview_only"
    #: No adapter is registered under this key at all.
    UNREGISTERED = "unregistered"


class NativeHierarchy(str, Enum):
    """How much of the format's own structure the analysis tree preserves."""

    #: A format-specific node vocabulary — X12 envelopes and segments, copybook levels.
    NATIVE = "native"
    #: The format-blind object/array/scalar walk. Nesting and ordering survive; format
    #: semantics do not, and their absence from the tree says nothing about the source.
    GENERIC = "generic"
    #: No analysis tree is ever produced for this format.
    NONE = "none"


class SourceLocationQuality(str, Enum):
    """The best source pointer a node from this format can carry.

    Determines what "jump to source" can do, and — more importantly — how precisely a UI may
    claim to know *where* something is. A path-only analyzer must never render a line number.
    """

    #: Byte offsets into the raw source (an exact range).
    BYTE_OFFSETS = "byte_offsets"
    #: 1-based source line numbers.
    LINE_NUMBERS = "line_numbers"
    #: A structural path and/or sibling ordinal only — no position in the raw bytes.
    PATH_ONLY = "path_only"
    #: No source pointer at all.
    NONE = "none"


class ProjectionCoverage(str, Enum):
    """How much of what the analyzer observes survives onto the canonical model.

    The analysis tree and the catalog's entity/field rows are two different views of one
    import. A construct present in the first and absent from the second was *dropped by
    normalization*, which is neither a parse limit nor a missing source.
    """

    #: Everything the analyzer models has a canonical representation.
    FULL = "full"
    #: Some observed constructs have no canonical representation; ``dropped_constructs`` names
    #: the reviewed ones.
    PARTIAL = "partial"
    #: Nothing is projected — no normalizer participates for this format.
    NONE = "none"
    #: Not reviewed. The safe default: it makes no claim in either direction.
    UNKNOWN = "unknown"


class ConversionSupport(str, Enum):
    """Whether this format participates in the canonical conversion graph."""

    #: At least one declared format key resolves to a registered normalizer, so an import can
    #: reach the canonical model and, from there, every export destination.
    SUPPORTED = "supported"
    #: The adapter is registered but its required toolchain is missing in this runtime.
    TOOL_UNAVAILABLE = "tool_unavailable"
    #: No conversion path exists — no registered normalizer, or the adapter never persists.
    UNSUPPORTED = "unsupported"


class AbsenceCategory(str, Enum):
    """The closed vocabulary of *why* a detail is not there (CPDO-2.4).

    Eight causes that "no details" used to conflate. Exactly one of them is a statement about
    the customer's source material being absent; the rest are statements about apiome, about a
    policy, or about the source's *content*. :data:`_ABSENCE_EXPLANATIONS` is the single place
    that decides which, and only :attr:`SOURCE_MISSING` sets ``source_missing``.
    """

    #: No source material was captured for the revision. The only category that is genuinely a
    #: missing source.
    SOURCE_MISSING = "source_missing"
    #: The revision predates payload analysis, or no analyzer has run for it yet.
    NOT_ANALYZED = "not_analyzed"
    #: The format has no analyzer. A capability boundary, not a defect in the source.
    FORMAT_UNSUPPORTED = "format_unsupported"
    #: The analyzer read the source but could not describe this part of it — a node/depth
    #: budget, or a grammar it knowingly does not read. The data is in the source; apiome has
    #: no description of it.
    PARSE_LIMIT = "parse_limit"
    #: The analyzer raised. The failure is recorded rather than hidden.
    ANALYZER_FAILED = "analyzer_failed"
    #: A value-visibility policy withheld the value. The structure is known; the content is
    #: deliberately not stored.
    VALUE_REDACTED = "value_redacted"
    #: The analyzer models this construct and did not observe it — so it is genuinely not in
    #: the source. The one category that is a positive statement about source content.
    ABSENT_IN_SOURCE = "absent_in_source"
    #: The registry makes no statement about this construct for this format. Its absence is
    #: evidence of nothing.
    UNDECLARED = "undeclared"


class ConstructAvailability(str, Enum):
    """What the registry can say about one named construct in one format."""

    #: The format's analyzer models this construct.
    MODELLED = "modelled"
    #: The format's analyzer declares it does **not** model this construct.
    UNMODELLED = "unmodelled"
    #: Neither list names it; the registry has no statement to make.
    UNDECLARED = "undeclared"


#: Analysis reason code → absence category. The bridge between CPDO-1.1's stored reason codes
#: and this registry's explanation vocabulary. Total over :data:`ANALYSIS_REASONS`, asserted by
#: contract test, so a reason code added there without a category here cannot ship.
REASON_ABSENCE_CATEGORIES: Dict[str, AbsenceCategory] = {
    REASON_NOT_ANALYZED: AbsenceCategory.NOT_ANALYZED,
    REASON_NO_SOURCE_CAPTURED: AbsenceCategory.SOURCE_MISSING,
    REASON_UNSUPPORTED_FORMAT: AbsenceCategory.FORMAT_UNSUPPORTED,
    REASON_BOUNDS_EXCEEDED: AbsenceCategory.PARSE_LIMIT,
    REASON_ANALYZER_FAILED: AbsenceCategory.ANALYZER_FAILED,
}


# ===========================================================================
# Value types
# ===========================================================================


class AnalyzerEvidence(BaseModel):
    """Which analyzer backs this entry's claims, and what it was built on.

    The "tool/version evidence" the ticket asks for. A capability claim without it is an
    opinion: "X12 composites are modelled" is only checkable if the reader knows *which*
    extractor at *which* version, over *which* parser release, is being described.

    Deliberately a snake_case sibling of :class:`~app.payload_analysis.AnalyzerInfo` rather
    than a reuse of it: that model serializes under camelCase aliases for the payload-analysis
    surface, and this registry's contract — like :mod:`app.capability_registry`'s — is
    snake_case end to end. One casing per contract beats one model across two.

    Attributes:
        key: Analyzer key (the adapter key, or ``generic`` for the format-blind walk).
        version: That analyzer's version.
        tool_versions: Underlying parser/library versions it leans on; empty when it uses none.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Analyzer key (the adapter key, or ``generic``).")
    version: str = Field(description="The analyzer implementation version this entry describes.")
    tool_versions: Dict[str, str] = Field(
        default_factory=dict,
        description="Underlying parser/library versions the analyzer leans on.",
    )


class SourceLocationSupport(BaseModel):
    """The best source pointer this format's analyzer can attach to a node."""

    model_config = ConfigDict(extra="forbid")

    quality: SourceLocationQuality = Field(
        description="The strongest pointer kind nodes from this format can carry."
    )
    note: str = Field(
        description="One line on what that means for navigation — what a reader can and "
        "cannot be shown."
    )


class ValueVisibilitySupport(BaseModel):
    """The value material this format's analysis can ever carry.

    Two different limits, and conflating them is how a UI ends up implying a value was hidden
    when the analyzer never had one. :attr:`default` is the policy applied when nobody chose;
    :attr:`maximum` is the ceiling the *analyzer* imposes — a COBOL copybook is a layout, not
    data, so its analysis has no observed values to withhold at any policy level.
    """

    model_config = ConfigDict(extra="forbid")

    default: str = Field(
        description="The value-visibility level applied when no explicit policy is chosen."
    )
    maximum: str = Field(
        description="The highest level this format's analyzer can ever supply, regardless of "
        "policy — ``none`` when the analyzer observes no values at all."
    )
    note: str = Field(description="One line on why the ceiling is where it is.")


class CanonicalProjectionSupport(BaseModel):
    """How much of the native analysis survives onto the canonical model."""

    model_config = ConfigDict(extra="forbid")

    coverage: ProjectionCoverage = Field(
        description="Whether every observed construct, some, or none reach the canonical model."
    )
    dropped_constructs: List[str] = Field(
        default_factory=list,
        description="Reviewed construct keys the canonical model has no representation for. "
        "Empty on a derived entry, which makes no claim.",
    )
    note: str = Field(
        description="One line on what the canonical model keeps and what only the analysis holds."
    )


class ConversionSupportEntry(BaseModel):
    """Whether this format participates in the conversion graph, and by which route.

    The route matters less than the *fact*: an adapter that persists a catalog item has, by
    contract, produced a canonical model for it, so it can reach every export destination. What
    varies is how — through a normalizer registered under one of the adapter's declared format
    keys, or inside the adapter itself — and whether it can run here at all.
    """

    model_config = ConfigDict(extra="forbid")

    support: ConversionSupport = Field(description="Whether a conversion path exists at all.")
    canonical_formats: List[str] = Field(
        default_factory=list,
        description="Declared format keys that resolve to a registered normalizer — the routes "
        "onto the canonical model, sorted. Empty when the adapter normalizes in-adapter.",
    )
    normalizes_in_adapter: bool = Field(
        default=False,
        description="True when no registered normalizer claims any declared key and the adapter "
        "builds the canonical model itself. Not a gap — a different route.",
    )
    declared_formats: List[str] = Field(
        default_factory=list,
        description="Every format key the adapter declares, sorted. A mix of normalizer keys and "
        "detection aliases, so a key here without a normalizer is not by itself a missing route.",
    )
    note: str = Field(description="One line on the conversion route or its absence.")


class FormatCapability(BaseModel):
    """The versioned capability & parsing-limit entry for one source format (CPDO-2.4).

    Everything a reader needs to know what apiome will *ever* be able to say about a document
    of this format, before opening one: the native hierarchy it preserves, the source pointers
    it can offer, the values it can carry, the grammar it does not read, what survives
    normalization, and whether it converts — each backed by the analyzer and tool versions in
    :attr:`analyzer`.
    """

    model_config = ConfigDict(extra="forbid")

    format: str = Field(description="Stable import-source registry key (e.g. ``edix12``).")
    label: str = Field(description="Human label for the format.")
    paradigm: Optional[str] = Field(
        default=None,
        description="The canonical paradigm the adapter produces, or null for an unknown format.",
    )
    provenance: CapabilityProvenance = Field(
        description="Whether this entry is reviewed, derived from the adapter, or a declaration "
        "that the format is unknown."
    )
    availability: FormatAvailability = Field(
        description="Whether this format can be imported and analysed in the current runtime."
    )
    unavailable_reason: Optional[str] = Field(
        default=None,
        description="Why the format is unavailable here, or null when it is available.",
    )
    native_hierarchy: NativeHierarchy = Field(
        description="How much of the format's own structure the analysis tree preserves."
    )
    native_hierarchy_note: str = Field(
        description="One line on what the tree's node vocabulary actually is."
    )
    analyzer: AnalyzerEvidence = Field(
        description="The analyzer and tool versions backing every claim in this entry."
    )
    source_location: SourceLocationSupport = Field(
        description="The best source pointer nodes from this format can carry."
    )
    value_visibility: ValueVisibilitySupport = Field(
        description="The value material this format's analysis can ever carry."
    )
    supported_constructs: List[str] = Field(
        default_factory=list,
        description="Construct keys the analyzer models, sorted. Their absence from a tree means "
        "they were not in the source.",
    )
    unsupported_constructs: List[str] = Field(
        default_factory=list,
        description="Construct keys the analyzer knowingly does not model, sorted — the format's "
        "unsupported grammar. Their absence from a tree means nothing about the source.",
    )
    limits: Dict[str, int] = Field(
        default_factory=dict,
        description="The numeric parsing limits in force (node/depth budgets, value preview "
        "length), so a bounded record is distinguishable from a small one.",
    )
    canonical_projection: CanonicalProjectionSupport = Field(
        description="How much of the native analysis survives onto the canonical model."
    )
    conversion: ConversionSupportEntry = Field(
        description="Whether this format participates in the conversion graph, and by which route."
    )
    version_coverage: VersionCoverage = Field(
        description="Which versions of this format are read and written, which one an export "
        "produces by default, and where a version is reached through a projection or a downgrade "
        "(FMT-3.8). A claim about *versions*: how completely the format's constructs are modelled "
        "is what ``unsupported_constructs`` and ``canonical_projection`` above answer.",
    )
    notes: List[str] = Field(
        default_factory=list,
        description="Reviewed prose about this format's boundaries, in reading order.",
    )
    registry_version: str = Field(description="The registry contract version this entry belongs to.")
    review_date: str = Field(description="When this entry's claims were last reviewed.")


class AbsenceExplanation(BaseModel):
    """The reviewed wording for one :class:`AbsenceCategory` (CPDO-2.4).

    One per category, so the eight causes are worded and rendered *separately*.
    :attr:`summary_template` may contain a single ``{construct}`` slot, substituted only with
    an apiome-controlled construct key.

    :attr:`source_missing` is the load-bearing field: it is ``True`` for exactly one category,
    and it is what a UI must consult before saying anything about the customer's source being
    absent. A parse limit, an unsupported format and an analyzer failure all leave it ``False``.
    """

    model_config = ConfigDict(extra="forbid")

    category: AbsenceCategory = Field(description="The cause category this explanation is for.")
    category_label: str = Field(description="Short human label (e.g. 'Parser limit').")
    summary_template: str = Field(
        description="Reviewed one-line explanation, optionally with a single ``{construct}`` slot."
    )
    remediation: str = Field(description="Short, safe guidance for this category.")
    source_missing: bool = Field(
        description="True only when the source material itself was never captured. Never true "
        "for a parser, capability, policy or content cause."
    )


class ConstructExplanation(BaseModel):
    """Why one named construct is not in one format's analysis (CPDO-2.4).

    The resolved answer for "the tree has no ``x12.hl_hierarchy`` node — what does that mean?".
    :attr:`source_missing` is always ``False``: a construct's absence from an analysis is never
    evidence that the source was not captured, whichever way the registry resolves it.
    """

    model_config = ConfigDict(extra="forbid")

    format: str = Field(description="The format key the question was asked about.")
    # Named ``construct_key`` rather than ``construct``: pydantic's ``BaseModel`` already carries
    # a deprecated ``construct`` classmethod, and shadowing it emits a warning on every import.
    construct_key: str = Field(description="The construct key the question was asked about.")
    availability: ConstructAvailability = Field(
        description="Whether the analyzer models, does not model, or says nothing about it."
    )
    category: AbsenceCategory = Field(description="The absence category this resolves to.")
    summary: str = Field(description="The rendered one-line explanation.")
    remediation: str = Field(description="Short, safe guidance.")
    source_missing: bool = Field(
        description="Always false — a construct's absence never means the source is missing."
    )


class FormatCapabilitySnapshot(BaseModel):
    """The full, deterministic registry view exposed to the REST contract + UI (CPDO-2.4).

    Derived from the (deterministic) import-source registry and the static seeds, so identical
    inputs yield an identical snapshot — safe to cache by :attr:`version` and to mirror in a
    TypeScript contract.
    """

    model_config = ConfigDict(extra="forbid")

    version: str = Field(description="The registry contract version (:data:`REGISTRY_VERSION`).")
    review_date: str = Field(description="When the registry's seeds/explanations were reviewed.")
    analysis_schema_version: str = Field(
        description="The payload-analysis contract version this registry's reason mapping pairs "
        "with, so a reader can tell the two apart when either moves.",
    )
    absence_categories: List[str] = Field(
        description="The canonical set of absence-category strings, sorted. Contract tests reject "
        "any category outside this set.",
    )
    absences: List[AbsenceExplanation] = Field(
        description="The reviewed explanation for each absence category, in vocabulary order.",
    )
    reason_absence_categories: Dict[str, str] = Field(
        description="Analysis reason code → absence category, for every reason code CPDO-1.1 can "
        "store.",
    )
    formats: List[FormatCapability] = Field(
        description="One capability entry per registered import source, in key order.",
    )


# ===========================================================================
# Absence explanations (one reviewed template per cause)
# ===========================================================================

# The single source of the eight causes' honest wording. The whole point of the table is the
# ``source_missing`` column: it is True on exactly one row, and no derivation anywhere in this
# module can move it. A parse limit says the data is in the source and apiome cannot describe
# it — the opposite claim from "the source is missing", and the one CPDO-2.4 exists to keep
# distinguishable.
_ABSENCE_EXPLANATIONS: Dict[AbsenceCategory, AbsenceExplanation] = {
    AbsenceCategory.SOURCE_MISSING: AbsenceExplanation(
        category=AbsenceCategory.SOURCE_MISSING,
        category_label="Source not captured",
        summary_template="No source material was captured for this revision, so there is nothing "
        "to analyse for {construct}.",
        remediation="Re-import the item so its source is captured, then the analysis will run.",
        source_missing=True,
    ),
    AbsenceCategory.NOT_ANALYZED: AbsenceExplanation(
        category=AbsenceCategory.NOT_ANALYZED,
        category_label="Not analysed yet",
        summary_template="This revision has not been analysed, so nothing is known about "
        "{construct} either way.",
        remediation="Re-import the item to produce an analysis for its current revision.",
        source_missing=False,
    ),
    AbsenceCategory.FORMAT_UNSUPPORTED: AbsenceExplanation(
        category=AbsenceCategory.FORMAT_UNSUPPORTED,
        category_label="Format not analysed",
        summary_template="apiome has no native analyzer for this format, so {construct} is not "
        "described. The source itself is unaffected.",
        remediation="This is an apiome capability boundary, not a problem with the source.",
        source_missing=False,
    ),
    AbsenceCategory.PARSE_LIMIT: AbsenceExplanation(
        category=AbsenceCategory.PARSE_LIMIT,
        category_label="Parser limit",
        summary_template="apiome's analyzer for this format does not describe {construct}; the "
        "source may well contain it.",
        remediation="This is an apiome parser limitation — read the original source to confirm "
        "what is there.",
        source_missing=False,
    ),
    AbsenceCategory.ANALYZER_FAILED: AbsenceExplanation(
        category=AbsenceCategory.ANALYZER_FAILED,
        category_label="Analysis failed",
        summary_template="The analyzer failed on this revision, so {construct} was never "
        "described. The import itself completed.",
        remediation="Re-import to retry the analysis; the catalog item is unaffected.",
        source_missing=False,
    ),
    AbsenceCategory.VALUE_REDACTED: AbsenceExplanation(
        category=AbsenceCategory.VALUE_REDACTED,
        category_label="Value withheld",
        summary_template="The structure of {construct} is known, but its value is withheld by the "
        "value-visibility policy in force.",
        remediation="Request a wider value visibility only if the stored record was written under "
        "one; a record never held values it can now reveal.",
        source_missing=False,
    ),
    AbsenceCategory.ABSENT_IN_SOURCE: AbsenceExplanation(
        category=AbsenceCategory.ABSENT_IN_SOURCE,
        category_label="Not in the source",
        summary_template="The analyzer models {construct} and did not observe it, so this source "
        "does not contain it.",
        remediation="No action needed — this is a statement about the source, not about apiome.",
        source_missing=False,
    ),
    AbsenceCategory.UNDECLARED: AbsenceExplanation(
        category=AbsenceCategory.UNDECLARED,
        category_label="No statement",
        summary_template="apiome's capability registry makes no statement about {construct} for "
        "this format, so its absence means nothing either way.",
        remediation="Read the original source to determine what is there.",
        source_missing=False,
    ),
}


def absence_explanation(category: AbsenceCategory) -> AbsenceExplanation:
    """Return the reviewed :class:`AbsenceExplanation` for ``category``.

    Args:
        category: The cause category to explain.

    Returns:
        Its reviewed explanation.
    """
    return _ABSENCE_EXPLANATIONS[category]


def absence_explanations() -> List[AbsenceExplanation]:
    """Return every category's reviewed explanation, in vocabulary (enum) order."""
    return [_ABSENCE_EXPLANATIONS[category] for category in AbsenceCategory]


def _render(template: str, construct: Optional[str]) -> str:
    """Render an explanation template, naming ``construct`` safely.

    Substitutes only the single ``{construct}`` slot, and only with a backticked construct key.
    When ``construct`` is omitted a neutral phrase keeps the sentence readable. A literal
    replacement rather than :meth:`str.format`, so a template is text and never a format string —
    the TypeScript mirror does the same, and neither can raise on an unbalanced brace.

    Args:
        template: The reviewed ``summary_template``.
        construct: The construct key to name, or ``None`` for generic phrasing.

    Returns:
        The rendered sentence.
    """
    return template.replace("{construct}", f"`{construct}`" if construct else "this detail")


def explain_analysis_absence(*, status: str, reason: Optional[str]) -> Optional[AbsenceExplanation]:
    """Explain why a payload analysis has no detail, from its stored status and reason.

    The record-level half of the registry's honesty guarantee: every non-available analysis
    status resolves to exactly one reviewed category, and only ``no_source_captured`` resolves
    to a source-missing one. An *unrecognised* reason code resolves to
    :attr:`AbsenceCategory.NOT_ANALYZED` rather than to anything that would claim more than is
    known — a code this registry has never seen is not evidence about the source.

    Args:
        status: The analysis status (:data:`~app.payload_analysis.ANALYSIS_STATUSES`).
        reason: The stored reason code, or ``None``.

    Returns:
        The reviewed explanation, or ``None`` when ``status`` is ``available`` — an available
        analysis has no absence to explain. Pass the result through :func:`render_absence` to
        name the construct it is about.
    """
    if status == STATUS_AVAILABLE and not reason:
        return None
    if not reason:
        # A non-available status is required by the CPDO-1.1 contract to carry a reason; a row
        # that somehow does not is reported as un-analysed rather than as anything stronger.
        return _ABSENCE_EXPLANATIONS[AbsenceCategory.NOT_ANALYZED]
    category = REASON_ABSENCE_CATEGORIES.get(reason)
    if category is None:
        logger.debug("format capability registry: unmapped analysis reason %r", reason)
        return _ABSENCE_EXPLANATIONS[AbsenceCategory.NOT_ANALYZED]
    return _ABSENCE_EXPLANATIONS[category]


def render_absence(explanation: AbsenceExplanation, construct: Optional[str] = None) -> str:
    """Render ``explanation``'s reviewed sentence, naming ``construct`` safely.

    Args:
        explanation: The reviewed explanation to render.
        construct: The construct key to name, or ``None`` for generic phrasing.

    Returns:
        The rendered one-line explanation.
    """
    return _render(explanation.summary_template, construct)


def explain_construct(format_key: str, construct: str) -> ConstructExplanation:
    """Explain what one construct's absence from ``format_key``'s analysis means.

    The construct-level half of the honesty guarantee, and the direct answer to "the tree has
    no node for this — is the data missing?". Three outcomes, and none of them is
    source-missing:

    * the analyzer **models** it → :attr:`AbsenceCategory.ABSENT_IN_SOURCE`: a positive
      statement that the source does not contain it;
    * the analyzer **declares it unmodelled** → :attr:`AbsenceCategory.PARSE_LIMIT`: the source
      may well contain it and apiome has no description of it;
    * neither list names it → :attr:`AbsenceCategory.UNDECLARED`: the registry has nothing to
      say, which is itself the honest answer.

    Args:
        format_key: The import-source key of the analysed format.
        construct: The analyzer's dotted construct key (e.g. ``x12.hl_hierarchy``).

    Returns:
        The resolved :class:`ConstructExplanation`, always with ``source_missing`` false.
    """
    capability = capability_for(format_key)
    normalized = construct.strip()
    if normalized and normalized in set(capability.supported_constructs):
        availability = ConstructAvailability.MODELLED
        category = AbsenceCategory.ABSENT_IN_SOURCE
    elif normalized and normalized in set(capability.unsupported_constructs):
        availability = ConstructAvailability.UNMODELLED
        category = AbsenceCategory.PARSE_LIMIT
    else:
        availability = ConstructAvailability.UNDECLARED
        category = AbsenceCategory.UNDECLARED
    explanation = _ABSENCE_EXPLANATIONS[category]
    return ConstructExplanation(
        format=capability.format,
        construct_key=normalized,
        availability=availability,
        category=category,
        summary=_render(explanation.summary_template, normalized or None),
        remediation=explanation.remediation,
        source_missing=False,
    )


# ===========================================================================
# Reviewed seeds
# ===========================================================================


class _Seed(BaseModel):
    """A reviewed capability seed: the claims no derivation could make on its own.

    Only the fields a person checked against the format's parser and normalizer. Everything
    else on the entry — the analyzer identity, the construct lists, the limits, the conversion
    route — is still read off the live adapter, so a seed cannot go stale about the things the
    code knows.
    """

    model_config = ConfigDict(extra="forbid")

    native_hierarchy: NativeHierarchy
    native_hierarchy_note: str
    source_location: SourceLocationSupport
    value_visibility: ValueVisibilitySupport
    canonical_projection: CanonicalProjectionSupport
    notes: List[str] = Field(default_factory=list)


# EDI X12 and COBOL copybook are seeded explicitly because they are the two formats whose
# boundaries the ticket requires to be stated rather than inferred — and the two where the gap
# between "the analysis holds it" and "the canonical model holds it" is widest. gRPC joined them
# in FMT-3.7 (#5432), which needed the registry to say which Protobuf **Editions** features the
# canonical model carries and which it does not.
_CAPABILITY_SEED: Dict[str, _Seed] = {
    "grpc": _Seed(
        # gRPC's payload analysis is still the format-blind walk, so these three fields restate
        # what derivation produces rather than claiming more. Only the projection statement and
        # the notes below are reviewed judgements — which is exactly what FMT-3.7 needed a seed
        # for: what a compiled descriptor set loses on its way into the canonical model.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.PATH_ONLY,
            note=(
                "Nodes locate by structural path and sibling ordinal only. A UI can identify the "
                "construct but cannot point at a line or byte range in the raw source. A "
                "descriptor set is a compiled artifact and carries no source spans, so a line "
                "number could only ever be guessed from the uploaded text."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.FULL,
            note=(
                "Leaf values are observed, so the stored record carries whatever the "
                "value-visibility policy in force allows — the default keeps only presence and "
                "length."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "protobuf.custom_options",
                "protobuf.extension_ranges",
                "protobuf.features.default_symbol_visibility",
                "protobuf.features.enforce_naming_style",
            ],
            note=(
                "Services, methods with their streaming modes, messages, fields with their "
                "numbers, enums with their value numbers, oneofs and reserved ranges all "
                "survive. **Protobuf Editions** (2023/2024) features are resolved down the "
                "lexical scope chain and six of the eight are modelled: `field_presence` "
                "becomes canonical nullability (an EXPLICIT field is nullable, its IMPLICIT "
                "twin is not, and LEGACY_REQUIRED is neither), `enum_type` becomes the enum's "
                "`enum_closed` flag, and `repeated_field_encoding`, `utf8_validation`, "
                "`message_encoding` and `json_format` are recorded on the construct that sets "
                "them. The two listed above are not modelled: they govern generated-code "
                "naming and symbol visibility — compiler behaviour with no wire or JSON "
                "meaning — so the canonical model has nothing for them to become. Every file's "
                "edition, syntax and fully resolved feature set is recorded in provenance "
                "whether or not each feature is modelled."
            ),
        ),
        notes=[
            "The compiled descriptor set is the artifact of record, not the .proto text: "
            "imports, option inheritance and Editions feature resolution are the compiler's "
            "answers, never a re-parse here. A document that does not compile has no analysis "
            "at all, which is reported as a compile failure rather than as an empty source.",
            "Editions feature resolution is ours, not the compiler's: `buf build` writes each "
            "scope's raw `features` override into the descriptor and leaves the merge to the "
            "reader, so the resolved values reported here are computed from the edition's own "
            "defaults table as published in descriptor.proto.",
            "A type a target file references but an *import* declares (google.protobuf."
            "Timestamp, a sibling module's message) is carried as a reference with no local "
            "definition. That is the shape a protobuf `import` has, not a resolution failure.",
            "Custom options and extension declarations are preserved in the descriptor set and "
            "in the retained source, and only there — the canonical model has no vocabulary for "
            "a user-defined option, so it is neither named nor counted.",
        ],
    ),
    "edix12": _Seed(
        native_hierarchy=NativeHierarchy.NATIVE,
        native_hierarchy_note=(
            "Interchange → functional group → transaction set → segment → element, with "
            "composite components regrouped under their element position rather than flattened "
            "into siblings."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.BYTE_OFFSETS,
            note=(
                "The X12 parser exposes no positions, so the interchange text is scanned a second "
                "time on its own declared delimiters and matched to the parsed segments. Every "
                "segment, group and transaction set then carries the exact offset, length and line "
                "of the bytes it was read from, alongside its envelope path "
                "(``ISA/GS[0]/ST[2]/NM1[4]``). Where the two readings disagree the scan is "
                "abandoned whole and the record falls back to path and ordinal — a record carries "
                "positions that were checked against the parse, or it carries none."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.FULL,
            note=(
                "Element values are observed, so the stored record carries whatever the "
                "value-visibility policy in force allows — nothing more. An X12 element is "
                "business data (names, account numbers, claim amounts); the default withholds it "
                "and keeps only presence and length."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "x12.control_numbers",
                "x12.delimiters",
                "x12.empty_elements",
                "x12.envelope_control_totals",
                "x12.functional_group",
                "x12.interchange_envelope",
                "x12.repeating_elements",
                "x12.segment_ordinals",
                "x12.segment_repeat_counts",
            ],
            note=(
                "The canonical model describes one schema, so normalization reads the first "
                "functional group's first transaction set and drops the envelope around it. "
                "Every group and transaction set the interchange carried is in the analysis, "
                "and only there. An analysis of an interchange carrying more than one says so "
                "explicitly, naming the set the conversion was derived from."
            ),
        ),
        notes=[
            "An element position the source wrote and left empty is recorded as present with a "
            "zero length; a position the source never wrote is not recorded at all. The two are "
            "different facts about the payload and are never rendered as one.",
            "HL loops are described as the segments they are, not as the hierarchy they encode. "
            "Where the interchange declares a repetition separator (ISA11 at 00501 and later, "
            "never at 00401) a repeated element carries its occurrences and states how many.",
            "Control totals declared by the SE, GE and IEA trailers are recorded beside the "
            "counts actually observed, so an interchange that disagrees with itself can be seen "
            "to. The trailer segments themselves are not tree nodes, and TA1 acknowledgements are "
            "removed by the parser before the analysis runs.",
            "No 4010/5010 implementation-guide conformance is evaluated — a structurally valid "
            "interchange is not claimed to be a conformant one, and an ST03 implementation "
            "convention reference is recorded as the sender's claim rather than as a checked fact.",
        ],
    ),
    "relaxng": _Seed(
        # RELAX NG's payload analysis is still the format-blind walk, so the first three
        # fields restate what derivation produces. The reviewed judgement is the projection
        # statement below: FMT-4.1's acceptance criterion is that `interleave` and the
        # datatype-library constructs are *declared*, and this is where a reader is told what
        # a RELAX NG grammar loses on its way into the canonical model.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.PATH_ONLY,
            note=(
                "Patterns locate by structural path and sibling ordinal only. The hardened XML "
                "reader exposes no positions, and the compact syntax is read by a separate "
                "tokenizer, so a line number would have to be guessed differently for each of "
                "the two spellings of one grammar."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "A grammar is a schema, not data: the analyzer observes no runtime values at any "
                "policy level. 'No value here' is the absence of data to observe, not a "
                "redaction."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "relaxng.datatype_except",
                "relaxng.external_datatype_library",
                "relaxng.interleave",
                "relaxng.list",
                "relaxng.mixed",
                "relaxng.name_class_wildcard",
                "relaxng.remote_href",
            ],
            note=(
                "Named patterns become canonical types, `element`/`attribute` patterns become "
                "fields, `choice` becomes a union (or an `enum` constraint when its branches are "
                "literal values), `optional`/`zeroOrMore`/`oneOrMore` become nullability and "
                "lists, and `data` parameters become canonical constraints. Composition is "
                "resolved before normalization, so `include` (with its overrides) and "
                "`externalRef` leave no trace to lose. The listed constructs are *carried but "
                "not fully expressible*: `interleave`'s branches all survive as members and only "
                "their order-independence is lost (each such member is tagged "
                "`relaxng_interleaved`), an `anyName`/`nsName` wildcard becomes a single "
                "open-content member named `*`, a `data` `except` clause keeps the base datatype "
                "and records the exclusion without enforcing it, `list` becomes a list of its "
                "item type without the single-text-node encoding, `mixed` keeps the character "
                "content as an extra member, and a datatype library other than the W3C XML "
                "Schema datatypes is carried verbatim rather than interpreted. Every occurrence "
                "is counted and located in `extras['relaxng']['capability_limits']`."
            ),
        ),
        notes=[
            "The XML syntax (`.rng`) and the compact syntax (`.rnc`) are two spellings of one "
            "language and are read by two front-ends onto one pattern algebra, so the same "
            "grammar written either way produces the same canonical model — the syntax is "
            "deliberately not part of the model, and survives only on the retained raw source.",
            "An `include`/`externalRef` naming an absolute URL is never fetched. Its shape is "
            "vetted against the SSRF policy — a `file:`/`data:` href, or one carrying "
            "credentials, fails the import as an unsafe construct — and a policy-legal http(s) "
            "href is recorded as a declared limit whose definitions are absent, which then "
            "surfaces as an unresolved reference rather than as a silently smaller grammar.",
            "RELAX NG *output* is not implemented (#4134), so a grammar imported here is "
            "exported through another target's emitter and is not written back as RELAX NG.",
        ],
    ),
    "dtd": _Seed(
        # A DTD's payload analysis is the format-blind walk, so the first three fields
        # restate what derivation produces. The reviewed judgement is the projection
        # statement below: FMT-4.2's acceptance criterion is that mixed content is modelled
        # *or* declared a limit **explicitly**, and this is where a reader is told which —
        # both, as it turns out — and what else a DTD loses on its way into the model.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.PATH_ONLY,
            note=(
                "Declarations locate by structural path and sibling ordinal only. A DTD is read "
                "by a scanner over an entity input stack, so a byte offset in the composed text "
                "does not correspond to a position in any file a user uploaded — a declaration "
                "pulled in through a parameter entity lives in a different file from the "
                "reference that pulled it."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "A DTD is a schema, not data: the analyzer observes no runtime values at any "
                "policy level. 'No value here' is the absence of data to observe, not a "
                "redaction. An internal subset arrives inside an instance document, and the "
                "instance's content is not read at all."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "dtd.any_content",
                "dtd.id_uniqueness",
                "dtd.mixed_content",
                "dtd.orphan_attlist",
                "dtd.remote_system_id",
                "dtd.repeated_group",
                "dtd.tokenized_attribute",
                "dtd.unparsed_entity",
            ],
            note=(
                "Each `<!ELEMENT>` becomes one canonical type — a `(#PCDATA)` element with no "
                "attributes is a `SCALAR`, everything else a `RECORD` — and a name in a content "
                "model becomes a member typed by that element's type, never a copy of it. "
                "Occurrence indicators become nullability and lists (`?` nullable, `*` a "
                "nullable list, `+` a required list), a `choice` becomes a `UNION` referenced by "
                "one member, and an element named twice in one model folds into one member "
                "bounded by `min_items`/`max_items`. `<!ATTLIST>` definitions become members "
                "carrying the XPath `@` sigil, and the whole default vocabulary becomes "
                "canonical constraints: an enumeration and a `#FIXED` value become `enum`, a "
                "bare literal becomes `default`, `#REQUIRED` a non-nullable member and "
                "`#IMPLIED` a nullable one. Entities are expanded before normalization, so "
                "their uses leave no trace to lose, and the declarations are carried in "
                "`extras['dtd']`. The listed constructs are *carried but not fully "
                "expressible*: mixed content keeps its child elements as repeated members "
                "beside a `#text` member and loses only the interleaving, `ANY` becomes one "
                "open-content member, an occurrence indicator on a group distributes onto the "
                "group's members, `IDREFS`/`ENTITIES`/`NMTOKENS` become lists of strings, "
                "`ID`/`IDREF` record their declared type without enforcing uniqueness or "
                "referential integrity, an unparsed entity and its notation are recorded rather "
                "than modelled, an `<!ATTLIST>` for an element that is never declared is "
                "recorded rather than failed, and an absolute system identifier is recorded "
                "rather than fetched. Every occurrence is counted and located in "
                "`extras['dtd']['capability_limits']`."
            ),
        ),
        notes=[
            "A DTD is not XML and is not read by an XML parser: `<!ELEMENT>`/`<!ATTLIST>` are "
            "markup declarations, and the shared hardened XML reader refuses a `DOCTYPE` "
            "outright. The reader is a scanner with its own byte, nesting and entity-expansion "
            "ceilings, and it reads an external subset, an internal subset, and a modular set "
            "composed through parameter entities by the same path.",
            "Entity expansion is bounded in three dimensions at once — how many references are "
            "expanded, how many bytes they produce, and how deep the expansion nests — and "
            "every reference is charged against one budget, so a document cannot move work "
            "between the parameter-entity and general-entity mechanisms to spend past a guard. "
            "An entity that re-enters its own expansion chain is refused as an unsafe "
            "construct rather than unrolled until a budget stops it.",
            "Nothing external is fetched. A relative system identifier resolves against the "
            "uploaded set; an absolute one is vetted against the SSRF policy — a `file:`/`data:` "
            "identifier, or one carrying credentials, fails the import — and a policy-legal "
            "http(s) identifier is recorded as a declared limit whose declarations are absent. "
            "This is the XXE and blind-XXE shape, and it fails closed.",
            "A DTD has no documentation construct: comments are not attached to the "
            "declarations they precede, so imported types and members carry no description and "
            "the absence is the format's, not the reader's.",
            "DTD *output* is not implemented, so a DTD imported here is exported through "
            "another target's emitter and is not written back as a DTD.",
        ],
    ),
    "odcs": _Seed(
        # ODCS's payload analysis is the format-blind walk, so the first three fields
        # restate what derivation produces. The reviewed judgement is the projection
        # statement below: FMT-5.1's acceptance criterion is that the registry declares
        # what is *modelled* and what is *carried but not modelled*, and this is where a
        # reader is told which half of a data contract each of its blocks lands in.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.PATH_ONLY,
            note=(
                "Schema objects and properties locate by name and structural path only. A "
                "contract published across files is composed before normalization — a quality "
                "pack maintained beside the contract is merged into the object it names — so a "
                "rule's position in one member does not identify it inside the composed "
                "contract."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "A data contract is a schema, not data: the analyzer observes no runtime values "
                "at any policy level. 'No value here' is the absence of data to observe, not a "
                "redaction. The values a contract *states* — a property's `examples`, an "
                "enumerated `logicalTypeOptions.enum` — are part of the schema and are carried "
                "as constraints and extras."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "odcs.authoritative_definition",
                "odcs.classification",
                "odcs.custom_property",
                "odcs.declaration_order",
                "odcs.free_form_object",
                "odcs.key_uniqueness",
                "odcs.partitioning",
                "odcs.physical_type",
                "odcs.price",
                "odcs.quality_rule",
                "odcs.server",
                "odcs.sla_property",
                "odcs.support_channel",
                "odcs.tag",
                "odcs.team_role",
                "odcs.transform_metadata",
            ],
            note=(
                "A data contract has two halves and they land differently. The *structural* "
                "half is modelled: each `schema[]` object becomes one canonical `RECORD`, each "
                "property becomes one member, `required` becomes nullability, a nested `object` "
                "property becomes a synthesized record keyed by its path, an `array` becomes a "
                "list around its `items` type, and `logicalTypeOptions` — the portable half of "
                "ODCS typing — becomes canonical constraints: lengths, numeric bounds, "
                "`pattern`, `enum`, and `format` when the declared value is a format token "
                "rather than a free-form date pattern. Declaration order is recorded in "
                "`odcs_position` because a dataset's column order is physical and canonical "
                "ordering does not follow it. The *governance* "
                "half — the listed constructs — is **carried but not modelled**: quality rules, "
                "`team`/`roles` ownership, `slaProperties`, `servers`, `support`, `price`, "
                "`tags`, `customProperties` and `authoritativeDefinitions` survive verbatim "
                "under the documented `odcs_*` extras namespace, on whichever node declared "
                "them, so nothing is lost and nothing is re-spelled — but no canonical feature "
                "reads them, and none of them is enforced. `physicalType` is deliberately not "
                "interpreted: `varchar(20)` does not become `maxLength: 20`, because the unit "
                "differs by dialect. Every occurrence is counted and located in "
                "`extras['odcs']['capability_limits']`."
            ),
        ),
        notes=[
            "The reader covers the ODCS v3.x line, and only that line. A v2.2.x contract "
            "declares the same `apiVersion`/`kind` pair but spells a dataset as `quantumName` "
            "with `dataset[].columns[]`, so it is claimed by detection and then rejected *by "
            "version*, with the v2 -> v3 renames named in the message — never parsed into an "
            "empty contract.",
            "A contract that describes no structure is refused rather than imported: a "
            "`schema[]` object with no `properties` would produce an empty catalog type, which "
            "reads as 'this dataset has no columns' rather than as 'this document did not say'.",
            "`authoritativeDefinitions` URLs are recorded and **never fetched** during import. "
            "A relative URL naming a member of the same imported file set is additionally "
            "recorded as resolved, but its content is not expanded — a JSON Schema a contract "
            "delegates its payload shape to stays a reference, not a set of canonical types.",
            "Quality rules are carried, never executed and never translated into constraints. A "
            "`sql` rule's query, a `custom` rule's engine block and a `text` rule's prose are "
            "kept exactly as written, which is what lets the emitter write them back unchanged.",
            "ODCS *output* is implemented (FMT-5.2), and it is the one target in the fleet whose "
            "emitted artifacts are checked against the format's **own published JSON Schema**, "
            "shipped with this service and run offline. The governance half is written back from "
            "the `odcs_*` extras verbatim, so a contract imported and re-exported is canonically "
            "identical. The structural half is rebuilt, and the emitter refuses to write a facet "
            "the standard does not admit beside the column's `logicalType` — a non-standard "
            "`enum` type option is dropped and reported rather than written illegally.",
            "Nothing in the governance half is ever invented on export. A contract emitted from a "
            "schema that carries no ownership, SLA or quality metadata is written *without* those "
            "blocks, and their absence is reported as a `SYNTH` finding: a fabricated owner or "
            "service level is a governance claim nobody made. The only values supplied without a "
            "source are `version` and `status`, which the standard requires for a document to "
            "exist at all, and both are reported as fabricated.",
        ],
    ),
    "arrow": _Seed(
        # Arrow's payload analysis is the format-blind walk, so the first three fields restate
        # what derivation produces. The reviewed judgement is the projection statement below:
        # FMT-4.5's acceptance criterion is that nested, dictionary-encoded and decimal types
        # are *modelled or declared limits*, and this is where a reader is told which of the two
        # each one is — and what an Arrow schema's encoding, as distinct from its data, costs on
        # the way into the canonical model.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.NONE,
            note=(
                "An Arrow schema is read from one of three serializations, and two of them are "
                "binary — an IPC Flatbuffer and a Flight reply have no lines to point at. Fields "
                "locate by name and column position only, and they locate the same way in all "
                "three, which is the property that makes the surfaces interchangeable."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "An Arrow *schema* is metadata about a table, not the table: the analyzer "
                "observes no column values at any policy level, because the payload imported "
                "carries none. 'No value here' is the absence of data to observe, not a "
                "redaction."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "arrow.decimal_width",
                "arrow.dictionary_encoding",
                "arrow.extension_type",
                "arrow.flight_endpoint",
                "arrow.half_precision",
                "arrow.interval",
                "arrow.physical_layout",
                "arrow.temporal_unit",
                "arrow.union_layout",
            ],
            note=(
                "A schema becomes one canonical `RECORD` — the table — with one field per "
                "column, keeping the column's position in `field_number` so a key-sorted model "
                "does not lose it. Nested types are modelled exactly: a `struct` is a `RECORD`, "
                "a `list`/`fixedsizelist` is a list reference (a fixed size additionally bounds "
                "it with `min_items`/`max_items`), a `map` is a `MAP` with both its key and "
                "value types, and a `union` is a `UNION` over its variants. Primitives take the "
                "canonical scalar of their exact width, a `fixedsizebinary` becomes `bytes` "
                "bounded by its byte width, and the temporal types become a formatted `string`. "
                "The listed constructs are *carried but not fully expressible*: a "
                "dictionary-encoded field keeps its value type and records the index type and "
                "ordering, a `decimal` keeps the `decimal` scalar and records its precision, "
                "scale and storage width, an extension type keeps its storage type and records "
                "its name, a `union` records its mode and type codes, an `interval` and a "
                "half-precision float take the nearest canonical type, the large-offset, view "
                "and run-end-encoded variants take their ordinary counterpart, and a Flight "
                "response's endpoints are recorded rather than becoming operations. Every "
                "occurrence is counted and located in `extras['arrow']['capability_limits']`."
            ),
        ),
        notes=[
            "The three surfaces are one reader. The JSON integration form, a binary IPC stream "
            "or file, and a Flight `GetSchema` reply all parse into the same document type "
            "before anything is normalized, so an IPC schema and its JSON twin produce the same "
            "canonical model — the same types, the same keys, the same fingerprint — rather "
            "than two models that resemble each other.",
            "The model's identity is derived from the *document*, never from the filename: a "
            "Flight descriptor's path names the dataset, a `name` in the schema metadata names "
            "it otherwise, and a schema that names itself nothing is called `Schema`. That is "
            "what lets the same table imported from two serializations be one API.",
            "Schema and field metadata are carried verbatim, and the conventional documentation "
            "keys (`description`, `comment`, `doc`) become descriptions. Arrow defines no "
            "documentation construct, so a schema whose columns are undocumented imports "
            "undocumented — the absence is the format's, not the reader's.",
            "A live Flight endpoint is vetted against the SSRF policy before a client is "
            "constructed, and its credentials come from the shared credential vault as call "
            "headers. Nothing else is fetched: a schema names no external references.",
            "Arrow *output* is not implemented here (#4317 files the Parquet/Arrow emitter), so "
            "a schema imported through this adapter is exported through another target's "
            "emitter and is not written back as Arrow.",
        ],
    ),
    "cddl": _Seed(
        # CDDL's payload analysis is the format-blind walk, so the first three fields
        # restate what derivation produces. The reviewed judgement is the projection
        # statement below: FMT-4.4's acceptance criterion is that control operators map to
        # canonical constraints where an analogue exists and are *declared losses* where
        # none does, and this is where a reader is told which is which — and what sockets,
        # generics and tags cost on the way into the model.
        native_hierarchy=NativeHierarchy.GENERIC,
        native_hierarchy_note=(
            "The format-blind walk records containers, ordered collections and leaves. Nesting "
            "and ordering survive; this format's own semantics are not named, and their absence "
            "from the tree says nothing about the source."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.PATH_ONLY,
            note=(
                "Rules locate by name and structural path only. A grammar split across files "
                "is composed into one namespace before normalization — CDDL has no include "
                "directive, so the set is the unit of import — and a rule's byte offset in one "
                "member does not identify it inside the composed grammar."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "A CDDL grammar is a schema, not data: the analyzer observes no runtime values "
                "at any policy level. 'No value here' is the absence of data to observe, not a "
                "redaction. The literal values a grammar states — a member key, a type choice "
                "of strings — are part of the schema and are carried as constraints."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "cddl.control_bits",
                "cddl.control_cbor",
                "cddl.control_intersection",
                "cddl.control_unmapped",
                "cddl.control_within",
                "cddl.generic_rule",
                "cddl.group_choice",
                "cddl.group_socket",
                "cddl.major_type",
                "cddl.open_map_entry",
                "cddl.tag",
                "cddl.type_socket",
                "cddl.unwrap",
            ],
            note=(
                "Every type rule becomes one canonical type: a map is a `RECORD` (a `MAP` when "
                "its whole body is a table), an array is a `RECORD` of positional members (an "
                "`ALIAS` to a list when it holds one repeated element), `&( … )` is an `ENUM`, a "
                "choice is a `UNION` (a `SCALAR` carrying `enum` when every branch is a "
                "literal), and everything else is a `SCALAR`. A group rule produces no type — it "
                "exists to be spliced, and every splice site carries its members. Occurrence "
                "indicators become nullability and lists, and an explicit `n*m` additionally "
                "bounds the list with `min_items`/`max_items`. Control operators become "
                "constraints wherever an analogue exists: `.size` becomes lengths (or, on an "
                "integer, the value range that many bytes admit), `.regexp` becomes `pattern`, "
                "`.lt`/`.le`/`.gt`/`.ge` become the numeric bounds, `.eq` becomes a "
                "single-valued `enum`, `.default` becomes the member's default, and `.and` "
                "merges both operands' constraints. The listed constructs are *carried but not "
                "fully expressible*: a CBOR tag and a major-type shorthand keep the type "
                "underneath and record the encoding slot, `~name` types the member by the rule "
                "it unwraps, a table entry beside named members becomes one open-content member "
                "named `*`, a group choice spliced into a larger group carries its first "
                "alternative (a group choice that is a whole map or array body is modelled "
                "exactly, as a union of one record per alternative), a socket is resolved to "
                "the plugs the document supplies and only its open-endedness is lost, a "
                "parameterised rule is instantiated once per use rather than typed in the "
                "abstract, and `.cbor`/`.cborseq`/`.bits`/`.within`/`.ne` are recorded on the "
                "member in `cddl_control` without being enforced. Every occurrence is counted "
                "and located in `extras['cddl']['capability_limits']`."
            ),
        ),
        notes=[
            "CDDL is read *and* written. The reader records each construct's source spelling — "
            "which prelude type a leaf used, a tag, an unmapped control operator, whether a "
            "record came from a map or an array — in `extras`, and the emitter writes every one "
            "of them back, so a grammar imported and re-exported is the grammar that arrived "
            "rather than a re-derivation of it.",
            "Sockets, plugs and generics are *composition*, and are resolved before "
            "normalization: a type socket's `/=` plugs become a choice, a group socket's `//=` "
            "plugs become a group choice, and a generic rule is instantiated once per distinct "
            "argument list. Instantiation is bounded and refuses to re-enter an identical "
            "instantiation, so a self-instantiating generic fails rather than running.",
            "CDDL has no include directive, so a grammar split across files composes as a "
            "*fileset*: the members are loaded together into one namespace. A reference that "
            "resolves in no member fails the import naming the missing rule, rather than being "
            "read as an open type — which would silently produce a smaller grammar than the "
            "author wrote.",
            "The `;` comment is CDDL's only documentation construct and binds to nothing. A "
            "comment block written directly above a rule becomes that rule's description, the "
            "same block separated by a blank line becomes the document's, and a comment sharing "
            "a line with a member becomes that member's. Anything else is left unattached "
            "rather than guessed at.",
        ],
    ),
    "cobolcopybook": _Seed(
        native_hierarchy=NativeHierarchy.NATIVE,
        native_hierarchy_note=(
            "Record → group → field → 88-level condition name, each carrying its level number, "
            "PICTURE, USAGE, OCCURS bounds, and the byte offset and length it occupies within "
            "the record."
        ),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.LINE_NUMBERS,
            note=(
                "Every definition carries the 1-based source line it was declared on, recovered "
                "by scanning the copybook and matched in traversal order, so a repeated FILLER "
                "resolves to its own line. A name that cannot be placed carries no line rather "
                "than a guessed one."
            ),
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note=(
                "A copybook is a record layout, not data: the analyzer observes no runtime "
                "values at any policy level. 'No value here' is the absence of data to observe, "
                "not a redaction."
            ),
        ),
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.PARTIAL,
            dropped_constructs=[
                "copybook.computed_storage_length",
                "copybook.condition_names_88",
                "copybook.level_numbers",
                "copybook.occurs_bounds",
                "copybook.occurs_depending_on",
                "copybook.picture_clauses",
                "copybook.redefines",
                "copybook.storage_offsets",
                "copybook.usage_clauses",
            ],
            note=(
                "The canonical model keeps a field's name and inferred type. Everything that "
                "makes a copybook a *layout* — levels, PICTURE, USAGE, OCCURS bounds, "
                "88-conditions, byte offsets, and the fact that two items share one span of "
                "storage — survives only in the analysis. A REDEFINES overlay normalizes to an "
                "ordinary sibling field; representing it as a union is #3991's."
            ),
        ),
        notes=[
            "Byte offsets and lengths are computed from PICTURE and USAGE under assumptions the "
            "copybook does not state — a single-byte encoding, packed decimal at two digits per "
            "byte plus a sign nibble, the common binary width table, an overpunched rather than "
            "separate sign, and no SYNCHRONIZED slack. Every record names them, so a length is "
            "read as conditional rather than observed.",
            "An item whose PICTURE cannot be sized has no length, and nothing after it has an "
            "offset. An item after a variable-length table has a range of offsets rather than an "
            "offset, and carries none — a minimum presented as the offset would be worse than "
            "no answer.",
            "Level-66 RENAMES and COPY ... REPLACING are not read by the parser. They are "
            "detected by scanning the source, and each one found makes the record partial with a "
            "stated reason rather than presenting a partial layout as a complete one.",
        ],
    ),
}


# ===========================================================================
# Derivation (the safe fallback every registered format is guaranteed)
# ===========================================================================

#: Construct-key suffixes that, when *supported*, upgrade a derived entry's source-location
#: quality above the path-only default. Kept as a rule rather than a per-format table so a
#: future native extractor that records lines or offsets is described correctly the day it
#: registers, without a registry edit.
_LOCATION_SUFFIXES: Tuple[Tuple[str, SourceLocationQuality], ...] = (
    (".byte_offsets", SourceLocationQuality.BYTE_OFFSETS),
    (".source_offsets", SourceLocationQuality.BYTE_OFFSETS),
    (".source_lines", SourceLocationQuality.LINE_NUMBERS),
    (".line_numbers", SourceLocationQuality.LINE_NUMBERS),
)


def _derive_source_location(capabilities: AnalyzerCapabilities) -> SourceLocationSupport:
    """Derive the source-location quality a format's analyzer can offer.

    Path-only is the floor, because every analyzer builds a structural path as it walks. It is
    raised only when the analyzer *declares* it models a stronger pointer — and a suffix listed
    in :data:`_LOCATION_SUFFIXES` under ``unsupported`` is a positive statement that it does
    not, so it can never raise the floor.

    Args:
        capabilities: The analyzer's own declaration.

    Returns:
        The derived :class:`SourceLocationSupport`.
    """
    supported = set(capabilities.supported)
    for suffix, quality in _LOCATION_SUFFIXES:
        if any(key.endswith(suffix) for key in supported):
            return SourceLocationSupport(
                quality=quality,
                note=(
                    "The analyzer declares it records this pointer kind; nodes carry it where "
                    "the construct could be placed."
                ),
            )
    return SourceLocationSupport(
        quality=SourceLocationQuality.PATH_ONLY,
        note=(
            "Nodes locate by structural path and sibling ordinal only. A UI can identify the "
            "construct but cannot point at a line or byte range in the raw source."
        ),
    )


def _derive_conversion(
    formats: Iterable[str], *, available: bool, preview_only: bool
) -> ConversionSupportEntry:
    """Derive whether a format reaches the canonical model, and by which route.

    The only two things that genuinely stop a conversion are an adapter that never persists
    (nothing to convert *from*) and a missing toolchain (nothing can be imported here). Every
    other registered adapter reaches the canonical model, because :meth:`ImportSource.normalize`
    is abstract and an item that failed it would not be in the catalog to convert.

    A declared format key without a registered normalizer is therefore *not* reported as a gap:
    ``formats`` mixes normalizer keys with detection aliases (``edix12`` declares ``x12`` and
    ``edi`` too), and several adapters — JSON Schema, JSON Type Definition — build the canonical
    model in-adapter with no separate normalizer at all. Calling either case "unconvertible"
    would be exactly the kind of false negative this registry exists to prevent.

    Args:
        formats: The adapter's declared format keys.
        available: Whether the adapter is runnable in this runtime.
        preview_only: Whether the adapter never persists (nothing to convert *from*).

    Returns:
        The derived :class:`ConversionSupportEntry`.
    """
    from .normalizer import get_normalizer

    declared = sorted({key for key in formats if key})
    canonical = [key for key in declared if get_normalizer(key) is not None]

    if preview_only:
        support = ConversionSupport.UNSUPPORTED
        note = (
            "This adapter accepts a document without persisting it, so there is no catalog "
            "revision to convert from."
        )
    elif not available:
        support = ConversionSupport.TOOL_UNAVAILABLE
        note = (
            "A toolchain this format requires is missing in this runtime, so no import — and "
            "therefore no conversion — can run here."
        )
    elif canonical:
        support = ConversionSupport.SUPPORTED
        note = (
            f"An import normalizes onto the canonical model through {', '.join(canonical)}, and "
            "from there reaches every export destination."
        )
    else:
        support = ConversionSupport.SUPPORTED
        note = (
            "The adapter builds the canonical model itself rather than through a separately "
            "registered normalizer, and from there reaches every export destination."
        )
    return ConversionSupportEntry(
        support=support,
        canonical_formats=canonical,
        normalizes_in_adapter=support == ConversionSupport.SUPPORTED and not canonical,
        declared_formats=declared,
        note=note,
    )


# Built per call rather than shared, so the caller's (already validated) key can be echoed into
# it. Every other field is constant: an unknown format is described by the absence of every
# claim, not by a guess.
def _unknown_format_capability(format_key: str) -> FormatCapability:
    """Build the truthful "no adapter is registered under this key" entry.

    A catalog item can name a source format whose adapter was later retired, or a caller can
    ask about a key that never existed. Both must resolve — a UI that cannot resolve a format
    falls back to "no details", which is the failure this registry exists to remove.

    Args:
        format_key: The (already validated) key that was asked about.

    Returns:
        An entry that claims nothing about the format.
    """
    return FormatCapability(
        format=format_key,
        label=format_key,
        paradigm=None,
        provenance=CapabilityProvenance.UNKNOWN_FORMAT,
        availability=FormatAvailability.UNREGISTERED,
        unavailable_reason="No import-source adapter is registered under this format key.",
        native_hierarchy=NativeHierarchy.NONE,
        native_hierarchy_note=(
            "No adapter is registered for this format, so no analysis tree is produced for it."
        ),
        analyzer=AnalyzerEvidence(key="none", version="0.0.0", tool_versions={}),
        source_location=SourceLocationSupport(
            quality=SourceLocationQuality.NONE,
            note="No analyzer runs for this format, so no node carries a source pointer.",
        ),
        value_visibility=ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.NONE,
            note="Nothing is observed for this format, so there is no value material to govern.",
        ),
        supported_constructs=[],
        unsupported_constructs=[],
        limits={},
        canonical_projection=CanonicalProjectionSupport(
            coverage=ProjectionCoverage.NONE,
            dropped_constructs=[],
            note="No adapter normalizes this format onto the canonical model.",
        ),
        conversion=ConversionSupportEntry(
            support=ConversionSupport.UNSUPPORTED,
            canonical_formats=[],
            normalizes_in_adapter=False,
            declared_formats=[],
            note="No adapter is registered, so this format has no conversion route.",
        ),
        # Not an empty coverage — an *undeclared* one. "Reads no versions" would be a claim about
        # the format; the honest answer for a key nothing is registered under is that the question
        # has no answer here.
        version_coverage=UNDECLARED_VERSION_COVERAGE,
        notes=[
            "This format key is not one apiome currently imports. Anything a catalog item of "
            "this format does not show is unknown, not absent.",
        ],
        registry_version=REGISTRY_VERSION,
        review_date=REVIEW_DATE,
    )


def _analyzer_capabilities_of(source: "ImportSource") -> AnalyzerCapabilities:
    """Read an adapter's capability declaration, degrading to an empty one if it raises.

    An adapter whose declaration blows up must not take the whole registry — and therefore
    every format's explanation — down with it. An empty declaration is the safe answer: it
    claims nothing is modelled and nothing is ruled out, so every construct resolves to
    :attr:`AbsenceCategory.UNDECLARED`.

    Args:
        source: The adapter instance.

    Returns:
        Its :class:`~app.payload_analysis.AnalyzerCapabilities`, or an empty one.
    """
    try:
        return source.analysis_capabilities()
    except Exception:  # pragma: no cover - defensive; no shipped adapter raises here
        logger.warning(
            "format capability registry: %r could not declare its analyzer capabilities",
            getattr(source, "key", "?"),
            exc_info=True,
        )
        return AnalyzerCapabilities()


def _analyzer_evidence_of(source: "ImportSource") -> AnalyzerEvidence:
    """Read an adapter's analyzer identity and tool versions, degrading if the probe raises.

    Tool versions are read from the live parser libraries, which is exactly why the probe is
    guarded: an import error inside a version lookup must cost the entry its *evidence*, not
    its existence.

    Args:
        source: The adapter instance.

    Returns:
        The :class:`AnalyzerEvidence` for this adapter.
    """
    try:
        tool_versions = dict(source.analyzer_tool_versions())
    except Exception:  # pragma: no cover - defensive; no shipped adapter raises here
        logger.warning(
            "format capability registry: %r could not report its analyzer tool versions",
            getattr(source, "key", "?"),
            exc_info=True,
        )
        tool_versions = {}
    return AnalyzerEvidence(
        key=source.analyzer_key,
        version=source.analyzer_version,
        tool_versions={str(name): str(value) for name, value in sorted(tool_versions.items())},
    )


def _derive_capability(source: "ImportSource") -> FormatCapability:
    """Build a format's entry from the live adapter, applying its reviewed seed when one exists.

    Everything the code knows — analyzer key/version, tool versions, the declared construct
    lists, the numeric limits, the normalizer routes, runtime availability — is read from the
    adapter on every call, so it cannot drift. A seed supplies only the reviewed judgements no
    derivation can make: what the native hierarchy actually is, how good the source pointers
    are, where the value ceiling sits, and what normalization drops.

    Args:
        source: The registered adapter instance.

    Returns:
        Its :class:`FormatCapability`.
    """
    descriptor = source.descriptor()
    capabilities = _analyzer_capabilities_of(source)
    seed = _CAPABILITY_SEED.get(descriptor.key)

    if source.preview_only:
        availability = FormatAvailability.PREVIEW_ONLY
        unavailable_reason = (
            "This adapter accepts a document for validation without persisting it, so no "
            "analysis is ever stored for it."
        )
    elif not descriptor.available:
        availability = FormatAvailability.TOOL_UNAVAILABLE
        unavailable_reason = descriptor.unavailable_reason
    else:
        availability = FormatAvailability.AVAILABLE
        unavailable_reason = None

    if seed is not None:
        native_hierarchy = seed.native_hierarchy
        native_hierarchy_note = seed.native_hierarchy_note
        source_location = seed.source_location
        value_visibility = seed.value_visibility
        canonical_projection = seed.canonical_projection
        notes = list(seed.notes)
    else:
        native = source.analyzer_key != GENERIC_ANALYZER_KEY
        native_hierarchy = NativeHierarchy.NATIVE if native else NativeHierarchy.GENERIC
        native_hierarchy_note = (
            "The analyzer emits its own format-specific node vocabulary; see the supported "
            "constructs below for what it names."
            if native
            else "The format-blind walk records containers, ordered collections and leaves. "
            "Nesting and ordering survive; this format's own semantics are not named, and "
            "their absence from the tree says nothing about the source."
        )
        source_location = _derive_source_location(capabilities)
        value_visibility = ValueVisibilitySupport(
            default=ValueVisibility.DEFAULT,
            maximum=ValueVisibility.FULL,
            note=(
                "Leaf values are observed, so the stored record carries whatever the "
                "value-visibility policy in force allows — the default keeps only presence and "
                "length."
            ),
        )
        canonical_projection = CanonicalProjectionSupport(
            coverage=ProjectionCoverage.UNKNOWN,
            dropped_constructs=[],
            note=(
                "This format's projection onto the canonical model has not been reviewed, so "
                "the registry makes no claim about what normalization keeps or drops."
            ),
        )
        notes = [
            "This entry is derived from the adapter's own declarations rather than reviewed, so "
            "it states only what the adapter states.",
        ]

    return FormatCapability(
        format=descriptor.key,
        label=descriptor.label,
        paradigm=descriptor.paradigm.value,
        provenance=(
            CapabilityProvenance.REVIEWED if seed is not None else CapabilityProvenance.DERIVED
        ),
        availability=availability,
        unavailable_reason=unavailable_reason,
        native_hierarchy=native_hierarchy,
        native_hierarchy_note=native_hierarchy_note,
        analyzer=_analyzer_evidence_of(source),
        source_location=source_location,
        value_visibility=value_visibility,
        supported_constructs=list(capabilities.supported),
        unsupported_constructs=list(capabilities.unsupported),
        limits=dict(capabilities.limits),
        canonical_projection=canonical_projection,
        conversion=_derive_conversion(
            descriptor.formats,
            available=descriptor.available,
            preview_only=source.preview_only,
        ),
        # Read from the FMT-3.8 declaration rather than from the adapter: ``descriptor.formats``
        # mixes version keys with detection aliases (``cobol``, ``apib``), so it cannot answer
        # "which versions?" on its own. An adapter with no declaration resolves to the undeclared
        # coverage instead of an invented one.
        version_coverage=version_coverage_for(descriptor.key),
        notes=notes,
        registry_version=REGISTRY_VERSION,
        review_date=REVIEW_DATE,
    )


# ===========================================================================
# Public resolution
# ===========================================================================


def is_valid_format_key(format_key: str) -> bool:
    """Return whether ``format_key`` has the shape of a registrable format key.

    Callers that accept a format key from a request validate it here first, so an arbitrary
    string is rejected at the boundary rather than echoed back inside a capability entry.

    Args:
        format_key: The candidate key.

    Returns:
        True when it matches :data:`FORMAT_KEY_PATTERN`.
    """
    return bool(FORMAT_KEY_PATTERN.match(format_key))


def capability_for(format_key: str) -> FormatCapability:
    """Return the capability entry for ``format_key`` — always, for any key.

    The guarantee the ticket's first acceptance criterion asks for: every catalog format
    resolves to a safe entry. A reviewed seed produces a ``reviewed`` entry, any other
    registered adapter produces a ``derived`` one read off the adapter itself, and an
    unregistered key produces an ``unknown_format`` entry that claims nothing. There is no
    input for which this returns nothing, because "the registry had no answer" is precisely
    the dead end that leaves a UI saying "no details".

    Args:
        format_key: The import-source key (aliases such as ``protobuf`` → ``grpc`` resolve).

    Returns:
        The format's :class:`FormatCapability`.
    """
    from .import_source import get_import_source

    normalized = (format_key or "").strip().lower()
    if not normalized or not is_valid_format_key(normalized):
        # Never echo an unvalidated string into an entry; a key that could not have been
        # registered is reported under a fixed placeholder instead.
        return _unknown_format_capability("unknown")
    source = get_import_source(normalized)
    if source is None:
        return _unknown_format_capability(normalized)
    return _derive_capability(source)


def format_capabilities() -> List[FormatCapability]:
    """Return one entry per registered import source, in key order.

    Returns:
        Every registered format's :class:`FormatCapability`, sorted by key.
    """
    from .import_source import available_import_sources

    return [capability_for(key) for key in available_import_sources()]


def registry_snapshot() -> FormatCapabilitySnapshot:
    """Build the deterministic, versioned snapshot of the whole registry (REST/UI contract).

    Pure and deterministic: the same adapter registry and the same seeds yield an identical
    snapshot, so the UI can fetch it once and cache it by
    :attr:`FormatCapabilitySnapshot.version`.

    Returns:
        The full :class:`FormatCapabilitySnapshot`.
    """
    return FormatCapabilitySnapshot(
        version=REGISTRY_VERSION,
        review_date=REVIEW_DATE,
        analysis_schema_version=PAYLOAD_ANALYSIS_SCHEMA_VERSION,
        absence_categories=sorted(category.value for category in AbsenceCategory),
        absences=absence_explanations(),
        reason_absence_categories={
            reason: REASON_ABSENCE_CATEGORIES[reason].value for reason in ANALYSIS_REASONS
        },
        formats=format_capabilities(),
    )
