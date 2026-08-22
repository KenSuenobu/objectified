"""Unit tests for the Kafka Connect emitter — FMT-5.3 (#5441).

Organised around what the writer promises:

#. **native re-emission** — a model that came from Connect is written back in the
   spellings the reader carried, so ``kafka-connect -> kafka-connect`` is a round-trip
   rather than a re-derivation;
#. **projection** — a model from anywhere else gets Connect primitives from its canonical
   scalars and bundled logical types from its canonical formats;
#. **honest refusal and honest loss** — Connect has no union, no enumeration, no
   reference construct and no validation vocabulary, and each of those is reported rather
   than silently approximated;
#. **the Avro transcode** — the direction FMT-5.3 exists to make possible.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import EmitOptions, get_emitter, load_builtin_emitters
from app.fileset import IntakeFileset
from app.import_source import get_import_source, load_builtin_import_sources
from app.kafka_connect_emitter import (
    KafkaConnectEmitOptions,
    KafkaConnectEmitter,
    KafkaConnectFidelityRulePack,
    validate_connect_schema,
)

load_builtin_import_sources()
load_builtin_emitters()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "kafka-connect"


def _fixture(name: str) -> str:
    return (CORPUS / name).read_text(encoding="utf-8")


def _import(text: str, *, label: str = "schema.json") -> CanonicalApi:
    adapter = get_import_source("kafka-connect")
    return adapter.normalize(adapter.parse(text, source_label=label), include_raw=False)


def _emit(api: CanonicalApi, **options: Any):
    return KafkaConnectEmitter().emit(api, opts=KafkaConnectEmitOptions(**options))


def _only_document(api: CanonicalApi, **options: Any) -> Dict[str, Any]:
    files = _emit(api, **options).files
    assert len(files) == 1, [f.path for f in files]
    return files[0].content


def _member(document: Dict[str, Any], name: str) -> Dict[str, Any]:
    return next(field for field in document["fields"] if field["field"] == name)


def _record(key: str, fields: List[CanonicalField], **kwargs: Any) -> Type:
    return Type(key=key, name=key.rsplit(".", 1)[-1], kind=TypeKind.RECORD, fields=fields, **kwargs)


def _model(*types: Type, identity: str = "Model") -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="test",
        identity=ApiIdentity(name=identity),
        types=list(types),
    )


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def test_emitter_is_registered_under_its_format_key() -> None:
    assert get_emitter("kafka-connect") is KafkaConnectEmitter
    assert KafkaConnectEmitter.paradigm is ApiParadigm.DATA_SCHEMA
    assert KafkaConnectEmitter.multi_file is True


def test_capability_profile_states_what_connect_cannot_do() -> None:
    profile = KafkaConnectEmitter.capability_profile()
    assert profile.operations is False
    assert profile.events is False
    assert profile.unions is False
    assert profile.constraints is False
    assert profile.nullability is True


def test_base_emit_options_are_accepted_and_defaulted() -> None:
    result = KafkaConnectEmitter().emit(_import(_fixture("01-minimal-struct.json")), opts=EmitOptions())
    assert result.files


# ---------------------------------------------------------------------------
# Native re-emission
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture",
    [
        "01-minimal-struct.json",
        "02-typical-order-schema.json",
        "03-composition-nested-and-map.json",
        "04-stress-logical-types-and-parameters.json",
        "05-real-world-change-event-schema.json",
        "06-typical-schema-payload-envelope.json",
    ],
)
def test_every_corpus_schema_round_trips_to_an_identical_canonical_model(fixture: str) -> None:
    original = _import(_fixture(fixture), label=fixture)
    reimported = _import(json.dumps(_only_document(original)), label=fixture)
    assert [t.key for t in reimported.types] == [t.key for t in original.types]
    for before, after in zip(original.types, reimported.types):
        assert before.kind is after.kind
        assert [f.name for f in before.fields] == [f.name for f in after.fields]
        for old_field, new_field in zip(before.fields, after.fields):
            assert old_field.type == new_field.type
            assert old_field.constraints == new_field.constraints
            assert old_field.default == new_field.default


def test_a_connect_source_keeps_its_exact_primitive_widths() -> None:
    document = _only_document(_import(_fixture("04-stress-logical-types-and-parameters.json")))
    for connect_type in ("int8", "int16", "int32", "int64", "float32", "float64", "bytes"):
        assert _member(document, f"f_{connect_type}")["type"] == connect_type


def test_a_decimals_parameters_are_written_back_in_connects_string_spelling() -> None:
    document = _only_document(_import(_fixture("04-stress-logical-types-and-parameters.json")))
    decimal = _member(document, "f_decimal")
    assert decimal["type"] == "bytes"
    assert decimal["name"] == "org.apache.kafka.connect.data.Decimal"
    assert decimal["parameters"] == {"scale": "2", "connect.decimal.precision": "12"}


def test_an_enum_logical_type_is_written_back_with_its_allowed_parameter() -> None:
    document = _only_document(_import(_fixture("04-stress-logical-types-and-parameters.json")))
    enum_field = _member(document, "f_enum_by_parameters")
    assert enum_field["name"] == "io.debezium.data.Enum"
    assert enum_field["parameters"] == {"allowed": "new,paid,shipped,cancelled"}


def test_an_undecoded_logical_type_survives_the_round_trip() -> None:
    text = json.dumps(
        {
            "type": "struct",
            "name": "com.example.Odd",
            "fields": [
                {"field": "geo", "type": "string", "name": "io.example.geo.Point", "optional": True}
            ],
        }
    )
    document = _only_document(_import(text))
    assert _member(document, "geo")["name"] == "io.example.geo.Point"


def test_free_form_parameters_and_versions_are_written_back() -> None:
    document = _only_document(_import(_fixture("04-stress-logical-types-and-parameters.json")))
    assert document["version"] == 7
    assert document["parameters"]["connect.record.origin"] == "corpus"


def test_emit_version_option_suppresses_the_registry_revision() -> None:
    document = _only_document(_import(_fixture("02-typical-order-schema.json")), emit_version=False)
    assert "version" not in document


def test_a_root_schemas_own_optional_flag_survives() -> None:
    adapter = get_import_source("kafka-connect")
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-pipeline-set").iterdir())
    }
    api = adapter.normalize(
        adapter.parse_fileset(IntakeFileset.from_members(members, root="connector.json")),
        include_raw=False,
    )
    files = {file.path: file.content for file in _emit(api).files}
    assert files["logistics.shipments.Value.json"]["optional"] is True
    assert files["logistics.shipments.Key.json"]["optional"] is False


def _pipeline_model() -> CanonicalApi:
    adapter = get_import_source("kafka-connect")
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-pipeline-set").iterdir())
    }
    return adapter.normalize(
        adapter.parse_fileset(IntakeFileset.from_members(members, root="connector.json")),
        include_raw=False,
    )


def test_a_pipeline_set_emits_one_document_per_root_plus_its_connector() -> None:
    paths = [file.path for file in _emit(_pipeline_model()).files]
    assert paths == [
        "connector.json",
        "logistics.shipments.Key.json",
        "logistics.shipments.Value.json",
    ]


def test_the_connector_configuration_is_written_back_verbatim() -> None:
    files = {file.path: file.content for file in _emit(_pipeline_model()).files}
    connector = files["connector.json"]
    assert connector["name"] == "shipments-sink"
    assert connector["config"]["connector.class"].endswith("JdbcSinkConnector")
    assert connector["config"]["transforms.route.regex"] == "logistics\\.(.*)"


def test_a_model_with_no_connector_configuration_gets_no_connector_file() -> None:
    paths = [file.path for file in _emit(_import(_fixture("01-minimal-struct.json"))).files]
    assert paths == ["com.example.Beacon.json"]


def test_a_pipeline_set_round_trips_through_the_emitted_file_set() -> None:
    adapter = get_import_source("kafka-connect")
    result = _emit(_pipeline_model())
    members = {file.path: json.dumps(file.content) for file in result.files}
    reimported = adapter.normalize(
        adapter.parse_fileset(IntakeFileset.from_members(members, root="connector.json")),
        include_raw=False,
    )
    assert reimported.identity.name == "shipments-sink"
    assert [t.key for t in reimported.types] == [t.key for t in _pipeline_model().types]


def test_a_carried_envelope_payload_is_reported_rather_than_paired_by_guess() -> None:
    result = _emit(_import(_fixture("06-typical-schema-payload-envelope.json")))
    assert any(loss.subject == "envelope-payload-dropped" for loss in result.losses)


def test_field_declaration_order_is_restored_from_field_number() -> None:
    """The canonical model sorts fields by key; ``field_number`` is what keeps the order."""
    document = _only_document(_import(_fixture("02-typical-order-schema.json")))
    assert [field["field"] for field in document["fields"]] == [
        "order_id",
        "customer_id",
        "status",
        "placed_at",
        "total_minor_units",
        "currency",
        "note",
        "cancelled",
    ]


def test_emission_is_deterministic() -> None:
    api = _import(_fixture("03-composition-nested-and-map.json"))
    assert json.dumps(_only_document(api)) == json.dumps(_only_document(api))


# ---------------------------------------------------------------------------
# Projection from a foreign model
# ---------------------------------------------------------------------------


def test_canonical_scalars_project_onto_connect_primitives() -> None:
    fields = [
        CanonicalField(key=f"R.{name}", name=name, type=TypeRef(name=name, nullable=False), field_number=i + 1)
        for i, name in enumerate(["integer", "int64", "float", "double", "bool", "string", "bytes", "int8"])
    ]
    document = _only_document(_model(_record("R", fields)))
    emitted = {field["field"]: field["type"] for field in document["fields"]}
    assert emitted == {
        "integer": "int32",
        "int64": "int64",
        "float": "float32",
        "double": "float64",
        "bool": "boolean",
        "string": "string",
        "bytes": "bytes",
        "int8": "int8",
    }


def test_a_canonical_format_picks_the_bundled_logical_type() -> None:
    fields = [
        CanonicalField(
            key="R.when",
            name="when",
            type=TypeRef(name="string", nullable=False),
            field_number=1,
            constraints=Constraints(format="date-time"),
        ),
        CanonicalField(
            key="R.day",
            name="day",
            type=TypeRef(name="string", nullable=False),
            field_number=2,
            constraints=Constraints(format="date"),
        ),
    ]
    document = _only_document(_model(_record("R", fields)))
    assert _member(document, "when") == {
        "field": "when",
        "type": "int64",
        "name": "org.apache.kafka.connect.data.Timestamp",
        "optional": False,
    }
    assert _member(document, "day")["name"] == "org.apache.kafka.connect.data.Date"


def test_a_projected_decimal_derives_a_scale_and_reports_it() -> None:
    field = CanonicalField(
        key="R.amount",
        name="amount",
        type=TypeRef(name="bytes", nullable=False),
        field_number=1,
        constraints=Constraints(format="decimal"),
    )
    result = _emit(_model(_record("R", [field])))
    document = result.files[0].content
    assert _member(document, "amount")["parameters"] == {"scale": "0"}
    assert any(loss.subject == "decimal-scale-derived" for loss in result.losses)


def test_a_decimal_carried_as_text_stays_a_string() -> None:
    field = CanonicalField(
        key="R.amount",
        name="amount",
        type=TypeRef(name="string", nullable=True),
        field_number=1,
        constraints=Constraints(format="decimal"),
    )
    document = _only_document(_model(_record("R", [field])))
    assert _member(document, "amount")["type"] == "string"
    assert "name" not in _member(document, "amount")


def test_an_unsigned_64_bit_scalar_is_widened_and_reported() -> None:
    field = CanonicalField(
        key="R.n", name="n", type=TypeRef(name="uint64", nullable=False), field_number=1
    )
    result = _emit(_model(_record("R", [field])))
    assert _member(result.files[0].content, "n")["type"] == "int64"
    assert any(loss.subject == "unsigned-widened" for loss in result.losses)


def test_an_any_valued_scalar_is_written_as_a_string_and_reported() -> None:
    field = CanonicalField(
        key="R.blob", name="blob", type=TypeRef(name="any", nullable=True), field_number=1
    )
    result = _emit(_model(_record("R", [field])))
    assert _member(result.files[0].content, "blob")["type"] == "string"
    assert any(loss.subject == "any-scalar-approximated" for loss in result.losses)


def test_an_enum_type_is_flattened_to_a_string_and_reported() -> None:
    enum = Type(key="Status", name="Status", kind=TypeKind.ENUM)
    field = CanonicalField(
        key="R.status", name="status", type=TypeRef(name="Status", nullable=False), field_number=1
    )
    result = _emit(_model(_record("R", [field]), enum))
    assert _member(result.files[0].content, "status")["type"] == "string"
    assert any(loss.subject == "enum-flattened" for loss in result.losses)


def test_a_nullable_only_union_becomes_an_optional_member() -> None:
    union = Type(key="MaybeString", name="MaybeString", kind=TypeKind.UNION, union_members=["null", "string"])
    field = CanonicalField(
        key="R.value", name="value", type=TypeRef(name="MaybeString", nullable=False), field_number=1
    )
    document = _only_document(_model(_record("R", [field]), union))
    assert _member(document, "value")["type"] == "string"
    assert _member(document, "value")["optional"] is True


def test_a_real_union_is_approximated_and_reported() -> None:
    union = Type(
        key="Either", name="Either", kind=TypeKind.UNION, union_members=["string", "int64"]
    )
    field = CanonicalField(
        key="R.value", name="value", type=TypeRef(name="Either", nullable=False), field_number=1
    )
    result = _emit(_model(_record("R", [field]), union))
    assert _member(result.files[0].content, "value")["type"] == "string"
    assert any(loss.subject == "union-flattened" for loss in result.losses)


def test_a_recursive_record_is_cut_rather_than_expanded_forever() -> None:
    node = _record(
        "Node",
        [
            CanonicalField(key="Node.id", name="id", type=TypeRef(name="string", nullable=False), field_number=1),
            CanonicalField(key="Node.next", name="next", type=TypeRef(name="Node", nullable=True), field_number=2),
        ],
    )
    result = _emit(_model(node))
    document = result.files[0].content
    assert _member(document, "next")["type"] == "string"
    assert any(loss.subject == "recursive-type-cut" for loss in result.losses)


def test_validation_constraints_are_dropped_and_reported() -> None:
    field = CanonicalField(
        key="R.name",
        name="name",
        type=TypeRef(name="string", nullable=False),
        field_number=1,
        constraints=Constraints(min_length=1, max_length=64, pattern="^[a-z]+$"),
    )
    result = _emit(_model(_record("R", [field])))
    dropped = [loss for loss in result.losses if loss.subject == "constraints-dropped"]
    assert dropped and "max_length" in dropped[0].detail and "pattern" in dropped[0].detail


def test_a_model_with_no_record_type_is_refused() -> None:
    scalar = Type(key="Bare", name="Bare", kind=TypeKind.SCALAR)
    with pytest.raises(ValueError) as excinfo:
        _emit(_model(scalar))
    assert "at least one record type" in str(excinfo.value)


def test_only_unreferenced_records_become_documents() -> None:
    inner = _record(
        "Inner",
        [CanonicalField(key="Inner.a", name="a", type=TypeRef(name="string", nullable=False), field_number=1)],
    )
    outer = _record(
        "Outer",
        [CanonicalField(key="Outer.inner", name="inner", type=TypeRef(name="Inner", nullable=False), field_number=1)],
    )
    paths = [file.path for file in _emit(_model(inner, outer)).files]
    assert paths == ["Outer.json"]


def test_the_namespace_option_qualifies_an_unqualified_record() -> None:
    record = _record(
        "Bare",
        [CanonicalField(key="Bare.a", name="a", type=TypeRef(name="string", nullable=False), field_number=1)],
    )
    document = _only_document(_model(record), namespace="com.example")
    assert document["name"] == "com.example.Bare"


def test_operations_are_dropped_with_a_types_only_verdict() -> None:
    operation = Operation(
        key="S.Do",
        name="Do",
        kind=OperationKind.REQUEST_RESPONSE,
        streaming=StreamingMode.NONE,
        messages=[Message(key="S.Do#request", role=MessageRole.REQUEST)],
    )
    pack = KafkaConnectFidelityRulePack(KafkaConnectEmitter.capability_profile(), "Kafka Connect")
    verdict = pack.operation_verdict(operation)
    assert "types-only" in verdict.message


def test_an_enum_type_verdict_is_a_drop_rather_than_the_profile_default() -> None:
    pack = KafkaConnectFidelityRulePack(KafkaConnectEmitter.capability_profile(), "Kafka Connect")
    verdict = pack.type_verdict(Type(key="Status", name="Status", kind=TypeKind.ENUM))
    assert "no enumeration type" in verdict.message
    record_verdict = pack.type_verdict(_record("R", []))
    assert "no enumeration type" not in record_verdict.message


def test_an_api_with_operations_still_emits_its_types() -> None:
    api = _model(
        _record(
            "R", [CanonicalField(key="R.a", name="a", type=TypeRef(name="string", nullable=False), field_number=1)]
        )
    )
    api.services = [Service(key="S", name="S", operations=[])]
    assert [file.path for file in _emit(api).files] == ["R.json"]


# ---------------------------------------------------------------------------
# Self-validation
# ---------------------------------------------------------------------------


def test_validate_connect_schema_accepts_what_the_emitter_writes() -> None:
    assert validate_connect_schema(_only_document(_import(_fixture("01-minimal-struct.json")))) == []


def test_validate_connect_schema_rejects_a_document_the_reader_would_refuse() -> None:
    errors = validate_connect_schema({"type": "record", "name": "X", "fields": []})
    assert errors and "not readable" in errors[0]


# ---------------------------------------------------------------------------
# The Avro transcode (acceptance criterion 3)
# ---------------------------------------------------------------------------


def test_an_avro_record_transcodes_into_a_readable_connect_schema() -> None:
    avro = get_import_source("avro")
    api = avro.normalize(
        avro.parse(
            json.dumps(
                {
                    "type": "record",
                    "name": "Order",
                    "namespace": "com.example.orders",
                    "fields": [
                        {"name": "order_id", "type": "string"},
                        {"name": "placed_at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
                        {
                            "name": "total",
                            "type": {
                                "type": "bytes",
                                "logicalType": "decimal",
                                "precision": 12,
                                "scale": 2,
                            },
                        },
                        {"name": "cancelled", "type": "boolean"},
                    ],
                }
            )
        ),
        include_raw=False,
    )
    document = _only_document(api)
    assert document["name"] == "com.example.orders.Order"
    assert _member(document, "order_id")["type"] == "string"
    assert _member(document, "placed_at")["name"] == "org.apache.kafka.connect.data.Timestamp"
    total = _member(document, "total")
    assert total["type"] == "bytes"
    assert total["name"] == "org.apache.kafka.connect.data.Decimal"
    assert total["parameters"] == {"scale": "2", "connect.decimal.precision": "12"}
    assert _member(document, "cancelled")["type"] == "boolean"
    # The premise of the transcode: what came out reads back in.
    reimported = _import(json.dumps(document))
    assert [t.key for t in reimported.types] == ["com.example.orders.Order"]


def test_a_connect_schema_transcodes_into_an_avro_schema_with_its_logical_types() -> None:
    api = _import(
        json.dumps(
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
                    {
                        "field": "total",
                        "type": "bytes",
                        "name": "org.apache.kafka.connect.data.Decimal",
                        "optional": False,
                        "parameters": {"scale": "2", "connect.decimal.precision": "12"},
                    },
                ],
            }
        )
    )
    avro_result = get_emitter("avro")().emit(api)
    schema = avro_result.files[0].content
    by_name = {field["name"]: field for field in schema["fields"]}
    assert by_name["order_id"]["type"] == "string"
    assert by_name["placed_at"]["type"]["logicalType"] == "timestamp-millis"
    total = by_name["total"]["type"]
    assert total["logicalType"] == "decimal"
    assert (total["precision"], total["scale"]) == (12, 2)


# ---------------------------------------------------------------------------
# extras ↔ emitter symmetry
# ---------------------------------------------------------------------------

#: Extras keys the reader documents that the writer deliberately does not consume, with
#: the reason. A key may only sit here because Connect's schema form has nowhere to put it
#: — never because writing it back was forgotten.
READER_ONLY_EXTRAS = {
    "kafka_connect_payload": (
        "a sample record is data, not structure, and the model does not record which "
        "schema each record belongs to"
    ),
    "connect_kind": "derived from the canonical TypeKind on the way out, not read back",
}


def _documented_extras_keys() -> set[str]:
    """Parse the ``connect_*`` namespace table out of the normalizer's docstring.

    The table is an RST simple table; only the rows between its two full-width rules are
    read, so prose that happens to start with a literal is never mistaken for a row.
    """
    from app import kafka_connect_normalizer

    doc = (kafka_connect_normalizer.__doc__ or "").splitlines()
    rules = [i for i, line in enumerate(doc) if line.strip().startswith("====")]
    assert len(rules) == 3, "the extras namespace table lost one of its three rules"
    keys: set[str] = set()
    for line in doc[rules[1] + 1 : rules[2]]:
        head = line.strip().split("  ")[0]
        if not head.startswith("``"):
            continue
        for token in head.split("/"):
            token = token.strip().strip("`").strip()
            if token:
                keys.add(token)
    return keys


def _extras_keys_the_reader_writes() -> set[str]:
    """Collect every extras key the reader actually emits across the shipped corpus."""
    adapter = get_import_source("kafka-connect")
    keys: set[str] = set()
    models = [
        adapter.normalize(adapter.parse(path.read_text(encoding="utf-8"), source_label=path.name))
        for path in sorted(CORPUS.glob("*.json"))
    ]
    models.append(_pipeline_model())
    for model in models:
        keys.update(model.extras)
        for type_ in model.types:
            keys.update(type_.extras)
            for field in type_.fields:
                keys.update(field.extras)
    return keys


def test_every_extras_key_the_reader_writes_is_documented() -> None:
    """The docstring table is the contract; an undocumented key is a silent one."""
    assert _extras_keys_the_reader_writes() <= _documented_extras_keys()


def test_every_documented_extras_key_is_consumed_by_the_writer_or_declared_reader_only() -> None:
    """The symmetry rule: what the reader parks, the writer restores — or says why not."""
    from app import kafka_connect_normalizer

    source = Path(__file__).resolve().parents[1] / "src" / "app" / "kafka_connect_emitter.py"
    emitter_text = source.read_text(encoding="utf-8")
    # A key reaches the writer either as a literal or through the shared constant the
    # normalizer publishes for it; both count as consumed.
    known = {key for key in _documented_extras_keys() if f'"{key}"' in emitter_text}
    for name in dir(kafka_connect_normalizer):
        value = getattr(kafka_connect_normalizer, name)
        if name.isupper() and isinstance(value, str) and name in emitter_text:
            known.add(value)
    unconsumed = _documented_extras_keys() - known
    assert unconsumed <= set(READER_ONLY_EXTRAS), sorted(unconsumed - set(READER_ONLY_EXTRAS))


# ---------------------------------------------------------------------------
# Bundle paths
# ---------------------------------------------------------------------------


def test_a_hostile_type_name_cannot_escape_the_bundle() -> None:
    """A canonical type name is source text and is about to become a filename."""
    record = Type(
        key="../../etc/passwd",
        name="../../etc/passwd",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="x.a", name="a", type=TypeRef(name="string", nullable=False), field_number=1
            )
        ],
    )
    (path,) = [file.path for file in _emit(_model(record)).files]
    assert "/" not in path and ".." not in path
    assert path.endswith(".json")


def test_two_records_whose_names_sanitize_alike_get_distinct_paths() -> None:
    def record(key: str) -> Type:
        return Type(
            key=key,
            name=key,
            kind=TypeKind.RECORD,
            fields=[
                CanonicalField(
                    key=f"{key}.a",
                    name="a",
                    type=TypeRef(name="string", nullable=False),
                    field_number=1,
                )
            ],
        )

    paths = [file.path for file in _emit(_model(record("a/b"), record("a:b"))).files]
    assert len(set(paths)) == 2
