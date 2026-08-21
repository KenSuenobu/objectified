"""Tests for the WIT identifier and type-expression mapping — FMT-2.6 (#5424).

:mod:`app.wit_type_system` answers the two questions the WIT emitter delegates:
what a canonical construct is *called* in WIT, and how its type is *spelled*. Both
answers have hard grammatical constraints — a WIT identifier is lower-kebab-case and
may not collide with a reserved word, and every generic level (``list``, ``option``,
``borrow``, ``stream``) must nest in the order the importer unwrapped it — so they are
exercised here directly rather than only through emitted documents.

The ledger is tested as a *contract*: its three classes must stay in bijection with
the three capability-limit classes the WIT importer records, and no loss may be
recorded under a subject that has not been classified.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

import pytest

from app.canonical_model import TypeRef
from app.emitter import LossKind, LossTracker
from app.import_preview_manifest import STATUS_FOR_COVERAGE, CoverageClass
from app.projection_taxonomy import ProjectionReason, ProjectionStatus
from app.wit_parser import _ID  # the grammar the emitter must satisfy
from app.wit_type_system import (
    CANONICAL_TO_WIT_APPROXIMATION,
    CANONICAL_TO_WIT_PRIMITIVE,
    LEDGER_OUTCOME,
    LOSS_KIND_FOR_CLASS,
    LOSS_LEDGER_CLASS,
    WIT_IDENTIFIER_RE,
    WIT_KEYWORDS,
    WitLossClass,
    WitNameAllocator,
    WitTypeRenderer,
    is_wit_identifier,
    record_wit_loss,
    referenced_identifiers,
    wit_identifier,
)

# ===========================================================================
# Identifiers
# ===========================================================================


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("greet", "greet"),
        ("GetPet", "get-pet"),
        ("getHTTPResponse", "get-http-response"),
        ("HTTPServer", "http-server"),
        ("UserProfile", "user-profile"),
        ("user_profile", "user-profile"),
        ("user.profile", "user-profile"),
        ("GET /pets/{id}", "get-pets-id"),
        ("example.catalog.v1", "example-catalog-v1"),
        ("all-scalars", "all-scalars"),
        ("2fa", "x-2fa"),
        ("   ", "item"),
        ("", "item"),
        (None, "item"),
    ],
)
def test_wit_identifier_rewrites_source_names_onto_the_grammar(
    source: Optional[str], expected: str
) -> None:
    """Every supported source spelling maps onto its documented WIT identifier."""
    assert wit_identifier(source) == expected


@pytest.mark.parametrize("keyword", sorted(WIT_KEYWORDS))
def test_reserved_words_are_emitted_in_the_explicit_identifier_form(keyword: str) -> None:
    """A name that lands on a keyword keeps its spelling behind a ``%`` escape."""
    assert wit_identifier(keyword) == f"%{keyword}"


def test_identifier_output_always_satisfies_the_parser_grammar() -> None:
    """Whatever comes in, what comes out is a name ``app.wit_parser`` accepts."""
    parser_grammar = re.compile(rf"{_ID}\Z")
    for source in [
        "Pet",
        "3-legged-oauth",
        "%weird%",
        "SCREAMING_SNAKE",
        "dotted.name.parts",
        "trailing---dashes---",
        "résumé",
        "9",
        "record",
        "GET /a/{b}/c",
    ]:
        emitted = wit_identifier(source)
        assert parser_grammar.match(emitted), (source, emitted)
        assert WIT_IDENTIFIER_RE.match(emitted)
        assert is_wit_identifier(emitted)


def test_wit_identifier_is_idempotent() -> None:
    """Re-normalizing an identifier is a no-op, so an alias can be re-derived safely."""
    for source in ["get-pet", "%record", "x-2fa", "all-scalars", "u32"]:
        assert wit_identifier(wit_identifier(source)) == wit_identifier(source)


def test_fallback_is_used_only_when_the_source_has_no_word_characters() -> None:
    """A blank name takes the caller's fallback rather than vanishing."""
    assert wit_identifier("!!!", fallback="field") == "field"
    assert wit_identifier("!!!", fallback="!!!") == "item"
    assert wit_identifier("a", fallback="field") == "a"


# ===========================================================================
# The allocator
# ===========================================================================


def test_allocator_gives_colliding_names_a_counted_suffix() -> None:
    """Two source names that normalize onto one identifier stay distinct."""
    names = WitNameAllocator()
    assert names.allocate("getPet") == "get-pet"
    assert names.allocate("get_pet") == "get-pet-2"
    assert names.allocate("GET-PET") == "get-pet-3"


def test_allocator_suffixes_are_still_legal_identifiers() -> None:
    """A counted suffix may not push the name out of the grammar."""
    names = WitNameAllocator()
    for _ in range(12):
        assert is_wit_identifier(names.allocate("pet"))


def test_allocator_honours_reserved_and_explicitly_reserved_names() -> None:
    """Names reserved up front are never handed out."""
    names = WitNameAllocator(reserved=["pet"])
    assert names.allocate("pet") == "pet-2"
    names.reserve("cart")
    assert names.allocate("cart") == "cart-2"
    assert names.taken() == {"pet", "pet-2", "cart", "cart-2"}


def test_allocator_taken_returns_a_copy() -> None:
    """Mutating the reported set must not corrupt the allocator."""
    names = WitNameAllocator()
    names.allocate("pet")
    snapshot = names.taken()
    snapshot.add("intruder")
    assert names.allocate("intruder") == "intruder"


# ===========================================================================
# The ledger
# ===========================================================================


def test_the_three_loss_classes_mirror_the_importers_three_capability_limits() -> None:
    """Each emit-direction class stands for exactly one importer coverage class.

    The WIT importer records three classes of capability limit (IXH-7.9):
    ``partially-mapped``, ``inferred`` and its declared parser limits. The emitter's
    ledger must be those three read backwards, in the same shared taxonomy — never a
    fourth class and never a private vocabulary.
    """
    assert set(WitLossClass) == {
        WitLossClass.PARTIALLY_MAPPED,
        WitLossClass.INFERRED,
        WitLossClass.UNSUPPORTED,
    }
    assert LEDGER_OUTCOME[WitLossClass.PARTIALLY_MAPPED] == STATUS_FOR_COVERAGE[
        CoverageClass.PARTIALLY_MAPPED
    ]
    assert LEDGER_OUTCOME[WitLossClass.INFERRED] == STATUS_FOR_COVERAGE[
        CoverageClass.INFERRED
    ]
    # The third class inverts its reason on purpose: the importer blames our parser
    # for a WIT construct it declines to read, while the emit direction blames the
    # destination grammar — there is no WIT spelling to write.
    importer_status, _ = STATUS_FOR_COVERAGE[CoverageClass.NOT_PARSED_BY_ADAPTER]
    emit_status, emit_reason = LEDGER_OUTCOME[WitLossClass.UNSUPPORTED]
    assert emit_status is importer_status is ProjectionStatus.DROPPED
    assert emit_reason is ProjectionReason.DESTINATION_UNSUPPORTED


def test_every_class_has_an_outcome_and_a_loss_kind() -> None:
    """No class may be declared without saying what it means on both channels."""
    assert set(LEDGER_OUTCOME) == set(WitLossClass)
    assert set(LOSS_KIND_FOR_CLASS) == set(WitLossClass)
    assert LOSS_KIND_FOR_CLASS[WitLossClass.UNSUPPORTED] is LossKind.NA
    assert LOSS_KIND_FOR_CLASS[WitLossClass.PARTIALLY_MAPPED] is LossKind.INFERRED
    assert LOSS_KIND_FOR_CLASS[WitLossClass.INFERRED] is LossKind.INFERRED


def test_every_declared_subject_is_classified_and_classes_are_all_used() -> None:
    """The subject table is total, and every class earns its place in it."""
    assert all(isinstance(value, WitLossClass) for value in LOSS_LEDGER_CLASS.values())
    assert set(LOSS_LEDGER_CLASS.values()) == set(WitLossClass)


def test_recording_a_loss_uses_its_declared_class() -> None:
    """A recorded loss carries the kind its subject's class declares."""
    losses = LossTracker()
    recorded = record_wit_loss(losses, "event-channel", "no channel vocabulary", "chan")
    assert recorded.kind is LossKind.NA
    assert losses.records() == [recorded]


def test_recording_an_unclassified_subject_is_refused() -> None:
    """A new kind of loss must be classified before it can be reported."""
    with pytest.raises(KeyError):
        record_wit_loss(LossTracker(), "brand-new-subject", "…")


# ===========================================================================
# Scalars
# ===========================================================================


def test_primitive_table_only_maps_onto_real_wit_types() -> None:
    """Every 'exact' mapping must name a type the WIT grammar actually has."""
    allowed = {
        "bool",
        "char",
        "f32",
        "f64",
        "list<u8>",
        "s8",
        "s16",
        "s32",
        "s64",
        "string",
        "u8",
        "u16",
        "u32",
        "u64",
    }
    assert set(CANONICAL_TO_WIT_PRIMITIVE.values()) <= allowed


def test_primitive_table_inverts_the_importers_own_mapping() -> None:
    """Everything the WIT importer reads must be spelled back out again."""
    from app.wit_normalizer import _WIT_PRIMITIVE_TO_CANONICAL

    for wit_name, canonical in _WIT_PRIMITIVE_TO_CANONICAL.items():
        emitted = CANONICAL_TO_WIT_PRIMITIVE[canonical]
        # `float32`/`float64` are aliases the emitter normalizes onto `f32`/`f64`.
        assert emitted in {wit_name, "f32", "f64"}, (wit_name, canonical, emitted)


def test_approximation_table_states_why_each_mapping_is_lossy() -> None:
    """An approximation without a reason would be an unexplained downgrade."""
    for canonical, (expression, reason) in CANONICAL_TO_WIT_APPROXIMATION.items():
        assert expression
        assert reason.strip(), canonical
        assert canonical not in CANONICAL_TO_WIT_PRIMITIVE


# ===========================================================================
# The type renderer
# ===========================================================================


def _renderer(
    named: Optional[Dict[str, str]] = None,
    *,
    losses: Optional[LossTracker] = None,
    linked: Optional[List[str]] = None,
) -> WitTypeRenderer:
    """Build a renderer over a fixed name table."""
    table = named or {}
    return WitTypeRenderer(
        resolve=table.get,
        losses=losses if losses is not None else LossTracker(),
        link=(lambda expression, pointer=None: linked.append(expression))
        if linked is not None
        else None,
    )


@pytest.mark.parametrize(
    ("ref", "expected"),
    [
        (TypeRef(name="string", nullable=False), "string"),
        (TypeRef(name="string"), "option<string>"),
        (TypeRef(name="uint8", nullable=False), "u8"),
        (TypeRef(name="int8", nullable=False), "s8"),
        (TypeRef(name="double", nullable=False), "f64"),
        (TypeRef(name="bytes", nullable=False), "list<u8>"),
        (TypeRef(item=TypeRef(name="string", nullable=False), nullable=False), "list<string>"),
        (
            TypeRef(
                item=TypeRef(item=TypeRef(name="double", nullable=False), nullable=False),
                nullable=False,
            ),
            "list<list<f64>>",
        ),
        (TypeRef(item=TypeRef(name="string", nullable=False)), "option<list<string>>"),
    ],
)
def test_scalar_and_wrapper_levels_render_in_the_importers_order(
    ref: TypeRef, expected: str
) -> None:
    """List nesting and optionality are spelled exactly as the importer unwrapped them."""
    assert _renderer().render(ref) == expected


def test_named_types_are_spelled_with_the_identifier_the_resolver_supplies() -> None:
    """A named reference goes through the caller's scope, not through the raw key."""
    renderer = _renderer({"examples:calc.calculate.op": "op"})
    ref = TypeRef(name="examples:calc.calculate.op", nullable=False)
    assert renderer.render(ref) == "op"


def test_handle_and_async_wrappers_nest_inside_optionality() -> None:
    """``option<borrow<t>>`` — the order the importer's unwrapping implies."""
    renderer = _renderer({"pkg.store.table": "table"})
    borrowed = TypeRef(
        name="pkg.store.table", nullable=False, extras={"wit_handle": "borrow"}
    )
    assert renderer.render(borrowed) == "borrow<table>"
    optional_borrow = borrowed.model_copy(update={"nullable": True})
    assert renderer.render(optional_borrow) == "option<borrow<table>>"
    streamed = TypeRef(name="string", nullable=False, extras={"wit_async": "stream"})
    assert renderer.render(streamed) == "stream<string>"


def test_a_preserved_wit_spelling_is_written_back_verbatim_and_linked() -> None:
    """A construct the canonical model could not hold comes back exactly as it went in."""
    linked: List[str] = []
    renderer = _renderer(linked=linked)
    ref = TypeRef(
        name="tuple", nullable=False, extras={"wit_type": "tuple<u32,   string>"}
    )
    assert renderer.render(ref) == "tuple<u32, string>"
    assert linked == ["tuple<u32, string>"]


def test_a_preserved_spelling_still_takes_its_optionality_wrapper() -> None:
    """``option<tuple<…>>`` keeps both halves of what the importer recorded."""
    ref = TypeRef(name="tuple", extras={"wit_type": "tuple<u32, string>"})
    assert _renderer().render(ref) == "option<tuple<u32, string>>"


def test_an_untyped_reference_is_reported_rather_than_guessed() -> None:
    """A reference with neither a name nor an element type says so."""
    losses = LossTracker()
    assert _renderer(losses=losses).render(TypeRef(nullable=False)) == "string"
    assert [loss.subject for loss in losses.records()] == ["untyped-value"]


def test_a_missing_reference_renders_the_untyped_fallback() -> None:
    """``None`` is the caller saying 'there is no type here'."""
    assert _renderer().render(None) == "string"


def test_an_approximated_scalar_is_reported_once_per_name() -> None:
    """A model with many `date-time` fields reports the approximation once."""
    losses = LossTracker()
    renderer = _renderer(losses=losses)
    for _ in range(4):
        assert renderer.render(TypeRef(name="date-time", nullable=False)) == "string"
    assert [loss.subject for loss in losses.records()] == ["scalar-approximation"]


def test_an_unresolvable_reference_keeps_its_name_and_is_reported_once() -> None:
    """The name stays visible in the artifact; the ledger says it resolves nowhere."""
    losses = LossTracker()
    renderer = _renderer(losses=losses)
    for _ in range(3):
        assert renderer.render(TypeRef(name="MysteryType", nullable=False)) == "mystery-type"
    records = losses.records()
    assert [loss.subject for loss in records] == ["unresolved-type-reference"]
    assert "MysteryType" in records[0].detail


def test_link_normalizes_whitespace_and_reports_the_dependency() -> None:
    """Verbatim text is routed through ``link`` so its ``use`` statements get written."""
    linked: List[str] = []
    renderer = _renderer(linked=linked)
    assert renderer.link("result<row,\n  lookup-error>") == "result<row, lookup-error>"
    assert linked == ["result<row, lookup-error>"]


# ===========================================================================
# The identifier scanner
# ===========================================================================


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("u32", []),
        ("list<u8>", []),
        ("option<row>", ["row"]),
        ("result<row, lookup-error>", ["lookup-error", "row"]),
        ("tuple<string, list<u8>>", []),
        ("borrow<bucket>", ["bucket"]),
        ("result<option<list<u8>>, error>", ["error"]),
        ("stream<key-response>", ["key-response"]),
    ],
)
def test_referenced_identifiers_finds_named_types_and_ignores_the_grammar(
    expression: str, expected: List[str]
) -> None:
    """Only *named* types come back; generic heads and primitives are reserved words."""
    assert referenced_identifiers(expression) == expected
