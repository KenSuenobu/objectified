"""Unit tests for author-time schema checking of mock configuration (#5532, MSC-2.2).

Response *synthesis* moved to ``apiome_mock.schema_synthesizer`` when the second engine was
retired; what stayed is checking a value an author typed against the schema the spec declares for
it, which is asked at save time and has no runtime counterpart.
"""

from app.mock_schema_validation import validate_value


def test_a_matching_value_reports_no_error():
    assert validate_value(7, {"type": "integer"}) is None


def test_a_mismatched_value_names_the_failure():
    error = validate_value("not-an-int", {"type": "integer"})
    assert error is not None
    assert error.startswith("<root>: ")


def test_a_nested_failure_names_its_json_path():
    schema = {
        "type": "object",
        "properties": {"pet": {"type": "object", "properties": {"id": {"type": "integer"}}}},
    }
    error = validate_value({"pet": {"id": "nine"}}, schema)
    assert error is not None and error.startswith("pet/id: ")


def test_an_empty_or_non_mapping_schema_constrains_nothing():
    """A response the spec declares no schema for cannot be wrong, so it must pass."""
    assert validate_value({"anything": True}, {}) is None
    assert validate_value({"anything": True}, None) is None
    assert validate_value({"anything": True}, "not-a-schema") is None


def test_refs_resolve_against_the_root_document():
    root = {
        "components": {
            "schemas": {
                "Pet": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
                }
            }
        }
    }
    schema = {"$ref": "#/components/schemas/Pet"}
    assert validate_value({"id": 1, "name": "Rex"}, schema, root) is None
    assert validate_value({"name": "Rex"}, schema, root) is not None


def test_a_root_that_is_the_schema_itself_is_not_merged_into_itself():
    schema = {"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}
    assert validate_value({"id": 1}, schema, schema) is None
    assert validate_value({}, schema, schema) is not None


def test_an_unresolvable_schema_reports_rather_than_raises():
    error = validate_value(1, {"type": "not-a-json-schema-type"})
    assert error is not None and error.startswith("invalid schema: ")
