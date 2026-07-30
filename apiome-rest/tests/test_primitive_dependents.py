"""Reverse index of ``$ref`` edges — the type-detail Dependents card (#3477).

``apiome.primitives.refs`` records only a type's *outgoing* edges, so the detail page could
answer "what does this reference" but never "who references this": opening ``number`` from
``decimal``'s base chain showed an empty Dependents card even though ``decimal`` plainly
references it. ``GET /v1/primitives/{tenant}/{id}`` now scans the visible types' edge lists
for the viewed type's ``$id`` and returns the matches as ``dependents``.

These tests pin the reverse lookup itself (matched on the stored absolute
``resolved_target``, one entry per edge, scoped to the caller) and the property label each
entry carries.
"""

from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.primitives_routes import build_dependents, ref_location_label

client = TestClient(app)

_TENANT_ID = "11111111-1111-1111-1111-111111111111"
_AUTH = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "user-1",
    "auth_method": "jwt",
}

_NUMBER_ID = "https://api.apiome.dev/types/std/v0/primitives/number"
_DECIMAL_ID = "https://api.apiome.dev/types/std/v0/types/decimal"

# The type being viewed: `number`, which nothing points at until `decimal` does.
_NUMBER_ROW: Dict[str, Any] = {
    "id": "22222222-2222-2222-2222-222222222222",
    "tenant_id": _TENANT_ID,
    "name": "number",
    "description": None,
    "category": "number",
    "schema": {"$id": _NUMBER_ID, "type": "number"},
    "tags": [],
    "is_system": True,
    "is_public": True,
    "usage_count": 0,
    "enabled": True,
    "namespace": "std/v0/primitives",
    "schema_id": _NUMBER_ID,
    "base_uri": "https://api.apiome.dev/types/std/v0/primitives/",
    "draft": "2020-12",
    "refs": [],
    "created_at": None,
    "updated_at": None,
}

# `decimal` *is* a `number`: a whole-type `$ref` at the document root.
_DECIMAL_DEPENDENT: Dict[str, Any] = {
    "id": "33333333-3333-3333-3333-333333333333",
    "tenant_id": _TENANT_ID,
    "name": "decimal",
    "namespace": "std/v0/types",
    "schema_id": _DECIMAL_ID,
    "is_system": True,
    "schema": {"$id": _DECIMAL_ID, "$ref": "../primitives/number", "title": "Decimal"},
    "refs": [
        {
            "relative_ref": "../primitives/number",
            "resolved_target": _NUMBER_ID,
            "status": "resolved",
        }
    ],
}

# A tenant type that references `number` from two properties.
_INVOICE_DEPENDENT: Dict[str, Any] = {
    "id": "44444444-4444-4444-4444-444444444444",
    "tenant_id": _TENANT_ID,
    "name": "invoice",
    "namespace": "tenant/acme/v1",
    "schema_id": "https://api.apiome.dev/types/tenant/acme/v1/invoice",
    "is_system": False,
    "schema": {
        "type": "object",
        "properties": {
            "total": {"$ref": "../../../std/v0/primitives/number"},
            "lines": {"type": "array", "items": {"$ref": "/std/v0/primitives/number"}},
            "note": {"type": "string"},
        },
    },
    "refs": [
        {
            "relative_ref": "../../../std/v0/primitives/number",
            "resolved_target": _NUMBER_ID,
            "status": "resolved",
        },
        {
            "relative_ref": "/std/v0/primitives/number",
            "resolved_target": _NUMBER_ID,
            "status": "resolved",
        },
        {
            "relative_ref": "./tax-code",
            "resolved_target": "https://api.apiome.dev/types/tenant/acme/v1/tax-code",
            "status": "unresolved",
        },
    ],
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _dependents(rows: List[Dict[str, Any]], target: str = _NUMBER_ID) -> List[Dict[str, Any]]:
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_dependent_primitives.return_value = rows
        return build_dependents(target, tenant_id=_TENANT_ID, tenant_slug="acme")


class TestRefLocationLabel:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ((), None),  # A root `$ref`: the type *is* the referenced type.
            (("properties", "amount"), "amount"),
            (("properties", "lines", "items"), "lines[]"),
            (("properties", "amount", "allOf", 0), "amount"),
            (("$defs", "Row", "properties", "id"), "$defs.Row.id"),
            (("properties", "shipping", "properties", "cost"), "shipping.cost"),
            (("allOf", 0), None),  # Composed at the root — still whole-type.
        ],
    )
    def test_describes_where_the_ref_sits(self, path, expected):
        assert ref_location_label(path) == expected


class TestBuildDependents:
    def test_finds_the_type_that_references_the_target(self):
        result = _dependents([_DECIMAL_DEPENDENT])

        assert len(result) == 1
        assert result[0]["name"] == "decimal"
        assert result[0]["id"] == _DECIMAL_DEPENDENT["id"]
        assert result[0]["schema_id"] == _DECIMAL_ID
        assert result[0]["namespace"] == "std/v0/types"

    def test_a_whole_type_reference_names_no_property(self):
        # `decimal`'s `$ref` is at the document root, not on a property.
        assert _dependents([_DECIMAL_DEPENDENT])[0]["property"] is None

    def test_labels_each_referencing_property(self):
        result = _dependents([_INVOICE_DEPENDENT])

        # One entry per referencing edge — the same type twice, labelled by location.
        assert [dep["property"] for dep in result] == ["total", "lines[]"]

    def test_ignores_edges_aimed_elsewhere(self):
        # The invoice's third edge points at `tax-code`, not at the viewed type.
        assert all(dep["property"] != "—" for dep in _dependents([_INVOICE_DEPENDENT]))
        assert len(_dependents([_INVOICE_DEPENDENT])) == 2

    def test_marks_scope_and_tenant_label(self):
        core, tenant = _dependents([_DECIMAL_DEPENDENT])[0], _dependents([_INVOICE_DEPENDENT])[0]

        assert core["scope"] == "system"
        assert core["tenant_label"] is None
        assert tenant["scope"] == "tenant"
        assert tenant["tenant_label"] == "acme"

    def test_scopes_the_lookup_to_the_caller(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_dependent_primitives.return_value = []
            build_dependents(_NUMBER_ID, tenant_id=_TENANT_ID, tenant_slug="acme")

        mdb.get_dependent_primitives.assert_called_once_with(_NUMBER_ID, _TENANT_ID)

    def test_a_type_without_an_id_can_have_no_dependents(self):
        # A legacy flat primitive has no `$id`, so no edge can resolve to it — and no
        # query is worth running.
        with patch("app.primitives_routes.db") as mdb:
            assert build_dependents(None, tenant_id=_TENANT_ID, tenant_slug="acme") == []

        mdb.get_dependent_primitives.assert_not_called()

    def test_lists_a_dependent_whose_edge_is_still_flagged_unresolved(self):
        # The edge's status is the resolver's stale verdict; the target exists now, so
        # the dependency is real and belongs on the impact list.
        stale = {
            **_DECIMAL_DEPENDENT,
            "refs": [
                {
                    "relative_ref": "../primitives/number",
                    "resolved_target": _NUMBER_ID,
                    "status": "unresolved",
                }
            ],
        }
        assert len(_dependents([stale])) == 1

    def test_tolerates_a_row_with_no_schema_or_edges(self):
        bare = {**_DECIMAL_DEPENDENT, "schema": None, "refs": None}
        assert _dependents([bare]) == []


class TestGetPrimitiveEndpoint:
    def test_returns_the_dependents_of_the_viewed_type(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _NUMBER_ROW
            mdb.get_dependent_primitives.return_value = [_DECIMAL_DEPENDENT]
            response = client.get(f"/v1/primitives/acme/{_NUMBER_ROW['id']}")

        assert response.status_code == 200
        dependents = response.json()["dependents"]
        assert [dep["name"] for dep in dependents] == ["decimal"]
        assert dependents[0]["id"] == _DECIMAL_DEPENDENT["id"]

    def test_reverse_lookup_keys_on_the_types_own_id(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _NUMBER_ROW
            mdb.get_dependent_primitives.return_value = []
            client.get(f"/v1/primitives/acme/{_NUMBER_ROW['id']}")

        mdb.get_dependent_primitives.assert_called_once_with(_NUMBER_ID, _TENANT_ID)

    def test_returns_an_empty_list_when_nothing_references_the_type(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _NUMBER_ROW
            mdb.get_dependent_primitives.return_value = []
            response = client.get(f"/v1/primitives/acme/{_NUMBER_ROW['id']}")

        assert response.json()["dependents"] == []

    def test_does_not_persist_anything(self):
        with patch("app.primitives_routes.db") as mdb:
            mdb.get_primitive_by_id.return_value = _NUMBER_ROW
            mdb.get_dependent_primitives.return_value = [_DECIMAL_DEPENDENT]
            client.get(f"/v1/primitives/acme/{_NUMBER_ROW['id']}")

        mdb.update_primitive.assert_not_called()
        mdb.update_primitive_refs.assert_not_called()
