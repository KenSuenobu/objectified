"""Tests for Smithy catalog import/export adapters."""

from __future__ import annotations

import pytest
from corpus_loader import load_corpus

from app.canonical_model import ApiParadigm, TypeKind
from app.emitter import get_emitter
from app.import_source import DetectionInput, ImportSourceError
from app.smithy_import_source import SmithyImportSource
from app.smithy_normalizer import SmithyNormalizer
from app.smithy_parser import is_smithy, parse_smithy

# Fixtures come from the corpus manifest (IXH-1.1, #5087), selected by tag
# rather than hard-coded path. Entries are path-sorted, so the first match
# stays stable as the corpus grows (IXH-1.2).
_WEATHER_ENTRY = load_corpus(format="smithy", feature="service")[0]
_WEATHER_SERVICE = _WEATHER_ENTRY.read_text()


@pytest.fixture()
def adapter() -> SmithyImportSource:
    return SmithyImportSource()


def test_is_smithy_recognizes_weather_service():
    assert is_smithy(_WEATHER_SERVICE) is True
    assert is_smithy('import "@typespec/http";\nnamespace Demo;\n') is False


def test_parse_collects_shapes_and_service():
    doc = parse_smithy(_WEATHER_SERVICE)
    assert doc.version == "2.0"
    assert doc.namespace == "example.weather"
    assert {shape.name for shape in doc.structures} >= {
        "GetForecastInput",
        "Forecast",
        "DayForecast",
        "CurrentConditions",
    }
    assert {enum.name for enum in doc.enums} == {"Condition"}
    assert {lst.name for lst in doc.lists} == {"DayForecastList"}
    assert {op.name for op in doc.operations} == {"GetForecast", "GetCurrentConditions"}
    assert len(doc.services) == 1
    assert doc.services[0].name == "WeatherService"


def test_normalizer_maps_rpc_surface():
    doc = parse_smithy(_WEATHER_SERVICE)
    api = SmithyNormalizer().normalize(doc)
    assert api.format == "smithy"
    assert api.paradigm is ApiParadigm.RPC
    assert api.protocol == "smithy"
    assert api.services[0].name == "WeatherService"
    assert {op.name for op in api.services[0].operations} == {
        "GetForecast",
        "GetCurrentConditions",
    }
    forecast_input = next(t for t in api.types if t.name == "GetForecastInput")
    assert forecast_input.kind is TypeKind.RECORD
    assert {field.name for field in forecast_input.fields} == {"city", "days"}
    assert any(t.name == "DayForecastList" and t.kind is TypeKind.ALIAS for t in api.types)
    assert any(t.name == "Condition" and t.kind is TypeKind.ENUM for t in api.types)


def test_adapter_detect_parse_normalize(adapter: SmithyImportSource):
    detected = adapter.detect(
        DetectionInput(
            text=_WEATHER_SERVICE,
            filename="01-weather-service.smithy",
        )
    )
    assert detected.matched
    assert detected.format == "smithy"
    doc = adapter.parse(_WEATHER_SERVICE, source_label="01-weather-service.smithy")
    api = adapter.normalize(doc)
    assert len(api.services) == 1
    assert len(api.services[0].operations) == 2
    assert len(api.types) >= 5


def test_adapter_invalid_source_raises(adapter: SmithyImportSource):
    with pytest.raises(ImportSourceError):
        adapter.parse("openapi: 3.0.0")


def test_emitter_round_trips_core_constructs():
    doc = parse_smithy(_WEATHER_SERVICE)
    api = SmithyNormalizer().normalize(doc)
    emitter = get_emitter("smithy")
    assert emitter is not None
    result = emitter().emit(api)
    text = result.files[0].content
    assert '$version: "2.0"' in text
    assert "namespace example.weather" in text
    assert "service WeatherService" in text
    assert "operation GetForecast" in text
    assert "structure GetForecastInput" in text
    assert "enum Condition" in text
    assert "list DayForecastList" in text


def test_catalog_conversion_resolves_smithy_adapter():
    from app.catalog_conversion import resolve_conversion_adapter

    assert resolve_conversion_adapter("smithy", _WEATHER_SERVICE).key == "smithy"
