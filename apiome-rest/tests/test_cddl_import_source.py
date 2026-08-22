"""Unit tests for the CDDL ImportSource — FMT-4.4 (#5437).

Organised around the ticket's four acceptance criteria:

#. a CDDL file imports, and a CDDL file emitted from the same model round-trips;
#. control operators map to canonical constraints where an analogue exists and are declared
   losses where none does;
#. sockets/plugs and generics are modelled or declared parsing limits;
#. the corpus includes a COSE-shaped grammar and a WebAuthn-shaped grammar.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

import pytest

from app.canonical_model import ApiParadigm, TypeKind
from app.cddl_grammar import (
    LIMIT_DETAILS,
    MAX_CDDL_BYTES,
    MAX_CDDL_DEPTH,
    MAX_GENERIC_DEPTH,
    PRELUDE_SCALARS,
    AssignKind,
    CddlParseError,
    LimitRecorder,
    NodeKind,
    RuleKind,
    SocketKind,
    canonical_scalar_to_cddl,
    describe_node,
    is_socket_name,
    socket_kind,
)
from app.cddl_import_source import CDDL_CAPABILITIES, CddlImportSource
from app.cddl_normalizer import CDDL_EXTRAS_KEY, WILDCARD_FIELD_NAME
from app.cddl_parser import is_cddl, parse_cddl, parse_cddl_fileset, tokenize
from app.fileset import IntakeFileset
from app.format_capability_registry import (
    CapabilityProvenance,
    ProjectionCoverage,
    capability_for,
)
from app.format_version_coverage import VersionSupport, version_coverage_for
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
)
from app.import_routing import ImportTarget, decide_import_routing
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "cddl"

#: The smallest grammar that exercises a map, a member and an optional member.
MINIMAL = "person = {\n  name: tstr,\n  ? age: uint,\n}\n"


@pytest.fixture()
def adapter() -> CddlImportSource:
    """The registered CDDL adapter."""
    return get_import_source("cddl")


def _fixture(name: str) -> str:
    """Return a shipped corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _modules_set() -> IntakeFileset:
    """Return the shipped two-file CDDL set as an intake fileset."""
    members: Dict[str, str] = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-modules-set").iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root="api.cddl")


def _model(name: str, adapter: CddlImportSource):
    """Import one shipped corpus fixture end to end."""
    return adapter.normalize(adapter.parse(_fixture(name), source_label=name))


def _type(model, name: str):
    """Return one named type from a canonical model."""
    return next(item for item in model.types if item.name == name)


def _field(model, type_name: str, field_name: str):
    """Return one named field of one named type from a canonical model."""
    return next(
        field for field in _type(model, type_name).fields if field.name == field_name
    )


def _ordered(type_) -> list:
    """Return a type's field names in declaration order.

    ``normalize_ordering`` sorts fields by key, so declaration order — which is load-bearing
    for an array's positional members — lives on ``field_number``, not on the list.
    """
    return [
        field.name
        for field in sorted(type_.fields, key=lambda item: item.field_number or 0)
    ]


def _limits(model) -> Dict[str, int]:
    """Return ``construct -> count`` for the declared limits a model recorded."""
    report = model.extras[CDDL_EXTRAS_KEY]["capability_limits"]
    return {entry["construct"]: entry["count"] for entry in report}


# ===========================================================================
# Registration and detection
# ===========================================================================


def test_adapter_is_registered_as_a_data_schema_reader(adapter: CddlImportSource) -> None:
    assert adapter.key == "cddl"
    assert adapter.paradigm is ApiParadigm.DATA_SCHEMA
    assert adapter.formats == ("cddl",)
    assert ".cddl" in adapter.file_extensions


def test_detect_claims_a_grammar(adapter: CddlImportSource) -> None:
    result = adapter.detect(
        DetectionInput(text=_fixture("02-typical-order.cddl"), filename="order.cddl")
    )
    assert result.matched
    assert result.format == "cddl"
    assert result.confidence >= 0.85


def test_detect_wins_the_registry_race_for_every_valid_fixture() -> None:
    for name in sorted(path.name for path in CORPUS.glob("*.cddl")):
        decision = detect_import_source(DetectionInput(text=_fixture(name), filename=name))
        assert decision is not None, name
        source, result = decision
        assert source.key == "cddl", name
        assert result.format == "cddl", name


def test_detection_needs_more_than_an_assignment() -> None:
    """A rule assignment alone is shared with a dozen configuration languages."""
    assert not is_cddl("name = value\nother = thing\n")
    assert is_cddl("name = { field: tstr }\n")


def test_detection_refuses_a_json_document() -> None:
    assert not is_cddl(_fixture("negative/04-wrong-format-json-schema.json"))


def test_detection_refuses_empty_and_binary_input() -> None:
    assert not is_cddl("")
    assert not is_cddl("person = {\x00 name: tstr }")


def test_routing_sends_a_grammar_to_the_catalog(adapter: CddlImportSource) -> None:
    routing = decide_import_routing(adapter, adapter.normalize(adapter.parse(MINIMAL)))
    assert routing.target is ImportTarget.CATALOG
    assert routing.schemas_only is True


# ===========================================================================
# The tokenizer's two lexical decisions
# ===========================================================================


def test_a_dot_continues_an_identifier_only_between_identifier_characters() -> None:
    """`float16-32` is one name; `tstr .size` is a name and a control operator."""
    tokens, _ = tokenize("a = float16-32\nb = tstr .size 4\n")
    values = [token.value for token in tokens]
    assert "float16-32" in values
    assert ".size" in values
    assert "tstr" in values


def test_a_tag_lexes_as_one_token_not_as_a_float() -> None:
    document = parse_cddl("stamped = #6.1(number)\n")
    node = document.rules[0].node
    assert node.kind is NodeKind.TAG
    assert node.tag == 1


def test_a_hash_without_digits_is_the_any_type() -> None:
    document = parse_cddl("anything = #\n")
    assert document.rules[0].node.kind is NodeKind.ANY


def test_byte_string_literals_carry_their_qualifier_and_value() -> None:
    document = parse_cddl("magic = h'0f10'\n")
    literal = document.rules[0].node.literal
    assert literal.value == b"\x0f\x10"
    assert literal.spelling == "h'0f10'"


def test_a_parenthesised_type_is_not_a_group_rule() -> None:
    """`( a / b )` parenthesizes a type; `( a: x, b: y )` declares a group."""
    assert parse_cddl("choice = (tstr / uint)\n").rules[0].kind is RuleKind.TYPE
    assert parse_cddl("pair = (a: tstr, b: uint)\n").rules[0].kind is RuleKind.GROUP


# ===========================================================================
# AC 1 — a CDDL file imports
# ===========================================================================


def test_minimal_grammar_imports_as_one_record(adapter: CddlImportSource) -> None:
    model = adapter.normalize(adapter.parse(MINIMAL))
    person = _type(model, "person")
    assert person.kind is TypeKind.RECORD
    assert _ordered(person) == ["name", "age"]
    assert _field(model, "person", "age").type.nullable is True
    assert _field(model, "person", "name").type.nullable is False


def test_every_valid_corpus_fixture_imports(adapter: CddlImportSource) -> None:
    for name in sorted(path.name for path in CORPUS.glob("*.cddl")):
        model = adapter.normalize(adapter.parse(_fixture(name), source_label=name))
        assert model.types, name
        assert model.format == "cddl", name
        assert model.paradigm is ApiParadigm.DATA_SCHEMA, name


def test_occurrence_indicators_become_nullability_and_lists(
    adapter: CddlImportSource,
) -> None:
    model = _model("02-typical-order.cddl", adapter)
    lines = _field(model, "order", "lines")
    assert lines.type.is_list()
    assert lines.type.item.name == "line"
    assert lines.constraints.min_items == 1
    assert _field(model, "order", "note").type.nullable is True


def test_a_rule_reference_is_a_reference_not_a_copy(adapter: CddlImportSource) -> None:
    model = _model("02-typical-order.cddl", adapter)
    assert _field(model, "order", "customer").type.name == "customer"
    assert _type(model, "customer").kind is TypeKind.RECORD


def test_a_literal_type_choice_becomes_an_enum_constraint(
    adapter: CddlImportSource,
) -> None:
    model = _model("02-typical-order.cddl", adapter)
    status = _type(model, "status")
    assert status.kind is TypeKind.SCALAR
    assert status.constraints.enum == ["new", "paid", "shipped", "cancelled"]


def test_a_reference_choice_becomes_a_union(adapter: CddlImportSource) -> None:
    model = _model("06-real-world-webauthn-shaped.cddl", adapter)
    statement = _type(model, "attestation-statement")
    assert statement.kind is TypeKind.UNION
    assert statement.union_members == [
        "packed-stmt",
        "u2f-stmt",
        "apple-stmt",
        "none-stmt",
    ]


def test_a_pure_table_becomes_a_canonical_map(adapter: CddlImportSource) -> None:
    document = parse_cddl("payload = { * tstr => any }\n")
    model = adapter.normalize(document)
    payload = _type(model, "payload")
    assert payload.kind is TypeKind.MAP
    assert payload.key_type.name == "string"
    assert payload.value_type.name == "any"


def test_an_array_of_one_repeated_element_is_a_list_alias(
    adapter: CddlImportSource,
) -> None:
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    keyset = _type(model, "COSE_KeySet")
    assert keyset.kind is TypeKind.ALIAS
    assert keyset.aliased.is_list()
    assert keyset.aliased.item.name == "COSE_Key"


def test_an_array_with_named_entries_is_an_ordered_record(
    adapter: CddlImportSource,
) -> None:
    model = _model("06-real-world-webauthn-shaped.cddl", adapter)
    layout = _type(model, "authenticator-data-layout")
    assert layout.kind is TypeKind.RECORD
    assert layout.extras["cddl_shape"] == "array"
    assert _ordered(layout) == [
        "rpIdHash",
        "flags",
        "signCount",
        "attestedCredentialData",
        "extensions",
    ]


def test_a_group_rule_produces_no_type_and_is_spliced(adapter: CddlImportSource) -> None:
    """`Headers` exists to be spliced; its members land in every array that names it."""
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    assert not [item for item in model.types if item.name == "Headers"]
    sign = _type(model, "COSE_Sign")
    assert _ordered(sign)[:2] == ["protected", "unprotected"]
    assert "Headers" in model.extras[CDDL_EXTRAS_KEY]["group_rules"]


def test_an_enumeration_group_becomes_a_canonical_enum(adapter: CddlImportSource) -> None:
    model = _model("06-real-world-webauthn-shaped.cddl", adapter)
    flags = _type(model, "authenticator-flags")
    assert flags.kind is TypeKind.ENUM
    assert [(value.name, value.value) for value in flags.enum_values][:2] == [
        ("user-present", 0),
        ("user-verified", 2),
    ]


def test_comments_become_descriptions_where_they_bind(adapter: CddlImportSource) -> None:
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    assert model.description and model.description.startswith("COSE-shaped grammar")
    assert _field(model, "COSE_Key", "1").description == "kty"


def test_a_group_choice_that_is_a_whole_body_is_a_union_of_records(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    either = _type(model, "corners-either")
    assert either.kind is TypeKind.UNION
    assert len(either.union_members) == 2
    first = _type(model, either.union_members[0])
    assert [field.name for field in first.fields] == ["a", "b"]


# ===========================================================================
# AC 2 — control operators: constraints where an analogue exists
# ===========================================================================


def test_size_on_a_text_string_becomes_lengths(adapter: CddlImportSource) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    field = _field(model, "corners", "short-text")
    assert field.constraints.min_length == 1
    assert field.constraints.max_length == 40


def test_size_on_an_integer_becomes_the_value_range_those_bytes_admit(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    field = _field(model, "corners", "small-int")
    assert field.constraints.minimum == 0
    assert field.constraints.maximum == 65535


def test_regexp_becomes_a_pattern(adapter: CddlImportSource) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    assert _field(model, "corners", "sku").constraints.pattern == "[A-Z]{3}-[0-9]{4}"


def test_rfc9165_comparisons_become_numeric_bounds(adapter: CddlImportSource) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    assert _field(model, "corners", "positive").constraints.exclusive_minimum == 0
    assert _field(model, "corners", "capped").constraints.maximum == 1000


def test_default_becomes_the_member_default(adapter: CddlImportSource) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    assert _field(model, "corners", "retries").default == 3


def test_and_merges_both_operands_constraints(adapter: CddlImportSource) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    field = _field(model, "corners", "intersected")
    assert field.constraints.minimum == 1
    assert field.constraints.maximum == 100


def test_ranges_become_bounds_and_the_exclusive_form_is_exclusive(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    inclusive = _field(model, "corners", "percent").constraints
    exclusive = _field(model, "corners", "exclusive").constraints
    assert (inclusive.minimum, inclusive.maximum) == (0, 100)
    assert exclusive.maximum is None
    assert exclusive.exclusive_maximum == 100


def test_eq_becomes_a_single_valued_enum(adapter: CddlImportSource) -> None:
    model = adapter.normalize(parse_cddl('answer = tstr .eq "yes"\n'))
    assert _type(model, "answer").constraints.enum == ["yes"]


# ===========================================================================
# AC 2 — control operators: declared losses where no analogue exists
# ===========================================================================


@pytest.mark.parametrize(
    ("member", "construct"),
    [
        ("embedded", "cddl.control_cbor"),
        ("sequence", "cddl.control_cbor"),
        ("narrowed", "cddl.control_within"),
        ("flags", "cddl.control_bits"),
        ("not-zero", "cddl.control_unmapped"),
    ],
)
def test_a_control_without_an_analogue_is_declared_not_dropped(
    adapter: CddlImportSource, member: str, construct: str
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    assert construct in _limits(model)
    recorded = _field(model, "corners", member).extras["cddl_controls"]
    assert recorded and recorded[0]["operand"]


def test_a_declared_control_keeps_its_targets_type(adapter: CddlImportSource) -> None:
    """`.cbor` describes a nesting; the member is still the byte string it declared."""
    model = _model("04-stress-control-operators.cddl", adapter)
    assert _field(model, "corners", "embedded").type.name == "bytes"


def test_an_unmergeable_and_is_declared_as_an_intersection_limit(
    adapter: CddlImportSource,
) -> None:
    model = adapter.normalize(parse_cddl("narrow = uint .and any\n"))
    assert "cddl.control_intersection" in _limits(model)


def test_a_tag_is_recorded_and_declared(adapter: CddlImportSource) -> None:
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    tagged = _type(model, "COSE_Sign_Tagged")
    assert tagged.extras["cddl_tag"] == 98
    assert tagged.aliased.name == "COSE_Sign"
    assert "cddl.tag" in _limits(model)


def test_a_major_type_shorthand_uses_the_nearest_scalar_and_is_declared(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    field = _field(model, "corners", "raw-major-two")
    assert field.type.name == "bytes"
    assert field.extras["cddl_type"] == "#2"
    assert "cddl.major_type" in _limits(model)


def test_an_unwrap_types_the_member_by_the_rule_it_unwraps(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    field = _field(model, "corners", "unwrapped")
    assert field.type.name == "wrapper"
    assert field.extras["cddl_unwrap"] == "wrapper"
    assert "cddl.unwrap" in _limits(model)


def test_a_table_beside_named_members_is_one_open_content_member(
    adapter: CddlImportSource,
) -> None:
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    wildcard = _field(model, "COSE_Key", WILDCARD_FIELD_NAME)
    assert wildcard.extras["cddl_key"] == "table"
    assert wildcard.extras["cddl_key_type"] == "label"
    assert "cddl.open_map_entry" in _limits(model)


def test_a_table_entrys_occurrence_counts_entries_not_values(
    adapter: CddlImportSource,
) -> None:
    """`* label => values` admits many entries each holding one value, not a list."""
    model = _model("05-real-world-cose-shaped.cddl", adapter)
    wildcard = _field(model, "COSE_Key", WILDCARD_FIELD_NAME)
    assert not wildcard.type.is_list()
    assert wildcard.type.name == "values"


# ===========================================================================
# AC 3 — sockets, plugs and generics are modelled or declared
# ===========================================================================


def test_a_type_socket_is_resolved_to_a_union_of_its_plugs(
    adapter: CddlImportSource,
) -> None:
    model = _model("03-composition-sockets-and-generics.cddl", adapter)
    socket = _type(model, "$message")
    assert socket.kind is TypeKind.UNION
    assert socket.union_members == ["ping-message", "pong-message"]
    assert socket.extras["cddl_socket"] == "type"
    assert "cddl.type_socket" in _limits(model)
    assert model.extras[CDDL_EXTRAS_KEY]["sockets"]["$message"] == [
        "ping-message",
        "pong-message",
    ]


def test_a_group_socket_splices_its_first_alternative_and_declares_the_rest(
    adapter: CddlImportSource,
) -> None:
    model = _model("03-composition-sockets-and-generics.cddl", adapter)
    envelope = _type(model, "envelope")
    assert _ordered(envelope) == ["version", "sent-at", "payload"]
    limits = _limits(model)
    assert "cddl.group_socket" in limits
    assert "cddl.group_choice" in limits


def test_a_generic_is_instantiated_once_per_distinct_argument_list(
    adapter: CddlImportSource,
) -> None:
    model = _model("03-composition-sockets-and-generics.cddl", adapter)
    names = {item.name for item in model.types}
    assert {"page_message", "page_tstr"} <= names
    assert "page" not in names
    assert _type(model, "page_message").fields[0].type.item.name == "$message"
    assert _type(model, "page_tstr").fields[0].type.item.name == "string"
    assert "cddl.generic_rule" in _limits(model)
    instantiations = model.extras[CDDL_EXTRAS_KEY]["instantiations"]
    assert instantiations["page_message"] == {"rule": "page", "arguments": ["$message"]}


def test_an_instantiation_used_twice_produces_one_type(adapter: CddlImportSource) -> None:
    document = parse_cddl(
        "root = { a: box<tstr>, b: box<tstr> }\nbox<T> = { value: T }\n"
    )
    model = adapter.normalize(document)
    assert len([item for item in model.types if item.name.startswith("box")]) == 1


def test_a_generic_with_the_wrong_arity_is_refused() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl("root = box<tstr, uint>\nbox<T> = { value: T }\n")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_generic_arguments_on_a_non_generic_rule_are_refused() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl("root = plain<tstr>\nplain = tstr\n")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_a_self_instantiating_generic_is_bounded_rather_than_running() -> None:
    """Each level's argument is larger than the last, so re-entry is never identical."""
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl("root = tree<tstr>\ntree<T> = { child: tree<[T]> }\n")
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert str(MAX_GENERIC_DEPTH) in str(excinfo.value)


def test_two_arguments_that_fold_to_one_identifier_get_two_rules() -> None:
    """`box<tstr>` and `box<[tstr]>` are different types and must not share a rule."""
    document = parse_cddl("root = { a: box<tstr>, b: box<[tstr]> }\nbox<T> = { value: T }\n")
    instantiated = [rule.name for rule in document.rules if rule.name.startswith("box")]
    assert len(instantiated) == 2
    assert len(set(instantiated)) == 2


def test_socket_helpers_name_the_two_kinds() -> None:
    assert socket_kind("$message") is SocketKind.TYPE
    assert socket_kind("$$members") is SocketKind.GROUP
    assert socket_kind("plain") is None
    assert is_socket_name("$message") and not is_socket_name("plain")


# ===========================================================================
# Composition across a fileset
# ===========================================================================


def test_a_fileset_composes_into_one_namespace(adapter: CddlImportSource) -> None:
    model = adapter.normalize(adapter.parse_fileset(_modules_set()))
    names = {item.name for item in model.types}
    assert {"request", "response", "uuid", "timestamp"} <= names
    assert _field(model, "request", "id").type.name == "uuid"
    assert model.extras[CDDL_EXTRAS_KEY]["members"] == ["api.cddl", "common.cddl"]


def test_the_fileset_root_supplies_the_entry_point(adapter: CddlImportSource) -> None:
    model = adapter.normalize(adapter.parse_fileset(_modules_set()))
    assert model.extras[CDDL_EXTRAS_KEY]["root_rule"] == "request"


def test_a_fileset_without_its_root_is_refused(adapter: CddlImportSource) -> None:
    fileset = IntakeFileset(root="api.cddl", members={"common.cddl": "x = tstr\n"})
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(fileset)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_reference_that_resolves_in_no_member_names_the_missing_rule() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl_fileset(
            {"a.cddl": "root = { total: money }\n", "b.cddl": "other = tstr\n"},
            root="a.cddl",
        )
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "money" in str(excinfo.value)


# ===========================================================================
# Negatives — every failure classifies itself, or leaves it to the pipeline
# ===========================================================================


def test_an_unclosed_map_is_a_plain_syntax_error() -> None:
    """No taxonomy code: the pipeline classifies an uncoded parse failure itself."""
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(_fixture("negative/01-syntactic-unclosed-map.cddl"))
    assert excinfo.value.code is None


def test_a_rule_bound_twice_is_semantically_invalid() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(_fixture("negative/02-semantic-duplicate-rule.cddl"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_file_cut_mid_member_is_a_truncation() -> None:
    """The distinction from an unclosed bracket is a parser state, not a heuristic."""
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(_fixture("negative/03-truncated-mid-rule.cddl"))
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_an_unterminated_literal_is_a_truncation() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl('root = { name: "unterminated\n')
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_an_undefined_rule_reference_is_unresolved() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(_fixture("negative/06-unresolvable-type-reference.cddl"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_a_grammar_with_no_rules_is_semantically_invalid() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl("; only a comment\n")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_deep_nesting_is_refused_rather_than_recursing() -> None:
    """An uncaught ``RecursionError`` would surface as a 5xx, not as a rejection."""
    payload = "root = " + "[" * (MAX_CDDL_DEPTH + 8) + "tstr" + "]" * (MAX_CDDL_DEPTH + 8)
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(payload + "\n")
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_an_oversized_document_is_refused_before_it_is_scanned() -> None:
    payload = "; " + ("x" * (MAX_CDDL_BYTES + 16)) + "\nroot = tstr\n"
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl(payload)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_an_unknown_character_is_a_plain_syntax_error() -> None:
    with pytest.raises(CddlParseError) as excinfo:
        parse_cddl("root = tstr\nbad = \\\n")
    assert excinfo.value.code is None


def test_the_adapter_translates_parse_failures_to_import_source_errors(
    adapter: CddlImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/02-semantic-duplicate-rule.cddl"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_normalize_refuses_something_that_is_not_a_parsed_grammar(
    adapter: CddlImportSource,
) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"not": "a document"})


# ===========================================================================
# Declared limits are one vocabulary in several places
# ===========================================================================


def test_declared_limits_are_one_vocabulary() -> None:
    assert set(CDDL_CAPABILITIES.unsupported) == set(LIMIT_DETAILS)


def test_the_capability_seed_publishes_the_same_constructs() -> None:
    entry = capability_for("cddl")
    assert entry.provenance is CapabilityProvenance.REVIEWED
    assert entry.canonical_projection.coverage is ProjectionCoverage.PARTIAL
    assert set(entry.canonical_projection.dropped_constructs) == set(LIMIT_DETAILS)


def test_the_limit_recorder_refuses_a_construct_outside_the_vocabulary() -> None:
    recorder = LimitRecorder()
    with pytest.raises(KeyError):
        recorder.record("cddl.invented")


def test_the_limit_recorder_counts_and_locates() -> None:
    recorder = LimitRecorder()
    recorder.record("cddl.tag", location="a")
    recorder.record("cddl.tag", location="b")
    (limit,) = recorder.limits()
    assert limit.count == 2
    assert limit.locations == ("a", "b")
    assert limit.detail == LIMIT_DETAILS["cddl.tag"]


def test_declared_limits_render_as_partially_mapped_ledger_rows(
    adapter: CddlImportSource,
) -> None:
    model = _model("04-stress-control-operators.cddl", adapter)
    manifest = build_import_preview_manifest(model, adapter_key="cddl")
    rows = {
        row.source_construct: row
        for row in manifest.document_coverage
        if row.source_construct.startswith("cddl.")
    }
    assert rows, "the stress grammar declares limits and must render ledger rows"
    for row in rows.values():
        assert row.coverage is CoverageClass.PARTIALLY_MAPPED
        assert row.document_scoped is True
        assert "occurrence(s)" in row.detail


def test_the_projection_record_is_provenance_not_an_unmodeled_construct() -> None:
    assert CDDL_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS


# ===========================================================================
# Version coverage, prelude and determinism
# ===========================================================================


def test_version_coverage_declares_one_ungated_read_and_write() -> None:
    coverage = version_coverage_for("cddl")
    assert [entry.support for entry in coverage.reads] == [VersionSupport.UNGATED]
    assert [entry.support for entry in coverage.writes] == [VersionSupport.UNGATED]
    assert coverage.default_write == coverage.writes[0].version


def test_the_prelude_projects_onto_canonical_scalars() -> None:
    assert PRELUDE_SCALARS["tstr"] == "string"
    assert PRELUDE_SCALARS["bstr"] == "bytes"
    assert PRELUDE_SCALARS["uint"] == "uint64"
    assert PRELUDE_SCALARS["nil"] == "null"


def test_the_prelude_is_shadowed_by_a_rule_that_declares_the_name(
    adapter: CddlImportSource,
) -> None:
    """The prelude is a default, not a set of reserved words."""
    model = adapter.normalize(parse_cddl("uri = { href: tstr }\nroot = { link: uri }\n"))
    assert _type(model, "uri").kind is TypeKind.RECORD
    assert _field(model, "root", "link").type.name == "uri"


def test_the_canonical_to_cddl_table_round_trips_the_prelude() -> None:
    for prelude in ("tstr", "bstr", "uint", "int", "bool", "nil", "any"):
        scalar = PRELUDE_SCALARS[prelude]
        assert canonical_scalar_to_cddl(scalar) == prelude
    assert canonical_scalar_to_cddl(None) is None
    assert canonical_scalar_to_cddl("no-such-scalar") is None


def test_describe_node_is_stable_and_single_line() -> None:
    document = parse_cddl("root = uint .size 2\n")
    described = describe_node(document.rules[0].node)
    assert "\n" not in described
    assert ".size" in described


def test_importing_the_same_grammar_twice_is_a_no_op(adapter: CddlImportSource) -> None:
    first = _model("05-real-world-cose-shaped.cddl", adapter)
    second = _model("05-real-world-cose-shaped.cddl", adapter)
    assert canonical_fingerprint(first) == canonical_fingerprint(second)


def test_the_socket_plug_list_is_derived_from_bodies_not_positions() -> None:
    """Re-reading a grammar this repository wrote must record the same plug list."""
    document = parse_cddl("$m /= a\n$m /= b\na = tstr\nb = uint\n")
    assert document.sockets["$m"] == ("a", "b")


def test_a_plug_may_bind_a_socket_the_document_never_declares_with_equals() -> None:
    document = parse_cddl("$m /= a\na = tstr\nroot = { m: $m }\n")
    assert document.rule("$m") is not None
    assert document.rule("$m").assign is AssignKind.DEFINE
