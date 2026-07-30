"""Reference-target annotation on the single-primitive endpoint.

``apiome.primitives.refs`` stores each edge as ``{relative_ref, resolved_target, status}`` — the
target's ``$id`` is enough to display but not to navigate to, so the type-detail page could not link
a ``$ref`` to the type it points at. ``GET /v1/primitives/{tenant}/{id}`` now annotates every edge
with ``target_id`` / ``target_name``, the same shape the resolver listing already returns.

These tests pin that the annotation is read-only: a GET must not recompute or persist status.
"""

from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.primitives_routes import annotate_ref_targets

client = TestClient(app)

_TENANT_ID = "11111111-1111-1111-1111-111111111111"
_AUTH = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "user-1",
    "auth_method": "jwt",
}

_DECIMAL_ID = "22222222-2222-2222-2222-222222222222"
_DECIMAL_TARGET = "https://api.apiome.dev/types/std/v0/types/decimal"
_MISSING_TARGET = "https://api.apiome.dev/types/std/v0/types/nope"

_MONEY_ROW: Dict[str, Any] = {
    "id": "33333333-3333-3333-3333-333333333333",
    "tenant_id": _TENANT_ID,
    "name": "money",
    "description": None,
    "category": "object",
    "schema": {"type": "object"},
    "tags": [],
    "is_system": True,
    "is_public": True,
    "usage_count": 0,
    "enabled": True,
    "namespace": "std/v0/types",
    "schema_id": "https://api.apiome.dev/types/std/v0/types/money",
    "base_uri": "https://api.apiome.dev/types/std/v0/types/",
    "draft": "2020-12",
    "refs": [
        {"relative_ref": "./decimal", "resolved_target": _DECIMAL_TARGET, "status": "resolved"},
        {"relative_ref": "./nope", "resolved_target": _MISSING_TARGET, "status": "unresolved"},
    ],
    "created_at": None,
    "updated_at": None,
}


def _target_row(schema_id: str, _tenant_id: str) -> Optional[Dict[str, Any]]:
    """Only the decimal target exists; anything else is a miss."""
    if schema_id == _DECIMAL_TARGET:
        return {"id": _DECIMAL_ID, "name": "decimal"}
    return None


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


class TestAnnotateRefTargets:
    def test_attaches_target_identity_to_a_resolved_edge(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            edges = annotate_ref_targets(_MONEY_ROW["refs"], tenant_id=_TENANT_ID)

        assert edges[0]["target_id"] == _DECIMAL_ID
        assert edges[0]["target_name"] == "decimal"

    def test_leaves_an_unresolvable_edge_without_a_target(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            edges = annotate_ref_targets(_MONEY_ROW["refs"], tenant_id=_TENANT_ID)

        assert edges[1]["target_id"] is None
        assert edges[1]["target_name"] is None

    def test_preserves_the_stored_fields_and_their_order(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            edges = annotate_ref_targets(_MONEY_ROW["refs"], tenant_id=_TENANT_ID)

        # Order is load-bearing: the UI keys ref rows by index.
        assert [e["relative_ref"] for e in edges] == ["./decimal", "./nope"]
        # Status is carried through untouched — a GET does not re-resolve.
        assert [e["status"] for e in edges] == ["resolved", "unresolved"]

    def test_does_not_mutate_the_rows_it_was_given(self):
        original = [dict(edge) for edge in _MONEY_ROW["refs"]]
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            annotate_ref_targets(_MONEY_ROW["refs"], tenant_id=_TENANT_ID)

        assert _MONEY_ROW["refs"] == original

    def test_looks_each_distinct_target_up_once(self):
        shared = [
            {"relative_ref": "./a", "resolved_target": _DECIMAL_TARGET, "status": "resolved"},
            {"relative_ref": "./b", "resolved_target": _DECIMAL_TARGET, "status": "resolved"},
            {"relative_ref": "./c", "resolved_target": _MISSING_TARGET, "status": "unresolved"},
            {"relative_ref": "./d", "resolved_target": _MISSING_TARGET, "status": "unresolved"},
        ]
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            annotate_ref_targets(shared, tenant_id=_TENANT_ID)

        # Two distinct targets, four edges — misses are cached too.
        assert mdb.get_primitive_by_schema_id.call_count == 2

    @pytest.mark.parametrize("edges", [None, [], [{"relative_ref": "./x"}]])
    def test_tolerates_absent_empty_and_targetless_edges(self, edges):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            result = annotate_ref_targets(edges, tenant_id=_TENANT_ID)

        assert len(result) == len(edges or [])
        if result:
            assert result[0]["target_id"] is None
            # No target string, so no lookup was attempted.
            mdb.get_primitive_by_schema_id.assert_not_called()


class TestGetPrimitiveEndpoint:
    def test_returns_edges_annotated_with_their_targets(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _MONEY_ROW
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            response = client.get(f"/v1/primitives/acme/{_MONEY_ROW['id']}")

        assert response.status_code == 200
        refs = response.json()["refs"]
        assert refs[0]["target_id"] == _DECIMAL_ID
        assert refs[0]["target_name"] == "decimal"
        assert refs[1]["target_id"] is None

    def test_does_not_persist_anything(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _MONEY_ROW
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            client.get(f"/v1/primitives/acme/{_MONEY_ROW['id']}")

        mdb.update_primitive.assert_not_called()
        mdb.update_primitive_refs.assert_not_called()

    def test_scopes_target_lookups_to_the_callers_tenant(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _MONEY_ROW
            mdb.get_primitive_by_schema_id.side_effect = _target_row
            client.get(f"/v1/primitives/acme/{_MONEY_ROW['id']}")

        for call in mdb.get_primitive_by_schema_id.call_args_list:
            assert call.args[1] == _TENANT_ID

    def test_still_404s_for_a_missing_primitive(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = None
            response = client.get(f"/v1/primitives/acme/{_MONEY_ROW['id']}")

        assert response.status_code == 404
        mdb.get_primitive_by_schema_id.assert_not_called()
