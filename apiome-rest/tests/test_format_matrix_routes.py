"""Contract tests for the format matrix endpoint (FMT-1.5, #5416).

``GET /v1/formats/matrix`` is the answer partners, the portal and the CLI integrate against, so
these tests pin the *contract* rather than today's format list: the endpoint returns every
registered format, each row carries the documented blocks, the filters narrow and are echoed back,
the counts describe the rows actually returned, and — the seam that makes the whole ticket work —
registering an adapter server-side surfaces a new row with no route change.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_session_credentials
from app.format_capability_registry import REGISTRY_VERSION
from app.format_matrix import FORMAT_MATRIX_VERSION, INTERNAL_FORMAT_KEYS, is_shipped_import_source
from app.import_source import describe_import_sources
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

MATRIX_URL = "/v1/formats/matrix"


def _override_auth() -> Dict[str, Any]:
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = _override_auth
    yield
    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def matrix() -> Dict[str, Any]:
    """The unfiltered payload, fetched once."""
    app.dependency_overrides[validate_session_credentials] = _override_auth
    try:
        response = client.get(MATRIX_URL)
        assert response.status_code == 200
        return response.json()
    finally:
        app.dependency_overrides.clear()


def _rows(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    return payload["formats"]


# ===========================================================================
# Completeness — the first acceptance criterion
# ===========================================================================


def test_matrix_returns_every_registered_format(matrix: Dict[str, Any]) -> None:
    """Every shipped, non-internal adapter has a row. This is the acceptance criterion."""
    keys = {row["key"] for row in _rows(matrix)}
    expected = {
        descriptor.key
        for descriptor in describe_import_sources()
        if descriptor.key not in INTERNAL_FORMAT_KEYS and is_shipped_import_source(descriptor.key)
    }
    assert expected, "no adapters registered — the fixture would prove nothing"
    assert expected <= keys


def test_matrix_excludes_internal_machinery(matrix: Dict[str, Any]) -> None:
    """The no-op acceptance adapter is not a format anyone can use."""
    keys = {row["key"] for row in _rows(matrix)}
    assert keys.isdisjoint(INTERNAL_FORMAT_KEYS)


def test_row_carries_every_documented_block(matrix: Dict[str, Any]) -> None:
    """The row shape partners integrate against, pinned field by field."""
    row = next(row for row in _rows(matrix) if row["key"] == "openapi")
    assert set(row) == {
        "key",
        "label",
        "description",
        "icon",
        "paradigm",
        "direction",
        "version_coverage",
        "file_extensions",
        "import_support",
        "export_support",
        "toolchain",
        "capability",
    }
    assert row["direction"] == "both"
    assert row["import_support"]["supported"] is True
    assert row["import_support"]["publishable"] is True
    assert "openapi-3.1" in row["version_coverage"]
    assert row["file_extensions"]
    assert row["export_support"]["supported"] is True
    assert row["export_support"]["capability_profile"]["operations"] is True
    assert row["toolchain"]["satisfied"] is True
    assert row["capability"]["registry_version"] == REGISTRY_VERSION


def test_import_only_format_reports_an_unsupported_export_block(matrix: Dict[str, Any]) -> None:
    """The block is always present, so a client never branches on a missing key."""
    import_only = [row for row in _rows(matrix) if row["direction"] == "import_only"]
    assert import_only, "expected at least one import-only format"
    for row in import_only:
        assert row["export_support"]["supported"] is False
        assert row["export_support"]["capability_profile"] is None
        assert row["export_support"]["label"] is None


def test_envelope_carries_versions_and_empty_filters(matrix: Dict[str, Any]) -> None:
    """A response is cacheable by ``version`` and states which slice it is."""
    assert matrix["version"] == FORMAT_MATRIX_VERSION
    assert matrix["capability_registry_version"] == REGISTRY_VERSION
    assert matrix["filters"] == {"paradigm": None, "direction": None}
    assert matrix["counts"]["total"] == len(_rows(matrix))


def test_rows_are_ordered_by_label_then_key(matrix: Dict[str, Any]) -> None:
    """One ordering across the endpoint, the CLI table and the generated page."""
    rows = _rows(matrix)
    assert rows == sorted(rows, key=lambda row: (row["label"].lower(), row["key"]))


# ===========================================================================
# Filters
# ===========================================================================


def test_paradigm_filter_narrows_and_is_echoed() -> None:
    response = client.get(MATRIX_URL, params={"paradigm": "event"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["filters"]["paradigm"] == "event"
    assert payload["formats"], "expected at least one event-paradigm format"
    assert all(row["paradigm"] == "event" for row in payload["formats"])
    assert payload["counts"]["total"] == len(payload["formats"])


def test_direction_filter_import_includes_round_trips(matrix: Dict[str, Any]) -> None:
    response = client.get(MATRIX_URL, params={"direction": "import"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["filters"]["direction"] == "import"
    assert {row["key"] for row in payload["formats"]} == {
        row["key"] for row in _rows(matrix) if row["import_support"]["supported"]
    }


def test_direction_filter_both_returns_only_round_trips() -> None:
    payload = client.get(MATRIX_URL, params={"direction": "both"}).json()
    assert payload["formats"]
    assert all(row["direction"] == "both" for row in payload["formats"])
    assert payload["counts"]["import_only"] == 0
    assert payload["counts"]["export_only"] == 0


def test_counts_describe_the_filtered_rows() -> None:
    """A filtered response must never restate a whole-registry total beside a partial table."""
    payload = client.get(MATRIX_URL, params={"paradigm": "graph"}).json()
    rows = payload["formats"]
    counts = payload["counts"]
    assert counts["total"] == len(rows)
    assert counts["importable"] == sum(1 for row in rows if row["import_support"]["supported"])
    assert counts["exportable"] == sum(1 for row in rows if row["export_support"]["supported"])


def test_unknown_paradigm_is_rejected() -> None:
    """An unrecognized filter value is a 422, not a silently empty matrix that reads as
    "we support nothing in that paradigm"."""
    assert client.get(MATRIX_URL, params={"paradigm": "telepathy"}).status_code == 422


def test_unknown_direction_is_rejected() -> None:
    assert client.get(MATRIX_URL, params={"direction": "sideways"}).status_code == 422


# ===========================================================================
# Auth and request shape
# ===========================================================================


def test_matrix_requires_authentication() -> None:
    """An unauthenticated call must be 401 — *not* 422. A 422 here would mean the endpoint declares
    a required request parameter (a tenant-scoped dependency's ``tenant_slug`` leaking in as a
    required query param), which would reject every real authenticated call too."""
    app.dependency_overrides.clear()
    assert client.get(MATRIX_URL).status_code == 401


def test_matrix_has_no_required_request_params() -> None:
    """Non-tenant registry metadata: no query or path parameter may be required."""
    schema = app.openapi()
    params = schema["paths"][MATRIX_URL]["get"].get("parameters", [])
    required_non_header = [p["name"] for p in params if p.get("required") and p["in"] != "header"]
    assert required_non_header == []


def test_matrix_is_published_in_the_openapi_document() -> None:
    """The OpenAPI document is the contract partners generate clients from."""
    schema = app.openapi()
    operation = schema["paths"][MATRIX_URL]["get"]
    assert operation["summary"] == "Get the format support matrix"
    assert {p["name"] for p in operation.get("parameters", [])} >= {"paradigm", "direction"}


# ===========================================================================
# The registry seam
# ===========================================================================


def _probe_adapter(shipped: bool):
    """Build a throwaway import adapter for the registry-seam tests.

    Args:
        shipped: When ``True`` the class reports a module inside this repository, which is what the
            matrix treats as "Apiome ships this". When ``False`` it keeps the test module, which is
            what a caller-supplied plugin looks like.

    Returns:
        The adapter class, not yet registered.
    """
    from app.canonical_model import ApiParadigm
    from app.import_source import NO_MATCH, ImportSource, InputKind

    class _ProbeImportSource(ImportSource):  # not auto-registered
        key = "probe-matrix-format"
        label = "Probe Matrix Format"
        description = "A throwaway adapter used only by this test."
        icon = "boxes"
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE, InputKind.PASTE)
        supports_live_discovery = False
        formats = ("probe-matrix-format-1.0",)
        file_extensions = (".probe",)

        def detect(self, payload):  # pragma: no cover - enumeration never sniffs
            return NO_MATCH

        def parse(self, raw, *, source_label=None):  # pragma: no cover - never parsed here
            return raw

        def normalize(self, native_ast, *, include_raw=True):  # pragma: no cover
            raise NotImplementedError

    if shipped:
        # The matrix decides what this repository ships from the defining module, so a probe that
        # must be treated as shipped has to claim one. Nothing else about the class changes.
        _ProbeImportSource.__module__ = "app.probe_matrix_format_import_source"
    return _ProbeImportSource


@contextmanager
def _registered(adapter) -> Iterator[None]:
    """Register ``adapter`` for the duration of the block, then remove it again."""
    from app.import_source import _REGISTRY, load_builtin_import_sources

    load_builtin_import_sources()
    _REGISTRY[adapter.key] = adapter
    try:
        yield
    finally:
        _REGISTRY.pop(adapter.key, None)


def test_new_shipped_adapter_appears_without_route_changes() -> None:
    """Registering an adapter server-side surfaces a new row — the seam that lets a format reach
    the endpoint, the CLI and the docs page in the commit that adds it, with no route change."""
    adapter = _probe_adapter(shipped=True)
    with _registered(adapter):
        payload = client.get(MATRIX_URL).json()
    rows = {row["key"]: row for row in payload["formats"]}
    assert adapter.key in rows
    row = rows[adapter.key]
    assert row["label"] == "Probe Matrix Format"
    assert row["direction"] == "import_only"
    assert row["version_coverage"] == ["probe-matrix-format-1.0"]
    assert row["file_extensions"] == [".probe"]
    assert row["import_support"]["input_kinds"] == ["file", "paste"]
    assert row["import_support"]["publishable"] is False
    assert row["capability"]["provenance"] == "derived"


def test_adapter_registered_outside_the_repository_is_not_published() -> None:
    """The published surface is what Apiome ships, not what a caller has added to the registry at
    runtime — otherwise a plugin (or a sibling test module) could rewrite the documented answer."""
    adapter = _probe_adapter(shipped=False)
    with _registered(adapter):
        payload = client.get(MATRIX_URL).json()
    assert adapter.key not in {row["key"] for row in payload["formats"]}
