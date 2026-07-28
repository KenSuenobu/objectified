"""Pre-publish validation shared by POST …/publish (#3212; guide-aware since GOV-1.4)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from fastapi import HTTPException

from .compatibility_engine import CompatibilityCheckEngine, openapi_for_revision
from .database import db
from .models import VersionPublishRequest
from .publication_change_report import resolve_baseline_revision_id_for_change_report
from .schema_compatibility import CompatibilityRules
from .verification_policy_routes import decision_payload_for_http
from .verification_policy_store import evaluate_and_record

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PublishPrecheckOutcome:
    """What the publish prechecks observed (GOV-1.4, #4430; gate enforced GOV-2.5, #4437).

    Carries the style-guide lint signal computed at publish time so the publish flow can
    surface guide violations and enforce the error-severity gate. All fields are ``None`` when
    the checks were skipped (``skip_publish_checks``) or the lint step faulted.

    Attributes:
        lint_error_count: Number of **error**-severity violations under the resolved style
            guide, or ``None`` when not computed.
        guide_id: The applied guide's id (``None`` for the in-code fallback or when skipped).
        guide_name: The applied guide's display name, when computed.
        severity_counts: Per-severity violation counts when lint succeeded.
        error_findings: Error-severity findings (rule id + location) when lint succeeded.
        verification_decision: ECA-3.1 evidence-backed policy decision when evaluated.
    """

    lint_error_count: Optional[int] = None
    guide_id: Optional[str] = None
    guide_name: Optional[str] = None
    severity_counts: Optional[Dict[str, int]] = None
    error_findings: Optional[tuple[Dict[str, str], ...]] = None
    verification_decision: Optional[Dict[str, Any]] = None


def enforce_publish_prechecks(
    *,
    tenant_slug: str,
    tenant_id: str,
    project_id: str,
    existing: Dict[str, Any],
    request: VersionPublishRequest,
) -> PublishPrecheckOutcome:
    """
    Ensure draft revisions satisfy publication gates unless ``skip_publish_checks`` is set.

    Since GOV-1.4 the prechecks lint the revision under its resolved style guide
    (project → tenant → default) and report the violation counts on the returned
    :class:`PublishPrecheckOutcome`. Since GOV-2.5 (#4437) **error**-severity violations
    block publish (422) unless ``skip_publish_checks`` is set with a force-publish reason.
    Since ECA-3.1 (#4734) the evidence-backed verification policy is evaluated with
    ``purpose=publish``; when enforcement is ``block`` and the decision fails, publish is
    refused with the same decision payload the dashboard renders.

    Returns:
        The observed :class:`PublishPrecheckOutcome`.

    Raises:
        HTTPException: 422 for documentation gaps, style-guide errors, or a blocking
            verification-policy decision.
        HTTPException: 409 when compatibility is breaking and ``allow_breaking`` is false.
    """
    if bool(request.skip_publish_checks):
        return PublishPrecheckOutcome()

    version_record_id = str(existing["id"])

    try:
        head_spec = openapi_for_revision(existing, tenant_slug, tenant_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Could not build OpenAPI for this revision (schema validation): {exc}",
        ) from exc

    # GOV-1.4 / GOV-2.5: lint the materialized head under the resolved style guide. A lint
    # fault degrades to "no signal" so other gates still run; error-level violations block.
    outcome = PublishPrecheckOutcome()
    try:
        from .style_guide_engine import guided_lint_openapi_spec

        result, guide = guided_lint_openapi_spec(head_spec, tenant_id, project_id=project_id)
        error_findings = tuple(
            {
                "rule": str(f.rule),
                "path": str(f.path),
                "message": str(f.message),
            }
            for f in result.findings
            if str(f.severity) == "error"
        )
        outcome = PublishPrecheckOutcome(
            lint_error_count=int(result.severity_counts.get("error", 0)),
            guide_id=guide.guide_id,
            guide_name=guide.name,
            severity_counts=dict(result.severity_counts),
            error_findings=error_findings,
        )
        logger.info(
            "Publish precheck lint for revision %s: %d error-level violation(s) under "
            "style guide %r",
            version_record_id,
            outcome.lint_error_count,
            guide.name,
        )
    except Exception:  # noqa: BLE001 - lint faults must not block publishing
        logger.warning(
            "Publish precheck lint failed for revision %s; continuing without the "
            "style-guide signal",
            version_record_id,
            exc_info=True,
        )

    if outcome.lint_error_count and outcome.lint_error_count > 0:
        guide_label = outcome.guide_name or "style guide"
        first = (outcome.error_findings or ())[0] if outcome.error_findings else None
        first_hint = ""
        if first:
            first_hint = (
                f" (first: rule {first['rule']!r} at {first['path']!r})"
            )
        raise HTTPException(
            status_code=422,
            detail=(
                f"{outcome.lint_error_count} style-guide error violation(s) under "
                f"{guide_label!r}{first_hint}. Fix the violations or force-publish with a "
                "reason."
            ),
        )

    classes = db.get_classes_for_version(version_record_id)
    missing = [c for c in classes if not str(c.get("description") or "").strip()]
    if missing:
        first = str(missing[0].get("name") or missing[0].get("id") or "?")
        raise HTTPException(
            status_code=422,
            detail=(
                f"{len(missing)} class(es) are missing required descriptions "
                f"(first: {first!r})."
            ),
        )

    baseline_revision_id = resolve_baseline_revision_id_for_change_report(
        project_id=project_id,
        tenant_id=tenant_id,
        candidate_revision_id=version_record_id,
        mode=request.change_report_baseline_mode,
        manual_baseline_revision_id=request.change_report_baseline_revision_id,
    )
    if baseline_revision_id:
        base_row = db.get_version_by_id(str(baseline_revision_id), tenant_id)
        if base_row and base_row.get("published"):
            rules = CompatibilityRules()
            base_spec = openapi_for_revision(base_row, tenant_slug, tenant_id)
            result = CompatibilityCheckEngine.run(base_spec, head_spec, rules)

            if result.overall == "breaking" and not bool(request.allow_breaking):
                proj = db.get_project_by_id(project_id, tenant_id)
                proj_slug = str((proj or {}).get("slug") or project_id)
                from_label = str(base_row.get("version_id") or baseline_revision_id)
                to_label = str(existing.get("version_id") or version_record_id)
                report_hint = f"/{tenant_slug}/{proj_slug}/changes/{from_label}...{to_label}"

                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Breaking schema changes detected versus the published baseline "
                        f"({from_label} → {to_label}). "
                        "Review the change report or pass allowBreaking=true on the publish "
                        f"request. Change report path: {report_hint}"
                    ),
                )

    return _with_verification_policy(
        outcome,
        tenant_id=tenant_id,
        project_id=project_id,
        version_record_id=version_record_id,
    )


def _with_verification_policy(
    outcome: PublishPrecheckOutcome,
    *,
    tenant_id: str,
    project_id: str,
    version_record_id: str,
) -> PublishPrecheckOutcome:
    """Attach the ECA-3.1 decision and refuse publish when enforcement blocks.

    Args:
        outcome: The lint/compat outcome so far.
        tenant_id: Tenant context.
        project_id: Project of the revision being published.
        version_record_id: Catalog revision id.

    Returns:
        ``outcome`` with ``verification_decision`` set.

    Raises:
        HTTPException: 422 when policy ``enforcement=block`` and the decision failed.
    """
    try:
        decision, evaluation_id = evaluate_and_record(
            tenant_id=tenant_id,
            purpose="publish",
            project_id=project_id,
            version_record_id=version_record_id,
            actor_kind="system",
            actor_label="publish-precheck",
        )
        payload = decision_payload_for_http(decision, evaluation_id)
    except Exception:  # noqa: BLE001 - policy faults must not invent a silent block
        logger.warning(
            "Verification policy evaluate failed for revision %s; continuing without "
            "the ECA-3.1 signal",
            version_record_id,
            exc_info=True,
        )
        return outcome

    enriched = PublishPrecheckOutcome(
        lint_error_count=outcome.lint_error_count,
        guide_id=outcome.guide_id,
        guide_name=outcome.guide_name,
        severity_counts=outcome.severity_counts,
        error_findings=outcome.error_findings,
        verification_decision=payload,
    )
    if decision.enforcement == "block" and not decision.passed:
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    "Evidence-backed verification policy blocked publish. "
                    "Fix the failed gates, update the policy, or force-publish with a reason."
                ),
                "verificationPolicyDecision": payload,
            },
        )
    return enriched
