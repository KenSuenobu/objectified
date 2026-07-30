"""API tests for import review: conflicts, dedupe, validation report, resolutions (#3464).

``POST /v1/primitives/{tenant_slug}/import/review`` classifies each definition against the
registry without writing, and ``POST .../import`` honors the caller's per-type resolutions on
commit. The DB is mocked, so these assert on the classification surfaced by the review and on
the create/update calls the commit makes for each resolution.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.schema_validation import DRAFT_2020_12_META_URI

client = TestClient(app)

_JWT = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

# The $id a Money type imported into tenant acme's default namespace derives.
MONEY_ID = "https://api.apiome.dev/types/tenant/acme/money"


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _stamped(schema, schema_id):
    """Build the stamped form an imported schema is stored as (matches stamp_identity)."""
    return {**schema, "$id": schema_id, "$schema": DRAFT_2020_12_META_URI}


def _existing_money(schema):
    """An existing registry row at MONEY_ID carrying the given (stamped) schema."""
    return {"id": "e-money", "name": "Money", "schema": _stamped(schema, MONEY_ID)}


def _review(schema, **extra):
    body = {"schema": schema, "import_all": True}
    body.update(extra)
    return client.post("/v1/primitives/acme/import/review", json=body)


def _import(schema, **extra):
    body = {"schema": schema, "import_all": True}
    body.update(extra)
    return client.post("/v1/primitives/acme/import", json=body)


# =========================================================================== #
# Review endpoint — classification & report (writes nothing)
# =========================================================================== #


def test_review_classifies_new_identical_and_conflict():
    """Three defs against a registry that already holds two of them are classified correctly."""
    money_schema = {"type": "object"}

    def _lookup(schema_id, tenant_id):
        if schema_id == MONEY_ID:
            # Money exists with the SAME schema → identical.
            return _existing_money(money_schema)
        if schema_id == "https://api.apiome.dev/types/tenant/acme/invoice":
            # Invoice exists with a DIFFERENT schema → conflict.
            return {"id": "e-inv", "schema": {"type": "string"}}
        return None  # Customer is new

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = _lookup
        r = _review(
            {
                "$defs": {
                    "Money": money_schema,
                    "Invoice": {"type": "object"},
                    "Customer": {"type": "object"},
                }
            }
        )

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "review"
    # Nothing was written.
    mdb.create_primitive.assert_not_called()
    mdb.update_primitive.assert_not_called()

    by_name = {t["name"]: t for t in body["types"]}
    assert by_name["Money"]["status"] == "identical"
    assert by_name["Invoice"]["status"] == "conflict"
    assert by_name["Customer"]["status"] == "new"
    # Only the conflict offers resolution choices.
    assert by_name["Invoice"]["allowed_resolutions"] == ["keep", "overwrite", "rename"]
    assert by_name["Customer"]["allowed_resolutions"] == []
    # The conflict points at the existing row.
    assert by_name["Invoice"]["existing_id"] == "e-inv"

    assert body["summary"] == {
        "new": 1,
        "identical": 1,
        "conflict": 1,
        "invalid": 0,
        "total": 3,
    }


def test_review_reports_validation_errors_for_invalid_definition():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        r = _review({"$defs": {"Bad": {"type": "stringg"}}})

    assert r.status_code == 200
    body = r.json()
    bad = body["types"][0]
    assert bad["status"] == "invalid"
    assert bad["valid"] is False
    assert bad["error"]["error"] == "invalid_schema"
    assert bad["validation_errors"][0]["path"] == "type"
    assert body["summary"]["invalid"] == 1


# =========================================================================== #
# Commit — resolutions applied
# =========================================================================== #


def test_commit_conflict_default_keep_surfaces_not_silently_skipped():
    """A conflict with no resolution is reported (not silently dropped) and nothing is written."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda sid, tid: _existing_money({"type": "string"}) if sid == MONEY_ID else None
        )
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import({"$defs": {"Money": {"type": "object"}}})

    assert r.status_code == 200
    body = r.json()
    mdb.create_primitive.assert_not_called()
    mdb.update_primitive.assert_not_called()
    assert body["skipped"] == ["Money"]
    assert body["imported"] == []
    # The conflict is surfaced in the per-type review.
    review = next(t for t in body["reviews"] if t["name"] == "Money")
    assert review["status"] == "conflict"
    assert review["existing_id"] == "e-money"


def test_commit_overwrite_updates_existing_row():
    updated = []

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda sid, tid: _existing_money({"type": "string"}) if sid == MONEY_ID else None
        )
        mdb.update_primitive.side_effect = lambda pid, tid, updates: updated.append(
            (pid, updates)
        ) or {"id": pid}
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "overwrite"}},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["overwritten"] == ["Money"]
    assert body["total_overwritten"] == 1
    mdb.create_primitive.assert_not_called()
    # The existing row was updated with the new (stamped) schema.
    assert len(updated) == 1
    pid, updates = updated[0]
    assert pid == "e-money"
    assert updates["schema"]["$id"] == MONEY_ID
    assert updates["schema"]["type"] == "object"


def test_commit_rename_creates_under_new_name():
    created = []

    def _lookup(sid, tid):
        # Money exists (conflict); the rename target money_v2 does not.
        if sid == MONEY_ID:
            return _existing_money({"type": "string"})
        return None

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = _lookup
        mdb.create_primitive.side_effect = lambda **k: created.append(k) or {"name": k["name"]}
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "rename", "new_name": "money_v2"}},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["renamed"] == [{"from": "Money", "to": "money_v2"}]
    assert body["total_renamed"] == 1
    # The new row is created under the renamed identity.
    assert len(created) == 1
    assert created[0]["name"] == "money_v2"
    # The renamed leaf is slugified (lowercased, '_' → '-') the same as any derived $id.
    assert created[0]["schema_id"] == "https://api.apiome.dev/types/tenant/acme/money-v2"


def test_commit_rename_into_existing_name_is_an_error():
    def _lookup(sid, tid):
        # Both Money and the rename target already exist → rename collides.
        if sid == MONEY_ID:
            return _existing_money({"type": "string"})
        if sid == "https://api.apiome.dev/types/tenant/acme/money-v2":
            return {"id": "e-v2", "schema": {"type": "boolean"}}
        return None

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = _lookup
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "rename", "new_name": "money_v2"}},
        )

    assert r.status_code == 200
    body = r.json()
    mdb.create_primitive.assert_not_called()
    err = next(e for e in body["errors"] if e["name"] == "Money")
    assert err["error"] == "rename_conflict"


def test_commit_overwrite_of_system_type_is_rejected():
    """A tenant import cannot overwrite a shared system-core type (no phantom overwrite)."""
    system_row = {"id": "sys-money", "is_system": True, "schema": {"type": "string"}}

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda sid, tid: system_row if sid == MONEY_ID else None
        )
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "overwrite"}},
        )

    assert r.status_code == 200
    body = r.json()
    mdb.update_primitive.assert_not_called()
    assert body["overwritten"] == []
    err = next(e for e in body["errors"] if e["name"] == "Money")
    assert err["error"] == "cannot_overwrite_system"


def test_commit_dedupes_identical_definitions():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = (
            lambda sid, tid: _existing_money({"type": "object"}) if sid == MONEY_ID else None
        )
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import({"$defs": {"Money": {"type": "object"}}})

    assert r.status_code == 200
    body = r.json()
    mdb.create_primitive.assert_not_called()
    assert body["identical"] == ["Money"]
    assert body["total_identical"] == 1
    assert body["imported"] == []


def test_commit_invalid_resolution_action_is_400():
    # Resolution validation (_normalize_resolutions) runs before any registry lookup, so no
    # get_primitive_by_schema_id stub is needed — the 400 is raised before the commit loop. The
    # db is patched only to guarantee the route can't reach a real database if that order ever
    # changed; the lookup is asserted untouched below.
    with patch("app.primitives_routes.db") as mdb:
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "explode"}},
        )
    assert r.status_code == 400
    assert "Invalid resolution action" in r.json()["detail"]
    mdb.get_primitive_by_schema_id.assert_not_called()


def test_commit_rename_without_new_name_is_400():
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        r = _import(
            {"$defs": {"Money": {"type": "object"}}},
            resolutions={"Money": {"action": "rename"}},
        )
    assert r.status_code == 400
    assert "new_name" in r.json()["detail"]


def test_commit_report_counts_match_mixed_outcome():
    """A mixed batch's counts equal its per-type outcomes (report matches outcomes)."""
    created = []
    updated = []

    invoice_id = "https://api.apiome.dev/types/tenant/acme/invoice"

    def _lookup(sid, tid):
        if sid == MONEY_ID:
            return _existing_money({"type": "string"})  # conflict → overwrite
        if sid == invoice_id:
            # Same schema as imported → identical → deduped.
            return {"id": "e-inv", "schema": _stamped({"type": "object"}, invoice_id)}
        return None  # Customer → new

    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.side_effect = _lookup
        mdb.create_primitive.side_effect = lambda **k: created.append(k["name"]) or {"name": k["name"]}
        mdb.update_primitive.side_effect = lambda pid, tid, u: updated.append(pid) or {"id": pid}
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(
            {
                "$defs": {
                    "Money": {"type": "object"},
                    "Invoice": {"type": "object"},
                    "Customer": {"type": "object"},
                }
            },
            resolutions={"Money": {"action": "overwrite"}},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == ["Customer"]
    assert body["overwritten"] == ["Money"]
    assert body["identical"] == ["Invoice"]
    assert body["total_imported"] == 1
    assert body["total_overwritten"] == 1
    assert body["total_identical"] == 1
    assert body["total_errors"] == 0
    # Provenance counts: 2 written (created + overwritten), 1 passed over (deduped).
    _, kwargs = mdb.create_primitive_import.call_args
    assert kwargs["imported_count"] == 2
    assert kwargs["skipped_count"] == 1
