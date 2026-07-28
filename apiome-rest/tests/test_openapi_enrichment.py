"""Tests for OpenAPI spec enrichment (dogfooding schema_lint)."""

from __future__ import annotations

import re

import yaml

from app.openapi_enrichment import enrich_openapi_spec
from app.schema_lint import lint_openapi_spec


def _load_spec() -> dict:
    with open("openapi.yaml", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def test_enriched_spec_scores_a_or_better() -> None:
    result = lint_openapi_spec(enrich_openapi_spec(_load_spec()))
    assert result.score >= 90, result.rule_hits
    assert result.grade == "A"


def test_primitive_class_and_operation_schemas_are_documented() -> None:
    spec = enrich_openapi_spec(_load_spec())
    schemas = spec["components"]["schemas"]
    for name in (
        "PrimitiveSchema",
        "ClassSchema",
        "OperationSchema",
        "PathSchema",
        "ProjectPropertySchema",
    ):
        assert schemas[name]["description"].strip()
        for prop_name, prop_schema in schemas[name]["properties"].items():
            if "$ref" in prop_schema and "type" not in prop_schema:
                continue
            assert prop_schema.get("description"), f"{name}.{prop_name} missing description"


def test_renames_non_pascal_case_component_schemas() -> None:
    spec = enrich_openapi_spec(_load_spec())
    schemas = spec["components"]["schemas"]
    assert "MockScenarioSpec-Input" not in schemas
    assert "MockScenarioSpecInput" in schemas
    assert "SpecImportMultipartUploadBody" in schemas


def test_no_component_schema_name_survives_non_pascal_case() -> None:
    """The rename pass must leave *nothing* the linter's naming rule would reject.

    Asserted over the whole document rather than over a curated list: the generated names come
    and go as models change, and a spec regeneration should not need a hand-edit here to stay
    lint-clean.
    """
    schemas = enrich_openapi_spec(_load_spec())["components"]["schemas"]
    offenders = [name for name in schemas if not re.match(r"^[A-Z][A-Za-z0-9]*$", name)]
    assert offenders == []


def test_renames_fastapi_split_model_ids_without_merging_the_pair() -> None:
    """``Foo-Input`` / ``Foo-Output`` lose the hyphen and stay two distinct components.

    FastAPI emits the pair when a model's validation and serialization schemas differ. Merging
    them would claim the model round-trips identically when the generator has just said it does
    not, so only the hyphen is closed.
    """
    spec = {
        "components": {
            "schemas": {
                "MockScenarioRuleSpec-Input": {"type": "object", "properties": {}},
                "MockScenarioRuleSpec-Output": {"type": "object", "properties": {}},
                # Not PascalCase once the hyphen closes, so it is left alone rather than
                # half-fixed into another name the linter would still reject.
                "lower_case-Input": {"type": "object", "properties": {}},
            }
        },
        "paths": {},
    }
    schemas = enrich_openapi_spec(spec)["components"]["schemas"]
    assert "MockScenarioRuleSpecInput" in schemas
    assert "MockScenarioRuleSpecOutput" in schemas
    assert "MockScenarioRuleSpec-Input" not in schemas
    assert "MockScenarioRuleSpec-Output" not in schemas
    assert "lower_case-Input" in schemas


def test_split_model_rename_rewrites_every_reference() -> None:
    """A renamed component takes its ``$ref``s with it, or the document stops resolving."""
    spec = {
        "components": {
            "schemas": {
                "WidgetSpec-Input": {"type": "object", "properties": {}},
                "Envelope": {
                    "type": "object",
                    "properties": {"widget": {"$ref": "#/components/schemas/WidgetSpec-Input"}},
                },
            }
        },
        "paths": {},
    }
    enriched = enrich_openapi_spec(spec)
    ref = enriched["components"]["schemas"]["Envelope"]["properties"]["widget"]["$ref"]
    assert ref == "#/components/schemas/WidgetSpecInput"


def _missing_field_descriptions(spec: dict) -> list[str]:
    missing: list[str] = []
    http_methods = {"get", "put", "post", "delete", "patch", "options", "head", "trace"}

    def walk_schema(schema: dict, path: str, schema_name: str) -> None:
        if not isinstance(schema, dict):
            return
        if _is_ref_only(schema):
            return
        props = schema.get("properties")
        if isinstance(props, dict):
            for prop_name, prop_schema in props.items():
                ppath = f"{path}.properties.{prop_name}"
                if isinstance(prop_schema, dict):
                    if not _nonempty_str(prop_schema.get("description")):
                        missing.append(ppath)
                    walk_schema(prop_schema, ppath, schema_name)
        if schema.get("type") == "array" and isinstance(schema.get("items"), dict):
            walk_schema(schema["items"], path + ".items", schema_name)

    for sname, schema in spec.get("components", {}).get("schemas", {}).items():
        if isinstance(schema, dict):
            walk_schema(schema, f"components.schemas.{sname}", sname)

    for ppath, path_item in spec.get("paths", {}).items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method not in http_methods or not isinstance(operation, dict):
                continue
            op_path = f"paths.{ppath}.{method}"
            for param in operation.get("parameters") or []:
                if isinstance(param, dict) and not _nonempty_str(param.get("description")):
                    missing.append(f"{op_path}.parameters.{param.get('name')}")
                schema = param.get("schema") if isinstance(param, dict) else None
                if isinstance(schema, dict):
                    walk_schema(schema, f"{op_path}.parameters.{param.get('name')}.schema", "Parameter")
            rb = operation.get("requestBody")
            if isinstance(rb, dict) and not _nonempty_str(rb.get("description")):
                missing.append(f"{op_path}.requestBody")

    return missing


def _nonempty_str(value: object) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_ref_only(schema: dict) -> bool:
    return "$ref" in schema and "type" not in schema and "properties" not in schema


def test_parameters_and_request_bodies_have_descriptions() -> None:
    spec = enrich_openapi_spec(_load_spec())
    missing = _missing_field_descriptions(spec)
    assert missing == [], missing[:20]


# ---------------------------------------------------------------------------
# Synthesized examples respect the schema they are attached to — IXH-5.4 (#5116)
# ---------------------------------------------------------------------------


def _enriched_property(schema: dict) -> object:
    """Enrich a one-property spec and return the example the enricher chose."""
    spec = {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "1"},
        "paths": {},
        "components": {"schemas": {"Widget": {"type": "object", "properties": {"p": schema}}}},
    }
    return enrich_openapi_spec(spec)["components"]["schemas"]["Widget"]["properties"]["p"]["example"]


def test_const_properties_get_their_only_legal_example() -> None:
    """A ``const`` property has exactly one valid example; guessing from its name cannot win."""
    assert _enriched_property({"type": "string", "const": "modelled"}) == "modelled"


def test_enum_properties_prefer_their_default_member() -> None:
    """The default is what a client sees most often, and it is by definition a legal member."""
    schema = {"type": "string", "enum": ["warn", "block"], "default": "warn"}

    assert _enriched_property(schema) == "warn"


def test_enum_properties_without_a_legal_default_take_the_first_member() -> None:
    """A default outside the enum is not a usable example; the first member is, deterministically."""
    schema = {"type": "string", "enum": ["ready", "review"], "default": "archived"}

    assert _enriched_property(schema) == "ready"


def test_numeric_examples_are_clamped_into_range() -> None:
    """A name-guessed number is fitted to the bounds beside it rather than contradicting them."""
    schema = {"type": "integer", "minimum": 100, "maximum": 599}

    assert _enriched_property(schema) == 100


def test_string_examples_are_padded_to_min_length() -> None:
    """A secret bounded to 8 characters may not be given a 7-character example."""
    schema = {"type": "string", "minLength": 12}
    value = _enriched_property(schema)

    assert isinstance(value, str)
    assert len(value) == 12


def test_patterned_strings_are_left_alone() -> None:
    """Padding a patterned string would likely break the pattern; an honest miss beats a bad fix."""
    schema = {"type": "string", "minLength": 40, "pattern": "^[a-z]+$"}

    assert _enriched_property(schema) == "example"


def test_the_generated_contract_has_no_non_conforming_examples() -> None:
    """apiome's own published contract must pass the rule it ships (IXH-5.4).

    The contract is the rule's first real subject: shipping a linter that fires 24 times on our
    own ``openapi.yaml`` would be shipping a broken product.
    """
    from app.example_conformance_lint import example_conformance_findings

    findings = example_conformance_findings(enrich_openapi_spec(_load_spec()))

    assert findings == [], [f.path for f in findings]
