"""Corpus parity gate — FMT-1.4 (#5415).

Enumerates the live import-source and emitter registries and fails when a registered adapter is
missing any of the four artifacts a shipped format must carry: corpus examples (at least one
``valid`` and one ``negative``), a golden snapshot directory, a round-trip matrix row, and a
``format_capability_registry`` entry.

Two suites live here:

* **The gate.** One parametrized test per requirement, so a failure names the format and the
  artifact rather than dumping a matrix. Plus the waiver hygiene tests that keep
  :mod:`tests.corpus_parity_waivers` from rotting into a list of permanently-excused formats, and
  the drift check on the committed coverage report.
* **The engine.** Unit tests that drive :func:`corpus_parity.evaluate_format` with synthetic
  corpora, so "this gate would catch a missing golden" is proven directly instead of being
  inferred from the fact that today's repository happens to pass.

Regenerate the report with ``pytest tests/test_corpus_parity.py --update-corpus-parity``
(or ``UPDATE_CORPUS_PARITY=1``, or the standalone
``uv run python scripts/generate_corpus_parity_report.py``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import pytest
from corpus_loader import CorpusEntry, ExpectedDetection, ExpectedOutcome, Rung, ValidityClass
from corpus_parity import (
    ARTIFACT_PATH,
    MARKDOWN_PATH,
    REGENERATE_COMMAND,
    REPORT_VERSION,
    FormatParity,
    ParityReport,
    ParityRequirement,
    RequirementStatus,
    build_report,
    corpus_directory,
    evaluate_format,
    gap_summary,
    load_matrix,
    load_report,
    render_markdown,
    updating_report,
    write_report,
)
from corpus_parity_waivers import KNOWN_EXPORT_ONLY_DESTINATIONS, KNOWN_PARITY_WAIVERS

from app.emitter import load_builtin_emitters
from app.format_capability_registry import CapabilityProvenance
from app.import_source import available_import_sources, load_builtin_import_sources
from app.roundtrip_matrix import MatrixCellResult, MatrixCellStatus, RoundTripMatrix
from app.supported_formats_doc import shipped_emitters

load_builtin_import_sources()
load_builtin_emitters()

#: The whole report, built once: it reads the manifest, walks the golden store, and parses the
#: matrix artifact, none of which changes between tests in this module.
_REPORT = build_report()

#: The gated formats, in registry-key order, for parametrization.
_FORMATS: List[FormatParity] = list(_REPORT.formats)

#: Minimum characters a waiver reason must carry. A waiver is a review decision; "TODO" is not one.
MIN_WAIVER_REASON_LENGTH = 30

#: Monorepo root — the contributor guide and the CI workflow this gate is wired into live outside
#: ``apiome-rest/``, and both are acceptance criteria of #5415 rather than incidental prose.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_CONTRIBUTOR_GUIDE = _REPO_ROOT / "docs" / "CORPUS_CONTRIBUTOR_GUIDE.md"
_CI_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "apiome-rest-test.yml"


def _ids(entries: Sequence[FormatParity]) -> List[str]:
    return [entry.format_key for entry in entries]


def _fixes(requirement: ParityRequirement) -> str:
    """The one-line remediation quoted in a gate failure."""
    return {
        ParityRequirement.VALID_EXAMPLES: (
            "add valid fixtures under apiome-ui/examples/<format>/ and list them in "
            "corpus.manifest.json (see docs/CORPUS_CONTRIBUTOR_GUIDE.md §6)"
        ),
        ParityRequirement.NEGATIVE_EXAMPLES: (
            "add negative fixtures under apiome-ui/examples/<format>/negative/ with a "
            "failure_class and an expected_error_code"
        ),
        ParityRequirement.GOLDEN_SNAPSHOTS: (
            "run `uv run pytest tests/test_corpus_golden.py --update-golden` and review the "
            "generated snapshots"
        ),
        ParityRequirement.ROUNDTRIP_MATRIX: (
            "run `UPDATE_ROUNDTRIP_MATRIX=1 uv run pytest tests/test_roundtrip_matrix.py`, and "
            "record any failing cell in tests/roundtrip_xfails.py with a reason"
        ),
        ParityRequirement.CAPABILITY_ENTRY: (
            "register the adapter under the key format_capability_registry.capability_for() is "
            "asked for, or add a reviewed seed for it"
        ),
    }[requirement]


def _assert_requirement(entry: FormatParity, requirement: ParityRequirement) -> None:
    """Fail with a format-named, actionable message when ``requirement`` is unmet."""
    status = entry.requirements[requirement]
    if status is RequirementStatus.SATISFIED:
        return
    if status is RequirementStatus.WAIVED:
        # An explicit, reasoned xfail — the ticket's alternative to silence. It stays honest
        # because `test_no_parity_waiver_is_obsolete` fails once the artifact does exist.
        pytest.xfail(f"waived in KNOWN_PARITY_WAIVERS: {entry.waivers[requirement]}")
    detail = next(
        (line for line in gap_summary(_REPORT) if line.startswith(f"{entry.format_key}: {requirement.value}")),
        f"{entry.format_key}: {requirement.value}",
    )
    pytest.fail(
        f"{detail}\n"
        f"Fix: {_fixes(requirement)}\n"
        f"If the artifact genuinely cannot exist, add "
        f"(\"{entry.format_key}\", \"{requirement.value}\") to KNOWN_PARITY_WAIVERS with a reason."
    )


# ---------------------------------------------------------------------------
# The gate: every registered adapter carries every required artifact
# ---------------------------------------------------------------------------


def test_the_registry_has_formats_to_gate() -> None:
    """A gate that silently gates nothing is the failure mode this ticket exists to end."""
    assert _FORMATS, "no shipped, non-preview import adapters were found to gate"
    assert len(_FORMATS) == len(
        {entry.format_key for entry in _FORMATS}
    ), "the report lists a format twice"


@pytest.mark.parametrize("entry", _FORMATS, ids=_ids(_FORMATS))
def test_registered_adapter_has_valid_examples(entry: FormatParity) -> None:
    _assert_requirement(entry, ParityRequirement.VALID_EXAMPLES)


@pytest.mark.parametrize("entry", _FORMATS, ids=_ids(_FORMATS))
def test_registered_adapter_has_negative_examples(entry: FormatParity) -> None:
    _assert_requirement(entry, ParityRequirement.NEGATIVE_EXAMPLES)


@pytest.mark.parametrize("entry", _FORMATS, ids=_ids(_FORMATS))
def test_registered_adapter_has_golden_snapshots(entry: FormatParity) -> None:
    _assert_requirement(entry, ParityRequirement.GOLDEN_SNAPSHOTS)


@pytest.mark.parametrize("entry", _FORMATS, ids=_ids(_FORMATS))
def test_registered_adapter_has_a_roundtrip_matrix_row(entry: FormatParity) -> None:
    _assert_requirement(entry, ParityRequirement.ROUNDTRIP_MATRIX)


@pytest.mark.parametrize("entry", _FORMATS, ids=_ids(_FORMATS))
def test_registered_adapter_has_a_capability_entry(entry: FormatParity) -> None:
    _assert_requirement(entry, ParityRequirement.CAPABILITY_ENTRY)


def test_no_registered_adapter_has_an_unwaived_gap() -> None:
    """The aggregate view: one failure listing every gap at once."""
    gaps = gap_summary(_REPORT)
    assert not gaps, (
        f"{len(gaps)} corpus parity gap(s). Close them, or record a reasoned waiver in "
        f"tests/corpus_parity_waivers.py:\n  " + "\n  ".join(gaps)
    )


def test_every_gated_format_is_a_registered_adapter() -> None:
    """The report describes the live registry, not a hand-maintained list."""
    registered = set(available_import_sources())
    assert {entry.format_key for entry in _FORMATS} <= registered


def test_every_shipped_emitter_has_an_import_adapter() -> None:
    """An export-only destination cannot be covered by the import corpus — say so on purpose."""
    assert not _REPORT.export_only_destinations, (
        "shipped emitter(s) with no import adapter behind them: "
        f"{list(_REPORT.export_only_destinations)}. Register an adapter, or record the key in "
        "KNOWN_EXPORT_ONLY_DESTINATIONS with the reason no corpus can cover it."
    )


def test_only_internal_and_preview_formats_are_exempt() -> None:
    """Nothing drops out of the gate without a stated reason."""
    for excluded in _REPORT.excluded_formats:
        assert excluded.reason.strip(), f"{excluded.format_key} is exempt with no reason"
    assert {excluded.format_key for excluded in _REPORT.excluded_formats} == {"sample"}, (
        "the set of ungated registry keys changed: "
        f"{[excluded.format_key for excluded in _REPORT.excluded_formats]}. A new exemption is a "
        "review decision — confirm it is internal machinery or a preview adapter."
    )


# ---------------------------------------------------------------------------
# Waiver hygiene: a waiver is named, reasoned, and deleted when it stops being true
# ---------------------------------------------------------------------------


def test_every_waiver_names_a_gated_format_and_a_known_requirement() -> None:
    gated = {entry.format_key for entry in _FORMATS}
    known = {requirement.value for requirement in ParityRequirement}
    problems: List[str] = []
    for (format_key, requirement), reason in sorted(KNOWN_PARITY_WAIVERS.items()):
        if format_key not in gated:
            problems.append(f"{format_key!r} is not a gated format")
        if requirement not in known:
            problems.append(f"{requirement!r} is not a ParityRequirement value")
        if len(reason.strip()) < MIN_WAIVER_REASON_LENGTH:
            problems.append(f"({format_key}, {requirement}) has no substantive reason")
    assert not problems, "invalid parity waiver(s):\n  " + "\n  ".join(problems)


def test_no_parity_waiver_is_obsolete() -> None:
    """Strict: a waived requirement that is now satisfied must have its waiver deleted."""
    by_key = _REPORT.format_map()
    obsolete = [
        f"({format_key}, {requirement}) — the artifact now exists; delete the waiver"
        for (format_key, requirement) in sorted(KNOWN_PARITY_WAIVERS)
        if format_key in by_key
        and by_key[format_key].requirements.get(ParityRequirement(requirement))
        is RequirementStatus.SATISFIED
    ]
    assert not obsolete, "obsolete parity waiver(s):\n  " + "\n  ".join(obsolete)


def test_no_export_only_waiver_is_obsolete() -> None:
    """Strict: an emitter that gained an import adapter must leave the export-only map."""
    registered = set(available_import_sources())
    obsolete = sorted(key for key in KNOWN_EXPORT_ONLY_DESTINATIONS if key in registered)
    assert not obsolete, (
        "these emitter key(s) now have an import adapter; delete them from "
        f"KNOWN_EXPORT_ONLY_DESTINATIONS: {obsolete}"
    )


def test_export_only_waivers_name_a_shipped_emitter() -> None:
    emitters = set(shipped_emitters())
    unknown = sorted(key for key in KNOWN_EXPORT_ONLY_DESTINATIONS if key not in emitters)
    assert not unknown, f"KNOWN_EXPORT_ONLY_DESTINATIONS names non-emitter key(s): {unknown}"


# ---------------------------------------------------------------------------
# The published coverage report
# ---------------------------------------------------------------------------


def test_parity_report_artifact_is_current(request: pytest.FixtureRequest) -> None:
    """The committed report matches a fresh build; regenerate with the update flag."""
    if updating_report(request):
        write_report(_REPORT)
        assert ARTIFACT_PATH.is_file() and MARKDOWN_PATH.is_file()
        return

    assert ARTIFACT_PATH.is_file(), (
        f"Missing {ARTIFACT_PATH}; regenerate with `{REGENERATE_COMMAND}`"
    )
    assert MARKDOWN_PATH.is_file(), (
        f"Missing {MARKDOWN_PATH}; regenerate with `{REGENERATE_COMMAND}`"
    )
    assert ARTIFACT_PATH.read_text(encoding="utf-8") == _REPORT.to_json(), (
        f"{ARTIFACT_PATH.name} drifted from the live registries and corpus. "
        f"Regenerate with `{REGENERATE_COMMAND}`."
    )
    assert MARKDOWN_PATH.read_text(encoding="utf-8") == render_markdown(_REPORT), (
        f"{MARKDOWN_PATH.name} drifted from {ARTIFACT_PATH.name}. "
        f"Regenerate with `{REGENERATE_COMMAND}`."
    )


def test_committed_report_parses_and_lists_every_gated_format() -> None:
    stored = load_report()
    assert stored is not None
    assert stored.report_version == REPORT_VERSION
    assert {entry.format_key for entry in stored.formats} == {
        entry.format_key for entry in _FORMATS
    }


def test_report_records_per_format_fixture_counts() -> None:
    """The acceptance criterion: the report is a *coverage* report, not a pass/fail bit."""
    for entry in _FORMATS:
        assert entry.fixtures.total == (
            entry.fixtures.valid
            + entry.fixtures.negative
            + entry.fixtures.adversarial
            + entry.fixtures.scale
        ), f"{entry.format_key}: fixture counts do not add up"
        assert entry.corpus_directories, f"{entry.format_key}: no corpus directory recorded"


def test_report_json_is_deterministic() -> None:
    """Same inputs, same bytes — otherwise the artifact cannot be drift-checked at all."""
    assert build_report().to_json() == _REPORT.to_json()
    assert render_markdown(build_report()) == render_markdown(_REPORT)


def test_markdown_report_names_every_gated_format() -> None:
    rendered = render_markdown(_REPORT)
    for entry in _FORMATS:
        assert f"`{entry.format_key}`" in rendered
    assert "## Fixture counts" in rendered
    assert "## Required artifacts" in rendered


def test_the_gate_is_documented_as_the_definition_of_done() -> None:
    """AC: the gate is documented in the corpus contributor guide, not only in code."""
    assert _CONTRIBUTOR_GUIDE.is_file(), f"missing {_CONTRIBUTOR_GUIDE}"
    guide = _CONTRIBUTOR_GUIDE.read_text(encoding="utf-8")
    for expected in (
        "parity gate",
        "definition of done",
        "tests/test_corpus_parity.py",
        "corpus_parity_waivers.py",
        "KNOWN_PARITY_WAIVERS",
        "KNOWN_EXPORT_ONLY_DESTINATIONS",
        "generate_corpus_parity_report.py",
        "tests/golden/parity/corpus_parity.md",
    ):
        assert expected in guide, (
            f"docs/CORPUS_CONTRIBUTOR_GUIDE.md must document {expected!r} — a gate a contributor "
            "cannot read about is a gate that blocks them without telling them why"
        )


def test_the_coverage_report_is_published_by_ci() -> None:
    """AC: the coverage report is published by CI, not merely generated locally."""
    assert _CI_WORKFLOW.is_file(), f"missing {_CI_WORKFLOW}"
    workflow = _CI_WORKFLOW.read_text(encoding="utf-8")
    assert "scripts/generate_corpus_parity_report.py --check --fail-on-gaps" in workflow, (
        "the REST workflow must run the parity gate as a named step"
    )
    for path in (ARTIFACT_PATH, MARKDOWN_PATH):
        relative = path.relative_to(_REPO_ROOT).as_posix()
        assert relative in workflow, f"the REST workflow must publish {relative}"


# ---------------------------------------------------------------------------
# Engine unit tests: prove the gate would catch each gap
# ---------------------------------------------------------------------------


def _entry(
    path: str,
    *,
    validity: ValidityClass = ValidityClass.VALID,
    fmt: str = "demo",
    adapter: str = "demo",
    rung: Rung | None = Rung.MINIMAL,
) -> CorpusEntry:
    """Build a synthetic manifest entry (only the fields the parity engine reads matter)."""
    return CorpusEntry(
        path=path,
        format=fmt,
        adapter_key=adapter,
        validity_class=validity,
        expected_detection=ExpectedDetection(format=fmt, min_confidence=0.9),
        features=["demo"],
        expected_outcome=(
            ExpectedOutcome.IMPORTS if validity is ValidityClass.VALID else ExpectedOutcome.REJECTS
        ),
        source="hand-authored",
        license="Apache-2.0",
        provenance="Synthesized in a unit test.",
        rung=rung if validity is ValidityClass.VALID else None,
    )


def _cell(status: MatrixCellStatus, reason: str | None) -> MatrixCellResult:
    return MatrixCellResult(
        source_format="demo",
        emit_key="demo",
        emit_format="demo",
        status=status,
        reason=reason,
    )


def _matrix(*cells: MatrixCellResult, source_formats: Sequence[str] = ("demo",)) -> RoundTripMatrix:
    return RoundTripMatrix(
        source_formats=list(source_formats),
        emit_keys=["demo"],
        cells=list(cells),
    )


def _evaluate(
    *,
    entries: Sequence[CorpusEntry],
    golden_paths: Sequence[str] = ("demo/01-minimal.json",),
    matrix: RoundTripMatrix | None = None,
    emit_key: str | None = None,
    provenance: CapabilityProvenance = CapabilityProvenance.DERIVED,
    waivers: Dict[Tuple[str, str], str] | None = None,
) -> FormatParity:
    return evaluate_format(
        format_key="demo",
        label="Demo",
        paradigm="rest",
        entries=entries,
        golden_paths=golden_paths,
        matrix=matrix if matrix is not None else _matrix(),
        emit_key=emit_key,
        capability_provenance=provenance,
        waivers=waivers if waivers is not None else {},
    )


_COMPLETE = (
    _entry("demo/01-minimal.json"),
    _entry("demo/negative/01-truncated.json", validity=ValidityClass.INVALID),
)


def test_corpus_directory_is_the_first_path_segment() -> None:
    assert corpus_directory("openapi/01-minimal.yaml") == "openapi"
    assert corpus_directory("openapi/negative/01-truncated.yaml") == "openapi"
    assert corpus_directory("asyncapi/06-payment-events-set/asyncapi.yaml") == "asyncapi"


def test_a_complete_format_satisfies_every_requirement() -> None:
    result = _evaluate(entries=_COMPLETE)
    assert result.gaps == []
    assert set(result.requirements.values()) == {RequirementStatus.SATISFIED}
    assert result.fixtures.valid == 1
    assert result.fixtures.negative == 1
    assert result.rungs == ("minimal",)


def test_missing_valid_examples_is_a_gap() -> None:
    result = _evaluate(
        entries=[_entry("demo/negative/01-truncated.json", validity=ValidityClass.INVALID)],
    )
    assert result.gaps == [ParityRequirement.VALID_EXAMPLES]


def test_missing_negative_examples_is_a_gap() -> None:
    result = _evaluate(entries=[_entry("demo/01-minimal.json")])
    assert result.gaps == [ParityRequirement.NEGATIVE_EXAMPLES]


def test_missing_goldens_is_a_gap() -> None:
    result = _evaluate(entries=_COMPLETE, golden_paths=())
    assert result.gaps == [ParityRequirement.GOLDEN_SNAPSHOTS]
    assert result.goldens == 0


def test_a_golden_for_a_different_format_does_not_count() -> None:
    """The check is per corpus directory — an ``openapi`` golden cannot cover ``demo``."""
    result = _evaluate(entries=_COMPLETE, golden_paths=("openapi/01-minimal.yaml",))
    assert result.gaps == [ParityRequirement.GOLDEN_SNAPSHOTS]


def test_a_second_corpus_directory_needs_its_own_goldens() -> None:
    """``openapi`` owns ``swagger/`` too; one directory's goldens must not excuse the other."""
    entries = (*_COMPLETE, _entry("swagger/01-petstore.json", fmt="swagger"))
    result = _evaluate(
        entries=entries,
        golden_paths=("demo/01-minimal.json",),
        matrix=_matrix(source_formats=("demo", "swagger")),
    )
    assert result.corpus_directories == ("demo", "swagger")
    assert result.golden_directories == ("demo",)
    assert result.gaps == [ParityRequirement.GOLDEN_SNAPSHOTS]
    [line] = gap_summary(ParityReport(formats=(result,)))
    assert "swagger/" in line, "the failure must name the directory that has no goldens"


def test_missing_matrix_row_is_a_gap() -> None:
    result = _evaluate(entries=_COMPLETE, matrix=_matrix(source_formats=("other",)))
    assert result.gaps == [ParityRequirement.ROUNDTRIP_MATRIX]
    assert result.roundtrip_row is False


def test_absent_matrix_artifact_is_a_gap_not_a_crash() -> None:
    result = evaluate_format(
        format_key="demo",
        label="Demo",
        paradigm="rest",
        entries=_COMPLETE,
        golden_paths=("demo/01-minimal.json",),
        matrix=None,
        emit_key=None,
        capability_provenance=CapabilityProvenance.DERIVED,
        waivers={},
    )
    assert result.gaps == [ParityRequirement.ROUNDTRIP_MATRIX]


def test_import_only_format_needs_a_row_but_no_self_cell() -> None:
    result = _evaluate(entries=_COMPLETE, emit_key=None)
    assert result.roundtrip_cells == ()
    assert result.gaps == []


def test_passing_self_cell_satisfies_the_roundtrip_requirement() -> None:
    result = _evaluate(
        entries=_COMPLETE,
        emit_key="demo",
        matrix=_matrix(_cell(MatrixCellStatus.PASS, None)),
    )
    assert result.gaps == []
    assert result.roundtrip_cells[0].status == "pass"


def test_xfail_self_cell_with_a_reason_satisfies_the_roundtrip_requirement() -> None:
    """The ticket's "or a recorded xfail with a reason" — recorded, not silent."""
    result = _evaluate(
        entries=_COMPLETE,
        emit_key="demo",
        matrix=_matrix(_cell(MatrixCellStatus.XFAIL, "emitter drops discriminators")),
    )
    assert result.gaps == []
    assert result.roundtrip_cells[0].has_reason is True


@pytest.mark.parametrize(
    "status",
    [MatrixCellStatus.XFAIL, MatrixCellStatus.SKIPPED, MatrixCellStatus.UNSUPPORTED],
    ids=lambda status: status.value,
)
def test_non_passing_self_cell_without_a_reason_is_a_gap(status: MatrixCellStatus) -> None:
    result = _evaluate(entries=_COMPLETE, emit_key="demo", matrix=_matrix(_cell(status, "   ")))
    assert result.gaps == [ParityRequirement.ROUNDTRIP_MATRIX]


def test_absent_self_cell_is_a_gap() -> None:
    """A format with an emitter whose cell was never run is the ``asyncapi`` failure mode."""
    result = _evaluate(entries=_COMPLETE, emit_key="demo", matrix=_matrix())
    assert result.gaps == [ParityRequirement.ROUNDTRIP_MATRIX]
    assert result.roundtrip_cells[0].status is None


def test_unknown_capability_provenance_is_a_gap() -> None:
    result = _evaluate(entries=_COMPLETE, provenance=CapabilityProvenance.UNKNOWN_FORMAT)
    assert result.gaps == [ParityRequirement.CAPABILITY_ENTRY]


@pytest.mark.parametrize(
    "provenance",
    [CapabilityProvenance.REVIEWED, CapabilityProvenance.DERIVED],
    ids=lambda provenance: provenance.value,
)
def test_reviewed_and_derived_capabilities_both_satisfy(provenance: CapabilityProvenance) -> None:
    assert _evaluate(entries=_COMPLETE, provenance=provenance).gaps == []


def test_a_waiver_downgrades_a_gap_to_waived() -> None:
    result = _evaluate(
        entries=[_entry("demo/01-minimal.json")],
        waivers={("demo", "negative-examples"): "The format has no invalid instance to author."},
    )
    assert result.gaps == []
    assert result.waived == [ParityRequirement.NEGATIVE_EXAMPLES]
    assert result.waivers[ParityRequirement.NEGATIVE_EXAMPLES].startswith("The format has no")


def test_a_waiver_for_a_satisfied_requirement_reports_satisfied() -> None:
    """So :func:`test_no_parity_waiver_is_obsolete` can spot it and demand the waiver's removal."""
    result = _evaluate(
        entries=_COMPLETE,
        waivers={("demo", "negative-examples"): "no longer true"},
    )
    assert result.requirements[ParityRequirement.NEGATIVE_EXAMPLES] is RequirementStatus.SATISFIED
    assert result.waivers == {}


def test_a_waiver_for_another_format_does_not_apply() -> None:
    result = _evaluate(
        entries=[_entry("demo/01-minimal.json")],
        waivers={("other", "negative-examples"): "not this format"},
    )
    assert result.gaps == [ParityRequirement.NEGATIVE_EXAMPLES]


def test_a_format_with_no_entries_at_all_fails_every_corpus_requirement() -> None:
    result = _evaluate(entries=[], golden_paths=())
    assert result.gaps == [
        ParityRequirement.VALID_EXAMPLES,
        ParityRequirement.NEGATIVE_EXAMPLES,
        ParityRequirement.GOLDEN_SNAPSHOTS,
        ParityRequirement.ROUNDTRIP_MATRIX,
    ]


def test_gap_summary_names_the_format_and_the_remedy() -> None:
    report = ParityReport(formats=(_evaluate(entries=[], golden_paths=()),))
    lines = gap_summary(report)
    assert len(lines) == 4
    assert all(line.startswith("demo: ") for line in lines)
    assert any("corpus.manifest.json" in line for line in lines)
    assert any("UPDATE_ROUNDTRIP_MATRIX" in line for line in lines)


def test_markdown_report_shows_gaps_and_waivers() -> None:
    report = ParityReport(
        formats=(
            _evaluate(entries=[_entry("demo/01-minimal.json")]),
            _evaluate(
                entries=[_entry("demo/01-minimal.json")],
                waivers={("demo", "negative-examples"): "The format has no invalid instance."},
            ),
        )
    )
    rendered = render_markdown(report)
    assert "❌" in rendered
    assert "⚠️" in rendered
    assert "The format has no invalid instance." in rendered
    assert "**Formats with an unwaived gap:** 1" in rendered


def test_report_round_trips_through_json() -> None:
    payload = _REPORT.to_json()
    assert payload.endswith("\n")
    restored = ParityReport.model_validate(json.loads(payload))
    assert restored == _REPORT


def test_load_matrix_returns_none_when_the_artifact_is_absent(tmp_path: Path) -> None:
    assert load_matrix(tmp_path / "nope.json") is None


def test_write_report_writes_both_files(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "corpus_parity.json"
    write_report(_REPORT, target)
    assert target.read_text(encoding="utf-8") == _REPORT.to_json()
    assert target.with_suffix(".md").read_text(encoding="utf-8") == render_markdown(_REPORT)


def test_updating_report_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UPDATE_CORPUS_PARITY", raising=False)
    assert updating_report(None) is False
    monkeypatch.setenv("UPDATE_CORPUS_PARITY", "1")
    assert updating_report(None) is True
    monkeypatch.setenv("UPDATE_CORPUS_PARITY", "no")
    assert updating_report(None) is False


def test_build_report_accepts_injected_inputs() -> None:
    """The engine reads what it is given, so a caller can evaluate a hypothetical corpus."""
    report = build_report(entries=[], golden_paths=[], matrix=_matrix(source_formats=()))
    assert report.formats, "the registry still supplies the formats even with an empty corpus"
    assert all(entry.fixtures.total == 0 for entry in report.formats)
    assert report.pending_corpus_directories == ()
    assert len(gap_summary(report)) == 4 * len(report.formats)
