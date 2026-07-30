"""Unit tests for the pure registry scope-enforcement helpers (#3453).

Covers ``$ref`` discovery, registry-namespace resolution (absolute, relative, fragment,
external), tenant-segment extraction, core detection, and the two reference-direction
rules: a system-core type may not ``$ref`` a tenant namespace, and a tenant type may not
``$ref`` another tenant's namespace (tenant→core stays allowed).
"""

import pytest

from app.primitives_scope import (
    ScopeViolationError,
    enforce_ref_scope,
    find_forbidden_refs,
    is_core_namespace,
    iter_refs,
    registry_namespace_of_ref,
    tenant_segment_of,
)

BASE = "https://api.apiome.dev/types/"
STD_BASE = BASE + "std/v0/primitives/"
ACME_BASE = BASE + "tenant/acme/v1/types/"


# ===========================================================================
# iter_refs
# ===========================================================================


def test_iter_refs_walks_nested_objects_and_arrays():
    schema = {
        "type": "object",
        "properties": {
            "a": {"$ref": "./money"},
            "b": {"items": {"$ref": "#/$defs/X"}},
        },
        "allOf": [{"$ref": ACME_BASE + "other"}],
    }
    assert sorted(iter_refs(schema)) == sorted(
        ["./money", "#/$defs/X", ACME_BASE + "other"]
    )


def test_iter_refs_ignores_non_string_ref_values():
    # A malformed (non-string) $ref is left for the meta-validator, not yielded here.
    assert list(iter_refs({"$ref": {"not": "a string"}})) == []


def test_iter_refs_empty_for_schema_without_refs():
    assert list(iter_refs({"type": "string", "maxLength": 5})) == []


# ===========================================================================
# registry_namespace_of_ref
# ===========================================================================


def test_absolute_ref_under_registry_resolves_to_path():
    ref = BASE + "tenant/acme/v1/types/money"
    assert registry_namespace_of_ref(ref, STD_BASE) == "tenant/acme/v1/types/money"


def test_relative_ref_resolves_against_base():
    assert registry_namespace_of_ref("./uuid", STD_BASE) == "std/v0/primitives/uuid"


def test_relative_dotdot_ref_walks_up_namespace_tree():
    # From std/v0/primitives/, walking up two levels then into tenant stays under std.
    assert (
        registry_namespace_of_ref("../../tenant/acme/x", STD_BASE)
        == "std/tenant/acme/x"
    )


def test_fragment_ref_is_same_document_not_a_namespace():
    assert registry_namespace_of_ref("#/$defs/Money", STD_BASE) is None


def test_external_ref_is_not_a_registry_namespace():
    assert registry_namespace_of_ref("https://json-schema.org/x", STD_BASE) is None


def test_ref_with_trailing_fragment_classifies_by_path():
    ref = BASE + "tenant/acme/v1/types/money#/$defs/Cents"
    assert registry_namespace_of_ref(ref, STD_BASE) == "tenant/acme/v1/types/money"


# ===========================================================================
# tenant_segment_of / is_core_namespace
# ===========================================================================


@pytest.mark.parametrize(
    "path,expected",
    [
        ("tenant/acme/v1/types/money", "tenant/acme"),
        ("tenant/acme", "tenant/acme"),
        ("std/v0/primitives/string", None),
        ("vendor/fhir/r4/patient", None),
        ("tenant", None),  # no slug segment
        (None, None),
    ],
)
def test_tenant_segment_of(path, expected):
    assert tenant_segment_of(path) == expected


@pytest.mark.parametrize(
    "namespace,expected",
    [
        ("std", True),
        ("std/v0/types", True),
        ("std/v0/primitives/", True),
        ("standard/v0", False),  # not the std root
        ("tenant/acme/v1", False),
        (None, False),
    ],
)
def test_is_core_namespace(namespace, expected):
    assert is_core_namespace(namespace) is expected


# ===========================================================================
# find_forbidden_refs — core → tenant
# ===========================================================================


def test_core_type_referencing_tenant_namespace_is_forbidden():
    schema = {"type": "object", "properties": {"m": {"$ref": ACME_BASE + "money"}}}
    violations = find_forbidden_refs(
        schema, is_core=True, base_uri=STD_BASE, own_tenant_segment=None
    )
    assert len(violations) == 1
    assert violations[0]["reason"] == "core-to-tenant"
    assert violations[0]["target"] == "tenant/acme/v1/types/money"


def test_core_type_referencing_core_namespace_is_allowed():
    schema = {"$ref": STD_BASE + "uuid"}
    assert find_forbidden_refs(
        schema, is_core=True, base_uri=STD_BASE, own_tenant_segment=None
    ) == []


def test_core_type_with_internal_and_external_refs_is_allowed():
    schema = {
        "allOf": [{"$ref": "#/$defs/X"}, {"$ref": "https://json-schema.org/y"}],
        "$defs": {"X": {"type": "string"}},
    }
    assert find_forbidden_refs(
        schema, is_core=True, base_uri=STD_BASE, own_tenant_segment=None
    ) == []


# ===========================================================================
# find_forbidden_refs — tenant → other tenant (cross-tenant isolation)
# ===========================================================================


def test_tenant_type_referencing_other_tenant_is_forbidden():
    schema = {"$ref": BASE + "tenant/globex/v1/types/widget"}
    violations = find_forbidden_refs(
        schema, is_core=False, base_uri=ACME_BASE, own_tenant_segment="tenant/acme"
    )
    assert len(violations) == 1
    assert violations[0]["reason"] == "cross-tenant"


def test_tenant_type_referencing_own_namespace_is_allowed():
    schema = {"$ref": ACME_BASE + "address"}
    assert find_forbidden_refs(
        schema, is_core=False, base_uri=ACME_BASE, own_tenant_segment="tenant/acme"
    ) == []


def test_tenant_type_referencing_core_is_allowed():
    schema = {"$ref": STD_BASE + "uuid"}
    assert find_forbidden_refs(
        schema, is_core=False, base_uri=ACME_BASE, own_tenant_segment="tenant/acme"
    ) == []


def test_unknown_own_tenant_does_not_flag_cross_tenant():
    # When the owning tenant can't be derived, cross-tenant comparison is skipped.
    schema = {"$ref": BASE + "tenant/globex/v1/types/widget"}
    assert find_forbidden_refs(
        schema, is_core=False, base_uri=BASE + "vendor/x/", own_tenant_segment=None
    ) == []


def test_duplicate_refs_reported_once():
    ref = ACME_BASE + "money"
    schema = {"allOf": [{"$ref": ref}, {"$ref": ref}]}
    violations = find_forbidden_refs(
        schema, is_core=True, base_uri=STD_BASE, own_tenant_segment=None
    )
    assert len(violations) == 1


# ===========================================================================
# enforce_ref_scope
# ===========================================================================


def test_enforce_raises_for_core_to_tenant_with_message():
    schema = {"$ref": ACME_BASE + "money"}
    with pytest.raises(ScopeViolationError) as exc:
        enforce_ref_scope(schema, is_core=True, base_uri=STD_BASE, own_tenant_segment=None)
    assert "system-core" in exc.value.message
    assert exc.value.violations[0]["reason"] == "core-to-tenant"


def test_enforce_raises_for_cross_tenant_with_message():
    schema = {"$ref": BASE + "tenant/globex/v1/types/widget"}
    with pytest.raises(ScopeViolationError) as exc:
        enforce_ref_scope(
            schema, is_core=False, base_uri=ACME_BASE, own_tenant_segment="tenant/acme"
        )
    assert "another tenant" in exc.value.message


def test_enforce_is_silent_when_all_refs_allowed():
    schema = {"$ref": STD_BASE + "uuid"}
    enforce_ref_scope(schema, is_core=False, base_uri=ACME_BASE, own_tenant_segment="tenant/acme")
