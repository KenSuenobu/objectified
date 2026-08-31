"""Endpoint tests for the export test-drive mock surface — MFX-44.5 (#4371).

Pins the route contract the Export Studio's Test-drive panel depends on:

* the capability endpoint answers honestly on a server with no mock infrastructure, so the Studio
  can hide (or disable-with-reason) the tab;
* one POST turns an emitted OpenAPI artifact into a live base URL, frozen from a **server-side**
  re-emit rather than a document posted by the browser;
* a target the engine cannot serve, a too-large document, and the per-tenant concurrency cap are
  each refused with their own status;
* an instance reports its own expiry countdown, and an expired one reads as ``expired`` rather
  than as an error;
* the request log is tenant-scoped and instance-scoped, and a hosted mock (#3615) is invisible here;
* teardown is a 204 that also discards the log.

The source loader is faked (its DB-backed logic is covered in ``test_export_source.py``); the
emitter runs for real, so the frozen document is a genuine emitted artifact.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.config import settings
from app.export_mock import EXPORT_MOCK_ORIGIN, mock_request_log
from app.export_source import ExportSource, ExportSourceError
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)

TENANT = "acme"
TENANT_ID = "tenant-1"
MOCK_ID = "00000000-0000-0000-0000-0000000000aa"
BASE = f"/v1/export/{TENANT}/mock"

_MOCK_AUTH = {"tenant_id": TENANT_ID, "user_id": "user-1", "auth_method": "jwt"}

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Widgets", "version": "1.0.0"},
    "paths": {
        "/widgets": {"get": {"operationId": "listWidgets", "responses": {"200": {"description": "ok"}}}}
    },
}


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request as one tenant, and start from an empty request log."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    mock_request_log.clear()
    yield
    app.dependency_overrides.clear()
    mock_request_log.clear()


def _source() -> ExportSource:
    """A loaded source: one REST operation over one record type, at a fixed revision."""
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string"))],
    )
    op = Operation(
        key="GET /widgets",
        name="listWidgets",
        kind=OperationKind.QUERY,
        http_method="GET",
        http_path="/widgets",
    )
    service = Service(key="widgets", name="widgets", operations=[op])
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        services=[service],
        types=[widget],
    )
    return ExportSource(
        api=api,
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


def _row(**overrides):
    """A representative test-drive ``mock_instances`` row as RealDictCursor returns it."""
    row = {
        "id": MOCK_ID,
        "tenant_id": TENANT_ID,
        "version_id": None,
        "tenant_slug": TENANT,
        "project_slug": "artifact-1",
        "version_slug": "1.0.0",
        "name": "OpenAPI 3.1 test drive",
        "spec": SPEC,
        "config": {
            "origin": EXPORT_MOCK_ORIGIN,
            "target": "openapi-3.1",
            "target_key": "openapi",
            "target_label": "OpenAPI 3.1",
            "artifact": "artifact-1",
            "version_label": "1.0.0",
            "ttl_minutes": 30,
            "scenarios": [],
            "active_scenario": "happy-path",
            "seed": 0,
        },
        "rate_limit_per_minute": 60,
        "status": "active",
        "created_by": "user-1",
        "request_count": 0,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=30),
        "last_activity_at": None,
    }
    row.update(overrides)
    return row


def _provision(body=None, *, source=None, create=None):
    """POST the provision route with the loader and the insert faked."""
    payload = {"artifact": "artifact-1", "version": "1.0.0", "target": "openapi"}
    payload.update(body or {})
    created = create or (lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]))
    with (
        patch(
            "app.export_mock_routes.load_export_source",
            return_value=source if source is not None else _source(),
        ),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[]),
        patch("app.export_mock_routes.db.delete_mock_instance", return_value=True),
        patch("app.export_mock_routes.db.create_mock_instance", side_effect=created),
    ):
        return client.post(BASE, json=payload)


# --------------------------------------------------------------------------- #
# Capability
# --------------------------------------------------------------------------- #


def test_capability_reports_available_with_the_bounds_it_will_apply():
    """The Studio renders its tab, and its terms, from this one call."""
    response = client.get(f"{BASE}/capability")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["reason"] is None
    assert "openapi" in body["supportedTargets"]
    assert body["defaultTtlMinutes"] >= 1
    assert body["maxTtlMinutes"] >= body["defaultTtlMinutes"]
    assert body["maxPerTenant"] >= 1
    assert body["rateLimitPerMinute"] >= 1


def test_capability_degrades_honestly_when_the_mock_engine_is_absent(monkeypatch):
    """Absent infrastructure is a 200 saying "no, because …", never a failure the UI must guess at."""
    monkeypatch.setattr(settings, "mock_server_enabled", False)
    response = client.get(f"{BASE}/capability")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert "Mock Server" in body["reason"]


def test_every_other_route_refuses_with_503_when_mocking_is_unavailable(monkeypatch):
    """Nothing can be provisioned or read on a server with no mock infrastructure."""
    monkeypatch.setattr(settings, "mock_server_enabled", False)
    assert client.post(BASE, json={"artifact": "a", "target": "openapi"}).status_code == 503
    assert client.get(BASE).status_code == 503
    assert client.get(f"{BASE}/{MOCK_ID}").status_code == 503
    assert client.get(f"{BASE}/{MOCK_ID}/requests").status_code == 503
    assert client.delete(f"{BASE}/{MOCK_ID}").status_code == 503


# --------------------------------------------------------------------------- #
# Provisioning
# --------------------------------------------------------------------------- #


def test_provision_returns_a_live_base_url_and_the_operations_it_serves():
    """One click, one live URL — the ticket's headline acceptance."""
    response = _provision()
    assert response.status_code == 201
    body = response.json()
    assert body["baseUrl"].endswith(f"/v1/mock/{MOCK_ID}")
    assert body["status"] == "active"
    assert body["target"] == "openapi-3.1"
    assert body["targetKey"] == "openapi"
    assert body["targetLabel"] == "OpenAPI 3.1"
    assert body["artifact"] == "artifact-1"
    assert body["version"] == "1.0.0"
    assert body["operationCount"] >= 1
    assert body["operations"][0]["method"] == "GET"
    assert body["expiresInSeconds"] > 0
    # The built-in scenarios are always offered, with happy-path in force.
    assert "happy-path" in body["scenarios"]
    assert body["activeScenario"] == "happy-path"


def test_provision_freezes_a_server_side_emit_not_a_client_supplied_document():
    """The mock provably serves what this revision emits — the browser never supplies bytes."""
    captured = {}

    def _create(**kwargs):
        captured.update(kwargs)
        return _row(spec=kwargs["spec"], config=kwargs["config"])

    assert _provision(create=_create).status_code == 201
    assert captured["spec"]["openapi"].startswith("3.1")
    assert "/widgets" in captured["spec"]["paths"]
    # No published version backs a test-drive mock; the column is nullable for exactly this.
    assert captured["version_id"] is None
    assert captured["tenant_id"] == TENANT_ID
    assert captured["config"]["origin"] == EXPORT_MOCK_ORIGIN


def test_provision_clamps_the_requested_ttl(monkeypatch):
    """A caller cannot hold a test-drive mock open past the configured ceiling."""
    monkeypatch.setattr(settings, "export_mock_max_ttl_minutes", 45)
    captured = {}

    def _create(**kwargs):
        captured.update(kwargs)
        return _row(spec=kwargs["spec"], config=kwargs["config"])

    assert _provision({"ttlMinutes": 6000}, create=_create).status_code == 201
    assert captured["config"]["ttl_minutes"] == 45
    span = captured["expires_at"] - datetime.now(timezone.utc)
    assert timedelta(minutes=44) < span <= timedelta(minutes=45)


def test_a_target_the_engine_cannot_serve_is_refused_with_400():
    """Non-OpenAPI targets are named as unmockable, with the mockable ones listed."""
    response = _provision({"target": "protobuf"})
    assert response.status_code == 400
    assert "mock engine can serve" in response.json()["detail"]


def test_an_unknown_target_is_refused_with_400():
    """A typo'd target fails at resolution, before any source load or emit."""
    response = _provision({"target": "not-a-target"})
    assert response.status_code == 400


def test_an_unknown_source_surfaces_the_loaders_status():
    """A missing artifact/version is the loader's 404, not a generic failure."""
    with (
        patch(
            "app.export_mock_routes.load_export_source",
            side_effect=ExportSourceError("Artifact not found", status_code=404),
        ),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[]),
    ):
        response = client.post(BASE, json={"artifact": "nope", "target": "openapi"})
    assert response.status_code == 404


def test_an_over_large_emitted_document_is_refused_with_413(monkeypatch):
    """The frozen-spec column is size-capped; the refusal states both sizes."""
    monkeypatch.setattr(settings, "export_mock_max_document_bytes", 64)
    response = _provision()
    assert response.status_code == 413
    assert "capped at" in response.json()["detail"]


def test_the_per_tenant_cap_refuses_a_further_mock_with_409(monkeypatch):
    """A workspace cannot accumulate live mocks; the refusal says how to make room."""
    monkeypatch.setattr(settings, "export_mock_max_per_tenant", 1)
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[_row()]),
    ):
        response = client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"})
    assert response.status_code == 409
    assert "Stop one" in response.json()["detail"]


def test_an_expired_mock_does_not_consume_the_cap(monkeypatch):
    """Otherwise a user could only wait out an expired instance to start a new one."""
    monkeypatch.setattr(settings, "export_mock_max_per_tenant", 1)
    expired = _row(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[expired]),
        patch("app.export_mock_routes.db.delete_mock_instance", return_value=True),
        patch(
            "app.export_mock_routes.db.create_mock_instance",
            side_effect=lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]),
        ),
    ):
        response = client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"})
    assert response.status_code == 201


def test_provisioning_reaps_this_tenants_lapsed_test_drive_mocks():
    """A minutes-scale mock would otherwise litter the table faster than anything cleans it."""
    expired = _row(id="expired-1", expires_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    mock_request_log.record(
        "expired-1",
        method="GET",
        path="/widgets",
        status=200,
        matched=True,
        scenario="happy-path",
        operation_key="GET /widgets",
        schema_valid=True,
        duration_ms=2,
    )
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[expired]),
        patch("app.export_mock_routes.db.delete_mock_instance", return_value=True) as delete,
        patch(
            "app.export_mock_routes.db.create_mock_instance",
            side_effect=lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]),
        ),
    ):
        assert client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"}).status_code == 201
    delete.assert_called_once_with("expired-1", TENANT_ID)
    assert mock_request_log.entries("expired-1") == []


def test_reaping_never_touches_a_hosted_mock_or_a_live_one():
    """The reap is narrow by construction: this tenant's *lapsed test-drive* rows and nothing else."""
    rows = [
        _row(id="live-1"),
        _row(
            id="hosted-expired",
            config={"origin": "hosted", "scenarios": []},
            expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        ),
    ]
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=rows),
        patch("app.export_mock_routes.db.delete_mock_instance") as delete,
        patch(
            "app.export_mock_routes.db.create_mock_instance",
            side_effect=lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]),
        ),
    ):
        assert client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"}).status_code == 201
    delete.assert_not_called()


def test_a_failed_reap_never_blocks_the_new_mock():
    """Tidying up is best-effort; a delete that fails must not turn into a refusal to start."""
    expired = _row(id="expired-1", expires_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[expired]),
        patch(
            "app.export_mock_routes.db.delete_mock_instance",
            side_effect=RuntimeError("connection lost"),
        ),
        patch(
            "app.export_mock_routes.db.create_mock_instance",
            side_effect=lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]),
        ),
    ):
        response = client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"})
    assert response.status_code == 201


def test_a_hosted_mock_does_not_consume_the_export_cap(monkeypatch):
    """The two kinds share a table but not a budget — only test drives count here."""
    monkeypatch.setattr(settings, "export_mock_max_per_tenant", 1)
    hosted = _row(config={"origin": "hosted", "scenarios": []})
    with (
        patch("app.export_mock_routes.load_export_source", return_value=_source()),
        patch("app.export_mock_routes.db.list_mock_instances", return_value=[hosted]),
        patch(
            "app.export_mock_routes.db.create_mock_instance",
            side_effect=lambda **kwargs: _row(spec=kwargs["spec"], config=kwargs["config"]),
        ),
    ):
        response = client.post(BASE, json={"artifact": "artifact-1", "target": "openapi"})
    assert response.status_code == 201


# --------------------------------------------------------------------------- #
# Listing / inspecting
# --------------------------------------------------------------------------- #


def test_listing_returns_only_live_test_drive_mocks():
    """Expired instances and hosted mocks are both omitted."""
    rows = [
        _row(),
        _row(id="expired", expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)),
        _row(id="hosted", config={"origin": "hosted", "scenarios": []}),
    ]
    with patch("app.export_mock_routes.db.list_mock_instances", return_value=rows):
        response = client.get(BASE)
    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()] == [MOCK_ID]


def test_inspecting_reports_a_server_computed_countdown():
    """The Studio's countdown never depends on the browser clock."""
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=_row()):
        response = client.get(f"{BASE}/{MOCK_ID}")
    assert response.status_code == 200
    body = response.json()
    assert 0 < body["expiresInSeconds"] <= 30 * 60
    assert body["status"] == "active"


def test_an_expired_instance_reads_as_expired_rather_than_as_an_error():
    """"It ran out" is a state the panel shows, not a failure it has to interpret."""
    expired = _row(expires_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=expired):
        response = client.get(f"{BASE}/{MOCK_ID}")
    assert response.status_code == 200
    assert response.json()["status"] == "expired"
    assert response.json()["expiresInSeconds"] == 0


def test_a_hosted_mock_is_not_reachable_through_the_export_surface():
    """Hosted mocks are managed on /v1/mocks/… — here they are simply not found."""
    hosted = _row(config={"origin": "hosted", "scenarios": []})
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=hosted):
        response = client.get(f"{BASE}/{MOCK_ID}")
    assert response.status_code == 404


def test_another_tenants_mock_is_not_found():
    """Tenant scoping is the DB lookup's job; the route simply cannot see the row."""
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=None):
        assert client.get(f"{BASE}/{MOCK_ID}").status_code == 404


# --------------------------------------------------------------------------- #
# The request log
# --------------------------------------------------------------------------- #


def test_the_request_log_returns_what_the_data_plane_recorded():
    """The panel's rows are exactly the mock's served traffic, newest first."""
    mock_request_log.record(
        MOCK_ID,
        method="GET",
        path="/widgets",
        status=200,
        matched=True,
        scenario="happy-path",
        operation_key="GET /widgets",
        schema_valid=True,
        duration_ms=4,
    )
    mock_request_log.record(
        MOCK_ID,
        method="GET",
        path="/nope",
        status=404,
        matched=False,
        scenario="happy-path",
        operation_key=None,
        schema_valid=None,
        duration_ms=1,
    )
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=_row()):
        response = client.get(f"{BASE}/{MOCK_ID}/requests")
    assert response.status_code == 200
    body = response.json()
    assert body["mockId"] == MOCK_ID
    assert [entry["path"] for entry in body["entries"]] == ["/nope", "/widgets"]
    assert body["entries"][0]["matched"] is False
    assert body["entries"][0]["schemaValid"] is None
    assert body["entries"][1]["operationId"] == "GET /widgets"
    assert body["retained"] == 2
    assert body["truncated"] is False


def test_the_request_log_reports_truncation_against_the_lifetime_count():
    """A mock that outran the ring buffer says so rather than implying it served two requests."""
    mock_request_log.record(
        MOCK_ID,
        method="GET",
        path="/widgets",
        status=200,
        matched=True,
        scenario="happy-path",
        operation_key="GET /widgets",
        schema_valid=True,
        duration_ms=4,
    )
    with patch(
        "app.export_mock_routes.db.get_mock_instance_for_tenant",
        return_value=_row(request_count=500),
    ):
        response = client.get(f"{BASE}/{MOCK_ID}/requests")
    assert response.json()["truncated"] is True


def test_the_request_log_honours_the_limit():
    """A long-lived panel poll can ask for just the newest few."""
    for index in range(5):
        mock_request_log.record(
            MOCK_ID,
            method="GET",
            path=f"/w/{index}",
            status=200,
            matched=True,
            scenario="happy-path",
            operation_key="GET /w/{id}",
            schema_valid=True,
            duration_ms=1,
        )
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=_row()):
        response = client.get(f"{BASE}/{MOCK_ID}/requests?limit=2")
    body = response.json()
    assert len(body["entries"]) == 2
    assert body["retained"] == 5


def test_the_request_log_of_an_unknown_mock_is_not_found():
    """A log read is as tenant-scoped as the instance it describes."""
    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=None):
        assert client.get(f"{BASE}/{MOCK_ID}/requests").status_code == 404


# --------------------------------------------------------------------------- #
# Teardown
# --------------------------------------------------------------------------- #


def test_stopping_a_mock_deletes_it_and_discards_its_log():
    """"Stop" frees the URL, the concurrency budget, and the retained traffic."""
    mock_request_log.record(
        MOCK_ID,
        method="GET",
        path="/widgets",
        status=200,
        matched=True,
        scenario="happy-path",
        operation_key="GET /widgets",
        schema_valid=True,
        duration_ms=4,
    )
    with (
        patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=_row()),
        patch("app.export_mock_routes.db.delete_mock_instance", return_value=True) as delete,
    ):
        response = client.delete(f"{BASE}/{MOCK_ID}")
    assert response.status_code == 204
    delete.assert_called_once_with(MOCK_ID, TENANT_ID)
    assert mock_request_log.entries(MOCK_ID) == []


def test_stopping_an_unknown_mock_is_not_found():
    """Nothing is deleted for an id this tenant does not own."""
    with (
        patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=None),
        patch("app.export_mock_routes.db.delete_mock_instance") as delete,
    ):
        assert client.delete(f"{BASE}/{MOCK_ID}").status_code == 404
    delete.assert_not_called()


# --------------------------------------------------------------------------- #
# The data-plane binding
# --------------------------------------------------------------------------- #

# The frozen document the served-request tests replay from: one operation with a real response
# schema, so a matched request comes back schema-shaped rather than empty.
_SERVED_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Widgets", "version": "1.0.0"},
    "paths": {
        "/widgets": {
            "get": {
                "operationId": "listWidgets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["id", "name"],
                                    "properties": {
                                        "id": {"type": "integer"},
                                        "name": {"type": "string"},
                                    },
                                }
                            }
                        },
                    }
                },
            }
        }
    },
}


def _sandbox_serving(result):
    """Patch the data plane onto a stubbed, configured mock engine (#5532, MSC-2.2)."""

    async def _serve(**_kwargs):
        return result

    return (
        patch("app.mock_routes.sandbox_is_configured", return_value=True),
        patch("app.mock_routes.request_sandbox_serve", _serve),
        patch("app.mock_routes.db.touch_mock_instance"),
    )


def test_a_request_to_the_mock_round_trips_with_a_schema_shaped_body_and_is_logged():
    """The ticket's second acceptance: real requests, schema-shaped responses, visible in the log.

    Since #5532 the response comes from the one mock engine rather than a second resolver living
    in this service, so the hop is stubbed here; what the engine decides is tested in apiome-mock.
    """
    row = _row(spec=_SERVED_SPEC)
    served_payload = {
        "status": 200,
        "headers": {"content-type": "application/json", "X-Mock-Schema-Valid": "true"},
        "mediaType": "application/json",
        "body": {"id": 1, "name": "Widget"},
        "bodyEncoding": "json",
        "operation": "GET /widgets",
        "scenario": None,
        "schemaValid": True,
    }
    guards = _sandbox_serving(served_payload)
    with (
        patch("app.mock_routes.db.get_mock_instance", return_value=row),
        guards[0],
        guards[1],
        guards[2],
    ):
        served = client.get(f"/v1/mock/{MOCK_ID}/widgets")

    assert served.status_code == 200
    assert served.headers["X-Mock-Schema-Valid"] == "true"
    body = served.json()
    assert isinstance(body["id"], int)
    assert isinstance(body["name"], str)

    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=row):
        log = client.get(f"{BASE}/{MOCK_ID}/requests").json()
    assert log["entries"][0]["path"] == "/widgets"
    assert log["entries"][0]["method"] == "GET"
    assert log["entries"][0]["status"] == 200
    assert log["entries"][0]["matched"] is True
    assert log["entries"][0]["operationId"] == "GET /widgets"
    assert log["entries"][0]["schemaValid"] is True


def test_an_unmatched_request_is_logged_as_unmatched():
    """A 404 from the mock is traffic the panel must show, not silence."""
    row = _row(spec=_SERVED_SPEC)
    served_payload = {
        "status": 404,
        "headers": {"content-type": "application/problem+json"},
        "mediaType": "application/problem+json",
        "body": {"title": "Not Found", "status": 404},
        "bodyEncoding": "json",
        "operation": None,
        "scenario": None,
        "schemaValid": None,
    }
    guards = _sandbox_serving(served_payload)
    with (
        patch("app.mock_routes.db.get_mock_instance", return_value=row),
        guards[0],
        guards[1],
        guards[2],
    ):
        assert client.get(f"/v1/mock/{MOCK_ID}/nope").status_code == 404

    with patch("app.export_mock_routes.db.get_mock_instance_for_tenant", return_value=row):
        entry = client.get(f"{BASE}/{MOCK_ID}/requests").json()["entries"][0]
    assert entry["path"] == "/nope"
    assert entry["matched"] is False
    assert entry["schemaValid"] is None
    assert entry["operationId"] is None


def test_an_expired_mock_stops_serving_and_says_so():
    """The TTL is the teardown: the same URL answers 410 Gone once it lapses."""
    expired = _row(spec=_SERVED_SPEC, expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    with patch("app.mock_routes.db.get_mock_instance", return_value=expired):
        response = client.get(f"/v1/mock/{MOCK_ID}/widgets")
    assert response.status_code == 410
    assert "expired" in response.json()["detail"]
