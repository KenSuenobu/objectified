"""Unit tests for the import ``$ref`` rewrite + core-format mapping engine (#3463).

The rewrite engine (:mod:`app.primitives_rewrite`) is pure and side-effect free, so it is
tested directly on parsed schemas: intra-source pointers become relative registry refs,
recognized formats map to core ``std/v0/types`` types, and — critically — every rewritten ref
round-trips through the resolver's URL semantics so it resolves via Epic 3 (#3456).
"""

from urllib.parse import urljoin

import pytest

from app.primitives_resolver import build_ref_edges
from app.primitives_rewrite import (
    CORE_FORMAT_TO_TYPE,
    core_type_uri,
    registry_relative_ref,
    rewrite_import_schema,
    rewrite_internal_ref,
)
from app.primitives_scope import resolve_registry_uri

BASE = "https://api.apiome.dev/types/std/v0/types/"
TENANT_BASE = "https://api.apiome.dev/types/tenant/acme/"


# ---------------------------------------------------------------------------
# rewrite_internal_ref
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ref,expected",
    [
        ("#/$defs/Money", "./money"),
        ("#/definitions/Money", "./money"),
        ("#/types/Line", "./line"),
        ("#/$defs/CurrencyCode", "./currencycode"),
        ("#/types/Money/properties/amount", "./money#/properties/amount"),
    ],
)
def test_rewrite_internal_ref_maps_each_container(ref, expected):
    assert rewrite_internal_ref(ref) == expected


@pytest.mark.parametrize(
    "ref",
    [
        "../primitives/string",  # already a registry-relative ref
        "https://json-schema.org/draft/2020-12/schema",  # external absolute
        "#",  # bare root
        "#/properties/x",  # a non-definitions pointer
        "",
    ],
)
def test_rewrite_internal_ref_leaves_non_intra_source_refs(ref):
    assert rewrite_internal_ref(ref) is None


def test_rewrite_internal_ref_unescapes_pointer_tokens():
    # ~1 escapes a slash in a JSON Pointer token; the leaf name is decoded before slugging.
    assert rewrite_internal_ref("#/$defs/a~1b") == "./a-b"


# ---------------------------------------------------------------------------
# registry_relative_ref — inverse of resolve_registry_uri
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "base,target",
    [
        (BASE, core_type_uri("email")),
        (TENANT_BASE, core_type_uri("uuid")),
        ("https://api.apiome.dev/types/tenant/acme/v3/types/", core_type_uri("date")),
    ],
)
def test_registry_relative_ref_round_trips(base, target):
    rel = registry_relative_ref(base, target)
    # The computed relative ref, resolved against the base, returns the original target.
    assert urljoin(base, rel) == target
    # And it resolves under the registry root (i.e. Epic 3 will treat it as a registry edge).
    assert resolve_registry_uri(rel, base) == target


def test_registry_relative_ref_falls_back_to_absolute_when_no_common_root():
    # A non-registry base has no meaningful relative path; the absolute target is returned.
    assert registry_relative_ref("", core_type_uri("email")) == core_type_uri("email")


# ---------------------------------------------------------------------------
# rewrite_import_schema — full document rewrite
# ---------------------------------------------------------------------------


def test_rewrite_does_not_mutate_input():
    original = {"$ref": "#/$defs/Money"}
    snapshot = dict(original)
    rewritten, _ = rewrite_import_schema(original, base_uri=BASE)
    assert original == snapshot
    assert rewritten == {"$ref": "./money"}


def test_rewrite_internal_refs_resolve_via_epic_3():
    schema = {
        "type": "object",
        "properties": {"line": {"$ref": "#/types/Line"}},
    }
    rewritten, changes = rewrite_import_schema(schema, base_uri=BASE)
    assert rewritten["properties"]["line"]["$ref"] == "./line"
    assert {"from": "#/types/Line", "to": "./line", "kind": "internal"} in changes

    # The rewritten ref produces a resolved registry edge once the target exists.
    target = urljoin(BASE, "./line")
    edges = build_ref_edges(rewritten, base_uri=BASE, target_exists=lambda u: u == target)
    assert edges == [
        {"relative_ref": "./line", "resolved_target": target, "status": "resolved"}
    ]


@pytest.mark.parametrize("fmt,leaf", sorted(CORE_FORMAT_TO_TYPE.items()))
def test_core_format_maps_to_core_type(fmt, leaf):
    schema = {"type": "string", "format": fmt}
    rewritten, changes = rewrite_import_schema(schema, base_uri=TENANT_BASE)
    expected_ref = registry_relative_ref(TENANT_BASE, core_type_uri(leaf))
    assert rewritten["$ref"] == expected_ref
    assert {"from": fmt, "to": expected_ref, "kind": "core-format"} in changes
    # The injected ref resolves to the seeded core type.
    assert resolve_registry_uri(expected_ref, TENANT_BASE) == core_type_uri(leaf)


def test_core_format_maps_nested_properties():
    schema = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "contact": {"type": "string", "format": "email"},
        },
    }
    rewritten, _ = rewrite_import_schema(schema, base_uri=BASE)
    assert rewritten["properties"]["id"]["$ref"] == "./uuid"
    assert rewritten["properties"]["contact"]["$ref"] == "./email"


def test_core_format_does_not_override_existing_ref():
    schema = {"type": "string", "format": "email", "$ref": "../custom/email"}
    rewritten, changes = rewrite_import_schema(schema, base_uri=BASE)
    # An author's explicit ref wins; no core mapping is injected.
    assert rewritten["$ref"] == "../custom/email"
    assert all(c["kind"] != "core-format" for c in changes)


def test_unrecognized_format_is_left_alone():
    schema = {"type": "string", "format": "hostname"}
    rewritten, changes = rewrite_import_schema(schema, base_uri=BASE)
    assert "$ref" not in rewritten
    assert changes == []


def test_format_disabled_when_map_core_formats_false():
    schema = {"type": "string", "format": "email"}
    rewritten, changes = rewrite_import_schema(
        schema, base_uri=BASE, map_core_formats=False
    )
    assert "$ref" not in rewritten
    assert changes == []


def test_property_named_format_is_not_treated_as_a_keyword():
    # A property literally named "format" is a sub-schema, not the format keyword.
    schema = {
        "type": "object",
        "properties": {"format": {"type": "string"}},
    }
    rewritten, changes = rewrite_import_schema(schema, base_uri=BASE)
    assert "$ref" not in rewritten["properties"]["format"]
    assert changes == []
