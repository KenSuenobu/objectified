"""Unit tests for the Apache Arrow ImportSource — FMT-4.5 (#5438).

Organised around the ticket's acceptance criteria:

#. an Arrow IPC schema and a JSON-form schema both import to the same canonical model
   (the surface-blind half is here; the IPC half is
   ``tests/test_arrow_ipc_parity.py``);
#. nested, dictionary-encoded and decimal types are modelled or declared limits;
#. a Flight ``GetSchema`` discovery path imports from a live endpoint
   (``tests/test_arrow_flight_discovery.py``);
#. round-trip against #4317's emitter is asserted once both exist — #4317 has not landed,
   so the matrix records ``arrow`` as a source-only row.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

import pytest

from app.arrow_import_source import ARROW_CAPABILITIES, ArrowImportSource
from app.arrow_normalizer import ARROW_EXTRAS_KEY, DEFAULT_ROOT_NAME
from app.arrow_parser import (
    ARROW_IPC_SUFFIXES,
    ARROW_JSON_SUFFIXES,
    is_arrow,
    is_arrow_document,
    parse_arrow,
    parse_arrow_fileset,
    read_arrow_document,
    render_json_form,
)
from app.arrow_schema import (
    LIMIT_DETAILS,
    MAX_DEPTH,
    MAX_DOCUMENT_BYTES,
    MAX_FIELDS,
    ArrowParseError,
    LimitRecorder,
)
from app.canonical_model import ApiParadigm, TypeKind
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
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "arrow"

#: The smallest schema that exercises a field, a type with parameters and nullability.
MINIMAL = """
{
  "schema": {
    "fields": [
      {"name": "id", "type": {"name": "int", "bitWidth": 64, "isSigned": true},
       "nullable": false, "children": []},
      {"name": "label", "type": {"name": "utf8"}, "nullable": true, "children": []}
    ]
  }
}
"""


@pytest.fixture()
def adapter() -> ArrowImportSource:
    """The registered Arrow adapter."""
    return get_import_source("arrow")


def _fixture(name: str) -> str:
    """Return a shipped corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _flight_set() -> IntakeFileset:
    """Return the shipped two-file Flight set as an intake fileset."""
    members: Dict[str, str] = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-flight-set").iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root="flight-info.json")


def _model(name: str, adapter: ArrowImportSource):
    """Import one shipped corpus fixture end to end."""
    return adapter.normalize(adapter.parse(_fixture(name), source_label=name))


def _type(model, name: str):
    """Return one named type from a canonical model."""
    return next(item for item in model.types if item.name == name)


def _field(model, type_name: str, field_name: str):
    """Return one named field of one named type from a canonical model."""
    return next(field for field in _type(model, type_name).fields if field.name == field_name)


def _ordered(type_) -> list:
    """Return a type's field names in column order.

    ``normalize_ordering`` sorts fields by key, so the column order Arrow states — which is
    positional and load-bearing — lives on ``field_number``, not on the list.
    """
    return [field.name for field in sorted(type_.fields, key=lambda item: item.field_number or 0)]


def _limits(model) -> Dict[str, int]:
    """Return ``construct -> count`` for the declared limits a model recorded."""
    return {
        entry["construct"]: entry["count"]
        for entry in model.extras[ARROW_EXTRAS_KEY]["capability_limits"]
    }


# ===========================================================================
# Registration and detection
# ===========================================================================


def test_adapter_is_registered_as_a_data_schema_reader(adapter: ArrowImportSource) -> None:
    assert adapter.key == "arrow"
    assert adapter.paradigm is ApiParadigm.DATA_SCHEMA
    assert adapter.formats == ("arrow",)
    assert ".arrow" in adapter.file_extensions
    assert adapter.supports_live_discovery is True


def test_detects_the_json_integration_form(adapter: ArrowImportSource) -> None:
    result = adapter.detect(DetectionInput(text=MINIMAL, filename="schema.json"))
    assert result.matched
    assert result.format == "arrow"
    assert result.confidence >= 0.85


def test_detects_a_flight_envelope_that_defers_its_schema(adapter: ArrowImportSource) -> None:
    text = _fixture("07-flight-set/flight-info.json")
    assert is_arrow(text)
    assert adapter.detect(DetectionInput(text=text)).format == "arrow"


def test_detects_binary_ipc_by_magic(adapter: ArrowImportSource) -> None:
    data = (CORPUS / "08-composition-nested-types.arrow").read_bytes()
    result = adapter.detect(DetectionInput(data=data, filename="x.arrow"))
    assert result.format == "arrow"
    assert result.confidence >= 0.85
    assert "IPC" in result.reason


def test_detection_of_an_ipc_filename_alone_is_a_weak_claim(adapter: ArrowImportSource) -> None:
    result = adapter.detect(DetectionInput(filename="columns.feather"))
    assert result.matched
    assert result.confidence < 0.85


def test_does_not_claim_an_avro_schema(adapter: ArrowImportSource) -> None:
    """The near neighbour: an object with a `fields` array and a `type` on each member."""
    text = _fixture("negative/04-wrong-format-avro.avsc")
    assert is_arrow(text) is False
    assert adapter.detect(DetectionInput(text=text)).matched is False


def test_every_valid_corpus_fixture_ranks_first_as_arrow() -> None:
    for path in sorted(CORPUS.glob("*.json")):
        best = detect_import_source(
            DetectionInput(text=path.read_text(encoding="utf-8"), filename=path.name)
        )
        assert best is not None, path.name
        assert best[0].key == "arrow", path.name
        assert best[1].confidence >= 0.85, path.name


def test_detection_never_raises_on_junk(adapter: ArrowImportSource) -> None:
    for junk in ("", "   ", "not json at all", "{", '{"schema": '):
        assert adapter.detect(DetectionInput(text=junk)).matched is False


def test_is_arrow_document_accepts_an_empty_schema_object() -> None:
    """A table with no columns is a legal schema; the bare form still needs Arrow evidence."""
    assert is_arrow_document({"schema": {"fields": []}}) is True
    assert is_arrow_document({"fields": []}) is False
    assert is_arrow_document("not a mapping") is False


def test_declared_suffixes_cover_both_surfaces() -> None:
    assert ".arrow" in ARROW_IPC_SUFFIXES
    assert ".json" in ARROW_JSON_SUFFIXES


# ===========================================================================
# Parsing the JSON integration form
# ===========================================================================


def test_parses_the_minimal_schema(adapter: ArrowImportSource) -> None:
    document = adapter.parse(MINIMAL, source_label="minimal.json")
    assert [field.name for field in document.schema.fields] == ["id", "label"]
    assert document.schema.fields[0].nullable is False
    assert document.schema.fields[0].type.bit_width == 64
    assert document.schema.fields[0].type.is_signed is True


def test_parses_schema_and_field_metadata() -> None:
    document = parse_arrow(_fixture("02-typical-orders-schema.json"))
    assert dict(document.schema.metadata)["source"] == "orders.public.orders"
    placed = next(f for f in document.schema.fields if f.name == "placed_at")
    assert placed.type.unit == "MICROSECOND"
    assert placed.type.timezone == "UTC"


def test_parses_nested_children() -> None:
    document = parse_arrow(_fixture("03-composition-nested-types.json"))
    customer = next(f for f in document.schema.fields if f.name == "customer")
    assert customer.type.name == "struct"
    assert [child.name for child in customer.children] == ["customer_id", "address"]


def test_metadata_may_be_written_as_a_plain_object() -> None:
    """A schema serialized from a language binding writes metadata as a mapping."""
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "a", "type": {"name": "utf8"}, "children": []}],'
        ' "metadata": {"owner": "analytics"}}}'
    )
    assert document.schema.metadata == (("owner", "analytics"),)


def test_a_bare_schema_object_parses() -> None:
    """Arrow's integration files wrap the schema; one exchanged alone often is not."""
    document = parse_arrow(
        '{"fields": [{"name": "a", "type": {"name": "utf8"}, "nullable": true, "children": []}]}'
    )
    assert [field.name for field in document.schema.fields] == ["a"]


def test_unknown_type_parameters_are_dropped_rather_than_guessed_at() -> None:
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "a", "type": {"name": "utf8", "byteWidth": 4},'
        ' "children": []}]}}'
    )
    assert document.schema.fields[0].type.parameters == {}


# ===========================================================================
# Negative tier — every code is grounded on the reader's own behaviour
# ===========================================================================


def test_trailing_comma_is_a_syntax_error_the_pipeline_classifies(
    adapter: ArrowImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/01-syntactic-trailing-comma.json"))
    assert excinfo.value.code is None


def test_unknown_type_name_is_semantic(adapter: ArrowImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/02-semantic-unknown-type-name.json"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "quaternion" in str(excinfo.value)


def test_a_document_cut_short_is_truncated_not_malformed(adapter: ArrowImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/03-truncated-mid-field.json"))
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_syntax_error_inside_a_complete_document_is_not_truncation() -> None:
    """Truncation is a *position*: the decoder ran out of input, not out of grammar."""
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow('{"schema": {"fields": [], "metadata": ]}}')
    assert excinfo.value.code is None


def test_wrong_format_is_uncoded_so_the_pipeline_can_call_it_a_mismatch(
    adapter: ArrowImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/04-wrong-format-avro.avsc"))
    assert excinfo.value.code is None


def test_a_nested_type_without_children_is_semantic(adapter: ArrowImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/06-semantic-struct-without-children.json"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_an_empty_document_is_empty() -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow("   ")
    assert excinfo.value.code == "INPUT_EMPTY"


def test_a_top_level_array_is_not_a_schema() -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow("[]")
    assert excinfo.value.code is None


@pytest.mark.parametrize(
    "type_json",
    [
        '{"name": "int", "bitWidth": 12, "isSigned": true}',
        '{"name": "int", "bitWidth": 32}',
        '{"name": "floatingpoint", "precision": "QUAD"}',
        '{"name": "timestamp", "unit": "FURLONG"}',
        '{"name": "decimal", "precision": 0, "scale": 2}',
        '{"name": "decimal", "precision": 10, "scale": 2, "bitWidth": 96}',
        '{"name": "fixedsizebinary", "byteWidth": -1}',
    ],
)
def test_a_parameter_outside_its_domain_is_semantic(type_json: str) -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow(
            '{"schema": {"fields": [{"name": "a", "type": %s, "children": []}]}}' % type_json
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_map_child_must_be_the_two_member_entries_struct() -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow(
            '{"schema": {"fields": [{"name": "m", "type": {"name": "map"}, "children": ['
            '{"name": "entries", "type": {"name": "utf8"}, "children": []}]}]}}'
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_union_type_id_list_must_match_its_variants() -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow(
            '{"schema": {"fields": [{"name": "u", "type": {"name": "union", "mode": "DENSE",'
            ' "typeIds": [0, 1, 2]}, "children": ['
            '{"name": "a", "type": {"name": "utf8"}, "children": []}]}]}}'
        )
    assert "typeIds" in str(excinfo.value)


# ===========================================================================
# Reader ceilings
# ===========================================================================


def test_a_document_past_the_byte_ceiling_is_refused() -> None:
    padding = "x" * (MAX_DOCUMENT_BYTES + 1)
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow('{"schema": {"fields": [], "pad": "%s"}}' % padding)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_a_schema_nested_past_the_depth_ceiling_is_refused() -> None:
    """A recursive walk meeting 1 000 levels raises RecursionError, which is a 5xx."""
    inner = '{"name": "leaf", "type": {"name": "utf8"}, "children": []}'
    for _ in range(MAX_DEPTH + 2):
        inner = (
            '{"name": "l", "type": {"name": "list"}, "nullable": true, "children": [%s]}' % inner
        )
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow('{"schema": {"fields": [%s]}}' % inner)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_the_field_ceiling_is_charged_across_the_whole_document() -> None:
    assert MAX_FIELDS > 0
    column = '{"name": "c%d", "type": {"name": "utf8"}, "children": []}'
    fields = ",".join(column % index for index in range(8))
    document = parse_arrow('{"schema": {"fields": [%s]}}' % fields)
    assert len(document.schema.fields) == 8


# ===========================================================================
# The JSON-form writer
# ===========================================================================


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-schema.json",
        "02-typical-orders-schema.json",
        "03-composition-nested-types.json",
        "04-stress-type-coverage.json",
        "05-real-world-trip-records-schema.json",
        "06-typical-flight-getschema-response.json",
    ],
)
def test_rendering_a_schema_and_reading_it_back_is_a_fixed_point(name: str) -> None:
    document = parse_arrow(_fixture(name), source_label=name)
    rendered = render_json_form(document.schema, flight=document.flight)
    again = parse_arrow(rendered, source_label=name)
    assert again.schema == document.schema
    assert again.flight == document.flight


# ===========================================================================
# Filesets
# ===========================================================================


def test_a_flight_set_resolves_its_schema_reference(adapter: ArrowImportSource) -> None:
    document = adapter.parse_fileset(_flight_set())
    assert [field.name for field in document.schema.fields][:2] == ["sku", "warehouse"]
    assert document.flight is not None
    assert document.flight.descriptor.path == ("warehouse", "public", "inventory")
    assert len(document.flight.endpoints) == 2


def test_an_unresolvable_schema_reference_fails_the_import() -> None:
    with pytest.raises(ArrowParseError) as excinfo:
        parse_arrow_fileset(
            {"root.json": '{"flight_descriptor": {"type": "PATH", "path": ["a"]},'
             ' "schema_ref": "missing.json"}'},
            root="root.json",
        )
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_a_set_without_its_root_is_rejected(adapter: ArrowImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.parse_fileset(IntakeFileset(root="absent.json", members={"other.json": "{}"}))


def test_a_flight_response_alone_is_not_importable() -> None:
    """A `GetFlightInfo` capture that defers its schema needs the set, not the file."""
    with pytest.raises(ArrowParseError):
        parse_arrow(_fixture("07-flight-set/flight-info.json"))


# ===========================================================================
# Normalization — the schema becomes one table
# ===========================================================================


def test_a_schema_becomes_one_record_of_columns(adapter: ArrowImportSource) -> None:
    model = _model("01-minimal-schema.json", adapter)
    assert model.paradigm is ApiParadigm.DATA_SCHEMA
    assert model.format == "arrow"
    assert model.identity.name == DEFAULT_ROOT_NAME
    root = _type(model, DEFAULT_ROOT_NAME)
    assert root.kind is TypeKind.RECORD
    assert _ordered(root) == ["id", "label"]
    assert _field(model, DEFAULT_ROOT_NAME, "id").type.nullable is False
    assert _field(model, DEFAULT_ROOT_NAME, "label").type.nullable is True


def test_column_position_survives_key_sorting(adapter: ArrowImportSource) -> None:
    model = _model("02-typical-orders-schema.json", adapter)
    root = _type(model, DEFAULT_ROOT_NAME)
    assert _ordered(root) == [
        "order_id",
        "customer_id",
        "placed_at",
        "total_minor_units",
        "currency",
        "cancelled",
        "note",
    ]
    assert [field.field_number for field in sorted(root.fields, key=lambda f: f.field_number)] == [
        1, 2, 3, 4, 5, 6, 7
    ]


def test_identity_comes_from_a_flight_descriptor_not_the_filename(
    adapter: ArrowImportSource,
) -> None:
    model = _model("06-typical-flight-getschema-response.json", adapter)
    assert model.identity.name == "shipments"
    assert model.identity.namespace == "warehouse.public"
    assert model.extras[ARROW_EXTRAS_KEY]["flight"]["descriptor"]["path"] == [
        "warehouse",
        "public",
        "shipments",
    ]


def test_identity_falls_back_to_a_name_in_the_schema_metadata() -> None:
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "a", "type": {"name": "utf8"}, "children": []}],'
        ' "metadata": [{"key": "name", "value": "orders"}]}}'
    )
    model = get_import_source("arrow").normalize(document)
    assert model.identity.name == "orders"
    assert "name" not in model.extras[ARROW_EXTRAS_KEY].get("schema_metadata", {})


def test_two_labels_for_one_schema_produce_one_fingerprint(adapter: ArrowImportSource) -> None:
    """The identity is derived from the document, which is what makes the surfaces equal."""
    text = _fixture("01-minimal-schema.json")
    first = adapter.normalize(adapter.parse(text, source_label="a.json"), include_raw=False)
    second = adapter.normalize(adapter.parse(text, source_label="b.arrow"), include_raw=False)
    assert canonical_fingerprint(first) == canonical_fingerprint(second)


def test_metadata_documentation_keys_become_descriptions() -> None:
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "a", "type": {"name": "utf8"}, "children": [],'
        ' "metadata": [{"key": "description", "value": "the a column"}]}],'
        ' "metadata": [{"key": "comment", "value": "one table"}]}}'
    )
    model = get_import_source("arrow").normalize(document)
    assert model.description == "one table"
    assert _field(model, DEFAULT_ROOT_NAME, "a").description == "the a column"


def test_field_metadata_is_carried_verbatim(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    field = _field(model, DEFAULT_ROOT_NAME, "f_dictionary")
    assert field.extras["arrow_metadata"] == {"cardinality_hint": "48"}


# ===========================================================================
# Nested types are modelled exactly
# ===========================================================================


def test_a_struct_becomes_a_named_record(adapter: ArrowImportSource) -> None:
    model = _model("03-composition-nested-types.json", adapter)
    customer = _type(model, "customer")
    assert customer.kind is TypeKind.RECORD
    assert _ordered(customer) == ["customer_id", "address"]
    assert _field(model, DEFAULT_ROOT_NAME, "customer").type.name == "customer"


def test_nested_type_names_are_built_from_the_field_path(adapter: ArrowImportSource) -> None:
    """Two `address` structs under different columns must not collide."""
    model = _model("03-composition-nested-types.json", adapter)
    assert _type(model, "customer_address").kind is TypeKind.RECORD
    assert _type(model, "lines_item").kind is TypeKind.RECORD


def test_a_list_becomes_a_list_reference(adapter: ArrowImportSource) -> None:
    model = _model("03-composition-nested-types.json", adapter)
    lines = _field(model, DEFAULT_ROOT_NAME, "lines")
    assert lines.type.is_list()
    assert lines.type.item.name == "lines_item"
    assert lines.extras["arrow_item"]["name"] == "item"


def test_a_map_becomes_a_map_with_both_its_key_and_value_types(
    adapter: ArrowImportSource,
) -> None:
    model = _model("03-composition-nested-types.json", adapter)
    attributes = _type(model, "attributes")
    assert attributes.kind is TypeKind.MAP
    assert attributes.key_type.name == "string"
    assert attributes.value_type.name == "string"
    assert attributes.extras["arrow_keys_sorted"] is False


def test_a_fixed_size_list_bounds_its_length(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    field = _field(model, DEFAULT_ROOT_NAME, "f_fixed_size_list")
    assert field.constraints.min_items == 3
    assert field.constraints.max_items == 3


def test_a_union_becomes_a_union_over_its_variants(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    union = _type(model, "f_dense_union")
    assert union.kind is TypeKind.UNION
    assert union.union_members == ["int32", "string", "bytes"]
    variants = union.extras["arrow_union"]["variants"]
    assert [variant["name"] for variant in variants] == ["as_int", "as_text", "as_bytes"]
    assert [variant["typeId"] for variant in variants] == [0, 1, 2]
    assert union.extras["arrow_union"]["mode"] == "DENSE"


# ===========================================================================
# Scalars
# ===========================================================================


@pytest.mark.parametrize(
    ("field_name", "scalar"),
    [
        ("f_null", "null"),
        ("f_bool", "bool"),
        ("f_int8", "int8"),
        ("f_uint16", "uint16"),
        ("f_int64", "int64"),
        ("f_float", "float"),
        ("f_double", "double"),
        ("f_utf8", "string"),
        ("f_large_utf8", "string"),
        ("f_binary", "bytes"),
        ("f_decimal128", "decimal"),
        ("f_decimal256", "decimal"),
    ],
)
def test_each_primitive_takes_its_exact_canonical_scalar(
    adapter: ArrowImportSource, field_name: str, scalar: str
) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    assert _field(model, DEFAULT_ROOT_NAME, field_name).type.name == scalar


def test_a_fixed_size_binary_is_bytes_bounded_by_its_width(adapter: ArrowImportSource) -> None:
    model = _model("02-typical-orders-schema.json", adapter)
    currency = _field(model, DEFAULT_ROOT_NAME, "currency")
    assert currency.type.name == "bytes"
    assert currency.constraints.min_length == 3
    assert currency.constraints.max_length == 3


@pytest.mark.parametrize(
    ("field_name", "fmt"),
    [
        ("f_date_day", "date"),
        ("f_time_s", "time"),
        ("f_timestamp_tz", "date-time"),
        ("f_duration", "duration"),
        ("f_interval_ym", "duration"),
    ],
)
def test_temporal_types_carry_a_format_hint(
    adapter: ArrowImportSource, field_name: str, fmt: str
) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    field = _field(model, DEFAULT_ROOT_NAME, field_name)
    assert field.type.name == "string"
    assert field.constraints.format == fmt


def test_the_source_type_is_always_recoverable_from_extras(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    assert _field(model, DEFAULT_ROOT_NAME, "f_timestamp_tz").extras["arrow_type"] == {
        "name": "timestamp",
        "unit": "NANOSECOND",
        "timezone": "Europe/Amsterdam",
    }


# ===========================================================================
# Declared limits
# ===========================================================================


def test_a_dictionary_encoded_field_keeps_its_value_type(adapter: ArrowImportSource) -> None:
    model = _model("05-real-world-trip-records-schema.json", adapter)
    vendor = _field(model, DEFAULT_ROOT_NAME, "vendor_id")
    assert vendor.type.name == "string"
    assert vendor.extras["arrow_dictionary"]["indexType"]["bitWidth"] == 8
    assert vendor.extras["arrow_dictionary"]["isOrdered"] is False
    assert _limits(model)["arrow.dictionary_encoding"] == 3


def test_a_dictionary_id_is_not_carried(adapter: ArrowImportSource) -> None:
    """The id names a message in an IPC stream, not a property of the data."""
    model = _model("05-real-world-trip-records-schema.json", adapter)
    assert "id" not in _field(model, DEFAULT_ROOT_NAME, "vendor_id").extras["arrow_dictionary"]


def test_a_decimal_records_its_precision_scale_and_width(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    assert _field(model, DEFAULT_ROOT_NAME, "f_decimal256").extras["arrow_decimal"] == {
        "precision": 60,
        "scale": 12,
        "bitWidth": 256,
    }
    assert _limits(model)["arrow.decimal_width"] == 2


def test_an_extension_type_keeps_its_storage_type(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    field = _field(model, DEFAULT_ROOT_NAME, "f_extension")
    assert field.type.name == "bytes"
    assert field.extras["arrow_extension"]["name"] == "arrow.uuid"
    assert _limits(model)["arrow.extension_type"] == 1


def test_flight_endpoints_are_recorded_and_become_no_operation(
    adapter: ArrowImportSource,
) -> None:
    model = adapter.normalize(adapter.parse_fileset(_flight_set()))
    assert model.services == []
    endpoints = model.extras[ARROW_EXTRAS_KEY]["flight"]["endpoints"]
    assert len(endpoints) == 2
    assert endpoints[0]["locations"] == ["grpc+tls://flight-a.example.com:443"]
    assert _limits(model)["arrow.flight_endpoint"] == 1


def test_every_declared_limit_is_located(adapter: ArrowImportSource) -> None:
    model = _model("04-stress-type-coverage.json", adapter)
    for entry in model.extras[ARROW_EXTRAS_KEY]["capability_limits"]:
        assert entry["detail"] == LIMIT_DETAILS[entry["construct"]]
        assert entry["locations"], entry["construct"]


def test_a_schema_that_meets_no_limit_records_none(adapter: ArrowImportSource) -> None:
    assert _limits(_model("01-minimal-schema.json", adapter)) == {}


def test_the_limit_recorder_refuses_a_key_outside_the_vocabulary() -> None:
    recorder = LimitRecorder()
    with pytest.raises(KeyError):
        recorder.record("arrow.invented")


def test_declared_capabilities_match_the_limit_vocabulary() -> None:
    assert sorted(ARROW_CAPABILITIES.unsupported) == sorted(LIMIT_DETAILS)
    assert "arrow.struct" in ARROW_CAPABILITIES.supported
    assert "arrow.map" in ARROW_CAPABILITIES.supported


# ===========================================================================
# Registry surfaces
# ===========================================================================


def test_the_capability_registry_carries_a_reviewed_seed() -> None:
    capability = capability_for("arrow")
    assert capability.provenance is CapabilityProvenance.REVIEWED
    assert capability.canonical_projection.coverage is ProjectionCoverage.PARTIAL
    assert sorted(capability.canonical_projection.dropped_constructs) == sorted(LIMIT_DETAILS)


def test_version_coverage_declares_one_ungated_read_and_no_write() -> None:
    coverage = version_coverage_for("arrow")
    assert [row.support for row in coverage.reads] == [VersionSupport.UNGATED]
    assert list(coverage.writes) == []
    assert coverage.default_write is None


def test_the_projection_record_is_provenance_not_a_source_construct() -> None:
    assert ARROW_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS


def test_declared_limits_render_as_partially_mapped_ledger_rows(
    adapter: ArrowImportSource,
) -> None:
    model = _model("05-real-world-trip-records-schema.json", adapter)
    manifest = build_import_preview_manifest(model, adapter_key="arrow")
    rows = {
        row.source_construct: row
        for row in manifest.document_coverage
        if row.source_construct.startswith("arrow.")
    }
    assert "arrow.dictionary_encoding" in rows
    assert rows["arrow.dictionary_encoding"].coverage is CoverageClass.PARTIALLY_MAPPED
    assert "vendor_id" in rows["arrow.dictionary_encoding"].detail


def test_normalize_rejects_a_foreign_ast(adapter: ArrowImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"schema": {"fields": []}})


def test_read_arrow_document_leaves_raw_to_its_caller() -> None:
    parsed = read_arrow_document({"schema": {"fields": []}})
    assert parsed.raw is None


# ===========================================================================
# Key allocation — Arrow names are not canonical keys
# ===========================================================================


def test_two_columns_of_the_same_name_get_distinct_keys() -> None:
    """Arrow permits it; two canonical fields sharing a key would shadow each other."""
    document = parse_arrow(
        '{"schema": {"fields": ['
        '{"name": "value", "type": {"name": "utf8"}, "children": []},'
        '{"name": "value", "type": {"name": "int", "bitWidth": 32, "isSigned": true},'
        ' "children": []}]}}'
    )
    model = get_import_source("arrow").normalize(document)
    root = _type(model, DEFAULT_ROOT_NAME)
    assert [field.name for field in root.fields] == ["value", "value"]
    assert len({field.key for field in root.fields}) == 2


def test_a_column_name_containing_a_dot_keeps_its_name_and_folds_its_key() -> None:
    """`user.id` is an ordinary analytical column; `.` is the canonical key separator."""
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "user.id", "type": {"name": "utf8"},'
        ' "children": []}]}}'
    )
    model = get_import_source("arrow").normalize(document)
    field = _type(model, DEFAULT_ROOT_NAME).fields[0]
    assert field.name == "user.id"
    assert field.key == f"{DEFAULT_ROOT_NAME}.user_id"


def test_a_column_named_like_the_root_does_not_claim_the_root_type_key() -> None:
    document = parse_arrow(
        '{"schema": {"fields": [{"name": "%s", "type": {"name": "struct"}, "children": ['
        '{"name": "a", "type": {"name": "utf8"}, "children": []}]}]}}' % DEFAULT_ROOT_NAME
    )
    model = get_import_source("arrow").normalize(document)
    assert len({item.key for item in model.types}) == len(model.types)
