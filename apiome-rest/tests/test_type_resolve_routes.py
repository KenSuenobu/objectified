"""Route tests for the type-registry resolver API (#3459).

``POST /v1/types/{tenant_slug}/resolve`` re-resolves the tenant's ``$ref`` edges against
the current registry, persists any status that changed, and returns the per-primitive
dependency listing the resolver UI consumes (#3470). The DB layer is mocked; pure
re-resolution mechanics live in ``test_type_resolver.py``.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

BASE = "https://api.apiome.dev/types/"
MONEY = BASE + "tenant/acme/types/money"
DECIMAL = BASE + "tenant/acme/types/decimal"
STRING = BASE + "std/v0/primitives/string"


def _prim(**overrides):
    row = {
        "id": "p1",
        "tenant_id": "t1",
        "name": "order",
        "schema_id": BASE + "tenant/acme/types/order",
        "namespace": "tenant/acme/types",
        "base_uri": BASE + "tenant/acme/types/",
        "is_system": False,
        "refs": [],
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_resolve_empty_tenant():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = []
        r = client.post("/v1/types/acme/resolve")
    assert r.status_code == 200
    assert r.json() == {
        "total_primitives": 0,
        "ref_count": 0,
        "resolved_ref_count": 0,
        "unresolved_ref_count": 0,
        "affected_primitive_count": 0,
        "reresolved_primitive_count": 0,
        "primitives": [],
    }
    # Scope comes from the token tenant, not the URL slug.
    mdb.get_primitives_for_tenant.assert_called_once_with("t1")


def test_primitives_without_refs_are_omitted():
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [_prim(refs=[])]
        r = client.post("/v1/types/acme/resolve")
    body = r.json()
    assert body["total_primitives"] == 0
    assert body["primitives"] == []
    mdb.update_primitive.assert_not_called()


def test_unchanged_edges_are_not_persisted_but_are_listed():
    """A resolved edge that is still resolved is reported, with target identity, no write."""
    prim = _prim(
        refs=[{"relative_ref": "../primitives/string", "resolved_target": STRING, "status": "resolved"}]
    )
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [prim]
        mdb.get_primitive_by_schema_id.return_value = {"id": "s1", "name": "string"}
        r = client.post("/v1/types/acme/resolve")

    body = r.json()
    assert body["total_primitives"] == 1
    assert body["resolved_ref_count"] == 1
    assert body["unresolved_ref_count"] == 0
    assert body["reresolved_primitive_count"] == 0
    edge = body["primitives"][0]["refs"][0]
    assert edge["status"] == "resolved"
    assert edge["target_id"] == "s1"
    assert edge["target_name"] == "string"
    mdb.update_primitive.assert_not_called()


def test_reresolve_persists_flipped_status():
    """A formerly-unresolved edge whose target now exists is flipped and persisted."""
    prim = _prim(
        id="order",
        refs=[{"relative_ref": "./money", "resolved_target": MONEY, "status": "unresolved"}],
    )
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [prim]
        mdb.get_primitive_by_schema_id.return_value = {"id": "m1", "name": "money"}
        r = client.post("/v1/types/acme/resolve")

    body = r.json()
    assert body["resolved_ref_count"] == 1
    assert body["unresolved_ref_count"] == 0
    assert body["affected_primitive_count"] == 0
    assert body["reresolved_primitive_count"] == 1
    # The refreshed edges are written back (3-field persisted shape, status now resolved).
    mdb.update_primitive.assert_called_once_with(
        "order",
        "t1",
        {"refs": [{"relative_ref": "./money", "resolved_target": MONEY, "status": "resolved"}]},
    )


def test_reresolve_marks_dangling_when_target_missing():
    """A formerly-resolved edge whose target is now gone flips to unresolved and persists."""
    prim = _prim(
        id="order",
        refs=[{"relative_ref": "./money", "resolved_target": MONEY, "status": "resolved"}],
    )
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [prim]
        mdb.get_primitive_by_schema_id.return_value = None  # target no longer exists
        r = client.post("/v1/types/acme/resolve")

    body = r.json()
    assert body["unresolved_ref_count"] == 1
    assert body["affected_primitive_count"] == 1
    assert body["reresolved_primitive_count"] == 1
    edge = body["primitives"][0]["refs"][0]
    assert edge["status"] == "unresolved"
    assert edge["target_id"] is None
    mdb.update_primitive.assert_called_once()


def test_system_primitive_status_change_is_not_written_back():
    """System-core rows are read-only: a status flip is reported but never persisted."""
    prim = _prim(
        id="sys1",
        is_system=True,
        refs=[{"relative_ref": "./money", "resolved_target": MONEY, "status": "unresolved"}],
    )
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [prim]
        mdb.get_primitive_by_schema_id.return_value = {"id": "m1", "name": "money"}
        r = client.post("/v1/types/acme/resolve")

    body = r.json()
    assert body["resolved_ref_count"] == 1
    assert body["reresolved_primitive_count"] == 0  # change reflected, not counted as written
    mdb.update_primitive.assert_not_called()


def test_distinct_targets_are_looked_up_once():
    """The same target $id shared by two edges is queried a single time (memoized)."""
    primitives = [
        _prim(id="a", refs=[{"relative_ref": "./money", "resolved_target": MONEY, "status": "unresolved"}]),
        _prim(id="b", refs=[{"relative_ref": "../money", "resolved_target": MONEY, "status": "unresolved"}]),
    ]
    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = primitives
        mdb.get_primitive_by_schema_id.return_value = {"id": "m1", "name": "money"}
        r = client.post("/v1/types/acme/resolve")

    assert r.status_code == 200
    assert r.json()["resolved_ref_count"] == 2
    mdb.get_primitive_by_schema_id.assert_called_once_with(MONEY, "t1")


def test_mixed_edges_aggregate_counts():
    prim = _prim(
        id="order",
        refs=[
            {"relative_ref": "../primitives/string", "resolved_target": STRING, "status": "unresolved"},
            {"relative_ref": "./decimal", "resolved_target": DECIMAL, "status": "unresolved"},
        ],
    )

    def _by_schema_id(schema_id, tenant_id):
        return {"id": "s1", "name": "string"} if schema_id == STRING else None

    with patch("app.type_namespaces_routes.db") as mdb:
        mdb.get_primitives_for_tenant.return_value = [prim]
        mdb.get_primitive_by_schema_id.side_effect = _by_schema_id
        r = client.post("/v1/types/acme/resolve")

    body = r.json()
    assert body["total_primitives"] == 1
    assert body["ref_count"] == 2
    assert body["resolved_ref_count"] == 1
    assert body["unresolved_ref_count"] == 1
    assert body["affected_primitive_count"] == 1
    assert body["reresolved_primitive_count"] == 1  # the string edge flipped to resolved
    listed = body["primitives"][0]
    assert listed["resolved_count"] == 1
    assert listed["unresolved_count"] == 1
