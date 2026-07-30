"""Registry audit log — list API (#3481, 7.4).

GET /v1/primitives/{tenant_slug}/audit reads the append-only apiome.registry_audit ledger,
tenant-scoped, newest first, with offset and cursor pagination. The DB is mocked; these assert
the envelope shape, filter/pagination plumbing, and the input validation guards. The endpoint
sits behind the same primitives-registry entitlement as the rest of the advanced surface, but
with the operator gating switch off (the default) it passes through to the authenticated tenant.
"""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "user_id": "11111111-2222-3333-4444-555555555555",
    "auth_method": "jwt",
}

_PRIMITIVE_ID = "33333333-4444-5555-6666-777777777777"


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _sample_row():
    return {
        "id": "aaaaaaaa-bbbb-cccc-dddd-000000000001",
        "tenant_id": _MOCK_AUTH["tenant_id"],
        "primitive_id": _PRIMITIVE_ID,
        "schema_id": "https://api.apiome.dev/types/tenant/acme/my-type",
        "namespace": "tenant/acme",
        "action": "primitive.create",
        "outcome": "success",
        "actor_id": _MOCK_AUTH["user_id"],
        "detail": {"name": "My Type", "category": "string"},
        "created_at": datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc),
    }


def test_registry_audit_offset_mode():
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 2
        mdb.search_registry_audit.return_value = [_sample_row()]
        r = client.get(
            f"/v1/primitives/t/audit?limit=1&offset=0&primitiveId={_PRIMITIVE_ID}"
        )
    assert r.status_code == 200
    data = r.json()
    assert data["schemaVersion"] == 1
    assert data["pagination"]["total"] == 2
    assert data["pagination"]["hasMore"] is True
    assert data["pagination"]["offset"] == 0
    assert data["pagination"]["nextOffset"] == 1
    assert data["pagination"]["nextCursor"] is not None
    item = data["items"][0]
    assert item["action"] == "primitive.create"
    assert item["tenantId"] == _MOCK_AUTH["tenant_id"]
    assert item["primitiveId"] == _PRIMITIVE_ID
    assert item["schemaId"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert item["namespace"] == "tenant/acme"
    # Filters are threaded through to the DB layer.
    mdb.search_registry_audit.assert_called_once()
    kw = mdb.search_registry_audit.call_args[1]
    assert kw["limit"] == 1
    assert kw["offset"] == 0
    assert kw["primitive_id"] == _PRIMITIVE_ID


def test_registry_audit_action_and_outcome_filters_passed_through():
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 0
        mdb.search_registry_audit.return_value = []
        r = client.get(
            "/v1/primitives/t/audit?action=primitive.create&action=primitive.delete&outcome=success"
        )
    assert r.status_code == 200
    kw = mdb.search_registry_audit.call_args[1]
    assert kw["actions"] == ["primitive.create", "primitive.delete"]
    assert kw["outcome"] == "success"


def test_registry_audit_cursor_and_offset_rejected():
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 0
        r = client.get(
            "/v1/primitives/t/audit?cursor=eyJ0IjoiMjAyNi0wNi0wMVQxMjowMDowMCswMDowMCIsImkiOiJhYWFhYWFhYS1iYmJiLWNjY2MtZGRkZC0wMDAwMDAwMDAwMDEifQ&offset=1"
        )
    assert r.status_code == 400


def test_registry_audit_invalid_outcome():
    with patch("app.registry_audit_routes.db"):
        r = client.get("/v1/primitives/t/audit?outcome=maybe")
    assert r.status_code == 400


def test_registry_audit_invalid_actor_id():
    with patch("app.registry_audit_routes.db"):
        r = client.get("/v1/primitives/t/audit?actorId=not-a-uuid")
    assert r.status_code == 400


def test_registry_audit_invalid_cursor():
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 0
        r = client.get("/v1/primitives/t/audit?cursor=not-valid")
    assert r.status_code == 400


def test_registry_audit_cursor_mode_next_cursor():
    row = _sample_row()
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 10
        mdb.search_registry_audit.return_value = [row, row]
        r = client.get("/v1/primitives/t/audit?limit=1")
    assert r.status_code == 200
    data = r.json()
    assert data["pagination"]["hasMore"] is True
    assert data["pagination"]["nextCursor"] is not None
    assert data["pagination"]["offset"] == 0
    nc = data["pagination"]["nextCursor"]
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 10
        mdb.search_registry_audit.return_value = []
        r2 = client.get(f"/v1/primitives/t/audit?limit=1&cursor={nc}")
    assert r2.status_code == 200
    assert r2.json()["pagination"]["offset"] is None
    ca = mdb.search_registry_audit.call_args[1]["cursor_created_at"]
    assert ca is not None
    assert mdb.search_registry_audit.call_args[1]["cursor_id"] == row["id"]


def test_registry_audit_route_not_shadowed_by_primitive_lookup():
    # The literal /audit segment must resolve to the audit list, not the primitives
    # /{tenant_slug}/{primitive_id} catch-all (which would 404 on a missing id).
    with patch("app.registry_audit_routes.db") as mdb:
        mdb.count_registry_audit_filtered.return_value = 0
        mdb.search_registry_audit.return_value = []
        r = client.get("/v1/primitives/t/audit")
    assert r.status_code == 200
    assert r.json()["items"] == []
