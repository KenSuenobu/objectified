"""API tests for committing an Apiome type-definition bundle (#3462).

``POST /v1/primitives/{tenant_slug}/import`` with ``source_kind='type-def-bundle'`` expands
the request ``schema`` as a bundle and commits each type as a primitive row. The DB is mocked,
so these assert that a bundle of N types creates N rows with their inter-type refs intact in
the ``refs`` payload, and that a malformed bundle is rejected with a clear 400 error.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _post_bundle(schema, **extra):
    body = {"schema": schema, "import_all": True, "source_kind": "type-def-bundle"}
    body.update(extra)
    return client.post("/v1/primitives/std/import", json=body)


def test_bundle_of_n_types_imports_n_rows_with_refs_intact():
    created = []

    def _create(**kwargs):
        created.append(kwargs)
        return {"name": kwargs["name"], "refs": kwargs.get("refs", [])}

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.get_primitive_by_schema_id.return_value = None  # registry refs unresolved
        mdb.create_primitive_import.return_value = {"id": "imp-b1"}
        r = _post_bundle(
            {
                "types": {
                    "Order": {
                        "type": "object",
                        "properties": {"line": {"$ref": "#/types/Line"}},
                    },
                    "Line": {
                        "type": "object",
                        "properties": {"amount": {"$ref": "../primitives/number"}},
                    },
                }
            },
            target_namespace="std/v0/types",
        )

    assert r.status_code == 200
    body = r.json()
    assert body["total_imported"] == 2
    assert set(body["imported"]) == {"Order", "Line"}
    assert body["import_id"] == "imp-b1"

    # Two rows created — one per bundle type.
    assert len(created) == 2
    by_name = {c["name"]: c for c in created}
    # Order's inter-type ref is rewritten to a relative registry ref (#3463) and resolved like
    # any other registry edge (unresolved here, since the target is not yet committed) — no
    # leftover 'internal' fragment pointer remains in the stored refs.
    order_refs = by_name["Order"]["refs"]
    assert {
        "relative_ref": "./line",
        "resolved_target": "https://api.apiome.dev/types/std/v0/types/line",
        "status": "unresolved",
    } in order_refs
    assert all(e["status"] != "internal" for e in order_refs)
    # Line's registry-relative ref is resolved (unresolved here) — kept distinct from internal.
    line_refs = by_name["Line"]["refs"]
    assert any(e["relative_ref"] == "../primitives/number" for e in line_refs)
    assert all(e["status"] != "internal" for e in line_refs)

    # Provenance recorded under the bundle source kind.
    _, kwargs = mdb.create_primitive_import.call_args
    assert kwargs["source_kind"] == "type-def-bundle"
    assert kwargs["imported_count"] == 2


def test_bundle_selected_definitions_filter():
    created = []
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = lambda **k: created.append(k) or {"name": k["name"]}
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp-b2"}
        r = client.post(
            "/v1/primitives/std/import",
            json={
                "schema": {"types": {"A": {"type": "string"}, "B": {"type": "string"}}},
                "source_kind": "type-def-bundle",
                "import_all": False,
                "selected_definitions": ["A"],
            },
        )
    assert r.status_code == 200
    assert [c["name"] for c in created] == ["A"]


def test_bundle_malformed_no_container_is_clear_400():
    with patch("app.primitives_routes.db") as mdb:
        r = _post_bundle({"not_a_container": {}})
    assert r.status_code == 400
    assert "types" in r.json()["detail"]
    mdb.create_primitive.assert_not_called()


def test_bundle_malformed_only_unusable_entries_is_400():
    with patch("app.primitives_routes.db"):
        r = _post_bundle({"types": {"Bad": "not-a-schema"}})
    assert r.status_code == 400
    assert "no usable type" in r.json()["detail"]


def test_bundle_invalid_type_recorded_as_error_not_blocking():
    created = []
    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = lambda **k: created.append(k) or {"name": k["name"]}
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp-b3"}
        r = _post_bundle(
            {"types": {"Good": {"type": "object"}, "Bad": {"type": "stringg"}}}
        )
    assert r.status_code == 200
    body = r.json()
    # The valid type committed; the invalid one is reported, not fatal.
    assert body["imported"] == ["Good"]
    assert body["total_errors"] == 1
    assert body["errors"][0]["name"] == "Bad"
    assert body["errors"][0]["error"] == "invalid_schema"
