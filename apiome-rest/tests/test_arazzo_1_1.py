"""Arazzo 1.1 read-and-emit support — FMT-3.1 (#5426).

Arazzo 1.1 (May 2026) lets a single workflow span a synchronous OpenAPI-described API and
an asynchronous AsyncAPI-described event stream. This suite covers the acceptance criteria
of #5426 directly:

* a 1.1 document is detected, parsed, normalized and re-emitted **as 1.1**;
* a 1.0 document still round-trips **as 1.0** — the emitter never silently upgrades;
* a workflow with both an OpenAPI and an AsyncAPI source description imports with both
  sources resolved and each step linked to the one it calls;
* the lint pack evaluates 1.1 without false positives from the new reference forms;
* an out-of-range version and a step that names nothing to invoke are rejected with the
  taxonomy codes the corpus manifest declares.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from app.arazzo_emitter import ArazzoEmitOptions, ArazzoEmitter, validate_arazzo_document
from app.arazzo_import_source import ArazzoImportSource
from app.arazzo_lint import lint_arazzo_result
from app.arazzo_spec import (
    ARAZZO_VERSION_1_0,
    ARAZZO_VERSION_1_1,
    ArazzoSemanticError,
    ArazzoVersionError,
    default_arazzo_version,
    parse_arazzo_version,
    resolve_step_target,
    supports_async_sources,
    validate_arazzo_semantics,
    validate_arazzo_version,
)
from app.fileset import IntakeFileset
from app.import_source import DetectionInput, ImportSourceError

#: The FMT-3.1 corpus directory, whose entries this suite drives end to end.
EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "arazzo-1.1"


@pytest.fixture()
def adapter() -> ArazzoImportSource:
    return ArazzoImportSource()


def _example(name: str) -> Dict[str, Any]:
    """Parse one corpus example into its native document."""
    return yaml.safe_load((EXAMPLES / name).read_text(encoding="utf-8"))


def _emit(model, **options: Any) -> Dict[str, Any]:
    """Emit a model as Arazzo and parse the result back into a document."""
    result = ArazzoEmitter().emit(model, opts=ArazzoEmitOptions(**options))
    text = str(result.files[0].content)
    validate_arazzo_document(text)
    return yaml.safe_load(text)


def _sourced_fileset() -> IntakeFileset:
    """The multi-file corpus set: a workflow plus the OpenAPI file it points at."""
    directory = EXAMPLES / "06-sourced-set"
    members = {path.name: path.read_text(encoding="utf-8") for path in sorted(directory.iterdir())}
    return IntakeFileset.from_members(members, root="workflow.arazzo.yaml")


# ---------------------------------------------------------------------------
# Version vocabulary
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("marker", "expected"),
    [("1.0.0", (1, 0)), ("1.0.1", (1, 0)), ("1.1.0", (1, 1)), ("1.1", (1, 1))],
)
def test_supported_versions_parse(marker: str, expected: tuple) -> None:
    assert validate_arazzo_version(marker) == expected


@pytest.mark.parametrize("marker", ["2.0.0", "0.9.0", "1.2.0", "banana", "", None])
def test_unsupported_versions_are_rejected(marker: Any) -> None:
    with pytest.raises(ArazzoVersionError):
        validate_arazzo_version(marker)


def test_only_1_1_expresses_async_sources() -> None:
    assert not supports_async_sources(parse_arazzo_version("1.0.1"))
    assert supports_async_sources(parse_arazzo_version("1.1.0"))


def test_default_version_follows_the_model_s_sources() -> None:
    assert default_arazzo_version(has_async_sources=False) == ARAZZO_VERSION_1_0
    assert default_arazzo_version(has_async_sources=True) == ARAZZO_VERSION_1_1


# ---------------------------------------------------------------------------
# Detect / parse / normalize
# ---------------------------------------------------------------------------


def test_detects_a_1_1_document(adapter: ArazzoImportSource) -> None:
    result = adapter.detect(DetectionInput(document=_example("01-minimal-single-step.yaml")))
    assert result.matched
    assert result.format == "arazzo"
    assert result.confidence >= 0.95
    assert "1.1.0" in (result.reason or "")


def test_detects_an_unreadable_version_as_arazzo_not_as_another_format(
    adapter: ArazzoImportSource,
) -> None:
    """`arazzo: 2.0.0` is an Arazzo document; only its *version* is out of range."""
    result = adapter.detect(
        DetectionInput(document=_example("negative/06-version-out-of-range-2.0.yaml"))
    )
    assert result.matched and result.format == "arazzo"


def test_normalize_keeps_the_source_version_and_source_types(
    adapter: ArazzoImportSource,
) -> None:
    model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    assert model.extras["arazzo"] == "1.1.0"
    assert model.extras["sourceTypes"] == {"orders": "openapi", "orderEvents": "asyncapi"}
    assert model.extras["asyncSources"] == ["orderEvents"]
    assert model.extras["infoSummary"].startswith("Place an order over REST")


def test_mixed_sync_async_workflow_links_every_step_to_its_source(
    adapter: ArazzoImportSource,
) -> None:
    """AC: both sources resolved and linked, with the async half marked as such."""
    model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    steps = {
        operation.extras["stepId"]: operation.extras
        for operation in model.services[0].operations
    }
    assert steps["placeOrder"]["sourceDescription"] == "orders"
    assert steps["placeOrder"]["sourceType"] == "openapi"
    assert "asyncStep" not in steps["placeOrder"]

    for step_id in ("awaitOrderAccepted", "awaitSettlement"):
        assert steps[step_id]["sourceDescription"] == "orderEvents"
        assert steps[step_id]["sourceType"] == "asyncapi"
        assert steps[step_id]["asyncStep"] is True

    assert steps["fetchInvoice"]["sourceType"] == "openapi"


def test_message_payload_criteria_alone_mark_a_step_async(
    adapter: ArazzoImportSource,
) -> None:
    """The `$message.*` context is enough even when the source declares no type."""
    document = copy.deepcopy(_example("05-real-world-order-to-cash.yaml"))
    for entry in document["sourceDescriptions"]:
        entry.pop("type", None)
    model = adapter.normalize(document)
    steps = {op.extras["stepId"]: op.extras for op in model.services[0].operations}
    assert steps["awaitOrderAccepted"]["asyncStep"] is True
    assert "asyncStep" not in steps["placeOrder"]


def test_components_are_preserved_for_rebuild(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(_example("03-composition-reusable-components.yaml"))
    assert set(model.extras["components"]) == {
        "inputs",
        "parameters",
        "successActions",
        "failureActions",
    }


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-single-step.yaml",
        "02-typical-checkout-flow.yaml",
        "03-composition-reusable-components.yaml",
        "04-stress-criteria-vocabulary.yaml",
        "05-real-world-order-to-cash.yaml",
        "07-version-1.0-baseline.yaml",
    ],
)
def test_every_corpus_example_imports_and_lints(
    adapter: ArazzoImportSource, name: str
) -> None:
    model = adapter.normalize(adapter.parse((EXAMPLES / name).read_text(encoding="utf-8")))
    assert model.services
    assert adapter.lint(model) is not None


# ---------------------------------------------------------------------------
# Rejections
# ---------------------------------------------------------------------------


def test_out_of_range_version_is_a_version_error(adapter: ArazzoImportSource) -> None:
    """AC / corpus: `arazzo: 2.0.0` fails as FORMAT_VERSION_UNSUPPORTED."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.normalize(_example("negative/06-version-out-of-range-2.0.yaml"))
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"
    assert "1.1.x" in str(excinfo.value)


def test_step_naming_nothing_to_invoke_is_a_semantic_error(
    adapter: ArazzoImportSource,
) -> None:
    """AC / corpus: a step with no operation target fails as INPUT_SEMANTIC_INVALID."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.normalize(_example("negative/02-semantic-step-without-operation.yaml"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "doNothing" in str(excinfo.value)


def test_semantics_accept_every_target_spelling() -> None:
    """Each spelling a step may use to name what it calls satisfies the rule."""
    for step in (
        {"stepId": "a", "operationId": "createCart"},
        {"stepId": "b", "operationId": "$sourceDescriptions.api.createCart"},
        {"stepId": "c", "operationRef": "#/sourceDescriptions/0"},
        {"stepId": "d", "operationPath": "{$sourceDescriptions.api.url}#/paths/~1a/get"},
        {"stepId": "e", "workflowId": "other"},
        {"stepId": "f", "request": {"source": "api", "operationId": "createCart"}},
    ):
        document = {
            "arazzo": "1.1.0",
            "info": {"title": "t", "version": "1.0.0"},
            "sourceDescriptions": [{"name": "api", "type": "openapi", "url": "https://x/o.yaml"}],
            "workflows": [{"workflowId": "w", "steps": [step]}],
        }
        validate_arazzo_semantics(document)
        assert resolve_step_target(step, source_names=["api"]) is not None


def test_semantics_tolerate_a_document_with_no_workflows() -> None:
    """An empty workflow list is a valid, if empty, document — not a rejection."""
    validate_arazzo_semantics(
        {"arazzo": "1.1.0", "info": {"title": "Empty", "version": "1.0.0"}, "workflows": []}
    )


def test_semantic_error_names_the_offending_step() -> None:
    with pytest.raises(ArazzoSemanticError, match="'ghost'"):
        validate_arazzo_semantics(
            {
                "arazzo": "1.1.0",
                "workflows": [{"workflowId": "w", "steps": [{"stepId": "ghost"}]}],
            }
        )


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------


def test_a_1_1_document_re_emits_as_1_1(adapter: ArazzoImportSource) -> None:
    """AC: detected, parsed, normalized and re-emitted as 1.1."""
    model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    emitted = _emit(model)
    assert emitted["arazzo"] == "1.1.0"
    assert [entry["type"] for entry in emitted["sourceDescriptions"]] == [
        "openapi",
        "asyncapi",
    ]


def test_a_1_0_document_is_not_silently_upgraded(adapter: ArazzoImportSource) -> None:
    """AC: a 1.0 document still round-trips as 1.0."""
    model = adapter.normalize(_example("07-version-1.0-baseline.yaml"))
    assert _emit(model)["arazzo"] == "1.0.1"


def test_a_1_0_document_round_trips_unchanged(adapter: ArazzoImportSource) -> None:
    """AC: the 1.0 body survives the round trip, not only its version marker."""
    source = _example("07-version-1.0-baseline.yaml")
    emitted = _emit(adapter.normalize(copy.deepcopy(source)))
    assert emitted == source


def test_a_1_1_document_round_trips_unchanged(adapter: ArazzoImportSource) -> None:
    source = _example("05-real-world-order-to-cash.yaml")
    emitted = _emit(adapter.normalize(copy.deepcopy(source)))
    assert emitted == source


def test_rebuilt_export_defaults_to_1_1_only_for_async_models(
    adapter: ArazzoImportSource,
) -> None:
    """Without a raw document to re-render, the version follows the source types."""
    async_model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    sync_model = adapter.normalize(_example("02-typical-checkout-flow.yaml"))
    for model, expected in ((async_model, "1.1.0"), (sync_model, "1.0.1")):
        model.raw = None
        model.extras.pop("arazzo")
        assert _emit(model)["arazzo"] == expected


def test_rebuilt_export_carries_components_and_info_summary(
    adapter: ArazzoImportSource,
) -> None:
    model = adapter.normalize(_example("03-composition-reusable-components.yaml"))
    model.raw = None
    emitted = _emit(model)
    assert set(emitted["components"]) == {
        "inputs",
        "parameters",
        "successActions",
        "failureActions",
    }
    assert emitted["workflows"][1]["dependsOn"] == ["createSubscription"]

    checkout = adapter.normalize(_example("02-typical-checkout-flow.yaml"))
    checkout.raw = None
    assert _emit(checkout)["info"]["summary"] == "Create a cart, add an item, and pay for it."


def test_explicit_version_option_overrides_the_source(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(_example("07-version-1.0-baseline.yaml"))
    assert _emit(model, arazzo_version="1.1.0")["arazzo"] == "1.1.0"


def test_explicit_version_option_rejects_an_unreadable_version(
    adapter: ArazzoImportSource,
) -> None:
    model = adapter.normalize(_example("01-minimal-single-step.yaml"))
    with pytest.raises(ValueError, match="arazzo_version"):
        ArazzoEmitter().emit(model, opts=ArazzoEmitOptions(arazzo_version="2.0.0"))


def test_downgrading_an_async_model_records_a_loss(adapter: ArazzoImportSource) -> None:
    """Asking for 1.0 on an async model is honoured, but never silently."""
    model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    result = ArazzoEmitter().emit(model, opts=ArazzoEmitOptions(arazzo_version="1.0.1"))
    assert yaml.safe_load(str(result.files[0].content))["arazzo"] == "1.0.1"
    assert any(loss.subject == "async-sources-need-1-1" for loss in result.losses)


def test_emit_option_is_published_on_the_target_descriptor() -> None:
    """The new option is discoverable by the Export Studio, not only by Python."""
    schema = ArazzoEmitter.options_model.model_json_schema()
    assert "arazzo_version" in schema["properties"]


# ---------------------------------------------------------------------------
# Multi-file: a workflow imported with the documents its sources name
# ---------------------------------------------------------------------------


def test_fileset_resolves_a_sibling_source_document(adapter: ArazzoImportSource) -> None:
    document = adapter.parse_fileset(_sourced_fileset(), source_label="06-sourced-set")
    assert [entry["name"] for entry in document.resolved_sources] == ["inventory"]
    assert document.resolved_sources[0]["path"] == "inventory.openapi.yaml"
    assert document.resolved_sources[0]["content"]["openapi"] == "3.1.0"


def test_fileset_resolution_is_published_on_the_model(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(adapter.parse_fileset(_sourced_fileset()))
    assert model.extras["resolvedSources"][0]["name"] == "inventory"
    # The workflow document itself is untouched, so an export still renders the source.
    assert "content" not in model.extras["sourceDescriptions"][0]


def test_fileset_resolution_lets_lint_check_the_operation_id(
    adapter: ArazzoImportSource,
) -> None:
    """A resolved source turns `$sourceDescriptions.inventory.<op>` into a real check."""
    members = dict(_sourced_fileset().members)
    workflow = yaml.safe_load(members["workflow.arazzo.yaml"])
    workflow["workflows"][0]["steps"][0]["operationId"] = (
        "$sourceDescriptions.inventory.noSuchOperation"
    )
    members["workflow.arazzo.yaml"] = yaml.safe_dump(workflow)
    broken = IntakeFileset.from_members(members, root="workflow.arazzo.yaml")

    clean_report = adapter.lint(adapter.normalize(adapter.parse_fileset(_sourced_fileset())))
    broken_report = adapter.lint(adapter.normalize(adapter.parse_fileset(broken)))

    assert not [f for f in clean_report.findings if f.rule == "arazzo.dangling-operation-id"]
    assert [f for f in broken_report.findings if f.rule == "arazzo.dangling-operation-id"]


def test_fileset_without_an_arazzo_member_is_a_format_mismatch(
    adapter: ArazzoImportSource,
) -> None:
    members = {"inventory.openapi.yaml": (EXAMPLES / "06-sourced-set" / "inventory.openapi.yaml").read_text()}
    fileset = IntakeFileset.from_members(members, root="inventory.openapi.yaml")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(fileset)
    assert excinfo.value.code == "FORMAT_MISMATCH"


def test_fileset_with_two_workflows_is_semantically_invalid(
    adapter: ArazzoImportSource,
) -> None:
    members = dict(_sourced_fileset().members)
    members["second.arazzo.yaml"] = members["workflow.arazzo.yaml"]
    fileset = IntakeFileset.from_members(members, root="workflow.arazzo.yaml")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(fileset)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_fileset_ignores_a_non_document_member(adapter: ArazzoImportSource) -> None:
    """A README riding along in the set must not fail the import."""
    members = dict(_sourced_fileset().members)
    members["README.md"] = "# Not a document\n\n- just prose: [and a link](x)\n"
    fileset = IntakeFileset.from_members(members, root="workflow.arazzo.yaml")
    document = adapter.parse_fileset(fileset)
    assert [entry["name"] for entry in document.resolved_sources] == ["inventory"]


# ---------------------------------------------------------------------------
# Lint: no false positives from the 1.1 reference forms
# ---------------------------------------------------------------------------


def _arazzo_findings(model) -> List[str]:
    return sorted(
        finding.rule
        for finding in lint_arazzo_result(model).findings
        if finding.rule.startswith("arazzo.") or finding.rule.startswith("arzzo.")
    )


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-single-step.yaml",
        "02-typical-checkout-flow.yaml",
        "03-composition-reusable-components.yaml",
        "04-stress-criteria-vocabulary.yaml",
        "05-real-world-order-to-cash.yaml",
        "07-version-1.0-baseline.yaml",
    ],
)
def test_lint_reports_nothing_against_a_valid_1_1_example(
    adapter: ArazzoImportSource, name: str
) -> None:
    """AC: 1.1 lints without false positives from the new fields."""
    assert _arazzo_findings(adapter.normalize(_example(name))) == []


def test_operation_ref_by_index_is_accepted(adapter: ArazzoImportSource) -> None:
    """`#/sourceDescriptions/1` is a legal pointer; only an out-of-range index is not."""
    document = copy.deepcopy(_example("04-stress-criteria-vocabulary.yaml"))
    assert _arazzo_findings(adapter.normalize(copy.deepcopy(document))) == []

    document["workflows"][0]["steps"][2]["operationRef"] = "#/sourceDescriptions/9"
    findings = _arazzo_findings(adapter.normalize(document))
    assert "arzzo.unresolvable-operation-ref" in findings


def test_runtime_expression_operation_id_is_checked_against_its_own_source(
    adapter: ArazzoImportSource,
) -> None:
    """A named source scopes the check: the other source's operations do not count."""
    document = {
        "arazzo": "1.1.0",
        "info": {"title": "Two sources", "version": "1.0.0"},
        "sourceDescriptions": [
            {
                "name": "orders",
                "type": "openapi",
                "url": "https://x/orders.yaml",
                "content": {
                    "openapi": "3.1.0",
                    "paths": {"/o": {"post": {"operationId": "createOrder"}}},
                },
            },
            {
                "name": "events",
                "type": "asyncapi",
                "url": "https://x/events.yaml",
                "content": {"asyncapi": "3.0.0", "operations": {"receiveOrderAccepted": {}}},
            },
        ],
        "workflows": [
            {
                "workflowId": "w",
                "steps": [
                    {
                        "stepId": "place",
                        "operationId": "$sourceDescriptions.orders.createOrder",
                        "successCriteria": [{"condition": "$statusCode == 201"}],
                    },
                    {
                        "stepId": "await",
                        "operationId": "$sourceDescriptions.events.receiveOrderAccepted",
                        "successCriteria": [{"condition": "$statusCode == 200"}],
                    },
                ],
            }
        ],
    }
    assert _arazzo_findings(adapter.normalize(copy.deepcopy(document))) == []

    # The event operation exists — but not in the `orders` source the step now names.
    document["workflows"][0]["steps"][1]["operationId"] = (
        "$sourceDescriptions.orders.receiveOrderAccepted"
    )
    findings = _arazzo_findings(adapter.normalize(document))
    assert "arazzo.dangling-operation-id" in findings


def test_async_source_in_a_1_0_document_is_flagged(adapter: ArazzoImportSource) -> None:
    document = copy.deepcopy(_example("05-real-world-order-to-cash.yaml"))
    document["arazzo"] = "1.0.1"
    findings = _arazzo_findings(adapter.normalize(document))
    assert "arazzo.async-source-before-1-1" in findings


def test_async_source_in_a_1_1_document_is_not_flagged(adapter: ArazzoImportSource) -> None:
    model = adapter.normalize(_example("05-real-world-order-to-cash.yaml"))
    assert "arazzo.async-source-before-1-1" not in _arazzo_findings(model)
