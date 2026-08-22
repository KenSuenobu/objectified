"""Unit tests for the Kafka Connect ImportSource — FMT-5.3 (#5441).

Organised around the ticket's acceptance criteria:

#. a Connect schema imports (and, with :mod:`tests.test_kafka_connect_emitter`,
   round-trips);
#. logical types map to canonical formats and constraints, never to opaque strings;
#. a Connect schema and its Avro equivalent produce comparable canonical models, which
   is what makes the transcode a projection rather than a translation;
#. the shipped corpus covers a flat schema, a nested schema with a map, and a malformed
   one — asserted against the fixtures directly, so the suite fails if one is deleted
   rather than only if one changes;
#. the capability registry declares what is modelled and what is carried-but-not-modelled.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from app.canonical_model import ApiParadigm, TypeKind
from app.fileset import IntakeFileset
from app.format_capability_registry import ProjectionCoverage, capability_for
from app.format_version_coverage import VersionSupport, version_coverage_for
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)
from app.kafka_connect_import_source import (
    KAFKA_CONNECT_CAPABILITIES,
    KafkaConnectImportSource,
)
from app.kafka_connect_normalizer import KAFKA_CONNECT_EXTRAS_KEY
from app.kafka_connect_parser import (
    MAX_SCHEMA_DEPTH,
    is_connect_connector_config,
    is_kafka_connect,
    is_kafka_connect_document,
    parse_kafka_connect,
    parse_kafka_connect_fileset,
)
from app.kafka_connect_schema import (
    CONNECT_TO_CANONICAL_SCALAR,
    LIMIT_DETAILS,
    LOGICAL_TYPES,
    ConnectParseError,
    LimitRecorder,
    logical_type_for_format,
)

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "kafka-connect"

#: The smallest schema that exercises the struct envelope and two typed members.
MINIMAL = json.dumps(
    {
        "type": "struct",
        "name": "com.example.Ping",
        "optional": False,
        "fields": [
            {"field": "id", "type": "string", "optional": False},
            {"field": "seen_at", "type": "int64", "optional": True},
        ],
    }
)


def _adapter() -> KafkaConnectImportSource:
    source = get_import_source("kafka-connect")
    assert isinstance(source, KafkaConnectImportSource)
    return source


def _fixture(name: str) -> str:
    return (CORPUS / name).read_text(encoding="utf-8")


def _import(text: str, *, label: str = "schema.json"):
    adapter = _adapter()
    return adapter.normalize(adapter.parse(text, source_label=label))


def _field(model, type_key: str, name: str):
    type_ = next(t for t in model.types if t.key == type_key)
    return next(f for f in type_.fields if f.name == name)


# ---------------------------------------------------------------------------
# Registration and detection
# ---------------------------------------------------------------------------


def test_adapter_is_registered_with_a_data_schema_paradigm() -> None:
    adapter = _adapter()
    assert adapter.key == "kafka-connect"
    assert adapter.paradigm is ApiParadigm.DATA_SCHEMA
    assert "kafka-connect" in adapter.formats
    assert adapter.file_extensions[-1] == ".json"


def test_detects_a_struct_schema_by_its_field_key() -> None:
    result = _adapter().detect(DetectionInput(text=MINIMAL, filename="value.json"))
    assert result.matched
    assert result.format == "kafka-connect"
    assert result.confidence >= 0.85


def test_detects_the_schema_payload_envelope() -> None:
    result = _adapter().detect(
        DetectionInput(text=_fixture("06-typical-schema-payload-envelope.json"))
    )
    assert result.matched
    assert "envelope" in (result.reason or "")


def test_detects_a_connector_configuration() -> None:
    result = _adapter().detect(
        DetectionInput(text=_fixture("07-pipeline-set/connector.json"))
    )
    assert result.matched
    assert result.confidence >= 0.85
    assert "connector" in (result.reason or "")


def test_does_not_claim_an_avro_schema() -> None:
    """Avro keys a member ``name``; Connect keys it ``field``. That is the whole marker."""
    avro = _fixture("negative/04-wrong-format-avro.avsc")
    assert not is_kafka_connect(avro)
    assert not _adapter().detect(DetectionInput(text=avro, filename="x.avsc")).matched


def test_does_not_claim_a_bare_json_schema_object() -> None:
    assert not is_kafka_connect(json.dumps({"type": "object", "properties": {}}))
    assert not is_kafka_connect(json.dumps({"type": "string"}))


def test_detection_never_raises_on_unparseable_text() -> None:
    for text in ("", "   ", "{", "not json at all", "\x00\x00"):
        assert _adapter().detect(DetectionInput(text=text)).matched is False


def test_is_kafka_connect_document_accepts_all_three_surfaces() -> None:
    assert is_kafka_connect_document(json.loads(MINIMAL))
    assert is_kafka_connect_document({"schema": json.loads(MINIMAL), "payload": {}})
    assert is_connect_connector_config({"name": "s", "config": {"connector.class": "X"}})
    assert not is_connect_connector_config({"name": "s", "config": {"unrelated": "1"}})


def test_the_avro_adapter_still_wins_its_own_document() -> None:
    """Detection must not regress the neighbour it is most easily confused with."""
    best = detect_import_source(
        DetectionInput(text=_fixture("negative/04-wrong-format-avro.avsc"), filename="a.avsc")
    )
    assert best is not None
    assert best[0].key == "avro"


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


def test_a_struct_becomes_one_record_keyed_by_its_schema_name() -> None:
    model = _import(MINIMAL)
    assert model.paradigm is ApiParadigm.DATA_SCHEMA
    assert model.format == "kafka-connect"
    assert [t.key for t in model.types] == ["com.example.Ping"]
    record = model.types[0]
    assert record.kind is TypeKind.RECORD
    assert record.namespace == "com.example"
    assert {f.name for f in record.fields} == {"id", "seen_at"}


def test_optional_becomes_nullability_and_declaration_order_is_kept() -> None:
    model = _import(_fixture("02-typical-order-schema.json"))
    record = model.types[0]
    assert _field(model, record.key, "order_id").type.nullable is False
    assert _field(model, record.key, "note").type.nullable is True
    ordered = sorted(record.fields, key=lambda f: f.field_number or 0)
    assert [f.name for f in ordered][:3] == ["order_id", "customer_id", "status"]


def test_defaults_survive_including_a_false_and_a_null_one() -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    root = "com.example.stress.AllTypes"
    boolean = _field(model, root, "f_boolean")
    assert boolean.default is True and boolean.extras["has_default"] is True
    nullable_struct = _field(model, root, "f_optional_struct_with_default")
    assert nullable_struct.default is None
    assert nullable_struct.extras["has_default"] is True


def test_nested_structs_arrays_and_maps_are_modelled() -> None:
    model = _import(_fixture("03-composition-nested-and-map.json"))
    keys = {t.key for t in model.types}
    assert {"com.example.orders.Customer", "com.example.orders.Address"} <= keys
    lines = _field(model, "com.example.orders.OrderDetail", "lines")
    assert lines.type.is_list()
    assert lines.type.item is not None
    assert lines.type.item.name == "com.example.orders.OrderLine"
    attributes = _field(model, "com.example.orders.OrderDetail", "attributes")
    map_type = next(t for t in model.types if t.key == attributes.type.name)
    assert map_type.kind is TypeKind.MAP
    assert map_type.key_type is not None and map_type.key_type.name == "string"
    assert map_type.value_type is not None and map_type.value_type.name == "string"


def test_two_fields_naming_the_same_struct_share_one_canonical_type() -> None:
    """A change-event envelope's ``before``/``after`` pair is one record, not two."""
    model = _import(_fixture("05-real-world-change-event-schema.json"))
    root = "example.inventory.customers.Envelope"
    before = _field(model, root, "before")
    after = _field(model, root, "after")
    assert before.type.name == after.type.name == "example.inventory.customers.Value"
    assert sum(1 for t in model.types if t.key == before.type.name) == 1


def test_every_connect_primitive_maps_to_its_exact_canonical_width() -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    root = "com.example.stress.AllTypes"
    for connect_type, canonical in CONNECT_TO_CANONICAL_SCALAR.items():
        field = _field(model, root, f"f_{connect_type}")
        assert field.type.name == canonical, connect_type
        assert field.extras["connect_type"] == connect_type


def test_an_envelope_imports_its_schema_and_carries_the_payload_verbatim() -> None:
    model = _import(_fixture("06-typical-schema-payload-envelope.json"))
    assert model.identity.name == "Shipment"
    assert model.extras[KAFKA_CONNECT_EXTRAS_KEY]["envelope"] is True
    payload = model.extras["kafka_connect_payload"][0]
    assert payload["shipment_id"] == "SHP-000412"


# ---------------------------------------------------------------------------
# Logical types → canonical constraints (acceptance criterion 2)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field_name", "expected_scalar", "expected_format"),
    [
        ("f_decimal", "bytes", "decimal"),
        ("f_date", "string", "date"),
        ("f_time", "string", "time"),
        ("f_timestamp", "string", "date-time"),
        ("f_debezium_zoned_timestamp", "string", "date-time"),
    ],
)
def test_a_logical_type_becomes_a_canonical_format_not_a_string(
    field_name: str, expected_scalar: str, expected_format: str
) -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    field = _field(model, "com.example.stress.AllTypes", field_name)
    assert field.type.name == expected_scalar
    assert field.constraints is not None
    assert field.constraints.format == expected_format


def test_a_decimals_digits_are_read_out_of_its_parameters() -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    field = _field(model, "com.example.stress.AllTypes", "f_decimal")
    assert field.extras["scale"] == 2
    assert field.extras["precision"] == 12
    # The parameters a logical type consumed are not carried a second time.
    assert "connect_parameters" not in field.extras


def test_an_enum_logical_types_allowed_values_become_an_enum_constraint() -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    field = _field(model, "com.example.stress.AllTypes", "f_enum_by_parameters")
    assert field.constraints is not None
    assert field.constraints.enum == ["new", "paid", "shipped", "cancelled"]


def test_an_unrecognised_logical_type_keeps_its_base_type_and_is_recorded() -> None:
    text = json.dumps(
        {
            "type": "struct",
            "name": "com.example.Odd",
            "fields": [
                {
                    "field": "geo",
                    "type": "string",
                    "name": "io.example.geo.Point",
                    "optional": True,
                }
            ],
        }
    )
    model = _import(text)
    field = _field(model, "com.example.Odd", "geo")
    assert field.type.name == "string"
    assert field.extras["connect_logical_type"] == "io.example.geo.Point"
    limits = {
        limit["construct"]
        for limit in model.extras[KAFKA_CONNECT_EXTRAS_KEY]["capability_limits"]
    }
    assert "kafka-connect.unknown_logical_type" in limits


def test_a_decimal_with_an_unreadable_scale_keeps_the_parameter_verbatim() -> None:
    text = json.dumps(
        {
            "type": "struct",
            "name": "com.example.Odd",
            "fields": [
                {
                    "field": "amount",
                    "type": "bytes",
                    "name": "org.apache.kafka.connect.data.Decimal",
                    "optional": False,
                    "parameters": {"scale": "two", "connect.decimal.precision": "9"},
                }
            ],
        }
    )
    field = _field(_import(text), "com.example.Odd", "amount")
    assert field.extras["precision"] == 9
    assert "scale" not in field.extras
    assert field.extras["connect_parameters"] == {"scale": "two"}


def test_logical_type_for_format_resolves_the_bundled_names_only() -> None:
    assert logical_type_for_format("date-time", "string").name.endswith(".Timestamp")
    assert logical_type_for_format("decimal", "bytes").name.endswith(".Decimal")
    # A decimal carried as text is a formatted string, not Connect's byte-backed Decimal.
    assert logical_type_for_format("decimal", "string") is None
    assert logical_type_for_format("uuid", "string") is None


def test_every_declared_logical_type_declares_a_real_connect_base_type() -> None:
    for name, logical in LOGICAL_TYPES.items():
        assert logical.name == name
        assert logical.base_type in CONNECT_TO_CANONICAL_SCALAR


# ---------------------------------------------------------------------------
# Comparability with Avro (the transcode's premise)
# ---------------------------------------------------------------------------


AVRO_TWIN = json.dumps(
    {
        "type": "record",
        "name": "Order",
        "namespace": "com.example.orders",
        "fields": [
            {"name": "order_id", "type": "string"},
            {"name": "placed_at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
            {"name": "cancelled", "type": "boolean"},
        ],
    }
)

CONNECT_TWIN = json.dumps(
    {
        "type": "struct",
        "name": "com.example.orders.Order",
        "optional": False,
        "fields": [
            {"field": "order_id", "type": "string", "optional": False},
            {
                "field": "placed_at",
                "type": "int64",
                "name": "org.apache.kafka.connect.data.Timestamp",
                "optional": False,
            },
            {"field": "cancelled", "type": "boolean", "optional": False},
        ],
    }
)


def test_a_connect_schema_and_its_avro_twin_produce_comparable_models() -> None:
    """The premise of the FMT-5.3 transcode: same record, same fields, same types.

    Compared field by field rather than by fingerprint because the two readers legitimately
    record different ``extras`` — that is what each format's writer needs to restore its own
    spelling. What must agree is everything a *consumer* of the canonical model reads.
    """
    avro_adapter = get_import_source("avro")
    avro_model = avro_adapter.normalize(avro_adapter.parse(AVRO_TWIN))
    connect_model = _import(CONNECT_TWIN)

    assert [t.key for t in avro_model.types] == [t.key for t in connect_model.types]

    def shape(model) -> Dict[str, Any]:
        record = model.types[0]
        return {
            field.name: (
                field.type.name,
                field.type.nullable,
                field.constraints.format if field.constraints else None,
            )
            for field in record.fields
        }

    assert shape(avro_model) == shape(connect_model)


# ---------------------------------------------------------------------------
# File sets
# ---------------------------------------------------------------------------


def _pipeline_fileset(root: str = "connector.json") -> IntakeFileset:
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-pipeline-set").iterdir())
    }
    return IntakeFileset.from_members(members, root=root)


def test_a_pipeline_set_imports_every_schema_and_names_itself_after_the_connector() -> None:
    adapter = _adapter()
    model = adapter.normalize(adapter.parse_fileset(_pipeline_fileset()))
    assert model.identity.name == "shipments-sink"
    report = model.extras[KAFKA_CONNECT_EXTRAS_KEY]
    assert report["roots"] == ["logistics.shipments.Key", "logistics.shipments.Value"]
    assert model.extras["kafka_connect_connector"]["config"]["pk.mode"] == "record_key"


def test_a_set_of_schemas_with_no_connector_composes_too() -> None:
    document = parse_kafka_connect_fileset(
        {"a.json": MINIMAL, "b.json": _fixture("01-minimal-struct.json")},
        root="a.json",
    )
    assert len(document.roots) == 2
    assert document.connector is None
    assert document.source_files == ("a.json", "b.json")


def test_a_set_with_two_connector_configurations_is_refused() -> None:
    config = _fixture("07-pipeline-set/connector.json")
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect_fileset(
            {"a.json": config, "b.json": config, "c.json": MINIMAL}, root="a.json"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "one pipeline" in str(excinfo.value)


def test_a_set_carrying_only_a_connector_configuration_is_refused() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect_fileset(
            {"connector.json": _fixture("07-pipeline-set/connector.json")},
            root="connector.json",
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "carries no schema" in str(excinfo.value)


def test_a_missing_fileset_root_is_refused() -> None:
    adapter = _adapter()
    fileset = IntakeFileset(root="absent.json", members={"a.json": MINIMAL})
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(fileset)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


# ---------------------------------------------------------------------------
# Refusals and error grounding
# ---------------------------------------------------------------------------


def test_a_bare_connector_configuration_is_refused_with_guidance() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(_fixture("07-pipeline-set/connector.json"), source_label="c.json")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "key and value schemas" in str(excinfo.value)


def test_an_avro_document_is_refused_without_a_code() -> None:
    """A code-less refusal is what lets the pipeline report ``FORMAT_MISMATCH``."""
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(_fixture("negative/04-wrong-format-avro.avsc"), source_label="a.avsc")
    assert excinfo.value.code is None
    assert "Avro's spelling" in str(excinfo.value)


def test_a_truncated_document_is_classified_by_parser_state() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(_fixture("negative/03-truncated-mid-field.json"), source_label="t.json")
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_syntax_error_carries_no_code_so_the_pipeline_classifies_it() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(_fixture("negative/01-syntactic-missing-brace.json"))
    assert excinfo.value.code is None


@pytest.mark.parametrize(
    "fixture",
    ["negative/02-semantic-struct-without-fields.json", "negative/06-semantic-field-without-type.json"],
)
def test_semantic_refusals_carry_the_semantic_code(fixture: str) -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(_fixture(fixture), source_label=fixture)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_an_empty_fields_array_is_refused() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(json.dumps({"type": "struct", "name": "X", "fields": []}))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_duplicate_field_name_is_refused() -> None:
    text = json.dumps(
        {
            "type": "struct",
            "name": "X",
            "fields": [
                {"field": "a", "type": "string"},
                {"field": "a", "type": "int32"},
            ],
        }
    )
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(text)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "twice" in str(excinfo.value)


@pytest.mark.parametrize(
    ("node", "needle"),
    [
        ({"type": "array", "optional": False}, "no `items`"),
        ({"type": "map", "keys": {"type": "string"}}, "both `keys` and `values`"),
        ({"type": "string", "parameters": []}, "must be an object"),
    ],
)
def test_container_members_must_declare_what_they_contain(
    node: Dict[str, Any], needle: str
) -> None:
    text = json.dumps({"type": "struct", "name": "X", "fields": [{"field": "f", **node}]})
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(text)
    assert needle in str(excinfo.value)


def test_a_non_struct_root_is_refused() -> None:
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(json.dumps({"type": "string", "optional": True}))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "not a `struct`" in str(excinfo.value)


def test_a_pathologically_deep_schema_is_bounded_rather_than_recursing() -> None:
    node: Dict[str, Any] = {"type": "string", "optional": True}
    for _ in range(MAX_SCHEMA_DEPTH + 5):
        node = {"type": "array", "optional": False, "items": node}
    text = json.dumps({"type": "struct", "name": "X", "fields": [{"field": "f", **node}]})
    with pytest.raises(ConnectParseError) as excinfo:
        parse_kafka_connect(text)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_normalize_rejects_a_foreign_ast() -> None:
    with pytest.raises(ImportSourceError):
        _adapter().normalize({"type": "struct"})


# ---------------------------------------------------------------------------
# Declared limits, provenance and the capability registry
# ---------------------------------------------------------------------------


def test_the_limit_recorder_refuses_a_construct_outside_the_vocabulary() -> None:
    recorder = LimitRecorder()
    with pytest.raises(KeyError):
        recorder.record("kafka-connect.not-a-real-limit")


def test_the_limit_recorder_counts_occurrences_and_dedupes_locations() -> None:
    recorder = LimitRecorder()
    recorder.record("kafka-connect.schema_version", location="A")
    recorder.record("kafka-connect.schema_version", location="A")
    recorder.record("kafka-connect.schema_version", location="B")
    (limit,) = recorder.limits()
    assert limit.count == 3
    assert limit.locations == ("A", "B")


def test_the_adapters_unsupported_constructs_are_exactly_the_limit_vocabulary() -> None:
    assert KAFKA_CONNECT_CAPABILITIES.unsupported == sorted(LIMIT_DETAILS)


def test_every_declared_limit_is_reachable_from_the_shipped_corpus() -> None:
    """A limit nobody can trigger is a claim, not a capability statement."""
    adapter = _adapter()
    seen: set[str] = set()
    for path in sorted(CORPUS.glob("*.json")):
        model = adapter.normalize(adapter.parse(path.read_text(encoding="utf-8"), source_label=path.name))
        seen.update(
            limit["construct"]
            for limit in model.extras[KAFKA_CONNECT_EXTRAS_KEY]["capability_limits"]
        )
    model = adapter.normalize(adapter.parse_fileset(_pipeline_fileset()))
    seen.update(
        limit["construct"] for limit in model.extras[KAFKA_CONNECT_EXTRAS_KEY]["capability_limits"]
    )
    # Two limits are deliberately unreachable from the shipped fixtures, and both for the
    # same reason: a fixture that triggered them would misrepresent the format. Every
    # struct a converter writes is named, and every logical type the corpus README lists is
    # one this reader decodes — so an anonymous struct and an undecoded name are authored
    # here rather than smuggled into the corpus.
    for hand_authored in (
        {"type": "struct", "fields": [{"field": "id", "type": "string", "optional": False}]},
        {
            "type": "struct",
            "name": "com.example.Odd",
            "fields": [
                {
                    "field": "geo",
                    "type": "string",
                    "name": "io.example.geo.Point",
                    "optional": True,
                }
            ],
        },
    ):
        model = adapter.normalize(adapter.parse(json.dumps(hand_authored)))
        seen.update(
            limit["construct"]
            for limit in model.extras[KAFKA_CONNECT_EXTRAS_KEY]["capability_limits"]
        )
    assert seen == set(LIMIT_DETAILS)


def test_an_anonymous_struct_is_keyed_by_position_and_recorded() -> None:
    model = _import(
        json.dumps(
            {
                "type": "struct",
                "fields": [
                    {
                        "field": "inner",
                        "type": "struct",
                        "optional": True,
                        "fields": [{"field": "a", "type": "string", "optional": False}],
                    }
                ],
            }
        )
    )
    keys = {t.key for t in model.types}
    assert "Schema" in keys and "Schema.inner" in keys
    inner = next(t for t in model.types if t.key == "Schema.inner")
    assert inner.extras["connect_anonymous"] is True


def test_only_the_readers_own_record_is_registered_as_provenance() -> None:
    assert KAFKA_CONNECT_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS
    for carried in ("connect_type", "connect_logical_type", "connect_parameters"):
        assert carried not in PROVENANCE_EXTRA_KEYS


def test_declared_limits_reach_the_coverage_ledger_as_partially_mapped_rows() -> None:
    model = _import(_fixture("04-stress-logical-types-and-parameters.json"))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(model, adapter_key="kafka-connect", options={})
    )
    rows = {
        row.source_construct: row
        for row in page.coverage
        if row.source_construct.startswith("kafka-connect.")
    }
    recorded = {
        limit["construct"]
        for limit in model.extras[KAFKA_CONNECT_EXTRAS_KEY]["capability_limits"]
    }
    assert set(rows) == recorded
    assert rows, "no Kafka Connect limits reached the ledger"
    for row in rows.values():
        assert row.coverage is CoverageClass.PARTIALLY_MAPPED
        assert row.document_scoped is True


def test_the_capability_registry_declares_the_same_limit_vocabulary() -> None:
    capability = capability_for("kafka-connect")
    projection = capability.canonical_projection
    assert projection.coverage is ProjectionCoverage.PARTIAL
    assert sorted(projection.dropped_constructs) == sorted(LIMIT_DETAILS)


def test_version_coverage_declares_one_ungated_read_and_one_ungated_write() -> None:
    coverage = version_coverage_for("kafka-connect")
    assert coverage.declared
    assert [row.support for row in coverage.reads] == [VersionSupport.UNGATED]
    assert [row.support for row in coverage.writes] == [VersionSupport.UNGATED]
    assert all(row.note for row in coverage.reads + coverage.writes)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_two_imports_of_the_same_document_fingerprint_identically() -> None:
    first = _import(_fixture("03-composition-nested-and-map.json"), label="a.json")
    second = _import(_fixture("03-composition-nested-and-map.json"), label="a.json")
    assert canonical_fingerprint(first) == canonical_fingerprint(second)
