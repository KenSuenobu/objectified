"""Tests for the verification-evidence contract (ECA-1.3, #4731).

``app.verification_evidence`` is the pure, database-free half of the evidence schema. These tests
pin the guarantees the ticket's acceptance criteria turn into rules rather than habits:

* a record retains the suite digest, the target identity, timing, the outcome, and per-operation
  failures — and refuses a submission that would leave any of those unstated;
* a verdict is **derived** from the case records, so an upload cannot record a green run over red
  cases;
* artifacts are **redacted and linked**: a ``data:`` URI, a credential-bearing link, and an
  unredacted reference are all refused, and free text is scrubbed before it is stored;
* stored rows reassemble into exactly the record the exporters read.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import pytest

from app.verification_evidence import (
    ARTIFACT_KINDS,
    ASSERTION_KINDS,
    CODE_ARTIFACT_EMBEDDED,
    CODE_ARTIFACT_UNREDACTED,
    CODE_ARTIFACT_URI_INVALID,
    CODE_DUPLICATE_CASE,
    CODE_FAILURE_DETAIL_REQUIRED,
    CODE_NO_OPERATIONS,
    CODE_OUTCOME_MISMATCH,
    CODE_SUITE_DIGEST_INVALID,
    CODE_TIMING_INVALID,
    FIELD_TEXT_LIMIT,
    MESSAGE_TEXT_LIMIT,
    OPERATION_OUTCOMES,
    RUN_OUTCOME_CANCELLED,
    RUN_OUTCOME_ERRORED,
    RUN_OUTCOME_FAILED,
    RUN_OUTCOME_PASSED,
    RUN_OUTCOMES,
    ArtifactReferenceInput,
    AssertionInput,
    EvidenceValidationError,
    OperationResultInput,
    VerificationRunInput,
    derive_counts,
    derive_outcome,
    duration_ms_between,
    record_from_rows,
    redact_text,
    summary_from_row,
    validate_artifact_uri,
    validate_run_input,
)

_DIGEST = "sha256:" + "a" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
_END = _START + timedelta(seconds=5)
_RUN = "33333333-3333-4333-8333-333333333333"
_OPERATION = "44444444-4444-4444-8444-444444444444"


def _operation(**overrides: Any) -> OperationResultInput:
    """A passing case record, as a runner submits one."""
    payload: Dict[str, Any] = {
        "case_id": "get-pets-example-1",
        "operation_key": "GET /pets",
        "http_method": "GET",
        "http_path": "/pets",
        "outcome": "passed",
        "expected_status": "200",
        "actual_status": 200,
        "started_at": _START,
        "finished_at": _START + timedelta(milliseconds=120),
        "duration_ms": 120,
    }
    payload.update(overrides)
    return OperationResultInput(**payload)


def _run(**overrides: Any) -> VerificationRunInput:
    """A valid submission carrying one passing case."""
    payload: Dict[str, Any] = {
        "target_ref": "staging",
        "suite_digest": _DIGEST,
        "runner_name": "apiome-contract-runner",
        "started_at": _START,
        "finished_at": _END,
        "operations": [_operation()],
    }
    payload.update(overrides)
    return VerificationRunInput(**payload)


# ===========================================================================
# Vocabularies — must stay in lock-step with the V212 CHECK constraints
# ===========================================================================


def test_the_run_vocabulary_separates_a_contract_failure_from_an_execution_failure() -> None:
    assert RUN_OUTCOMES == ("passed", "failed", "errored", "cancelled")
    assert OPERATION_OUTCOMES == ("passed", "failed", "errored", "skipped")


def test_assertion_and_artifact_vocabularies_are_closed() -> None:
    assert ASSERTION_KINDS == (
        "status_code",
        "response_schema",
        "header",
        "content_type",
        "latency",
        "custom",
    )
    assert ARTIFACT_KINDS == (
        "request",
        "response",
        "log",
        "har",
        "report",
        "diff",
        "other",
    )


@pytest.mark.parametrize("kind", ["teapot", "", "STATUS_CODE"])
def test_an_assertion_kind_outside_the_vocabulary_is_refused(kind: str) -> None:
    with pytest.raises(ValueError):
        AssertionInput(kind=kind, outcome="passed")


def test_a_case_outcome_outside_the_vocabulary_is_refused() -> None:
    with pytest.raises(ValueError):
        _operation(outcome="flaky")


def test_a_method_is_stored_upper_cased_so_runs_group_across_uploads() -> None:
    assert _operation(http_method="get").http_method == "GET"


# ===========================================================================
# Derivation — the verdict comes from the records
# ===========================================================================


def test_counts_always_sum_to_the_total() -> None:
    counts = derive_counts(
        [
            _operation(case_id="a", outcome="passed"),
            _operation(case_id="b", outcome="failed", failure_code="status-mismatch"),
            _operation(case_id="c", outcome="errored", failure_code="transport-error"),
            _operation(case_id="d", outcome="skipped"),
        ]
    )
    assert counts == {"total": 4, "passed": 1, "failed": 1, "errored": 1, "skipped": 1}
    assert (
        counts["passed"] + counts["failed"] + counts["errored"] + counts["skipped"]
        == counts["total"]
    )


def test_an_unexecutable_case_outranks_a_contract_failure() -> None:
    # A gate must be able to tell "the implementation is incompatible" from "we never found out".
    assert derive_outcome({"failed": 3, "errored": 1}) == RUN_OUTCOME_ERRORED
    assert derive_outcome({"failed": 1, "errored": 0}) == RUN_OUTCOME_FAILED
    assert derive_outcome({"failed": 0, "errored": 0}) == RUN_OUTCOME_PASSED


def test_a_run_of_only_skipped_cases_passes_and_says_so_in_its_counts() -> None:
    counts = derive_counts([_operation(outcome="skipped")])
    assert derive_outcome(counts) == RUN_OUTCOME_PASSED
    assert counts["passed"] == 0 and counts["skipped"] == 1


def test_a_cancelled_run_is_never_derived_because_no_record_implies_it() -> None:
    assert derive_outcome({"failed": 0, "errored": 0}) != RUN_OUTCOME_CANCELLED


def test_duration_is_milliseconds_and_never_negative() -> None:
    assert duration_ms_between(_START, _START + timedelta(milliseconds=1500)) == 1500
    assert duration_ms_between(_END, _START) == 0


# ===========================================================================
# Validation — a failure always says why
# ===========================================================================


def test_a_valid_submission_returns_its_derived_counts() -> None:
    assert validate_run_input(_run())["total"] == 1


@pytest.mark.parametrize(
    "digest",
    ["", "sha256:abc", "a" * 64, "sha512:" + "a" * 64, "sha256:" + "A" * 64],
)
def test_a_suite_digest_that_is_not_the_compiler_form_is_refused(digest: str) -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(suite_digest=digest))
    assert exc.value.code == CODE_SUITE_DIGEST_INVALID


def test_a_run_that_finished_before_it_started_is_refused() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(started_at=_END, finished_at=_START))
    assert exc.value.code == CODE_TIMING_INVALID


@pytest.mark.parametrize(
    "window",
    [
        {"started_at": _START - timedelta(seconds=1), "finished_at": _START},
        {"started_at": _START, "finished_at": _END + timedelta(seconds=1)},
        {"started_at": _END, "finished_at": _START},
    ],
)
def test_a_case_outside_its_run_window_is_refused(window: Dict[str, Any]) -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[_operation(**window)]))
    assert exc.value.code == CODE_TIMING_INVALID


def test_a_run_with_no_cases_is_not_evidence() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[]))
    assert exc.value.code == CODE_NO_OPERATIONS


def test_a_run_that_stopped_before_executing_anything_declares_itself_cancelled() -> None:
    counts = validate_run_input(_run(operations=[], outcome=RUN_OUTCOME_CANCELLED))
    assert counts["total"] == 0


@pytest.mark.parametrize("outcome", ["failed", "errored"])
def test_a_non_passing_case_must_carry_a_failure_code(outcome: str) -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[_operation(outcome=outcome)]))
    assert exc.value.code == CODE_FAILURE_DETAIL_REQUIRED


def test_a_passing_case_may_not_carry_a_failure_code() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(
            _run(operations=[_operation(outcome="passed", failure_code="status-mismatch")])
        )
    assert exc.value.code == CODE_OUTCOME_MISMATCH


def test_a_failed_assertion_must_carry_a_code() -> None:
    operation = _operation(
        outcome="failed",
        failure_code="response-schema-invalid",
        assertions=[AssertionInput(kind="response_schema", outcome="failed")],
    )
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[operation]))
    assert exc.value.code == CODE_FAILURE_DETAIL_REQUIRED


def test_a_passing_case_containing_a_failed_assertion_is_refused() -> None:
    # The precise lie evidence must not be able to tell.
    operation = _operation(
        outcome="passed",
        assertions=[
            AssertionInput(kind="status_code", outcome="failed", code="status-mismatch")
        ],
    )
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[operation]))
    assert exc.value.code == CODE_OUTCOME_MISMATCH


def test_the_same_case_recorded_twice_is_refused() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[_operation(), _operation()]))
    assert exc.value.code == CODE_DUPLICATE_CASE


def test_a_declared_outcome_that_contradicts_the_cases_is_refused() -> None:
    failing = _operation(outcome="failed", failure_code="status-mismatch")
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[failing], outcome=RUN_OUTCOME_PASSED))
    assert exc.value.code == CODE_OUTCOME_MISMATCH


def test_a_declared_outcome_that_agrees_with_the_cases_is_accepted() -> None:
    failing = _operation(outcome="failed", failure_code="status-mismatch")
    assert validate_run_input(_run(operations=[failing], outcome=RUN_OUTCOME_FAILED))["failed"] == 1


def test_cancelled_is_taken_on_the_runners_word_even_over_failing_cases() -> None:
    failing = _operation(outcome="failed", failure_code="status-mismatch")
    counts = validate_run_input(_run(operations=[failing], outcome=RUN_OUTCOME_CANCELLED))
    assert counts["failed"] == 1


def test_an_unknown_run_outcome_is_refused_by_the_model() -> None:
    with pytest.raises(ValueError):
        _run(outcome="green")


# ===========================================================================
# Artifacts — linked, redacted, verifiable
# ===========================================================================


@pytest.mark.parametrize(
    "uri",
    [
        "https://artifacts.example.com/run/1/response.json",
        "s3://tenant-artifacts/run/1/response.json",
        "gs://tenant-artifacts/run/1/response.json",
        "runs/1/response.json",
    ],
)
def test_a_link_to_stored_bytes_is_accepted(uri: str) -> None:
    assert validate_artifact_uri(uri) == uri


def test_a_data_uri_is_refused_because_it_embeds_rather_than_links() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_artifact_uri("data:application/json;base64,eyJhIjoxfQ==")
    assert exc.value.code == CODE_ARTIFACT_EMBEDDED


def test_an_artifact_link_may_not_carry_credentials() -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_artifact_uri("https://user:hunter2@artifacts.example.com/run/1.json")
    assert exc.value.code == CODE_ARTIFACT_URI_INVALID


@pytest.mark.parametrize("uri", ["file:///etc/passwd", "javascript:alert(1)", "  "])
def test_an_unsupported_artifact_scheme_is_refused(uri: str) -> None:
    with pytest.raises(EvidenceValidationError) as exc:
        validate_artifact_uri(uri)
    assert exc.value.code == CODE_ARTIFACT_URI_INVALID


def test_an_artifact_that_does_not_claim_redaction_is_refused() -> None:
    artifact = ArtifactReferenceInput(
        kind="response", uri="s3://bucket/run/1.json", redacted=False
    )
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(artifacts=[artifact]))
    assert exc.value.code == CODE_ARTIFACT_UNREDACTED


def test_a_case_artifact_is_validated_the_same_way_as_a_run_artifact() -> None:
    operation = _operation(
        artifacts=[ArtifactReferenceInput(kind="response", uri="data:text/plain,hello")]
    )
    with pytest.raises(EvidenceValidationError) as exc:
        validate_run_input(_run(operations=[operation]))
    assert exc.value.code == CODE_ARTIFACT_EMBEDDED


def test_a_content_hash_must_be_a_sha256_hex_digest() -> None:
    with pytest.raises(ValueError):
        ArtifactReferenceInput(kind="log", uri="runs/1.log", content_sha256="nope")
    assert (
        ArtifactReferenceInput(kind="log", uri="runs/1.log", content_sha256="b" * 64).content_sha256
        == "b" * 64
    )


def test_an_artifact_reference_has_no_field_for_content() -> None:
    # ``extra="forbid"`` is what makes "linked, not embedded" structural rather than advisory.
    with pytest.raises(ValueError):
        ArtifactReferenceInput(kind="log", uri="runs/1.log", content="the whole body")


# ===========================================================================
# Redaction
# ===========================================================================


@pytest.mark.parametrize(
    "text",
    [
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789",
        "token=aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g",
        "connect https://user:hunter2@internal.example.com/api",
    ],
)
def test_a_credential_quoted_by_a_runner_never_reaches_storage(text: str) -> None:
    redacted = redact_text(text)
    assert "«redacted»" in (redacted or "")
    assert "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789" not in (redacted or "")
    assert "aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g" not in (redacted or "")
    assert "hunter2" not in (redacted or "")


def test_redaction_happens_before_truncation_so_nothing_survives_by_being_long() -> None:
    padded = "x" * (MESSAGE_TEXT_LIMIT - 10) + " token=aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g"
    redacted = redact_text(padded) or ""
    assert "aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g" not in redacted
    assert len(redacted) <= MESSAGE_TEXT_LIMIT + 1


def test_a_truncated_message_says_so() -> None:
    assert (redact_text("y" * (MESSAGE_TEXT_LIMIT + 50)) or "").endswith("…")


def test_none_passes_through_redaction() -> None:
    assert redact_text(None) is None


def test_a_failure_message_is_redacted_when_the_model_is_built() -> None:
    operation = _operation(
        outcome="failed",
        failure_code="status-mismatch",
        failure_message="upstream said token=aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g",
    )
    assert "aX9fK2mQ7pL0zR4tYw8vB1nC5jH3sD6g" not in (operation.failure_message or "")


def test_assertion_renderings_are_redacted_and_bounded_tighter_than_messages() -> None:
    assertion = AssertionInput(
        kind="response_schema",
        outcome="failed",
        code="response-schema-invalid",
        actual="z" * (FIELD_TEXT_LIMIT + 100),
    )
    assert len(assertion.actual or "") <= FIELD_TEXT_LIMIT + 1
    assert FIELD_TEXT_LIMIT < MESSAGE_TEXT_LIMIT


# ===========================================================================
# Row assembly
# ===========================================================================


def _run_row(**overrides: Any) -> Dict[str, Any]:
    """A stored ``verification_run`` row, as the data layer returns one."""
    row: Dict[str, Any] = {
        "id": _RUN,
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "suite_digest": _DIGEST,
        "suite_schema_version": 1,
        "suite_compiler_version": 1,
        "suite_case_count": 12,
        "target_id": "22222222-2222-4222-8222-222222222222",
        "target_slug": "staging",
        "target_environment": "staging",
        "target_network_class": "public",
        "target_base_url": "https://staging.example.com/api",
        "runner_name": "apiome-contract-runner",
        "runner_version": "1.0.0",
        "recorded_by": None,
        "actor_label": "ci-key",
        "actor_kind": "api_key",
        "started_at": _START,
        "finished_at": _END,
        "duration_ms": 5000,
        "outcome": "failed",
        "total_cases": 2,
        "passed_cases": 1,
        "failed_cases": 1,
        "errored_cases": 0,
        "skipped_cases": 0,
        "source": {"kind": "project", "reference": "project/petstore/1.0.0"},
        "context": {"commit": "abc123"},
        "idempotency_key": None,
        "created_at": _END,
    }
    row.update(overrides)
    return row


def _operation_rows() -> List[Dict[str, Any]]:
    """Two stored case rows, in stored order."""
    return [
        {
            "id": _OPERATION,
            "run_id": _RUN,
            "sequence": 0,
            "case_id": "get-pets-example-1",
            "operation_key": "GET /pets",
            "operation_name": "listPets",
            "case_source": "declared_example",
            "http_method": "GET",
            "http_path": "/pets",
            "outcome": "passed",
            "failure_code": None,
            "failure_message": None,
            "expected_status": "200",
            "actual_status": 200,
            "started_at": _START,
            "finished_at": _START + timedelta(milliseconds=120),
            "duration_ms": 120,
            "attempts": 1,
        },
        {
            "id": "55555555-5555-4555-8555-555555555555",
            "run_id": _RUN,
            "sequence": 1,
            "case_id": "get-pet-negative-1",
            "operation_key": "GET /pets/{petId}",
            "operation_name": "getPet",
            "case_source": "negative",
            "http_method": "GET",
            "http_path": "/pets/abc",
            "outcome": "failed",
            "failure_code": "status-mismatch",
            "failure_message": "expected 400, got 500",
            "expected_status": "400",
            "actual_status": 500,
            "started_at": _START,
            "finished_at": _START + timedelta(milliseconds=300),
            "duration_ms": 300,
            "attempts": 2,
        },
    ]


def test_a_summary_folds_the_count_columns_into_the_counts_block() -> None:
    summary = summary_from_row(_run_row())
    assert summary.counts == {"total": 2, "passed": 1, "failed": 1, "errored": 0, "skipped": 0}
    assert summary.target_slug == "staging"
    assert summary.suite_digest == _DIGEST


def test_rows_reassemble_into_one_record_with_children_attached_to_their_case() -> None:
    assertions = [
        {
            "id": "66666666-6666-4666-8666-666666666666",
            "operation_id": "55555555-5555-4555-8555-555555555555",
            "sequence": 0,
            "kind": "status_code",
            "outcome": "failed",
            "subject": None,
            "expected": "400",
            "actual": "500",
            "code": "status-mismatch",
            "message": "the contract declares 400 for an invalid id",
        }
    ]
    artifacts = [
        {
            "id": "77777777-7777-4777-8777-777777777777",
            "operation_id": "55555555-5555-4555-8555-555555555555",
            "kind": "response",
            "label": "response body",
            "media_type": "application/json",
            "uri": "s3://tenant-artifacts/run/1/case-2.json",
            "size_bytes": 512,
            "content_sha256": "c" * 64,
            "redacted": True,
            "redaction": {"headers": 2},
        },
        {
            "id": "88888888-8888-4888-8888-888888888888",
            "operation_id": None,
            "kind": "log",
            "label": "runner log",
            "media_type": "text/plain",
            "uri": "s3://tenant-artifacts/run/1/runner.log",
            "size_bytes": 90210,
            "content_sha256": None,
            "redacted": True,
            "redaction": {},
        },
    ]
    record = record_from_rows(_run_row(), _operation_rows(), assertions, artifacts)

    assert [operation.case_id for operation in record.operations] == [
        "get-pets-example-1",
        "get-pet-negative-1",
    ]
    assert record.operations[0].assertions == []
    assert record.operations[1].assertions[0].code == "status-mismatch"
    assert record.operations[1].artifacts[0].uri.endswith("case-2.json")
    # A run-level artifact stays on the run rather than being attached to an arbitrary case.
    assert [artifact.kind for artifact in record.artifacts] == ["log"]


def test_a_record_with_no_children_still_reads() -> None:
    record = record_from_rows(_run_row(total_cases=0, passed_cases=0, failed_cases=0))
    assert record.operations == []
    assert record.artifacts == []
    assert record.counts["total"] == 0


def test_a_legacy_row_with_a_non_object_json_column_degrades_to_an_empty_dict() -> None:
    record = record_from_rows(_run_row(source=None, context="not-an-object"))
    assert record.source == {}
    assert record.context == {}
