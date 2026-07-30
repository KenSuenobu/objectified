"""Unit tests for the JSON Schema draft 2020-12 validator/identity helpers (#3452).

Covers the pure functions in ``app.schema_validation`` that the Primitives create,
update, and import paths all share: meta-schema validation with structured field-level
errors, draft/dialect derivation, stable ``$id`` derivation, base-URI resolution, and
identity stamping.
"""

import pytest

from app import schema_validation as sv


# ===========================================================================
# validate_schema_document
# ===========================================================================


def test_valid_string_schema_has_no_errors():
    assert sv.validate_schema_document({"type": "string"}) == []


def test_valid_full_schema_has_no_errors():
    schema = {
        "$schema": sv.DRAFT_2020_12_META_URI,
        "$id": "https://api.apiome.dev/types/std/v0/primitives/string",
        "type": "string",
        "maxLength": 5,
    }
    assert sv.validate_schema_document(schema) == []


def test_invalid_type_is_reported_field_level():
    errors = sv.validate_schema_document({"type": "stringg"})
    assert len(errors) == 1
    assert errors[0]["path"] == "type"
    assert errors[0]["keyword"] == "anyOf"
    assert "message" in errors[0]


def test_invalid_maxlength_is_reported():
    errors = sv.validate_schema_document({"type": "string", "maxLength": -1})
    assert any(e["path"] == "maxLength" for e in errors)


def test_multiple_faults_each_reported_once():
    errors = sv.validate_schema_document(
        {"type": "objectt", "required": "notalist", "properties": "nope"}
    )
    paths = sorted(e["path"] for e in errors)
    assert paths == ["properties", "required", "type"]
    # Deduplicated: the union-of-vocabularies meta-schema must not double-report a path.
    assert len(paths) == len(set(paths))


def test_boolean_schema_is_valid_per_spec():
    # ``true`` / ``false`` are valid JSON Schemas under the meta-schema.
    assert sv.validate_schema_document(True) == []
    assert sv.validate_schema_document(False) == []


# ===========================================================================
# assert_valid_schema_document
# ===========================================================================


def test_assert_valid_passes_silently():
    sv.assert_valid_schema_document({"type": "integer"})


def test_assert_valid_raises_with_errors():
    with pytest.raises(sv.SchemaValidationError) as exc:
        sv.assert_valid_schema_document({"type": "nope"})
    assert exc.value.errors
    assert exc.value.errors[0]["path"] == "type"


# ===========================================================================
# derive_draft
# ===========================================================================


def test_derive_draft_defaults_to_2020_12():
    assert sv.derive_draft({"type": "string"}) == "2020-12"


def test_derive_draft_reads_2020_12_uri():
    assert sv.derive_draft({"$schema": sv.DRAFT_2020_12_META_URI}) == "2020-12"


def test_derive_draft_reads_legacy_dash_form():
    assert sv.derive_draft({"$schema": "http://json-schema.org/draft-07/schema#"}) == "07"


def test_derive_draft_unrecognized_uri_defaults():
    assert sv.derive_draft({"$schema": "https://example.com/custom"}) == "2020-12"


# ===========================================================================
# derive_base_uri
# ===========================================================================


def test_base_uri_explicit_wins():
    assert (
        sv.derive_base_uri("tenant/acme/v1/types", "https://x.example/base/", "acme")
        == "https://x.example/base/"
    )


def test_base_uri_explicit_gets_trailing_slash():
    assert sv.derive_base_uri(None, "https://x.example/base", "acme") == "https://x.example/base/"


def test_base_uri_from_namespace():
    assert (
        sv.derive_base_uri("tenant/acme/v1/types", None, "acme")
        == "https://api.apiome.dev/types/tenant/acme/v1/types/"
    )


def test_base_uri_tenant_default_when_unplaced():
    assert (
        sv.derive_base_uri(None, None, "acme")
        == "https://api.apiome.dev/types/tenant/acme/"
    )


# ===========================================================================
# derive_schema_id
# ===========================================================================


def test_schema_id_honors_explicit_id():
    schema = {"$id": "https://api.apiome.dev/types/std/v0/primitives/string", "type": "string"}
    assert (
        sv.derive_schema_id(schema, name="Anything", base_uri="https://x/")
        == "https://api.apiome.dev/types/std/v0/primitives/string"
    )


def test_schema_id_derived_from_base_and_slugged_name():
    schema = {"type": "string"}
    assert (
        sv.derive_schema_id(schema, name="Email Address", base_uri="https://x.example/ns/")
        == "https://x.example/ns/email-address"
    )


def test_schema_id_is_stable_for_same_name_and_base():
    a = sv.derive_schema_id({"type": "string"}, name="UUID", base_uri="https://x/ns")
    b = sv.derive_schema_id({"type": "string"}, name="UUID", base_uri="https://x/ns/")
    assert a == b == "https://x/ns/uuid"


def test_schema_id_blank_explicit_id_falls_back_to_derived():
    schema = {"$id": "   ", "type": "string"}
    assert sv.derive_schema_id(schema, name="X", base_uri="https://x/ns/") == "https://x/ns/x"


# ===========================================================================
# stamp_identity
# ===========================================================================


def test_stamp_identity_writes_id_and_schema():
    out = sv.stamp_identity({"type": "string"}, schema_id="https://x/ns/s", draft="2020-12")
    assert out["$id"] == "https://x/ns/s"
    assert out["$schema"] == sv.DRAFT_2020_12_META_URI


def test_stamp_identity_does_not_mutate_input():
    src = {"type": "string"}
    sv.stamp_identity(src, schema_id="https://x/ns/s", draft="2020-12")
    assert "$id" not in src and "$schema" not in src


def test_stamp_identity_preserves_existing_schema_uri():
    out = sv.stamp_identity(
        {"type": "string", "$schema": "https://example.com/custom"},
        schema_id="https://x/ns/s",
        draft="2020-12",
    )
    assert out["$schema"] == "https://example.com/custom"


# ===========================================================================
# merge_definition_containers / is_root_type_document
# ===========================================================================


def test_merge_definition_containers_reads_both_spellings():
    document = {"$defs": {"A": {"type": "string"}}, "definitions": {"B": {"type": "number"}}}
    assert list(sv.merge_definition_containers(document)) == ["A", "B"]


def test_merge_definition_containers_ignores_non_mappings():
    assert sv.merge_definition_containers({"$defs": ["A"]}) == {}
    assert sv.merge_definition_containers("not a document") == {}


def test_root_asserting_something_is_a_type_beside_its_defs():
    document = {"type": "object", "properties": {}, "$defs": {"A": {"type": "string"}}}
    assert sv.is_root_type_document(document, has_definitions=True) is True


def test_pure_container_root_is_not_a_type():
    """A titled bundle is still a bundle — its members are the types."""
    document = {"$id": "https://acme.test/bundle", "title": "Bundle"}
    assert sv.is_root_type_document(document, has_definitions=True) is False


def test_annotation_only_schema_is_a_type_when_it_holds_no_definitions():
    """The empty schema constrains nothing, which is not a reason to refuse it."""
    document = {
        "$schema": sv.DRAFT_2020_12_META_URI,
        "$id": "https://acme.test/api/evaluate/request",
        "title": "Evaluate API Request",
        "examples": ["hello world", 42],
    }
    assert sv.is_root_type_document(document, has_definitions=False) is True


def test_a_lone_annotation_is_enough():
    assert sv.is_root_type_document({"description": "anything"}, has_definitions=False) is True


def test_arbitrary_json_object_is_not_a_type():
    """No JSON Schema keyword at all — a package.json describes no type."""
    document = {"name": "acme-tools", "version": "1.4.0", "scripts": {"build": "tsc"}}
    assert sv.is_root_type_document(document, has_definitions=False) is False


def test_an_empty_defs_box_is_not_a_type():
    """The container keys are stripped from a root, so a bare empty box describes nothing."""
    assert sv.is_root_type_document({"$defs": {}}, has_definitions=False) is False


def test_non_mapping_is_not_a_type():
    assert sv.is_root_type_document(["type", "string"], has_definitions=False) is False


# ===========================================================================
# untyped_schema_warning
# ===========================================================================


def test_untyped_warning_fires_for_a_definition_that_asserts_nothing():
    assert sv.untyped_schema_warning({}) == sv.UNTYPED_SCHEMA_WARNING
    assert sv.untyped_schema_warning({"title": "A"}) == sv.UNTYPED_SCHEMA_WARNING


def test_untyped_warning_is_quiet_when_the_shape_can_be_read():
    """Not a guess: properties -> object, enum -> its values' type, $ref/combinator -> elsewhere."""
    for schema in (
        {"type": "string"},
        {"properties": {}},
        {"enum": ["a"]},
        {"const": 1},
        {"$ref": "./money"},
        {"allOf": [{"type": "string"}]},
        {"items": {"type": "string"}},
    ):
        assert sv.untyped_schema_warning(schema) is None, schema


def test_untyped_warning_ignores_a_non_mapping_definition():
    assert sv.untyped_schema_warning(["type", "string"]) is None
    assert sv.untyped_schema_warning(None) is None
