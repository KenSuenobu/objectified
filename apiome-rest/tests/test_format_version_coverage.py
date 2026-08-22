"""Declared version-coverage conformance suite — FMT-3.8 (#5433).

The ticket's load-bearing acceptance criterion is not that the field exists. It is that
**every declared version has corpus evidence, and a declaration without evidence fails CI**.
Without that, :mod:`app.format_version_coverage` is one more hand-maintained list of version
claims — exactly what it replaced — and it would drift the same way, only now with a schema.

So this suite is organised by claim rather than by module:

* **Completeness** — every published format declares its coverage, and nothing else does.
* **Well-formedness** — a read key is one the adapter really declares, a write key is one an
  emitter really produces, a qualified version carries the reason that qualifies it.
* **Evidence** — the conformance check itself: a corpus fixture per read version, a round-trip
  matrix row per write version, waivers strict in both directions.
* **Agreement with the code** — where a module already owns a version table (AsyncAPI, Arazzo,
  Kong, Gateway API), the declaration is asserted against *it* rather than against a copy.
* **Surfaces** — the field reaches the capability endpoint, the format matrix and the generated
  docs page.

Everything here is deterministic: the corpus manifest, the committed round-trip artifact and the
adapter registry, never a live import or emit. A developer missing a bundled binary gets the same
answer CI does.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient
from version_coverage_conformance import (
    KNOWN_VERSION_COVERAGE_WAIVERS,
    ConformanceRow,
    Direction,
    conformance_rows,
    covered_descriptors,
    read_evidence,
    write_evidence,
)

from app.arazzo_spec import SUPPORTED_ARAZZO_VERSIONS
from app.asyncapi_parser import ASYNCAPI_SUPPORTED_VERSIONS
from app.auth import validate_session_credentials
from app.format_capability_registry import capability_for, registry_snapshot
from app.format_matrix import build_format_matrix, shipped_emitters
from app.format_version_coverage import (
    UNDECLARED_VERSION_COVERAGE,
    FormatVersion,
    VersionCoverage,
    VersionSupport,
    declared_version_coverage,
    version_coverage_for,
)
from app.gateway_api_schema import HTTPROUTE_VERSIONS
from app.import_source import get_import_source
from app.kong_deck_schema import DECK_FORMAT_VERSIONS
from app.main import app
from app.supported_formats_doc import render_supported_formats_page

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}


def _override_auth() -> Dict[str, Any]:
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = _override_auth
    yield
    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def coverage() -> Dict[str, VersionCoverage]:
    """Every format's declared coverage, keyed by import-source key."""
    return declared_version_coverage()


@pytest.fixture(scope="module")
def rows() -> List[ConformanceRow]:
    """Every declared version with the evidence resolved for it."""
    return conformance_rows()


def _ids(descriptors) -> List[str]:
    """Registry keys, for readable parametrized test ids."""
    return [descriptor.key for descriptor in descriptors]


_DESCRIPTORS = covered_descriptors()


# ---------------------------------------------------------------------------
# Completeness — every published format declares its coverage
# ---------------------------------------------------------------------------


def test_the_population_under_test_is_not_empty() -> None:
    # A registry that failed to load would make every parametrized test below vacuous.
    assert len(_DESCRIPTORS) >= 40


@pytest.mark.parametrize("descriptor", _DESCRIPTORS, ids=_ids(_DESCRIPTORS))
def test_every_published_format_declares_read_coverage(descriptor, coverage) -> None:
    declared = coverage.get(descriptor.key)
    assert declared is not None, (
        f"{descriptor.key} is published but declares no version coverage; add it to "
        "app.format_version_coverage._VERSION_COVERAGE"
    )
    assert declared.declared
    assert declared.reads, f"{descriptor.key} declares no readable version"


def test_no_declaration_exists_for_an_unregistered_format(coverage) -> None:
    # A declaration for a key nothing is registered under would publish a version claim no code
    # can serve — the drift this table exists to end, pointing the other way.
    published = {descriptor.key for descriptor in _DESCRIPTORS}
    assert set(coverage) == published


def test_an_unknown_format_key_resolves_to_an_undeclared_coverage() -> None:
    assert version_coverage_for("retired-adapter") is UNDECLARED_VERSION_COVERAGE
    assert version_coverage_for("") is UNDECLARED_VERSION_COVERAGE
    # Not "reads nothing" — *says* nothing. The difference is the whole point of the flag.
    assert UNDECLARED_VERSION_COVERAGE.declared is False
    assert UNDECLARED_VERSION_COVERAGE.reads == ()


# ---------------------------------------------------------------------------
# Well-formedness — the keys resolve, the qualifiers are explained
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("descriptor", _DESCRIPTORS, ids=_ids(_DESCRIPTORS))
def test_every_read_key_is_one_the_adapter_declares(descriptor, coverage) -> None:
    declared = set(descriptor.formats)
    for version in coverage[descriptor.key].reads:
        assert version.format_key in declared, (
            f"{descriptor.key} declares read version {version.version!r} under "
            f"{version.format_key!r}, which the adapter does not list in `formats`"
        )


@pytest.mark.parametrize("descriptor", _DESCRIPTORS, ids=_ids(_DESCRIPTORS))
def test_write_coverage_matches_the_emitter_registry(descriptor, coverage) -> None:
    emitter = shipped_emitters().get(descriptor.key)
    declared = coverage[descriptor.key]
    if emitter is None:
        assert not declared.writes, (
            f"{descriptor.key} declares write versions but no emitter is registered for it"
        )
        assert declared.default_write is None
        return
    assert declared.writes, f"{descriptor.key} has an emitter but declares no write version"
    assert declared.write_format_keys == [emitter.format], (
        f"{descriptor.key} writes under {declared.write_format_keys}, but its emitter produces "
        f"{emitter.format!r}"
    )
    assert declared.default_write in {version.version for version in declared.writes}


@pytest.mark.parametrize("descriptor", _DESCRIPTORS, ids=_ids(_DESCRIPTORS))
def test_a_qualified_version_says_why(descriptor, coverage) -> None:
    declared = coverage[descriptor.key]
    for version in [*declared.reads, *declared.writes]:
        if version.support is VersionSupport.FULL:
            continue
        note = (version.note or "").strip()
        assert note, f"{descriptor.key} {version.version!r} is {version.support.value} with no note"
        assert note.endswith("."), (
            f"{descriptor.key} {version.version!r} note is not a sentence: {note!r}"
        )


def test_a_qualified_version_without_a_note_is_rejected_at_construction() -> None:
    # The model is the first gate: the table cannot grow a bare qualifier even before this suite
    # gets a chance to look at it.
    with pytest.raises(ValueError, match="without a note"):
        FormatVersion(version="9.9", format_key="nope", support=VersionSupport.PARTIAL)


def test_a_default_write_that_names_no_declared_version_is_rejected() -> None:
    with pytest.raises(ValueError, match="not one of the declared write versions"):
        VersionCoverage(
            writes=[
                FormatVersion(version="1.0", format_key="nope", support=VersionSupport.FULL)
            ],
            default_write="2.0",
        )


def test_a_default_write_on_an_import_only_format_is_rejected() -> None:
    with pytest.raises(ValueError, match="declares no write versions"):
        VersionCoverage(default_write="1.0")


def test_a_repeated_version_is_rejected() -> None:
    with pytest.raises(ValueError, match="more than once"):
        VersionCoverage(
            reads=[
                FormatVersion(version="1.0", format_key="a", support=VersionSupport.FULL),
                FormatVersion(version="1.0", format_key="b", support=VersionSupport.FULL),
            ]
        )


# ---------------------------------------------------------------------------
# Evidence — the conformance check the ticket asks for
# ---------------------------------------------------------------------------


def test_every_declared_read_version_has_a_corpus_fixture(rows) -> None:
    unevidenced = [
        row
        for row in rows
        if row.direction is Direction.READ and not row.evidenced and row.waiver is None
    ]
    assert not unevidenced, "declared read versions with no corpus entry detecting at them: " + (
        ", ".join(f"{row.format_key} {row.version!r} (key {row.selector!r})" for row in unevidenced)
    )


def test_every_declared_write_version_has_a_round_trip_row(rows) -> None:
    unevidenced = [
        row
        for row in rows
        if row.direction is Direction.WRITE and not row.evidenced and row.waiver is None
    ]
    assert not unevidenced, "declared write versions with no round-trip matrix row: " + (
        ", ".join(f"{row.format_key} {row.version!r} (key {row.selector!r})" for row in unevidenced)
    )


def test_every_declared_version_is_evidenced_or_waived(rows) -> None:
    # The two assertions above name the two failure modes separately so a failure reads well; this
    # one is the invariant they add up to, and it is what "a declaration without evidence fails CI"
    # means.
    assert all(row.evidenced or row.waiver for row in rows)
    assert rows, "no version rows were resolved; the declaration table did not load"


def test_a_waiver_is_deleted_once_its_version_is_evidenced(rows) -> None:
    # Strict, like the parity and round-trip waivers: an excuse that is no longer needed must be
    # removed rather than left to rot into a permanently-excused version.
    stale = [row for row in rows if row.waiver is not None and row.evidenced]
    assert not stale, "waived versions that now have evidence: " + ", ".join(
        f"{row.format_key}/{row.direction.value}/{row.version}" for row in stale
    )


def test_every_waiver_names_a_declared_version(rows) -> None:
    declared = {(row.format_key, row.direction.value, row.version) for row in rows}
    unknown = sorted(set(KNOWN_VERSION_COVERAGE_WAIVERS) - declared)
    assert not unknown, f"waivers for versions nothing declares: {unknown}"


def test_read_evidence_is_indexed_per_adapter_not_per_detection_key() -> None:
    # A corpus fixture proves the coverage of *the adapter that claims it*. Indexing by detection
    # key alone would let a format inherit evidence from a document it never reads — an Arazzo
    # fileset whose companion is an OpenAPI file detects as `openapi-3.1` but is Arazzo's fixture.
    evidence = read_evidence()
    assert ("openapi", "openapi-3.1") in evidence
    assert ("openapi", "graphql") not in evidence
    assert ("graphql", "graphql") in evidence


def test_every_corpus_detection_key_is_one_its_adapter_declares() -> None:
    # The property the read half of the conformance check leans on: a fixture's declared detection
    # format is always a key its own adapter serves, so "detects at this version" and "this adapter
    # reads this version" are the same statement rather than two that happen to agree.
    for adapter_key, detection_key in read_evidence():
        adapter = get_import_source(adapter_key)
        assert adapter is not None, adapter_key
        assert detection_key in adapter.formats, f"{adapter_key} fixture detects as {detection_key}"


def test_write_evidence_is_read_from_the_committed_matrix_artifact() -> None:
    evidence = write_evidence()
    # The emitter's registry key and the format it writes are not the same string, and the matrix
    # records both: gRPC's emitter is registered under `protobuf` and produces `proto3`.
    assert "openapi-3.1" in evidence
    assert "proto3" in evidence
    assert "protobuf" in evidence["proto3"]


# ---------------------------------------------------------------------------
# Agreement with the modules that own a version table
# ---------------------------------------------------------------------------


def test_asyncapi_declares_exactly_the_versions_its_parser_supports(coverage) -> None:
    declared = {version.version for version in coverage["asyncapi"].reads}
    assert declared == set(ASYNCAPI_SUPPORTED_VERSIONS)


def test_arazzo_declares_exactly_the_version_range_its_spec_module_enforces(coverage) -> None:
    declared = {version.version for version in coverage["arazzo"].reads}
    assert declared == {f"{major}.{minor}.x" for major, minor in SUPPORTED_ARAZZO_VERSIONS}


def test_kong_declares_exactly_the_deck_format_versions_its_schema_accepts(coverage) -> None:
    declared = {version.version for version in coverage["kong"].reads}
    assert declared == {f"deck `_format_version` {value}" for value in DECK_FORMAT_VERSIONS}


def test_gateway_api_declares_exactly_the_httproute_versions_it_reads(coverage) -> None:
    declared = {version.version for version in coverage["gateway-api"].reads}
    assert declared == set(HTTPROUTE_VERSIONS)


def test_openapi_declares_every_version_key_its_adapter_detects(coverage) -> None:
    adapter = get_import_source("openapi")
    assert adapter is not None
    assert set(coverage["openapi"].read_format_keys) == set(adapter.formats)


def test_swagger_1_2_is_declared_as_a_projection_rather_than_a_first_class_read(coverage) -> None:
    # The two FMT-3.6/3.4 versions a reader is most likely to mis-plan around: both are readable,
    # neither is read head-on, and the note is the only place that says so.
    [swagger_12] = [v for v in coverage["openapi"].reads if v.format_key == "swagger-1.2"]
    assert swagger_12.support is VersionSupport.PARTIAL
    assert "2.0" in (swagger_12.note or "")

    [odata_v2] = [v for v in coverage["odata"].reads if v.format_key == "odata-v2"]
    assert odata_v2.support is VersionSupport.PARTIAL


def test_wsdl_2_0_is_readable_but_not_writable(coverage) -> None:
    # The clearest asymmetry in the table, and the one a "we support WSDL 2.0" claim would flatten.
    declared = coverage["wsdl"]
    assert {version.version for version in declared.reads} == {"1.1", "2.0"}
    assert {version.version for version in declared.writes} == {"1.1"}
    assert declared.default_write == "1.1"


# ---------------------------------------------------------------------------
# Surfaces — capability entry, endpoint, matrix, docs page
# ---------------------------------------------------------------------------


def test_every_capability_entry_carries_its_declared_coverage() -> None:
    for descriptor in _DESCRIPTORS:
        entry = capability_for(descriptor.key)
        assert entry.version_coverage == version_coverage_for(descriptor.key)


def test_an_unknown_format_entry_claims_no_versions() -> None:
    entry = capability_for("retired-adapter")
    assert entry.version_coverage.declared is False
    assert entry.version_coverage.writes == ()


def test_the_capability_snapshot_carries_coverage_for_every_format() -> None:
    snapshot = registry_snapshot()
    published = {descriptor.key for descriptor in _DESCRIPTORS}
    for entry in snapshot.formats:
        if entry.format in published:
            assert entry.version_coverage.declared, entry.format


def test_the_capability_endpoint_serves_the_field() -> None:
    response = client.get("/v1/import/format-capabilities")
    assert response.status_code == 200
    formats = {row["format"]: row for row in response.json()["formats"]}
    openapi = formats["openapi"]["version_coverage"]
    assert openapi["default_write"] == "3.1.0"
    assert [row["version"] for row in openapi["reads"]] == ["3.2", "3.1", "3.0", "2.0", "1.2"]
    assert [row["format_key"] for row in openapi["writes"]] == ["openapi-3.1"] * 3


def test_the_single_format_capability_endpoint_serves_the_field() -> None:
    response = client.get("/v1/import/format-capabilities/wsdl")
    assert response.status_code == 200
    coverage = response.json()["version_coverage"]
    assert [row["version"] for row in coverage["reads"]] == ["1.1", "2.0"]
    assert coverage["default_write"] == "1.1"


def test_the_format_matrix_carries_the_coverage_on_every_row() -> None:
    matrix = build_format_matrix()
    assert matrix.formats
    for row in matrix.formats:
        assert row.capability.version_coverage.declared, row.key
        assert row.capability.version_coverage.reads, row.key


def test_the_matrix_rows_flat_format_keys_and_the_declared_versions_stay_distinct() -> None:
    # ``row.version_coverage`` is the adapter's declared *format keys* — aliases included — and
    # ``row.capability.version_coverage`` is the reviewed version statement. Conflating them is how
    # `cobol` and `apib` end up published as versions.
    row = next(entry for entry in build_format_matrix().formats if entry.key == "cobolcopybook")
    assert "cobol" in row.version_coverage
    assert "cobol" not in [
        version.format_key for version in row.capability.version_coverage.reads
    ]


def test_the_generated_docs_page_renders_version_coverage_per_format() -> None:
    page = render_supported_formats_page()
    assert "## Version coverage" in page
    assert "| Format | Key | Reads | Writes | Default export |" in page
    # One evidenced row per published format, and the qualified-version reasons beneath the table.
    for descriptor in _DESCRIPTORS:
        assert f"| `{descriptor.key}` |" in page
    assert "### Where support is qualified" in page
    assert "Read by projecting the resource listing" in page
