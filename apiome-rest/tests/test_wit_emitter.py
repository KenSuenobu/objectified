"""Tests for the WIT (WebAssembly Component Model) emitter — FMT-2.6 (#5424).

Exercises the ticket's acceptance criteria:

* **Emitted packages parse with the vendored WIT parser used by the importer** —
  every corpus source format the engine can import is emitted to WIT and fed back to
  :func:`app.wit_parser.parse_wit`, the same parser the ``wit`` import adapter uses.
* **Round-trip preserves interfaces, function signatures and named types** — every
  valid ``wit`` corpus fixture is imported, emitted and re-imported, and the two
  canonical models are asserted identical construct for construct.
* **Loss classes are symmetric with the importer's three documented capability
  limits** — every loss the emitter can record is asserted to carry one of the three
  declared classes, and the constructs the ticket names (open-ended maps, arbitrary
  unions, numeric constraints) are asserted to report the class that fits them.
* **Corpus** — the three committed fixtures (a types-only package, an interface with
  functions, and a world with exports) are asserted to be exactly what the emitter
  writes today, so output that changes without the corpus being regenerated fails.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import pytest
from corpus_loader import CorpusEntry, load_corpus

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.diff import diff
from app.emitter import (
    EmitOptions,
    EmitOptionsError,
    LossKind,
    Provenance,
    coerce_emit_options,
    get_emitter,
    load_builtin_emitters,
)
from app.fidelity_rulepack import CapabilityRulePack
from app.lossiness import LossinessKind
from app.wit_emitter import (
    DEFAULT_TYPES_INTERFACE,
    OUTPUT_MEDIA_TYPE,
    WIT_FORMAT_KEY,
    WitEmitOptions,
    WitEmitter,
    WitFidelityRulePack,
    validate_wit_document,
)
from app.wit_import_source import WitImportSource
from app.wit_parser import parse_wit
from app.wit_type_system import LOSS_LEDGER_CLASS, WitLossClass

EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples"
WIT_EXAMPLES = EXAMPLES / "wit"


# ===========================================================================
# Helpers
# ===========================================================================


def emit(api: CanonicalApi, **options: object) -> str:
    """Emit ``api`` and return the WIT document text."""
    return WitEmitter().emit(api, opts=WitEmitOptions(**options)).files[0].content


def subjects(api: CanonicalApi, **options: object) -> List[str]:
    """Return the loss subjects one emit records, in report order."""
    result = WitEmitter().emit(api, opts=WitEmitOptions(**options))
    return [loss.subject for loss in result.losses]


def model(
    *,
    services: Optional[List[Service]] = None,
    types: Optional[List[Type]] = None,
    paradigm: ApiParadigm = ApiParadigm.RPC,
    format: str = "proto3",
    identity: Optional[ApiIdentity] = None,
    **kwargs: object,
) -> CanonicalApi:
    """Build a small model with sensible identity defaults."""
    return CanonicalApi(
        paradigm=paradigm,
        format=format,
        identity=identity or ApiIdentity(name="Pet Store", namespace="acme.pets"),
        services=services or [],
        types=types or [],
        **kwargs,
    )


def operation(name: str, **kwargs: object) -> Operation:
    """Build a request/response operation under the ``svc`` service key."""
    return Operation(
        key=f"svc.{name}", name=name, kind=OperationKind.REQUEST_RESPONSE, **kwargs
    )


def service(*operations: Operation, name: str = "Pets") -> Service:
    """Build a service holding ``operations``."""
    return Service(key="svc", name=name, operations=list(operations))


def wit_corpus_entries() -> List[CorpusEntry]:
    """Return the valid, single-file ``wit`` corpus entries."""
    return [
        entry
        for entry in load_corpus(format="wit", validity_class="valid")
        if entry.fileset_role is None
    ]


def import_wit(text: str, label: str = "fixture.wit") -> CanonicalApi:
    """Import WIT text through the production adapter."""
    source = WitImportSource()
    return source.normalize(source.parse(text, source_label=label), include_raw=False)


# ===========================================================================
# Registration
# ===========================================================================


def test_the_emitter_is_registered_under_the_import_adapters_format_key() -> None:
    """Sharing the ``wit`` key is what joins emit and re-import without an alias."""
    load_builtin_emitters()
    assert get_emitter(WIT_FORMAT_KEY) is WitEmitter
    assert WitEmitter.key == WitEmitter.format == "wit"


def test_the_descriptor_describes_a_single_file_rpc_target_with_no_toolchain() -> None:
    """The card the UI/CLI render must match what the emitter actually does."""
    descriptor = WitEmitter.descriptor()
    assert descriptor.paradigm is ApiParadigm.RPC
    assert descriptor.multi_file is False
    assert descriptor.needs_toolchain is False
    assert descriptor.available is True
    assert descriptor.icon == "component"


def test_the_capability_profile_states_what_wit_actually_carries() -> None:
    """WIT has variants and optionality; it has no events, numbers or facets."""
    profile = WitEmitter.capability_profile()
    assert profile.operations is True
    assert profile.unions is True
    assert profile.nullability is True
    assert profile.events is False
    assert profile.constraints is False
    assert profile.field_identity is False


# ===========================================================================
# Options
# ===========================================================================


def test_a_package_override_must_be_a_legal_wit_package_name() -> None:
    """``ns:name`` is the grammar; anything else is refused up front."""
    assert WitEmitOptions(package="wasi:keyvalue").package == "wasi:keyvalue"
    assert WitEmitOptions(package="   ").package is None
    for bad in ["keyvalue", "WASI:keyvalue", "wasi:key_value", "wasi:keyvalue:extra"]:
        with pytest.raises(ValueError):
            WitEmitOptions(package=bad)


def test_world_and_types_interface_names_are_normalized_onto_the_grammar() -> None:
    """A caller may say ``My World``; the document must say ``my-world``."""
    options = WitEmitOptions(world="My World", types_interface="Shared Types")
    assert options.world == "my-world"
    assert options.types_interface == "shared-types"


def test_blank_names_fall_back_rather_than_producing_an_illegal_document() -> None:
    """A blank world means 'derive one'; a blank interface name takes the default."""
    options = WitEmitOptions(world="   ", types_interface="   ")
    assert options.world is None
    assert options.types_interface == DEFAULT_TYPES_INTERFACE


def test_unknown_options_are_rejected_with_an_emit_options_error() -> None:
    """A typo in an option name fails loudly rather than being ignored."""
    with pytest.raises(EmitOptionsError):
        coerce_emit_options(WitEmitter, {"nope": 1})
    with pytest.raises(EmitOptionsError):
        coerce_emit_options(WitEmitter, {"package": "NOT A PACKAGE"})


def test_the_base_options_envelope_is_accepted_and_defaulted() -> None:
    """A caller passing the generic envelope gets this target's defaults."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert WitEmitter().emit(api, opts=EmitOptions()).files[0].content == (
        WitEmitter().emit(api).files[0].content
    )


# ===========================================================================
# Acceptance: emitted packages parse with the importer's parser
# ===========================================================================


@pytest.mark.parametrize("entry", wit_corpus_entries(), ids=lambda e: e.path)
def test_every_wit_corpus_fixture_re_emits_as_parseable_wit(entry: CorpusEntry) -> None:
    """The emitter's output is a document the ``wit`` adapter accepts back."""
    document = emit(import_wit(entry.read_text(), entry.path))
    parsed = parse_wit(document, source_label=entry.path)
    assert parsed.interfaces or parsed.worlds


def test_a_model_from_every_paradigm_emits_parseable_wit() -> None:
    """REST, event, graph and data-schema models all produce a package that parses."""
    models = {
        "rest": model(
            format="openapi-3.1",
            paradigm=ApiParadigm.REST,
            services=[
                service(
                    operation(
                        "listPets",
                        http_method="GET",
                        http_path="/pets",
                        messages=[
                            Message(
                                key="svc.listPets#response.200",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                payload=TypeRef(name="Pet"),
                            )
                        ],
                    )
                )
            ],
            types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
        ),
        "event": model(
            format="asyncapi-3",
            paradigm=ApiParadigm.EVENT,
            services=[
                Service(
                    key="svc",
                    name="Signups",
                    operations=[
                        Operation(key="svc.emit", name="emit", kind=OperationKind.PUBLISH)
                    ],
                )
            ],
            channels=[Channel(key="user/signedup", address="user/signedup")],
            types=[Type(key="Signup", name="Signup", kind=TypeKind.RECORD)],
        ),
        "schema": model(
            format="avro",
            paradigm=ApiParadigm.DATA_SCHEMA,
            types=[Type(key="Row", name="Row", kind=TypeKind.RECORD)],
        ),
    }
    for label, api in models.items():
        document = emit(api)
        assert parse_wit(document, source_label=f"{label}.wit") is not None


# ===========================================================================
# Acceptance: round-trip preserves interfaces, signatures and named types
# ===========================================================================


@pytest.mark.parametrize("entry", wit_corpus_entries(), ids=lambda e: e.path)
def test_round_trip_through_the_importer_preserves_the_canonical_model(
    entry: CorpusEntry,
) -> None:
    """Import → emit → re-import must land on the same model, construct for construct.

    ``emit_world`` is off because it is the only option that *adds* a construct: a
    package whose source declared no world gets one synthesized, which is reported as
    a loss and asserted separately.
    """
    before = import_wit(entry.read_text(), entry.path)
    after = import_wit(emit(before, emit_world=False), entry.path)
    model_diff = diff(before, after)
    assert model_diff.changes == [], model_diff.changes


@pytest.mark.parametrize("entry", wit_corpus_entries(), ids=lambda e: e.path)
def test_round_trip_preserves_every_interface_function_and_named_type(
    entry: CorpusEntry,
) -> None:
    """The named surfaces themselves — not merely the diff — survive the trip."""
    before = import_wit(entry.read_text(), entry.path)
    after = import_wit(emit(before, emit_world=False), entry.path)
    assert [s.key for s in after.services] == [s.key for s in before.services]
    assert [t.key for t in after.types] == [t.key for t in before.types]
    assert [(op.key, [m.key for m in op.messages]) for op in after.operations()] == [
        (op.key, [m.key for m in op.messages]) for op in before.operations()
    ]


def test_a_worldless_package_gains_exactly_one_synthesized_world_by_default() -> None:
    """The only construct the defaults add is a world, and it is reported as added."""
    before = import_wit((WIT_EXAMPLES / "08-emitted-interface-functions.wit").read_text())
    assert not [s for s in before.services if s.extras.get("wit_kind") == "world"]
    after = import_wit(emit(before))
    added = [s for s in after.services if s.extras.get("wit_kind") == "world"]
    assert len(added) == 1
    assert added[0].extras["wit_exports"] == ["product-service"]
    assert "synthesized-world" in subjects(before)
    assert "synthesized-world" not in subjects(before, emit_world=False)


def test_a_world_inline_interface_is_written_back_inside_its_world() -> None:
    """``world.iface`` is not a legal package-level name, so it must be re-inlined."""
    entry = next(e for e in wit_corpus_entries() if "composition" in e.path)
    document = emit(import_wit(entry.read_text(), entry.path))
    assert "export health: interface {" in document
    assert "interface notifier.health" not in document


def test_a_resource_is_written_back_from_the_extras_the_importer_parked() -> None:
    """Resource-scoped methods have no canonical home; the extras are the source."""
    entry = next(e for e in wit_corpus_entries() if "stress-type-system" in e.path)
    document = emit(import_wit(entry.read_text(), entry.path))
    assert "resource table {" in document
    assert "constructor(name: string);" in document
    assert "merge: static func(a: borrow<table>, b: borrow<table>) -> table;" in document


# ===========================================================================
# Acceptance: the committed corpus fixtures
# ===========================================================================


@pytest.mark.parametrize(
    ("fixture", "source", "options"),
    [
        ("07-emitted-types-only.wit", "avro/02-order-record.avsc", {}),
        (
            "08-emitted-interface-functions.wit",
            "protobuf/02-grpc-service.proto",
            {"emit_world": False},
        ),
        ("09-emitted-world-exports.wit", "graphql/01-simple-user.graphql", {}),
    ],
)
def test_committed_corpus_fixtures_are_what_the_emitter_writes_today(
    fixture: str, source: str, options: dict
) -> None:
    """Regenerating the corpus is a deliberate act, so drift fails here."""
    from corpus_adapter_support import adapter_for

    entry = next(e for e in load_corpus() if e.path == source)
    adapter = adapter_for(entry)
    api = adapter.normalize(
        adapter.parse(entry.read_text(), source_label=source), include_raw=False
    )
    assert emit(api, **options) == (WIT_EXAMPLES / fixture).read_text()


def test_the_types_only_fixture_declares_no_world() -> None:
    """A schema-only source has no callable to export, so it gets no world."""
    document = (WIT_EXAMPLES / "07-emitted-types-only.wit").read_text()
    parsed = parse_wit(document, source_label="07")
    assert parsed.worlds == ()
    assert [iface.name for iface in parsed.interfaces] == ["types"]


def test_the_interface_fixture_declares_functions_and_a_cross_interface_use() -> None:
    """An operation group becomes ``func`` items that ``use`` the shared types."""
    parsed = parse_wit(
        (WIT_EXAMPLES / "08-emitted-interface-functions.wit").read_text(), source_label="08"
    )
    product_service = next(i for i in parsed.interfaces if i.name == "product-service")
    assert [f.name for f in product_service.functions] == [
        "create-product",
        "get-product",
        "list-products",
    ]
    assert [use.path for use in product_service.uses] == ["types"]


def test_the_world_fixture_exports_the_generated_interface() -> None:
    """A synthesized world exports every interface that declares a function."""
    parsed = parse_wit(
        (WIT_EXAMPLES / "09-emitted-world-exports.wit").read_text(), source_label="09"
    )
    assert [world.name for world in parsed.worlds] == ["graph-ql-schema"]
    assert [
        (ref.direction, ref.path) for ref in parsed.worlds[0].interface_refs
    ] == [("export", "query")]


# ===========================================================================
# Determinism
# ===========================================================================


def test_two_emissions_of_one_model_are_byte_identical() -> None:
    """Re-exporting an unchanged catalog item must not produce a new artifact."""
    api = import_wit((WIT_EXAMPLES / "04-stress-type-system.wit").read_text())
    first = WitEmitter().emit(api)
    second = WitEmitter().emit(api)
    assert first.files[0].content == second.files[0].content
    assert first.losses == second.losses
    assert first.provenance == second.provenance


def test_the_emitted_file_is_named_after_the_package_and_carries_the_wit_media_type() -> None:
    """The bundle entry is a ``.wit`` file a component build can consume directly."""
    result = WitEmitter().emit(import_wit((WIT_EXAMPLES / "02-typical-calculator.wit").read_text()))
    assert result.files[0].path == "calculator.wit"
    assert result.files[0].media_type == OUTPUT_MEDIA_TYPE
    assert result.media_type == OUTPUT_MEDIA_TYPE
    assert isinstance(result.files[0].content, str)


# ===========================================================================
# Package declaration
# ===========================================================================


def test_an_imported_wit_package_keeps_its_own_package_and_version() -> None:
    """The source's declaration wins over anything the emitter would derive."""
    document = emit(import_wit((WIT_EXAMPLES / "02-typical-calculator.wit").read_text()))
    assert document.startswith("package examples:calculator@0.1.0;\n")


def test_a_package_is_derived_from_identity_and_reported_when_the_source_has_none() -> None:
    """Inventing a package name is a source-incomplete loss, not a silent default."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert emit(api).startswith("package acme-pets:pet-store;\n")
    assert "synthesized-package-name" in subjects(api)


def test_a_namespace_that_is_also_the_name_is_split_rather_than_repeated() -> None:
    """``example-catalog-v1:example-catalog-v1`` reads worse than ``example:catalog-v1``."""
    api = model(
        identity=ApiIdentity(name="example.catalog.v1", namespace="example.catalog.v1"),
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    assert emit(api).startswith("package example:catalog-v1;\n")


def test_a_single_segment_namespace_that_matches_the_name_falls_back() -> None:
    """With nothing to split, the default namespace keeps the halves distinct."""
    api = model(
        identity=ApiIdentity(name="pets", namespace="pets"),
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    assert emit(api).startswith("package apiome:pets;\n")


def test_a_package_override_is_written_verbatim() -> None:
    """A caller that names the package gets exactly that name."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert emit(api, package="wasi:pets").startswith("package wasi:pets;\n")


@pytest.mark.parametrize(
    ("version", "expected"),
    [("1.2.3", "@1.2.3"), ("v2.0", "@2.0"), ("2026-08-20", "@2026-08-20")],
)
def test_a_version_the_grammar_accepts_is_written(version: str, expected: str) -> None:
    """WIT versions start with a digit; a leading ``v`` is normalized away."""
    api = model(version=version, types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert emit(api).splitlines()[0].endswith(f"{expected};")


def test_a_version_the_grammar_rejects_is_dropped_and_reported() -> None:
    """A non-numeric version cannot be written, so the ledger says it was not."""
    api = model(version="beta", types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert "@" not in emit(api).splitlines()[0]
    assert "unsupported-version-literal" in subjects(api)


# ===========================================================================
# Types
# ===========================================================================


def _types_block(api: CanonicalApi, **options: object) -> str:
    """Emit ``api`` and return its document text (types land in one interface)."""
    return emit(api, **options)


def test_a_record_renders_its_fields_with_wit_optionality() -> None:
    """A nullable canonical field is exactly WIT's ``option<…>``."""
    api = model(
        types=[
            Type(
                key="Pet",
                name="Pet",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="Pet.name", name="name", type=TypeRef(name="string", nullable=False)
                    ),
                    CanonicalField(key="Pet.age", name="age", type=TypeRef(name="i32")),
                ],
            )
        ]
    )
    document = _types_block(api)
    assert "record pet {" in document
    assert "name: string," in document
    assert "age: option<s32>," in document


def test_an_empty_record_still_declares_itself() -> None:
    """A typeless canonical record is a declaration with no members, not a drop."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert "record pet {}" in _types_block(api)


def test_an_enum_renders_its_members_and_reports_a_dropped_wire_value() -> None:
    """A WIT enum case has a name and nothing else."""
    api = model(
        types=[
            Type(
                key="Status",
                name="Status",
                kind=TypeKind.ENUM,
                enum_values=[
                    EnumValue(key="Status.ACTIVE", name="ACTIVE", value=1),
                    EnumValue(key="Status.GONE", name="GONE"),
                ],
            )
        ]
    )
    document = _types_block(api)
    assert "enum status {" in document
    assert "active," in document
    assert "gone," in document
    assert "default-value" in subjects(api)


def test_an_empty_enum_still_declares_itself() -> None:
    """An enum with no members is a declaration with no cases."""
    api = model(types=[Type(key="Status", name="Status", kind=TypeKind.ENUM)])
    assert "enum status {}" in _types_block(api)


def test_a_flags_type_from_a_wit_source_is_written_back_as_flags() -> None:
    """``flags`` is a bitset, which canonical ENUM cannot say — the extras can."""
    api = model(
        types=[
            Type(
                key="Access",
                name="access",
                kind=TypeKind.ENUM,
                enum_values=[EnumValue(key="Access.read", name="read")],
                extras={"wit_kind": "flags"},
            )
        ]
    )
    assert "flags access {" in _types_block(api)


def test_a_union_from_a_wit_source_keeps_its_case_names_and_payloads() -> None:
    """The importer preserved the cases; the emitter writes exactly those."""
    document = emit(import_wit((WIT_EXAMPLES / "02-typical-calculator.wit").read_text()))
    assert "variant calc-error {" in document
    assert "divide-by-zero," in document
    assert "invalid-input(string)," in document


def test_a_union_without_case_names_derives_them_and_reports_the_approximation() -> None:
    """WIT requires named cases; a canonical union has only member types."""
    api = model(
        types=[
            Type(key="Cat", name="Cat", kind=TypeKind.RECORD),
            Type(key="Dog", name="Dog", kind=TypeKind.RECORD),
            Type(key="Pet", name="Pet", kind=TypeKind.UNION, union_members=["Cat", "Dog"]),
        ]
    )
    document = _types_block(api)
    assert "variant pet {" in document
    assert "cat(cat)," in document
    assert "dog(dog)," in document
    assert "undiscriminated-union" in subjects(api)


def test_an_empty_union_declares_an_empty_variant() -> None:
    """A union with no members has no case to invent."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.UNION)])
    assert "variant pet {}" in _types_block(api)


def test_a_map_is_approximated_as_an_association_list_and_reported() -> None:
    """WIT has no map type; the ticket names this as a declared loss."""
    api = model(
        types=[
            Type(
                key="Labels",
                name="Labels",
                kind=TypeKind.MAP,
                key_type=TypeRef(name="string", nullable=False),
                value_type=TypeRef(name="i32", nullable=False),
            )
        ]
    )
    assert "type labels = list<tuple<string, s32>>;" in _types_block(api)
    assert "open-ended-map" in subjects(api)


def test_an_alias_renders_its_target() -> None:
    """A canonical ALIAS is exactly WIT's ``type x = y;``."""
    api = model(
        types=[
            Type(
                key="Id",
                name="Id",
                kind=TypeKind.ALIAS,
                aliased=TypeRef(name="uint64", nullable=False),
            )
        ]
    )
    assert "type id = u64;" in _types_block(api)


def test_a_scalar_renders_a_concrete_right_hand_side() -> None:
    """A custom scalar with nothing behind it still needs a WIT type to alias."""
    api = model(types=[Type(key="Money", name="Money", kind=TypeKind.SCALAR)])
    assert "type money = string;" in _types_block(api)


def test_validation_facets_and_field_numbers_are_reported_per_type() -> None:
    """The ticket names numeric constraints as a declared loss."""
    api = model(
        types=[
            Type(
                key="Pet",
                name="Pet",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="Pet.age",
                        name="age",
                        type=TypeRef(name="i32", nullable=False),
                        field_number=3,
                        default=0,
                        constraints=Constraints(minimum=0, maximum=30),
                    )
                ],
            )
        ]
    )
    reported = subjects(api)
    assert "validation-constraints" in reported
    assert "field-identity" in reported
    assert "default-value" in reported


def test_a_type_named_after_a_wit_keyword_keeps_its_name_escaped() -> None:
    """``%record`` is how WIT spells a type honestly called ``record``."""
    api = model(types=[Type(key="record", name="record", kind=TypeKind.RECORD)])
    assert "record %record {}" in _types_block(api)


# ===========================================================================
# Functions
# ===========================================================================


def test_a_response_and_an_error_become_wits_result_type() -> None:
    """``result<ok, err>`` is the one place the two models line up exactly."""
    api = model(
        services=[
            service(
                operation(
                    "eval",
                    messages=[
                        Message(
                            key="svc.eval#request",
                            role=MessageRole.REQUEST,
                            payload=TypeRef(name="Request", nullable=False),
                            extras={"wit_param_name": "req"},
                        ),
                        Message(
                            key="svc.eval#response",
                            role=MessageRole.RESPONSE,
                            payload=TypeRef(name="double", nullable=False),
                        ),
                        Message(
                            key="svc.eval#error",
                            role=MessageRole.ERROR,
                            payload=TypeRef(name="CalcError", nullable=False),
                        ),
                    ],
                )
            )
        ],
        types=[
            Type(key="Request", name="Request", kind=TypeKind.RECORD),
            Type(key="CalcError", name="CalcError", kind=TypeKind.RECORD),
        ],
    )
    assert "eval: func(req: request) -> result<f64, calc-error>;" in emit(api)


def test_an_error_with_no_response_becomes_result_with_an_empty_ok_arm() -> None:
    """``result<_, err>`` says the call can fail and returns nothing on success."""
    api = model(
        services=[
            service(
                operation(
                    "drop",
                    messages=[
                        Message(
                            key="svc.drop#error",
                            role=MessageRole.ERROR,
                            payload=TypeRef(name="string", nullable=False),
                        )
                    ],
                )
            )
        ]
    )
    assert "drop: func() -> result<_, string>;" in emit(api)


def test_a_one_way_operation_returns_nothing() -> None:
    """Fire-and-forget has no result clause at all."""
    api = model(
        services=[
            service(
                Operation(
                    key="svc.notify",
                    name="notify",
                    kind=OperationKind.ONE_WAY,
                    messages=[
                        Message(
                            key="svc.notify#response",
                            role=MessageRole.RESPONSE,
                            payload=TypeRef(name="string", nullable=False),
                        )
                    ],
                )
            )
        ]
    )
    assert "notify: func();" in emit(api)


def test_rest_parameters_become_function_parameters_in_declaration_order() -> None:
    """A REST call's path/query inputs are the callable's arguments."""
    api = model(
        services=[
            service(
                operation(
                    "getPet",
                    http_method="GET",
                    http_path="/pets/{id}",
                    parameters=[
                        Parameter(
                            key="svc.getPet#path.id",
                            name="id",
                            location=ParameterLocation.PATH,
                            type=TypeRef(name="string", nullable=False),
                            required=True,
                        ),
                        Parameter(
                            key="svc.getPet#query.detail",
                            name="detail",
                            location=ParameterLocation.QUERY,
                            type=TypeRef(name="bool"),
                            constraints=Constraints(enum=[True, False]),
                        ),
                    ],
                )
            )
        ]
    )
    assert "get-pet: func(id: string, detail: option<bool>);" in emit(api)
    reported = subjects(api)
    assert "http-binding" in reported
    assert "validation-constraints" in reported


def test_a_multi_parameter_wit_function_keeps_its_parameter_list_exactly() -> None:
    """The importer preserved the list; a canonical payload could not hold it."""
    document = emit(import_wit((WIT_EXAMPLES / "05-real-world-keyvalue.wit").read_text()))
    assert (
        "increment: func(target: borrow<bucket>, key: string, delta: s64) "
        "-> result<s64, error>;"
    ) in document


def test_named_results_are_written_back_in_the_legacy_tuple_form() -> None:
    """``-> (a: t, b: u)`` is a shape only the preserved extras can restore."""
    api = model(
        services=[
            service(
                operation(
                    "split",
                    messages=[
                        Message(
                            key="svc.split#response",
                            role=MessageRole.RESPONSE,
                            extras={
                                "wit_results": [
                                    {"name": "head", "type": "string"},
                                    {"name": "rest", "type": "list<string>"},
                                ]
                            },
                        )
                    ],
                )
            )
        ]
    )
    assert "split: func() -> (head: string, rest: list<string>);" in emit(api)


def test_an_async_function_keeps_its_async_keyword() -> None:
    """``async func`` is preserved from the extras the importer recorded."""
    api = model(
        services=[service(operation("poll", extras={"wit_async": True}))],
    )
    assert "poll: async func();" in emit(api)


def test_a_streaming_operation_is_carried_as_a_stream_payload_and_reported() -> None:
    """WIT states streaming as ``stream<…>``; the cardinality itself is not carried."""
    api = model(
        services=[
            service(
                operation(
                    "watch",
                    streaming=StreamingMode.SERVER,
                    messages=[
                        Message(
                            key="svc.watch#response",
                            role=MessageRole.RESPONSE,
                            payload=TypeRef(name="string", nullable=False),
                        )
                    ],
                )
            )
        ]
    )
    assert "watch: func() -> stream<string>;" in emit(api)
    assert "streaming-operation" in subjects(api)


def test_extra_responses_beyond_the_first_are_reported() -> None:
    """A WIT function returns one value; a REST operation may declare several."""
    api = model(
        services=[
            service(
                operation(
                    "getPet",
                    messages=[
                        Message(
                            key="svc.getPet#response.404",
                            role=MessageRole.RESPONSE,
                            status_code="404",
                            payload=TypeRef(name="string", nullable=False),
                        ),
                        Message(
                            key="svc.getPet#response.200",
                            role=MessageRole.RESPONSE,
                            status_code="200",
                            payload=TypeRef(name="Pet", nullable=False),
                        ),
                    ],
                )
            )
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    # The 2xx response is what a caller receives, so it wins the single return slot.
    assert "get-pet: func() -> pet;" in emit(api)
    assert "additional-response" in subjects(api)


def test_an_inline_payload_schema_is_carried_as_text_and_reported() -> None:
    """WIT has no anonymous structural type for a body defined inline."""
    api = model(
        services=[
            service(
                operation(
                    "post",
                    messages=[
                        Message(
                            key="svc.post#request",
                            role=MessageRole.REQUEST,
                            payload_schema={"type": "object"},
                        )
                    ],
                )
            )
        ]
    )
    assert "post: func(arg: string);" in emit(api)
    assert "inline-payload-schema" in subjects(api)


# ===========================================================================
# Interfaces and worlds
# ===========================================================================


def test_types_belonging_to_no_operation_group_land_in_the_shared_interface() -> None:
    """A schema-only source still exports a package worth building against."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert "interface types {" in emit(api)
    assert "interface shared {" in emit(api, types_interface="shared")


def test_the_shared_types_interface_is_reported_as_a_grouping_the_source_never_made() -> None:
    """WIT declares types only inside an interface, so one had to be invented."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert "synthesized-interface" in subjects(api)


def test_a_source_that_states_its_own_grouping_needs_no_synthesized_interface() -> None:
    """A WIT source already says which interface each type belongs to."""
    api = import_wit((WIT_EXAMPLES / "02-typical-calculator.wit").read_text())
    assert "synthesized-interface" not in subjects(api)


def test_a_cross_interface_reference_writes_a_use_statement() -> None:
    """An interface may only name a type it declares or imports."""
    api = model(
        services=[
            service(
                operation(
                    "getPet",
                    messages=[
                        Message(
                            key="svc.getPet#response",
                            role=MessageRole.RESPONSE,
                            payload=TypeRef(name="Pet", nullable=False),
                        )
                    ],
                )
            )
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    assert "use types.{pet};" in emit(api)


def test_an_imported_name_that_collides_locally_is_aliased() -> None:
    """A function and a type may not share a name inside one interface."""
    api = model(
        services=[
            service(
                operation(
                    "Pet",
                    messages=[
                        Message(
                            key="svc.Pet#response",
                            role=MessageRole.RESPONSE,
                            payload=TypeRef(name="Pet", nullable=False),
                        )
                    ],
                )
            )
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    document = emit(api)
    assert "use types.{pet as pet-2};" in document
    assert "pet: func() -> pet-2;" in document


def test_a_declared_world_keeps_its_imports_exports_and_includes() -> None:
    """A world the source declared is written back from the extras it carries."""
    document = emit(import_wit((WIT_EXAMPLES / "03-composition-notifier.wit").read_text()))
    assert "world notifier {" in document
    assert "import publisher;" in document
    assert "export subscriber;" in document
    assert "import now: func() -> u64;" in document


def test_a_worlds_include_statements_are_written_back() -> None:
    """``include`` is recorded unexpanded by the importer and re-emitted verbatim."""
    api = model(
        services=[
            Service(
                key="w",
                name="child",
                extras={
                    "wit_kind": "world",
                    "wit_imports": [],
                    "wit_exports": [],
                    "wit_includes": ["parent"],
                },
            )
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    assert "include parent;" in emit(api)


def test_the_synthesized_world_exports_only_interfaces_that_declare_functions() -> None:
    """Exporting a types-only interface would say nothing about the component."""
    api = model(
        services=[service(operation("ping"))],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    document = emit(api)
    assert "export pets;" in document
    assert "export types;" not in document


def test_no_world_is_synthesized_for_a_package_with_no_callable() -> None:
    """A types-only package has nothing to export, so it declares no world."""
    api = model(types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)])
    assert "world" not in emit(api)
    assert "synthesized-world" not in subjects(api)


def test_emit_world_off_writes_an_interface_only_package() -> None:
    """A caller composing worlds elsewhere does not want one invented here."""
    api = model(services=[service(operation("ping"))])
    assert "world" not in emit(api, emit_world=False)


def test_the_world_name_may_be_chosen_by_the_caller() -> None:
    """A named world is the component contract the exporter is building."""
    api = model(services=[service(operation("ping"))])
    assert "world my-component {" in emit(api, world="My Component")


def test_a_world_name_that_collides_is_suffixed_readably() -> None:
    """``task-api-world`` says what the declaration is; ``task-api-2`` does not."""
    api = model(
        identity=ApiIdentity(name="Task API", namespace="acme"),
        services=[service(operation("ping"), name="Task API")],
    )
    document = emit(api)
    assert "interface task-api {" in document
    assert "world task-api-world {" in document


# ===========================================================================
# Document-level losses
# ===========================================================================


def test_channels_servers_and_security_schemes_are_reported_as_unrepresentable() -> None:
    """WIT describes an interface, never a transport, an address or a credential."""
    api = model(
        services=[service(operation("ping"))],
        channels=[Channel(key="user/signedup", address="user/signedup")],
        servers=[Server(url="https://api.example.com")],
        extras={"inferred_auth_schemes": ["bearerAuth"]},
    )
    reported = subjects(api)
    for subject in ("event-channel", "server-binding", "security-scheme"):
        assert subject in reported


def test_a_security_scheme_declared_per_operation_is_also_reported() -> None:
    """Schemes live in two places in the canonical model; both are read."""
    api = model(services=[service(operation("ping", extras={"security": ["apiKey"]}))])
    losses = WitEmitter().emit(api).losses
    scheme = next(loss for loss in losses if loss.subject == "security-scheme")
    assert "apiKey" in scheme.detail


def test_event_operations_are_dropped_and_reported() -> None:
    """A publish has no callable to describe, in an interface or in a world."""
    api = model(
        services=[
            Service(
                key="svc",
                name="Signups",
                operations=[
                    Operation(key="svc.emit", name="emit", kind=OperationKind.PUBLISH)
                ],
            ),
            Service(
                key="w",
                name="host",
                extras={"wit_kind": "world"},
                operations=[
                    Operation(key="w.recv", name="recv", kind=OperationKind.SUBSCRIBE)
                ],
            ),
        ],
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
    )
    document = emit(api)
    assert "emit" not in document
    assert "recv" not in document
    assert subjects(api).count("event-operation") == 2


def test_descriptions_are_written_as_doc_comments_and_reported_once() -> None:
    """The WIT parser strips comments, so a description does not survive re-import."""
    api = model(
        types=[
            Type(
                key="Pet",
                name="Pet",
                kind=TypeKind.RECORD,
                description="A pet.\nStill a pet.",
            )
        ]
    )
    document = emit(api)
    assert "/// A pet." in document
    assert "/// Still a pet." in document
    assert subjects(api).count("documentation-comment") == 1


def test_doc_comments_can_be_switched_off() -> None:
    """A caller that wants a bare package gets one."""
    api = model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD, description="A pet.")]
    )
    assert "///" not in emit(api, include_docs=False)


def test_a_deprecated_construct_is_marked_and_reported() -> None:
    """WIT's deprecation gate is stripped by the parser, so a comment carries it."""
    api = model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD, deprecated=True)]
    )
    assert "/// Deprecated." in emit(api)
    assert "deprecated-marker" in subjects(api)


def test_renamed_identifiers_are_reported_once_with_a_count_and_samples() -> None:
    """A camel-cased source renames everything; a row per name would be noise."""
    api = model(
        types=[
            Type(
                key=f"Type{index}",
                name=f"TypeName{index}",
                kind=TypeKind.RECORD,
            )
            for index in range(8)
        ]
    )
    losses = WitEmitter().emit(api).losses
    renames = [loss for loss in losses if loss.subject == "renamed-identifier"]
    assert len(renames) == 1
    assert "8 name(s)" in renames[0].detail
    assert "and 3 more" in renames[0].detail


def test_an_unresolvable_use_from_the_import_is_written_back() -> None:
    """The importer recorded it for the document; the package must still declare it."""
    api = model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
        extras={
            "wit": {
                "package": "acme:pets",
                "external_uses": ["wasi:io/streams.{input-stream}"],
                "capability_limits": [],
            }
        },
    )
    document = emit(api)
    assert "use wasi:io/streams.{input-stream};" in document
    assert parse_wit(document, source_label="external.wit") is not None


def test_a_malformed_external_use_is_not_written() -> None:
    """A report entry that is not a ``use`` would not parse; it is left out."""
    api = model(
        types=[Type(key="Pet", name="Pet", kind=TypeKind.RECORD)],
        extras={"wit": {"external_uses": ["not a use statement"], "capability_limits": []}},
    )
    assert "use " not in emit(api)


# ===========================================================================
# The ledger
# ===========================================================================


def test_every_loss_any_corpus_model_records_is_a_declared_subject() -> None:
    """The ledger cannot grow a class the importer has no counterpart for."""
    from corpus_adapter_support import adapter_for

    seen = set()
    for entry in load_corpus(format="wit", validity_class="valid"):
        if entry.fileset_role is not None:
            continue
        adapter = adapter_for(entry)
        api = adapter.normalize(
            adapter.parse(entry.read_text(), source_label=entry.path), include_raw=False
        )
        for loss in WitEmitter().emit(api).losses:
            assert loss.subject in LOSS_LEDGER_CLASS, loss.subject
            seen.add(loss.subject)
    assert seen


def test_the_loss_kind_of_every_recorded_loss_matches_its_declared_class() -> None:
    """``n/a`` means nothing was written; ``inferred`` means something derived was."""
    api = model(
        services=[service(operation("ping"))],
        channels=[Channel(key="c", address="c")],
        types=[
            Type(
                key="Labels",
                name="Labels",
                kind=TypeKind.MAP,
                key_type=TypeRef(name="string", nullable=False),
                value_type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    for loss in WitEmitter().emit(api).losses:
        loss_class = LOSS_LEDGER_CLASS[loss.subject]
        expected = LossKind.NA if loss_class is WitLossClass.UNSUPPORTED else LossKind.INFERRED
        assert loss.kind is expected, (loss.subject, loss.kind)


def test_the_three_classes_are_each_reachable_from_one_model() -> None:
    """A model that loses in all three ways reports in all three classes."""
    api = model(
        services=[service(operation("ping"))],
        servers=[Server(url="https://api.example.com")],
        types=[
            Type(
                key="Labels",
                name="Labels",
                kind=TypeKind.MAP,
                key_type=TypeRef(name="string", nullable=False),
                value_type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    classes = {LOSS_LEDGER_CLASS[loss.subject] for loss in WitEmitter().emit(api).losses}
    assert classes == set(WitLossClass)


# ===========================================================================
# Provenance
# ===========================================================================


def test_provenance_marks_a_derived_package_and_a_synthesized_world() -> None:
    """The fidelity analyzer must be able to see what the emitter invented."""
    api = model(services=[service(operation("ping"))])
    records = {record.pointer: record for record in WitEmitter().emit(api).provenance}
    assert records["package"].provenance is Provenance.INFERRED
    assert any(
        pointer.startswith("world/") and record.provenance is Provenance.INFERRED
        for pointer, record in records.items()
    )


def test_provenance_marks_source_constructs_as_source() -> None:
    """Everything read straight from the model is recorded as coming from it."""
    api = import_wit((WIT_EXAMPLES / "02-typical-calculator.wit").read_text())
    records = {record.pointer: record for record in WitEmitter().emit(api).provenance}
    assert records["examples:calculator.calculate"].provenance is Provenance.SOURCE
    assert records["examples:calculator.calculate.op"].provenance is Provenance.SOURCE
    assert records["package"].provenance is Provenance.SOURCE


# ===========================================================================
# Failure
# ===========================================================================


def test_a_model_with_no_service_and_no_type_refuses_to_emit() -> None:
    """An empty package is not a document the WIT parser would accept back."""
    with pytest.raises(ValueError, match="at least one interface or world"):
        WitEmitter().emit(model())


# ===========================================================================
# Fidelity rules
# ===========================================================================


def _pack() -> WitFidelityRulePack:
    """Instantiate the pack over this emitter's own capability profile."""
    return WitFidelityRulePack(WitEmitter.capability_profile(), WitEmitter.label)


def test_the_rule_pack_is_the_one_the_emitter_declares() -> None:
    """The fidelity engine must reach these rules, not the profile-derived default."""
    assert WitEmitter.fidelity_rule_pack() is WitFidelityRulePack
    assert issubclass(WitFidelityRulePack, CapabilityRulePack)


def test_a_channel_is_a_drop() -> None:
    """WIT has no channel vocabulary at all."""
    verdict = _pack().channel_verdict(Channel(key="c", address="c"))
    assert verdict.kind is LossinessKind.DROP


def test_an_event_operation_is_a_drop_and_a_callable_is_ok() -> None:
    """The pack must agree with what the emitter actually writes."""
    pack = _pack()
    publish = Operation(key="svc.emit", name="emit", kind=OperationKind.PUBLISH)
    assert pack.operation_verdict(publish).kind is LossinessKind.DROP
    assert pack.operation_verdict(operation("ping")).kind is LossinessKind.OK


def test_a_streaming_or_http_operation_is_an_approximation() -> None:
    """Both are carried, and both lose something on the way."""
    pack = _pack()
    streaming = operation("watch", streaming=StreamingMode.SERVER)
    assert pack.operation_verdict(streaming).kind is LossinessKind.APPROX
    rest = operation("getPet", http_method="GET", http_path="/pets")
    assert pack.operation_verdict(rest).kind is LossinessKind.APPROX


def test_a_map_type_is_an_approximation_and_a_record_is_not() -> None:
    """The map rule is this pack's one refinement over the profile-derived default."""
    pack = _pack()
    labels = Type(
        key="Labels",
        name="Labels",
        kind=TypeKind.MAP,
        key_type=TypeRef(name="string"),
        value_type=TypeRef(name="string"),
    )
    assert pack.type_verdict(labels).kind is LossinessKind.APPROX
    assert pack.type_verdict(Type(key="Pet", name="Pet", kind=TypeKind.RECORD)).kind is (
        LossinessKind.OK
    )


# ---------------------------------------------------------------------------
# The post-emit validation gate — FMT-2.7 (#5425)
# ---------------------------------------------------------------------------


def test_the_validator_accepts_a_package_this_emitter_wrote() -> None:
    """The gate's checker agrees with the emitter on every corpus fixture."""
    for fixture in sorted(WIT_EXAMPLES.glob("*.wit")):
        result = WitEmitter().emit(import_wit(fixture.read_text()))
        validate_wit_document(str(result.files[0].content))


def test_the_validator_rejects_text_that_is_not_wit() -> None:
    with pytest.raises(ValueError, match="Invalid WIT package"):
        validate_wit_document("this is prose, not a package\n")


def test_the_validator_rejects_a_syntactically_broken_package() -> None:
    with pytest.raises(ValueError, match="Invalid WIT package"):
        validate_wit_document("package apiome:demo@1.0.0;\ninterface widgets {\n")


def test_the_validator_rejects_a_package_that_declares_nothing() -> None:
    """A bare package declaration is syntactically legal and describes no API.

    The adapter is what refuses it, which is the point of routing the gate through the
    adapter rather than through the bare grammar: everything an intake would reject, an
    export is held to as well.
    """
    with pytest.raises(ValueError, match="declares no interfaces or worlds"):
        validate_wit_document("package apiome:demo@1.0.0;\n")
