"""Tests for unresolved-``$ref`` detection, flags & counts on the Primitives registry (#3457).

Two concerns, both with a mocked DB layer (pure resolution mechanics live in
``test_primitives_resolver.py``; persisted-edge wiring in ``test_primitives_resolver_routes.py``):

* ``GET /v1/primitives/{tenant}/unresolved`` — aggregates the tenant's unresolved edges into
  the counts (#3454) + per-primitive breakdown (#3470) the registry overview/resolver consume.
* create / update / import call ``mark_refs_resolved_to_target`` so that creating the missing
  target clears dependents' unresolved flags ("fixing target clears on re-resolve").
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
# GET /{tenant}/unresolved
# ===========================================================================


def test_unresolved_endpoint_aggregates_counts_and_breakdown():
    rows = [
        {
            "id": "money",
            "name": "money",
            "schema_id": BASE + "tenant/acme/types/money",
            "namespace": "tenant/acme/types",
            "base_uri": BASE + "tenant/acme/types/",
            "refs": [
                # One unresolved, one resolved — only the unresolved one is surfaced.
                {
                    "relative_ref": "./decimal",
                    "resolved_target": BASE + "tenant/acme/types/decimal",
                    "status": "unresolved",
                },
                {"relative_ref": "../primitives/string", "resolved_target": STD_PRIMS_STRING, "status": "resolved"},
            ],
        },
        {
            "id": "order",
            "name": "order",
            "schema_id": BASE + "tenant/acme/types/order",
            "namespace": "tenant/acme/types",
            "base_uri": BASE + "tenant/acme/types/",
            "refs": [
                {
                    "relative_ref": "./money",
                    "resolved_target": BASE + "tenant/acme/types/money",
                    "status": "unresolved",
                },
            ],
        },
    ]
    with patch("app.primitives_routes.db") as mdb:
        mdb.count_unresolved_refs.return_value = {
            "unresolved_ref_count": 2,
            "affected_primitive_count": 2,
        }
        mdb.get_primitives_with_unresolved_refs.return_value = rows
        r = client.get("/v1/primitives/acme/unresolved")

    assert r.status_code == 200
    body = r.json()
    assert body["unresolved_ref_count"] == 2
    assert body["affected_primitive_count"] == 2
    assert len(body["primitives"]) == 2

    money = next(p for p in body["primitives"] if p["name"] == "money")
    # Only the unresolved edge is reported (the resolved one is filtered out).
    assert money["unresolved_count"] == 1
    assert money["unresolved_refs"] == [
        {"relative_ref": "./decimal", "resolved_target": BASE + "tenant/acme/types/decimal", "status": "unresolved"}
    ]
    # The aggregates are scoped to the token tenant, not the URL slug.
    mdb.count_unresolved_refs.assert_called_once_with("t1")
    mdb.get_primitives_with_unresolved_refs.assert_called_once_with("t1")


def test_unresolved_endpoint_empty_when_all_resolved():
    with patch("app.primitives_routes.db") as mdb:
        mdb.count_unresolved_refs.return_value = {
            "unresolved_ref_count": 0,
            "affected_primitive_count": 0,
        }
        mdb.get_primitives_with_unresolved_refs.return_value = []
        r = client.get("/v1/primitives/acme/unresolved")

    assert r.status_code == 200
    body = r.json()
    assert body == {
        "unresolved_ref_count": 0,
        "affected_primitive_count": 0,
        "primitives": [],
    }


def test_unresolved_path_not_captured_as_primitive_id():
    """The literal `unresolved` segment routes to the aggregate, never to get_primitive."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.count_unresolved_refs.return_value = {"unresolved_ref_count": 0, "affected_primitive_count": 0}
        mdb.get_primitives_with_unresolved_refs.return_value = []
        r = client.get("/v1/primitives/acme/unresolved")
    assert r.status_code == 200
    mdb.get_primitive_by_id.assert_not_called()


# ===========================================================================
# Re-resolve on fix: create / update / import clear dependents
# ===========================================================================


def test_create_reconciles_dependents_for_new_target():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        mdb.mark_refs_resolved_to_target.return_value = 1
        r = client.post(
            "/v1/primitives/std",
            json={
                "name": "string",
                "category": "string",
                "namespace": "std/v0/primitives",
                "schema": {"type": "string"},
            },
        )
    assert r.status_code == 200
    # The created type's own $id is reconciled against the tenant's dangling edges.
    mdb.mark_refs_resolved_to_target.assert_called_once_with("t1", STD_PRIMS_STRING)


def test_update_reconciles_when_identity_changes():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row(name="string", namespace="std/v0/primitives")
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.update_primitive.return_value = _row()
        r = client.put(
            "/v1/primitives/std/p1",
            json={"schema": {"type": "string", "title": "String"}},
        )
    assert r.status_code == 200
    mdb.mark_refs_resolved_to_target.assert_called_once_with("t1", STD_PRIMS_STRING)


def test_update_metadata_only_does_not_reconcile():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_id.return_value = _row()
        mdb.update_primitive.return_value = _row(description="x")
        r = client.put("/v1/primitives/std/p1", json={"description": "x"})
    assert r.status_code == 200
    mdb.mark_refs_resolved_to_target.assert_not_called()


def test_import_reconciles_each_definition():
    def _create(**kwargs):
        return {"name": kwargs["name"], "refs": kwargs.get("refs", [])}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = client.post(
            "/v1/primitives/std/import",
            json={
                "schema": {
                    "$defs": {
                        "string": {"type": "string"},
                        "number": {"type": "number"},
                    }
                },
                "import_all": True,
                "target_namespace": "std/v0/primitives",
            },
        )
    assert r.status_code == 200
    # One reconcile pass per successfully imported definition.
    targets = {c.args[1] for c in mdb.mark_refs_resolved_to_target.call_args_list}
    assert targets == {
        BASE + "std/v0/primitives/string",
        BASE + "std/v0/primitives/number",
    }


def test_create_succeeds_when_reconcile_fails():
    """Reconciliation is best-effort: its failure must not fail the create."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.return_value = _row()
        mdb.mark_refs_resolved_to_target.side_effect = RuntimeError("boom")
        r = client.post(
            "/v1/primitives/std",
            json={
                "name": "string",
                "category": "string",
                "namespace": "std/v0/primitives",
                "schema": {"type": "string"},
            },
        )
    assert r.status_code == 200
