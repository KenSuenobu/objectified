"""Tests for the generated supported-formats reference page (FMT-1.2, #5413).

The first test in this module is the **drift gate**: it regenerates the page in memory and compares
it byte-for-byte with the committed copy. The pytest suite runs in CI, so registering an adapter or
an emitter without regenerating the page turns the build red — which is the whole point. A reference
page that can silently fall behind the code is the problem this ticket exists to fix, not a smaller
version of it.

The rest assert the page says true things: that every registered format appears, that the
import/export direction matches the two registries, that the Projects/Catalog split is the routing
code's rule, and that the old four-format claim is gone from the prose guides.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

import pytest

from app.emitter import available_emit_formats, describe_emit_targets, get_emitter
from app.import_routing import PUBLISHABLE_FORMATS
from app.import_source import (
    describe_import_sources,
    get_import_source,
    resolve_import_source_key,
)
from app.supported_formats_doc import (
    REGENERATE_COMMAND,
    SUPPORTED_FORMATS_DOCS_PAGE,
    FormatRow,
    collect_format_rows,
    render_supported_formats_page,
)

from app.toolchain_selfcheck import missing_required_tools

REPO_ROOT = Path(__file__).resolve().parents[2]
PAGE_PATH = REPO_ROOT / SUPPORTED_FORMATS_DOCS_PAGE

#: Guides that must no longer present the Projects importer's four formats as the whole product.
IMPORT_GUIDE = REPO_ROOT / "docs/guide/import-a-spec.md"
EXPORT_GUIDE = REPO_ROOT / "docs/guide/export-a-spec.md"


@pytest.fixture(scope="module")
def page() -> str:
    """The committed page's text."""
    assert PAGE_PATH.is_file(), f"missing generated page: {PAGE_PATH}"
    return PAGE_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def rows() -> List[FormatRow]:
    """The rows the generator collects."""
    return collect_format_rows()


# ===========================================================================
# The drift gate
# ===========================================================================


#: The page's **Runtime** column is generated from *this* runtime, and the committed page was
#: generated from one that has the hard-required bundled toolchain (FMT-1.3, #5414) — as the
#: container image and CI both do. On a machine that never ran
#: ``scripts/install_dev_toolchain.sh``, AsyncAPI renders as *Needs toolchain* instead: an
#: environment difference, not a stale page. Say so and skip, rather than failing with advice
#: ("regenerate the page") that would commit the developer's own missing toolchain.
_MISSING_REQUIRED_TOOLS = missing_required_tools()
_TOOLCHAIN_SKIP_REASON = (
    "the required bundled toolchain is not installed here ("
    + ", ".join(_MISSING_REQUIRED_TOOLS)
    + "); run apiome-rest/scripts/install_dev_toolchain.sh. The committed page describes a "
    "runtime that has it, so comparing against it here would report an environment difference "
    "as drift."
)


@pytest.mark.skipif(bool(_MISSING_REQUIRED_TOOLS), reason=_TOOLCHAIN_SKIP_REASON)
def test_committed_page_matches_a_fresh_generation(page: str) -> None:
    """The acceptance criterion: CI fails when the committed page is stale."""
    assert page == render_supported_formats_page(), (
        f"{SUPPORTED_FORMATS_DOCS_PAGE} is out of date with the registries.\n"
        f"Regenerate with: {REGENERATE_COMMAND}"
    )


def test_rendering_is_deterministic() -> None:
    """A generator whose output wobbles between runs cannot be drift-checked at all."""
    assert render_supported_formats_page() == render_supported_formats_page()


def test_registering_an_adapter_trips_the_drift_gate(page: str) -> None:
    """The gate has to catch the case it exists for: a new adapter, no regenerated page.

    A gate that only catches hand edits of the page would miss the actual failure mode — someone
    adds a format and the reference page quietly keeps describing the old surface.
    """
    from app.canonical_model import ApiParadigm
    from app.import_source import _REGISTRY, ImportSource, InputKind

    class _ProbeImportSource(ImportSource):  # not auto-registered
        key = "fmt12-probe"
        label = "FMT-1.2 Probe"
        description = "A throwaway adapter used only by this test."
        icon = "boxes"
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE,)
        formats = ("fmt12-probe",)
        file_extensions = (".fmt12probe",)

        def detect(self, payload):  # pragma: no cover - never exercised
            from app.import_source import NO_MATCH

            return NO_MATCH

        def parse(self, raw, *, source_label=None):  # pragma: no cover
            return raw

        def normalize(self, native_ast, *, include_raw=True):  # pragma: no cover
            raise NotImplementedError

    # The generator documents what this repository *ships* (adapters defined under `app.`), so a
    # probe declared in a test module would be filtered out and prove nothing. Presenting it as an
    # `app.` module is what makes this a faithful stand-in for "someone added an adapter".
    _ProbeImportSource.__module__ = "app.fmt12_probe_import_source"
    _REGISTRY["fmt12-probe"] = _ProbeImportSource
    try:
        drifted = render_supported_formats_page()
        assert "FMT-1.2 Probe" in drifted
        assert drifted != page, "registering an adapter did not change the page — the gate is blind"
    finally:
        # Leaving it registered would poison every later assertion in this process.
        _REGISTRY.pop("fmt12-probe", None)

    assert render_supported_formats_page() == page


def test_page_declares_itself_generated(page: str) -> None:
    """A hand edit is the failure mode; the file has to say so and name the fix."""
    assert "GENERATED FILE — do not edit by hand." in page
    assert REGENERATE_COMMAND in page


# ===========================================================================
# Every registered format is documented
# ===========================================================================


def _is_shipped_source(key: str) -> bool:
    """Whether ``key`` is an adapter this repository ships, rather than a test's throwaway.

    Sibling test modules register fixture adapters into the process-wide registry and several do
    not remove them, so a bare "every registered key" assertion is order-dependent. The rule is
    written out here rather than imported from the generator, so this test still fails if the
    generator drops a shipped adapter for some *other* reason.
    """
    adapter = get_import_source(key)
    return adapter is not None and type(adapter).__module__.startswith("app.")


def test_every_shipped_import_source_appears(page: str) -> None:
    """No adapter can be supported and undocumented — that is the bug being fixed."""
    missing = [
        d.key
        for d in describe_import_sources()
        if d.key != "sample" and _is_shipped_source(d.key) and f"`{d.key}`" not in page
    ]
    assert not missing, (
        f"shipped import sources absent from {SUPPORTED_FORMATS_DOCS_PAGE}: {sorted(missing)}"
    )


def test_every_shipped_emitter_appears(page: str) -> None:
    """An export destination is part of the format surface too."""
    missing = []
    for format_key in available_emit_formats():
        emitter = get_emitter(format_key)
        if emitter is None or not emitter.__module__.startswith("app."):
            continue
        descriptor_key = emitter.descriptor().key
        if descriptor_key == "sample":
            continue
        if f"`{resolve_import_source_key(descriptor_key)}`" not in page:
            missing.append(format_key)
    assert not missing, (
        f"shipped emitters absent from {SUPPORTED_FORMATS_DOCS_PAGE}: {sorted(missing)}"
    )


@pytest.mark.parametrize("key", ["openapi", "grpc", "asyncapi", "graphql", "avro"])
def test_known_round_tripping_formats_are_not_reported_as_import_only(
    key: str, rows: List[FormatRow]
) -> None:
    """Guards the emitter-key join, which is easy to get subtly wrong.

    The emitter registry key is not always its descriptor key — the AsyncAPI emitter registers
    under ``asyncapi-3`` but describes itself as ``asyncapi`` — so a join on the wrong one silently
    reports these round-tripping formats as import-only. Naming them explicitly turns that into a
    failure instead of a quiet under-claim on a page whose entire purpose is not to under-claim.
    """
    row = next(r for r in rows if r.key == key)
    assert row.can_export is True, f"{key} has a registered emitter but the page says otherwise"
    assert row.direction == "Import + export"


def test_page_documents_far_more_than_the_four_formats_the_guides_claimed(rows: List[FormatRow]) -> None:
    """The headline problem: documentation said four, the engine has dozens."""
    importable = [r for r in rows if r.can_import]
    assert len(importable) > 30


def test_internal_sample_adapter_is_not_presented_as_a_format(page: str) -> None:
    """`sample` is the no-op job-pipeline stub; listing it would be a fresh over-claim."""
    assert "`sample`" not in page
    assert "Sample (no-op)" not in page


# ===========================================================================
# The page states import / export / both, per format
# ===========================================================================


def _emitter_keys() -> Dict[str, bool]:
    """Resolved import keys that have a registered emitter behind them."""
    return {
        resolve_import_source_key(t.descriptor.key): True
        for t in describe_emit_targets()
        if t.descriptor.key != "sample"
    }


def test_direction_matches_the_two_registries(rows: List[FormatRow]) -> None:
    """The acceptance criterion: per format, whether import, export, or both is supported."""
    emitters = _emitter_keys()
    import_keys = {d.key for d in describe_import_sources() if d.key != "sample"}

    for row in rows:
        assert row.can_import is (row.key in import_keys), row.key
        assert row.can_export is (row.key in emitters), row.key
        assert row.direction in {"Import + export", "Import only", "Export only"}, row.key


def test_direction_labels_are_rendered(page: str) -> None:
    assert "Import + export" in page
    assert "Import only" in page


def test_a_round_tripping_format_says_so(rows: List[FormatRow]) -> None:
    openapi = next(r for r in rows if r.key == "openapi")
    assert openapi.direction == "Import + export"


def test_an_import_only_format_says_so(rows: List[FormatRow]) -> None:
    # `mcp` reads a Model Context Protocol server description; there is no MCP emitter.
    mcp = next(r for r in rows if r.key == "mcp")
    assert mcp.can_import is True
    assert mcp.can_export is False
    assert mcp.direction == "Import only"


@pytest.mark.parametrize("key", ["kong", "gateway-api"])
def test_a_round_tripping_gateway_format_says_so(key: str, rows: List[FormatRow]) -> None:
    """The gateway formats gained emitters in FMT-2.2 / FMT-2.3: not read-only any more."""
    row = next(r for r in rows if r.key == key)
    assert row.can_import is True
    assert row.can_export is True
    assert row.direction == "Import + export"


def test_protobuf_emitter_is_joined_onto_its_grpc_import_adapter(rows: List[FormatRow]) -> None:
    """The two registries spell it differently; the alias table is what reconciles them.

    Without reusing `resolve_import_source_key`, gRPC would render as import-only *and* a phantom
    `protobuf` export-only row would appear beside it.
    """
    keys = [r.key for r in rows]
    assert "protobuf" not in keys
    grpc = next(r for r in rows if r.key == "grpc")
    assert grpc.direction == "Import + export"


# ===========================================================================
# The Projects / Catalog split is the routing code's rule
# ===========================================================================


def test_publishable_column_follows_import_routing(rows: List[FormatRow]) -> None:
    """The page must not claim a routing the server would not perform."""
    for row in rows:
        expected = any(fmt.strip().lower() in PUBLISHABLE_FORMATS for fmt in row.format_keys)
        assert row.publishable is expected, row.key


def test_openapi_is_the_publishable_family(rows: List[FormatRow]) -> None:
    publishable = {r.key for r in rows if r.publishable}
    assert publishable == {"openapi"}


def test_page_names_both_importers(page: str) -> None:
    """The silence about the Catalog importer is the documented problem."""
    assert "Projects importer" in page
    assert "Catalog importer" in page


def test_page_explains_the_conversion_nuance(page: str) -> None:
    """A format that normalizes to OpenAPI first routes to a Project; the legend must say so."""
    assert "normalizes to" in page


# ===========================================================================
# Table integrity
# ===========================================================================


def test_every_table_row_has_the_declared_column_count(page: str) -> None:
    """A stray `|` in registry prose would silently shift every column after it."""
    header = (
        "| Format | Key | Direction | Publishable | Input kinds | Live discovery "
        "| Format keys | File extensions | Analysis | Runtime |"
    )
    expected_columns = header.count("|") - 1
    in_table = False
    for line in page.splitlines():
        if line == header:
            in_table = True
            continue
        if in_table:
            if not line.startswith("|"):
                in_table = False
                continue
            # Count only unescaped pipes — an escaped one is content, not a cell boundary.
            unescaped = line.replace("\\|", "")
            assert unescaped.count("|") - 1 == expected_columns, line


def test_file_extensions_from_fmt_1_1_are_present(page: str) -> None:
    """FMT-1.1's declarations are what make the extensions column non-empty."""
    for extension in (".tsp", ".cpy", ".edi", ".hl7", ".capnp"):
        assert f"`{extension}`" in page, extension


def test_paradigm_sections_are_present(page: str) -> None:
    for heading in ("## REST", "## RPC", "## Event", "## Graph", "## Data schema", "## Agent"):
        assert heading in page, heading


def test_reviewed_boundary_notes_have_anchors(page: str, rows: List[FormatRow]) -> None:
    """Reviewed formats link from their Analysis cell to their notes; the anchors must exist."""
    for row in rows:
        if f"](#{row.anchor})" in page:
            assert f'<a id="{row.anchor}"></a>' in page, row.key


def test_boundary_section_only_carries_reviewed_prose(page: str) -> None:
    """A derived entry states what the adapter declared, which nobody reviewed as a boundary."""
    boundaries = page.split("## Format boundaries", 1)[1]
    assert "This entry is derived from the adapter" not in boundaries


# ===========================================================================
# The prose guides no longer imply four formats
# ===========================================================================


def test_import_guide_no_longer_claims_four_formats() -> None:
    """The exact sentence the ticket quotes must be gone."""
    text = IMPORT_GUIDE.read_text(encoding="utf-8")
    assert (
        "Supported inputs: **OpenAPI 3.x**, **Swagger 2.0**, **Arazzo 1.0**, "
        "**JSON Schema 2020-12**." not in text
    )


def test_import_guide_names_the_catalog_importer_and_links_the_page() -> None:
    text = IMPORT_GUIDE.read_text(encoding="utf-8")
    assert "Catalog importer" in text
    assert "supported-formats.md" in text


def test_export_guide_links_the_generated_page() -> None:
    text = EXPORT_GUIDE.read_text(encoding="utf-8")
    assert "supported-formats.md" in text
