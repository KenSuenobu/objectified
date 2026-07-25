"""Provider-neutral lint governance webhooks (CLX-4.2, #4860).

Turns the four lint-governance moments a pipeline or chat integration must react to into
notifications delivered over the **existing** push-webhook channels
(``apiome.push_webhook_subscriptions`` / ``push_webhook_delivery_events``, #2587/#2588) —
the same HMAC-signed (``X-Apiome-Signature``), retried, provider-neutral delivery the
repository-refresh notifications use::

    lint.scan.completed      — a NEW evidence run was recorded for a subject
    lint.regression.detected — a gate evaluation found newly introduced unwaived errors
    lint.waiver.expiring     — a granted waiver approaches its expiry (one-shot per grant)
    lint.coverage.failed     — a gate evaluation failed the required-coverage gate

Emission points are deliberate about noise:

* ``scan.completed`` fires from :meth:`Database.record_lint_evidence_run` only when a row was
  actually inserted — the fingerprint dedup path (an unchanged re-scan) stays silent.
* ``regression.detected`` / ``coverage.failed`` fire only from lint **gate** evaluation
  (:func:`app.lint_gate.evaluate_lint_gate`) — a deliberate CI action — never from plain
  ``GET …/lint/policy`` reads, so browsing a report can't page anyone.
* ``waiver.expiring`` fires from the periodic sweep, exactly once per granted waiver
  (:meth:`Database.claim_expiring_lint_waivers` claims atomically across replicas).

Payloads carry ids and fingerprints only — never raw configuration, raw artifacts, source
text, or credentials. Like every sibling notification module, fan-out is **best-effort**:
per-subscription failures are logged and skipped and no function here ever raises, so a
notification problem can never fail the scan/gate/sweep it describes.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

__all__ = [
    "EVENT_LINT_COVERAGE_FAILED",
    "EVENT_LINT_REGRESSION_DETECTED",
    "EVENT_LINT_SCAN_COMPLETED",
    "EVENT_LINT_WAIVER_EXPIRING",
    "notify_lint_coverage_failed",
    "notify_lint_regression",
    "notify_lint_scan_completed",
    "notify_lint_waiver_expiring",
]

EVENT_LINT_SCAN_COMPLETED = "lint.scan.completed"
EVENT_LINT_REGRESSION_DETECTED = "lint.regression.detected"
EVENT_LINT_WAIVER_EXPIRING = "lint.waiver.expiring"
EVENT_LINT_COVERAGE_FAILED = "lint.coverage.failed"


def _clean_str(raw: Any) -> Optional[str]:
    """Return a stripped non-empty string, or ``None`` for blank/missing values."""
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _compact(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Drop ``None`` values so payloads never carry empty keys."""
    return {k: v for k, v in payload.items() if v is not None}


def _fan_out(
    db: Any,
    tenant_id: str,
    event_type: str,
    payload: Mapping[str, Any],
) -> List[str]:
    """Enqueue one delivery per active tenant subscription (best-effort, never raises).

    Args:
        db: Database handle exposing ``list_active_push_webhook_subscription_ids`` and
            ``enqueue_push_webhook_delivery``.
        tenant_id: Subscription + delivery scope.
        event_type: The ``lint.*`` event type stamped on each delivery.
        payload: JSON-serializable notification body.

    Returns:
        Enqueued delivery-event ids (empty when no subscription exists or listing failed).
    """
    try:
        subscription_ids = db.list_active_push_webhook_subscription_ids(tenant_id)
    except Exception:  # noqa: BLE001 - notification fan-out never raises
        logger.exception(
            "lint-notification fan-out: failed to list subscriptions for tenant %s",
            tenant_id,
        )
        return []

    enqueued: List[str] = []
    for subscription_id in subscription_ids:
        try:
            row = db.enqueue_push_webhook_delivery(
                tenant_id,
                subscription_id,
                event_type,
                dict(payload),
            )
            event_id = _clean_str(row.get("id")) if isinstance(row, Mapping) else None
            if event_id is not None:
                enqueued.append(event_id)
        except Exception:  # noqa: BLE001 - a dead subscription must not fail the batch
            logger.exception(
                "lint-notification fan-out: failed to enqueue %s for subscription %s",
                event_type,
                subscription_id,
            )
    return enqueued


def notify_lint_scan_completed(
    db: Any,
    *,
    tenant_id: str,
    run: Mapping[str, Any],
) -> List[str]:
    """Notify that a NEW lint evidence run was recorded for a subject.

    Called from :meth:`Database.record_lint_evidence_run` after a genuine insert (the
    fingerprint-dedup skip never notifies). The payload identifies the run by ids and
    fingerprints only; ``raw_artifact_ref`` and configuration content stay server-side.

    Args:
        db: Database handle for the fan-out.
        tenant_id: The subject's owning tenant.
        run: The evidence-run column dict, including the inserted ``id``.

    Returns:
        Enqueued delivery-event ids.
    """
    findings = run.get("findings")
    payload = _compact(
        {
            "event": EVENT_LINT_SCAN_COMPLETED,
            "subjectType": _clean_str(run.get("subject_type")),
            "versionRecordId": _clean_str(run.get("version_record_id")),
            "mcpVersionId": _clean_str(run.get("mcp_version_id")),
            "scannerId": _clean_str(run.get("scanner_id")),
            "scannerVersion": _clean_str(run.get("scanner_version")),
            "adapterVersion": _clean_str(run.get("adapter_version")),
            "profile": _clean_str(run.get("profile")),
            "outcome": _clean_str(run.get("outcome")),
            "evidenceRunId": _clean_str(run.get("id")),
            "reportFingerprint": _clean_str(run.get("report_fingerprint")),
            "inputFingerprint": _clean_str(run.get("input_fingerprint")),
            "sourceFingerprint": _clean_str(run.get("source_fingerprint")),
            "configFingerprint": _clean_str(run.get("config_fingerprint")),
            "findingCount": len(findings) if isinstance(findings, Sequence) else 0,
        }
    )
    return _fan_out(db, tenant_id, EVENT_LINT_SCAN_COMPLETED, payload)


def notify_lint_regression(
    db: Any,
    *,
    tenant_id: str,
    subject_type: str,
    subject_id: str,
    project_id: Optional[str] = None,
    baseline_subject_id: Optional[str] = None,
    new_fingerprints: Optional[Sequence[str]] = None,
    regression_count: int = 0,
    policy_version_id: Optional[str] = None,
    policy_content_fingerprint: Optional[str] = None,
    evaluation_id: Optional[str] = None,
    links: Optional[Mapping[str, Optional[str]]] = None,
) -> List[str]:
    """Notify that a gate evaluation detected newly introduced unwaived errors.

    Args:
        db: Database handle for the fan-out.
        tenant_id: The subject's owning tenant.
        subject_type: ``catalog_revision`` | ``mcp_endpoint_version``.
        subject_id: The gated revision / snapshot.
        project_id: Owning project (catalog subjects).
        baseline_subject_id: The compared-against subject, when a baseline was supplied.
        new_fingerprints: Fingerprints of the regressed findings.
        regression_count: Number of regressions (new + error + unwaived).
        policy_version_id: The pinned policy pack.
        policy_content_fingerprint: The pack's content fingerprint.
        evaluation_id: The persisted evaluation row, when recording succeeded.
        links: Evidence / policy / workspace API links from the gate payload.

    Returns:
        Enqueued delivery-event ids.
    """
    payload = _compact(
        {
            "event": EVENT_LINT_REGRESSION_DETECTED,
            "subjectType": _clean_str(subject_type),
            "subjectId": _clean_str(subject_id),
            "projectId": _clean_str(project_id),
            "baselineSubjectId": _clean_str(baseline_subject_id),
            "newFingerprints": [str(fp) for fp in new_fingerprints or [] if fp],
            "count": int(regression_count),
            "policyVersionId": _clean_str(policy_version_id),
            "policyContentFingerprint": _clean_str(policy_content_fingerprint),
            "evaluationId": _clean_str(evaluation_id),
            "links": _compact(dict(links)) if links else None,
        }
    )
    return _fan_out(db, tenant_id, EVENT_LINT_REGRESSION_DETECTED, payload)


def notify_lint_coverage_failed(
    db: Any,
    *,
    tenant_id: str,
    subject_type: str,
    subject_id: str,
    project_id: Optional[str] = None,
    missing_axes: Optional[Sequence[str]] = None,
    required_axes: Optional[Sequence[str]] = None,
    policy_version_id: Optional[str] = None,
    evaluation_id: Optional[str] = None,
    links: Optional[Mapping[str, Optional[str]]] = None,
) -> List[str]:
    """Notify that a gate evaluation failed the required-coverage gate.

    Fires only when the pack's ``failOnRequiredCoverage`` toggle is on (the caller gates),
    so tenants that chose not to enforce coverage are never paged about it.

    Args:
        db: Database handle for the fan-out.
        tenant_id: The subject's owning tenant.
        subject_type: ``catalog_revision`` | ``mcp_endpoint_version``.
        subject_id: The gated revision / snapshot.
        project_id: Owning project (catalog subjects).
        missing_axes: Required axes with no assessment.
        required_axes: The pack's full required-coverage list.
        policy_version_id: The pinned policy pack.
        evaluation_id: The persisted evaluation row, when recording succeeded.
        links: Evidence / policy / workspace API links from the gate payload.

    Returns:
        Enqueued delivery-event ids.
    """
    payload = _compact(
        {
            "event": EVENT_LINT_COVERAGE_FAILED,
            "subjectType": _clean_str(subject_type),
            "subjectId": _clean_str(subject_id),
            "projectId": _clean_str(project_id),
            "missingAxes": [str(a) for a in missing_axes or [] if a],
            "requiredAxes": [str(a) for a in required_axes or [] if a],
            "policyVersionId": _clean_str(policy_version_id),
            "evaluationId": _clean_str(evaluation_id),
            "links": _compact(dict(links)) if links else None,
        }
    )
    return _fan_out(db, tenant_id, EVENT_LINT_COVERAGE_FAILED, payload)


def notify_lint_waiver_expiring(
    db: Any,
    *,
    decision: Mapping[str, Any],
    kind: str = "lint_finding",
    href: Optional[str] = None,
) -> List[str]:
    """Notify that a granted waiver approaches (or passed) its expiry.

    Called from the waiver-expiry sweep with a row already claimed via
    :meth:`Database.claim_expiring_lint_waivers` (a lint finding decision) or
    :meth:`Database.claim_expiring_import_export_quality_waivers` (an IXH-2.3 import/export
    quality waiver, projected onto the same shape), so each grant notifies exactly once.

    Args:
        db: Database handle for the fan-out.
        decision: The waiver row (must carry ``tenant_id``).
        kind: Which ledger the waiver came from — ``lint_finding`` (default) or
            ``quality:import`` / ``quality:export``. Subscribers key off this rather than
            guessing from the href.
        href: API link to the waiver, when it is not a lint decision.

    Returns:
        Enqueued delivery-event ids (empty when the row has no tenant).
    """
    tenant_id = _clean_str(decision.get("tenant_id"))
    if tenant_id is None:
        logger.warning("lint.waiver.expiring: decision %s has no tenant", decision.get("id"))
        return []
    decision_id = _clean_str(decision.get("id"))
    default_href = f"/v1/lint/decisions/{decision_id}" if decision_id else None
    payload = _compact(
        {
            "event": EVENT_LINT_WAIVER_EXPIRING,
            "kind": kind,
            "decisionId": decision_id,
            "sourceFingerprint": _clean_str(decision.get("source_fingerprint")),
            "ruleId": _clean_str(decision.get("rule_id")),
            "projectId": _clean_str(decision.get("project_id")),
            "state": _clean_str(decision.get("state")),
            "expiresAt": _clean_str(decision.get("expires_at")),
            "rationale": _clean_str(decision.get("rationale")),
            "linkedTicket": _clean_str(decision.get("linked_ticket")),
            "decisionHref": href or default_href,
        }
    )
    return _fan_out(db, tenant_id, EVENT_LINT_WAIVER_EXPIRING, payload)
