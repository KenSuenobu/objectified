"""Tests for the Kubernetes structural-schema rules — FMT-2.1 (#5419).

:mod:`app.k8s_structural_schema` is the independent checker behind the CRD
emitter's acceptance criterion "emitted CRDs validate against the
``apiextensions.k8s.io/v1`` schema and satisfy structural-schema rules". These
tests pin each rule it enforces, in both directions: a conforming schema produces
no violations, and every restriction is reported with the path of the node that
broke it.
"""

from __future__ import annotations

import pytest

from app.k8s_structural_schema import (
    CRD_API_VERSION,
    INT_OR_STRING,
    KUBERNETES_KNOWN_FORMATS,
    PRESERVE_UNKNOWN_FIELDS,
    STRUCTURAL_FORBIDDEN_KEYWORDS,
    structural_schema_violations,
    validate_k8s_crd_document,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

STRUCTURAL_SCHEMA = {
    "type": "object",
    "description": "A structural schema Kubernetes accepts.",
    "properties": {
        "spec": {
            "type": "object",
            "required": ["topic"],
            "properties": {
                "topic": {"type": "string", "minLength": 1},
                "replicas": {"type": "integer", "minimum": 1},
                "labels": {"type": "object", "additionalProperties": {"type": "string"}},
                "peers": {"type": "array", "items": {"type": "string"}},
                "port": {INT_OR_STRING: True},
                "extra": {PRESERVE_UNKNOWN_FIELDS: True},
            },
        },
        "status": {"type": "object", PRESERVE_UNKNOWN_FIELDS: True},
    },
}


def _crd(schema: dict | None = None, **overrides) -> str:
    """Render a minimal CRD document as YAML text, with optional overrides."""
    import yaml

    version = {
        "name": overrides.pop("version_name", "v1"),
        "served": True,
        "storage": overrides.pop("storage", True),
    }
    if schema is not None:
        version["schema"] = {"openAPIV3Schema": schema}
    versions = overrides.pop("versions", [version])
    plural = overrides.pop("plural", "queues")
    group = overrides.pop("group", "messaging.example.io")
    document = {
        "apiVersion": overrides.pop("api_version", CRD_API_VERSION),
        "kind": "CustomResourceDefinition",
        "metadata": {"name": overrides.pop("name", f"{plural}.{group}")},
        "spec": {
            "group": group,
            "names": {"kind": "Queue", "plural": plural, "singular": "queue"},
            "scope": overrides.pop("scope", "Namespaced"),
            "versions": versions,
        },
    }
    assert not overrides, f"unused overrides: {sorted(overrides)}"
    return yaml.safe_dump(document, sort_keys=False)


# ---------------------------------------------------------------------------
# structural_schema_violations
# ---------------------------------------------------------------------------


def test_a_structural_schema_has_no_violations() -> None:
    assert structural_schema_violations(STRUCTURAL_SCHEMA) == []


def test_root_must_declare_a_type() -> None:
    violations = structural_schema_violations({"properties": {}})
    assert len(violations) == 1
    assert "must declare a non-empty `type`" in violations[0]


def test_every_property_must_declare_a_type() -> None:
    violations = structural_schema_violations(
        {"type": "object", "properties": {"spec": {"description": "no type"}}}
    )
    assert violations == [
        "openAPIV3Schema.properties.spec: must declare a non-empty `type` "
        f"(or set `{PRESERVE_UNKNOWN_FIELDS}`/`{INT_OR_STRING}`)"
    ]


def test_array_items_must_declare_a_type() -> None:
    violations = structural_schema_violations(
        {"type": "object", "properties": {"tags": {"type": "array", "items": {}}}}
    )
    assert any("properties.tags.items" in message for message in violations)


def test_an_array_must_declare_items() -> None:
    violations = structural_schema_violations({"type": "array"})
    assert violations == ["openAPIV3Schema: an `array` node must declare an `items` schema"]


@pytest.mark.parametrize("marker", [PRESERVE_UNKNOWN_FIELDS, INT_OR_STRING])
def test_vendor_markers_opt_a_node_out_of_the_type_rule(marker: str) -> None:
    assert structural_schema_violations(
        {"type": "object", "properties": {"free": {marker: True}}}
    ) == []


def test_int_or_string_must_not_also_declare_a_type() -> None:
    violations = structural_schema_violations({INT_OR_STRING: True, "type": "string"})
    assert violations == [f"openAPIV3Schema: `{INT_OR_STRING}` nodes must not declare a `type`"]


@pytest.mark.parametrize(
    "keyword", ["$ref", "deprecated", "oneOf", "patternProperties", "definitions", "not"]
)
def test_forbidden_keywords_are_reported(keyword: str) -> None:
    assert keyword in STRUCTURAL_FORBIDDEN_KEYWORDS
    violations = structural_schema_violations({"type": "object", keyword: "anything"})
    assert violations == [
        f"openAPIV3Schema: `{keyword}` is not allowed in a structural schema"
    ]


def test_forbidden_keywords_are_reported_at_depth() -> None:
    violations = structural_schema_violations(
        {
            "type": "object",
            "properties": {"spec": {"type": "object", "properties": {"x": {"$ref": "#/a"}}}},
        }
    )
    assert (
        "openAPIV3Schema.properties.spec.properties.x: `$ref` is not allowed in a "
        "structural schema"
    ) in violations


def test_unique_items_true_is_rejected() -> None:
    violations = structural_schema_violations(
        {"type": "array", "items": {"type": "string"}, "uniqueItems": True}
    )
    assert violations == ["openAPIV3Schema: `uniqueItems: true` is not supported by Kubernetes"]


def test_unique_items_false_is_allowed() -> None:
    assert structural_schema_violations(
        {"type": "array", "items": {"type": "string"}, "uniqueItems": False}
    ) == []


def test_additional_properties_false_is_rejected() -> None:
    violations = structural_schema_violations({"type": "object", "additionalProperties": False})
    assert violations == ["openAPIV3Schema: `additionalProperties: false` is not allowed"]


def test_additional_properties_and_properties_are_mutually_exclusive() -> None:
    violations = structural_schema_violations(
        {
            "type": "object",
            "properties": {"a": {"type": "string"}},
            "additionalProperties": {"type": "string"},
        }
    )
    assert violations == [
        "openAPIV3Schema: `additionalProperties` and `properties` are mutually exclusive"
    ]


def test_unknown_formats_are_rejected() -> None:
    violations = structural_schema_violations({"type": "string", "format": "iso-4217-currency"})
    assert violations == [
        "openAPIV3Schema: `format: iso-4217-currency` is not a Kubernetes-known format"
    ]


@pytest.mark.parametrize("known", sorted(KUBERNETES_KNOWN_FORMATS))
def test_kubernetes_known_formats_are_accepted(known: str) -> None:
    assert structural_schema_violations({"type": "string", "format": known}) == []


def test_a_non_mapping_node_is_a_violation() -> None:
    assert structural_schema_violations(["not", "a", "schema"]) == [
        "openAPIV3Schema: expected a schema object, got list"
    ]


def test_the_path_prefix_is_configurable() -> None:
    violations = structural_schema_violations({}, path="queues/v1")
    assert violations[0].startswith("queues/v1: ")


# ---------------------------------------------------------------------------
# validate_k8s_crd_document
# ---------------------------------------------------------------------------


def test_a_well_formed_crd_validates() -> None:
    validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA))


def test_a_version_without_a_schema_validates() -> None:
    """`spec.versions[].schema` is optional; only a present schema is checked."""
    validate_k8s_crd_document(_crd(None))


def test_unparsable_text_is_rejected() -> None:
    with pytest.raises(Exception):
        validate_k8s_crd_document("not: [a, crd")


def test_a_non_crd_document_is_rejected() -> None:
    with pytest.raises(Exception):
        validate_k8s_crd_document("apiVersion: v1\nkind: ConfigMap\n")


def test_a_legacy_api_version_is_rejected() -> None:
    with pytest.raises(ValueError, match="apiVersion must be"):
        validate_k8s_crd_document(
            _crd(STRUCTURAL_SCHEMA, api_version="apiextensions.k8s.io/v1beta1")
        )


def test_metadata_name_must_be_plural_dot_group() -> None:
    with pytest.raises(ValueError, match="metadata.name must be"):
        validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA, name="queue-definitions"))


def test_scope_must_be_namespaced_or_cluster() -> None:
    with pytest.raises(ValueError, match="scope must be"):
        validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA, scope="Global"))


def test_exactly_one_storage_version_is_required() -> None:
    with pytest.raises(ValueError, match="exactly one version must set"):
        validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA, storage=False))

    two_storage = [
        {"name": "v1", "served": True, "storage": True},
        {"name": "v2", "served": True, "storage": True},
    ]
    with pytest.raises(ValueError, match="exactly one version must set"):
        validate_k8s_crd_document(_crd(None, versions=two_storage))


def test_version_names_must_be_kubernetes_shaped() -> None:
    with pytest.raises(ValueError, match="version names must look like"):
        validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA, version_name="1.0.0"))


@pytest.mark.parametrize("name", ["v1", "v2", "v1beta1", "v2alpha3"])
def test_kubernetes_shaped_version_names_are_accepted(name: str) -> None:
    validate_k8s_crd_document(_crd(STRUCTURAL_SCHEMA, version_name=name))


def test_a_non_structural_schema_is_rejected_with_its_path() -> None:
    schema = {"type": "object", "properties": {"spec": {"oneOf": [{"type": "string"}]}}}
    with pytest.raises(ValueError) as excinfo:
        validate_k8s_crd_document(_crd(schema))
    message = str(excinfo.value)
    assert "queues.messaging.example.io/v1.properties.spec" in message
    assert "`oneOf` is not allowed" in message


def test_every_violation_is_reported_not_just_the_first() -> None:
    schema = {"type": "object", "properties": {"a": {}, "b": {}}}
    with pytest.raises(ValueError) as excinfo:
        validate_k8s_crd_document(_crd(schema, scope="Global"))
    message = str(excinfo.value)
    assert "scope must be" in message
    assert ".properties.a" in message
    assert ".properties.b" in message
