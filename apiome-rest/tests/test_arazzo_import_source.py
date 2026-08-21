"""End-to-end tests for the Arazzo import source (MFI-30.2, #4395)."""

from __future__ import annotations

import copy
from typing import Any, Dict

import pytest

from app.arazzo_import_source import ArazzoImportSource
from app.arazzo_lint import lint_arazzo_result
from app.breaking_change import Severity, classify_models
from app.canonical_model import ApiParadigm
from app.diff import ChangeKind, EntityCategory, diff
from app.import_source import (
    DetectionInput,
    DiffChangeKind,
    ImportSourceError,
    InputKind,
)
from app.import_source import get_import_source, available_import_sources, load_builtin_import_sources


def _base_doc() -> Dict[str, Any]:
    return {
        "arazzo": "1.0.1",
        "info": {"title": "Checkout", "version": "1.0.0", "summary": "Checkout flow"},
        "sourceDescriptions": [
            {
                "name": "openapi",
                "type": "openapi",
                "url": "https://example.test/openapi.json",
                "content": {
                    "openapi": "3.0.0",
                    "info": {"title": "Shop", "version": "1.0.0"},
                    "paths": {
                        "/carts": {
                            "post": {"operationId": "createCart", "responses": {"201": {}}},
                        },
                        "/payments": {
                            "post": {"operationId": "createPayment", "responses": {"200": {}}},
                        },
                    },
                },
            }
        ],
        "workflows": [
            {
                "workflowId": "checkout",
                "summary": "Checkout cart and pay",
                "steps": [
                    {
                        "stepId": "createCart",
                        "operationId": "createCart",
                        "successCriteria": [{"condition": "$statusCode == 201", "type": "simple"}],
                    },
                    {
                        "stepId": "submitPayment",
                        "operationId": "createPayment",
                        "successCriteria": [{"condition": "$statusCode == 200", "type": "simple"}],
                    },
                ],
            }
        ],
    }


@pytest.fixture()
def adapter() -> ArazzoImportSource:
    return ArazzoImportSource()


def test_descriptor_metadata(adapter: ArazzoImportSource) -> None:
    descriptor = adapter.descriptor()
    assert descriptor.key == "arazzo"
    assert descriptor.label == "Arazzo"
    assert descriptor.paradigm is ApiParadigm.REST
    assert set(descriptor.input_kinds) == {
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        # FMT-3.1 (#5426): a workflow imports together with the documents its
        # `sourceDescriptions` point at.
        InputKind.FILESET,
    }
    assert descriptor.formats == ["arazzo"]
    assert descriptor.available is True


def test_registered_in_import_source_registry() -> None:
    load_builtin_import_sources()
    assert "arazzo" in available_import_sources()
    assert isinstance(get_import_source("arazzo"), ArazzoImportSource)


def test_detect_from_document(adapter: ArazzoImportSource) -> None:
    result = adapter.detect(DetectionInput(document=_base_doc()))
    assert result.matched
    assert result.format == "arazzo"
    assert result.confidence >= 0.98


def test_detect_declines_openapi(adapter: ArazzoImportSource) -> None:
    assert not adapter.detect(
        DetectionInput(document={"openapi": "3.1.0", "info": {}, "paths": {}})
    ).matched


def test_parse_and_normalize_produces_canonical_entities(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(_base_doc())
    assert model.format == "arazzo"
    assert model.paradigm is ApiParadigm.REST
    assert model.title == "Checkout"
    assert len(model.services) == 1
    service = model.services[0]
    assert service.key == "checkout"
    assert service.extras["stepOrder"] == ["createCart", "submitPayment"]
    assert len(service.operations) == 2
    keys = {op.key for op in service.operations}
    assert keys == {"checkout#createCart", "checkout#submitPayment"}
    assert model.extras["sourceDescriptions"][0]["name"] == "openapi"


def test_normalize_rejects_non_arazzo(adapter: ArazzoImportSource) -> None:
    with pytest.raises(ImportSourceError, match="not an Arazzo"):
        adapter.normalize({"info": {"title": "nope"}})


def test_lint_flags_dangling_operation_id(adapter: ArazzoImportSource) -> None:
    doc = copy.deepcopy(_base_doc())
    doc["workflows"][0]["steps"].append(
        {
            "stepId": "ghostStep",
            "operationId": "doesNotExist",
            "successCriteria": [{"condition": "$statusCode == 200", "type": "simple"}],
        }
    )
    report = adapter.lint(adapter.normalize(doc))
    rules = {finding.rule for finding in report.findings}
    assert "arazzo.dangling-operation-id" in rules
    assert any("doesNotExist" in finding.message for finding in report.findings)


def test_lint_flags_unused_workflow_inputs(adapter: ArazzoImportSource) -> None:
    doc = copy.deepcopy(_base_doc())
    doc["workflows"][0]["inputs"] = {
        "type": "object",
        "properties": {"cartId": {"type": "string"}},
    }
    report = lint_arazzo_result(adapter.normalize(doc))
    assert any(f.rule == "arazzo.unused-workflow-input" for f in report.findings)


def test_lint_flags_missing_success_criteria(adapter: ArazzoImportSource) -> None:
    doc = copy.deepcopy(_base_doc())
    doc["workflows"][0]["steps"][0].pop("successCriteria")
    report = lint_arazzo_result(adapter.normalize(doc))
    assert any(f.rule == "arazzo.missing-success-criteria" for f in report.findings)


def test_two_versions_diff_step_level(adapter: ArazzoImportSource) -> None:
    before = adapter.normalize(_base_doc())
    after_doc = copy.deepcopy(_base_doc())
    after_doc["workflows"][0]["steps"] = [
        after_doc["workflows"][0]["steps"][1],
        {
            "stepId": "confirmOrder",
            "operationId": "createPayment",
            "successCriteria": [{"condition": "$statusCode == 200", "type": "simple"}],
        },
    ]
    after = adapter.normalize(after_doc)

    model_diff = diff(before, after)
    operation_changes = [
        c for c in model_diff.changes if c.category is EntityCategory.OPERATION
    ]
    kinds = {c.kind for c in operation_changes}
    assert ChangeKind.ADDED in kinds
    assert ChangeKind.REMOVED in kinds

    spi_diff = adapter.diff(before, after)
    op_entries = [e for e in spi_diff.entries if e.entity == "operation"]
    assert {e.change for e in op_entries} >= {DiffChangeKind.ADDED, DiffChangeKind.REMOVED}


def test_step_reorder_classified_via_breaking_change_spi(adapter: ArazzoImportSource) -> None:
    before = adapter.normalize(_base_doc())
    after_doc = copy.deepcopy(_base_doc())
    after_doc["workflows"][0]["steps"] = list(reversed(after_doc["workflows"][0]["steps"]))
    after = adapter.normalize(after_doc)

    result = classify_models(before, after)
    assert any(
        c.rule_id == "arazzo.step-reorder" and c.severity is Severity.DANGEROUS
        for c in result.classifications
    )


def test_fingerprint_is_stable(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(_base_doc())
    assert adapter.fingerprint(model) == adapter.fingerprint(adapter.normalize(_base_doc()))


def test_format_detection_marks_arazzo_importable() -> None:
    from app.format_detection import detect_format

    detection = detect_format(DetectionInput(document=_base_doc()))
    assert detection.detected is not None
    assert detection.detected.format == "arazzo"
    assert detection.detected.importable is True
    assert detection.detected.source_key == "arazzo"


def test_routes_to_non_publishable_catalog_item(adapter: ArazzoImportSource) -> None:
    from app.import_routing import ImportTarget, decide_import_routing

    model = adapter.normalize(_base_doc())
    routing = decide_import_routing(adapter, model)
    assert routing.target is ImportTarget.CATALOG
    assert routing.publishable is False


def test_emitter_round_trips_checkout_fixture() -> None:
    from pathlib import Path

    import yaml

    from app.arazzo_emitter import validate_arazzo_document
    from app.emitter import get_emitter

    fixture = (
        Path(__file__).resolve().parent
        / "fixtures/openapi_family/arazzo-checkout.yaml"
    )
    raw = fixture.read_text(encoding="utf-8")
    adapter = ArazzoImportSource()
    api = adapter.normalize(adapter.parse(raw, source_label="arazzo-checkout.yaml"))
    emitter = get_emitter("arazzo")
    assert emitter is not None
    result = emitter().emit(api)
    text = str(result.files[0].content)
    validate_arazzo_document(text)
    round_trip = yaml.safe_load(text)
    assert round_trip["arazzo"] == "1.0.1"
    assert round_trip["workflows"][0]["workflowId"] == "checkout"


def test_catalog_conversion_resolves_arazzo_adapter() -> None:
    from app.catalog_conversion import resolve_conversion_adapter

    assert resolve_conversion_adapter("arazzo", "arazzo: 1.0.1").key == "arazzo"
