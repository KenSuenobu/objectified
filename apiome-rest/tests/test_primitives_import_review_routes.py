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
from app.schema_validation import DRAFT_2020_12_META_URI, UNTYPED_SCHEMA_WARNING

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
        "warnings": 0,
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


# =========================================================================== #
# Root-schema resolution — a document is not only its $defs
# =========================================================================== #


# A schema like https://schemas.sourcemeta.com/self/v1/schemas/api/list/response.json: it
# declares an $id, a type, and properties of its own *and* carries $defs of the sub-schemas
# it refs. Reading only the container imported `policies` and silently dropped `response`.
_ROOT_AND_DEFS = {
    "$schema": DRAFT_2020_12_META_URI,
    "$id": "https://schemas.sourcemeta.com/self/v1/schemas/api/list/response",
    "title": "Sourcemeta One List API Response",
    "type": "object",
    "required": ["policies"],
    "properties": {"policies": {"$ref": "#/$defs/policies"}},
    "$defs": {"policies": {"type": "array", "items": {"type": "object"}}},
}


def _review_names(schema, **extra):
    """Review a document with an empty registry and return the reported type names."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        r = _review(schema, **extra)
    assert r.status_code == 200, r.text
    return r.json()


def test_review_imports_the_root_schema_alongside_its_defs():
    """A document that is itself a schema is a type too — not just a bag of $defs."""
    body = _review_names(_ROOT_AND_DEFS)
    # Root first: it is the document's headline type, its $defs hold its parts.
    assert [t["name"] for t in body["types"]] == ["response", "policies"]
    assert body["summary"]["total"] == 2


def test_root_schema_is_named_from_its_id():
    """The $id's last segment is the name the registry already serves the document under."""
    body = _review_names(_ROOT_AND_DEFS)
    root = body["types"][0]
    assert root["name"] == "response"
    assert root["schema_id"] == "https://schemas.sourcemeta.com/self/v1/schemas/api/list/response"


def test_root_schema_drops_its_own_defs_container():
    """The root's $defs members are imported as their own types, so the inline copy would be dead
    weight — its `#/$defs/...` pointers are rewritten to relative registry refs instead."""
    created = {}
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.side_effect = (
            lambda **k: created.setdefault(k["name"], k) or {"name": k["name"]}
        )
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(_ROOT_AND_DEFS)

    assert r.status_code == 200, r.text
    assert r.json()["imported"] == ["response", "policies"]
    root_schema = created["response"]["schema"]
    assert "$defs" not in root_schema
    assert root_schema["properties"]["policies"]["$ref"] == "./policies"


def test_root_schema_falls_back_to_title_then_source_label():
    """With no $id the title names the root; with neither, the source label's last segment does."""
    titled = {k: v for k, v in _ROOT_AND_DEFS.items() if k != "$id"}
    assert _review_names(titled)["types"][0]["name"] == "sourcemeta-one-list-api-response"

    bare = {k: v for k, v in titled.items() if k != "title"}
    body = _review_names(bare, source_label="https://acme.test/schemas/list-response.json")
    assert body["types"][0]["name"] == "list-response"


def test_root_name_colliding_with_a_def_is_suffixed_not_dropped():
    """A root sharing a name with one of its own definitions describes a different type."""
    doc = {
        "$id": "https://acme.test/policies",
        "type": "object",
        "$defs": {"policies": {"type": "array"}},
    }
    body = _review_names(doc)
    assert [t["name"] for t in body["types"]] == ["policies-root", "policies"]
    assert any("policies-root" in w for w in body["warnings"])


def test_a_pure_container_document_still_imports_only_its_defs():
    """A document that asserts nothing about itself contributes no root type."""
    body = _review_names({"$defs": {"Money": {"type": "object"}}})
    assert [t["name"] for t in body["types"]] == ["Money"]


def test_a_document_that_is_neither_schema_nor_container_is_400():
    """Arbitrary JSON that merely parses as an object carries no JSON Schema keyword."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        r = _review({"name": "acme-tools", "version": "1.4.0", "scripts": {"build": "tsc"}})
    assert r.status_code == 400
    assert "No definitions found" in r.json()["detail"]


def test_an_empty_defs_box_is_400():
    """A document whose only content is an empty container declares no type at all."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        r = _review({"$defs": {}})
    assert r.status_code == 400
    assert "No definitions found" in r.json()["detail"]


# =========================================================================== #
# Annotation-only schemas — a type need not constrain anything
# =========================================================================== #


# https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/evaluate/request.json: a schema that
# accepts *any* JSON instance, so it declares no `type` and no `properties` — only its identity
# and documentation. It is the empty schema, and it is the only type the document describes.
_ANNOTATION_ONLY = {
    "$schema": DRAFT_2020_12_META_URI,
    "$id": "https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/evaluate/request",
    "title": "Sourcemeta One Schema Evaluate API Request",
    "description": "The JSON instance to validate against a schema in the catalog",
    "examples": [{"name": "Alice", "age": 30}, "hello world", 42, True, None, [1, 2, 3]],
}


def test_annotation_only_schema_is_reviewed_as_one_valid_type():
    """A document carrying only `$schema`/`$id`/title/description/examples is still a type."""
    body = _review_names(_ANNOTATION_ONLY)
    assert [t["name"] for t in body["types"]] == ["request"]
    root = body["types"][0]
    assert root["valid"] is True
    assert root["validation_errors"] == []
    assert root["status"] == "new"
    assert root["schema_id"] == _ANNOTATION_ONLY["$id"]


def test_annotation_only_schema_imports_as_an_empty_object_type():
    """Committing it creates one primitive: no type / no properties files under 'object'."""
    created = {}
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.side_effect = (
            lambda **k: created.setdefault(k["name"], k) or {"name": k["name"]}
        )
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(_ANNOTATION_ONLY)

    assert r.status_code == 200, r.text
    assert r.json()["imported"] == ["request"]
    row = created["request"]
    assert row["category"] == "object"
    assert row["description"] == _ANNOTATION_ONLY["description"]
    # The examples survive verbatim: they are the only thing the schema says about instances.
    assert row["schema"]["examples"] == _ANNOTATION_ONLY["examples"]
    # Nothing was invented on the author's behalf — no `type` was stamped in.
    assert "type" not in row["schema"]


def test_annotation_only_schema_is_reviewed_with_the_untyped_advisory():
    """It imports, and the review says what the author left out — a caution, not an error."""
    root = _review_names(_ANNOTATION_ONLY)["types"][0]
    assert root["warnings"] == [UNTYPED_SCHEMA_WARNING]
    # An advisory is not a verdict: the type is still valid and still importable.
    assert root["valid"] is True
    assert root["status"] == "new"


def test_a_definition_whose_shape_can_be_read_gets_no_advisory():
    """`properties`, an `enum`, a `$ref` — the type follows from those, so nothing is guessed."""
    body = _review_names(
        {
            "$defs": {
                "typed": {"type": "string"},
                "from-properties": {"properties": {"a": {"type": "string"}}},
                "from-enum": {"enum": ["a", "b"]},
                "from-ref": {"$ref": "./money"},
            }
        }
    )
    assert all(t["warnings"] == [] for t in body["types"])


def test_the_advisory_reaches_the_commit_report_too():
    """The commit's per-type review block mirrors the review endpoint, advisories included."""
    with patch("app.primitives_routes.db") as mdb:
        mdb.get_primitive_by_schema_id.return_value = None
        mdb.create_primitive.side_effect = lambda **k: {"name": k["name"]}
        mdb.create_primitive_import.return_value = {"id": "imp1"}
        r = _import(_ANNOTATION_ONLY)

    assert r.status_code == 200, r.text
    reviews = r.json()["reviews"]
    assert [rev["name"] for rev in reviews] == ["request"]
    assert reviews[0]["warnings"] == [UNTYPED_SCHEMA_WARNING]


# =========================================================================== #
# Summary — the cautioned-type count
# =========================================================================== #


def test_summary_counts_a_type_with_an_unresolved_ref_as_a_warning():
    body = _review_names(
        {
            "$defs": {
                "position": {"type": "object", "properties": {"x": {"$ref": "./missing"}}},
                "money": {"type": "object"},
            }
        },
        target_namespace="acme/v1/types",
    )
    assert body["summary"]["warnings"] == 1
    # It is still New — a caution cuts across the classification rather than replacing it.
    assert body["summary"]["new"] == 2
    assert body["summary"]["total"] == 2


def test_summary_counts_an_advisory_as_a_warning_too():
    """The untyped-schema notice is a caution on the same axis as an unresolved ref."""
    assert _review_names(_ANNOTATION_ONLY)["summary"]["warnings"] == 1


def test_summary_counts_a_type_once_however_many_cautions_it_carries():
    body = _review_names(
        {
            "$defs": {
                "both": {"title": "Untyped", "$ref": "./missing"},
            }
        },
        target_namespace="acme/v1/types",
    )
    assert body["summary"]["warnings"] == 1


def test_summary_reports_zero_warnings_when_everything_is_clean():
    body = _review_names({"$defs": {"money": {"type": "object"}}})
    assert body["summary"]["warnings"] == 0


def test_annotation_only_schema_beside_defs_contributes_no_root_type():
    """A titled bundle is still a bundle: its members are the types, the root is not one."""
    doc = {
        "$schema": DRAFT_2020_12_META_URI,
        "$id": "https://acme.test/schemas/bundle",
        "title": "Acme type bundle",
        "$defs": {"Money": {"type": "object"}},
    }
    assert [t["name"] for t in _review_names(doc)["types"]] == ["Money"]
