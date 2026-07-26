"""Tests for the canonical-model → JSON Schema projection — IXH-5.1 (#5113).

The projection is what lets a payload be validated against a *project version* or a *catalog
revision*, neither of which stores a JSON Schema. Its contract is narrow and load-bearing: the
output must be a legal draft 2020-12 schema, deterministic, cycle-safe, bounded, and honest about
what it could not express.
"""

from __future__ import annotations

from typing import List

import pytest
from jsonschema.validators import Draft202012Validator

from app.canonical_json_schema import (
    CANONICAL_SCALAR_SCHEMAS,
    CanonicalTypeNotFoundError,
    build_type_json_schema,
    list_projectable_types,
)
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Type,
    TypeKind,
    TypeRef,
)
from app.schema_instance_validation import validate_json_instance


def _api(types: List[Type]) -> CanonicalApi:
    """Wrap a type list in the smallest legal canonical model."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="fixture"),
        types=types,
    )


def _field(owner: str, name: str, type_ref: TypeRef, **kwargs) -> CanonicalField:
    """Build a record member with the canonical stable-key convention."""
    return CanonicalField(key=f"{owner}.{name}", name=name, type=type_ref, **kwargs)


# ===========================================================================
# Records, enums, unions, maps, aliases
# ===========================================================================


def test_record_projects_properties_and_required() -> None:
    """A record becomes an object; only ``nullable=False`` members are required."""
    pet = Type(
        key="Pet",
        name="Pet",
        kind=TypeKind.RECORD,
        fields=[
            _field("Pet", "id", TypeRef(name="string", nullable=False)),
            _field("Pet", "age", TypeRef(name="i32")),
        ],
    )

    projection = build_type_json_schema(_api([pet]), "Pet")

    assert projection.document["type"] == "object"
    assert projection.document["properties"]["id"] == {"type": "string"}
    assert projection.document["properties"]["age"] == {"type": "integer", "format": "int32"}
    assert projection.document["required"] == ["id"]
    assert projection.document["title"] == "Pet"


def test_projected_schema_is_itself_a_legal_2020_12_schema() -> None:
    """Whatever the source scalars, the output must be a schema a validator will accept."""
    weird = Type(
        key="Weird",
        name="Weird",
        kind=TypeKind.RECORD,
        fields=[
            _field("Weird", "money", TypeRef(name="Currency")),
            _field("Weird", "when", TypeRef(name="timestamp")),
            _field("Weird", "raw", TypeRef(name="bytes")),
        ],
    )

    projection = build_type_json_schema(_api([weird]), "Weird")

    Draft202012Validator.check_schema(projection.document)


def test_unmapped_scalar_constrains_nothing_and_is_reported() -> None:
    """A source scalar with no JSON analogue accepts anything, and the caller is told."""
    money = Type(
        key="Invoice",
        name="Invoice",
        kind=TypeKind.RECORD,
        fields=[_field("Invoice", "total", TypeRef(name="Money"))],
    )

    projection = build_type_json_schema(_api([money]), "Invoice")

    assert projection.document["properties"]["total"] == {}
    assert projection.unmapped_scalars == ("Money",)
    # And the permissiveness is real: nothing at that position can fail.
    assert validate_json_instance(projection.document, {"total": ["anything"]}).valid is True


def test_enum_projects_wire_values_and_narrows_type() -> None:
    """An enum's declared wire values win over its names, and a homogeneous enum gets a type."""
    status = Type(
        key="Status",
        name="Status",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Status.ACTIVE", name="ACTIVE"),
            EnumValue(key="Status.OFF", name="OFF", value="disabled"),
        ],
    )

    projection = build_type_json_schema(_api([status]), "Status")

    assert projection.document["enum"] == ["ACTIVE", "disabled"]
    assert projection.document["type"] == "string"


def test_integer_enum_narrows_to_integer() -> None:
    """A protobuf-style numeric enum projects as ``integer``, not ``string``."""
    code = Type(
        key="Code",
        name="Code",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Code.OK", name="OK", value=0),
            EnumValue(key="Code.ERR", name="ERR", value=1),
        ],
    )

    projection = build_type_json_schema(_api([code]), "Code")

    assert projection.document["type"] == "integer"
    assert projection.document["enum"] == [0, 1]


def test_union_projects_oneof_over_member_refs() -> None:
    """A union becomes ``oneOf`` and pulls each member into ``$defs``."""
    cat = Type(key="Cat", name="Cat", kind=TypeKind.RECORD)
    dog = Type(key="Dog", name="Dog", kind=TypeKind.RECORD)
    pet = Type(key="Pet", name="Pet", kind=TypeKind.UNION, union_members=["Cat", "Dog"])

    projection = build_type_json_schema(_api([cat, dog, pet]), "Pet")

    assert projection.document["oneOf"] == [
        {"$ref": "#/$defs/Cat"},
        {"$ref": "#/$defs/Dog"},
    ]
    assert set(projection.document["$defs"]) == {"Cat", "Dog"}


def test_map_projects_additional_properties() -> None:
    """A map becomes an object constrained by its value type."""
    headers = Type(
        key="Headers",
        name="Headers",
        kind=TypeKind.MAP,
        key_type=TypeRef(name="string"),
        value_type=TypeRef(name="string"),
    )

    projection = build_type_json_schema(_api([headers]), "Headers")

    assert projection.document["type"] == "object"
    assert projection.document["additionalProperties"] == {"type": "string"}


def test_alias_projects_its_target() -> None:
    """An alias validates as the thing it aliases."""
    alias = Type(key="Id", name="Id", kind=TypeKind.ALIAS, aliased=TypeRef(name="uuid"))

    projection = build_type_json_schema(_api([alias]), "Id")

    assert projection.document["type"] == "string"
    assert projection.document["format"] == "uuid"


def test_list_reference_projects_nested_arrays() -> None:
    """``[[string]]`` projects as an array of arrays of strings."""
    matrix = Type(
        key="Matrix",
        name="Matrix",
        kind=TypeKind.RECORD,
        fields=[
            _field(
                "Matrix",
                "rows",
                TypeRef(item=TypeRef(item=TypeRef(name="string"))),
            )
        ],
    )

    projection = build_type_json_schema(_api([matrix]), "Matrix")

    assert projection.document["properties"]["rows"] == {
        "type": "array",
        "items": {"type": "array", "items": {"type": "string"}},
    }


def test_constraints_are_copied_onto_the_subschema() -> None:
    """The canonical constraint vocabulary is the JSON Schema one, so it maps by rename only."""
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            _field(
                "User",
                "handle",
                TypeRef(name="string", nullable=False),
                constraints=Constraints(min_length=3, max_length=16, pattern="^[a-z]+$"),
            ),
            _field(
                "User",
                "score",
                TypeRef(name="number"),
                constraints=Constraints(minimum=0, maximum=100, multiple_of=0.5),
            ),
        ],
    )

    projection = build_type_json_schema(_api([user]), "User")
    handle = projection.document["properties"]["handle"]
    score = projection.document["properties"]["score"]

    assert (handle["minLength"], handle["maxLength"], handle["pattern"]) == (3, 16, "^[a-z]+$")
    assert (score["minimum"], score["maximum"], score["multipleOf"]) == (0, 100, 0.5)
    result = validate_json_instance(projection.document, {"handle": "AB", "score": 101})
    assert {f.keyword for f in result.findings} == {"minLength", "pattern", "maximum"}


# ===========================================================================
# Reachability, cycles, bounds, determinism
# ===========================================================================


def test_only_reachable_types_enter_defs() -> None:
    """A type the root never references is not dragged into the validation document."""
    leaf = Type(key="Leaf", name="Leaf", kind=TypeKind.RECORD)
    unrelated = Type(key="Unrelated", name="Unrelated", kind=TypeKind.RECORD)
    root = Type(
        key="Root",
        name="Root",
        kind=TypeKind.RECORD,
        fields=[_field("Root", "leaf", TypeRef(name="Leaf"))],
    )

    projection = build_type_json_schema(_api([leaf, unrelated, root]), "Root")

    assert set(projection.document["$defs"]) == {"Leaf"}


def test_self_referential_type_terminates() -> None:
    """A type that contains itself projects once and validates recursively."""
    node = Type(
        key="Node",
        name="Node",
        kind=TypeKind.RECORD,
        fields=[
            _field("Node", "name", TypeRef(name="string", nullable=False)),
            _field("Node", "children", TypeRef(item=TypeRef(name="Node"))),
        ],
    )

    projection = build_type_json_schema(_api([node]), "Node")

    assert projection.document["$defs"]["Node"]["properties"]["children"] == {
        "type": "array",
        "items": {"$ref": "#/$defs/Node"},
    }
    result = validate_json_instance(
        projection.document, {"name": "a", "children": [{"children": []}]}
    )
    assert result.validated is True
    assert [f.pointer for f in result.findings] == ["/children/0"]


def test_mutually_recursive_types_terminate() -> None:
    """``A → B → A`` projects both types exactly once."""
    a = Type(
        key="A",
        name="A",
        kind=TypeKind.RECORD,
        fields=[_field("A", "b", TypeRef(name="B"))],
    )
    b = Type(
        key="B",
        name="B",
        kind=TypeKind.RECORD,
        fields=[_field("B", "a", TypeRef(name="A"))],
    )

    projection = build_type_json_schema(_api([a, b]), "A")

    assert set(projection.document["$defs"]) == {"A", "B"}


def test_defs_budget_truncates_and_says_so() -> None:
    """Past the ``$defs`` ceiling the projection stops and marks itself truncated."""
    chain = [
        Type(
            key=f"T{n}",
            name=f"T{n}",
            kind=TypeKind.RECORD,
            fields=[_field(f"T{n}", "next", TypeRef(name=f"T{n + 1}"))],
        )
        for n in range(10)
    ]
    chain.append(Type(key="T10", name="T10", kind=TypeKind.RECORD))

    projection = build_type_json_schema(_api(chain), "T0", max_defs=3)

    assert projection.truncated is True
    assert len(projection.document["$defs"]) == 3


def test_projection_is_deterministic_and_defs_are_sorted() -> None:
    """Two projections of an equal model are equal, and ``$defs`` order is a model property."""
    types = [
        Type(key="Zebra", name="Zebra", kind=TypeKind.RECORD),
        Type(key="Apple", name="Apple", kind=TypeKind.RECORD),
        Type(
            key="Root",
            name="Root",
            kind=TypeKind.RECORD,
            fields=[
                _field("Root", "z", TypeRef(name="Zebra")),
                _field("Root", "a", TypeRef(name="Apple")),
            ],
        ),
    ]

    first = build_type_json_schema(_api(types), "Root")
    second = build_type_json_schema(_api(list(types)), "Root")

    assert first.document == second.document
    assert list(first.document["$defs"]) == ["Apple", "Zebra"]


def test_qualified_keys_are_sanitized_into_defs_keys() -> None:
    """A package-qualified key cannot inject a pointer separator into its own ``$ref``."""
    pet = Type(key="acme/pets.v1/Pet", name="Pet", kind=TypeKind.RECORD)
    root = Type(
        key="Root",
        name="Root",
        kind=TypeKind.RECORD,
        fields=[_field("Root", "pet", TypeRef(name="acme/pets.v1/Pet"))],
    )

    projection = build_type_json_schema(_api([pet, root]), "Root")

    ref = projection.document["properties"]["pet"]["$ref"]
    assert ref == "#/$defs/acme_pets.v1_Pet"
    assert ref.split("#/$defs/")[1] in projection.document["$defs"]


# ===========================================================================
# Addressing
# ===========================================================================


def test_type_is_addressable_by_key_and_by_name() -> None:
    """Both the stable key and the source name resolve to the same type."""
    pet = Type(key="acme.Pet", name="Pet", kind=TypeKind.RECORD)
    api = _api([pet])

    assert build_type_json_schema(api, "acme.Pet").type_key == "acme.Pet"
    assert build_type_json_schema(api, "Pet").type_key == "acme.Pet"
    assert list_projectable_types(api) == ["Pet", "acme.Pet"]


def test_unknown_type_lists_the_candidates() -> None:
    """A miss is guidance, not a bare failure."""
    api = _api([Type(key="acme.Pet", name="Pet", kind=TypeKind.RECORD)])

    with pytest.raises(CanonicalTypeNotFoundError) as excinfo:
        build_type_json_schema(api, "Nope")

    assert excinfo.value.ambiguous is False
    assert excinfo.value.candidates == ["Pet", "acme.Pet"]


def test_ambiguous_name_is_refused_rather_than_guessed() -> None:
    """Two types sharing a source name must be addressed by key."""
    api = _api(
        [
            Type(key="a.Pet", name="Pet", kind=TypeKind.RECORD),
            Type(key="b.Pet", name="Pet", kind=TypeKind.RECORD),
        ]
    )

    with pytest.raises(CanonicalTypeNotFoundError) as excinfo:
        build_type_json_schema(api, "Pet")

    assert excinfo.value.ambiguous is True


@pytest.mark.parametrize("scalar_name", sorted(CANONICAL_SCALAR_SCHEMAS))
def test_scalar_map_only_holds_legal_json_schema_types(scalar_name: str) -> None:
    """Every mapped scalar must produce a schema a 2020-12 validator accepts."""
    fragment = CANONICAL_SCALAR_SCHEMAS[scalar_name]

    Draft202012Validator.check_schema(fragment)

    assert set(fragment) <= {"type", "format", "contentEncoding"}
    assert fragment["type"] in {"string", "integer", "number", "boolean", "null"}
