"""Registry audit writes on governed primitive actions (#3481, 7.4).

Each governed mutation — create, update, delete, import — must append exactly one row to the
apiome.registry_audit ledger with the acting user and the affected type's identity. The DB is
mocked, so these assert that ``db.insert_registry_audit`` is invoked with the right action and
context, and that audit writes are best-effort (a failed write never fails the action).
"""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.registry_audit import (
    ACTION_CREATE,
    ACTION_DELETE,
    ACTION_IMPORT,
    ACTION_UPDATE,
)

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}
_NOW = datetime(2026, 6, 23, 12, 0, 0, tzinfo=timezone.utc)
_VALID_SCHEMA = {"type": "string"}


def _row(**overrides):
    """A representative apiome.primitives row as returned by the DB layer."""
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "My Type",
        "description": None,
        "category": "string",
        "schema": _VALID_SCHEMA,
        "tags": [],
        "created_by": "u1",
        "is_system": False,
        "is_public": False,
        "usage_count": 0,
        "source": "human",
        "schema_id": "https://api.apiome.dev/types/tenant/acme/my-type",
        "draft": "2020-12",
        "namespace": None,
        "base_uri": "https://api.apiome.dev/types/tenant/acme/",
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


def test_create_writes_audit_row():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None  # gate on
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": _VALID_SCHEMA},
        )
    assert r.status_code == 200
    mdb.insert_registry_audit.assert_called_once()
    args, kwargs = mdb.insert_registry_audit.call_args
    assert args[0] == "t1"  # tenant_id
    assert args[1] == ACTION_CREATE
    assert args[2] == "success"
    assert kwargs["primitive_id"] == "p1"
    assert kwargs["actor_id"] == "u1"
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert kwargs["detail"]["name"] == "My Type"
    assert kwargs["detail"]["category"] == "string"


def test_create_audit_not_written_when_validation_blocks():
    # An invalid schema rejected by the gate never persists, so it must not be audited.
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None  # gate on
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "Bad", "category": "string", "schema": {"type": "nope"}},
        )
    assert r.status_code == 422
    mdb.create_primitive.assert_not_called()
    mdb.insert_registry_audit.assert_not_called()


def test_update_writes_audit_row_with_changed_fields():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None
        mdb.get_primitive_by_id.return_value = _row(schema={"type": "string"})
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.update_primitive.return_value = _row(description="updated")
        r = client.put(
            "/v1/primitives/acme/p1",
            json={"description": "updated"},
        )
    assert r.status_code == 200
    mdb.insert_registry_audit.assert_called_once()
    args, kwargs = mdb.insert_registry_audit.call_args
    assert args[1] == ACTION_UPDATE
    assert kwargs["primitive_id"] == "p1"
    assert kwargs["detail"]["changed_fields"] == ["description"]


def test_delete_writes_audit_row():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row()
        mdb.delete_primitive.return_value = True
        r = client.delete("/v1/primitives/acme/p1")
    assert r.status_code == 200
    mdb.insert_registry_audit.assert_called_once()
    args, kwargs = mdb.insert_registry_audit.call_args
    assert args[1] == ACTION_DELETE
    assert kwargs["primitive_id"] == "p1"
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert kwargs["detail"]["name"] == "My Type"


def test_delete_audit_not_written_for_missing_primitive():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = None
        r = client.delete("/v1/primitives/acme/does-not-exist")
    assert r.status_code == 404
    mdb.insert_registry_audit.assert_not_called()


def test_import_writes_single_audit_row():
    def _create(**kwargs):
        return {"name": kwargs["name"], "refs": kwargs.get("refs", [])}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp-1"}
        r = client.post(
            "/v1/primitives/std/import",
            json={
                "schema": {"types": {"Order": {"type": "object"}}},
                "import_all": True,
                "source_kind": "type-def-bundle",
                "target_namespace": "std/v0/types",
            },
        )
    assert r.status_code == 200
    mdb.insert_registry_audit.assert_called_once()
    args, kwargs = mdb.insert_registry_audit.call_args
    assert args[1] == ACTION_IMPORT
    assert args[2] == "success"  # outcome (positional)
    assert kwargs["namespace"] == "std/v0/types"
    assert kwargs["detail"]["import_id"] == "imp-1"
    assert kwargs["detail"]["total_imported"] == 1


def test_audit_write_failure_does_not_fail_the_action():
    # insert_registry_audit is best-effort at the DB layer; even if the helper raised, the
    # create response must still succeed. Here the DB call records but we simulate a raising
    # accessor to prove the route does not surface it.
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_type_registry_settings.return_value = None
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        mdb.insert_registry_audit.side_effect = RuntimeError("db down")
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": _VALID_SCHEMA},
        )
    # The action itself succeeded; the audit raise is swallowed by the route's best-effort path.
    assert r.status_code == 200
