"""Tests for the evidence exporters (ECA-1.3, #4731).

The acceptance criterion both formats answer is *reproducibility*: "JUnit and JSON exports
reproduce stored outcomes". So these tests are mostly one question asked many ways — can a reader
of the export reach a conclusion the stored record does not support?

* every stored case appears, in stored order, with its stored verdict;
* the JUnit counters come from the stored counts rather than a re-tally, so an export cannot
  disagree with the run it exports;
* a contract violation and an unexecutable case stay distinguishable (``<failure>`` vs ``<error>``);
* what identifies the evidence — suite digest, target, runner, window — survives the trip;
* text a runner captured cannot break the XML, and JSON output is stable enough to diff.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from xml.etree import ElementTree

import pytest

from app.verification_evidence import (
    ArtifactRecord,
    AssertionRecord,
    EvidenceValidationError,
    OperationRecord,
    VerificationRunRecord,
)
from app.verification_evidence_export import (
    EXPORT_FORMATS,
    EXPORT_MEDIA_TYPES,
    export_json,
    export_junit,
    export_run,
    run_export_document,
)

_DIGEST = "sha256:" + "a" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)


def _operations() -> List[OperationRecord]:
    """One case of each outcome, in the order they were recorded."""
    return [
        OperationRecord(
            id="a1",
            sequence=0,
            case_id="get-pets-example-1",
            operation_key="GET /pets",
            http_method="GET",
            http_path="/pets",
            outcome="passed",
            duration_ms=120,
        ),
        OperationRecord(
            id="a2",
            sequence=1,
            case_id="get-pet-negative-1",
            operation_key="GET /pets/{petId}",
            http_method="GET",
            http_path="/pets/abc",
            outcome="failed",
            failure_code="status-mismatch",
            failure_message="expected 400, got 500",
            expected_status="400",
            actual_status=500,
            duration_ms=300,
            assertions=[
                AssertionRecord(
                    id="s1",
                    sequence=0,
                    kind="status_code",
                    outcome="failed",
                    code="status-mismatch",
                    expected="400",
                    actual="500",
                    message="the contract declares 400 for an invalid id",
                ),
                AssertionRecord(
                    id="s2", sequence=1, kind="content_type", outcome="passed"
                ),
            ],
        ),
        OperationRecord(
            id="a3",
            sequence=2,
            case_id="post-pets-generated-1",
            operation_key="POST /pets",
            http_method="POST",
            http_path="/pets",
            outcome="errored",
            failure_code="transport-error",
            failure_message="connection reset",
            duration_ms=30000,
            attempts=3,
        ),
        OperationRecord(
            id="a4",
            sequence=3,
            case_id="delete-pet-generated-1",
            operation_key="DELETE /pets/{petId}",
            http_method="DELETE",
            http_path="/pets/1",
            outcome="skipped",
            failure_code="mutating-not-allowed",
            duration_ms=0,
        ),
    ]


def _record(**overrides: Any) -> VerificationRunRecord:
    """A stored run carrying one case of each outcome."""
    payload: Dict[str, Any] = {
        "id": "33333333-3333-4333-8333-333333333333",
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "suite_digest": _DIGEST,
        "suite_schema_version": 1,
        "suite_compiler_version": 1,
        "suite_case_count": 4,
        "target_id": "22222222-2222-4222-8222-222222222222",
        "target_slug": "staging",
        "target_environment": "staging",
        "target_network_class": "public",
        "target_base_url": "https://staging.example.com/api",
        "runner_name": "apiome-contract-runner",
        "runner_version": "1.2.3",
        "actor_kind": "api_key",
        "started_at": _START,
        "finished_at": _START + timedelta(seconds=31),
        "duration_ms": 31000,
        "outcome": "errored",
        "counts": {"total": 4, "passed": 1, "failed": 1, "errored": 1, "skipped": 1},
        "operations": _operations(),
        "artifacts": [
            ArtifactRecord(
                id="f1",
                kind="log",
                label="runner log",
                uri="s3://tenant-artifacts/run/1/runner.log",
                media_type="text/plain",
            )
        ],
    }
    payload.update(overrides)
    return VerificationRunRecord(**payload)


def _junit_root(record: VerificationRunRecord) -> ElementTree.Element:
    """Parse an exported run back into an element tree."""
    return ElementTree.fromstring(export_junit(record))


# ===========================================================================
# JSON
# ===========================================================================


def test_the_json_export_is_the_stored_record() -> None:
    document = json.loads(export_json(_record()))
    assert document["suite_digest"] == _DIGEST
    assert document["outcome"] == "errored"
    assert document["counts"] == {
        "total": 4,
        "passed": 1,
        "failed": 1,
        "errored": 1,
        "skipped": 1,
    }
    assert [operation["case_id"] for operation in document["operations"]] == [
        "get-pets-example-1",
        "get-pet-negative-1",
        "post-pets-generated-1",
        "delete-pet-generated-1",
    ]


def test_the_json_export_carries_target_identity_and_timing() -> None:
    document = json.loads(export_json(_record()))
    assert document["target_slug"] == "staging"
    assert document["target_environment"] == "staging"
    assert document["target_base_url"] == "https://staging.example.com/api"
    assert document["started_at"].startswith("2026-07-27T12:00:00")
    assert document["duration_ms"] == 31000


def test_the_json_export_keeps_artifacts_as_references() -> None:
    document = json.loads(export_json(_record()))
    artifact = document["artifacts"][0]
    assert artifact["uri"] == "s3://tenant-artifacts/run/1/runner.log"
    assert "content" not in artifact


def test_two_exports_of_the_same_run_are_byte_identical() -> None:
    assert export_json(_record()) == export_json(_record())


def test_the_json_export_declares_its_envelope_version() -> None:
    assert run_export_document(_record())["export_schema_version"] >= 1


# ===========================================================================
# JUnit
# ===========================================================================


def test_every_stored_case_appears_in_stored_order() -> None:
    cases = _junit_root(_record()).iter("testcase")
    assert [case.get("name") for case in cases] == [
        "get-pets-example-1",
        "get-pet-negative-1",
        "post-pets-generated-1",
        "delete-pet-generated-1",
    ]


def test_the_counters_come_from_the_stored_counts_rather_than_a_retally() -> None:
    # A record whose counts disagree with its cases must export the *stored* counts: an export that
    # quietly recomputed them would hide the disagreement instead of surfacing it.
    record = _record(counts={"total": 9, "passed": 6, "failed": 2, "errored": 1, "skipped": 0})
    root = _junit_root(record)
    assert root.get("tests") == "9"
    assert root.get("failures") == "2"
    assert root.get("errors") == "1"


def test_a_contract_violation_and_an_unexecutable_case_stay_distinguishable() -> None:
    root = _junit_root(_record())
    cases = {case.get("name"): case for case in root.iter("testcase")}
    assert cases["get-pet-negative-1"].find("failure") is not None
    assert cases["get-pet-negative-1"].find("error") is None
    assert cases["post-pets-generated-1"].find("error") is not None
    assert cases["post-pets-generated-1"].find("failure") is None


def test_a_passing_case_carries_no_verdict_element() -> None:
    case = next(
        c for c in _junit_root(_record()).iter("testcase") if c.get("name") == "get-pets-example-1"
    )
    assert list(case) == []


def test_a_skipped_case_says_why_it_was_skipped() -> None:
    case = next(
        c
        for c in _junit_root(_record()).iter("testcase")
        if c.get("name") == "delete-pet-generated-1"
    )
    skipped = case.find("skipped")
    assert skipped is not None
    assert skipped.get("message") == "mutating-not-allowed"


def test_a_failure_carries_its_stable_code_as_the_junit_type() -> None:
    case = next(
        c for c in _junit_root(_record()).iter("testcase") if c.get("name") == "get-pet-negative-1"
    )
    failure = case.find("failure")
    assert failure is not None
    assert failure.get("type") == "status-mismatch"
    assert failure.get("message") == "expected 400, got 500"


def test_the_failure_body_explains_the_break_without_a_trip_back_to_the_api() -> None:
    case = next(
        c for c in _junit_root(_record()).iter("testcase") if c.get("name") == "get-pet-negative-1"
    )
    text = (case.find("failure").text or "")
    assert "expected status 400, got 500" in text
    assert "status-mismatch" in text
    assert "the contract declares 400 for an invalid id" in text
    # Only the failed assertion is rendered; a passing check is not a failure detail.
    assert "content_type" not in text


def test_cases_are_grouped_by_operation_so_a_ci_viewer_can_read_them() -> None:
    classnames = {case.get("classname") for case in _junit_root(_record()).iter("testcase")}
    assert classnames == {"GET /pets", "GET /pets/{petId}", "POST /pets", "DELETE /pets/{petId}"}


def test_durations_are_rendered_in_junit_seconds() -> None:
    cases = {case.get("name"): case for case in _junit_root(_record()).iter("testcase")}
    assert cases["get-pets-example-1"].get("time") == "0.120"
    assert cases["post-pets-generated-1"].get("time") == "30.000"


def test_what_identifies_the_evidence_survives_as_properties() -> None:
    properties = {
        prop.get("name"): prop.get("value") for prop in _junit_root(_record()).iter("property")
    }
    assert properties["apiome.suite_digest"] == _DIGEST
    assert properties["apiome.target_slug"] == "staging"
    assert properties["apiome.target_environment"] == "staging"
    assert properties["apiome.outcome"] == "errored"
    assert properties["apiome.runner"] == "apiome-contract-runner"
    assert properties["apiome.started_at"].startswith("2026-07-27T12:00:00")


def test_markup_in_a_captured_message_cannot_break_the_document() -> None:
    operations = _operations()
    operations[1].failure_message = 'got <html> & "quotes" </testcase>'
    root = _junit_root(_record(operations=operations))
    case = next(c for c in root.iter("testcase") if c.get("name") == "get-pet-negative-1")
    assert case.find("failure").get("message") == 'got <html> & "quotes" </testcase>'


def test_a_control_character_from_a_raw_response_body_is_stripped() -> None:
    operations = _operations()
    operations[1].failure_message = "body was \x00\x08 binary"
    # Parsing at all is the assertion: XML 1.0 cannot represent these bytes.
    root = _junit_root(_record(operations=operations))
    case = next(c for c in root.iter("testcase") if c.get("name") == "get-pet-negative-1")
    assert "\x00" not in (case.find("failure").get("message") or "")


def test_a_run_with_no_cases_still_exports_a_well_formed_document() -> None:
    record = _record(
        operations=[],
        outcome="cancelled",
        counts={"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0},
    )
    root = _junit_root(record)
    assert root.get("tests") == "0"
    assert list(root.iter("testcase")) == []


def test_the_export_declares_an_xml_prolog() -> None:
    assert export_junit(_record()).startswith('<?xml version="1.0" encoding="UTF-8"?>')


# ===========================================================================
# Dispatch
# ===========================================================================


@pytest.mark.parametrize("export_format", EXPORT_FORMATS)
def test_every_advertised_format_renders_and_has_a_media_type(export_format: str) -> None:
    assert export_run(_record(), export_format)
    assert EXPORT_MEDIA_TYPES[export_format]


def test_an_unknown_format_is_refused_with_a_stable_code() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        export_run(_record(), "tap")
    assert exc.value.code == "evidence-export-format-unsupported"
