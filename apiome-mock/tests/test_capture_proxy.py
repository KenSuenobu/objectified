"""Guarded proxy capture runtime tests (#4747, PMR-2.4).

Drives the whole capture pipeline through the hosted app with a stub transport in place of a
socket: the opt-in header, each authorization gate, the allowlist, the fetch, the redaction that
runs before anything is stored, the credential re-scan that can refuse storage outright, and the
capture headers the caller reads back.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_capture import authorization_block, capture_policy_to_storage
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.api_key import ValidatedApiKey
from apiome_mock.capture import (
    CAPTURE_HEADER,
    CAPTURE_ID_HEADER,
    CAPTURE_REASON_HEADER,
    CAPTURE_REDACTIONS_HEADER,
    CAPTURE_UPSTREAM_HEADER,
    CaptureProxy,
    CaptureTransportError,
    UpstreamRequest,
    UpstreamResponse,
    build_capture_proxy,
    parse_capture_policy,
)
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}
                            }
                        },
                    }
                }
            }
        },
        "/pets/{petId}": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}},
                    }
                }
            },
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            }
        }
    },
}

BASE = "/demo/petstore/1.0.0"
UPSTREAM = "https://api.example.com/v1"
NOW = datetime.now(timezone.utc)
TENANT_ID = uuid4()
KEY_ID = uuid4()

LIVE_POLICY = capture_policy_to_storage(
    {
        "enabled": True,
        "upstreams": [UPSTREAM],
        "authorization": authorization_block(authorized_by="user-1", now=NOW, ttl_hours=24),
        "redaction": {"headers": ["X-Internal-Trace"], "patterns": ["email"]},
    }
)


class StubTransport:
    """A capture transport that answers from a script instead of a socket."""

    def __init__(
        self,
        *,
        status: int = 200,
        headers: tuple[tuple[str, str], ...] = (("content-type", "application/json"),),
        body: bytes = b'{"id": 7, "name": "Rex"}',
        error: str | None = None,
        truncated: bool = False,
    ) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        self.error = error
        self.truncated = truncated
        self.requests: list[UpstreamRequest] = []

    async def fetch(self, request: UpstreamRequest) -> UpstreamResponse:
        self.requests.append(request)
        if self.error is not None:
            raise CaptureTransportError(self.error)
        return UpstreamResponse(status=self.status, headers=self.headers, body=self.body, truncated=self.truncated)


def _compiled(mock_settings: dict[str, Any] | None) -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
        capture_policy=parse_capture_policy(mock_settings),
    )


@pytest.fixture
def transport() -> StubTransport:
    return StubTransport()


@pytest.fixture
def inserted() -> list[dict[str, Any]]:
    """Every capture the pipeline tried to persist, captured instead of written."""
    return []


def _make_client(
    *,
    mock_pool: object,
    monkeypatch: pytest.MonkeyPatch,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
    mock_settings: dict[str, Any] | None,
    api_key: ValidatedApiKey | None,
    pending: int = 0,
    insert_result: str | None = "cap-1",
    insert_error: Exception | None = None,
) -> Iterator[TestClient]:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("APIOME_MOCK_CAPTURE_ENABLED", "true")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    async def _insert(*_args: Any, **kwargs: Any) -> str | None:
        if insert_error is not None:
            raise insert_error
        inserted.append(kwargs)
        return insert_result

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
        patch("apiome_mock.server.record_mock_request"),
        patch(
            "apiome_mock.server.validate_api_key_for_tenant",
            new=AsyncMock(return_value=api_key),
        ),
        patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=_compiled(mock_settings)),
        ),
        patch("apiome_mock.capture.count_pending_captures", new=AsyncMock(return_value=pending)),
        patch("apiome_mock.capture.insert_capture_exchange", new=_insert),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            assert app.state.capture_proxy is not None
            app.state.capture_proxy = CaptureProxy(transport=transport)
            yield client
    get_settings.cache_clear()


@pytest.fixture
def capture_client(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
) -> Iterator[TestClient]:
    yield from _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
    )


# ---------------------------------------------------------------------------
# Opt-in
# ---------------------------------------------------------------------------


def test_a_request_without_the_header_is_mocked_not_captured(
    capture_client: TestClient, transport: StubTransport
) -> None:
    response = capture_client.get(f"{BASE}/pets")
    assert response.status_code == 200
    assert transport.requests == []
    assert CAPTURE_HEADER not in response.headers


@pytest.mark.parametrize("value", ["on", "1", "true", "YES", "record"])
def test_every_opt_in_spelling_records(capture_client: TestClient, transport: StubTransport, value: str) -> None:
    response = capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: value})
    assert response.status_code == 200
    assert len(transport.requests) == 1


def test_an_unrecognized_header_value_does_not_capture(capture_client: TestClient, transport: StubTransport) -> None:
    response = capture_client.get(f"{BASE}/pets", headers={CAPTURE_HEADER: "maybe"})
    assert response.status_code == 200
    assert transport.requests == []


# ---------------------------------------------------------------------------
# Authorization gates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("settings", "state"),
    [
        (None, "unconfigured"),
        ({"proxyCapture": capture_policy_to_storage({"enabled": False, "upstreams": [UPSTREAM]})}, "disabled"),
        (
            {
                "proxyCapture": capture_policy_to_storage(
                    {
                        "enabled": True,
                        "upstreams": [],
                        "authorization": authorization_block(authorized_by="u", now=NOW),
                    }
                )
            },
            "no-upstreams",
        ),
        (
            {"proxyCapture": capture_policy_to_storage({"enabled": True, "upstreams": [UPSTREAM]})},
            "unauthorized",
        ),
    ],
)
def test_capture_without_a_live_grant_is_refused_loudly(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
    settings: dict[str, Any] | None,
    state: str,
) -> None:
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings=settings,
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
    ):
        response = client.get(f"{BASE}/pets", headers={CAPTURE_HEADER: "on"})
        assert response.status_code == 403
        body = response.json()
        assert body["title"] == "Capture Not Authorized"
        assert body["captureState"] == state
        assert transport.requests == []


def test_capture_requires_an_api_key_for_attribution(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
) -> None:
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=None,
    ):
        response = client.get(f"{BASE}/pets", headers={CAPTURE_HEADER: "on"})
        assert response.status_code == 403
        assert response.json()["captureState"] == "no-api-key"
        assert transport.requests == []


def test_a_deployment_with_capture_off_never_proxies(
    monkeypatch: pytest.MonkeyPatch, mock_pool: object, transport: StubTransport
) -> None:
    assert build_capture_proxy(enabled=False, allow_private_upstreams=False, timeout_seconds=1.0) is None


# ---------------------------------------------------------------------------
# Allowlist and fetch
# ---------------------------------------------------------------------------


def test_a_request_hangs_off_the_entry_that_authorizes_it(capture_client: TestClient, transport: StubTransport) -> None:
    """An allowlist entry is a base: the mock's own paths hang off it, and nothing else does."""
    capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    assert transport.requests[0].url.startswith(f"{UPSTREAM}/")


def test_a_path_no_entry_authorizes_is_refused(capture_client: TestClient, transport: StubTransport) -> None:
    with patch("apiome_mock.capture.resolve_capture_upstream", return_value=None):
        response = capture_client.get(f"{BASE}/pets", headers={CAPTURE_HEADER: "on"})
    assert response.status_code == 403
    assert response.json()["title"] == "Upstream Not Allowlisted"
    assert response.json()["allowedUpstreams"] == [UPSTREAM]
    assert transport.requests == []


def test_the_fetch_targets_the_allowlisted_upstream(capture_client: TestClient, transport: StubTransport) -> None:
    capture_client.get(f"{BASE}/pets/7", params={"limit": "2"}, headers={CAPTURE_HEADER: "on"})
    sent = transport.requests[0]
    assert sent.url == f"{UPSTREAM}/pets/7?limit=2"
    assert sent.method == "GET"


def test_control_headers_are_not_forwarded_upstream(capture_client: TestClient, transport: StubTransport) -> None:
    capture_client.get(
        f"{BASE}/pets/7",
        headers={CAPTURE_HEADER: "on", "X-Api-Key": "k", "Accept": "application/json"},
    )
    forwarded = {name.lower() for name, _ in transport.requests[0].headers}
    assert "x-mock-capture" not in forwarded
    assert "x-api-key" not in forwarded
    assert "accept" in forwarded


def test_an_unreachable_upstream_is_a_bad_gateway(
    monkeypatch: pytest.MonkeyPatch, mock_pool: object, inserted: list[dict[str, Any]]
) -> None:
    failing = StubTransport(error="ConnectTimeout: too slow")
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=failing,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
    ):
        response = client.get(f"{BASE}/pets", headers={CAPTURE_HEADER: "on"})
        assert response.status_code == 502
        assert response.json()["title"] == "Upstream Unreachable"
        assert response.json()["upstream"] == f"{UPSTREAM}/pets"
        assert inserted == []


# ---------------------------------------------------------------------------
# The recorded exchange
# ---------------------------------------------------------------------------


def test_a_capture_returns_the_upstream_answer_and_says_it_recorded(
    capture_client: TestClient, inserted: list[dict[str, Any]]
) -> None:
    response = capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Rex"}
    assert response.headers[CAPTURE_HEADER] == "recorded"
    assert response.headers[CAPTURE_ID_HEADER] == "cap-1"
    assert response.headers[CAPTURE_UPSTREAM_HEADER] == f"{UPSTREAM}/pets/7"
    assert response.headers[CAPTURE_REDACTIONS_HEADER] == "0"
    assert len(inserted) == 1


def test_the_stored_record_carries_provenance_and_the_matched_operation(
    capture_client: TestClient, inserted: list[dict[str, Any]]
) -> None:
    capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    stored = inserted[0]
    assert stored["upstream"] == f"{UPSTREAM}/pets/7"
    assert stored["allowlist_entry"] == UPSTREAM
    assert stored["operation_key"] == "GET /pets/{petId}"
    assert stored["api_key_id"] == KEY_ID
    assert stored["policy_digest"].startswith("sha256:")
    assert stored["record"]["provenance"]["pathTemplate"] == "/pets/{petId}"
    assert stored["digest"].startswith("sha256:")


def test_credential_shaped_headers_are_dropped_rather_than_blocking_the_capture(
    capture_client: TestClient, inserted: list[dict[str, Any]]
) -> None:
    """A header the exact-on list cannot enumerate is redacted, not left to fail the re-scan."""
    response = capture_client.get(
        f"{BASE}/pets/7",
        headers={CAPTURE_HEADER: "on", "X-Tenant-Token": "live", "X-Signing-Key": "k"},
    )
    assert response.headers[CAPTURE_HEADER] == "recorded"
    stored = inserted[0]
    headers = stored["record"]["request"]["headers"]
    assert "x-tenant-token" not in headers
    assert "x-signing-key" not in headers
    rules = {decision["rule"] for decision in stored["redactions"]}
    assert rules == {"credential-header"}


def test_credentials_never_reach_the_stored_record(capture_client: TestClient, inserted: list[dict[str, Any]]) -> None:
    response = capture_client.get(
        f"{BASE}/pets/7",
        params={"access_token": "live-token"},
        headers={CAPTURE_HEADER: "on", "Authorization": "Bearer live", "X-Internal-Trace": "t1"},
    )
    stored = inserted[0]
    assert "live-token" not in str(stored["record"])
    assert "Bearer live" not in str(stored["record"])
    assert stored["record"]["request"]["headers"].get("authorization") is None
    assert stored["record"]["request"]["query"] == []
    rules = {decision["rule"] for decision in stored["redactions"]}
    assert {"always-header", "always-query", "policy-header"} <= rules
    assert int(response.headers[CAPTURE_REDACTIONS_HEADER]) == len(stored["redactions"])


def test_the_upstream_still_receives_the_credentials_it_needs(
    capture_client: TestClient, transport: StubTransport
) -> None:
    capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on", "Authorization": "Bearer live"})
    forwarded = dict((name.lower(), value) for name, value in transport.requests[0].headers)
    assert forwarded["authorization"] == "Bearer live"


def test_the_response_schema_outcome_is_recorded(
    monkeypatch: pytest.MonkeyPatch, mock_pool: object, inserted: list[dict[str, Any]]
) -> None:
    wrong = StubTransport(body=b'{"id": "seven"}')
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=wrong,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
    ):
        client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    stored = inserted[0]
    assert stored["schema_valid"] is False
    assert stored["validation_errors"]
    assert stored["record"]["validation"]["valid"] is False


def test_a_matching_response_validates_clean(capture_client: TestClient, inserted: list[dict[str, Any]]) -> None:
    capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    assert inserted[0]["schema_valid"] is True
    assert inserted[0]["validation_errors"] == []


def test_a_binary_body_is_returned_but_not_stored(
    monkeypatch: pytest.MonkeyPatch, mock_pool: object, inserted: list[dict[str, Any]]
) -> None:
    binary = StubTransport(headers=(("content-type", "image/png"),), body=b"\x89PNG\x00\x01")
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=binary,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
    ):
        response = client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
        assert response.content == b"\x89PNG\x00\x01"
    stored = inserted[0]
    assert stored["record"]["response"]["body"] is None
    assert stored["redactions"][0]["rule"] == "body-not-textual"


# ---------------------------------------------------------------------------
# Storage refusals — the caller is always told
# ---------------------------------------------------------------------------


def test_a_record_that_still_looks_credential_bearing_is_not_stored(
    capture_client: TestClient, inserted: list[dict[str, Any]]
) -> None:
    with patch(
        "apiome_mock.capture.residual_credential_pointers",
        return_value=["/response/body/leaked"],
    ):
        response = capture_client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Rex"}
    assert response.headers[CAPTURE_HEADER] == "not-recorded"
    assert response.headers[CAPTURE_REASON_HEADER] == "credential-scan-failed"
    assert inserted == []


def test_a_full_review_queue_stops_recording(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
) -> None:
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
        pending=10_000,
    ):
        response = client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
        assert response.status_code == 200
        assert response.headers[CAPTURE_REASON_HEADER] == "review-queue-full"
        assert inserted == []


def test_a_storage_failure_degrades_rather_than_failing_the_request(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
) -> None:
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
        insert_error=RuntimeError("postgres is away"),
    ):
        response = client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
        assert response.status_code == 200
        assert response.json() == {"id": 7, "name": "Rex"}
        assert response.headers[CAPTURE_HEADER] == "not-recorded"
        assert response.headers[CAPTURE_REASON_HEADER] == "store-unavailable"


def test_an_unresolvable_version_reports_store_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    transport: StubTransport,
    inserted: list[dict[str, Any]],
) -> None:
    for client in _make_client(
        mock_pool=mock_pool,
        monkeypatch=monkeypatch,
        transport=transport,
        inserted=inserted,
        mock_settings={"proxyCapture": LIVE_POLICY},
        api_key=ValidatedApiKey(id=KEY_ID, tenant_id=TENANT_ID, tenant_slug="demo"),
        insert_result=None,
    ):
        response = client.get(f"{BASE}/pets/7", headers={CAPTURE_HEADER: "on"})
        assert response.headers[CAPTURE_HEADER] == "not-recorded"
        assert response.headers[CAPTURE_REASON_HEADER] == "store-unavailable"


# ---------------------------------------------------------------------------
# Policy parsing
# ---------------------------------------------------------------------------


class TestRuntimePolicyParsing:
    def test_a_live_grant_is_authorized(self) -> None:
        policy = parse_capture_policy({"proxyCapture": LIVE_POLICY})
        assert policy.authorized()
        assert policy.digest.startswith("sha256:")

    def test_absent_settings_are_unconfigured_not_an_error(self) -> None:
        policy = parse_capture_policy(None)
        assert not policy.authorized()
        assert policy.state() == "unconfigured"

    def test_a_malformed_blob_never_raises(self) -> None:
        assert not parse_capture_policy({"proxyCapture": ["nope"]}).authorized()
        assert not parse_capture_policy("{broken").authorized()

    def test_a_bundle_without_the_key_can_never_capture(self) -> None:
        """``proxyCapture`` is not a bundled settings key, so a portable spec has no grant."""
        assert not parse_capture_policy({"scenarios": {}, "chaos": {}, "fixturePacks": {}}).authorized()

    def test_expiry_is_decided_per_call_not_at_parse_time(self) -> None:
        """A cached compiled spec must not keep a lapsed grant alive until the cache turns over."""
        policy = parse_capture_policy({"proxyCapture": LIVE_POLICY})
        assert policy.authorized(now=NOW)
        assert policy.state(now=NOW + timedelta(days=2)) == "expired"
