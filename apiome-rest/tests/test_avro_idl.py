"""Avro IDL (``.avdl``) import and emit — FMT-3.5 (#5430).

Four contracts, in the order the ticket states them:

1. a ``.avdl`` file imports, and a ``.avdl`` generated from the same model round-trips;
2. an IDL protocol with messages produces RPC operations; a schema-only IDL does not;
3. ``.avsc`` behaviour is unchanged — the JSON surface must not move at all;
4. the corpus covers schema-only IDL, a protocol with messages, imports, and a
   malformed IDL in the negative tier.

The corpus entries themselves are exercised by the shared suites
(``test_corpus_import`` / ``test_corpus_negative`` / ``test_corpus_golden``); what lives
here is the per-construct grammar coverage and the seams those suites cannot see.
"""

from __future__ import annotations

import json

import pytest
from corpus_loader import load_corpus

from app.avro_emitter import AvroEmitOptions, AvroEmitter, validate_avro_bundle
from app.avro_idl_emitter import IDL_MEDIA_TYPE
from app.avro_idl_parser import AvroIdlParseError, is_avro_idl, parse_avro_idl
from app.avro_import_source import AvroImportSource
from app.avro_parser import parse_avro
from app.canonical_model import ApiParadigm, MessageRole, OperationKind
from app.diff import diff
from app.fileset import IntakeFileset
from app.import_source import DetectionInput, ImportSourceError

# --- fixtures ---------------------------------------------------------------------

SCHEMA_ONLY = """\
/** Shared value types. */
namespace com.acme.core;

enum Colour {
  RED, GREEN, BLUE
}

record Widget {
  string id;
  Colour colour;
  union { null, string } label = null;
}
"""

PROTOCOL = """\
/** Widget service. */
@namespace("com.acme.widgets")
@version("2")
protocol WidgetService {

  record Widget {
    string id;
  }

  error NotFound {
    string id;
  }

  /** Fetch one widget. */
  Widget get(string id) throws NotFound;

  /** Fire and forget. */
  void touch(string id) oneway;

  /** Returns nothing, but is not oneway. */
  void poke(Widget widget);
}
"""


def _adapter() -> AvroImportSource:
    return AvroImportSource()


def _model(text: str, *, label: str = "test.avdl"):
    adapter = _adapter()
    return adapter.normalize(adapter.parse(text, source_label=label), include_raw=False)


def _emit_idl(api) -> str:
    result = AvroEmitter().emit(api, opts=AvroEmitOptions(output_syntax="avdl"))
    assert len(result.files) == 1, "Avro IDL keeps a whole protocol in one document"
    assert result.media_type == IDL_MEDIA_TYPE
    return result.files[0].content


# --- parser: document forms -------------------------------------------------------


def test_schema_only_idl_declares_types_and_no_protocol():
    document = parse_avro_idl(SCHEMA_ONLY, source_label="core.avdl")
    assert document.protocol is None
    assert document.syntax == "avdl"
    assert document.doc == "Shared value types."
    assert [(t.namespace, t.name) for t in document.types] == [
        ("com.acme.core", "Colour"),
        ("com.acme.core", "Widget"),
    ]
    assert document.root.name == "Colour", "the first declaration is the document root"


def test_protocol_idl_carries_the_message_layer():
    document = parse_avro_idl(PROTOCOL, source_label="widgets.avdl")
    protocol = document.protocol
    assert protocol is not None
    assert (protocol.name, protocol.namespace) == ("WidgetService", "com.acme.widgets")
    assert protocol.doc == "Widget service."
    assert protocol.properties == {"version": "2"}
    assert [m.name for m in protocol.messages] == ["get", "touch", "poke"]

    get, touch, poke = protocol.messages
    assert get.response == "Widget"
    assert get.errors == ("NotFound",)
    assert [(p.name, p.type) for p in get.request] == [("id", "string")]
    assert touch.oneway is True and touch.response == "null"
    assert poke.oneway is False and poke.response == "null"


def test_error_declaration_is_a_record_with_the_error_marker():
    document = parse_avro_idl(PROTOCOL, source_label="widgets.avdl")
    not_found = next(t for t in document.types if t.name == "NotFound")
    assert not_found.schema["type"] == "error"
    assert not_found.schema["fields"] == [{"name": "id", "type": "string"}]


# --- parser: type grammar ---------------------------------------------------------


@pytest.mark.parametrize(
    ("declaration", "expected"),
    [
        ("string plain;", "string"),
        ("array<int> many;", {"type": "array", "items": "int"}),
        ("map<string> byKey;", {"type": "map", "values": "string"}),
        ("union { null, string } maybe;", ["null", "string"]),
        ("string? shorthand;", ["null", "string"]),
        (
            "decimal(12, 4) money;",
            {"type": "bytes", "logicalType": "decimal", "precision": 12, "scale": 4},
        ),
        ("date day;", {"type": "int", "logicalType": "date"}),
        ("time_ms clock;", {"type": "int", "logicalType": "time-millis"}),
        ("timestamp_ms stamp;", {"type": "long", "logicalType": "timestamp-millis"}),
        (
            "local_timestamp_ms local;",
            {"type": "long", "logicalType": "local-timestamp-millis"},
        ),
        ("uuid correlation;", {"type": "string", "logicalType": "uuid"}),
        (
            '@logicalType("timestamp-micros") long precise;',
            {"type": "long", "logicalType": "timestamp-micros"},
        ),
        (
            "array<map<union { null, double }>> nested;",
            {
                "type": "array",
                "items": {"type": "map", "values": ["null", "double"]},
            },
        ),
    ],
)
def test_field_type_expressions(declaration, expected):
    document = parse_avro_idl(f"namespace t;\nrecord R {{\n  {declaration}\n}}\n")
    assert document.types[0].schema["fields"][0]["type"] == expected


def test_field_decoration_becomes_avro_properties():
    document = parse_avro_idl(
        'namespace t;\n'
        'record R {\n'
        '  /** Doc. */\n'
        '  @order("ignore") @aliases(["old"]) @owner({"team": "core"}) string name = "x";\n'
        "}\n"
    )
    field = document.types[0].schema["fields"][0]
    assert field["doc"] == "Doc."
    assert field["order"] == "ignore"
    assert field["aliases"] == ["old"]
    assert field["default"] == "x"
    assert field["type"] == {"type": "string", "owner": {"team": "core"}}


def test_escaped_identifiers_are_readable_in_both_positions():
    document = parse_avro_idl(
        "namespace t;\n"
        "record `record` {\n"
        "  string `enum`;\n"
        "  `record` self;\n"
        "}\n"
    )
    schema = document.types[0].schema
    assert schema["name"] == "record"
    assert [f["name"] for f in schema["fields"]] == ["enum", "self"]
    assert schema["fields"][1]["type"] == "record"


def test_enum_default_and_fixed_size():
    document = parse_avro_idl(
        "namespace t;\n"
        "enum Priority { LOW, HIGH } = LOW;\n"
        "@aliases([\"Sha\"]) fixed Digest(32);\n"
        "record R { Priority p; Digest d; }\n"
    )
    by_name = {t.name: t.schema for t in document.types}
    assert by_name["Priority"]["default"] == "LOW"
    assert by_name["Digest"] == {
        "type": "fixed",
        "name": "Digest",
        "namespace": "t",
        "aliases": ["Sha"],
        "size": 32,
    }


def test_doc_comments_are_dedented_and_joined():
    document = parse_avro_idl(
        "namespace t;\n"
        "/**\n"
        " * First line.\n"
        " * Second line.\n"
        " */\n"
        "record R { string a; }\n"
    )
    assert document.types[0].schema["doc"] == "First line.\nSecond line."


def test_line_and_block_comments_are_dropped():
    document = parse_avro_idl(
        "namespace t; // trailing\n/* block */\nrecord R { string a; /* inline */ }\n"
    )
    assert document.types[0].schema["fields"] == [{"name": "a", "type": "string"}]


# --- parser: imports --------------------------------------------------------------


def test_import_idl_and_schema_merge_their_named_types():
    members = {
        "main.avdl": (
            '@namespace("com.acme.main")\n'
            "protocol Main {\n"
            '  import idl "shared.avdl";\n'
            '  import schema "generated.avsc";\n'
            "  record Root { com.acme.shared.Leaf leaf; }\n"
            "  Root fetch();\n"
            "}\n"
        ),
        "shared.avdl": "namespace com.acme.shared;\nrecord Leaf { string id; }\n",
        "generated.avsc": json.dumps(
            {
                "type": "record",
                "name": "Generated",
                "namespace": "com.acme.gen",
                "fields": [{"name": "n", "type": "int"}],
            }
        ),
    }
    document = parse_avro_idl(members["main.avdl"], source_label="main.avdl", members=members)
    assert [f"{t.namespace}.{t.name}" for t in document.types] == [
        "com.acme.gen.Generated",
        "com.acme.main.Root",
        "com.acme.shared.Leaf",
    ]


def test_import_protocol_merges_the_types_of_an_avpr_document():
    members = {
        "main.avdl": (
            "namespace com.acme.main;\n"
            'import protocol "other.avpr";\n'
            "record Root { com.acme.other.Thing thing; }\n"
        ),
        "other.avpr": json.dumps(
            {
                "protocol": "Other",
                "namespace": "com.acme.other",
                "types": [
                    {"type": "record", "name": "Thing", "fields": [{"name": "id", "type": "string"}]}
                ],
            }
        ),
    }
    document = parse_avro_idl(members["main.avdl"], source_label="main.avdl", members=members)
    assert [f"{t.namespace}.{t.name}" for t in document.types] == [
        "com.acme.main.Root",
        "com.acme.other.Thing",
    ]


def test_an_unresolvable_import_is_a_named_unresolved_reference():
    with pytest.raises(AvroIdlParseError) as excinfo:
        parse_avro_idl(
            "namespace t;\nimport idl \"missing.avdl\";\nrecord R { string a; }\n"
        )
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "missing.avdl" in str(excinfo.value)


def test_a_cyclic_import_terminates():
    members = {
        "a.avdl": 'namespace t;\nimport idl "b.avdl";\nrecord A { string x; }\n',
        "b.avdl": 'namespace t;\nimport idl "a.avdl";\nrecord B { string y; }\n',
    }
    document = parse_avro_idl(members["a.avdl"], source_label="a.avdl", members=members)
    assert sorted(t.name for t in document.types) == ["A", "B"]


# --- parser: failure taxonomy -----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("namespace t;\nrecord R {\n  string a\n  long b;\n}\n", None),
        ('namespace t;\nrecord R {\n  string a = "unterminated\n', "INPUT_TRUNCATED"),
        ("namespace t;\nrecord R {\n  string a; /* never closed\n", "INPUT_TRUNCATED"),
        ("namespace t;\nrecord R {\n  string a;\n", "INPUT_TRUNCATED"),
        (
            "namespace t;\nrecord R {\n  union { null, string, string } u = null;\n}\n",
            "INPUT_SEMANTIC_INVALID",
        ),
        ("namespace t;\nrecord R { string a; string a; }\n", "INPUT_SEMANTIC_INVALID"),
        ("namespace t;\nrecord R { string a; }\nrecord R { int b; }\n", "INPUT_SEMANTIC_INVALID"),
        ("namespace t;\nenum E { }\n", "INPUT_SEMANTIC_INVALID"),
        (
            "namespace t;\nrecord R { string a; }\nR fetch();\n",
            "INPUT_SEMANTIC_INVALID",
        ),
    ],
)
def test_invalid_idl_carries_its_taxonomy_code(text, code):
    with pytest.raises(AvroIdlParseError) as excinfo:
        parse_avro_idl(text, source_label="broken.avdl")
    assert excinfo.value.code == code


def test_empty_input_is_rejected():
    with pytest.raises(AvroIdlParseError):
        parse_avro_idl("   \n  ")


@pytest.mark.parametrize(
    "text",
    [
        "namespace t;\nrecord R {{ {nest} x; }}\n".format(
            nest="array<" * 500 + "int" + ">" * 500
        ),
        "namespace t;\nrecord R {{ @a({nest}) string x; }}\n".format(
            nest="[" * 500 + "]" * 500
        ),
    ],
    ids=["type-expression", "annotation-json"],
)
def test_pathological_nesting_is_a_resource_rejection_not_a_crash(text):
    """A recursive-descent reader must refuse depth rather than exhaust the stack.

    ``RecursionError`` is not one of the exceptions the import pipeline's parse phase
    catches, so it would escape as a 500 rather than a failed job.
    """
    with pytest.raises(AvroIdlParseError) as excinfo:
        parse_avro_idl(text, source_label="deep.avdl")
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


@pytest.mark.parametrize(
    "text",
    [
        "\x00\x01\x02",
        "protocol {",
        "namespace ;",
        "record",
        "\ufeffnamespace t;\nrecord R { string a; }\n",
        "@" * 5000,
    ],
)
def test_the_sniffer_never_raises_on_hostile_input(text):
    """Detection runs before anything is trusted, so the sniff must always answer."""
    assert is_avro_idl(text) in (True, False)


# --- detection --------------------------------------------------------------------


@pytest.mark.parametrize("text", [SCHEMA_ONLY, PROTOCOL])
def test_sniffer_claims_both_idl_forms(text):
    assert is_avro_idl(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        'syntax = "proto3";\npackage x;\nmessage M { string a = 1; }\n',
        "namespace java com.example\nstruct Thing { 1: string id }\n",
        '{"type": "record", "name": "R", "fields": []}',
        "namespace com.example.only;\n",
    ],
)
def test_sniffer_does_not_claim_other_content(text):
    assert is_avro_idl(text) is False


def test_detect_reports_the_idl_surface_by_content_and_by_suffix():
    adapter = _adapter()
    by_content = adapter.detect(DetectionInput(text=PROTOCOL, filename="paste.txt"))
    assert (by_content.format, by_content.matched) == ("avro-idl", True)
    assert by_content.confidence >= 0.9

    by_suffix = adapter.detect(DetectionInput(text="", filename="schema.avdl"))
    assert by_suffix.format == "avro-idl"
    assert by_suffix.confidence == 0.8


def test_detect_still_reports_plain_avro_for_a_json_schema():
    adapter = _adapter()
    text = json.dumps(
        {"type": "record", "name": "R", "namespace": "t", "fields": [{"name": "a", "type": "string"}]}
    )
    result = adapter.detect(DetectionInput(text=text, filename="r.avsc"))
    assert (result.format, result.confidence) == ("avro", 0.95)


def test_the_adapter_declares_both_surfaces():
    assert AvroImportSource.formats == ("avro", "avsc", "avro-idl")
    assert ".avdl" in AvroImportSource.declared_file_extensions()


# --- import routing ---------------------------------------------------------------


def test_parse_routes_by_suffix_and_by_content():
    adapter = _adapter()
    assert adapter.parse(PROTOCOL, source_label="widgets.avdl").syntax == "avdl"
    assert adapter.parse(PROTOCOL, source_label=None).syntax == "avdl"
    avsc = json.dumps(
        {"type": "record", "name": "R", "namespace": "t", "fields": [{"name": "a", "type": "string"}]}
    )
    assert adapter.parse(avsc, source_label="r.avsc").syntax == "avsc"


def test_parse_fileset_resolves_imports_across_members():
    members = {
        "main.avdl": (
            '@namespace("com.acme.main")\n'
            "protocol Main {\n"
            '  import idl "shared.avdl";\n'
            "  record Root { com.acme.shared.Leaf leaf; }\n"
            "  Root fetch();\n"
            "}\n"
        ),
        "shared.avdl": "namespace com.acme.shared;\nrecord Leaf { string id; }\n",
    }
    adapter = _adapter()
    document = adapter.parse_fileset(
        IntakeFileset.from_members(members, root="main.avdl"), source_label="main.avdl"
    )
    assert {t.name for t in document.types} == {"Root", "Leaf"}


def test_parse_surfaces_the_taxonomy_code_on_the_import_error():
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter().parse(
            'namespace t;\nrecord R { string a = "oops\n', source_label="broken.avdl"
        )
    assert excinfo.value.code == "INPUT_TRUNCATED"


# --- normalization ----------------------------------------------------------------


def test_a_protocol_with_messages_produces_rpc_operations():
    api = _model(PROTOCOL, label="widgets.avdl")
    assert api.paradigm is ApiParadigm.RPC
    assert api.identity.name == "WidgetService"
    assert api.identity.namespace == "com.acme.widgets"
    assert api.description == "Widget service."
    assert api.extras["avro_protocol"] == "com.acme.widgets.WidgetService"
    assert api.extras["avro_protocol_properties"] == {"version": "2"}
    assert api.extras["avro_syntax"] == "avdl"

    service = api.services[0]
    assert service.key == "com.acme.widgets.WidgetService"
    kinds = {op.name: op.kind for op in service.operations}
    assert kinds["get"] is OperationKind.REQUEST_RESPONSE
    assert kinds["touch"] is OperationKind.ONE_WAY
    assert kinds["poke"] is OperationKind.REQUEST_RESPONSE


def test_a_schema_only_idl_produces_no_operations():
    api = _model(SCHEMA_ONLY, label="core.avdl")
    assert api.paradigm is ApiParadigm.DATA_SCHEMA
    assert api.services == []
    assert "avro_protocol" not in api.extras
    assert api.extras["avro_syntax"] == "avdl"


def test_message_request_response_and_error_payloads():
    api = _model(PROTOCOL, label="widgets.avdl")
    get = next(op for op in api.operations() if op.name == "get")
    roles = {m.role: m for m in get.messages}
    assert roles[MessageRole.REQUEST].extras["avro_parameters"] == [
        {"name": "id", "type": "string"}
    ]
    assert roles[MessageRole.RESPONSE].payload.name == "com.acme.widgets.Widget"
    assert roles[MessageRole.ERROR].payload.name == "com.acme.widgets.NotFound"
    assert roles[MessageRole.ERROR].name == "NotFound"

    touch = next(op for op in api.operations() if op.name == "touch")
    assert MessageRole.RESPONSE not in {m.role for m in touch.messages}


def test_error_types_keep_their_error_marker_in_extras():
    api = _model(PROTOCOL, label="widgets.avdl")
    not_found = api.type_by_key("com.acme.widgets.NotFound")
    assert not_found.extras["avro_kind"] == "error"


# --- .avsc behaviour is unchanged -------------------------------------------------

_AVSC = json.dumps(
    {
        "type": "record",
        "name": "User",
        "namespace": "com.acme",
        "doc": "A user.",
        "fields": [
            {"name": "id", "type": "string"},
            {"name": "at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
        ],
    }
)


def test_avsc_import_carries_no_idl_extras():
    api = _model(_AVSC, label="user.avsc")
    assert api.paradigm is ApiParadigm.DATA_SCHEMA
    assert api.identity.name == "User"
    assert api.description == "A user."
    assert set(api.extras) == {"avro_root"}
    user = api.type_by_key("com.acme.User")
    assert user.extras == {"avro_kind": "record"}
    assert all("avro_properties" not in f.extras for f in user.fields)


def test_avsc_parse_still_reports_the_avsc_syntax():
    assert parse_avro(_AVSC, source_label="user.avsc").syntax == "avsc"


def test_the_default_output_syntax_is_avsc():
    assert AvroEmitOptions().output_syntax == "avsc"
    result = AvroEmitter().emit(_model(_AVSC, label="user.avsc"))
    assert [f.path for f in result.files] == ["com/acme/User.avsc"]
    assert result.media_type == AvroEmitter.OUTPUT_MEDIA_TYPE


# --- emit -------------------------------------------------------------------------


def test_emitting_a_protocol_writes_the_protocol_form():
    text = _emit_idl(_model(PROTOCOL, label="widgets.avdl"))
    assert '@namespace("com.acme.widgets")' in text
    assert '@version("2")' in text
    assert "protocol WidgetService {" in text
    assert "error NotFound {" in text
    assert "Widget get(string id) throws NotFound;" in text
    assert "void touch(string id) oneway;" in text
    assert "void poke(com.acme.widgets.Widget widget);" in text or "void poke(Widget widget);" in text


def test_emitting_a_schema_only_model_writes_the_namespace_form():
    text = _emit_idl(_model(SCHEMA_ONLY, label="core.avdl"))
    assert text.startswith("/** Shared value types. */\nnamespace com.acme.core;\n")
    assert "protocol " not in text
    assert "enum Colour {" in text


def test_the_emitted_document_path_follows_the_namespace():
    result = AvroEmitter().emit(
        _model(PROTOCOL, label="widgets.avdl"), opts=AvroEmitOptions(output_syntax="avdl")
    )
    assert result.files[0].path == "com/acme/widgets/WidgetService.avdl"


def test_emitted_idl_records_provenance_for_types_and_messages():
    result = AvroEmitter().emit(
        _model(PROTOCOL, label="widgets.avdl"), opts=AvroEmitOptions(output_syntax="avdl")
    )
    pointers = {record.pointer for record in result.provenance}
    assert "/schemas/com.acme.widgets.Widget" in pointers
    assert "/messages/com.acme.widgets.WidgetService.get" in pointers


def test_a_types_only_model_from_another_format_emits_readable_idl():
    """A model with no Avro provenance still has to produce a parseable document."""
    from app.jsonschema_import_source import JsonSchemaImportSource

    schema = json.dumps(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Person",
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name"],
        }
    )
    source = JsonSchemaImportSource()
    api = source.normalize(source.parse(schema, source_label="person.json"), include_raw=False)
    text = _emit_idl(api)
    reparsed = parse_avro_idl(text, source_label="person.avdl")
    assert reparsed.types, "the emitted IDL declares at least one type"


def test_emitted_idl_schemas_validate_with_fastavro():
    document = parse_avro_idl(
        _emit_idl(_model(PROTOCOL, label="widgets.avdl")), source_label="out.avdl"
    )
    # ``error`` is IDL's own keyword for a record; fastavro validates the record shape.
    units = [
        (
            named.name,
            {**named.schema, "type": "record"}
            if named.schema.get("type") == "error"
            else named.schema,
        )
        for named in document.types
    ]
    assert validate_avro_bundle(units) == []


# --- round-trip -------------------------------------------------------------------


def _corpus_idl_entries():
    return [
        entry
        for entry in load_corpus(format="avro-idl")
        if entry.validity_class.value == "valid"
        and (entry.fileset_role is None or entry.fileset_role.value == "root")
    ]


@pytest.mark.parametrize(
    "entry", _corpus_idl_entries(), ids=lambda entry: entry.path
)
def test_generated_idl_round_trips_for_every_corpus_entry(entry):
    """A ``.avdl`` generated from the model of a ``.avdl`` re-imports to the same model."""
    from corpus_adapter_support import build_fileset

    adapter = _adapter()
    if entry.fileset_role is not None:
        native = adapter.parse_fileset(build_fileset(entry), source_label=entry.path)
    else:
        native = adapter.parse(entry.read_text(), source_label=entry.path)
    api = adapter.normalize(native, include_raw=False)

    emitted = _emit_idl(api)
    reimported = adapter.normalize(
        adapter.parse(emitted, source_label="roundtrip.avdl"), include_raw=False
    )
    delta = diff(api, reimported)
    assert delta.identical, f"{entry.path} did not round-trip: {delta.changes}"


def test_generated_idl_is_deterministic():
    api = _model(PROTOCOL, label="widgets.avdl")
    assert _emit_idl(api) == _emit_idl(api)
