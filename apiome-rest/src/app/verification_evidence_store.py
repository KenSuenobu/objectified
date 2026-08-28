"""Persistence for verification evidence — ECA-1.3 (#4731).

:mod:`app.verification_evidence` defines *what* evidence is; this module is the only place a run is
written or read, so the schema's guarantees are applied once rather than at each call site:

**A run is written whole, in one transaction, or not at all.** :func:`record_run` validates the
submission, derives the counts and the verdict, and hands the whole tree — run, cases, assertions,
artifact references — to a single database call. There is no "open a run / append / close it" path,
which is what makes V212's blanket UPDATE rejection something the application can actually live
with: partial evidence is never stored, so it never needs fixing up.

**A run names the target it used, not the target as it is now.** The ECA-1.2 record is read once to
snapshot its identity (:func:`app.verification_target.target_identity`), and the snapshot is what
the evidence carries. Note this is deliberately a *read*, not a ``resolve``: resolution is the
audited moment a definition becomes traffic, and it re-checks DNS and the enabled flag. Recording
what already happened must not fail because the target has since been disabled — or worse, write an
audit entry claiming a fresh selection.

**A mock-targeted run always says which mock.** A run whose target environment is ``mock`` is
written with a mock attestation row either way: the submitted one, or — when nothing was attached —
an explicitly *missing* one (:func:`app.mock_attestation.missing_mock_attestation`). Storing nothing
would read identically to a run that never involved a mock, and telling those two apart is the whole
point of PMR-3.2.

**A retried upload does not mint a second run.** Evidence is immutable, so a runner that uploads and
loses the response has no way to correct a duplicate. An ``idempotency_key`` is looked up before the
insert and again if the unique index rejects a concurrent one, and the original run is returned.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .database import db
from .mock_attestation import MockAttestationRecord, missing_mock_attestation
from .verification_evidence import (
    CODE_RUN_NOT_FOUND,
    CODE_TARGET_NOT_FOUND,
    RUN_OUTCOME_CANCELLED,
    ArtifactReferenceInput,
    EvidenceValidationError,
    OperationResultInput,
    VerificationRunInput,
    VerificationRunRecord,
    VerificationRunSummary,
    derive_outcome,
    duration_ms_between,
    record_from_rows,
    summary_from_row,
    validate_mock_attestation_input,
    validate_run_input,
)
from .verification_target import ENVIRONMENT_MOCK, TargetValidationError, target_identity
from .verification_target_store import TargetActor, actor_from_auth, get_target

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_LIST_LIMIT",
    "MOCK_TARGET_ENVIRONMENT",
    "RecordedRun",
    "TargetActor",
    "actor_from_auth",
    "get_run",
    "list_runs",
    "record_run",
]

#: Ceiling on a list read, mirroring the store-side clamp. A gate asks for the newest few; nobody
#: needs a tenant's entire history in one response.
MAX_LIST_LIMIT = 200

#: The ECA-1.2 environment class that means "this ran against a mock" — re-exported rather than
#: re-spelled, so the two modules cannot drift. A run in this environment must say which mock it
#: used, even when the answer is "it did not say" (PMR-3.2, #4749).
MOCK_TARGET_ENVIRONMENT = ENVIRONMENT_MOCK


@dataclass(frozen=True)
class RecordedRun:
    """The outcome of a record attempt.

    ``created`` is what lets the route answer ``201`` for new evidence and ``200`` for an
    idempotent replay without having to guess from the record itself — a distinction the caller
    cannot reconstruct, since a replay returns the original record verbatim.

    Attributes:
        record: The stored evidence.
        created: True when this call wrote the run; False when an ``idempotency_key`` matched an
            existing one and that run was returned instead.
    """

    record: VerificationRunRecord
    created: bool


def _target_snapshot(tenant_id: str, target_ref: str) -> Dict[str, Any]:
    """Read the named target and return the identity block the evidence embeds.

    Args:
        tenant_id: The caller's tenant.
        target_ref: The target's slug or id, as the runner named it.

    Returns:
        The ``target_identity`` block: id, slug, environment, network class, base URL. Retired
        targets are included — evidence that named one must still say what it was.

    Raises:
        EvidenceValidationError: ``evidence-target-not-found`` when nothing matches in this tenant.
    """
    try:
        record = get_target(tenant_id, target_ref, include_deleted=True)
    except TargetValidationError as exc:
        raise EvidenceValidationError(
            CODE_TARGET_NOT_FOUND,
            f"no verification target '{target_ref}' in this tenant; evidence must name the "
            "target it ran against",
        ) from exc
    return target_identity(record)


def _operation_payload(index: int, operation: OperationResultInput) -> Dict[str, Any]:
    """Flatten one submitted case into the row shape the database layer writes.

    Args:
        index: The case's position in the submission, stored as its ``sequence`` so an export
            reproduces the recorded order.
        operation: The :class:`~app.verification_evidence.OperationResultInput`.

    Returns:
        The row, with its assertions and artifact references nested for the single-transaction
        insert.
    """
    return {
        "sequence": index,
        "case_id": operation.case_id,
        "operation_key": operation.operation_key,
        "operation_name": operation.operation_name,
        "case_source": operation.case_source,
        "http_method": operation.http_method,
        "http_path": operation.http_path,
        "outcome": operation.outcome,
        "failure_code": operation.failure_code,
        "failure_message": operation.failure_message,
        "expected_status": operation.expected_status,
        "actual_status": operation.actual_status,
        "started_at": operation.started_at,
        "finished_at": operation.finished_at,
        "duration_ms": operation.duration_ms,
        "attempts": operation.attempts,
        "assertions": [
            {
                "sequence": position,
                "kind": assertion.kind,
                "outcome": assertion.outcome,
                "subject": assertion.subject,
                "expected": assertion.expected,
                "actual": assertion.actual,
                "code": assertion.code,
                "message": assertion.message,
            }
            for position, assertion in enumerate(operation.assertions)
        ],
        "artifacts": [_artifact_payload(artifact) for artifact in operation.artifacts],
    }


def _artifact_payload(artifact: ArtifactReferenceInput) -> Dict[str, Any]:
    """Flatten one artifact reference into its row shape.

    Args:
        artifact: The :class:`~app.verification_evidence.ArtifactReferenceInput`.

    Returns:
        The row. ``redacted`` is written as ``True`` because that is the only value V212 admits;
        the submission was already refused if it claimed otherwise.
    """
    return {
        "kind": artifact.kind,
        "label": artifact.label,
        "media_type": artifact.media_type,
        "uri": artifact.uri.strip(),
        "size_bytes": artifact.size_bytes,
        "content_sha256": artifact.content_sha256,
        "redacted": True,
        "redaction": dict(artifact.redaction or {}),
    }


def _mock_payload(record: MockAttestationRecord) -> Dict[str, Any]:
    """Flatten a validated mock attestation into the row shape the database layer writes.

    Args:
        record: The attestation, already validated and with its status derived.

    Returns:
        The ``verification_run_mock`` row map. A record with no bundle or runtime — one that says
        its verification is missing — writes NULLs there rather than placeholders, so the row
        cannot be mistaken for one naming a real mock.
    """
    bundle = record.bundle
    runtime = record.runtime
    conformance = record.conformance
    return {
        "status": record.status,
        "reason_code": record.reason_code,
        "reason": record.reason,
        "bundle_digest": bundle.digest if bundle else None,
        "bundle_format": bundle.format if bundle else None,
        "bundle_format_version": bundle.format_version if bundle else None,
        "bundle_signed": bool(bundle.signed) if bundle else False,
        "bundle_api": bundle.api.model_dump(mode="json") if bundle else {},
        "runtime_name": runtime.name if runtime else None,
        "runtime_version": runtime.version if runtime else None,
        "runtime_image": runtime.image if runtime else None,
        "corpus_format": conformance.corpus_format if conformance else None,
        "corpus_version": conformance.corpus_version if conformance else None,
        "corpus_digest": conformance.corpus_digest if conformance else None,
        "corpus_case_count": conformance.corpus_case_count if conformance else None,
        "conformance_total": conformance.total if conformance else 0,
        "conformance_passed": conformance.passed if conformance else 0,
        "conformance_failed": conformance.failed if conformance else 0,
        "failed_cases": list(conformance.failed_cases) if conformance else [],
        "fixture_packs": [pack.model_dump(mode="json") for pack in record.fixture_packs],
    }


def _mock_row_for(
    run: VerificationRunInput, environment: Optional[str]
) -> Optional[Dict[str, Any]]:
    """Decide what mock attestation, if any, this run stores.

    Three cases, and the middle one is the reason this function exists:

    * an attestation was attached → store it (already validated by ``validate_run_input``);
    * none was attached but the run targeted a ``mock`` environment → store an **explicitly
      missing** attestation, so the gap is a recorded fact rather than an absence;
    * none was attached and the target was not a mock → store nothing; there is no mock to describe.

    Args:
        run: The submitted run.
        environment: The target's environment class, from the identity snapshot.

    Returns:
        The row map, or ``None`` when the run has no mock to record.
    """
    if run.mock is not None:
        # Re-validated here, not merely trusted from ``validate_run_input``: the store is the single
        # door to the tables, and it applies the rule whichever way it was entered. The wrapper is
        # used so a refusal stays in the evidence taxonomy every caller already branches on.
        return _mock_payload(validate_mock_attestation_input(run.mock))
    if environment == MOCK_TARGET_ENVIRONMENT:
        return _mock_payload(missing_mock_attestation())
    return None


def record_run(
    tenant_id: str, run: VerificationRunInput, *, actor: TargetActor
) -> RecordedRun:
    """Record one finished run as immutable evidence.

    Order matters: the submission is validated first (the cheap, purely structural refusals), then
    the target is read, then the idempotency key is checked, and only then is anything written. A
    submission that is wrong in a cheap way never reaches the database.

    Args:
        tenant_id: The caller's tenant.
        run: The submitted run.
        actor: Who is recording it — a user or a CI runner.

    Returns:
        The stored evidence and whether this call wrote it (see :class:`RecordedRun`).

    Raises:
        EvidenceValidationError: with the code naming which rule failed.
    """
    counts = validate_run_input(run)
    identity = _target_snapshot(tenant_id, run.target_ref)

    if run.idempotency_key:
        existing = db.get_verification_run_by_idempotency_key(tenant_id, run.idempotency_key)
        if existing is not None:
            return RecordedRun(get_run(tenant_id, str(existing.get("id"))), created=False)

    outcome = (
        RUN_OUTCOME_CANCELLED if run.outcome == RUN_OUTCOME_CANCELLED else derive_outcome(counts)
    )
    run_row = {
        "tenant_id": tenant_id,
        "suite_digest": run.suite_digest,
        "suite_schema_version": run.suite_schema_version,
        "suite_compiler_version": run.suite_compiler_version,
        "suite_case_count": run.suite_case_count,
        "target_id": identity.get("target_id"),
        "target_slug": identity.get("slug"),
        "target_environment": identity.get("environment"),
        "target_network_class": identity.get("network_class"),
        "target_base_url": identity.get("base_url"),
        "runner_name": run.runner_name,
        "runner_version": run.runner_version,
        "recorded_by": actor.user_id,
        "actor_label": actor.label,
        "actor_kind": actor.kind,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "duration_ms": duration_ms_between(run.started_at, run.finished_at),
        "outcome": outcome,
        "total_cases": counts["total"],
        "passed_cases": counts["passed"],
        "failed_cases": counts["failed"],
        "errored_cases": counts["errored"],
        "skipped_cases": counts["skipped"],
        "source": dict(run.source or {}),
        "context": dict(run.context or {}),
        "idempotency_key": run.idempotency_key,
    }
    operations = [
        _operation_payload(index, operation) for index, operation in enumerate(run.operations)
    ]
    artifacts = [_artifact_payload(artifact) for artifact in run.artifacts]
    mock = _mock_row_for(run, identity.get("environment"))

    try:
        stored = db.insert_verification_evidence(
            run=run_row, operations=operations, artifacts=artifacts, mock=mock
        )
    except Exception as exc:  # noqa: BLE001 - narrowed by the idempotency re-check below
        # A concurrent upload with the same key loses the unique-index race. Evidence is immutable,
        # so the loser's only correct answer is the winner's run — the same answer a sequential
        # retry would have got.
        if run.idempotency_key:
            existing = db.get_verification_run_by_idempotency_key(tenant_id, run.idempotency_key)
            if existing is not None:
                logger.info(
                    "verification run insert lost the idempotency race for key %s; "
                    "returning the stored run",
                    run.idempotency_key,
                )
                return RecordedRun(get_run(tenant_id, str(existing.get("id"))), created=False)
        raise exc

    if stored is None:
        raise EvidenceValidationError(
            CODE_RUN_NOT_FOUND, "no tenant context for this credential; cannot record evidence"
        )
    return RecordedRun(get_run(tenant_id, str(stored.get("id"))), created=True)


def get_run(tenant_id: str, run_id: str) -> VerificationRunRecord:
    """Read one run in full: its cases, their assertions, and every artifact reference.

    Args:
        tenant_id: The caller's tenant.
        run_id: The run id.

    Returns:
        The complete record, including the mock attestation (PMR-3.2) when the run recorded one.

    Raises:
        EvidenceValidationError: ``evidence-run-not-found`` when nothing matches in this tenant.
    """
    run_row = db.get_verification_run(run_id, tenant_id)
    if run_row is None:
        raise EvidenceValidationError(
            CODE_RUN_NOT_FOUND, f"no verification run '{run_id}' in this tenant"
        )
    return record_from_rows(
        run_row,
        db.list_verification_run_operations(run_id, tenant_id),
        db.list_verification_run_assertions(run_id, tenant_id),
        db.list_verification_run_artifacts(run_id, tenant_id),
        db.get_verification_run_mock(run_id, tenant_id),
    )


def list_runs(
    tenant_id: str,
    *,
    target_id: Optional[str] = None,
    suite_digest: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 50,
) -> List[VerificationRunSummary]:
    """A tenant's runs, newest first, without per-case detail.

    The filters are the questions a gate asks: "the newest evidence for *this* suite", "everything
    that ran against *this* target", "the failures".

    Args:
        tenant_id: The caller's tenant.
        target_id: Restrict to one target.
        suite_digest: Restrict to one compiled suite.
        outcome: Restrict to one verdict.
        limit: Maximum runs (clamped to 1..200).

    Returns:
        The summaries; empty when nothing matches.
    """
    rows = db.list_verification_runs(
        tenant_id,
        target_id=target_id,
        suite_digest=suite_digest,
        outcome=outcome,
        limit=max(1, min(int(limit), MAX_LIST_LIMIT)),
    )
    return [summary_from_row(row) for row in rows]
