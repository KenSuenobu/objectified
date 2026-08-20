"""Tests for the format-count truth pass (FMT-1.6, #5417).

Two gates live here, and they answer the ticket's two acceptance criteria.

The **drift gate** regenerates every managed surface in memory — the JSON artifact, both generated
TypeScript modules, and the count tokens embedded in README and the guide pages — and compares them
byte-for-byte with what is committed. Registering an adapter without rerunning the generator turns
the build red.

The **guard** scans the human-facing surfaces for a format count that is neither inside a count
marker nor interpolated from the generated module. That is the criterion that stops this pass from
having to be repeated: a hand-typed "40+ formats" fails the moment it is written, rather than the
next time somebody happens to notice it is wrong.

Everything else asserts the counts say true things — that they are the matrix's own numbers, that
the per-paradigm breakdown is the canonical vocabulary, and that no count moves because *this*
machine is missing a bundled binary.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

import pytest

from app.canonical_model import ApiParadigm
from app.format_counts import (
    COUNTS_JSON_PATH,
    GENERATED_TS_MODULES,
    GUARDED_SOURCES,
    MARKED_DOCUMENTS,
    REGENERATE_COMMAND,
    FormatCounts,
    apply_count_tokens,
    build_format_counts,
    count_tokens,
    find_unmanaged_counts,
    render_counts_json,
    render_typescript_module,
)
from app.format_matrix import build_format_matrix
from app.supported_formats_doc import SUPPORTED_FORMATS_DOCS_PAGE

REPO_ROOT = Path(__file__).resolve().parents[2]

#: The portal and app modules whose copy must interpolate the generated constants.
BROWSE_FACETS = REPO_ROOT / "apiome-browse/lib/browseFacets.ts"
BROWSE_FORMAT_SURFACE = REPO_ROOT / "apiome-browse/lib/formatSurface.ts"
UI_HELP_CATALOG = REPO_ROOT / "apiome-ui/src/app/components/ade/help/helpCatalog.ts"


@pytest.fixture(scope="module")
def counts() -> FormatCounts:
    """The measured counts."""
    return build_format_counts()


@pytest.fixture(scope="module")
def tokens(counts: FormatCounts) -> Dict[str, int]:
    """The Markdown count tokens and their values."""
    return count_tokens(counts)


def _read(path: str) -> str:
    """Read a monorepo-relative file.

    Args:
        path: Path relative to the repository root.

    Returns:
        The file's text.
    """
    target = REPO_ROOT / path
    assert target.is_file(), f"missing managed surface: {path}"
    return target.read_text(encoding="utf-8")


# ===========================================================================
# The drift gate
# ===========================================================================


def test_committed_counts_json_matches_a_fresh_generation(counts: FormatCounts) -> None:
    """The acceptance criterion: CI fails when the committed counts are stale."""
    assert _read(COUNTS_JSON_PATH) == render_counts_json(counts), (
        f"{COUNTS_JSON_PATH} is out of date with the registries.\n"
        f"Regenerate with: {REGENERATE_COMMAND}"
    )


@pytest.mark.parametrize("module", GENERATED_TS_MODULES)
def test_committed_typescript_module_matches_a_fresh_generation(
    module: str, counts: FormatCounts
) -> None:
    """Each app's build-time constants are regenerated, never edited."""
    assert _read(module) == render_typescript_module(counts), (
        f"{module} is out of date with the registries.\n"
        f"Regenerate with: {REGENERATE_COMMAND}"
    )


@pytest.mark.parametrize("document", MARKED_DOCUMENTS)
def test_marked_document_counts_are_current(document: str, tokens: Dict[str, int]) -> None:
    """Every count token in prose holds the value the registries currently produce."""
    text = _read(document)
    assert text == apply_count_tokens(text, tokens), (
        f"{document} states a stale format count.\nRegenerate with: {REGENERATE_COMMAND}"
    )


def test_rendering_is_deterministic(counts: FormatCounts) -> None:
    """A generator whose output wobbles between runs cannot be drift-checked at all."""
    assert render_counts_json(counts) == render_counts_json(build_format_counts())
    assert render_typescript_module(counts) == render_typescript_module(build_format_counts())


def test_both_apps_receive_the_same_generated_module() -> None:
    """Two copies of one artifact. If they could differ, the two apps could claim different
    numbers, which is the failure this ticket removes."""
    rendered = {_read(module) for module in GENERATED_TS_MODULES}
    assert len(rendered) == 1


def test_registering_an_adapter_moves_every_count() -> None:
    """The gate has to catch the case it exists for: a new adapter, no regenerated surfaces.

    A gate that only catches a hand edit would miss the real failure mode — a format is added and
    every claim about the surface quietly keeps describing the old one.
    """
    from app.import_source import _REGISTRY, ImportSource, InputKind

    class _ProbeImportSource(ImportSource):  # not auto-registered
        key = "fmt16-probe"
        label = "FMT-1.6 Probe"
        description = "A throwaway adapter used only by this test."
        icon = "boxes"
        paradigm = ApiParadigm.AGENT
        input_kinds = (InputKind.FILE,)
        formats = ("fmt16-probe",)
        file_extensions = (".fmt16probe",)

        def detect(self, payload):  # pragma: no cover - never exercised
            from app.import_source import NO_MATCH

            return NO_MATCH

        def parse(self, raw, *, source_label=None):  # pragma: no cover
            return raw

        def normalize(self, native_ast, *, include_raw=True):  # pragma: no cover
            raise NotImplementedError

    before = build_format_counts()

    # The counts describe what this repository *ships* (adapters defined under `app.`), so a probe
    # declared in a test module would be filtered out and prove nothing.
    _ProbeImportSource.__module__ = "app.fmt16_probe_import_source"
    _REGISTRY["fmt16-probe"] = _ProbeImportSource
    try:
        drifted = build_format_counts()
        assert drifted.total == before.total + 1
        assert drifted.importable == before.importable + 1
        agent_before = next(p for p in before.paradigms if p.id == ApiParadigm.AGENT.value)
        agent_after = next(p for p in drifted.paradigms if p.id == ApiParadigm.AGENT.value)
        assert agent_after.total == agent_before.total + 1
        assert render_counts_json(drifted) != render_counts_json(before)
    finally:
        # Leaving it registered would poison every later assertion in this process.
        _REGISTRY.pop("fmt16-probe", None)

    assert build_format_counts() == before


# ===========================================================================
# The hand-typed-count guard
# ===========================================================================


@pytest.mark.parametrize("source", GUARDED_SOURCES)
def test_no_guarded_surface_states_a_hand_typed_count(source: str) -> None:
    """The second acceptance criterion: a reintroduced literal count fails a test."""
    findings = find_unmanaged_counts(source, _read(source))
    assert not findings, "\n".join(
        f"{f.path}:{f.line_number}: hand-typed format count {f.matched!r} — {f.line}\n"
        f"State it in Markdown as the number followed by its tag "
        f"(42<!--format-count:importable-->), or in TypeScript by interpolating FORMAT_COUNTS "
        f"from the generated module."
        for f in findings
    )


@pytest.mark.parametrize(
    "copy",
    [
        "Apiome imports 40+ formats.",
        "Import any of 40 formats today.",
        "We support 43 API formats.",
        "Covers 36 description formats.",
        "one of 12 formats",
    ],
)
def test_guard_catches_a_hand_typed_count(copy: str) -> None:
    """A guard that misses the shape it was written for is decoration."""
    assert find_unmanaged_counts("sample.md", copy), f"guard missed: {copy!r}"


def test_guard_accepts_a_marked_count(tokens: Dict[str, int]) -> None:
    """The managed form has to pass, or the mechanism is unusable."""
    marked = apply_count_tokens("Apiome imports 0<!--format-count:importable--> formats.", tokens)
    assert marked.startswith(f"Apiome imports {tokens['importable']}<!--format-count:")
    assert find_unmanaged_counts("sample.md", marked) == []


def test_guard_ignores_numbers_that_are_not_format_counts() -> None:
    """A false positive costs a contributor an afternoon, so the pattern stays specific."""
    prose = "Published 42 versions across 6 organizations, in the OpenAPI 3.1 format family."
    assert find_unmanaged_counts("sample.md", prose) == []


def test_guard_reports_where_the_count_is() -> None:
    """A failure a reader cannot act on is a failure they will disable."""
    text = "intro\nand 40+ formats here\noutro\n"
    findings = find_unmanaged_counts("sample.md", text)
    assert len(findings) == 1
    assert findings[0].line_number == 2
    assert findings[0].line == "and 40+ formats here"
    assert findings[0].matched == "40+ formats"


# ===========================================================================
# The counts themselves
# ===========================================================================


def test_counts_are_the_matrix_counts(counts: FormatCounts) -> None:
    """One traversal behind every surface: these are `GET /v1/formats/matrix`'s own numbers."""
    matrix = build_format_matrix().counts
    assert counts.total == matrix.total
    assert counts.importable == matrix.importable
    assert counts.exportable == matrix.exportable
    assert counts.round_trip == matrix.round_trip
    assert counts.import_only == matrix.import_only
    assert counts.export_only == matrix.export_only
    assert counts.live_discovery == matrix.live_discovery
    assert counts.publishable == matrix.publishable
    assert counts.toolchain_gated == matrix.toolchain_gated


def test_the_two_importers_partition_the_importable_formats(counts: FormatCounts) -> None:
    """Projects importer plus Catalog importer is every format Apiome reads, with no overlap."""
    assert counts.publishable + counts.catalog == counts.importable


def test_directions_partition_the_surface(counts: FormatCounts) -> None:
    """Round-trip, import-only and export-only account for every format exactly once."""
    assert counts.round_trip + counts.import_only + counts.export_only == counts.total
    assert counts.importable == counts.round_trip + counts.import_only
    assert counts.exportable == counts.round_trip + counts.export_only


def test_paradigms_are_the_canonical_vocabulary(counts: FormatCounts) -> None:
    """The browse facet is built from this list, so it must be `ApiParadigm` in its own order."""
    assert [p.id for p in counts.paradigms] == [p.value for p in ApiParadigm]
    assert all(p.label.strip() for p in counts.paradigms)


def test_paradigm_breakdown_sums_to_the_totals(counts: FormatCounts) -> None:
    """A breakdown that does not add up would let a section header contradict the headline."""
    assert sum(p.total for p in counts.paradigms) == counts.total
    assert sum(p.importable for p in counts.paradigms) == counts.importable
    assert sum(p.exportable for p in counts.paradigms) == counts.exportable


def test_counts_do_not_depend_on_this_deployments_toolchain(
    counts: FormatCounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A count that moved with the installed binaries could not be committed at all.

    A format whose parser is missing here is still a format Apiome supports — the distinction
    FMT-1.5 drew — so pretending every bundled tool is absent must change nothing.
    """
    monkeypatch.setattr("app.format_matrix.is_tool_available", lambda tool: False)
    assert build_format_counts() == counts


def test_toolchain_gated_is_a_declaration_not_an_observation(counts: FormatCounts) -> None:
    """It counts formats that *require* a tool, so it is the same number on every deployment."""
    rows = build_format_matrix().formats
    assert counts.toolchain_gated == sum(1 for row in rows if row.toolchain.required_tools)


def test_count_tokens_cover_every_headline_number(counts: FormatCounts) -> None:
    """A number a surface may want but no token names would be typed by hand instead."""
    resolved = count_tokens(counts)
    for field in (
        "total",
        "importable",
        "exportable",
        "round_trip",
        "import_only",
        "export_only",
        "live_discovery",
        "publishable",
        "catalog",
        "toolchain_gated",
    ):
        assert resolved[field] == getattr(counts, field)
    for paradigm in counts.paradigms:
        assert resolved[f"paradigm.{paradigm.id}"] == paradigm.total


# ===========================================================================
# The token mechanism
# ===========================================================================


def test_apply_count_tokens_rewrites_only_the_value(tokens: Dict[str, int]) -> None:
    """Authored prose around a marker must survive regeneration untouched."""
    text = "Apiome imports 1<!--format-count:importable--> formats today.\n"
    rewritten = apply_count_tokens(text, tokens)
    assert rewritten == (
        f"Apiome imports {tokens['importable']}<!--format-count:importable--> formats today.\n"
    )


def test_apply_count_tokens_is_idempotent(tokens: Dict[str, int]) -> None:
    """Running the generator twice must not produce a second diff."""
    text = "0<!--format-count:total-->"
    once = apply_count_tokens(text, tokens)
    assert apply_count_tokens(once, tokens) == once


def test_apply_count_tokens_rejects_an_unknown_token(tokens: Dict[str, int]) -> None:
    """A typo'd token would otherwise leave a number frozen forever."""
    with pytest.raises(KeyError, match="unknown format-count token"):
        apply_count_tokens("0<!--format-count:importabel-->", tokens)


def test_apply_count_tokens_leaves_unmarked_text_alone(tokens: Dict[str, int]) -> None:
    """The documents are authored, not generated; only the markers are ours."""
    text = "# Title\n\nSome prose with a 3.1 version and a `code span`.\n"
    assert apply_count_tokens(text, tokens) == text


# ===========================================================================
# The surfaces
# ===========================================================================


def test_readme_states_the_measured_surface_and_links_the_generated_page(
    tokens: Dict[str, int],
) -> None:
    """The ticket's headline: the README's strongest claim is now a measurement."""
    readme = _read("README.md")
    assert "<!--format-count:importable-->" in readme
    assert "<!--format-count:exportable-->" in readme
    assert "any-to-any" in readme
    assert SUPPORTED_FORMATS_DOCS_PAGE in readme
    assert "/v1/formats/matrix" in readme
    assert f"{tokens['importable']}<!--format-count:importable-->" in readme


@pytest.mark.parametrize(
    "document",
    ["docs/guide/import-a-spec.md", "docs/guide/export-a-spec.md", "docs/guide/README.md"],
)
def test_guide_pages_carry_managed_counts(document: str) -> None:
    """The guide's counts were the ones most visibly wrong; none of them is typed any more."""
    text = _read(document)
    assert "<!--format-count:" in text
    assert "supported-formats.md" in text


def test_browse_facets_read_the_generated_paradigm_vocabulary() -> None:
    """`apiome-browse` exposes a paradigm facet backed by the canonical paradigm values."""
    source = BROWSE_FACETS.read_text(encoding="utf-8")
    assert "FORMAT_PARADIGMS" in source, "the facet vocabulary is not the generated one"
    assert "from './generated/formatCounts'" in source
    assert "BROWSE_PARADIGMS" in source
    assert "'paradigm' | 'format'" in source


def test_portal_copy_interpolates_the_generated_counts() -> None:
    """The portal's hero claim is composed from the constants, not written as a sentence."""
    source = BROWSE_FORMAT_SURFACE.read_text(encoding="utf-8")
    assert "FORMAT_COUNTS" in source
    assert "${counts.importable} formats" in source


def test_help_catalog_interpolates_the_generated_counts() -> None:
    """The in-app guide search said "40+ formats"; it now says whatever the registries say."""
    source = UI_HELP_CATALOG.read_text(encoding="utf-8")
    assert "FORMAT_COUNTS.importable" in source
    assert "@/app/generated/formatCounts" in source


def test_generated_typescript_declares_itself_generated() -> None:
    """A contributor who opens the file must be told not to edit it, and how to regenerate it."""
    for module in GENERATED_TS_MODULES:
        source = _read(module)
        assert "GENERATED FILE" in source
        assert REGENERATE_COMMAND in source


def test_every_guarded_surface_exists() -> None:
    """A guard that silently skips a renamed file protects nothing."""
    missing: List[str] = [s for s in GUARDED_SOURCES if not (REPO_ROOT / s).is_file()]
    assert not missing, f"guarded surfaces are missing: {missing}"


@pytest.mark.parametrize("document", MARKED_DOCUMENTS)
def test_no_marked_line_begins_with_the_marker_comment(document: str) -> None:
    """A rendering trap, and the reason the tag trails the value instead of bracketing it.

    A line that *starts* with ``<!--`` opens an HTML block in CommonMark: the paragraph around it
    splits, and the prose either side renders as two paragraphs with raw markup between them. The
    drift gate cannot see this — the text is still self-consistent — so it gets its own assertion.
    """
    offenders = [
        (number, line)
        for number, line in enumerate(_read(document).splitlines(), start=1)
        if line.lstrip().startswith("<!--format-count")
    ]
    assert not offenders, (
        f"{document} has a count marker at the start of a line, which would break the paragraph "
        f"around it: {offenders}. Keep the number and its tag together, mid-line."
    )
