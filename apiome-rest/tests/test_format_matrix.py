"""Unit tests for the format matrix builder (FMT-1.5, #5416).

Two things are being proved here.

The first is that the matrix is a **faithful, complete** view of the registries: every shipped
adapter and every shipped emitter has a row, the row says what the registry says, and nothing is
invented. These tests read the same registries the builder reads, which would be circular if the
builder were the thing under test in isolation — so they assert the *relationships* the builder is
responsible for (direction follows from the two registries, counts follow from the rows, filters
partition the rows) rather than re-deriving each field's value.

The second is that the matrix is the **single traversal** behind the endpoint, the CLI and the
generated docs page. ``test_page_rows_match_matrix_rows`` is the load-bearing one: the FMT-1.2 page
is rendered from these rows, so a format cannot appear on one surface and not the other.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, List

import pytest

from app.canonical_model import ApiParadigm
from app.emitter import available_emit_formats, get_emitter
from app.format_capability_registry import REGISTRY_VERSION
from app.format_matrix import (
    FORMAT_MATRIX_VERSION,
    INTERNAL_FORMAT_KEYS,
    DirectionFilter,
    FormatDirection,
    FormatMatrixRow,
    build_format_matrix,
    filter_format_matrix,
    is_shipped_import_source,
    shipped_emitter_classes,
    shipped_emitters,
)
from app.import_routing import PUBLISHABLE_FORMATS
from app.import_source import describe_import_sources, get_import_source
from app.supported_formats_doc import collect_format_rows
from app.toolchain_runner import is_tool_available


@pytest.fixture(scope="module")
def rows() -> List[FormatMatrixRow]:
    """Every row of the unfiltered matrix."""
    return build_format_matrix().formats


@pytest.fixture(scope="module")
def by_key(rows: List[FormatMatrixRow]) -> dict[str, FormatMatrixRow]:
    """The rows indexed by registry key."""
    return {row.key: row for row in rows}


# ===========================================================================
# Completeness: every shipped format has exactly one row
# ===========================================================================


def test_every_shipped_import_adapter_has_a_row(by_key: dict[str, FormatMatrixRow]) -> None:
    """Registering an adapter is what puts a format on the matrix — there is no list to join."""
    for descriptor in describe_import_sources():
        if descriptor.key in INTERNAL_FORMAT_KEYS or not is_shipped_import_source(descriptor.key):
            continue
        assert descriptor.key in by_key, f"{descriptor.key} is registered but missing from the matrix"
        assert by_key[descriptor.key].import_support.supported is True


def test_every_shipped_emitter_has_a_row(by_key: dict[str, FormatMatrixRow]) -> None:
    """An emitter with no adapter behind it is an export-only destination, not an omission."""
    for import_key in shipped_emitters():
        assert import_key in by_key, f"{import_key} has an emitter but no matrix row"
        assert by_key[import_key].export_support.supported is True


def test_internal_machinery_is_not_published(by_key: dict[str, FormatMatrixRow]) -> None:
    """The no-op acceptance adapter is pipeline machinery; publishing it would be an over-claim."""
    for key in INTERNAL_FORMAT_KEYS:
        assert key not in by_key


def test_rows_have_unique_keys(rows: List[FormatMatrixRow]) -> None:
    """One row per format — an adapter and its emitter must merge, not appear twice."""
    keys = [row.key for row in rows]
    assert len(keys) == len(set(keys))


def test_rows_are_ordered_by_label_then_key(rows: List[FormatMatrixRow]) -> None:
    """The endpoint, the CLI table and the docs page all rely on this one ordering."""
    assert rows == sorted(rows, key=lambda row: (row.label.lower(), row.key))


# ===========================================================================
# Faithfulness: each row says what the registries say
# ===========================================================================


def test_direction_follows_the_two_registries(rows: List[FormatMatrixRow]) -> None:
    """``direction`` is derived, never declared — it must agree with the support blocks."""
    for row in rows:
        can_import = row.import_support.supported
        can_export = row.export_support.supported
        assert can_import or can_export, f"{row.key} is on the matrix but supports neither direction"
        if can_import and can_export:
            assert row.direction is FormatDirection.BOTH
        elif can_import:
            assert row.direction is FormatDirection.IMPORT_ONLY
        else:
            assert row.direction is FormatDirection.EXPORT_ONLY


def test_import_block_mirrors_the_adapter_descriptor(by_key: dict[str, FormatMatrixRow]) -> None:
    """Input kinds, discovery, extensions and version coverage are copied, not restated."""
    for descriptor in describe_import_sources():
        row = by_key.get(descriptor.key)
        if row is None:
            continue
        assert row.label == descriptor.label
        assert row.description == descriptor.description
        assert row.icon == descriptor.icon
        assert row.paradigm is descriptor.paradigm
        assert row.import_support.input_kinds == [kind.value for kind in descriptor.input_kinds]
        assert row.import_support.supports_live_discovery == descriptor.supports_live_discovery
        assert row.import_support.supports_remote_refs == descriptor.supports_remote_refs
        assert row.import_support.available == descriptor.available
        assert row.import_support.unavailable_reason == descriptor.unavailable_reason
        assert row.version_coverage == list(descriptor.formats)
        assert row.file_extensions == list(descriptor.file_extensions)


def test_export_block_mirrors_the_emitter(by_key: dict[str, FormatMatrixRow]) -> None:
    """The export half carries the emitter's own descriptor and capability profile."""
    for import_key, emitter in shipped_emitter_classes().items():
        row = by_key[import_key]
        descriptor = emitter.descriptor()
        assert row.export_support.target_key == descriptor.key
        assert row.export_support.label == descriptor.label
        assert row.export_support.format == descriptor.format
        assert row.export_support.multi_file == descriptor.multi_file
        assert row.export_support.available == descriptor.available
        assert row.export_support.capability_profile == emitter.capability_profile()


def test_import_only_rows_carry_an_empty_export_block(rows: List[FormatMatrixRow]) -> None:
    """The block is always present, so a consumer never branches on a missing key."""
    for row in rows:
        if row.export_support.supported:
            continue
        assert row.export_support.target_key is None
        assert row.export_support.label is None
        assert row.export_support.format is None
        assert row.export_support.capability_profile is None
        assert row.export_support.available is False


def test_publishable_is_the_routing_rule(by_key: dict[str, FormatMatrixRow]) -> None:
    """Project-vs-catalog is read from the routing code, so the matrix cannot promise a routing
    the server would not perform."""
    for descriptor in describe_import_sources():
        row = by_key.get(descriptor.key)
        if row is None:
            continue
        expected = any(fmt.strip().lower() in PUBLISHABLE_FORMATS for fmt in descriptor.formats)
        assert row.import_support.publishable is expected


def test_openapi_row_is_the_publishable_round_tripping_one(
    by_key: dict[str, FormatMatrixRow],
) -> None:
    """A concrete anchor: the reference adapter reads and writes, and mints Projects."""
    row = by_key["openapi"]
    assert row.direction is FormatDirection.BOTH
    assert row.import_support.publishable is True
    assert "openapi-3.1" in row.version_coverage
    assert ".json" in row.file_extensions or ".yaml" in row.file_extensions
    assert row.export_support.capability_profile is not None
    assert row.export_support.capability_profile.operations is True


def test_asyncapi_export_resolves_through_the_alias_table(
    by_key: dict[str, FormatMatrixRow],
) -> None:
    """The AsyncAPI emitter registers under ``asyncapi-3`` but describes itself as ``asyncapi``;
    a lookup by descriptor key alone would report a round-tripping format as import-only."""
    row = by_key["asyncapi"]
    assert row.direction is FormatDirection.BOTH
    assert row.export_support.supported is True


# ===========================================================================
# The toolchain gate
# ===========================================================================


def test_toolchain_gate_is_the_union_of_both_directions(rows: List[FormatMatrixRow]) -> None:
    """A format gated on import and on export lists each tool once, in both breakdowns."""
    for row in rows:
        assert row.toolchain.required_tools == sorted(
            set(row.toolchain.import_tools) | set(row.toolchain.export_tools)
        )
        assert row.toolchain.import_tools == sorted(set(row.toolchain.import_tools))
        assert row.toolchain.export_tools == sorted(set(row.toolchain.export_tools))


def test_toolchain_gate_matches_the_declared_requirements(rows: List[FormatMatrixRow]) -> None:
    """``required_tools`` is read off the adapter and the emitter, never hand-listed here."""
    emitters = shipped_emitter_classes()
    for row in rows:
        adapter = get_import_source(row.key) if row.import_support.supported else None
        expected_import = sorted(set(getattr(adapter, "required_tools", ()) if adapter else ()))
        emitter = emitters.get(row.key)
        expected_export = sorted(set(getattr(emitter, "required_tools", ()) if emitter else ()))
        assert row.toolchain.import_tools == expected_import
        assert row.toolchain.export_tools == expected_export


def test_missing_tools_are_probed_and_satisfied_agrees(rows: List[FormatMatrixRow]) -> None:
    """``satisfied`` is exactly "nothing is missing" — the two can never disagree."""
    for row in rows:
        expected_missing = [
            tool for tool in row.toolchain.required_tools if not is_tool_available(tool)
        ]
        assert row.toolchain.missing_tools == expected_missing
        assert row.toolchain.satisfied is (not expected_missing)


def test_a_format_with_no_toolchain_is_satisfied(rows: List[FormatMatrixRow]) -> None:
    """A pure-Python format is never reported as gated on anything."""
    ungated = [row for row in rows if not row.toolchain.required_tools]
    assert ungated, "expected at least one pure-Python format"
    for row in ungated:
        assert row.toolchain.satisfied is True
        assert row.toolchain.missing_tools == []


# ===========================================================================
# The capability summary
# ===========================================================================


def test_every_row_carries_a_resolved_capability_summary(rows: List[FormatMatrixRow]) -> None:
    """``capability_for`` always resolves, so no row may fall back to a placeholder."""
    for row in rows:
        assert row.capability.registry_version == REGISTRY_VERSION
        assert row.capability.review_date
        assert row.capability.native_hierarchy_note


def test_no_row_is_an_unknown_format(rows: List[FormatMatrixRow]) -> None:
    """Every published format has a registered adapter or emitter, so none may report
    ``unknown_format`` — that value exists for retired keys a catalog item still names."""
    for row in rows:
        assert row.capability.provenance.value != "unknown_format"


# ===========================================================================
# Counts and filters
# ===========================================================================


def test_counts_are_computed_from_the_rows() -> None:
    """The headline numbers are a function of the rows, so they cannot drift from the table."""
    matrix = build_format_matrix()
    rows = matrix.formats
    counts = matrix.counts
    assert counts.total == len(rows)
    assert counts.importable == sum(1 for row in rows if row.import_support.supported)
    assert counts.exportable == sum(1 for row in rows if row.export_support.supported)
    assert counts.round_trip == sum(1 for row in rows if row.direction is FormatDirection.BOTH)
    assert counts.import_only == sum(
        1 for row in rows if row.direction is FormatDirection.IMPORT_ONLY
    )
    assert counts.export_only == sum(
        1 for row in rows if row.direction is FormatDirection.EXPORT_ONLY
    )
    assert counts.importable == counts.round_trip + counts.import_only
    assert counts.exportable == counts.round_trip + counts.export_only
    assert counts.live_discovery == sum(
        1 for row in rows if row.import_support.supports_live_discovery
    )
    assert counts.publishable == sum(1 for row in rows if row.import_support.publishable)
    assert counts.toolchain_gated == sum(1 for row in rows if row.toolchain.required_tools)
    assert counts.unavailable_here == sum(1 for row in rows if not row.toolchain.satisfied)


def test_unfiltered_matrix_echoes_no_filters() -> None:
    """The default response states, in the payload, that it is the whole surface."""
    matrix = build_format_matrix()
    assert matrix.filters.paradigm is None
    assert matrix.filters.direction is None
    assert matrix.version == FORMAT_MATRIX_VERSION
    assert matrix.capability_registry_version == REGISTRY_VERSION


@pytest.mark.parametrize("paradigm", list(ApiParadigm))
def test_paradigm_filter_returns_only_that_paradigm(paradigm: ApiParadigm) -> None:
    """Every paradigm filters cleanly, including one with no registered formats."""
    matrix = build_format_matrix(paradigm=paradigm)
    assert matrix.filters.paradigm is paradigm
    assert all(row.paradigm is paradigm for row in matrix.formats)
    assert matrix.counts.total == len(matrix.formats)


def test_paradigm_filter_partitions_the_matrix(rows: List[FormatMatrixRow]) -> None:
    """No row is lost or duplicated across the paradigms — the filter is a partition."""
    total = sum(len(build_format_matrix(paradigm=p).formats) for p in ApiParadigm)
    assert total == len(rows)


def test_direction_filter_import_includes_round_tripping_formats(
    rows: List[FormatMatrixRow],
) -> None:
    """``import`` is a capability question ("can Apiome read it?"), not an exact direction match."""
    matrix = build_format_matrix(direction=DirectionFilter.IMPORT)
    assert matrix.filters.direction is DirectionFilter.IMPORT
    assert {row.key for row in matrix.formats} == {
        row.key for row in rows if row.import_support.supported
    }
    assert any(row.direction is FormatDirection.BOTH for row in matrix.formats)


def test_direction_filter_export_includes_round_tripping_formats(
    rows: List[FormatMatrixRow],
) -> None:
    """The mirror of the import filter."""
    matrix = build_format_matrix(direction=DirectionFilter.EXPORT)
    assert {row.key for row in matrix.formats} == {
        row.key for row in rows if row.export_support.supported
    }


def test_direction_filter_both_returns_only_round_trips(rows: List[FormatMatrixRow]) -> None:
    """``both`` narrows to the intersection, not the union."""
    matrix = build_format_matrix(direction=DirectionFilter.BOTH)
    assert all(row.direction is FormatDirection.BOTH for row in matrix.formats)
    assert {row.key for row in matrix.formats} == {
        row.key
        for row in rows
        if row.import_support.supported and row.export_support.supported
    }


def test_filters_combine() -> None:
    """Paradigm and direction narrow together rather than one overriding the other."""
    matrix = build_format_matrix(paradigm=ApiParadigm.REST, direction=DirectionFilter.BOTH)
    for row in matrix.formats:
        assert row.paradigm is ApiParadigm.REST
        assert row.direction is FormatDirection.BOTH
    assert matrix.filters.paradigm is ApiParadigm.REST
    assert matrix.filters.direction is DirectionFilter.BOTH


def test_filtering_a_built_matrix_matches_building_it_filtered() -> None:
    """A caller holding the full payload narrows it with the same rules the server used — one
    implementation of the filter, so the CLI cannot disagree with the endpoint."""
    full = build_format_matrix()
    for paradigm in (None, ApiParadigm.REST, ApiParadigm.EVENT):
        for direction in (None, DirectionFilter.IMPORT, DirectionFilter.EXPORT, DirectionFilter.BOTH):
            narrowed = filter_format_matrix(full, paradigm=paradigm, direction=direction)
            fresh = build_format_matrix(paradigm=paradigm, direction=direction)
            assert narrowed.formats == fresh.formats
            assert narrowed.counts == fresh.counts
            assert narrowed.filters == fresh.filters


# ===========================================================================
# Determinism and the shared-traversal guarantee
# ===========================================================================


def test_matrix_is_deterministic() -> None:
    """Two builds of the same registries are equal — what makes the page drift-checkable and the
    response cacheable by ``version``."""
    assert build_format_matrix() == build_format_matrix()


def test_page_rows_match_matrix_rows(rows: List[FormatMatrixRow]) -> None:
    """The FMT-1.2 docs page is rendered from these rows.

    This is the acceptance criterion in test form: the page and ``GET /v1/formats/matrix`` are two
    renderings of one traversal, so a format cannot reach one surface and not the other.
    """
    page_rows = collect_format_rows()
    assert [row.key for row in page_rows] == [row.key for row in rows]
    for page_row, entry in zip(page_rows, rows):
        assert page_row.label == entry.label
        assert page_row.paradigm is entry.paradigm
        assert page_row.can_import == entry.import_support.supported
        assert page_row.can_export == entry.export_support.supported
        assert page_row.publishable == entry.import_support.publishable
        assert page_row.format_keys == tuple(entry.version_coverage)
        assert page_row.file_extensions == tuple(entry.file_extensions)
        assert page_row.boundary_notes == tuple(entry.capability.notes)


def test_shipped_emitters_is_the_descriptor_view_of_shipped_emitter_classes() -> None:
    """The two accessors are one lookup, so the parity gate and the matrix see the same emitters."""
    classes = shipped_emitter_classes()
    descriptors = shipped_emitters()
    assert set(classes) == set(descriptors)
    for key, emitter in classes.items():
        assert descriptors[key] == emitter.descriptor()


def test_shipped_emitter_classes_covers_every_shipped_registry_key() -> None:
    """Every emitter in the registry that this repository ships resolves onto some import key."""
    resolved = set(shipped_emitter_classes().values())
    for format_key in available_emit_formats():
        emitter = get_emitter(format_key)
        if emitter is None or not emitter.__module__.startswith("app."):
            continue
        if emitter.descriptor().key in INTERNAL_FORMAT_KEYS:
            continue
        assert emitter in resolved, f"{format_key} is shipped but absent from the matrix's emitters"


# ===========================================================================
# The export-only path
# ===========================================================================


@contextmanager
def _registered_emitter(emitter_cls) -> Iterator[None]:
    """Register ``emitter_cls`` for the duration of the block, then remove it again."""
    from app.emitter import _REGISTRY, load_builtin_emitters

    load_builtin_emitters()
    _REGISTRY[emitter_cls.format] = emitter_cls
    try:
        yield
    finally:
        _REGISTRY.pop(emitter_cls.format, None)


def _probe_emitter():
    """Build an emitter for a format no adapter reads — an export-only destination.

    Today every shipped emitter has an import adapter behind it, so this branch of the builder has
    no live example. That is exactly why it is worth exercising: the day a write-only destination
    ships, "the matrix lists it" must already be true rather than discovered.

    Returns:
        The emitter class, not yet registered. Its module claims this repository, because the
        matrix publishes what Apiome ships.
    """
    from app.emitter import CapabilityProfile, Emitter

    class _ProbeEmitter(Emitter):  # not auto-registered
        key = "probe-destination"
        format = "probe-destination-1"
        label = "Probe Destination"
        description = "A write-only destination used only by this test."
        icon = "file-output"
        paradigm = ApiParadigm.RPC
        multi_file = True
        required_tools = ("probe-tool",)

        @classmethod
        def capability_profile(cls) -> CapabilityProfile:
            return CapabilityProfile(operations=True)

        def emit(self, api, *, opts=None):  # pragma: no cover - enumeration never emits
            raise NotImplementedError

    _ProbeEmitter.__module__ = "app.probe_destination_emitter"
    return _ProbeEmitter


def test_export_only_destination_gets_a_row() -> None:
    """An emitter with no adapter behind it is still a format Apiome supports, and a matrix whose
    whole point is stating the surface in full must list it."""
    emitter = _probe_emitter()
    with _registered_emitter(emitter):
        matrix = build_format_matrix()
        row = next(row for row in matrix.formats if row.key == "probe-destination")
        assert row.direction is FormatDirection.EXPORT_ONLY
        assert row.label == "Probe Destination"
        assert row.paradigm is ApiParadigm.RPC
        assert row.export_support.supported is True
        assert row.export_support.multi_file is True
        assert row.export_support.capability_profile is not None
        assert row.export_support.capability_profile.operations is True
        assert row.toolchain.export_tools == ["probe-tool"]
        assert row.toolchain.import_tools == []
        # No adapter reads it, so there is nothing to declare a version coverage or an extension.
        assert row.version_coverage == []
        assert row.file_extensions == []
        assert row.import_support.supported is False
        assert row.import_support.publishable is False
        # No adapter is registered under the key, so the capability registry says so honestly
        # rather than inventing an entry for a format it has never seen.
        assert row.capability.provenance.value == "unknown_format"


def test_export_only_destination_is_counted_and_filtered_as_such() -> None:
    """The counts and the direction filters follow the row, with no special case."""
    emitter = _probe_emitter()
    with _registered_emitter(emitter):
        assert build_format_matrix().counts.export_only == 1
        export_keys = {row.key for row in build_format_matrix(
            direction=DirectionFilter.EXPORT
        ).formats}
        assert "probe-destination" in export_keys
        import_keys = {row.key for row in build_format_matrix(
            direction=DirectionFilter.IMPORT
        ).formats}
        assert "probe-destination" not in import_keys
        both_keys = {row.key for row in build_format_matrix(
            direction=DirectionFilter.BOTH
        ).formats}
        assert "probe-destination" not in both_keys


def test_emitter_from_outside_the_repository_is_not_published() -> None:
    """The published surface is what Apiome ships, not what a caller registered at runtime."""
    emitter = _probe_emitter()
    emitter.__module__ = __name__
    with _registered_emitter(emitter):
        assert "probe-destination" not in {row.key for row in build_format_matrix().formats}
