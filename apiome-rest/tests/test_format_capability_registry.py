"""Unit + contract tests for the source-format capability & parsing-limit registry — CPDO-2.4 (#4796).

Pins the ticket's acceptance criteria:

* **every catalog format has a safe fallback entry** — every registered import source resolves
  to a complete entry, and so does a key no adapter is registered under, because a catalog item
  naming a retired adapter must still render an explanation rather than a dead end;
* **X12 and copybook boundaries are explicit** — both are reviewed seeds, both state what
  normalization drops, and the copybook's "no observed values at any policy" claim is checked
  against the analyzer that would have to produce them;
* **unparsed data is never reported as source-missing** — the load-bearing invariant. Exactly
  one absence category sets ``source_missing``, it is reachable only from the
  ``no_source_captured`` analysis reason, and no construct-level explanation can ever set it;
* **contract tests over registry changes** — the language-neutral vocabulary committed at
  ``scripts/format_capabilities/vocabulary.json`` is asserted field-for-field, so a change that
  lands in Python without its TypeScript mirror (or vice versa) turns a suite red.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_session_credentials
from app.cobolcopybook_analysis import analyze_cobolcopybook
from app.cobolcopybook_parser import parse_cobolcopybook
from app.format_capability_registry import (
    REASON_ABSENCE_CATEGORIES,
    REGISTRY_VERSION,
    REVIEW_DATE,
    AbsenceCategory,
    CapabilityProvenance,
    ConstructAvailability,
    ConversionSupport,
    FormatAvailability,
    FormatCapability,
    NativeHierarchy,
    ProjectionCoverage,
    SourceLocationQuality,
    VersionSupport,
    _derive_source_location,
    absence_explanation,
    absence_explanations,
    capability_for,
    explain_analysis_absence,
    explain_construct,
    format_capabilities,
    is_valid_format_key,
    registry_snapshot,
    render_absence,
)
from app.import_source import available_import_sources, get_import_source
from app.main import app
from app.payload_analysis import (
    ANALYSIS_REASONS,
    ANALYSIS_STATUSES,
    PAYLOAD_ANALYSIS_SCHEMA_VERSION,
    REASON_ANALYZER_FAILED,
    REASON_BOUNDS_EXCEEDED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_NOT_ANALYZED,
    REASON_UNSUPPORTED_FORMAT,
    STATUS_AVAILABLE,
    STATUS_FAILED,
    STATUS_PARTIAL,
    STATUS_UNAVAILABLE,
    ValueVisibility,
    analyzer_capabilities,
)

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

#: The committed language-neutral vocabulary both language mirrors are asserted against.
VOCABULARY_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "format_capabilities" / "vocabulary.json"
)


def _override_auth() -> Dict[str, Any]:
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = _override_auth
    yield
    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def vocabulary() -> Dict[str, Any]:
    """The committed vocabulary snapshot."""
    return json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def entries() -> List[FormatCapability]:
    """One capability entry per registered import source."""
    return format_capabilities()


# ---------------------------------------------------------------------------
# AC 1 — every catalog format has a safe fallback capability entry
# ---------------------------------------------------------------------------


def test_every_registered_format_has_an_entry(entries: List[FormatCapability]) -> None:
    assert [entry.format for entry in entries] == available_import_sources()
    assert entries, "the import-source registry is empty; the rest of this suite proves nothing"


def test_every_entry_is_complete_and_stamped(entries: List[FormatCapability]) -> None:
    """No entry may be a hollow placeholder — each carries the evidence backing its claims."""
    for entry in entries:
        assert entry.label, f"{entry.format} has no label"
        assert entry.paradigm, f"{entry.format} has no paradigm"
        assert entry.native_hierarchy_note.strip(), f"{entry.format} explains no hierarchy"
        assert entry.source_location.note.strip(), f"{entry.format} explains no source locations"
        assert entry.value_visibility.note.strip(), f"{entry.format} explains no value ceiling"
        assert entry.canonical_projection.note.strip(), f"{entry.format} explains no projection"
        assert entry.conversion.note.strip(), f"{entry.format} explains no conversion route"
        assert entry.analyzer.key, f"{entry.format} names no analyzer"
        assert entry.analyzer.version, f"{entry.format} names no analyzer version"
        assert entry.registry_version == REGISTRY_VERSION
        assert entry.review_date == REVIEW_DATE
        assert entry.notes, f"{entry.format} carries no reviewed note"


def test_entry_analyzer_evidence_matches_the_live_adapter(entries: List[FormatCapability]) -> None:
    """Analyzer identity is read off the adapter on every call, so it cannot go stale."""
    for entry in entries:
        source = get_import_source(entry.format)
        assert source is not None
        assert entry.analyzer.key == source.analyzer_key
        assert entry.analyzer.version == source.analyzer_version
        assert entry.analyzer.tool_versions == {
            str(k): str(v) for k, v in source.analyzer_tool_versions().items()
        }
        declared = source.analysis_capabilities()
        assert entry.supported_constructs == list(declared.supported)
        assert entry.unsupported_constructs == list(declared.unsupported)
        assert entry.limits == dict(declared.limits)


def test_derived_entries_make_no_projection_claim(entries: List[FormatCapability]) -> None:
    """The fallback is *safe*: an unreviewed format claims nothing about normalization."""
    for entry in entries:
        if entry.provenance is CapabilityProvenance.DERIVED:
            assert entry.canonical_projection.coverage is ProjectionCoverage.UNKNOWN
            assert entry.canonical_projection.dropped_constructs == []


def test_generic_analyzer_entries_are_reported_as_generic(entries: List[FormatCapability]) -> None:
    for entry in entries:
        if entry.provenance is CapabilityProvenance.DERIVED:
            expected = (
                NativeHierarchy.GENERIC
                if entry.analyzer.key == "generic"
                else NativeHierarchy.NATIVE
            )
            assert entry.native_hierarchy is expected, entry.format


def test_unknown_format_key_resolves_to_an_entry_that_claims_nothing() -> None:
    entry = capability_for("some-retired-adapter")
    assert entry.format == "some-retired-adapter"
    assert entry.provenance is CapabilityProvenance.UNKNOWN_FORMAT
    assert entry.availability is FormatAvailability.UNREGISTERED
    assert entry.native_hierarchy is NativeHierarchy.NONE
    assert entry.source_location.quality is SourceLocationQuality.NONE
    assert entry.canonical_projection.coverage is ProjectionCoverage.NONE
    assert entry.conversion.support is ConversionSupport.UNSUPPORTED
    assert entry.supported_constructs == []
    assert entry.unsupported_constructs == []


@pytest.mark.parametrize(
    "key",
    ["", "   ", "has space", "semi;colon", "../../etc/passwd", "x" * 65, "-leading"],
)
def test_a_key_that_could_never_be_registered_is_not_echoed_back(key: str) -> None:
    """An arbitrary string never reaches the entry — it resolves under a fixed placeholder."""
    assert is_valid_format_key(key.strip().lower()) is False
    entry = capability_for(key)
    assert entry.format == "unknown"
    assert entry.provenance is CapabilityProvenance.UNKNOWN_FORMAT


def test_alias_keys_resolve_to_their_adapter() -> None:
    assert capability_for("protobuf").format == "grpc"


def test_keys_resolve_case_insensitively_and_ignore_surrounding_space() -> None:
    """Matches the import-source registry, which lowercases a ``source_kind`` before lookup."""
    assert capability_for("  EDIX12 ").format == "edix12"
    assert capability_for("EdiX12").provenance is CapabilityProvenance.REVIEWED


def test_preview_only_adapter_is_reported_as_never_stored() -> None:
    entry = capability_for("sample")
    assert entry.availability is FormatAvailability.PREVIEW_ONLY
    assert entry.unavailable_reason
    assert entry.conversion.support is ConversionSupport.UNSUPPORTED


def test_conversion_support_never_reports_an_in_adapter_normalizer_as_a_gap(
    entries: List[FormatCapability],
) -> None:
    """JSON Schema and JTD build the canonical model themselves — that is a route, not a gap."""
    by_key = {entry.format: entry for entry in entries}
    for key in ("json-schema", "jtd"):
        entry = by_key[key]
        assert entry.conversion.support is ConversionSupport.SUPPORTED
        assert entry.conversion.canonical_formats == []
        assert entry.conversion.normalizes_in_adapter is True
        assert entry.conversion.declared_formats


def test_conversion_declares_every_format_key_the_adapter_declares() -> None:
    entry = capability_for("edix12")
    source = get_import_source("edix12")
    assert source is not None
    assert entry.conversion.declared_formats == sorted(source.formats)
    # ``x12`` / ``edi`` are detection aliases with no normalizer of their own; the entry lists
    # them without implying a document matching one of them is unconvertible.
    assert entry.conversion.canonical_formats == ["edix12"]
    assert entry.conversion.normalizes_in_adapter is False
    assert entry.conversion.support is ConversionSupport.SUPPORTED


@pytest.mark.parametrize(
    ("supported", "expected"),
    [
        ([], SourceLocationQuality.PATH_ONLY),
        (["fmt.object", "fmt.scalar"], SourceLocationQuality.PATH_ONLY),
        (["fmt.source_lines"], SourceLocationQuality.LINE_NUMBERS),
        (["fmt.line_numbers"], SourceLocationQuality.LINE_NUMBERS),
        (["fmt.byte_offsets"], SourceLocationQuality.BYTE_OFFSETS),
        (["fmt.source_offsets"], SourceLocationQuality.BYTE_OFFSETS),
        # Strongest declaration wins, whatever order the analyzer listed them in.
        (["fmt.source_lines", "fmt.byte_offsets"], SourceLocationQuality.BYTE_OFFSETS),
    ],
)
def test_derived_source_location_reads_the_analyzers_own_declaration(
    supported: List[str], expected: SourceLocationQuality
) -> None:
    """The rule that keeps a *future* native extractor described correctly with no registry edit."""
    derived = _derive_source_location(analyzer_capabilities(supported=supported))
    assert derived.quality is expected
    assert derived.note.strip()


def test_derived_source_location_is_never_raised_by_an_unsupported_declaration() -> None:
    """Declaring a pointer kind *unsupported* is a statement it is absent, not present."""
    declared = analyzer_capabilities(
        supported=["fmt.object"], unsupported=["fmt.byte_offsets", "fmt.source_lines"]
    )
    assert _derive_source_location(declared).quality is SourceLocationQuality.PATH_ONLY


def test_unavailable_toolchain_is_stated_rather_than_hidden(
    entries: List[FormatCapability],
) -> None:
    for entry in entries:
        if entry.availability is FormatAvailability.TOOL_UNAVAILABLE:
            assert entry.unavailable_reason
            assert entry.conversion.support is ConversionSupport.TOOL_UNAVAILABLE
        elif entry.availability is FormatAvailability.AVAILABLE:
            assert entry.unavailable_reason is None


# ---------------------------------------------------------------------------
# AC 2 — X12 and copybook boundaries are explicit
# ---------------------------------------------------------------------------


def test_x12_and_copybook_are_reviewed_not_derived() -> None:
    for key in ("edix12", "cobolcopybook"):
        entry = capability_for(key)
        assert entry.provenance is CapabilityProvenance.REVIEWED, key
        assert entry.native_hierarchy is NativeHierarchy.NATIVE, key
        assert entry.canonical_projection.coverage is ProjectionCoverage.PARTIAL, key
        assert entry.canonical_projection.dropped_constructs, key
        assert len(entry.notes) >= 3, key


def test_x12_states_its_envelope_and_grammar_boundaries() -> None:
    entry = capability_for("edix12")
    assert "x12.interchange_envelope" in entry.supported_constructs
    assert "x12.functional_group" in entry.supported_constructs
    # The grammar the extractor knowingly does not read. HL nesting and implementation-guide
    # conformance are boundaries of the analyzer itself, not of any one source.
    for construct in (
        "x12.hl_hierarchy",
        "x12.ta1_acknowledgement",
        "x12.iea_trailer",
        "x12.implementation_guide_validation",
    ):
        assert construct in entry.unsupported_constructs, construct
    # CPDO-2.2: the interchange text is scanned and matched to the parse, so a construct carries
    # the exact bytes it was read from — and empty positions and repetitions become readable with it.
    assert entry.source_location.quality is SourceLocationQuality.BYTE_OFFSETS
    for construct in (
        "x12.byte_offsets",
        "x12.empty_elements",
        "x12.repeating_elements",
        "x12.envelope_control_totals",
        "x12.segment_repeat_counts",
    ):
        assert construct in entry.supported_constructs, construct
    # The envelope survives only in the analysis: normalization reads one transaction set.
    for construct in (
        "x12.functional_group",
        "x12.interchange_envelope",
        "x12.empty_elements",
        "x12.segment_repeat_counts",
    ):
        assert construct in entry.canonical_projection.dropped_constructs, construct


def test_x12_never_claims_a_construct_it_both_models_and_does_not() -> None:
    """The two lists are disjoint. CPDO-2.2 moved four constructs across, and a stale entry left in
    both would make the panel say a construct is modelled and unmodelled on the same screen."""
    entry = capability_for("edix12")
    assert not set(entry.supported_constructs) & set(entry.unsupported_constructs)


def test_copybook_states_its_layout_and_clause_boundaries() -> None:
    entry = capability_for("cobolcopybook")
    for construct in (
        "copybook.level_numbers",
        "copybook.picture_clauses",
        "copybook.occurs_bounds",
        "copybook.condition_names_88",
        "copybook.source_lines",
    ):
        assert construct in entry.supported_constructs, construct
    # CPDO-2.3: REDEFINES is parsed and laid out, and storage is computed from PICTURE/USAGE.
    for construct in (
        "copybook.redefines",
        "copybook.computed_storage_length",
        "copybook.storage_offsets",
        "copybook.variable_length_records",
    ):
        assert construct in entry.supported_constructs, construct
    # The grammar the parser still does not read, and the encoding a length only ever assumes.
    for construct in (
        "copybook.renames_66",
        "copybook.copy_replacing",
        "copybook.character_encoding_detection",
    ):
        assert construct in entry.unsupported_constructs, construct
    assert entry.source_location.quality is SourceLocationQuality.LINE_NUMBERS
    # The layout semantics survive only in the analysis — offsets and overlays included.
    for construct in (
        "copybook.picture_clauses",
        "copybook.storage_offsets",
        "copybook.redefines",
    ):
        assert construct in entry.canonical_projection.dropped_constructs, construct


def test_copybook_never_claims_a_construct_it_both_models_and_does_not() -> None:
    """CPDO-2.3 moved five constructs across; one left in both lists would make the panel say a
    construct is modelled and unmodelled on the same screen."""
    entry = capability_for("cobolcopybook")
    assert not set(entry.supported_constructs) & set(entry.unsupported_constructs)


def test_copybook_states_the_assumptions_its_computed_lengths_rest_on() -> None:
    """A byte count is only true under an encoding and a representation the copybook never states,
    so the registry says so before a reader ever opens a record."""
    notes = " ".join(capability_for("cobolcopybook").notes).lower()

    assert "single-byte" in notes
    assert "synchronized" in notes
    assert "variable-length table" in notes


def test_copybook_value_ceiling_matches_what_its_analyzer_can_produce() -> None:
    """The 'no observed values at any policy' claim is checked against the analyzer itself.

    A registry claim about value visibility is only worth making if it is true of the code that
    would have to produce the values — otherwise a UI would show "value withheld" for a format
    that has no values to withhold.
    """
    entry = capability_for("cobolcopybook")
    assert entry.value_visibility.maximum == ValueVisibility.NONE
    assert entry.value_visibility.default == ValueVisibility.DEFAULT

    copybook = "\n".join(
        [
            "       01  CUSTOMER-RECORD.",
            "           05  CUST-ID          PIC 9(6).",
            "           05  CUST-NAME        PIC X(30).",
            "           05  CUST-STATUS      PIC X.",
            "               88  STATUS-ACTIVE  VALUE 'A'.",
            "           05  CUST-ORDERS      OCCURS 5 TIMES PIC 9(4).",
        ]
    )
    document = analyze_cobolcopybook(
        parse_cobolcopybook(copybook), source=copybook, source_format="cobolcopybook"
    )

    def walk(nodes):
        for node in nodes:
            yield node
            yield from walk(node.children)

    observed = list(walk(document.tree))
    assert observed, "the fixture produced no nodes; the claim below would be vacuous"
    assert all(node.value is None for node in observed)
    assert all(node.value_present is None for node in observed)


def test_x12_value_ceiling_matches_what_its_analyzer_can_produce() -> None:
    """The mirror check: X12 element values *are* observed, so the ceiling is not 'none'."""
    entry = capability_for("edix12")
    assert entry.value_visibility.maximum == ValueVisibility.FULL
    assert entry.value_visibility.default == ValueVisibility.DEFAULT


# ---------------------------------------------------------------------------
# AC 3 — the UI never reports unparsed data as source-missing
# ---------------------------------------------------------------------------


def test_exactly_one_absence_category_means_the_source_is_missing() -> None:
    flagged = [e.category for e in absence_explanations() if e.source_missing]
    assert flagged == [AbsenceCategory.SOURCE_MISSING]


def test_every_absence_category_has_reviewed_wording() -> None:
    explanations = absence_explanations()
    assert [e.category for e in explanations] == list(AbsenceCategory)
    for explanation in explanations:
        assert explanation.category_label.strip()
        assert "{construct}" in explanation.summary_template
        assert explanation.remediation.strip()


def test_every_analysis_reason_maps_to_a_category() -> None:
    assert set(REASON_ABSENCE_CATEGORIES) == set(ANALYSIS_REASONS)


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        (REASON_NOT_ANALYZED, AbsenceCategory.NOT_ANALYZED),
        (REASON_NO_SOURCE_CAPTURED, AbsenceCategory.SOURCE_MISSING),
        (REASON_UNSUPPORTED_FORMAT, AbsenceCategory.FORMAT_UNSUPPORTED),
        (REASON_BOUNDS_EXCEEDED, AbsenceCategory.PARSE_LIMIT),
        (REASON_ANALYZER_FAILED, AbsenceCategory.ANALYZER_FAILED),
    ],
)
def test_analysis_reason_resolves_to_its_reviewed_category(
    reason: str, expected: AbsenceCategory
) -> None:
    explanation = explain_analysis_absence(status=STATUS_UNAVAILABLE, reason=reason)
    assert explanation is not None
    assert explanation.category is expected
    assert explanation.source_missing is (expected is AbsenceCategory.SOURCE_MISSING)


def test_only_a_missing_source_is_reported_as_a_missing_source() -> None:
    """The ticket's central invariant, over every status × reason the store can hold."""
    for status in ANALYSIS_STATUSES:
        for reason in (None, *ANALYSIS_REASONS):
            explanation = explain_analysis_absence(status=status, reason=reason)
            if explanation is None:
                assert status == STATUS_AVAILABLE and reason is None
                continue
            assert explanation.source_missing is (reason == REASON_NO_SOURCE_CAPTURED), (
                f"{status}/{reason} claimed source_missing={explanation.source_missing}"
            )


def test_a_bounded_partial_analysis_is_a_parser_limit_not_a_missing_source() -> None:
    explanation = explain_analysis_absence(status=STATUS_PARTIAL, reason=REASON_BOUNDS_EXCEEDED)
    assert explanation is not None
    assert explanation.category is AbsenceCategory.PARSE_LIMIT
    assert explanation.source_missing is False
    assert "source may well contain it" in render_absence(explanation, "x12.segment")


def test_an_analyzer_failure_is_not_a_missing_source() -> None:
    explanation = explain_analysis_absence(status=STATUS_FAILED, reason=REASON_ANALYZER_FAILED)
    assert explanation is not None
    assert explanation.source_missing is False


def test_an_available_analysis_has_no_absence_to_explain() -> None:
    assert explain_analysis_absence(status=STATUS_AVAILABLE, reason=None) is None


def test_an_unrecognised_reason_code_claims_nothing_about_the_source() -> None:
    explanation = explain_analysis_absence(status=STATUS_UNAVAILABLE, reason="reason_from_the_future")
    assert explanation is not None
    assert explanation.category is AbsenceCategory.NOT_ANALYZED
    assert explanation.source_missing is False


def test_a_non_available_status_without_a_reason_claims_nothing_about_the_source() -> None:
    explanation = explain_analysis_absence(status=STATUS_UNAVAILABLE, reason=None)
    assert explanation is not None
    assert explanation.source_missing is False


def test_an_unmodelled_construct_is_a_parser_limit() -> None:
    explanation = explain_construct("edix12", "x12.hl_hierarchy")
    assert explanation.availability is ConstructAvailability.UNMODELLED
    assert explanation.category is AbsenceCategory.PARSE_LIMIT
    assert explanation.source_missing is False
    assert "`x12.hl_hierarchy`" in explanation.summary


def test_a_modelled_construct_that_is_absent_is_absent_from_the_source() -> None:
    explanation = explain_construct("edix12", "x12.functional_group")
    assert explanation.availability is ConstructAvailability.MODELLED
    assert explanation.category is AbsenceCategory.ABSENT_IN_SOURCE
    assert explanation.source_missing is False


def test_an_undeclared_construct_yields_no_claim_in_either_direction() -> None:
    explanation = explain_construct("edix12", "x12.something_nobody_declared")
    assert explanation.availability is ConstructAvailability.UNDECLARED
    assert explanation.category is AbsenceCategory.UNDECLARED
    assert explanation.source_missing is False


def test_no_construct_explanation_can_ever_claim_the_source_is_missing(
    entries: List[FormatCapability],
) -> None:
    """Exhaustive over every construct every registered analyzer declares, either way."""
    checked = 0
    for entry in entries:
        for construct in (*entry.supported_constructs, *entry.unsupported_constructs):
            explanation = explain_construct(entry.format, construct)
            assert explanation.source_missing is False
            assert explanation.category is not AbsenceCategory.SOURCE_MISSING
            checked += 1
    assert checked > 0, "no analyzer declared a construct; this assertion proves nothing"


def test_construct_explanation_for_an_unknown_format_says_so() -> None:
    explanation = explain_construct("some-retired-adapter", "anything.at.all")
    assert explanation.availability is ConstructAvailability.UNDECLARED
    assert explanation.source_missing is False


def test_render_absence_reads_without_a_construct() -> None:
    explanation = absence_explanation(AbsenceCategory.PARSE_LIMIT)
    assert "{construct}" not in render_absence(explanation)
    assert "this detail" in render_absence(explanation)


# ---------------------------------------------------------------------------
# AC 4 — registry changes have contract tests
# ---------------------------------------------------------------------------


def test_vocabulary_snapshot_matches_the_python_registry(vocabulary: Dict[str, Any]) -> None:
    """The committed snapshot is the contract both language mirrors are held to."""
    assert vocabulary["registry_version"] == REGISTRY_VERSION
    assert vocabulary["review_date"] == REVIEW_DATE
    assert vocabulary["analysis_schema_version"] == PAYLOAD_ANALYSIS_SCHEMA_VERSION

    vocabularies = vocabulary["vocabularies"]
    assert vocabularies["capability_provenance"] == [m.value for m in CapabilityProvenance]
    assert vocabularies["format_availability"] == [m.value for m in FormatAvailability]
    assert vocabularies["native_hierarchy"] == [m.value for m in NativeHierarchy]
    assert vocabularies["source_location_quality"] == [m.value for m in SourceLocationQuality]
    assert vocabularies["projection_coverage"] == [m.value for m in ProjectionCoverage]
    assert vocabularies["conversion_support"] == [m.value for m in ConversionSupport]
    assert vocabularies["version_support"] == [m.value for m in VersionSupport]
    assert vocabularies["absence_category"] == [m.value for m in AbsenceCategory]
    assert vocabularies["construct_availability"] == [m.value for m in ConstructAvailability]
    assert vocabularies["analysis_reason"] == list(ANALYSIS_REASONS)

    assert vocabulary["reason_absence_categories"] == {
        reason: REASON_ABSENCE_CATEGORIES[reason].value for reason in ANALYSIS_REASONS
    }
    assert vocabulary["absences"] == [
        {
            "category": e.category.value,
            "category_label": e.category_label,
            "summary_template": e.summary_template,
            "remediation": e.remediation,
            "source_missing": e.source_missing,
        }
        for e in absence_explanations()
    ]


def test_vocabulary_snapshot_keeps_exactly_one_source_missing_row(
    vocabulary: Dict[str, Any],
) -> None:
    """Guards the snapshot itself, not just the registry that was dumped into it."""
    flagged = [row["category"] for row in vocabulary["absences"] if row["source_missing"]]
    assert flagged == [AbsenceCategory.SOURCE_MISSING.value]


def test_registry_snapshot_is_deterministic() -> None:
    assert registry_snapshot().model_dump_json() == registry_snapshot().model_dump_json()


def test_registry_snapshot_carries_the_whole_contract() -> None:
    snapshot = registry_snapshot()
    assert snapshot.version == REGISTRY_VERSION
    assert snapshot.review_date == REVIEW_DATE
    assert snapshot.analysis_schema_version == PAYLOAD_ANALYSIS_SCHEMA_VERSION
    assert snapshot.absence_categories == sorted(c.value for c in AbsenceCategory)
    assert [e.category for e in snapshot.absences] == list(AbsenceCategory)
    assert set(snapshot.reason_absence_categories) == set(ANALYSIS_REASONS)
    assert [f.format for f in snapshot.formats] == available_import_sources()


# ---------------------------------------------------------------------------
# REST contract
# ---------------------------------------------------------------------------


def test_get_registry_returns_the_snapshot() -> None:
    response = client.get("/v1/import/format-capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == REGISTRY_VERSION
    assert body["analysis_schema_version"] == PAYLOAD_ANALYSIS_SCHEMA_VERSION
    assert [f["format"] for f in body["formats"]] == available_import_sources()
    assert [a["category"] for a in body["absences"]] == [c.value for c in AbsenceCategory]
    assert sum(1 for a in body["absences"] if a["source_missing"]) == 1


def test_get_registry_exposes_tool_version_evidence() -> None:
    response = client.get("/v1/import/format-capabilities")
    by_key = {f["format"]: f for f in response.json()["formats"]}
    x12 = by_key["edix12"]
    assert x12["analyzer"]["key"] == "edix12"
    assert x12["analyzer"]["version"]
    assert "pyx12" in x12["analyzer"]["tool_versions"]


def test_get_one_format_returns_its_entry() -> None:
    response = client.get("/v1/import/format-capabilities/cobolcopybook")
    assert response.status_code == 200
    body = response.json()
    assert body["format"] == "cobolcopybook"
    assert body["provenance"] == "reviewed"
    assert body["source_location"]["quality"] == "line_numbers"
    assert body["value_visibility"]["maximum"] == "none"


def test_get_one_format_resolves_a_retired_adapter_rather_than_404ing() -> None:
    response = client.get("/v1/import/format-capabilities/retired-format")
    assert response.status_code == 200
    body = response.json()
    assert body["provenance"] == "unknown_format"
    assert body["availability"] == "unregistered"


@pytest.mark.parametrize("key", ["has%20space", "semi;colon", "x" * 65, "-leading"])
def test_get_one_format_rejects_a_key_that_could_never_be_registered(key: str) -> None:
    response = client.get(f"/v1/import/format-capabilities/{key}")
    assert response.status_code == 422


def test_get_one_format_is_case_insensitive() -> None:
    response = client.get("/v1/import/format-capabilities/EDIX12")
    assert response.status_code == 200
    assert response.json()["format"] == "edix12"


def test_registry_requires_authentication() -> None:
    app.dependency_overrides.clear()
    response = client.get("/v1/import/format-capabilities")
    assert response.status_code in (401, 403)
