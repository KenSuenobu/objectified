"""Tests for FHIR catalog import/export adapters — MFI-22.2."""

from __future__ import annotations

import pytest
from corpus_loader import load_corpus

from app.canonical_model import ApiParadigm, TypeKind
from app.emitter import get_emitter
from app.fhir_emitter import validate_fhir_document
from app.fhir_import_source import FhirImportSource
from app.fhir_normalizer import FhirNormalizer
from app.fhir_parser import is_fhir, parse_fhir
from app.import_source import DetectionInput, ImportSourceError

# Fixtures come from the corpus manifest (IXH-1.1, #5087), selected by tag
# rather than hard-coded path: the Patient resource instance, and the two
# StructureDefinitions profiling Observation and Patient respectively.
# Entries are path-sorted, so the first match stays stable as the corpus
# grows (IXH-1.2).
_PATIENT_ENTRY = load_corpus(format="fhir", feature="patient")[0]
_OBSERVATION_PROFILE_ENTRY = load_corpus(format="fhir", feature="profiles-observation")[0]
_PATIENT_PROFILE_ENTRY = load_corpus(format="fhir", feature="profiles-patient")[0]
_PATIENT_INSTANCE = _PATIENT_ENTRY.read_text()
_OBSERVATION_PROFILE = _OBSERVATION_PROFILE_ENTRY.read_text()
_PATIENT_PROFILE = _PATIENT_PROFILE_ENTRY.read_text()


@pytest.fixture()
def adapter() -> FhirImportSource:
    return FhirImportSource()


def test_is_fhir_recognizes_patient_instance():
    assert is_fhir(_PATIENT_INSTANCE) is True
    assert is_fhir('{"type": "record", "name": "User", "fields": []}') is False


def test_parse_structure_definition_collects_elements():
    doc = parse_fhir(_OBSERVATION_PROFILE)
    assert doc.kind == "structure_definition"
    assert doc.structure_definition is not None
    assert doc.structure_definition.resource_type == "Observation"
    assert {element.field_name for element in doc.structure_definition.elements} == {
        "status",
        "code",
        "valueQuantity",
    }


def test_parse_resource_instance_infers_profile():
    doc = parse_fhir(_PATIENT_INSTANCE)
    assert doc.kind == "resource_profile"
    assert doc.resource_profile is not None
    assert doc.resource_profile.resource_type == "Patient"
    assert any(field.name == "name" and field.is_array for field in doc.resource_profile.fields)


def test_parse_third_fixture_covers_patient_profile():
    doc = parse_fhir(_PATIENT_PROFILE)
    assert doc.structure_definition is not None
    assert doc.structure_definition.resource_type == "Patient"
    gender = next(
        element for element in doc.structure_definition.elements if element.field_name == "gender"
    )
    assert gender.types[0].code == "code"


def test_normalizer_maps_rest_resource_and_operations():
    doc = parse_fhir(_OBSERVATION_PROFILE)
    api = FhirNormalizer().normalize(doc)
    assert api.format == "fhir"
    assert api.paradigm is ApiParadigm.REST
    observation = next(t for t in api.types if t.name == "Observation")
    assert observation.kind is TypeKind.RECORD
    service = api.services[0]
    assert service.name == "Observation"
    assert any(op.http_method == "GET" for op in service.operations)


def test_adapter_detect_parse_normalize(adapter: FhirImportSource):
    detected = adapter.detect(
        DetectionInput(text=_OBSERVATION_PROFILE, filename="02-patient-structuredefinition.json")
    )
    assert detected.matched
    assert detected.format == "fhir"
    doc = adapter.parse(_OBSERVATION_PROFILE)
    api = adapter.normalize(doc)
    assert api.extras.get("fhir_structure_definition")


def test_adapter_invalid_source_raises(adapter: FhirImportSource):
    with pytest.raises(ImportSourceError):
        adapter.parse('{"hello": "world"}')


def test_emitter_round_trips_observation_profile():
    doc = parse_fhir(_OBSERVATION_PROFILE)
    api = FhirNormalizer().normalize(doc)
    emitter = get_emitter("fhir")
    assert emitter is not None
    text = emitter().emit(api).files[0].content
    assert '"resourceType": "StructureDefinition"' in text
    assert "Observation.status" in text
    validate_fhir_document(text)


def test_emitter_round_trips_patient_instance_profile():
    doc = parse_fhir(_PATIENT_INSTANCE)
    api = FhirNormalizer().normalize(doc)
    emitter = get_emitter("fhir")
    assert emitter is not None
    text = emitter().emit(api).files[0].content
    assert '"resourceType": "Patient"' in text
    validate_fhir_document(text)


def test_catalog_conversion_resolves_fhir_adapter():
    from app.catalog_conversion import resolve_conversion_adapter

    assert resolve_conversion_adapter("fhir", _OBSERVATION_PROFILE).key == "fhir"
