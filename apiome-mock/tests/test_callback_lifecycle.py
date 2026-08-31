"""Callback control plane and automatic firing (#4746, PMR-2.3).

Exercises the outbound half of a contract end to end: the reserved ``__mock__/callbacks`` routes,
the delivery a served operation fires on its own, and the proof that a bundle-backed portable
runtime does all of it identically to the hosted one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_bundle import BundleIdentity, build_bundle
from app.mock_callbacks import CALLBACK_FORMAT, callback_digest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.bundle import load_bundle_document
from apiome_mock.callback_dispatch import CALLBACK_HEADER, CALLBACK_URL_HEADER, CallbackDispatcher
from apiome_mock.callbacks import parse_callbacks
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.portable import create_portable_app
from apiome_mock.portable_config import PortableSettings
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

ORDERS_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Orders", "version": "1.0.0"},
    "paths": {
        "/orders": {
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/NewOrder"}}},
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": {"id": "order-1"}}},
                                "schema": {"$ref": "#/components/schemas/Order"},
                            }
                        },
                    }
                },
            },
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"examples": {"sample": {"value": []}}}},
                    }
                }
            },
        }
    },
    "components": {
        "schemas": {
            "NewOrder": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
            "Order": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
            "OrderEvent": {
                "type": "object",
                "required": ["event", "id"],
                "properties": {"event": {"type": "string"}, "id": {"type": "string"}},
            },
        }
    },
}

DESTINATION = "https://hooks.example.com/orders"

ORDER_CREATED = {
    "callbackFormat": CALLBACK_FORMAT,
    "callbackFormatVersion": 1,
    "description": "Order created.",
    "trigger": {"operation": "POST /orders", "statuses": [201]},
    "destinations": [DESTINATION],
    "request": {
        "headers": {"X-Event": "order.created"},
        "body": {"event": "order.created", "id": "{{request.body#/id}}"},
    },
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
    "retry": {"maxAttempts": 2, "backoffMs": 1, "retryOn": [503]},
}

# Fires nothing on its own; only an explicit trigger reaches it.
MANUAL_ONLY = {
    "destinations": [DESTINATION],
    "request": {"body": {"event": "manual", "id": "{{fixture.orderId}}"}},
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
    "retry": {"maxAttempts": 1},
}

# Renders a payload the declared schema rejects (``id`` must be a string).
BAD_PAYLOAD = {
    "trigger": {"operation": "GET /orders"},
    "destinations": [DESTINATION],
    "request": {"body": {"event": "bad", "id": 7}},
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
}

MOCK_SETTINGS: dict[str, Any] = {
    "fixtures": {"orderId": "fixture-order"},
    "callbacks": {"order-created": ORDER_CREATED, "manual-only": MANUAL_ONLY, "bad-payload": BAD_PAYLOAD},
}

BASE = "/demo/orders/1.0.0"
CONTROL = f"{BASE}/__mock__"


class RecordingTransport:
    """Replays a scripted sequence of statuses and records every outbound request."""

    def __init__(self, script: list[int] | None = None) -> None:
        self.script = list(script or [200])
        self.sent: list[Any] = []

    async def send(self, request: Any) -> int:
        self.sent.append(request)
        return self.script[min(len(self.sent) - 1, len(self.script) - 1)]


def _compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="orders",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=ORDERS_SPEC,
        operations=tuple(extract_operations(ORDERS_SPEC)),
        fixtures=dict(MOCK_SETTINGS["fixtures"]),
        callbacks=parse_callbacks(MOCK_SETTINGS),
    )


@pytest.fixture
def transport() -> RecordingTransport:
    return RecordingTransport()


@pytest.fixture
def dispatcher(transport: RecordingTransport) -> CallbackDispatcher:
    return CallbackDispatcher(transport=transport, allow_private_destinations=True)


@pytest.fixture
def mock_client(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    dispatcher: CallbackDispatcher,
) -> Iterator[TestClient]:
    """The hosted runtime, with the database and the outbound transport stubbed out."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
        patch("apiome_mock.server.record_mock_request"),
        patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
        patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=_compiled())),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = InMemorySessionStore(
                SessionCaps(ttl_seconds=3600.0, max_resources=50, max_bytes=1_048_576, max_sessions=50)
            )
            app.state.callback_dispatcher = dispatcher
            yield client
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def test_list_callbacks_reports_definitions_and_deployment_state(mock_client: TestClient) -> None:
    resp = mock_client.get(f"{CONTROL}/callbacks")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is True
    assert [entry["name"] for entry in body["callbacks"]] == ["bad-payload", "manual-only", "order-created"]
    created = next(entry for entry in body["callbacks"] if entry["name"] == "order-created")
    assert created["digest"] == callback_digest(ORDER_CREATED)
    assert created["destinations"] == [DESTINATION]
    assert created["retry"]["delaysMs"] == [1]


def test_list_callbacks_rejects_other_methods(mock_client: TestClient) -> None:
    resp = mock_client.post(f"{CONTROL}/callbacks")
    assert resp.status_code == 405
    assert "GET" in resp.headers["Allow"]


def test_unknown_callback_control_path_is_404_not_spec_routed(mock_client: TestClient) -> None:
    resp = mock_client.get(f"{CONTROL}/callbacks/order-created")
    assert resp.status_code == 404
    assert "/__mock__/callbacks" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Automatic firing
# ---------------------------------------------------------------------------


def test_a_served_operation_fires_its_callback_and_reports_the_outcome(
    mock_client: TestClient, transport: RecordingTransport
) -> None:
    resp = mock_client.post(f"{BASE}/orders", json={"id": "order-9"})
    assert resp.status_code == 201, resp.text
    assert resp.headers[CALLBACK_HEADER] == "order-created=delivered"
    assert len(transport.sent) == 1
    assert transport.sent[0].url == DESTINATION
    assert transport.sent[0].body == '{"event": "order.created", "id": "order-9"}'


def test_a_non_triggering_status_fires_nothing(mock_client: TestClient, transport: RecordingTransport) -> None:
    # The request body is invalid, so the operation answers 400 rather than its trigger status.
    resp = mock_client.post(f"{BASE}/orders", json={"nope": True})
    assert resp.status_code == 400
    assert CALLBACK_HEADER not in resp.headers
    assert transport.sent == []


def test_a_consumer_may_choose_an_allowlisted_receiver(mock_client: TestClient, transport: RecordingTransport) -> None:
    resp = mock_client.post(
        f"{BASE}/orders",
        json={"id": "order-9"},
        headers={CALLBACK_URL_HEADER: f"{DESTINATION}/tenant-a?token=abc"},
    )
    assert resp.headers[CALLBACK_HEADER] == "order-created=delivered"
    assert transport.sent[0].url == f"{DESTINATION}/tenant-a?token=abc"


def test_a_receiver_outside_the_allowlist_is_refused_not_delivered_to(
    mock_client: TestClient, transport: RecordingTransport
) -> None:
    resp = mock_client.post(
        f"{BASE}/orders",
        json={"id": "order-9"},
        headers={CALLBACK_URL_HEADER: "https://evil.example.com/steal"},
    )
    assert resp.status_code == 201
    assert resp.headers[CALLBACK_HEADER] == "order-created=rejected"
    assert transport.sent == []


def test_a_payload_failing_its_declared_schema_is_not_delivered(
    mock_client: TestClient, transport: RecordingTransport
) -> None:
    resp = mock_client.get(f"{BASE}/orders")
    assert resp.status_code == 200
    assert resp.headers[CALLBACK_HEADER] == "bad-payload=invalid-payload"
    assert transport.sent == []


def test_deliveries_are_visible_after_the_triggering_request(
    mock_client: TestClient, dispatcher: CallbackDispatcher
) -> None:
    mock_client.post(f"{BASE}/orders", json={"id": "order-9"})
    resp = mock_client.get(f"{CONTROL}/callbacks/deliveries")
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is True
    record = body["deliveries"][-1]
    assert record["callback"] == "order-created"
    assert record["outcome"] == "delivered"
    assert record["trigger"] == "POST /orders"
    assert record["destination"] == DESTINATION
    assert [attempt["attempt"] for attempt in record["attempts"]] == [1]


def test_deliveries_can_be_filtered_and_limited(mock_client: TestClient) -> None:
    mock_client.post(f"{BASE}/orders", json={"id": "a"})
    mock_client.get(f"{BASE}/orders")
    filtered = mock_client.get(f"{CONTROL}/callbacks/deliveries?callback=bad-payload").json()
    assert [record["callback"] for record in filtered["deliveries"]] == ["bad-payload"]
    limited = mock_client.get(f"{CONTROL}/callbacks/deliveries?limit=1").json()
    assert len(limited["deliveries"]) == 1
    ignored = mock_client.get(f"{CONTROL}/callbacks/deliveries?limit=not-a-number").json()
    assert len(ignored["deliveries"]) == 2


def test_retries_are_recorded_with_their_scheduled_delays(
    mock_client: TestClient, transport: RecordingTransport
) -> None:
    transport.script = [503, 200]
    mock_client.post(f"{BASE}/orders", json={"id": "order-9"})
    record = mock_client.get(f"{CONTROL}/callbacks/deliveries").json()["deliveries"][-1]
    assert record["outcome"] == "delivered"
    assert [(a["attempt"], a["delayMs"], a["status"]) for a in record["attempts"]] == [
        (1, 0, 503),
        (2, 1, 200),
    ]


# ---------------------------------------------------------------------------
# Explicit trigger
# ---------------------------------------------------------------------------


def test_trigger_delivers_a_callback_on_demand(mock_client: TestClient, transport: RecordingTransport) -> None:
    resp = mock_client.post(f"{CONTROL}/callbacks/manual-only/trigger")
    assert resp.status_code == 200, resp.text
    record = resp.json()
    assert record["outcome"] == "delivered"
    assert record["trigger"] == "manual"
    # The payload template read fixture data rather than a triggering request.
    assert transport.sent[0].body == '{"event": "manual", "id": "fixture-order"}'


def test_trigger_accepts_an_explicit_payload(mock_client: TestClient, transport: RecordingTransport) -> None:
    resp = mock_client.post(
        f"{CONTROL}/callbacks/manual-only/trigger",
        json={"payload": {"event": "override", "id": "given"}},
    )
    assert resp.json()["outcome"] == "delivered"
    assert transport.sent[0].body == '{"event": "override", "id": "given"}'


def test_trigger_validates_an_explicit_payload_against_the_declared_schema(
    mock_client: TestClient, transport: RecordingTransport
) -> None:
    resp = mock_client.post(
        f"{CONTROL}/callbacks/manual-only/trigger",
        json={"payload": {"event": "override"}},
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "invalid-payload"
    assert transport.sent == []


def test_trigger_rejects_a_destination_outside_the_allowlist(mock_client: TestClient) -> None:
    resp = mock_client.post(
        f"{CONTROL}/callbacks/manual-only/trigger",
        json={"destination": "https://evil.example.com/steal"},
    )
    assert resp.status_code == 403
    assert resp.json()["allowedDestinations"] == [DESTINATION]


def test_trigger_reports_an_unknown_callback(mock_client: TestClient) -> None:
    resp = mock_client.post(f"{CONTROL}/callbacks/nope/trigger")
    assert resp.status_code == 400
    assert resp.json()["availableCallbacks"] == ["bad-payload", "manual-only", "order-created"]


def test_trigger_rejects_malformed_bodies_and_methods(mock_client: TestClient) -> None:
    resp = mock_client.post(f"{CONTROL}/callbacks/manual-only/trigger", content=b"[]")
    assert resp.status_code == 400
    resp = mock_client.get(f"{CONTROL}/callbacks/manual-only/trigger")
    assert resp.status_code == 405
    resp = mock_client.post(f"{CONTROL}/callbacks/manual-only/trigger", json={"destination": ""})
    assert resp.status_code == 400


def test_trigger_is_reproducible_for_a_seed(mock_client: TestClient, transport: RecordingTransport) -> None:
    for _ in range(2):
        mock_client.post(f"{CONTROL}/callbacks/manual-only/trigger", json={"seed": 7})
    assert transport.sent[0].body == transport.sent[1].body


# ---------------------------------------------------------------------------
# Disabled deployments
# ---------------------------------------------------------------------------


@pytest.fixture
def disabled_client(monkeypatch: pytest.MonkeyPatch, mock_pool: object) -> Iterator[TestClient]:
    """The same runtime with outbound callbacks switched off — the default posture."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
        patch("apiome_mock.server.record_mock_request"),
        patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
        patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=_compiled())),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.callback_dispatcher = None
            yield client
    get_settings.cache_clear()


def test_a_disabled_deployment_still_lists_definitions(disabled_client: TestClient) -> None:
    body = disabled_client.get(f"{CONTROL}/callbacks").json()
    assert body["enabled"] is False
    assert len(body["callbacks"]) == 3


def test_a_disabled_deployment_delivers_nothing(disabled_client: TestClient) -> None:
    resp = disabled_client.post(f"{BASE}/orders", json={"id": "order-9"})
    assert resp.status_code == 201
    assert CALLBACK_HEADER not in resp.headers

    trigger = disabled_client.post(f"{CONTROL}/callbacks/manual-only/trigger")
    assert trigger.status_code == 503
    assert trigger.json()["title"] == "Callbacks Disabled"

    deliveries = disabled_client.get(f"{CONTROL}/callbacks/deliveries").json()
    assert deliveries == {"enabled": False, "deliveries": []}


# ---------------------------------------------------------------------------
# Portable parity
# ---------------------------------------------------------------------------


@pytest.fixture
def portable_client(transport: RecordingTransport) -> Iterator[TestClient]:
    """The portable runtime serving the same version from a bundle."""
    document = build_bundle(
        identity=BundleIdentity(
            tenant="demo",
            project="orders",
            version="1.0.0",
            revision_id=str(uuid4()),
        ),
        spec=ORDERS_SPEC,
        mock_settings=MOCK_SETTINGS,
    )
    bundle = load_bundle_document(document)
    settings = PortableSettings.isolated(bundle="unused")
    app = create_portable_app(bundle, settings)
    # The portable app builds no dispatcher unless --callbacks is set; swap in the recording one
    # so parity is asserted on behavior rather than on network access.
    app.state.callback_dispatcher = CallbackDispatcher(transport=transport, allow_private_destinations=True)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def test_the_bundle_carries_the_callback_definitions(portable_client: TestClient) -> None:
    body = portable_client.get(f"{CONTROL}/callbacks").json()
    created = next(entry for entry in body["callbacks"] if entry["name"] == "order-created")
    assert created["digest"] == callback_digest(ORDER_CREATED)


def test_the_portable_runtime_reports_its_callbacks_on_ready(portable_client: TestClient) -> None:
    ready = portable_client.get("/ready").json()
    assert ready["bundle"]["callbacks"] == ["bad-payload", "manual-only", "order-created"]


def test_a_portable_runtime_defaults_to_no_outbound_delivery() -> None:
    document = build_bundle(
        identity=BundleIdentity(
            tenant="demo",
            project="orders",
            version="1.0.0",
            revision_id=str(uuid4()),
        ),
        spec=ORDERS_SPEC,
        mock_settings=MOCK_SETTINGS,
    )
    app = create_portable_app(load_bundle_document(document), PortableSettings.isolated(bundle="unused"))
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get(f"{CONTROL}/callbacks").json()["enabled"] is False
        assert CALLBACK_HEADER not in client.post(f"{BASE}/orders", json={"id": "x"}).headers
