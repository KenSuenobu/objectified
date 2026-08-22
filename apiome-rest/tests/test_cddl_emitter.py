"""Unit tests for the CDDL emitter — FMT-4.4 (#5437).

The ticket's first acceptance criterion has two halves, and this suite owns the second: *a
CDDL file emitted from the same model round-trips*. It is asserted the strongest way the
repository can — every shipped valid corpus fixture is imported, re-emitted and re-imported,
and the two canonical models must be **identical**, not merely similar.

The rest of the suite covers the writer's two modes. A model imported from CDDL is written
back from the spellings the reader recorded (*native*); a model imported from anywhere else
has its canonical constraints projected onto control operators, and everything CDDL cannot
carry is recorded as a loss rather than dropped (*projected*).
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.cddl_emitter import (
    CddlEmitOptions,
    CddlEmitter,
    CddlFidelityRulePack,
    validate_cddl_document,
)
from app.cddl_grammar import CddlParseError
from app.cddl_normalizer import CddlNormalizer
from app.cddl_parser import parse_cddl, parse_cddl_fileset
from app.emitter import LossKind, get_emitter, load_builtin_emitters
from app.import_source import canonical_diff

load_builtin_emitters()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "cddl"

#: The shipped single-file valid fixtures, in corpus order.
VALID_FIXTURES = sorted(path.name for path in CORPUS.glob("*.cddl"))


@pytest.fixture()
def emitter() -> CddlEmitter:
    """The registered CDDL emitter."""
    return CddlEmitter()


def _import(name: str) -> CanonicalApi:
    """Import one shipped corpus fixture."""
    text = (CORPUS / name).read_text(encoding="utf-8")
    return CddlNormalizer().normalize(parse_cddl(text, source_label=name))


def _emit(api: CanonicalApi, **options) -> str:
    """Emit one model and return the single file's text."""
    result = CddlEmitter().emit(api, opts=CddlEmitOptions(**options) if options else None)
    assert len(result.files) == 1
    return str(result.files[0].content)


def _reimport(text: str) -> CanonicalApi:
    """Re-import an emitted grammar."""
    return CddlNormalizer().normalize(parse_cddl(text, source_label="emitted.cddl"))


def _rule(text: str, name: str) -> str:
    """Return the emitted rule for ``name``, from its assignment to its blank line."""
    lines: List[str] = []
    collecting = False
    for line in text.splitlines():
        if line.startswith(f"{name} =") or line.startswith(f"{name} /="):
            collecting = True
        elif collecting and (not line.strip()):
            break
        if collecting:
            lines.append(line)
    assert lines, f"no rule named {name!r} in\n{text}"
    return "\n".join(lines)


def _types_only_api() -> CanonicalApi:
    """A model that never saw CDDL — the writer's *projected* mode."""
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="json-schema",
        identity=ApiIdentity(name="Widget"),
        title="Widget",
        types=[
            Type(
                key="Widget",
                name="Widget",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="Widget.sku",
                        name="sku",
                        type=TypeRef(name="string", nullable=False),
                        field_number=1,
                        constraints=Constraints(
                            min_length=3, max_length=3, pattern="[A-Z]{3}"
                        ),
                    ),
                    CanonicalField(
                        key="Widget.quantity",
                        name="quantity",
                        type=TypeRef(name="i64", nullable=False),
                        field_number=2,
                        constraints=Constraints(minimum=1, maximum=99),
                        default=1,
                    ),
                    CanonicalField(
                        key="Widget.tags",
                        name="tags",
                        type=TypeRef(item=TypeRef(name="string", nullable=False)),
                        field_number=3,
                    ),
                    CanonicalField(
                        key="Widget.note",
                        name="note",
                        type=TypeRef(name="string"),
                        field_number=4,
                    ),
                ],
            )
        ],
    )


# ===========================================================================
# Registration
# ===========================================================================


def test_emitter_is_registered_for_the_cddl_format() -> None:
    assert get_emitter("cddl") is CddlEmitter


def test_emitter_declares_a_types_only_data_schema_target(emitter: CddlEmitter) -> None:
    assert emitter.key == "cddl"
    assert emitter.paradigm is ApiParadigm.DATA_SCHEMA
    assert emitter.multi_file is False
    profile = CddlEmitter.capability_profile()
    assert profile.operations is False
    assert profile.events is False
    assert profile.unions is True


def test_the_fidelity_rule_pack_drops_operations_and_channels() -> None:
    assert CddlEmitter.fidelity_rule_pack() is CddlFidelityRulePack
    pack = CddlFidelityRulePack(CddlEmitter.capability_profile(), "CDDL")
    operation = pack.operation_verdict(
        Operation(key="GET /x", name="x", kind=OperationKind.QUERY)
    )
    channel = pack.channel_verdict(Channel(key="chan", address="chan"))
    assert "types-only" in operation.message
    assert "types-only" in channel.message


def test_the_output_path_is_named_after_the_model() -> None:
    result = CddlEmitter().emit(_import("02-typical-order.cddl"))
    assert result.files[0].path == "order.cddl"
    assert result.media_type == "text/plain"


# ===========================================================================
# AC 1 — a CDDL file emitted from the same model round-trips
# ===========================================================================


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_every_valid_fixture_round_trips_with_no_canonical_diff(name: str) -> None:
    source = _import(name)
    diff = canonical_diff(source, _reimport(_emit(source)))
    assert diff.is_empty, [
        f"{entry.change.value} {entry.entity} {entry.key}" for entry in diff.entries
    ]


def test_the_multi_file_fixture_round_trips_into_one_grammar() -> None:
    """CDDL has no include: a set composes into one namespace and is written as one file."""
    members: Dict[str, str] = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-modules-set").iterdir())
        if path.is_file()
    }
    source = CddlNormalizer().normalize(parse_cddl_fileset(members, root="api.cddl"))
    diff = canonical_diff(source, _reimport(_emit(source)))
    assert diff.is_empty, [entry.key for entry in diff.entries]


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_emitting_the_same_model_twice_is_byte_identical(name: str) -> None:
    source = _import(name)
    assert _emit(source) == _emit(source)


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_every_emitted_grammar_re_parses(name: str) -> None:
    validate_cddl_document(_emit(_import(name)))


def test_the_entry_rule_is_written_first_so_re_import_agrees() -> None:
    """RFC 8610 §3.1 makes the first rule the entry point; writing any other first
    would silently move it."""
    text = _emit(_import("02-typical-order.cddl"))
    first = next(line for line in text.splitlines() if "=" in line and not line.startswith(";"))
    assert first.startswith("order = ")


# ===========================================================================
# Native mode — the reader's spellings are written back
# ===========================================================================


def test_prelude_spellings_survive_rather_than_being_re_derived() -> None:
    text = _emit(_import("01-minimal-person.cddl"))
    assert "name: tstr," in text
    assert "age: uint," in text
    assert "? email: tstr," in text


def test_a_tag_is_written_back_around_its_type() -> None:
    text = _emit(_import("05-real-world-cose-shaped.cddl"))
    assert "COSE_Sign_Tagged = #6.98(COSE_Sign)" in text


def test_a_type_socket_is_written_back_as_its_plugs() -> None:
    text = _emit(_import("03-composition-sockets-and-generics.cddl"))
    assert "$message /= ping-message" in text
    assert "$message /= pong-message" in text


def test_sockets_can_be_flattened_into_one_closed_rule() -> None:
    text = _emit(_import("03-composition-sockets-and-generics.cddl"), sockets_as_plugs=False)
    assert "$message = ping-message / pong-message" in text
    assert "/=" not in text


def test_control_operators_are_written_back_verbatim() -> None:
    text = _emit(_import("04-stress-control-operators.cddl"))
    rule = _rule(text, "corners")
    for spelling in (
        "tstr .size (1..40)",
        "bstr .size 32",
        'tstr .regexp "[A-Z]{3}-[0-9]{4}"',
        "bstr .cbor inner",
        "bstr .cborseq inner",
        "refined .within broad",
        "uint .and (1..100)",
        "uint .default 3",
        "uint .bits flag-bits",
        "int .ne 0",
    ):
        assert spelling in rule, spelling


def test_a_compound_control_operand_is_parenthesised() -> None:
    """`tstr .size 1..40` would re-associate as `(tstr .size 1) .. 40`."""
    rule = _rule(_emit(_import("04-stress-control-operators.cddl")), "corners")
    assert "tstr .size (1..40)" in rule
    assert "tstr .size 1..40," not in rule


def test_nested_list_occurrences_are_rebuilt_exactly() -> None:
    rule = _rule(_emit(_import("04-stress-control-operators.cddl")), "corners")
    assert "matrix: [3*3 [3*3 number]]," in rule
    assert "at-least-one: [+ tstr]," in rule
    assert "at-most-five: [0*5 uint]," in rule


def test_an_array_record_is_written_with_brackets_and_a_map_with_braces() -> None:
    text = _emit(_import("05-real-world-cose-shaped.cddl"))
    assert _rule(text, "COSE_Sign").startswith("COSE_Sign = [")
    assert _rule(text, "COSE_Key").startswith("COSE_Key = {")


def test_a_table_entry_keeps_its_key_type() -> None:
    assert "* label => values," in _rule(
        _emit(_import("05-real-world-cose-shaped.cddl")), "COSE_Key"
    )


def test_a_whole_body_group_choice_is_written_inline_not_as_extra_rules() -> None:
    text = _emit(_import("04-stress-control-operators.cddl"))
    assert "corners-either = [ (a: uint, b: uint) // (c: tstr) ]" in text
    assert "corners-either-choice1" not in text


def test_an_enumeration_group_is_written_back_as_an_enum_group() -> None:
    text = _emit(_import("04-stress-control-operators.cddl"))
    assert "flag-bits = &(" in text
    assert "read: 0," in text


def test_comments_are_written_back_where_they_bind() -> None:
    text = _emit(_import("05-real-world-cose-shaped.cddl"))
    assert text.startswith("; COSE-shaped grammar")
    assert "; kty" in text


def test_comments_can_be_turned_off() -> None:
    text = _emit(_import("05-real-world-cose-shaped.cddl"), include_comments=False)
    assert ";" not in text


def test_no_generated_banner_is_written() -> None:
    """A banner would read back as the grammar's own leading comment on the next import."""
    text = _emit(_import("01-minimal-person.cddl"))
    assert "generated" not in text.lower()


def test_a_repeating_keyed_member_is_not_written_as_a_list_of_lists() -> None:
    """`* tags: tstr` is a member that may repeat, not a member holding a list."""
    source = CddlNormalizer().normalize(parse_cddl("root = {\n  * tags: tstr,\n}\n"))
    text = _emit(source)
    assert "* tags: tstr," in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_member_occurrence_and_an_inline_list_are_both_written() -> None:
    source = CddlNormalizer().normalize(parse_cddl("root = {\n  + items: [* tstr],\n}\n"))
    text = _emit(source)
    assert "+ items: [* tstr]," in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_cut_key_keeps_its_caret() -> None:
    source = CddlNormalizer().normalize(
        parse_cddl('root = { "k" ^ => tstr, * tstr ^ => any }\n')
    )
    text = _emit(source)
    assert '"k" ^ => tstr,' in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_an_enum_member_whose_value_is_not_a_literal_keeps_its_spelling() -> None:
    """`admin: uint` has no canonical value; the name must not be written as one."""
    source = CddlNormalizer().normalize(
        parse_cddl("root = { f: bits }\nbits = &(\n  read: 0,\n  admin: uint,\n)\n")
    )
    text = _emit(source)
    assert "admin: uint," in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_group_written_where_a_type_belongs_becomes_a_map_that_round_trips() -> None:
    """RFC 8610 does not admit `h: Headers`; failing the grammar over it would be worse."""
    source = CddlNormalizer().normalize(
        parse_cddl("root = { h: Headers }\nHeaders = (a: tstr, b: uint)\n")
    )
    text = _emit(source)
    assert "h: Headers-group," in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_socket_with_one_plug_still_binds_with_the_extension_operator() -> None:
    """Writing `$m = tstr` would turn an extension point into a closed rule."""
    source = CddlNormalizer().normalize(parse_cddl("$m /= tstr\nroot = { v: $m }\n"))
    text = _emit(source)
    assert "$m /= tstr" in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_tag_with_no_number_is_still_written_as_a_tag() -> None:
    source = CddlNormalizer().normalize(parse_cddl("root = #6(tstr)\n"))
    text = _emit(source)
    assert "root /= " not in text
    assert "#6(tstr)" in text
    assert canonical_diff(source, _reimport(text)).is_empty


def test_a_shadowed_prelude_name_is_written_as_the_reference_it_is() -> None:
    source = CddlNormalizer().normalize(
        parse_cddl("uri = { href: tstr }\nroot = { link: uri }\n")
    )
    text = _emit(source)
    assert "link: uri," in text
    assert canonical_diff(source, _reimport(text)).is_empty


@pytest.mark.parametrize(
    "grammar",
    [
        "root = { magic: h'0f10' }\n",
        "root = { ratio: 1.5, big: 1e3 }\n",
        "root = { a: 0x1f, b: 0b1010 }\n",
        "root = {}\n",
        "root = [ 2*4 tstr ]\n",
        "root = { v: tstr / uint / nil }\n",
    ],
)
def test_literal_and_occurrence_corners_round_trip(grammar: str) -> None:
    source = CddlNormalizer().normalize(parse_cddl(grammar))
    assert canonical_diff(source, _reimport(_emit(source))).is_empty


# ===========================================================================
# Projected mode — a model that never saw CDDL
# ===========================================================================


def test_a_foreign_model_projects_its_scalars_onto_the_prelude() -> None:
    text = _emit(_types_only_api())
    assert "sku: tstr" in text
    assert "quantity: int" in text


def test_a_foreign_models_lengths_become_size() -> None:
    assert ".size 3" in _emit(_types_only_api())


def test_a_foreign_models_bounds_become_comparison_operators() -> None:
    text = _emit(_types_only_api())
    assert ".ge 1" in text
    assert ".le 99" in text


def test_a_foreign_models_pattern_becomes_regexp() -> None:
    assert '.regexp "[A-Z]{3}"' in _emit(_types_only_api())


def test_a_foreign_models_default_becomes_the_default_operator() -> None:
    assert ".default 1" in _emit(_types_only_api())


def test_a_foreign_models_nullability_and_lists_become_occurrence_indicators() -> None:
    text = _emit(_types_only_api())
    assert "? note: tstr" in text
    assert "tags: [* tstr]" in text


def test_a_foreign_model_emits_a_grammar_that_re_parses() -> None:
    validate_cddl_document(_emit(_types_only_api()))


def test_a_min_length_without_a_maximum_is_declared_a_loss() -> None:
    """CDDL's `.size` bounds a length exactly or within a range; a floor alone is not
    expressible."""
    api = _types_only_api()
    api.types[0].fields[0].constraints = Constraints(min_length=4)
    losses = CddlEmitter().emit(api).losses
    assert any(loss.subject == "constraint-min-length" for loss in losses)


@pytest.mark.parametrize(
    ("constraint", "subject"),
    [
        (Constraints(multiple_of=5), "constraint-multiple-of"),
        (Constraints(unique_items=True), "constraint-unique-items"),
    ],
)
def test_a_constraint_cddl_has_no_operator_for_is_declared(
    constraint: Constraints, subject: str
) -> None:
    api = _types_only_api()
    api.types[0].fields[0].constraints = constraint
    losses = CddlEmitter().emit(api).losses
    assert any(loss.subject == subject for loss in losses)
    assert all(loss.kind is LossKind.NA for loss in losses if loss.subject == subject)


def test_operations_and_channels_are_declared_dropped_not_silently_omitted() -> None:
    api = _types_only_api()
    api.services = [
        Service(
            key="svc",
            name="svc",
            operations=[Operation(key="GET /x", name="x", kind=OperationKind.QUERY)],
        )
    ]
    api.channels = [Channel(key="chan", address="chan")]
    losses = CddlEmitter().emit(api).losses
    assert any(loss.subject == "services-dropped" for loss in losses)


def test_a_scalar_with_no_prelude_analogue_is_approximated_and_declared() -> None:
    api = _types_only_api()
    api.types[0].fields[0].type = TypeRef(name="geo_point", nullable=False)
    result = CddlEmitter().emit(api)
    assert "sku: any" in str(result.files[0].content)
    approximations = [
        loss for loss in result.losses if loss.subject == "scalar-approximated"
    ]
    assert approximations and approximations[0].kind is LossKind.INFERRED


def test_a_union_member_that_resolves_to_nothing_is_declared() -> None:
    api = _types_only_api()
    api.types.append(
        Type(
            key="Choice",
            name="Choice",
            kind=TypeKind.UNION,
            union_members=["Widget", "MissingType"],
        )
    )
    result = CddlEmitter().emit(api)
    assert any(
        loss.subject == "union-member-unresolved" for loss in result.losses
    )


def test_an_empty_union_is_written_as_any_and_declared() -> None:
    api = _types_only_api()
    api.types.append(Type(key="Nothing", name="Nothing", kind=TypeKind.UNION))
    result = CddlEmitter().emit(api)
    assert "Nothing = any" in str(result.files[0].content)
    assert any(loss.subject == "empty-union" for loss in result.losses)


def test_an_enum_projects_onto_an_enumeration_group() -> None:
    api = _types_only_api()
    api.types.append(
        Type(
            key="Status",
            name="Status",
            kind=TypeKind.ENUM,
            enum_values=[
                EnumValue(key="Status.NEW", name="NEW", value=0),
                EnumValue(key="Status.DONE", name="DONE", value=1),
            ],
        )
    )
    text = str(CddlEmitter().emit(api).files[0].content)
    assert "Status = &(" in text
    assert "NEW: 0," in text


def test_a_map_projects_onto_a_table() -> None:
    api = _types_only_api()
    api.types.append(
        Type(
            key="Index",
            name="Index",
            kind=TypeKind.MAP,
            key_type=TypeRef(name="string"),
            value_type=TypeRef(name="i64"),
        )
    )
    text = str(CddlEmitter().emit(api).files[0].content)
    assert "Index = { * tstr => int }" in text


def test_a_name_cddl_cannot_spell_is_folded_into_one_it_can() -> None:
    api = _types_only_api()
    api.types[0].fields[0].name = "not a name!"
    text = str(CddlEmitter().emit(api).files[0].content)
    assert "not a name!" not in text
    validate_cddl_document(text)


def test_an_empty_model_writes_nothing_a_reader_can_parse() -> None:
    """A CDDL file with no rules is not a grammar; there is nothing honest to invent."""
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="json-schema",
        identity=ApiIdentity(name="Empty"),
    )
    with pytest.raises(CddlParseError):
        validate_cddl_document(str(CddlEmitter().emit(api).files[0].content))


def test_provenance_is_recorded_for_every_written_type_and_member() -> None:
    result = CddlEmitter().emit(_import("01-minimal-person.cddl"))
    recorded = {record.pointer for record in result.provenance}
    assert "person" in recorded
    assert "person.name" in recorded
