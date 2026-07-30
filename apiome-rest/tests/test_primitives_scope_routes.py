"""API tests for registry scope & visibility enforcement on the Primitives CRUD (#3453).

Covers create / update / import: a system-core type that ``$ref``s a tenant namespace is
rejected at the REST boundary with structured violations, a tenant type that ``$ref``s
another tenant's namespace is rejected, and the allowed directions (tenant→core, tenant→own)
persist. The read-scope half of #3453 is enforced in the DB layer and unit-tested separately.
"""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}
_NOW = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)

BASE = "https://api.apiome.dev/types/"
STD_REF = BASE + "std/v0/primitives/uuid"
ACME_REF = BASE + "tenant/acme/v1/types/money"
GLOBEX_REF = BASE + "tenant/globex/v1/types/widget"


def _row(**overrides):
    """A representative apiome.primitives row as returned by the DB layer."""
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "My Type",
        "description": None,
        "category": "object",
        "schema": {"type": "object"},
        "tags": [],
        "created_by": "u1",
        "is_system": False,
        "is_public": False,
        "usage_count": 0,
        "source": "human",
        "schema_id": None,
        "draft": "2020-12",
        "namespace": None,
        "base_uri": None,
        "created_at": _NOW,
        "updated_at": _NOW,
        "enabled": True,
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


# ===========================================================================
# CREATE — core → tenant is rejected
# ===========================================================================


def test_create_core_type_referencing_tenant_namespace_rejected():
    with patch("app.primitives_routes.db") as mdb:
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "CoreThing",
                "category": "object",
                "namespace": "std/v0/primitives",
                "schema": {"type": "object", "properties": {"m": {"$ref": ACME_REF}}},
            },
        )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "system-core" in detail["message"]
    assert detail["violations"][0]["reason"] == "core-to-tenant"
    assert detail["violations"][0]["$ref"] == ACME_REF
    # A scope violation never reaches the database.
    mdb.create_primitive.assert_not_called()


def test_create_tenant_type_referencing_core_is_allowed():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row(name="Order")
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "Order",
                "category": "object",
                "schema": {"type": "object", "properties": {"id": {"$ref": STD_REF}}},
            },
        )
    assert r.status_code == 200
    mdb.create_primitive.assert_called_once()


def test_create_tenant_type_referencing_other_tenant_rejected():
    with patch("app.primitives_routes.db") as mdb:
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "Order",
                "category": "object",
                "schema": {"type": "object", "properties": {"w": {"$ref": GLOBEX_REF}}},
            },
        )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "another tenant" in detail["message"]
    assert detail["violations"][0]["reason"] == "cross-tenant"
    mdb.create_primitive.assert_not_called()


def test_create_tenant_type_referencing_own_namespace_is_allowed():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row(name="Invoice")
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "Invoice",
                "category": "object",
                "namespace": "tenant/acme/v1/types",
                "schema": {"type": "object", "properties": {"m": {"$ref": ACME_REF}}},
            },
        )
    assert r.status_code == 200
    mdb.create_primitive.assert_called_once()


# ===========================================================================
# UPDATE — re-placing into core enforces the rule
# ===========================================================================


def test_update_into_core_namespace_with_tenant_ref_rejected():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row(name="My Type")
        r = client.put(
            "/v1/primitives/acme/p1",
            json={
                "namespace": "std/v0/primitives",
                "schema": {"type": "object", "properties": {"m": {"$ref": ACME_REF}}},
            },
        )
    assert r.status_code == 422
    assert r.json()["detail"]["violations"][0]["reason"] == "core-to-tenant"
    mdb.update_primitive.assert_not_called()


# ===========================================================================
# IMPORT — same enforcement per definition
# ===========================================================================


def test_import_rejects_scope_violating_definition_but_imports_valid():
    def _create(**kwargs):
        return {"name": kwargs["name"]}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        mdb.get_primitive_by_schema_id.return_value = None  # clean registry — all New (#3464)
        r = client.post(
            "/v1/primitives/acme/import",
            json={
                "schema": {
                    "$defs": {
                        "Good": {"type": "object", "properties": {"id": {"$ref": STD_REF}}},
                        "Bad": {"type": "object", "properties": {"m": {"$ref": ACME_REF}}},
                    }
                },
                "import_all": True,
                "target_namespace": "std/v0/primitives",
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == ["Good"]
    err = next(e for e in body["errors"] if e["name"] == "Bad")
    assert err["error"] == "scope_violation"
    assert err["details"][0]["reason"] == "core-to-tenant"
    # Only the allowed definition is created.
    assert mdb.create_primitive.call_count == 1
