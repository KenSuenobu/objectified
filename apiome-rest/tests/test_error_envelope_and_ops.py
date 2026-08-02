"""Integration tests for the error envelope, request-id middleware, health probes, and ops
dashboard (RC1-3.2, #3617).

These drive the real FastAPI app via TestClient so the middleware stack, exception handlers, and
routes are exercised end to end.
"""

from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.config import settings
from app.main import app

client = TestClient(app)

_AUTH = {
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_id": "22222222-2222-2222-2222-222222222222",
    "auth_method": "jwt",
    "user_email": "ops@acme.io",
}


# ---------------------------------------------------------------------------
# Request id middleware
# ---------------------------------------------------------------------------


def test_response_carries_request_id_header():
    r = client.get("/livez")
    assert r.status_code == 200
    assert r.headers.get(settings.request_id_header)


def test_incoming_request_id_is_reused():
    rid = "client-supplied-id-123"
    r = client.get("/livez", headers={settings.request_id_header: rid})
    assert r.headers.get(settings.request_id_header) == rid


# ---------------------------------------------------------------------------
# Error envelope
# ---------------------------------------------------------------------------


def test_404_has_consistent_envelope():
    # A deliberately unknown path yields Starlette's 404, routed through our exception handler.
    r = client.get("/this-route-does-not-exist")
    assert r.status_code == 404
    body = r.json()
    assert "detail" in body  # preserved for backward compatibility
    assert body["error"]["status"] == 404
    assert body["error"]["type"] == "http_error"
    # request id in the body matches the response header.
    assert body["request_id"] == r.headers.get(settings.request_id_header)
    assert body["error"]["request_id"] == body["request_id"]


def test_http_exception_detail_preserved():
    """A route-raised HTTPException keeps its detail string and gains the envelope."""

    @app.get("/_test_only_boom")
    async def _boom():
        raise HTTPException(status_code=403, detail="nope, forbidden")

    try:
        r = client.get("/_test_only_boom")
        assert r.status_code == 403
        body = r.json()
        assert body["detail"] == "nope, forbidden"
        assert body["error"]["message"] == "nope, forbidden"
        assert body["error"]["status"] == 403
    finally:
        # Remove the throwaway route so it does not leak into other tests.
        app.router.routes = [
            route for route in app.router.routes
            if getattr(route, "path", None) != "/_test_only_boom"
        ]


def test_unhandled_exception_returns_safe_500_envelope():
    @app.get("/_test_only_explode")
    async def _explode():
        raise RuntimeError("internal secret detail that must not leak")

    try:
        # raise_server_exceptions=False so TestClient returns the 500 response instead of re-raising.
        local = TestClient(app, raise_server_exceptions=False)
        r = local.get("/_test_only_explode")
        assert r.status_code == 500
        body = r.json()
        assert body["error"]["type"] == "internal_error"
        assert body["error"]["status"] == 500
        # The internal exception message must not be surfaced to the client.
        assert "internal secret detail" not in str(body)
        assert body["detail"] == "Internal server error"
        # The 500 still carries the correlation id in both the body and the response header, so an
        # operator can tie the client's report to the logged stack trace.
        assert body["request_id"]
        assert r.headers.get(settings.request_id_header) == body["request_id"]
    finally:
        app.router.routes = [
            route for route in app.router.routes
            if getattr(route, "path", None) != "/_test_only_explode"
        ]


# ---------------------------------------------------------------------------
# Health / readiness probes
# ---------------------------------------------------------------------------


def test_livez_does_not_touch_db():
    # No DB patching: liveness must succeed regardless of database state.
    r = client.get("/livez")
    assert r.status_code == 200
    assert r.json()["status"] == "alive"


def test_readyz_ok_when_db_reachable():
    with patch("app.ops_routes.db") as mdb:
        mdb.execute_query.return_value = [{"ok": 1}]
        r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ready", "database": "connected"}


def test_readyz_503_when_db_down():
    with patch("app.ops_routes.db") as mdb:
        mdb.execute_query.side_effect = Exception("connection refused")
        r = client.get("/readyz")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "not_ready"
    assert body["database"] == "unavailable"


def test_health_backward_compatible_shape():
    with patch("app.ops_routes.db") as mdb:
        mdb.execute_query.return_value = [{"ok": 1}]
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy", "database": "connected"}


def test_health_unhealthy_when_db_down():
    with patch("app.ops_routes.db") as mdb:
        mdb.execute_query.side_effect = Exception("boom")
        r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["status"] == "unhealthy"


# ---------------------------------------------------------------------------
# Ops dashboard (platform-admin gated)
# ---------------------------------------------------------------------------


@pytest.fixture
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_ops_metrics_requires_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = False
        r = client.get("/v1/ops/metrics")
    assert r.status_code == 403


def test_ops_metrics_for_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/metrics")
    assert r.status_code == 200
    body = r.json()
    for key in ("total_requests", "error_rate", "requests_per_second", "latency_ms", "in_flight"):
        assert key in body


def test_ops_backups_for_platform_admin_unconfigured(_auth_override, monkeypatch):
    monkeypatch.setattr(settings, "backup_dir", None)
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/backups")
    assert r.status_code == 200
    assert r.json()["status"] == "unconfigured"


def test_ops_status_combines_metrics_and_backups(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/status")
    assert r.status_code == 200
    body = r.json()
    assert "metrics" in body and "backups" in body


def test_ops_dashboard_renders_html(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/dashboard")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "Ops Dashboard" in r.text


def test_ops_dashboard_requires_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = False
        r = client.get("/v1/ops/dashboard")
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# IXH-6.6: import/export observability operator view
# ---------------------------------------------------------------------------


def test_ops_import_export_requires_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = False
        r = client.get("/v1/ops/import-export")
    assert r.status_code == 403


def test_ops_import_export_renders_the_aggregates_and_documented_tags(_auth_override):
    """The operator view: the three metric families plus the complete documented tag
    set every metric key is drawn from, and the per-replica scope statement."""
    from app.import_export_metrics import import_export_metrics

    import_export_metrics.reset()
    try:
        import_export_metrics.record_stage(kind="import", stage="parse", duration_ms=42)
        import_export_metrics.record_failure(
            kind="import", code="INPUT_MALFORMED", adapter_or_target="asyncapi"
        )
        with patch("app.ops_routes.db") as mdb:
            mdb.is_platform_admin.return_value = True
            r = client.get("/v1/ops/import-export")
        assert r.status_code == 200
        body = r.json()
        assert body["import_export"]["stages"]["import"]["parse"]["completed"]["count"] == 1
        assert body["import_export"]["failures"]["import"]["INPUT_MALFORMED"]["asyncapi"] == 1
        tags = body["documented_tags"]
        assert set(tags["kinds"]) == {"import", "export"}
        assert "parse" in tags["stages"]["import"]
        assert "packaging" in tags["stages"]["export"]
        assert "INPUT_MALFORMED" in tags["failure_codes"]["import"]
        assert "SOURCE_LOAD_FAILED" in tags["failure_codes"]["export"]
        assert body["scope"] == {"per_replica": True, "resets_on_restart": True}
    finally:
        import_export_metrics.reset()


def test_ops_metrics_payload_includes_import_export(_auth_override):
    """The general metrics payload (and thus /v1/ops/status + the dashboard poll)
    carries the import/export aggregates."""
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/metrics")
    assert r.status_code == 200
    body = r.json()
    assert set(body["import_export"]) == {"stages", "jobs", "failures"}


def test_ops_dashboard_renders_import_export_cards(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/dashboard")
    assert r.status_code == 200
    assert "Import/Export jobs" in r.text
    assert "Import/Export failures" in r.text
