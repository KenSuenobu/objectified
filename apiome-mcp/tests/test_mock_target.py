"""Tests for AGX-2.4 mock-target routing (:mod:`apiome_mcp.mock_target`, #4536)."""

from __future__ import annotations

import inspect

import pytest

from apiome_mcp.mock_target import (
    DEFAULT_TARGET,
    MAX_SEGMENT_LENGTH,
    MOCK_API_KEY_HEADER,
    InvalidBaseUrlError,
    InvalidMockCoordinateError,
    InvocationRoute,
    InvocationTarget,
    InvocationTargetError,
    MissingRouteInputError,
    MockCoordinates,
    UnknownInvocationTargetError,
    build_mock_base_url,
    normalize_base_url,
    parse_target,
    resolve_route,
)

_MOCK_ROOT = "https://mock.apiome.test"
_UPSTREAM = "https://api.petstore.test/v2"
_COORDS = MockCoordinates("acme-corp", "petstore", "1.0.0")


# ---------------------------------------------------------------------------
# InvocationTarget / parse_target
# ---------------------------------------------------------------------------


def test_target_values_match_database_column() -> None:
    """The enum is the ``agent_toolsets.target`` contract: exactly prod | mock, as strings."""
    assert {member.value for member in InvocationTarget} == {"prod", "mock"}
    assert InvocationTarget.MOCK == "mock"
    assert DEFAULT_TARGET is InvocationTarget.PROD


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("prod", InvocationTarget.PROD),
        ("mock", InvocationTarget.MOCK),
        ("MOCK", InvocationTarget.MOCK),
        ("  Prod  ", InvocationTarget.PROD),
        (InvocationTarget.MOCK, InvocationTarget.MOCK),
        (None, DEFAULT_TARGET),
        ("", DEFAULT_TARGET),
        ("   ", DEFAULT_TARGET),
    ],
)
def test_parse_target_accepts_stored_values(raw: object, expected: InvocationTarget) -> None:
    assert parse_target(raw) is expected


@pytest.mark.parametrize("raw", ["staging", "MOCKED", "prod,mock", "true", "1"])
def test_parse_target_rejects_unknown_strings(raw: str) -> None:
    """An unrecognised target never falls back — routing the wrong way is undetectable."""
    with pytest.raises(UnknownInvocationTargetError) as exc:
        parse_target(raw)
    assert "mock" in str(exc.value) and "prod" in str(exc.value)


@pytest.mark.parametrize("raw", [1, True, 3.5, ["mock"], {"target": "mock"}])
def test_parse_target_rejects_non_strings(raw: object) -> None:
    with pytest.raises(UnknownInvocationTargetError):
        parse_target(raw)


def test_target_errors_share_one_base_class() -> None:
    """Callers (AGX-2.1) can map every routing failure with a single ``except``."""
    for error in (
        UnknownInvocationTargetError,
        InvalidMockCoordinateError,
        InvalidBaseUrlError,
        MissingRouteInputError,
    ):
        assert issubclass(error, InvocationTargetError)
    assert issubclass(InvocationTargetError, ValueError)


# ---------------------------------------------------------------------------
# MockCoordinates
# ---------------------------------------------------------------------------


def test_coordinates_mount_path() -> None:
    assert _COORDS.mount_path == "/acme-corp/petstore/1.0.0"


def test_coordinates_percent_encode_reserved_characters() -> None:
    """Encoding happens at join time so a label with URL-reserved characters stays one segment."""
    coords = MockCoordinates("acme-corp", "pet-store", "1.0.0+rc1")
    assert coords.mount_path == "/acme-corp/pet-store/1.0.0%2Brc1"


@pytest.mark.parametrize(
    "bad",
    [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "has space",
        "tab\there",
        "new\nline",
        "null\x00byte",
        "del\x7f",
        "x" * (MAX_SEGMENT_LENGTH + 1),
    ],
)
def test_coordinates_reject_unsafe_segments(bad: str) -> None:
    """A slug can never escape the version's mount point on the mock."""
    with pytest.raises(InvalidMockCoordinateError):
        MockCoordinates(bad, "petstore", "1.0.0")
    with pytest.raises(InvalidMockCoordinateError):
        MockCoordinates("acme-corp", bad, "1.0.0")
    with pytest.raises(InvalidMockCoordinateError):
        MockCoordinates("acme-corp", "petstore", bad)


def test_coordinates_reject_non_string_segments() -> None:
    with pytest.raises(InvalidMockCoordinateError):
        MockCoordinates(None, "petstore", "1.0.0")  # type: ignore[arg-type]


def test_coordinates_are_frozen() -> None:
    with pytest.raises(Exception):
        _COORDS.tenant_slug = "other"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Base URL handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("root", "expected"),
    [
        ("https://mock.apiome.test", "https://mock.apiome.test/acme-corp/petstore/1.0.0"),
        ("https://mock.apiome.test/", "https://mock.apiome.test/acme-corp/petstore/1.0.0"),
        ("https://mock.apiome.test///", "https://mock.apiome.test/acme-corp/petstore/1.0.0"),
        ("http://localhost:8775", "http://localhost:8775/acme-corp/petstore/1.0.0"),
        ("  https://mock.apiome.test  ", "https://mock.apiome.test/acme-corp/petstore/1.0.0"),
        # A path-prefixed deployment keeps its prefix.
        ("https://apiome.test/mock", "https://apiome.test/mock/acme-corp/petstore/1.0.0"),
    ],
)
def test_build_mock_base_url(root: str, expected: str) -> None:
    assert build_mock_base_url(root, _COORDS) == expected


@pytest.mark.parametrize(
    "root",
    ["", "   ", "mock.apiome.test", "file:///etc/passwd", "ftp://mock.apiome.test", "https://"],
)
def test_build_mock_base_url_rejects_non_http_roots(root: str) -> None:
    with pytest.raises(InvalidBaseUrlError):
        build_mock_base_url(root, _COORDS)


@pytest.mark.parametrize(
    "root",
    ["https://mock.apiome.test/?tenant=x", "https://mock.apiome.test/#frag"],
)
def test_build_mock_base_url_rejects_query_or_fragment(root: str) -> None:
    """Appending a path to a URL that already has a query would put the path in the query."""
    with pytest.raises(InvalidBaseUrlError):
        build_mock_base_url(root, _COORDS)


def test_normalize_base_url_names_the_offending_field() -> None:
    with pytest.raises(InvalidBaseUrlError) as exc:
        normalize_base_url("mock_public_base_url", "ftp://nope.test")
    assert "mock_public_base_url" in str(exc.value)


# ---------------------------------------------------------------------------
# resolve_route — mock target
# ---------------------------------------------------------------------------


def test_mock_route_points_at_the_sim_mock() -> None:
    route = resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT, coordinates=_COORDS)
    assert route.base_url == f"{_MOCK_ROOT}/acme-corp/petstore/1.0.0"
    assert route.is_mock is True
    assert route.target is InvocationTarget.MOCK


def test_mock_route_never_injects_upstream_credentials() -> None:
    """The vault is not consulted in mock mode — the sandbox holds no upstream secret."""
    route = resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT, coordinates=_COORDS)
    assert route.inject_upstream_credentials is False
    assert dict(route.extra_headers) == {}


def test_mock_route_works_with_no_upstream_configured() -> None:
    """AGX-2.4 acceptance: a sandbox toolset runs with *no* upstream URL or credentials at all."""
    route = resolve_route(
        target="mock",
        upstream_base_url=None,
        mock_public_base_url=_MOCK_ROOT,
        coordinates=_COORDS,
    )
    assert route.base_url.startswith(_MOCK_ROOT)
    assert route.inject_upstream_credentials is False


def test_mock_route_ignores_any_configured_upstream() -> None:
    """Even a present (or unusable) upstream cannot leak into a mock-targeted call."""
    route = resolve_route(
        target="mock",
        upstream_base_url="file:///etc/passwd",
        mock_public_base_url=_MOCK_ROOT,
        coordinates=_COORDS,
    )
    assert route.base_url == f"{_MOCK_ROOT}/acme-corp/petstore/1.0.0"


def test_mock_route_carries_private_mock_key_when_supplied() -> None:
    """Private draft mocks (SIM-2.5) need mock-runtime auth, which is not an upstream credential."""
    route = resolve_route(
        target="mock",
        mock_public_base_url=_MOCK_ROOT,
        coordinates=_COORDS,
        mock_api_key="ak_live_example",
    )
    assert dict(route.extra_headers) == {MOCK_API_KEY_HEADER: "ak_live_example"}
    assert route.inject_upstream_credentials is False


@pytest.mark.parametrize("blank", [None, ""])
def test_mock_route_omits_header_for_blank_key(blank: str | None) -> None:
    route = resolve_route(
        target="mock",
        mock_public_base_url=_MOCK_ROOT,
        coordinates=_COORDS,
        mock_api_key=blank,
    )
    assert dict(route.extra_headers) == {}


def test_mock_route_requires_mock_root() -> None:
    with pytest.raises(MissingRouteInputError) as exc:
        resolve_route(target="mock", coordinates=_COORDS)
    assert "mock_public_base_url" in str(exc.value)


def test_mock_route_requires_coordinates() -> None:
    with pytest.raises(MissingRouteInputError) as exc:
        resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT)
    assert "coordinates" in str(exc.value)


def test_mock_route_rejects_bad_mock_root() -> None:
    with pytest.raises(InvalidBaseUrlError):
        resolve_route(target="mock", mock_public_base_url="not-a-url", coordinates=_COORDS)


# ---------------------------------------------------------------------------
# resolve_route — prod target
# ---------------------------------------------------------------------------


def test_prod_route_points_at_upstream_and_injects_credentials() -> None:
    route = resolve_route(target="prod", upstream_base_url=_UPSTREAM)
    assert route.base_url == _UPSTREAM
    assert route.inject_upstream_credentials is True
    assert route.is_mock is False
    assert dict(route.extra_headers) == {}


def test_prod_route_normalizes_trailing_slash() -> None:
    assert resolve_route(target="prod", upstream_base_url=f"{_UPSTREAM}/").base_url == _UPSTREAM


def test_prod_route_requires_upstream() -> None:
    with pytest.raises(MissingRouteInputError) as exc:
        resolve_route(target="prod")
    assert "upstream_base_url" in str(exc.value)


def test_prod_route_rejects_non_http_upstream() -> None:
    with pytest.raises(InvalidBaseUrlError):
        resolve_route(target="prod", upstream_base_url="file:///etc/passwd")


def test_missing_target_defaults_to_prod() -> None:
    """A toolset row without a target behaves as the AGX-1.2 column default."""
    assert resolve_route(target=None, upstream_base_url=_UPSTREAM).target is InvocationTarget.PROD


def test_unknown_target_refuses_to_route() -> None:
    with pytest.raises(UnknownInvocationTargetError):
        resolve_route(target="staging", upstream_base_url=_UPSTREAM)


# ---------------------------------------------------------------------------
# Audit labelling (AGX-3.3) and the no-recompile invariant
# ---------------------------------------------------------------------------


def test_audit_target_distinguishes_mock_from_prod() -> None:
    """AGX-3.3 rows are labelled so mock traffic is filterable in analytics."""
    mock = resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT, coordinates=_COORDS)
    prod = resolve_route(target="prod", upstream_base_url=_UPSTREAM)
    assert mock.audit_target == "mock"
    assert prod.audit_target == "prod"
    assert mock.audit_target != prod.audit_target


def test_switching_target_changes_only_the_destination() -> None:
    """Flipping ``target`` needs no toolset recompile: same inputs, different route."""
    common = {
        "upstream_base_url": _UPSTREAM,
        "mock_public_base_url": _MOCK_ROOT,
        "coordinates": _COORDS,
    }
    sandbox = resolve_route(target="mock", **common)  # type: ignore[arg-type]
    promoted = resolve_route(target="prod", **common)  # type: ignore[arg-type]

    assert sandbox.base_url != promoted.base_url
    assert sandbox.inject_upstream_credentials != promoted.inject_upstream_credentials
    assert sandbox.audit_target != promoted.audit_target


def test_resolve_route_takes_no_tool_definition() -> None:
    """Guard the invariant: routing is per-call, so nothing compiled can depend on target."""
    params = set(inspect.signature(resolve_route).parameters)
    assert params == {
        "target",
        "upstream_base_url",
        "mock_public_base_url",
        "coordinates",
        "mock_api_key",
    }


def test_resolve_route_is_pure_and_uncached() -> None:
    """A target flipped in the database takes effect on the very next call."""
    first = resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT, coordinates=_COORDS)
    second = resolve_route(target="prod", upstream_base_url=_UPSTREAM)
    third = resolve_route(target="mock", mock_public_base_url=_MOCK_ROOT, coordinates=_COORDS)
    assert first == third
    assert second.target is InvocationTarget.PROD


# ---------------------------------------------------------------------------
# InvocationRoute immutability
# ---------------------------------------------------------------------------


def test_route_headers_are_immutable() -> None:
    route = resolve_route(
        target="mock",
        mock_public_base_url=_MOCK_ROOT,
        coordinates=_COORDS,
        mock_api_key="ak_live_example",
    )
    with pytest.raises(TypeError):
        route.extra_headers["X-Injected"] = "nope"  # type: ignore[index]


def test_route_headers_do_not_alias_the_caller_dict() -> None:
    source = {"X-Trace": "abc"}
    route = InvocationRoute(
        target=InvocationTarget.PROD,
        base_url=_UPSTREAM,
        inject_upstream_credentials=True,
        extra_headers=source,
    )
    source["X-Trace"] = "mutated"
    assert dict(route.extra_headers) == {"X-Trace": "abc"}


def test_route_is_frozen() -> None:
    route = resolve_route(target="prod", upstream_base_url=_UPSTREAM)
    with pytest.raises(Exception):
        route.base_url = "https://elsewhere.test"  # type: ignore[misc]
