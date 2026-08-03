"""Unit tests for the WIT (WebAssembly Component Model) ImportSource (IXH-7.9 / #5134)."""

from __future__ import annotations

import pytest

from app.canonical_model import (
    ApiParadigm,
    MessageRole,
    TypeKind,
)
from app.fileset import IntakeFileset
from app.import_preview_manifest import (
    KNOWN_PARSER_LIMITS,
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_routing import ImportTarget, decide_import_routing
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    get_import_source,
)
from app.wit_import_source import WitImportSource
from app.wit_parser import WitParseError, is_wit, parse_wit


@pytest.fixture
def adapter() -> WitImportSource:
    return WitImportSource()


CALCULATOR = """\
package docs:calculator@0.1.0;

interface types {
    record money {
        units: u64,
        cents: u8,
    }
    enum currency { usd, eur, jpy }
}

interface calculate {
    use types.{money, currency as cur};

    variant calc-error {
        overflow,
        divide-by-zero,
        custom(string),
    }

    flags permissions { read, write, admin }

    type history = list<money>;

    resource engine {
        constructor(initial: s32);
        add: func(x: s32) -> s32;
        merge: static func(a: borrow<engine>, b: borrow<engine>) -> engine;
    }

    eval: func(expr: string, in-currency: cur) -> result<money, calc-error>;
    reset: func();
    history-of: func(limit: option<u32>) -> history;
}

world calculator {
    import types;
    export calculate;
    import log: func(msg: string);
    export run: func(a: u32) -> u32;
    include docs:helper/base;
}
"""

MINIMAL = """\
package examples:greeter@0.1.0;

interface greet {
    greeting: func(name: string) -> string;
}
"""


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def test_detect_claims_wit_package(adapter: WitImportSource) -> None:
    result = adapter.detect(DetectionInput(text=CALCULATOR, filename="calculator.wit"))
    assert result.confidence >= 0.9
    assert result.format == "wit"


def test_detect_claims_extension_only(adapter: WitImportSource) -> None:
    result = adapter.detect(DetectionInput(text=None, filename="thing.wit"))
    assert 0 < result.confidence < 0.9


def test_detect_declines_non_wit(adapter: WitImportSource) -> None:
    assert not adapter.detect(DetectionInput(text="openapi: 3.0.3\ninfo: {}\n")).matched
    assert not adapter.detect(
        DetectionInput(text='syntax = "proto3";\nmessage M { int32 a = 1; }\n')
    ).matched
    # CORBA-style IDL uses `interface` too, but not WIT's `name: func` syntax.
    assert not adapter.detect(
        DetectionInput(text="module Acme { interface Greeter { string hello(); }; };")
    ).matched


def test_is_wit_never_raises_on_junk() -> None:
    assert not is_wit("")
    assert not is_wit("{ not wit }")
    assert not is_wit("interface { nameless")


def test_adapter_is_registered() -> None:
    source = get_import_source("wit")
    assert isinstance(source, WitImportSource)
    descriptor = source.descriptor()
    assert descriptor.paradigm is ApiParadigm.RPC
    assert "wit" in descriptor.formats


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_parse_reads_package_interfaces_worlds(adapter: WitImportSource) -> None:
    doc = adapter.parse(CALCULATOR, source_label="calculator.wit")
    assert doc.package == "docs:calculator"
    assert doc.version == "0.1.0"
    assert [i.name for i in doc.interfaces] == ["types", "calculate"]
    assert [w.name for w in doc.worlds] == ["calculator"]

    calculate = doc.interfaces[1]
    assert [f.name for f in calculate.functions] == ["eval", "reset", "history-of"]
    assert calculate.uses[0].path == "types"
    assert calculate.uses[0].names == (("money", None), ("currency", "cur"))

    engine = calculate.resources[0]
    assert engine.constructor is not None
    assert [m.name for m in engine.methods] == ["add", "merge"]
    assert engine.methods[1].kind == "static"

    world = doc.worlds[0]
    assert {(f.direction, f.function.name) for f in world.functions} == {
        ("import", "log"),
        ("export", "run"),
    }
    assert world.includes == ("docs:helper/base",)


def test_parse_rejects_empty_and_non_wit(adapter: WitImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.parse("")
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("openapi: 3.0.3\ninfo:\n  title: nope\n")
    assert exc_info.value.code == "FORMAT_MISMATCH"


def test_parse_classifies_truncation() -> None:
    with pytest.raises(WitParseError) as exc_info:
        parse_wit("package a:b;\ninterface data {\n  record point {\n    x: u32,\n")
    assert exc_info.value.code == "INPUT_TRUNCATED"


def test_parse_classifies_no_definitions() -> None:
    with pytest.raises(WitParseError) as exc_info:
        parse_wit("package examples:empty@0.1.0;\n")
    assert exc_info.value.code == "INPUT_SEMANTIC_INVALID"


def test_parse_classifies_binary_input() -> None:
    with pytest.raises(WitParseError) as exc_info:
        parse_wit("package a:b;\x00interface x { f: func(); }")
    assert exc_info.value.code == "INPUT_ENCODING_INVALID"


def test_parse_rejects_invalid_statement() -> None:
    with pytest.raises(WitParseError):
        parse_wit("package a:b;\ninterface greet {\n  greeting func(name: string);\n}\n")


def test_parse_strips_comments_and_gates() -> None:
    doc = parse_wit(
        "package a:b;\n"
        "// line comment\n"
        "/* block /* nested */ comment */\n"
        "interface x {\n"
        "  /// doc comment\n"
        "  @since(version = 1.0.0)\n"
        "  ping: func() -> bool;\n"
        "}\n"
    )
    assert [f.name for f in doc.interfaces[0].functions] == ["ping"]


def test_parse_unwraps_nested_package_block() -> None:
    doc = parse_wit(
        "package a:b@1.0.0 {\n"
        "  interface x { ping: func() -> bool; }\n"
        "}\n"
        "package c:d {\n"
        "  interface hidden { pong: func(); }\n"
        "}\n"
    )
    assert doc.package == "a:b"
    assert [i.name for i in doc.interfaces] == ["x"]
    assert doc.extra_package_blocks == 1


# ---------------------------------------------------------------------------
# Fileset (multi-file package) intake
# ---------------------------------------------------------------------------


MEMBER_TYPES = """\
package examples:orders@1.0.0;

interface order-types {
    record order {
        id: option<string>,
        total-cents: u64,
    }
    variant order-error {
        not-found,
        rejected(string),
    }
}
"""

MEMBER_API = """\
package examples:orders@1.0.0;

interface order-api {
    use order-types.{order, order-error};

    get-order: func(id: string) -> result<order, order-error>;
}
"""


def test_fileset_merges_package_and_resolves_uses(adapter: WitImportSource) -> None:
    fileset = IntakeFileset.from_members(
        {"api.wit": MEMBER_API, "types.wit": MEMBER_TYPES}, root="api.wit"
    )
    doc = adapter.parse_fileset(fileset)
    assert doc.package == "examples:orders"
    assert {i.name for i in doc.interfaces} == {"order-types", "order-api"}

    api = adapter.normalize(doc)
    # The cross-file `use` resolves to the sibling interface's canonical type key.
    (operation,) = api.operations()
    response = next(m for m in operation.messages if m.role is MessageRole.RESPONSE)
    assert response.payload is not None
    assert response.payload.name == "examples:orders.order-types.order"
    error = next(m for m in operation.messages if m.role is MessageRole.ERROR)
    assert error.payload is not None
    assert error.payload.name == "examples:orders.order-types.order-error"
    assert api.extras["wit"]["external_uses"] == []


def test_fileset_rejects_conflicting_packages(adapter: WitImportSource) -> None:
    fileset = IntakeFileset.from_members(
        {
            "a.wit": "package a:one;\ninterface x { f: func(); }\n",
            "b.wit": "package b:two;\ninterface y { g: func(); }\n",
        },
        root="a.wit",
    )
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse_fileset(fileset)
    assert exc_info.value.code == "INPUT_SEMANTIC_INVALID"


def test_use_outside_package_is_recorded_not_resolved(adapter: WitImportSource) -> None:
    doc = parse_wit(
        "package a:b;\n"
        "interface x {\n"
        "  use wasi:io/streams.{input-stream};\n"
        "  read: func(from: input-stream) -> list<u8>;\n"
        "}\n"
    )
    api = adapter.normalize(doc)
    assert api.extras["wit"]["external_uses"] == ["wasi:io/streams.{input-stream}"]
    (operation,) = api.operations()
    request = operation.messages[0]
    assert request.payload is not None
    # Kept as a named reference — never silently dropped, never fabricated.
    assert request.payload.name == "input-stream"


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def test_normalize_maps_worlds_interfaces_and_types(adapter: WitImportSource) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    assert api.paradigm is ApiParadigm.RPC
    assert api.format == "wit"
    assert api.version == "0.1.0"
    assert api.identity.namespace == "docs:calculator"

    service_keys = {s.key for s in api.services}
    assert service_keys == {
        "docs:calculator.calculate",
        "docs:calculator.calculator",
    }

    kinds = {t.key: t.kind for t in api.types}
    assert kinds["docs:calculator.types.money"] is TypeKind.RECORD
    assert kinds["docs:calculator.types.currency"] is TypeKind.ENUM
    assert kinds["docs:calculator.calculate.calc-error"] is TypeKind.UNION
    assert kinds["docs:calculator.calculate.permissions"] is TypeKind.ENUM
    assert kinds["docs:calculator.calculate.history"] is TypeKind.ALIAS
    assert kinds["docs:calculator.calculate.engine"] is TypeKind.RECORD

    flags_type = next(t for t in api.types if t.name == "permissions")
    assert flags_type.extras["wit_kind"] == "flags"

    resource = next(t for t in api.types if t.name == "engine")
    assert resource.extras["wit_kind"] == "resource"
    assert resource.extras["wit_constructor"]["params"] == [
        {"name": "initial", "type": "s32"}
    ]
    assert [m["name"] for m in resource.extras["wit_methods"]] == ["add", "merge"]


def test_normalize_result_return_maps_to_response_and_error(
    adapter: WitImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    calculate = next(s for s in api.services if s.name == "calculate")
    eval_op = next(o for o in calculate.operations if o.name == "eval")
    roles = {m.role for m in eval_op.messages}
    assert roles == {MessageRole.REQUEST, MessageRole.RESPONSE, MessageRole.ERROR}
    response = next(m for m in eval_op.messages if m.role is MessageRole.RESPONSE)
    assert response.payload is not None
    assert response.payload.name == "docs:calculator.types.money"
    error = next(m for m in eval_op.messages if m.role is MessageRole.ERROR)
    assert error.payload is not None
    assert error.payload.name == "docs:calculator.calculate.calc-error"


def test_normalize_option_maps_to_nullability(adapter: WitImportSource) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    calculate = next(s for s in api.services if s.name == "calculate")
    history_of = next(o for o in calculate.operations if o.name == "history-of")
    request = next(m for m in history_of.messages if m.role is MessageRole.REQUEST)
    assert request.payload is not None
    assert request.payload.name == "uint32"
    assert request.payload.nullable is True  # option<u32>
    # WIT types are otherwise non-nullable.
    eval_op = next(o for o in calculate.operations if o.name == "eval")
    response = next(m for m in eval_op.messages if m.role is MessageRole.RESPONSE)
    assert response.payload is not None and response.payload.nullable is False


def test_normalize_world_functions_keep_direction(adapter: WitImportSource) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    world = next(s for s in api.services if s.name == "calculator")
    directions = {o.name: o.extras["wit_direction"] for o in world.operations}
    assert directions == {"log": "import", "run": "export"}
    world_extras = world.extras
    assert world_extras["wit_imports"] == ["types"]
    assert world_extras["wit_exports"] == ["calculate"]
    assert world_extras["wit_includes"] == ["docs:helper/base"]


def test_normalize_types_only_package_is_data_schema(adapter: WitImportSource) -> None:
    doc = parse_wit("package a:b;\ninterface shapes { record dot { x: u32 } }\n")
    api = adapter.normalize(doc)
    assert api.paradigm is ApiParadigm.DATA_SCHEMA
    assert api.services == []


def test_normalize_rejects_foreign_ast(adapter: WitImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"not": "a wit document"})


def test_fingerprint_is_deterministic(adapter: WitImportSource) -> None:
    api_a = adapter.normalize(adapter.parse(CALCULATOR))
    api_b = adapter.normalize(adapter.parse(CALCULATOR))
    assert adapter.fingerprint(api_a) == adapter.fingerprint(api_b)
    assert adapter.diff(api_a, api_b).is_empty


# ---------------------------------------------------------------------------
# Capability limits — never silent drops
# ---------------------------------------------------------------------------


def test_capability_limits_record_resources_and_borrow(
    adapter: WitImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    limits = {
        (entry["kind"], entry["construct"]): entry["count"]
        for entry in api.extras["wit"]["capability_limits"]
    }
    assert limits[("resource-methods", "resource#calculate.engine")] == 3
    assert ("borrow-handle", "borrow#calculate") in limits
    assert api.extras["wit"]["unexpanded_includes"] == ["docs:helper/base"]


def test_wit_extras_key_is_provenance_registered() -> None:
    assert "wit" in PROVENANCE_EXTRA_KEYS


def test_declared_parser_limits_have_registry_entry() -> None:
    constructs = {limit.construct for limit in KNOWN_PARSER_LIMITS["wit"]}
    assert "world include expansion" in constructs
    assert "secondary nested package blocks" in constructs


def test_preview_manifest_renders_capability_limit_rows(
    adapter: WitImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="wit", options={})
    )

    by_construct = {entry.source_construct: entry for entry in page.coverage}
    resource_row = by_construct["wit#resource#calculate.engine"]
    assert resource_row.coverage is CoverageClass.PARTIALLY_MAPPED
    assert "capability limit" in resource_row.detail
    borrow_row = by_construct["wit#borrow#calculate"]
    assert borrow_row.coverage is CoverageClass.PARTIALLY_MAPPED

    # The adapter's declared parser limits appear as not-parsed-by-adapter rows.
    declared = [
        entry
        for entry in page.coverage
        if entry.coverage is CoverageClass.NOT_PARSED_BY_ADAPTER
    ]
    assert {entry.source_construct for entry in declared} == {
        "world include expansion",
        "secondary nested package blocks",
    }


def test_preview_manifest_renders_external_use_rows(adapter: WitImportSource) -> None:
    doc = parse_wit(
        "package a:b;\n"
        "interface x {\n"
        "  use wasi:io/streams.{input-stream};\n"
        "  read: func(from: input-stream) -> list<u8>;\n"
        "}\n"
    )
    api = adapter.normalize(doc)
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="wit", options={})
    )
    external_rows = [
        entry
        for entry in page.coverage
        if entry.source_construct.startswith("wit#use.")
    ]
    assert len(external_rows) == 1
    assert external_rows[0].coverage is CoverageClass.INFERRED


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def test_routing_sends_wit_to_catalog(adapter: WitImportSource) -> None:
    api = adapter.normalize(adapter.parse(MINIMAL))
    decision = decide_import_routing(adapter, api)
    assert decision.target is ImportTarget.CATALOG
    assert decision.publishable is False


def test_lint_produces_scored_report(adapter: WitImportSource) -> None:
    api = adapter.normalize(adapter.parse(CALCULATOR))
    report = adapter.lint(api)
    assert report.score is not None
    assert report.grade is not None
    assert report.report_fingerprint
