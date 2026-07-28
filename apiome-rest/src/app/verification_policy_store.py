"""Persistence for verification publish/deploy policy — ECA-3.1 (#4734).

Loads the policy in force, appends new versions, and records evaluate decisions.
The pure verdict lives in :mod:`app.verification_policy_evaluate`; this module is the
only place policy rows and evaluation rows are written.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from .database import db
from .verification_policy import (
    DEFAULT_POLICY,
    PURPOSE_DEPLOY,
    PURPOSE_PUBLISH,
    VerificationPolicy,
    canonical_policy_body,
    policy_content_fingerprint,
    policy_from_row,
    validate_policy_body,
)
from .verification_policy_evaluate import (
    EvidenceRunSummary,
    PolicyDecision,
    evaluate_verification_policy,
)

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_EVALUATION_LIST_LIMIT",
    "PolicyValidationError",
    "evaluate_and_record",
    "list_evaluations",
    "list_policy_versions",
    "load_tenant_policy",
    "save_tenant_policy",
]

MAX_EVALUATION_LIST_LIMIT = 100


class PolicyValidationError(ValueError):
    """Raised when a policy body fails validation before persistence."""

    def __init__(self, errors: Sequence[str]) -> None:
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def load_tenant_policy(tenant_id: str) -> VerificationPolicy:
    """Load the policy in force for a tenant.

    Never raises on store failure: degrades to the advisory default so an infrastructure
    fault does not invent a blocking gate.

    Args:
        tenant_id: Tenant whose policy governs.

    Returns:
        The tenant's current policy, or :data:`DEFAULT_POLICY`.
    """
    if not tenant_id:
        return DEFAULT_POLICY
    try:
        row = db.get_latest_verification_policy(tenant_id)
    except Exception:  # noqa: BLE001 - unreadable policy must not invent a block
        logger.warning(
            "Could not load verification policy for tenant %s; using advisory default",
            tenant_id,
            exc_info=True,
        )
        return DEFAULT_POLICY
    return policy_from_row(row)


def list_policy_versions(tenant_id: str, *, limit: int = 50) -> List[Dict[str, Any]]:
    """Return policy version history newest first.

    Args:
        tenant_id: Tenant to list.
        limit: Maximum rows.

    Returns:
        Stored policy rows (empty when none).
    """
    return db.list_verification_policies(tenant_id, limit=limit)


def save_tenant_policy(
    *,
    tenant_id: str,
    required_suite_digests: Sequence[str],
    max_evidence_age_seconds: Optional[int],
    required_target_network_class: Optional[str],
    purpose: str,
    breaking_change_action: str,
    enforcement: str,
    actor_user_id: Optional[str] = None,
    actor_label: Optional[str] = None,
) -> VerificationPolicy:
    """Append a new policy version for a tenant.

    Args:
        tenant_id: Tenant the policy governs.
        required_suite_digests: Digests the gate requires.
        max_evidence_age_seconds: Freshness ceiling, or ``None``.
        required_target_network_class: Network class filter, or ``None``.
        purpose: ``publish`` / ``deploy`` / ``both``.
        breaking_change_action: ``ignore`` / ``warn`` / ``block``.
        enforcement: ``advisory`` / ``block``.
        actor_user_id: Publishing user id.
        actor_label: Human-readable actor label.

    Returns:
        The newly stored policy.

    Raises:
        PolicyValidationError: When the body fails validation.
        RuntimeError: When the insert returns no row.
    """
    errors = validate_policy_body(
        required_suite_digests=required_suite_digests,
        max_evidence_age_seconds=max_evidence_age_seconds,
        required_target_network_class=required_target_network_class,
        purpose=purpose,
        breaking_change_action=breaking_change_action,
        enforcement=enforcement,
    )
    if errors:
        raise PolicyValidationError(errors)

    body = canonical_policy_body(
        required_suite_digests=required_suite_digests,
        max_evidence_age_seconds=max_evidence_age_seconds,
        required_target_network_class=required_target_network_class,
        purpose=purpose,
        breaking_change_action=breaking_change_action,
        enforcement=enforcement,
    )
    fingerprint = policy_content_fingerprint(body)
    digests = list(body["requiredSuiteDigests"])
    row = db.insert_verification_policy(
        tenant_id=tenant_id,
        content_fingerprint=fingerprint,
        required_suite_digests=digests,
        max_evidence_age_seconds=max_evidence_age_seconds,
        required_target_network_class=required_target_network_class,
        purpose=purpose,
        breaking_change_action=breaking_change_action,
        enforcement=enforcement,
        actor_user_id=actor_user_id,
        actor_label=actor_label,
    )
    if not row:
        raise RuntimeError("Failed to persist verification policy")
    return policy_from_row(row)


def _parse_timestamp(value: Any) -> Optional[datetime]:
    """Parse a DB timestamp into aware UTC, or return ``None``."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _runs_from_rows(rows: Sequence[Mapping[str, Any]]) -> List[EvidenceRunSummary]:
    """Adapt ``verification_run`` rows into evaluator summaries."""
    out: List[EvidenceRunSummary] = []
    for row in rows:
        out.append(
            EvidenceRunSummary(
                run_id=str(row.get("id") or ""),
                suite_digest=str(row.get("suite_digest") or ""),
                outcome=str(row.get("outcome") or ""),
                target_network_class=str(row.get("target_network_class") or "public"),
                finished_at=_parse_timestamp(row.get("finished_at")),
                created_at=_parse_timestamp(row.get("created_at")),
            )
        )
    return out


def evaluate_and_record(
    *,
    tenant_id: str,
    purpose: str,
    project_id: Optional[str] = None,
    version_record_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    actor_label: Optional[str] = None,
    actor_kind: Optional[str] = None,
    now: Optional[datetime] = None,
) -> tuple[PolicyDecision, Optional[str]]:
    """Load policy + evidence + changelog, evaluate, and persist the decision.

    Args:
        tenant_id: Tenant context.
        purpose: ``publish`` or ``deploy``.
        project_id: Optional project of the subject revision.
        version_record_id: Optional catalog revision id (needed for breaking gate).
        actor_user_id: Actor who triggered evaluate.
        actor_label: Human-readable actor label.
        actor_kind: ``user`` / ``api_key`` / ``system``.
        now: Injectable clock for tests.

    Returns:
        ``(decision, evaluation_id)`` — evaluation_id may be ``None`` if persist failed.
    """
    if purpose not in (PURPOSE_PUBLISH, PURPOSE_DEPLOY):
        raise ValueError("purpose must be 'publish' or 'deploy'")

    policy = load_tenant_policy(tenant_id)

    # Prefer runs matching required digests; when none required, still list recent passes
    # so a future gate extension can cite them without a second round-trip.
    digests = list(policy.required_suite_digests)
    evidence_rows: List[Dict[str, Any]] = []
    if digests:
        for digest in digests:
            evidence_rows.extend(
                db.list_verification_runs(
                    tenant_id,
                    suite_digest=digest,
                    outcome="passed",
                    limit=20,
                )
            )
    else:
        evidence_rows = db.list_verification_runs(
            tenant_id, outcome="passed", limit=20
        )

    changelog_max_severity: Optional[str] = None
    changelog_id: Optional[str] = None
    changelog_status: Optional[str] = None
    if version_record_id and project_id:
        try:
            changelog = db.get_version_changelog(
                version_record_id, tenant_id, project_id
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "Could not load version changelog for %s; treating as no breaking signal",
                version_record_id,
                exc_info=True,
            )
            changelog = None
        if changelog:
            changelog_id = str(changelog.get("id") or "") or None
            changelog_status = str(changelog.get("status") or "") or None
            severity = changelog.get("max_severity")
            changelog_max_severity = str(severity) if severity else None

    decision = evaluate_verification_policy(
        policy,
        purpose=purpose,
        evidence_runs=_runs_from_rows(evidence_rows),
        changelog_max_severity=changelog_max_severity,
        changelog_id=changelog_id,
        changelog_status=changelog_status,
        now=now,
    )

    evaluation_id: Optional[str] = None
    try:
        evaluation_id = db.record_verification_policy_evaluation(
            {
                "tenant_id": tenant_id,
                "project_id": project_id,
                "version_record_id": version_record_id,
                "policy_version_id": decision.policy_version_id,
                "policy_content_fingerprint": decision.policy_content_fingerprint,
                "purpose": purpose,
                "passed": decision.passed,
                "enforcement": decision.enforcement,
                "gate_results": [g.as_dict() for g in decision.gate_results],
                "evidence_run_ids": list(decision.evidence_run_ids),
                "warnings": [dict(w) for w in decision.warnings],
                "actor_user_id": actor_user_id,
                "actor_label": actor_label,
                "actor_kind": actor_kind,
            }
        )
    except Exception:  # noqa: BLE001 - decision must still return even if audit write fails
        logger.warning(
            "Failed to persist verification policy evaluation for tenant %s",
            tenant_id,
            exc_info=True,
        )

    return decision, evaluation_id


def list_evaluations(
    tenant_id: str,
    *,
    version_record_id: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """List recent evaluations for a tenant (optionally filtered by revision).

    Args:
        tenant_id: Tenant context.
        version_record_id: Optional revision filter.
        limit: Maximum rows (clamped).

    Returns:
        Evaluation rows newest first.
    """
    return db.list_verification_policy_evaluations(
        tenant_id,
        version_record_id=version_record_id,
        limit=limit,
    )
