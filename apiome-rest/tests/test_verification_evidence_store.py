"""Tests for the verification-evidence store (ECA-1.3, #4731).

``app.verification_evidence_store`` is the single door between the pure contract and the four
``verification_run*`` tables. These tests pin what that door applies, against a stubbed data layer:

* a submission the database would reject never reaches it, and the expensive work (the target read,
  the insert) never happens for a submission that was already wrong;
* a run records the target **identity as it was**, read rather than resolved — recording history
  must not fail because the target has since been disabled, nor pretend a fresh selection happened;
* the whole tree is handed over in one call, because immutable evidence cannot be written in parts;
* a replayed ``idempotency_key`` returns the original run instead of minting a second one, whether
  the duplicate is sequential or loses a race to the unique index.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from app.verification_evidence import (
    CODE_RUN_NOT_FOUND,
    CODE_SUITE_DIGEST_INVALID,
    CODE_TARGET_NOT_FOUND,
    RUN_OUTCOME_CANCELLED,
    ArtifactReferenceInput,
    AssertionInput,
    EvidenceValidationError,
    OperationResultInput,
    VerificationRunInput,
)
from app.verification_evidence_store import (
    TargetActor,
    actor_from_auth,
    get_run,
    list_runs,
    record_run,
)
from app.verification_target import (
    NETWORK_CLASS_PUBLIC,
    TargetAuthReference,
    TargetValidationError,
    VerificationPolicy,
    VerificationTargetRecord,
)
from app.verification_target_store import ACTOR_KIND_API_KEY, ACTOR_KIND_USER

_TENANT = "11111111-1111-4111-8111-111111111111"
_TARGET = "22222222-2222-4222-8222-222222222222"
_RUN = "33333333-3333-4333-8333-333333333333"
_USER = "44444444-4444-4444-8444-444444444444"
_DIGEST = "sha256:" + "a" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
_END = _START + timedelta(seconds=5)

_ACTOR = TargetActor(user_id=_USER, label="ada@example.com", kind=ACTOR_KIND_USER)
_RUNNER = TargetActor(user_id=_USER, label="ci-key", kind=ACTOR_KIND_API_KEY)


def _target(**overrides: Any) -> VerificationTargetRecord:
    """A stored target, as :func:`app.verification_target_store.get_target` returns one."""
    payload: Dict[str, Any] = {
        "id": _TARGET,
        "tenant_id": _TENANT,
        "slug": "staging",
        "name": "Staging",
        "environment": "staging",
        "base_url": "https://staging.example.com/api",
        "network_class": NETWORK_CLASS_PUBLIC,
        "auth": TargetAuthReference(),
        "policy": VerificationPolicy(),
        "enabled": True,
    }
    payload.update(overrides)
    return VerificationTargetRecord(**payload)


def _operation(**overrides: Any) -> OperationResultInput:
    """A passing case record."""
    payload: Dict[str, Any] = {
        "case_id": "get-pets-example-1",
        "operation_key": "GET /pets",
        "http_method": "GET",
        "http_path": "/pets",
        "outcome": "passed",
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


def _run_row(**overrides: Any) -> Dict[str, Any]:
    """A stored ``verification_run`` row."""
    row: Dict[str, Any] = {
        "id": _RUN,
        "tenant_id": _TENANT,
        "suite_digest": _DIGEST,
        "suite_schema_version": None,
        "suite_compiler_version": None,
        "suite_case_count": None,
        "target_id": _TARGET,
        "target_slug": "staging",
        "target_environment": "staging",
        "target_network_class": "public",
        "target_base_url": "https://staging.example.com/api",
        "runner_name": "apiome-contract-runner",
        "runner_version": None,
        "recorded_by": _USER,
        "actor_label": "ada@example.com",
        "actor_kind": "user",
        "started_at": _START,
        "finished_at": _END,
        "duration_ms": 5000,
        "outcome": "passed",
        "total_cases": 1,
        "passed_cases": 1,
        "failed_cases": 0,
        "errored_cases": 0,
        "skipped_cases": 0,
        "source": {},
        "context": {},
        "idempotency_key": None,
        "created_at": _END,
    }
    row.update(overrides)
    return row


class _FakeDb:
    """A stand-in for the data layer that records what the store asked it to do."""

    def __init__(
        self,
        *,
        run_row: Optional[Dict[str, Any]] = None,
        existing: Optional[Dict[str, Any]] = None,
        insert_error: Optional[Exception] = None,
    ) -> None:
        """Build the double.

        Args:
            run_row: The row every run read returns.
            existing: The row an idempotency-key lookup returns, if any.
            insert_error: Raised by the insert, to simulate a unique-index race.
        """
        self.run_row = run_row if run_row is not None else _run_row()
        self.existing = existing
        self.insert_error = insert_error
        self.inserts: List[Dict[str, Any]] = []
        self.idempotency_lookups: List[str] = []
        self.list_calls: List[Dict[str, Any]] = []

    def insert_verification_evidence(
        self,
        *,
        run: Dict[str, Any],
        operations: Optional[List[Dict[str, Any]]] = None,
        artifacts: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional[Dict[str, Any]]:
        self.inserts.append(
            {"run": run, "operations": operations or [], "artifacts": artifacts or []}
        )
        if self.insert_error is not None:
            raise self.insert_error
        return self.run_row

    def get_verification_run(self, run_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.run_row if run_id == str(self.run_row["id"]) else None

    def get_verification_run_by_idempotency_key(
        self, tenant_id: str, idempotency_key: str
    ) -> Optional[Dict[str, Any]]:
        self.idempotency_lookups.append(idempotency_key)
        return self.existing

    def list_verification_run_operations(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def list_verification_run_assertions(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def list_verification_run_artifacts(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def list_verification_runs(self, tenant_id: str, **kwargs: Any) -> List[Dict[str, Any]]:
        self.list_calls.append({"tenant_id": tenant_id, **kwargs})
        return [self.run_row]


def _with(fake: _FakeDb, target: Optional[VerificationTargetRecord] = None):
    """Patch the store's data layer and target read for the duration of a test."""
    return patch.multiple(
        "app.verification_evidence_store",
        db=fake,
        get_target=MagicMock(return_value=target if target is not None else _target()),
    )


# ===========================================================================
# Recording
# ===========================================================================


def test_recording_writes_the_whole_run_in_one_call() -> None:
    fake = _FakeDb()
    with _with(fake):
        recorded = record_run(_TENANT, _run(), actor=_ACTOR)

    assert recorded.created is True
    assert recorded.record.id == _RUN
    assert len(fake.inserts) == 1
    assert len(fake.inserts[0]["operations"]) == 1


def test_a_run_records_the_derived_verdict_and_counts_not_the_claim() -> None:
    fake = _FakeDb()
    submission = _run(
        operations=[
            _operation(),
            _operation(case_id="c2", outcome="failed", failure_code="status-mismatch"),
        ]
    )
    with _with(fake):
        record_run(_TENANT, submission, actor=_ACTOR)

    stored = fake.inserts[0]["run"]
    assert stored["outcome"] == "failed"
    assert stored["total_cases"] == 2
    assert stored["failed_cases"] == 1
    assert stored["passed_cases"] == 1


def test_a_cancelled_run_keeps_the_runners_word() -> None:
    fake = _FakeDb()
    with _with(fake):
        record_run(_TENANT, _run(outcome=RUN_OUTCOME_CANCELLED), actor=_ACTOR)
    assert fake.inserts[0]["run"]["outcome"] == RUN_OUTCOME_CANCELLED


def test_the_run_duration_is_derived_from_its_own_window() -> None:
    fake = _FakeDb()
    with _with(fake):
        record_run(_TENANT, _run(), actor=_ACTOR)
    assert fake.inserts[0]["run"]["duration_ms"] == 5000


def test_a_run_snapshots_the_target_identity_and_no_credential_reference() -> None:
    fake = _FakeDb()
    target = _target(
        auth=TargetAuthReference(kind="env", scheme="bearer", ref="APIOME_STAGING_TOKEN")
    )
    with _with(fake, target):
        record_run(_TENANT, _run(), actor=_ACTOR)

    stored = fake.inserts[0]["run"]
    assert stored["target_id"] == _TARGET
    assert stored["target_slug"] == "staging"
    assert stored["target_environment"] == "staging"
    assert stored["target_network_class"] == "public"
    assert stored["target_base_url"] == "https://staging.example.com/api"
    # The identity block deliberately omits the credential reference.
    assert "APIOME_STAGING_TOKEN" not in repr(stored)


def test_a_retired_or_disabled_target_can_still_be_recorded_against() -> None:
    # Recording what already happened is not a selection: it must not fail because the target has
    # since been disabled, and it must not write an ECA-1.2 resolve entry claiming otherwise.
    fake = _FakeDb()
    get_target = MagicMock(return_value=_target(enabled=False, deleted_at=_START))
    with patch.multiple("app.verification_evidence_store", db=fake, get_target=get_target):
        record_run(_TENANT, _run(), actor=_ACTOR)

    assert get_target.call_args.kwargs["include_deleted"] is True
    assert len(fake.inserts) == 1


def test_a_run_naming_an_unknown_target_is_refused() -> None:
    fake = _FakeDb()
    get_target = MagicMock(side_effect=TargetValidationError("target-not-found", "nope"))
    with patch.multiple("app.verification_evidence_store", db=fake, get_target=get_target):
        with pytest.raises(EvidenceValidationError) as exc:
            record_run(_TENANT, _run(), actor=_ACTOR)

    assert exc.value.code == CODE_TARGET_NOT_FOUND
    assert fake.inserts == []


def test_a_submission_that_is_wrong_never_costs_a_target_read_or_an_insert() -> None:
    fake = _FakeDb()
    get_target = MagicMock(return_value=_target())
    with patch.multiple("app.verification_evidence_store", db=fake, get_target=get_target):
        with pytest.raises(EvidenceValidationError) as exc:
            record_run(_TENANT, _run(suite_digest="not-a-digest"), actor=_ACTOR)

    assert exc.value.code == CODE_SUITE_DIGEST_INVALID
    assert get_target.call_count == 0
    assert fake.inserts == []


def test_cases_are_stored_in_submission_order() -> None:
    fake = _FakeDb()
    submission = _run(
        operations=[
            _operation(case_id="first"),
            _operation(case_id="second"),
            _operation(case_id="third"),
        ]
    )
    with _with(fake):
        record_run(_TENANT, submission, actor=_ACTOR)

    stored = fake.inserts[0]["operations"]
    assert [(row["sequence"], row["case_id"]) for row in stored] == [
        (0, "first"),
        (1, "second"),
        (2, "third"),
    ]


def test_assertions_and_artifacts_travel_with_their_case() -> None:
    fake = _FakeDb()
    operation = _operation(
        outcome="failed",
        failure_code="status-mismatch",
        assertions=[
            AssertionInput(kind="status_code", outcome="failed", code="status-mismatch")
        ],
        artifacts=[ArtifactReferenceInput(kind="response", uri="s3://bucket/run/1.json")],
    )
    with _with(fake):
        record_run(_TENANT, _run(operations=[operation]), actor=_ACTOR)

    stored = fake.inserts[0]["operations"][0]
    assert stored["assertions"][0]["code"] == "status-mismatch"
    assert stored["artifacts"][0]["uri"] == "s3://bucket/run/1.json"
    assert stored["artifacts"][0]["redacted"] is True


def test_a_run_level_artifact_is_kept_off_the_cases() -> None:
    fake = _FakeDb()
    artifact = ArtifactReferenceInput(kind="log", uri="s3://bucket/run/1/runner.log")
    with _with(fake):
        record_run(_TENANT, _run(artifacts=[artifact]), actor=_ACTOR)

    assert fake.inserts[0]["artifacts"][0]["kind"] == "log"
    assert fake.inserts[0]["operations"][0]["artifacts"] == []


def test_the_recording_actor_is_stored_and_a_runner_stays_distinguishable() -> None:
    fake = _FakeDb()
    with _with(fake):
        record_run(_TENANT, _run(), actor=_RUNNER)

    stored = fake.inserts[0]["run"]
    assert stored["recorded_by"] == _USER
    assert stored["actor_kind"] == ACTOR_KIND_API_KEY
    assert stored["actor_label"] == "ci-key"


def test_an_api_key_caller_is_recorded_as_a_runner() -> None:
    actor = actor_from_auth({"auth_method": "api_key", "user_email": "ci@example.com"}, _USER)
    assert actor.kind == ACTOR_KIND_API_KEY
    assert actor.user_id == _USER


def test_a_run_with_no_tenant_context_is_refused_rather_than_silently_dropped() -> None:
    fake = _FakeDb()
    fake.insert_verification_evidence = lambda **_: None  # type: ignore[assignment]
    with _with(fake):
        with pytest.raises(EvidenceValidationError) as exc:
            record_run(_TENANT, _run(), actor=_ACTOR)
    assert exc.value.code == CODE_RUN_NOT_FOUND


# ===========================================================================
# Idempotency
# ===========================================================================


def test_a_repeated_upload_returns_the_original_run_rather_than_a_duplicate() -> None:
    fake = _FakeDb(existing=_run_row(idempotency_key="build-42"))
    with _with(fake):
        recorded = record_run(_TENANT, _run(idempotency_key="build-42"), actor=_ACTOR)

    assert recorded.created is False
    assert recorded.record.id == _RUN
    assert fake.inserts == []
    assert fake.idempotency_lookups == ["build-42"]


def test_losing_the_unique_index_race_answers_with_the_winners_run() -> None:
    fake = _FakeDb(insert_error=RuntimeError("duplicate key value violates unique constraint"))
    fake.existing = None

    lookups: List[Optional[Dict[str, Any]]] = [None, _run_row(idempotency_key="build-42")]

    def _lookup(tenant_id: str, idempotency_key: str) -> Optional[Dict[str, Any]]:
        return lookups.pop(0)

    fake.get_verification_run_by_idempotency_key = _lookup  # type: ignore[assignment]
    with _with(fake):
        recorded = record_run(_TENANT, _run(idempotency_key="build-42"), actor=_ACTOR)

    assert recorded.created is False
    assert recorded.record.id == _RUN


def test_an_insert_failure_that_is_not_a_duplicate_is_raised() -> None:
    fake = _FakeDb(insert_error=RuntimeError("connection reset"))
    with _with(fake):
        with pytest.raises(RuntimeError, match="connection reset"):
            record_run(_TENANT, _run(idempotency_key="build-42"), actor=_ACTOR)


def test_a_run_without_a_key_never_costs_an_idempotency_lookup() -> None:
    fake = _FakeDb()
    with _with(fake):
        record_run(_TENANT, _run(), actor=_ACTOR)
    assert fake.idempotency_lookups == []


# ===========================================================================
# Reading
# ===========================================================================


def test_reading_a_run_assembles_it_from_the_four_tables() -> None:
    fake = _FakeDb()
    fake.list_verification_run_operations = lambda run_id, tenant_id: [  # type: ignore[assignment]
        {
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sequence": 0,
            "case_id": "get-pets-example-1",
            "operation_key": "GET /pets",
            "http_method": "GET",
            "http_path": "/pets",
            "outcome": "passed",
            "duration_ms": 120,
            "attempts": 1,
        }
    ]
    fake.list_verification_run_artifacts = lambda run_id, tenant_id: [  # type: ignore[assignment]
        {
            "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "operation_id": None,
            "kind": "log",
            "uri": "s3://bucket/run/1/runner.log",
            "redacted": True,
            "redaction": {},
        }
    ]
    with _with(fake):
        record = get_run(_TENANT, _RUN)

    assert record.operations[0].case_id == "get-pets-example-1"
    assert record.artifacts[0].kind == "log"


def test_reading_a_run_from_another_tenant_reads_as_absent() -> None:
    fake = _FakeDb()
    with _with(fake):
        with pytest.raises(EvidenceValidationError) as exc:
            get_run(_TENANT, "99999999-9999-4999-8999-999999999999")
    assert exc.value.code == CODE_RUN_NOT_FOUND


def test_listing_passes_the_gate_filters_through_and_clamps_the_limit() -> None:
    fake = _FakeDb()
    with _with(fake):
        summaries = list_runs(
            _TENANT, target_id=_TARGET, suite_digest=_DIGEST, outcome="failed", limit=10_000
        )

    assert len(summaries) == 1
    call = fake.list_calls[0]
    assert call["target_id"] == _TARGET
    assert call["suite_digest"] == _DIGEST
    assert call["outcome"] == "failed"
    assert call["limit"] == 200
