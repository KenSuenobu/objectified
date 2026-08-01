"""Tests for the browse protocol/format facet vocabulary (MFI-6.1, #3753)."""

from app.browse_facets import (
    BROWSE_PROTOCOL_VALUES,
    MAX_FACET_VALUE_LENGTH,
    format_label,
    normalize_format_filter,
    normalize_protocol_filter,
    protocol_label,
    sort_format_counts,
    sort_protocol_counts,
)
from app.canonical_model import ApiParadigm

# ---------------------------------------------------------------------------
# Protocol vocabulary
# ---------------------------------------------------------------------------


def test_protocol_values_are_exactly_the_canonical_paradigms():
    assert BROWSE_PROTOCOL_VALUES == tuple(p.value for p in ApiParadigm)


def test_normalize_protocol_accepts_canonical_values():
    for value in BROWSE_PROTOCOL_VALUES:
        assert normalize_protocol_filter(value) == value


def test_normalize_protocol_is_punctuation_and_case_insensitive():
    assert normalize_protocol_filter("Data-Schema") == "data_schema"
    assert normalize_protocol_filter("data schema") == "data_schema"
    assert normalize_protocol_filter("DATASCHEMA") == "data_schema"
    assert normalize_protocol_filter("  REST  ") == "rest"


def test_normalize_protocol_resolves_common_aliases():
    assert normalize_protocol_filter("graphql") == "graph"
    assert normalize_protocol_filter("event-driven") == "event"
    assert normalize_protocol_filter("messaging") == "event"
    assert normalize_protocol_filter("mcp") == "agent"
    assert normalize_protocol_filter("grpc") == "rpc"


def test_normalize_protocol_blank_is_none():
    assert normalize_protocol_filter(None) is None
    assert normalize_protocol_filter("") is None
    assert normalize_protocol_filter("   ") is None


def test_normalize_protocol_keeps_unknown_value_as_a_narrowing_filter():
    # An unknown protocol must narrow to nothing rather than 4xx, so it is normalized, not rejected.
    assert normalize_protocol_filter("Telepathy") == "telepathy"


def test_normalize_protocol_caps_length():
    assert len(normalize_protocol_filter("x" * 500)) == MAX_FACET_VALUE_LENGTH


def test_protocol_labels_cover_every_paradigm():
    for value in BROWSE_PROTOCOL_VALUES:
        assert protocol_label(value) not in ("", value), f"no display label for {value}"
    assert protocol_label("data_schema") == "Data schema"
    assert protocol_label("rest") == "REST"


def test_protocol_label_falls_back_to_raw_value():
    assert protocol_label("telepathy") == "telepathy"


# ---------------------------------------------------------------------------
# Format vocabulary
# ---------------------------------------------------------------------------


def test_normalize_format_lowercases_and_trims():
    assert normalize_format_filter("  OpenAPI-3.1 ") == "openapi-3.1"


def test_normalize_format_blank_is_none():
    assert normalize_format_filter(None) is None
    assert normalize_format_filter("  ") is None


def test_normalize_format_caps_length():
    assert len(normalize_format_filter("f" * 500)) == MAX_FACET_VALUE_LENGTH


def test_format_label_uses_the_adapter_registry():
    assert format_label("graphql") == "GraphQL"
    assert format_label("wsdl") == "WSDL"
    assert format_label("protobuf") == "gRPC / Protobuf"


def test_format_label_appends_the_version_of_a_versioned_key():
    assert format_label("openapi-3.1") == "OpenAPI 3.1"
    assert format_label("asyncapi-3") == "AsyncAPI 3"


def test_format_label_picks_the_matching_name_from_a_multi_name_adapter():
    # The OpenAPI adapter emits both families; a Swagger key must not be labelled "OpenAPI 2.0".
    assert format_label("swagger-2.0") == "Swagger 2.0"


def test_format_label_keeps_multi_part_versions_intact():
    assert format_label("json-schema-2020-12") == "JSON Schema 2020-12"


def test_format_label_does_not_split_keys_that_merely_end_in_digits():
    assert format_label("iso20022") == "ISO 20022"
    assert format_label("hl7v2") == "HL7 v2"


def test_format_label_falls_back_to_the_raw_key():
    assert format_label("totally-unknown") == "totally-unknown"
    assert format_label("") == ""
    assert format_label(None) == ""


# ---------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------


def test_sort_protocol_counts_uses_canonical_order_then_unknowns():
    ordered = sort_protocol_counts({"graph": 2, "rest": 5, "telepathy": 9, "rpc": 1})
    assert [value for value, _label, _count in ordered] == ["rest", "rpc", "graph", "telepathy"]
    assert ordered[0] == ("rest", "REST", 5)


def test_sort_protocol_counts_empty():
    assert sort_protocol_counts({}) == []


def test_sort_format_counts_is_by_count_then_key():
    ordered = sort_format_counts({"graphql": 2, "openapi-3.1": 5, "avro": 2})
    assert [value for value, _label, _count in ordered] == ["openapi-3.1", "avro", "graphql"]
    assert ordered[0][1] == "OpenAPI 3.1"


def test_sort_format_counts_empty():
    assert sort_format_counts({}) == []
