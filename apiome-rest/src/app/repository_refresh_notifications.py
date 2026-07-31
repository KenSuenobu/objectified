"""Refresh-cycle notifications (RAR-5.4, #3535).

Stakeholders need to know when an auto-refresh cycle *changes* something —
without watching a dashboard. This module extends the REPO-12.5 (#2954) failure
notifications to cover the auto-refresh loop: it turns the three *interesting*
refresh outcomes into notifications delivered over the **existing** push-webhook
channels (``apiome.push_webhook_subscriptions`` / ``push_webhook_delivery_events``,
#2587/#2588)::

    refresh outcome ──► notify { new_version | diverged | failed } via existing channels

Only outcomes a stakeholder must act on or be aware of fire a notification:

* ``new-version`` — the re-import created a new, provenance-linked version (RAR-4.2).
* ``diverged``    — a manual edit since import was detected and the refresh was
  *held*, not applied (RAR-4.4 divergence guard); someone must review.
* ``failed``      — the refresh cycle errored before producing a version.

An ``unchanged`` cycle (a freshness/idempotency no-op, RAR-2.4) is intentionally
*silent* — there is nothing to act on — which also keeps the channels quiet under
the common case.

This module reuses the :class:`RefreshOutcome` / :class:`RefreshTrigger` vocabulary
and the lineage/link facets from the sibling RAR-5.3 audit module
(:mod:`app.repository_refresh_audit`) so the notification a stakeholder receives
and the history row a reviewer reads describe the same cycle in the same terms.

**Preferences are honored.** Each notifiable outcome has an independent toggle in
:class:`RefreshNotificationPreferences` (all on by default, mirroring REPO-12.5's
``auto_import_failed`` / ``auto_import_breaking`` defaults). The caller loads the
tenant/user preference blob (e.g. ``user_settings.notifications.repository``) and
passes it in; :func:`notify_refresh_outcome` short-circuits when the matching
toggle is off, so a muted outcome never enqueues a delivery.

**Links to the review action / change report.** Every payload carries a deep-link
to the review action (the file's diff view, RAR-5.1) plus the ``versionId`` /
``changeReportId`` (RAR-4.2/4.3) that resolve the change report, so the recipient
can jump straight to the diff.

Like the sibling RAR-4.x / RAR-5.3 building blocks, delivery here is
**best-effort**: fan-out swallows per-subscription errors and the function never
raises, so a notification problem can never fail the refresh it describes.
Invoking :func:`notify_refresh_outcome` from the EPIC-4 refresh dispatcher — after
the version is created (RAR-4.2) and the change report is generated (RAR-4.3) — is
the dispatcher's job, mirroring how RAR-4.1/4.2/4.3/4.4 and RAR-5.3 deferred their
wiring.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import quote, urlencode

from .repository_refresh_audit import RefreshOutcome, RefreshTrigger

logger = logging.getLogger(__name__)

# Push-webhook event types stamped on each refresh notification. Namespaced under
# ``repository.refresh.*`` so a subscriber can route/filter refresh events distinctly
# from other repository webhooks; the suffix is the outcome.
EVENT_TYPE_BY_OUTCOME: Dict[RefreshOutcome, str] = {
    RefreshOutcome.NEW_VERSION: "repository.refresh.new_version",
    RefreshOutcome.DIVERGED: "repository.refresh.diverged",
    RefreshOutcome.FAILED: "repository.refresh.failed",
}

# The outcomes that produce a notification at all. ``UNCHANGED`` is intentionally
# absent: a no-op refresh has nothing to act on, so it stays silent.
NOTIFIABLE_OUTCOMES = frozenset(EVENT_TYPE_BY_OUTCOME.keys())

# Repo-level event fired when consecutive refresh failures trip the auto-pause
# threshold (RAR-3.4, #3525). Unlike the per-file outcomes above this describes the
# whole repository: its auto-refresh stopped and requires a manual resume.
EVENT_TYPE_AUTO_PAUSED = "repository.refresh.auto_paused"


@dataclass(frozen=True)
class RefreshNotificationPreferences:
    """Per-recipient toggles for refresh notifications (one per notifiable outcome).

    Mirrors the REPO-12.5 ``user_settings.notifications.repository`` preference shape:
    each notifiable refresh outcome can be muted independently, and all default *on*
    (a stakeholder is told about new versions, divergence holds, and failures unless
    they opt out). An ``unchanged`` cycle never notifies regardless of preferences.
    """

    #: Notify when a refresh creates a new version (RAR-4.2). Default on.
    notify_new_version: bool = True
    #: Notify when a refresh is held for review due to divergence (RAR-4.4). Default on.
    notify_diverged: bool = True
    #: Notify when a refresh cycle fails. Default on.
    notify_failed: bool = True
    #: Notify when a repository auto-pauses after consecutive refresh failures
    #: (RAR-3.4) — someone must manually resume it. Default on.
    notify_auto_paused: bool = True

    def allows(self, outcome: RefreshOutcome) -> bool:
        """Return whether ``outcome`` is permitted to notify under these preferences.

        A non-notifiable outcome (e.g. ``unchanged``) is always ``False``.

        Args:
            outcome: The refresh outcome being considered.

        Returns:
            ``True`` if a notification for ``outcome`` should be delivered.
        """
        if outcome is RefreshOutcome.NEW_VERSION:
            return self.notify_new_version
        if outcome is RefreshOutcome.DIVERGED:
            return self.notify_diverged
        if outcome is RefreshOutcome.FAILED:
            return self.notify_failed
        return False

    @classmethod
    def from_mapping(
        cls, prefs: Optional[Mapping[str, Any]]
    ) -> "RefreshNotificationPreferences":
        """Build preferences from a stored blob, tolerating missing/partial keys.

        Recognizes both the local snake_case keys (``notify_new_version`` …) and the
        REPO-12.5 ``user_settings.notifications.repository`` aliases
        (``refresh_new_version`` / ``refresh_diverged`` / ``refresh_failed``). Any key
        that is absent keeps its default (on); only an explicit ``False`` mutes an
        outcome, so a malformed/partial blob fails *open* (the user keeps getting the
        notifications they did not explicitly disable).

        Args:
            prefs: A mapping of preference toggles, or ``None`` for all-default.

        Returns:
            A populated :class:`RefreshNotificationPreferences`.
        """
        if not prefs:
            return cls()

        def _flag(*keys: str, default: bool = True) -> bool:
            for key in keys:
                if key in prefs and prefs[key] is not None:
                    return bool(prefs[key])
            return default

        return cls(
            notify_new_version=_flag("notify_new_version", "refresh_new_version"),
            notify_diverged=_flag("notify_diverged", "refresh_diverged"),
            notify_failed=_flag("notify_failed", "refresh_failed"),
            notify_auto_paused=_flag("notify_auto_paused", "refresh_auto_paused"),
        )


def should_notify(
    outcome: RefreshOutcome,
    preferences: Optional[RefreshNotificationPreferences] = None,
) -> bool:
    """Return whether a refresh ``outcome`` should produce a notification.

    Combines the static notifiability rule (only ``new-version`` / ``diverged`` /
    ``failed`` ever notify) with the recipient's preferences.

    Args:
        outcome: The refresh outcome.
        preferences: The recipient's toggles; defaults (all on) when ``None``.

    Returns:
        ``True`` if a notification should be delivered for ``outcome``.
    """
    if outcome not in NOTIFIABLE_OUTCOMES:
        return False
    prefs = preferences or RefreshNotificationPreferences()
    return prefs.allows(outcome)


def _clean_str(raw: Any) -> Optional[str]:
    """Return a stripped non-empty string, or ``None`` for blank/missing values."""
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def build_review_href(repository_id: str, branch: str, path: str) -> Optional[str]:
    """Build the deep-link to the file's review (diff) action (RAR-5.1).

    Mirrors the UI's ``repositorySpecReviewHref`` so the link a notification carries
    matches the one the Specs tab renders: it opens the repository's Files tab on the
    affected file/branch. Returns ``None`` when the repository id is missing (the
    minimum needed to form a stable link).

    Args:
        repository_id: The repository whose file was refreshed.
        branch: The branch the file was refreshed on.
        path: The repository-relative file path.

    Returns:
        A relative deep-link path, or ``None`` if no usable link can be formed.
    """
    repo = _clean_str(repository_id)
    if repo is None:
        return None
    params = [("tab", "files")]
    path_v = _clean_str(path)
    if path_v is not None:
        params.append(("path", path_v))
    branch_v = _clean_str(branch)
    if branch_v is not None:
        params.append(("branch", branch_v))
    return f"/ade/dashboard/repositories/{quote(repo, safe='')}/preview?{urlencode(params)}"


def build_refresh_notification(
    *,
    trigger: RefreshTrigger,
    outcome: RefreshOutcome,
    repository_id: str,
    branch: str,
    path: str,
    project_id: Optional[str] = None,
    version_id: Optional[str] = None,
    parent_version_id: Optional[str] = None,
    change_report_id: Optional[str] = None,
    source_commit_sha: Optional[str] = None,
    error: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the JSON-serializable notification payload for one refresh outcome.

    The ``event``, ``outcome``, ``trigger`` and lineage keys
    (``repositoryId`` / ``branch`` / ``path``) plus the ``reviewHref`` are always
    present so a recipient can route the event and jump to the review action; the
    version / change-report links and context fields are included only when supplied,
    so a failed or held cycle does not carry empty links.

    Args:
        trigger: What initiated the cycle (:class:`RefreshTrigger`).
        outcome: What the cycle produced (must be a notifiable outcome).
        repository_id: The repository whose file was refreshed (lineage key).
        branch: The branch the file was refreshed on (lineage key).
        path: The repository-relative file path (lineage key).
        project_id: The catalog project the refresh targets, when known.
        version_id: The new version created by the refresh (RAR-4.2), when any.
        parent_version_id: The prior version the refresh supersedes, when any.
        change_report_id: The change report documenting the diff (RAR-4.3), when any.
        source_commit_sha: The remote commit SHA that triggered the refresh, when known.
        error: A short error message, for a failed cycle.
        extra: Optional additional structured context merged into the payload (callers
            must not override the reserved keys above).

    Returns:
        A JSON-serializable notification dict with camelCase keys.

    Raises:
        TypeError: If ``trigger`` or ``outcome`` is not the matching enum type.
        ValueError: If ``outcome`` is not a notifiable outcome (the caller must gate
            on :func:`should_notify` first).
    """
    if not isinstance(trigger, RefreshTrigger):
        raise TypeError(f"trigger must be a RefreshTrigger, got {type(trigger).__name__}")
    if not isinstance(outcome, RefreshOutcome):
        raise TypeError(f"outcome must be a RefreshOutcome, got {type(outcome).__name__}")
    if outcome not in NOTIFIABLE_OUTCOMES:
        raise ValueError(f"outcome {outcome.value!r} is not notifiable")

    payload: Dict[str, Any] = {
        "event": EVENT_TYPE_BY_OUTCOME[outcome],
        "trigger": trigger.value,
        "outcome": outcome.value,
        "repositoryId": _clean_str(repository_id),
        "branch": _clean_str(branch),
        "path": _clean_str(path),
    }
    review_href = build_review_href(repository_id, branch, path)
    if review_href is not None:
        payload["reviewHref"] = review_href

    for key, value in (
        ("projectId", project_id),
        ("versionId", version_id),
        ("parentVersionId", parent_version_id),
        ("changeReportId", change_report_id),
        ("sourceCommitSha", source_commit_sha),
        ("error", error),
    ):
        cleaned = _clean_str(value)
        if cleaned is not None:
            payload[key] = cleaned

    if extra:
        for k, v in extra.items():
            payload.setdefault(k, v)
    return payload


def notify_refresh_outcome(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    branch: str,
    path: str,
    trigger: RefreshTrigger,
    outcome: RefreshOutcome,
    preferences: Optional[RefreshNotificationPreferences] = None,
    project_id: Optional[str] = None,
    version_id: Optional[str] = None,
    parent_version_id: Optional[str] = None,
    change_report_id: Optional[str] = None,
    source_commit_sha: Optional[str] = None,
    error: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Notify a refresh outcome by fanning out one delivery per active channel.

    Gates on :func:`should_notify` (static notifiability + the recipient's
    preferences): a silent outcome (``unchanged``) or a muted toggle enqueues
    nothing and returns an empty list. Otherwise it enqueues one push-webhook
    delivery per active tenant subscription
    (:meth:`Database.list_active_push_webhook_subscription_ids`), each carrying the
    payload from :func:`build_refresh_notification`.

    Best-effort: a per-subscription enqueue failure (e.g. a subscription deactivated
    between the listing and the enqueue) is logged and skipped, and the function never
    raises, so a notification problem cannot break the refresh it describes.

    Args:
        db: The database handle exposing ``list_active_push_webhook_subscription_ids``
            and ``enqueue_push_webhook_delivery``.
        tenant_id: Owning tenant id (notification + subscription scope).
        repository_id: The repository whose file was refreshed.
        branch: The branch the file was refreshed on.
        path: The repository-relative file path.
        trigger: What initiated the cycle (:class:`RefreshTrigger`).
        outcome: What the cycle produced (:class:`RefreshOutcome`).
        preferences: The recipient's toggles; defaults (all on) when ``None``.
        project_id: The catalog project the refresh targets, when known.
        version_id: The new version created by the refresh (RAR-4.2), when any.
        parent_version_id: The prior version the refresh supersedes, when any.
        change_report_id: The change report documenting the diff (RAR-4.3), when any.
        source_commit_sha: The remote commit SHA that triggered the refresh.
        error: A short error message, for a failed cycle.
        extra: Optional additional structured context for the payload.

    Returns:
        The list of enqueued delivery-event ids (empty when the outcome did not notify
        or no active subscription exists).

    Raises:
        TypeError: If ``trigger`` or ``outcome`` is not the matching enum type
            (a programming error, surfaced at call time).
    """
    if not isinstance(trigger, RefreshTrigger):
        raise TypeError(f"trigger must be a RefreshTrigger, got {type(trigger).__name__}")
    if not isinstance(outcome, RefreshOutcome):
        raise TypeError(f"outcome must be a RefreshOutcome, got {type(outcome).__name__}")

    if not should_notify(outcome, preferences):
        return []

    payload = build_refresh_notification(
        trigger=trigger,
        outcome=outcome,
        repository_id=repository_id,
        branch=branch,
        path=path,
        project_id=project_id,
        version_id=version_id,
        parent_version_id=parent_version_id,
        change_report_id=change_report_id,
        source_commit_sha=source_commit_sha,
        error=error,
        extra=extra,
    )
    return _fan_out_notification(db, tenant_id, payload["event"], payload)


def _fan_out_notification(
    db: Any,
    tenant_id: str,
    event_type: str,
    payload: Dict[str, Any],
) -> List[str]:
    """Enqueue ``payload`` once per active push-webhook subscription, best-effort.

    Shared delivery core for :func:`notify_refresh_outcome` and
    :func:`notify_refresh_auto_paused`. Never raises: a listing failure returns an
    empty list, and a per-subscription enqueue failure (e.g. a subscription
    deactivated between the listing and the enqueue) is logged and skipped.

    Args:
        db: The database handle exposing ``list_active_push_webhook_subscription_ids``
            and ``enqueue_push_webhook_delivery``.
        tenant_id: Owning tenant id (subscription scope).
        event_type: The push-webhook event type to stamp on each delivery.
        payload: The JSON-serializable notification payload.

    Returns:
        The list of enqueued delivery-event ids (possibly empty).
    """
    try:
        subscription_ids = db.list_active_push_webhook_subscription_ids(tenant_id)
    except Exception:
        logger.exception(
            "refresh-notification fan-out: failed to list subscriptions for tenant %s",
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
                payload,
            )
            event_id = _clean_str(row.get("id")) if isinstance(row, Mapping) else None
            if event_id is not None:
                enqueued.append(event_id)
        except Exception:
            # A subscription may have been deactivated/deleted between the listing and
            # the enqueue; skip it rather than fail the whole fan-out.
            logger.exception(
                "refresh-notification fan-out: failed to enqueue %s for subscription %s",
                event_type,
                subscription_id,
            )
    return enqueued


def build_auto_pause_notification(
    *,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    consecutive_failures: int,
    threshold: int,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the payload for a repository auto-pause event (RAR-3.4).

    Unlike :func:`build_refresh_notification` this is repo-level (no branch/path
    lineage): the repository's scheduled auto-refresh stopped after consecutive
    failures and requires a manual resume. The payload carries a ``resumeHref``
    deep-link to the repository's Settings tab, where the resume action lives.

    Args:
        repository_id: The repository that auto-paused.
        repository_full_name: Human-readable ``owner/name``, when known.
        consecutive_failures: The failure count that tripped the pause.
        threshold: The configured auto-pause threshold that was reached.
        error: The last refresh error, when known (also stored as the pause reason).

    Returns:
        A JSON-serializable notification dict with camelCase keys.
    """
    payload: Dict[str, Any] = {
        "event": EVENT_TYPE_AUTO_PAUSED,
        "repositoryId": _clean_str(repository_id),
        "consecutiveFailures": int(consecutive_failures),
        "threshold": int(threshold),
    }
    repo = _clean_str(repository_id)
    if repo is not None:
        payload["resumeHref"] = (
            f"/ade/dashboard/repositories/{quote(repo, safe='')}/preview?tab=settings"
        )
    for key, value in (
        ("repositoryFullName", repository_full_name),
        ("error", error),
    ):
        cleaned = _clean_str(value)
        if cleaned is not None:
            payload[key] = cleaned
    return payload


def notify_refresh_auto_paused(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    consecutive_failures: int,
    threshold: int,
    error: Optional[str] = None,
    preferences: Optional[RefreshNotificationPreferences] = None,
) -> List[str]:
    """Notify that a repository auto-paused its refresh after N failures (RAR-3.4).

    Fired by the refresh sweep exactly once, on the transition into the pause
    (``newly_paused`` from
    :meth:`app.database.Database.record_repository_refresh_failure`). Gated on the
    recipient's ``notify_auto_paused`` toggle; delivery is best-effort over the
    same push-webhook channels as the per-file refresh outcomes, and the function
    never raises, so a notification problem cannot break the sweep.

    Args:
        db: The database handle exposing the push-webhook accessors.
        tenant_id: Owning tenant id (notification + subscription scope).
        repository_id: The repository that auto-paused.
        repository_full_name: Human-readable ``owner/name``, when known.
        consecutive_failures: The failure count that tripped the pause.
        threshold: The configured auto-pause threshold that was reached.
        error: The last refresh error, when known.
        preferences: The recipient's toggles; defaults (all on) when ``None``.

    Returns:
        The list of enqueued delivery-event ids (empty when muted or no active
        subscription exists).
    """
    prefs = preferences or RefreshNotificationPreferences()
    if not prefs.notify_auto_paused:
        return []

    payload = build_auto_pause_notification(
        repository_id=repository_id,
        repository_full_name=repository_full_name,
        consecutive_failures=consecutive_failures,
        threshold=threshold,
        error=error,
    )
    return _fan_out_notification(db, tenant_id, EVENT_TYPE_AUTO_PAUSED, payload)
