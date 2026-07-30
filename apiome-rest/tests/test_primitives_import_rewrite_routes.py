"""API tests for ``$ref`` rewrite + core-format mapping on import commit (#3463).

``POST /v1/primitives/{tenant_slug}/import`` rewrites each imported definition's intra-source
pointers to relative registry refs and maps recognized formats to core ``std/v0/types`` types
before persisting. The DB is mocked, so these assert on the ``refs`` payload each row is created
with — that rewritten refs are stored relative and resolve via the registry (#3456), and that
core-format mapping works for recognized formats.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

# Absolute $id of the seeded core email type — what a recognized `format: email` maps to.
CORE_EMAIL = "https://api.apiome.dev/types/std/v0/types/email"


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _import(schema, **extra):
    body = {"schema": schema, "import_all": True}
    body.update(extra)
    return client.post("/v1/primitives/acme/import", json=body)


def test_internal_defs_ref_is_rewritten_relative_and_resolved():
    """A `#/$defs/X` sibling pointer is stored as `./x` and resolves once the target exists."""
    created = []

    def _create(**kwargs):
        created.append(kwargs)
        return {"name": kwargs["name"], "refs": kwargs.get("refs", [])}

    # The Money target resolves; Decimal does not (kept unresolved).
    money_id = "https://api.apiome.dev/types/tenant/acme/money"

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = _create
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda uri, tid: {"id": "x"} if uri == money_id else None
        )
        mdb.create_primitive_import.return_value = {"id": "imp-r1"}
        r = _import(
            {
                "$defs": {
                    "Money": {"type": "object"},
                    "Invoice": {
                        "type": "object",
                        "properties": {"total": {"$ref": "#/$defs/Money"}},
                    },
                }
            }
        )

    assert r.status_code == 200
    by_name = {c["name"]: c for c in created}
    invoice_refs = by_name["Invoice"]["refs"]
    assert invoice_refs == [
        {"relative_ref": "./money", "resolved_target": money_id, "status": "resolved"}
    ]
    # The rewrite is reported per type for the import-review table.
    assert r.json()["rewrites"]["Invoice"] == [
        {"from": "#/$defs/Money", "to": "./money", "kind": "internal"}
    ]


def test_core_format_mapping_resolves_to_core_type():
    """A recognized `format: email` is mapped to the seeded core type and resolves."""
    created = []

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = lambda **k: created.append(k) or {"name": k["name"]}
        # Only the core email type exists in scope.
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda uri, tid: {"id": "core"} if uri == CORE_EMAIL else None
        )
        mdb.create_primitive_import.return_value = {"id": "imp-r2"}
        r = _import({"$defs": {"Contact": {"type": "string", "format": "email"}}})

    assert r.status_code == 200
    refs = created[0]["refs"]
    # The mapped ref resolves to the core email type's $id.
    assert any(
        e["resolved_target"] == CORE_EMAIL and e["status"] == "resolved" for e in refs
    )
    assert r.json()["rewrites"]["Contact"][0]["kind"] == "core-format"


def test_core_format_mapping_can_be_disabled():
    created = []

    with patch("app.primitives_routes.db") as mdb:
        mdb.create_primitive.side_effect = lambda **k: created.append(k) or {"name": k["name"]}
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive_import.return_value = {"id": "imp-r3"}
        r = _import(
            {"$defs": {"Contact": {"type": "string", "format": "email"}}},
            map_core_formats=False,
        )

    assert r.status_code == 200
    # No $ref injected, so no registry edges recorded for the format.
    assert created[0]["refs"] == []
    assert "Contact" not in r.json()["rewrites"]
    # The stored schema keeps the format but gains no $ref.
    assert "$ref" not in created[0]["schema"]
