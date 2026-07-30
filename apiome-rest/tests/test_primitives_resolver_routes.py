"""API tests for relative ``$ref`` resolution + persistence on the Primitives CRUD (#3456).

Covers create / update / import: each computes the schema's ``$ref`` edges, marks them
resolved/unresolved by a tenant-scoped target lookup (``get_primitive_by_schema_id``), and
persists them to ``apiome.primitives.refs``. The DB is mocked, so these assert the edges passed
to the DB layer; pure resolution mechanics are covered in ``test_primitives_resolver.py``.
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
STD_PRIMS_STRING = BASE + "std/v0/primitives/string"


def _row(**overrides):
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "Date",
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
        "refs": [],
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
# CREATE
# ===========================================================================


def test_create_persists_resolved_ref_edge():
    with patch("app.primitives_routes.db") as mdb:
        # The referenced target exists in scope -> resolved.
        mdb.get_primitive_by_schema_id.return_value = _row(id="target")
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/std",
            json={
                "name": "Date",
                "category": "object",
                "namespace": "std/v0/types",
                "schema": {"type": "object", "properties": {"v": {"$ref": "../primitives/string"}}},
            },
        )
    assert r.status_code == 200
    refs = mdb.create_primitive.call_args.kwargs["refs"]
    assert refs == [
        {
            "relative_ref": "../primitives/string",
            "resolved_target": STD_PRIMS_STRING,
            "status": "resolved",
        }
    ]
    # The lookup is tenant-scoped (token tenant, not the URL slug).
    mdb.get_primitive_by_schema_id.assert_called_once_with(STD_PRIMS_STRING, "t1")


def test_create_persists_unresolved_ref_edge_when_target_missing():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None  # target not present
        mdb.get_primitive_by_namespace_name.return_value = None
        mdb.get_primitive_by_namespace_name.return_value = None
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/std",
            json={
                "name": "Date",
                "category": "object",
                "namespace": "std/v0/types",
                "schema": {"type": "object", "properties": {"v": {"$ref": "../primitives/string"}}},
            },
        )
    assert r.status_code == 200
    refs = mdb.create_primitive.call_args.kwargs["refs"]
    assert refs[0]["status"] == "unresolved"
    assert refs[0]["resolved_target"] == STD_PRIMS_STRING


def test_create_without_refs_persists_empty_edges():
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.return_value = _row()
        r = client.post(
            "/v1/primitives/std",
            json={"name": "Plain", "category": "string", "schema": {"type": "string"}},
        )
    assert r.status_code == 200
    assert mdb.create_primitive.call_args.kwargs["refs"] == []
    mdb.get_primitive_by_schema_id.assert_not_called()


# ===========================================================================
# UPDATE
# ===========================================================================


def test_update_reresolves_refs_on_schema_change():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row(name="Date", namespace="std/v0/types")
        mdb.get_primitive_by_schema_id.return_value = _row(id="target")
        mdb.update_primitive.return_value = _row()
        r = client.put(
            "/v1/primitives/std/p1",
            json={"schema": {"type": "object", "properties": {"v": {"$ref": "../primitives/string"}}}},
        )
    assert r.status_code == 200
    updates = mdb.update_primitive.call_args.args[2]
    assert updates["refs"][0]["relative_ref"] == "../primitives/string"
    assert updates["refs"][0]["status"] == "resolved"


def test_update_metadata_only_does_not_touch_refs():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row()
        mdb.update_primitive.return_value = _row(description="x")
        r = client.put("/v1/primitives/std/p1", json={"description": "x"})
    assert r.status_code == 200
    updates = mdb.update_primitive.call_args.args[2]
    assert "refs" not in updates
    mdb.get_primitive_by_schema_id.assert_not_called()


# ===========================================================================
# IMPORT
# ===========================================================================


def test_import_persists_refs_per_definition():
    created = []

    def _create(**kwargs):
        created.append(kwargs)
        return {"name": kwargs["name"], "refs": kwargs.get("refs", [])}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.get_primitive_by_schema_id.return_value = None  # unresolved
        mdb.get_primitive_by_namespace_name.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = client.post(
            "/v1/primitives/std/import",
            json={
                "schema": {
                    "$defs": {
                        "Date": {"type": "object", "properties": {"v": {"$ref": "../primitives/string"}}},
                    }
                },
                "import_all": True,
                "target_namespace": "std/v0/types",
            },
        )
    assert r.status_code == 200
    assert created[0]["refs"][0]["relative_ref"] == "../primitives/string"
    assert created[0]["refs"][0]["status"] == "unresolved"
