"""API tests for server-side draft 2020-12 validation on the Primitives CRUD (#3452).

Covers create / update / import: invalid schemas are rejected at the REST boundary with
field-level errors, valid types persist with a stable derived ``$id`` (``schema_id``) and a
stamped ``draft``, an author-declared ``$id`` is honored, and the import path runs the same
validator per definition.
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


def _row(**overrides):
    """A representative apiome.primitives row as returned by the DB layer."""
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "My Type",
        "description": None,
        "category": "string",
        "schema": {"type": "string"},
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
# CREATE — validation
# ===========================================================================


def test_create_rejects_invalid_schema_with_field_errors():
    with patch("app.primitives_routes.db") as mdb:
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "Bad", "category": "string", "schema": {"type": "stringg"}},
        )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "draft 2020-12" in detail["message"]
    assert detail["errors"][0]["path"] == "type"
    # An invalid schema never reaches the database.
    mdb.create_primitive.assert_not_called()


def test_create_persists_derived_schema_id_and_draft():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row(
            schema_id="https://api.apiome.dev/types/tenant/acme/my-type",
            base_uri="https://api.apiome.dev/types/tenant/acme/",
        )
        r = client.post(
            "/v1/primitives/acme",
            json={"name": "My Type", "category": "string", "schema": {"type": "string"}},
        )
    assert r.status_code == 200
    kwargs = mdb.create_primitive.call_args.kwargs
    # Derived against the tenant-default base URI from the URL slug.
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert kwargs["draft"] == "2020-12"
    assert kwargs["base_uri"] == "https://api.apiome.dev/types/tenant/acme/"
    # The persisted schema is stamped with its $id.
    assert kwargs["schema"]["$id"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert kwargs["schema"]["$schema"].endswith("/draft/2020-12/schema")


def test_create_honors_author_declared_id():
    declared = "https://api.apiome.dev/types/std/v0/primitives/string"
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row(schema_id=declared)
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "My Type",
                "category": "string",
                "schema": {"$id": declared, "type": "string"},
            },
        )
    assert r.status_code == 200
    assert mdb.create_primitive.call_args.kwargs["schema_id"] == declared


def test_create_uses_namespace_for_base_uri():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/acme",
            json={
                "name": "Money",
                "category": "object",
                "schema": {"type": "object"},
                "namespace": "tenant/acme/v1/types",
            },
        )
    assert r.status_code == 200
    kwargs = mdb.create_primitive.call_args.kwargs
    assert kwargs["base_uri"] == "https://api.apiome.dev/types/tenant/acme/v1/types/"
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/v1/types/money"
    assert kwargs["namespace"] == "tenant/acme/v1/types"


# ===========================================================================
# UPDATE — validation
# ===========================================================================


def test_update_rejects_invalid_schema():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row()
        r = client.put(
            "/v1/primitives/acme/p1",
            json={"schema": {"type": "nope"}},
        )
    assert r.status_code == 422
    assert r.json()["detail"]["errors"][0]["path"] == "type"
    mdb.update_primitive.assert_not_called()


def test_update_rederives_identity_on_schema_change():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row(name="My Type")
        mdb.update_primitive.return_value = _row(schema={"type": "integer"})
        r = client.put(
            "/v1/primitives/acme/p1",
            json={"schema": {"type": "integer"}},
        )
    assert r.status_code == 200
    updates = mdb.update_primitive.call_args.args[2]
    assert updates["schema_id"] == "https://api.apiome.dev/types/tenant/acme/my-type"
    assert updates["draft"] == "2020-12"
    assert updates["schema"]["$id"].endswith("/my-type")


def test_update_system_primitive_forbidden_before_validation():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row(is_system=True)
        r = client.put("/v1/primitives/acme/p1", json={"schema": {"type": "nope"}})
    assert r.status_code == 403
    mdb.update_primitive.assert_not_called()


def test_update_metadata_only_does_not_touch_identity():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row()
        mdb.update_primitive.return_value = _row(description="updated")
        r = client.put("/v1/primitives/acme/p1", json={"description": "updated"})
    assert r.status_code == 200
    updates = mdb.update_primitive.call_args.args[2]
    assert "schema_id" not in updates and "schema" not in updates


# ===========================================================================
# IMPORT — same validator per definition
# ===========================================================================


def test_import_rejects_invalid_definition_but_imports_valid():
    def _create(**kwargs):
        return {"name": kwargs["name"]}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        mdb.get_primitive_by_schema_id.return_value = None  # clean registry — all New (#3464)
        mdb.get_primitive_by_namespace_name.return_value = None
        r = client.post(
            "/v1/primitives/acme/import",
            json={
                "schema": {
                    "$defs": {
                        "Good": {"type": "string"},
                        "Bad": {"type": "stringg"},
                    }
                },
                "import_all": True,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == ["Good"]
    assert body["total_errors"] == 1
    err = next(e for e in body["errors"] if e["name"] == "Bad")
    assert err["error"] == "invalid_schema"
    assert err["details"][0]["path"] == "type"
    # Only the valid definition is created.
    assert mdb.create_primitive.call_count == 1


def test_import_rewrites_internal_defs_refs_to_relative_registry_edges():
    """#3463: a committed primitive's intra-doc #/$defs edges are rewritten relative + resolved.

    The #/$defs/Currency sibling pointer becomes ./currency and is resolved against the import's
    base URI like any registry ref (#3456) — no leftover 'internal' fragment pointer remains.
    """
    captured = {}

    def _create(**kwargs):
        captured[kwargs["name"]] = kwargs
        return {"name": kwargs["name"]}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        mdb.get_primitive_by_schema_id.return_value = None  # no cross-type targets exist
        mdb.get_primitive_by_namespace_name.return_value = None
        r = client.post(
            "/v1/primitives/acme/import",
            json={
                "schema": {
                    "$defs": {
                        "Money": {
                            "type": "object",
                            "properties": {"c": {"$ref": "#/$defs/Currency"}},
                        },
                        "Currency": {"type": "string"},
                    }
                },
                "import_all": True,
            },
        )
    assert r.status_code == 200
    money_refs = captured["Money"]["refs"]
    assert {
        "relative_ref": "./currency",
        "resolved_target": "https://api.apiome.dev/types/tenant/acme/currency",
        "status": "unresolved",
    } in money_refs
    assert all(e["status"] != "internal" for e in money_refs)
    # A def with no internal refs commits an empty edge list.
    assert captured["Currency"]["refs"] == []


def test_import_stamps_identity_using_target_namespace():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = {"name": "Good"}
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        mdb.get_primitive_by_schema_id.return_value = None  # clean registry — all New (#3464)
        mdb.get_primitive_by_namespace_name.return_value = None
        r = client.post(
            "/v1/primitives/acme/import",
            json={
                "schema": {"$defs": {"Good": {"type": "string"}}},
                "import_all": True,
                "target_namespace": "tenant/acme/v1/types",
            },
        )
    assert r.status_code == 200
    kwargs = mdb.create_primitive.call_args.kwargs
    assert kwargs["base_uri"] == "https://api.apiome.dev/types/tenant/acme/v1/types/"
    assert kwargs["schema_id"] == "https://api.apiome.dev/types/tenant/acme/v1/types/good"
    assert kwargs["namespace"] == "tenant/acme/v1/types"
    assert kwargs["source"] == "imported"
