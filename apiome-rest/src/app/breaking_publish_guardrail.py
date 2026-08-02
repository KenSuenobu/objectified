"""Breaking-publish guardrail — semver-aware publish gate (CTG-3.4, #4478).

CTG-3.1 (#4475) made breaking changes *visible* after publish; this module makes them
*consequential* at publish time. It answers one question:

    Does this revision break consumers **without** bumping the semver major?

Both halves matter. A breaking change shipped as ``2.0.0`` is a correct release. The same
change shipped as ``1.4.1`` is the semver violation that destroys consumer trust — and the
platform already knows it is breaking, so it should say so *before* the publish, not in the
changelog afterwards.

How it decides
--------------
* **Baseline** — the previous *published* revision on the line
  (:meth:`Database.get_prior_published_baseline_revision_id`), the same baseline CTG-3.1
  classifies against. Deliberately independent of the publish request's change-report
  baseline mode, so selecting ``initial`` cannot dodge the guardrail.
* **Breaking?** — the CTG-1.1 taxonomy (:func:`classify_openapi_changes`) rendered through
  the CTG-1.3 changelog builder, so the guardrail lists exactly the changes the published
  changelog will list.
* **Major bumped?** — :func:`app.semver_version.is_major_bump` over the two version labels.
  Labels that are not semver yield *unknown*, which warns but never blocks: a tenant with a
  non-semver versioning scheme has not committed a semver violation.

Policy
------
The level is a style-guide setting resolved through the GOV-1.4 chain (project → tenant →
default): ``off`` / ``warn`` (default) / ``block``. Only ``block`` refuses the publish, and
only a force-publish (``skipPublishChecks`` + reason, the GOV-2.5 pattern) gets past it.

Everything here is **best-effort**: a fault anywhere — missing baseline, unbuildable spec,
DB error — degrades to :data:`STATUS_UNAVAILABLE`, which never blocks a publish. A guardrail
that fails closed on its own bugs would be worse than the semver violation it guards against.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from .breaking_publish_policy import (
    BREAKING_PUBLISH_POLICY_BLOCK,
    BREAKING_PUBLISH_POLICY_OFF,
    DEFAULT_BREAKING_PUBLISH_POLICY,
    normalize_breaking_publish_policy,
)
from .change_taxonomy import classify_openapi_changes
from .changelog_generator import build_changelog
from .compatibility_engine import openapi_for_revision
from .database import db
from .semver_version import is_major_bump, next_major_label

logger = logging.getLogger(__name__)

__all__ = [
    "BreakingPublishAssessment",
    "MAX_LISTED_BREAKING_CHANGES",
    "STATUS_BLOCKED",
    "STATUS_DISABLED",
    "STATUS_NO_BASELINE",
    "STATUS_OK",
    "STATUS_UNAVAILABLE",
    "STATUS_WARNING",
    "assess_breaking_publish",
    "resolve_breaking_publish_policy",
]

#: The guardrail is switched off for this tenant/project.
STATUS_DISABLED = "disabled"
#: No previous published revision to compare against (initial publication).
STATUS_NO_BASELINE = "no-baseline"
#: Compared cleanly and found nothing to complain about.
STATUS_OK = "ok"
#: Breaking without a major bump, under ``warn`` — surfaced, publish proceeds.
STATUS_WARNING = "warning"
#: Breaking without a major bump, under ``block`` — publish refused unless forced.
STATUS_BLOCKED = "blocked"
#: The comparison could not be made; never blocks.
STATUS_UNAVAILABLE = "unavailable"

#: Cap on the breaking changes carried in a payload. A pathological rewrite can classify
#: thousands of changes; the dialog and the audit row only need enough to act on, and
#: ``breakingCount`` always reports the true total.
MAX_LISTED_BREAKING_CHANGES = 50

#: Why the major-bump question could not be answered.
_REASON_UNKNOWN_SCHEME = "version-labels-not-semver"


@dataclass(frozen=True)
class BreakingPublishAssessment:
    """The guardrail's verdict on one candidate publish.

    Attributes:
        policy: Resolved level — ``off`` / ``warn`` / ``block``.
        status: One of the ``STATUS_*`` constants.
        breaking: Whether the head classifies breaking against the baseline.
        major_bumped: ``True``/``False``, or ``None`` when a label is not semver.
        from_version: Baseline version label, when a baseline was compared.
        to_version: Candidate version label.
        baseline_revision_id: The compared baseline revision, when one exists.
        breaking_changes: Up to :data:`MAX_LISTED_BREAKING_CHANGES` breaking entries, each
            ``{pointer, ruleId, pathGroup, summary}``, in changelog order.
        breaking_count: Total breaking changes found (may exceed the listed ones).
        counts: Full CTG-1.3 severity tally for the comparison.
        max_severity: Worst severity across all classified changes.
        recommended_version: The label a compliant major bump would use.
        detail: Free-text explanation for ``unavailable``/unknown-scheme outcomes.
    """

    policy: str = DEFAULT_BREAKING_PUBLISH_POLICY
    status: str = STATUS_UNAVAILABLE
    breaking: bool = False
    major_bumped: Optional[bool] = None
    from_version: Optional[str] = None
    to_version: Optional[str] = None
    baseline_revision_id: Optional[str] = None
    breaking_changes: Tuple[Dict[str, str], ...] = ()
    breaking_count: int = 0
    counts: Optional[Dict[str, int]] = None
    max_severity: Optional[str] = None
    recommended_version: Optional[str] = None
    detail: Optional[str] = None

    @property
    def triggered(self) -> bool:
        """Whether the guardrail has something to say (warning or block)."""
        return self.status in (STATUS_WARNING, STATUS_BLOCKED)

    @property
    def blocked(self) -> bool:
        """Whether publish must be refused unless force-published."""
        return self.status == STATUS_BLOCKED

    @property
    def truncated(self) -> bool:
        """Whether :attr:`breaking_changes` omits some of :attr:`breaking_count`."""
        return self.breaking_count > len(self.breaking_changes)

    def message(self) -> str:
        """Human-readable one-liner for dialogs, API errors, and audit rows."""
        if not self.triggered:
            return "No breaking-publish guardrail findings."
        target = self.recommended_version or "the next major version"
        scope = f" versus {self.from_version}" if self.from_version else ""
        lead = (
            f"{self.breaking_count} breaking change(s){scope} "
            f"published as {self.to_version or 'this version'}"
        )
        if self.major_bumped is None:
            return (
                f"{lead}, and the version labels are not semver so a major bump cannot be "
                "confirmed. Publish under a major version to signal the break."
            )
        return f"{lead} without a major-version bump. Publish as {target} instead."

    def as_payload(self) -> Dict[str, Any]:
        """Serialize to the camelCase shape the dialog, the 422 body, and audit rows share."""
        return {
            "policy": self.policy,
            "status": self.status,
            "triggered": self.triggered,
            "blocked": self.blocked,
            "breaking": self.breaking,
            "majorBumped": self.major_bumped,
            "fromVersion": self.from_version,
            "toVersion": self.to_version,
            "baselineRevisionId": self.baseline_revision_id,
            "breakingChanges": [dict(c) for c in self.breaking_changes],
            "breakingCount": self.breaking_count,
            "truncated": self.truncated,
            "counts": dict(self.counts or {}),
            "maxSeverity": self.max_severity,
            "recommendedVersion": self.recommended_version,
            "detail": self.detail,
            "message": self.message(),
        }


def resolve_breaking_publish_policy(
    tenant_id: str, project_id: Optional[str] = None
) -> str:
    """Resolve the guardrail level from the assigned style guide (GOV-1.4 chain).

    Args:
        tenant_id: The tenant whose guide chain applies.
        project_id: The owning project, enabling a project-level guide to override.

    Returns:
        ``off`` / ``warn`` / ``block``. Any fault — no guide, DB error, unknown value —
        yields :data:`DEFAULT_BREAKING_PUBLISH_POLICY`, so the guardrail can never escalate
        a tenant to ``block`` because a lookup misbehaved.
    """
    try:
        guide = db.get_assigned_style_guide(tenant_id, project_id)
        if not isinstance(guide, dict):
            return DEFAULT_BREAKING_PUBLISH_POLICY
        return normalize_breaking_publish_policy(guide.get("breaking_publish_policy"))
    except Exception:  # noqa: BLE001 - policy resolution must never break a publish
        logger.warning(
            "Breaking-publish policy resolution failed for tenant %s (project %s); "
            "falling back to %r",
            tenant_id,
            project_id,
            DEFAULT_BREAKING_PUBLISH_POLICY,
            exc_info=True,
        )
        return DEFAULT_BREAKING_PUBLISH_POLICY


def assess_breaking_publish(
    *,
    tenant_slug: str,
    tenant_id: str,
    project_id: str,
    head_version: Mapping[str, Any],
    head_spec: Optional[Mapping[str, Any]] = None,
    policy: Optional[str] = None,
    openapi_loader: Optional[Callable[..., Mapping[str, Any]]] = None,
) -> BreakingPublishAssessment:
    """Assess a candidate publish against the guardrail. Never raises.

    Args:
        tenant_slug: Tenant slug (needed to materialize OpenAPI for a revision).
        tenant_id: Tenant context.
        project_id: Project owning the revision.
        head_version: The candidate revision row (needs ``id`` and ``version_id``).
        head_spec: The already-materialized head OpenAPI, when the caller has one — the
            publish prechecks build it anyway, so passing it avoids a second build.
        policy: Pre-resolved level; resolved from the guide chain when omitted.
        openapi_loader: Injection point for materializing a revision's OpenAPI; defaults to
            :func:`app.compatibility_engine.openapi_for_revision`.

    Returns:
        The :class:`BreakingPublishAssessment`. Faults come back as
        :data:`STATUS_UNAVAILABLE` with ``detail`` set, never as an exception.
    """
    level = normalize_breaking_publish_policy(
        policy if policy is not None else resolve_breaking_publish_policy(tenant_id, project_id)
    )
    to_label = str(head_version.get("version_id") or "") or None

    if level == BREAKING_PUBLISH_POLICY_OFF:
        return BreakingPublishAssessment(
            policy=level, status=STATUS_DISABLED, to_version=to_label
        )

    load_openapi = openapi_loader or openapi_for_revision
    head_revision_id = str(head_version.get("id") or "")

    try:
        baseline_revision_id = db.get_prior_published_baseline_revision_id(
            project_id, tenant_id, head_revision_id
        )
        if not baseline_revision_id:
            return BreakingPublishAssessment(
                policy=level, status=STATUS_NO_BASELINE, to_version=to_label
            )

        baseline = db.get_version_by_id(str(baseline_revision_id), tenant_id)
        if not isinstance(baseline, dict) or not baseline:
            return BreakingPublishAssessment(
                policy=level,
                status=STATUS_UNAVAILABLE,
                to_version=to_label,
                detail=f"Baseline revision not found: {baseline_revision_id}",
            )

        from_label = str(baseline.get("version_id") or "") or None
        baseline_spec = load_openapi(baseline, tenant_slug, tenant_id)
        candidate_spec = (
            head_spec
            if head_spec is not None
            else load_openapi(head_version, tenant_slug, tenant_id)
        )

        changelog = build_changelog(
            classify_openapi_changes(baseline_spec, candidate_spec),
            from_version=from_label,
            to_version=to_label,
        )
    except Exception as exc:  # noqa: BLE001 - a broken guardrail must not break publishing
        logger.warning(
            "Breaking-publish guardrail could not classify revision %s; continuing "
            "without the signal",
            head_revision_id,
            exc_info=True,
        )
        return BreakingPublishAssessment(
            policy=level,
            status=STATUS_UNAVAILABLE,
            to_version=to_label,
            detail=str(exc),
        )

    breaking_entries = [e for e in changelog.entries if e.severity == "breaking"]
    listed = tuple(
        {
            "pointer": str(e.pointer),
            "ruleId": str(e.rule_id),
            "pathGroup": str(e.path_group),
            "summary": str(e.summary),
        }
        for e in breaking_entries[:MAX_LISTED_BREAKING_CHANGES]
    )
    major_bumped = (
        is_major_bump(from_label or "", to_label or "")
        if (from_label and to_label)
        else None
    )
    counts = dict(changelog.counts or {})

    if not breaking_entries:
        return BreakingPublishAssessment(
            policy=level,
            status=STATUS_OK,
            breaking=False,
            major_bumped=major_bumped,
            from_version=from_label,
            to_version=to_label,
            baseline_revision_id=str(baseline_revision_id),
            counts=counts,
            max_severity=changelog.max_severity,
        )

    # Breaking *and* correctly majored — the release is well-formed, no friction.
    if major_bumped is True:
        status = STATUS_OK
        detail = None
    elif major_bumped is None:
        # Unknown versioning scheme: surface it, but never escalate to a block on a guess.
        status = STATUS_WARNING
        detail = _REASON_UNKNOWN_SCHEME
    else:
        status = (
            STATUS_BLOCKED if level == BREAKING_PUBLISH_POLICY_BLOCK else STATUS_WARNING
        )
        detail = None

    return BreakingPublishAssessment(
        policy=level,
        status=status,
        breaking=True,
        major_bumped=major_bumped,
        from_version=from_label,
        to_version=to_label,
        baseline_revision_id=str(baseline_revision_id),
        breaking_changes=listed,
        breaking_count=len(breaking_entries),
        counts=counts,
        max_severity=changelog.max_severity,
        recommended_version=next_major_label(from_label or ""),
        detail=detail,
    )
