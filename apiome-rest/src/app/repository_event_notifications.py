"""Policy-gated notifications for repository scan / sync events (REPO-7.2, #2800).

RAR-5.4 (:mod:`app.repository_refresh_notifications`) gave the auto-refresh loop a voice.
What it did not give anyone is an *off switch*, or a guarantee that a repository stuck in a
failure loop cannot page the same on-call every sweep tick. This module is the policy layer
that sits in front of delivery::

    event ──► muted for this repo? ──► won a throttle slot? ──► resolve tenant channels ──► fan out

Three operator-facing events are covered — the ones a stakeholder must act on rather than
merely observe:

* ``repository.refresh.auto_paused``       — consecutive failures tripped the RAR-3.4
  auto-pause; scheduled refresh has stopped and someone must resume it by hand.
* ``repository.refresh.breaking_change``   — a sync produced a version whose change report
  classifies as breaking; downstream consumers are about to be surprised.
* ``repository.refresh.repeated_failures`` — the repository has failed N times in a row but
  has *not* paused yet; this is the warning shot before the pause.

All three stay inside the ``repository.refresh.*`` namespace RAR-5.4 established, so a
subscriber keeps routing repository traffic on a single prefix.

**Channels are resolved per tenant** from the existing notification infrastructure — the
tenant's active push-webhook subscriptions (``apiome.push_webhook_subscriptions`` /
``push_webhook_delivery_events``, #2587/#2588), with their retry and dead-letter semantics
unchanged. Each channel is classified by its URL: a Slack incoming webhook gets a
Slack-native ``text``/``blocks`` body (Slack rejects a payload with no ``text``), every other
channel gets the structured JSON. One event therefore produces one delivery per channel,
each shaped for what is on the other end.

**Opt-out is per repository and per event type** (``apiome.repository_notification_preference``).
Rows are exceptions, not enrolments: a repository with no preference row is subscribed to
everything, and only an explicit ``enabled = FALSE`` mutes an event. A preference read that
*fails* is treated as "not muted" — a notification nobody asked to lose is far cheaper than a
silent pager during the incident where the database is already unhappy.

**Throttle is one notification per repository per event type per hour**
(``apiome.repository_notification_throttle``). The slot claim is a single conditional upsert,
so two sweep workers racing on the same repository cannot both win; the loser bumps the
suppression counter instead. A throttle read that *fails* also falls open, for the same
reason as the preference read.

Delivery is **best-effort** throughout, matching the sibling refresh/lint/publish notifiers:
per-channel errors are logged and skipped and the public entrypoints never raise, so a
notification problem can never fail the scan or sync it describes.

The auto-pause event is wired here from the RAR-3.2 refresh sweep. The breaking-change event
is emitted by the sync path once RAR-4.2/4.3 version creation is wired up — its entrypoint
(:func:`notify_repository_breaking_change`) is complete and tested, mirroring how RAR-4.3 and
RAR-5.4 shipped their building blocks ahead of the dispatcher that calls them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set
from urllib.parse import quote, urlsplit

from .repository_refresh_notifications import build_auto_pause_notification

logger = logging.getLogger(__name__)


class RepositoryNotificationEvent(str, Enum):
    """The repository scan/sync events REPO-7.2 delivers.

    The value is the push-webhook event type stamped on every delivery and the value
    persisted in the opt-out and throttle tables, so the three vocabularies cannot drift.
    """

    #: Consecutive refresh failures tripped the RAR-3.4 auto-pause threshold.
    AUTO_PAUSED = "repository.refresh.auto_paused"
    #: A sync produced a version whose change report classifies as breaking.
    BREAKING_CHANGE = "repository.refresh.breaking_change"
    #: The repository has failed repeatedly but has not paused yet.
    REPEATED_FAILURES = "repository.refresh.repeated_failures"


#: Every event type this module can deliver, as the raw strings stored in the database.
ALL_EVENT_TYPES: List[str] = [event.value for event in RepositoryNotificationEvent]

#: One sentence per event, for the preferences API — an operator deciding what to mute needs
#: to know what they would stop hearing about, not just an event type string.
EVENT_DESCRIPTIONS: Dict[RepositoryNotificationEvent, str] = {
    RepositoryNotificationEvent.AUTO_PAUSED: (
        "Scheduled auto-refresh stopped for this repository after too many consecutive "
        "failures, and must be resumed by hand."
    ),
    RepositoryNotificationEvent.BREAKING_CHANGE: (
        "A sync produced a version whose change report classifies as breaking, so "
        "downstream consumers of this repository's specs are affected."
    ),
    RepositoryNotificationEvent.REPEATED_FAILURES: (
        "This repository has failed to refresh several times in a row but has not been "
        "paused yet — the warning before the pause."
    ),
}

#: The throttle window: at most one notification per repository per event type per hour.
DEFAULT_THROTTLE_WINDOW_SECONDS = 3600

#: Consecutive failures at which the sweep starts emitting the repeated-failures warning.
#: Below this a failure is noise — a transient clone error, a provider blip — and the RAR-3.4
#: backoff already handles it without anyone being told.
REPEATED_FAILURE_THRESHOLD = 3

#: Reason codes reported on a suppressed dispatch, for logging and for the caller's telemetry.
SUPPRESSED_MUTED = "muted"
SUPPRESSED_THROTTLED = "throttled"
SUPPRESSED_NO_CHANNELS = "no-channels"

#: Hosts whose incoming webhooks speak Slack's message format rather than accepting an
#: arbitrary JSON body. Matched on the exact host or any subdomain of it.
_SLACK_HOSTS = ("slack.com",)


class ChannelKind(str, Enum):
    """How a resolved channel expects its body to be shaped."""

    #: A generic HTTP endpoint: receives the structured JSON payload as-is.
    WEBHOOK = "webhook"
    #: A Slack incoming webhook: receives a Slack ``text``/``blocks`` message.
    SLACK = "slack"


@dataclass(frozen=True)
class NotificationChannel:
    """One resolved delivery target for a tenant.

    Attributes:
        subscription_id: The ``push_webhook_subscriptions`` row id to enqueue against.
        url: The subscription's destination URL, used only to classify the channel.
        kind: How the body must be shaped for this destination.
    """

    subscription_id: str
    url: Optional[str]
    kind: ChannelKind


@dataclass(frozen=True)
class DispatchResult:
    """The outcome of one attempted repository-event notification.

    Attributes:
        event: The event that was dispatched (or suppressed).
        delivered: Ids of the delivery events actually enqueued, one per channel reached.
        channels: How many channels were resolved for the tenant. Zero when the tenant has
            no active subscription, or when the dispatch was suppressed before resolution.
        suppressed_reason: ``None`` when the event was dispatched; otherwise one of
            :data:`SUPPRESSED_MUTED`, :data:`SUPPRESSED_THROTTLED` or
            :data:`SUPPRESSED_NO_CHANNELS`.
    """

    event: RepositoryNotificationEvent
    delivered: List[str] = field(default_factory=list)
    channels: int = 0
    suppressed_reason: Optional[str] = None

    @property
    def suppressed(self) -> bool:
        """Return whether policy or a missing channel stopped this event from delivering."""
        return self.suppressed_reason is not None


def _clean_str(raw: Any) -> Optional[str]:
    """Return a stripped non-empty string, or ``None`` for blank/missing values."""
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def coerce_event(raw: Any) -> Optional[RepositoryNotificationEvent]:
    """Return the :class:`RepositoryNotificationEvent` for ``raw``, or ``None``.

    Accepts the enum itself or its wire/database string. Unknown values return ``None``
    rather than raising, so an API request or a stored row carrying a retired event type
    is rejected by the caller rather than crashing the read.

    Args:
        raw: An event enum member, its string value, or anything else.

    Returns:
        The matching enum member, or ``None`` when ``raw`` names no known event.
    """
    if isinstance(raw, RepositoryNotificationEvent):
        return raw
    text = _clean_str(raw)
    if text is None:
        return None
    try:
        return RepositoryNotificationEvent(text)
    except ValueError:
        return None


# --- channel resolution ------------------------------------------------------------------


def channel_kind_for_url(url: Optional[str]) -> ChannelKind:
    """Classify a subscription URL into the body shape its destination expects.

    A Slack incoming webhook rejects a body with no ``text`` field, so a channel pointed at
    one must receive a Slack message rather than the structured payload. Everything else —
    an in-house receiver, a relay, an automation platform — takes the JSON as-is.

    Args:
        url: The subscription's destination URL, or ``None``.

    Returns:
        :attr:`ChannelKind.SLACK` for a Slack incoming-webhook host, otherwise
        :attr:`ChannelKind.WEBHOOK` (the safe default for an unparseable or missing URL).
    """
    text = _clean_str(url)
    if text is None:
        return ChannelKind.WEBHOOK
    try:
        host = (urlsplit(text).hostname or "").lower()
    except ValueError:
        # A URL malformed enough that urlsplit refuses it cannot be classified; the
        # structured payload is the safe body to send.
        return ChannelKind.WEBHOOK
    for slack_host in _SLACK_HOSTS:
        if host == slack_host or host.endswith(f".{slack_host}"):
            return ChannelKind.SLACK
    return ChannelKind.WEBHOOK


def resolve_channels(db: Any, tenant_id: str) -> List[NotificationChannel]:
    """Resolve a tenant's notification channels from the existing push-webhook infra.

    Reads the tenant's active (non-deleted) push-webhook subscriptions and classifies each
    by URL. Never raises: a listing failure is logged and yields no channels, so the caller
    reports a suppressed dispatch rather than propagating a database error into a sweep.

    Args:
        db: Database handle exposing ``list_active_push_webhook_subscription_channels``.
        tenant_id: Owning tenant id (subscription scope).

    Returns:
        One :class:`NotificationChannel` per active subscription (possibly empty).
    """
    try:
        rows = db.list_active_push_webhook_subscription_channels(tenant_id)
    except Exception:
        logger.exception(
            "repository-event notification: failed to resolve channels for tenant %s",
            tenant_id,
        )
        return []

    channels: List[NotificationChannel] = []
    for row in rows or []:
        if not isinstance(row, Mapping):
            continue
        subscription_id = _clean_str(row.get("id"))
        if subscription_id is None:
            continue
        url = _clean_str(row.get("url"))
        channels.append(
            NotificationChannel(
                subscription_id=subscription_id,
                url=url,
                kind=channel_kind_for_url(url),
            )
        )
    return channels


# --- policy gates ------------------------------------------------------------------------


def muted_events(db: Any, tenant_id: str, repository_id: str) -> Set[str]:
    """Return the event types explicitly muted for one repository.

    Fails *open*: if the preference read errors, the result is empty (nothing muted), so a
    database problem cannot silence a repository's notifications during the incident that
    caused it.

    Args:
        db: Database handle exposing ``list_muted_repository_notification_events``.
        tenant_id: Owning tenant id.
        repository_id: The repository whose opt-outs are being read.

    Returns:
        The set of muted event-type strings (possibly empty).
    """
    try:
        return set(db.list_muted_repository_notification_events(tenant_id, repository_id))
    except Exception:
        logger.exception(
            "repository-event notification: failed to read opt-outs for repository %s; "
            "treating every event as subscribed",
            repository_id,
        )
        return set()


def claim_throttle_slot(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    event: RepositoryNotificationEvent,
    window_seconds: int = DEFAULT_THROTTLE_WINDOW_SECONDS,
) -> bool:
    """Try to claim this (repository, event type) pair's slot for the current window.

    The claim is one atomic conditional upsert in the database, so concurrent sweep workers
    cannot both win. A losing claim bumps the pair's suppression counter instead.

    Fails *open*: if the claim errors, the event is allowed through. Losing a notification
    is worse than sending one more than the policy promises.

    Args:
        db: Database handle exposing ``claim_repository_notification_slot``.
        tenant_id: Owning tenant id.
        repository_id: The repository the event is about.
        event: The event type being throttled.
        window_seconds: The quiet window; defaults to one hour.

    Returns:
        ``True`` when the event may be delivered, ``False`` when it is throttled.
    """
    try:
        return bool(
            db.claim_repository_notification_slot(
                tenant_id,
                repository_id,
                event.value,
                window_seconds,
            )
        )
    except Exception:
        logger.exception(
            "repository-event notification: throttle claim failed for repository %s "
            "event %s; delivering",
            repository_id,
            event.value,
        )
        return True


# --- payloads ----------------------------------------------------------------------------


def repository_href(repository_id: str, tab: str) -> Optional[str]:
    """Build the deep-link to one tab of a repository's detail screen.

    Args:
        repository_id: The repository the notification is about.
        tab: The detail tab to open (e.g. ``settings``, ``files``).

    Returns:
        A relative deep-link path, or ``None`` when the repository id is blank.
    """
    repo = _clean_str(repository_id)
    if repo is None:
        return None
    return f"/ade/dashboard/repositories/{quote(repo, safe='')}/preview?tab={quote(tab, safe='')}"


def build_breaking_change_notification(
    *,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    branch: Optional[str] = None,
    path: Optional[str] = None,
    project_id: Optional[str] = None,
    version_id: Optional[str] = None,
    parent_version_id: Optional[str] = None,
    change_report_id: Optional[str] = None,
    max_severity: Optional[str] = None,
    breaking_change_count: Optional[int] = None,
    source_commit_sha: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the payload for a sync that introduced a breaking change.

    The ``event`` / ``repositoryId`` keys and a human ``summary`` are always present so a
    recipient can route the event and render it without descending into the detail; the
    lineage and change-report links are included only when supplied, so a partially-known
    sync does not carry empty links.

    Args:
        repository_id: The repository whose sync produced the breaking change.
        repository_full_name: Human-readable ``owner/name``, when known.
        branch: The branch that was synced, when known.
        path: The repository-relative spec path, when known.
        project_id: The catalog project the sync targets, when known.
        version_id: The version the sync created, when any.
        parent_version_id: The version it supersedes, when any.
        change_report_id: The change report classifying the diff, when any.
        max_severity: The worst classified severity (e.g. ``breaking``), when known.
        breaking_change_count: How many changes classified as breaking, when known.
        source_commit_sha: The remote commit that was synced, when known.

    Returns:
        A JSON-serializable notification dict with camelCase keys.
    """
    label = _clean_str(repository_full_name) or _clean_str(repository_id) or "a repository"
    where = _clean_str(path)
    scope = f" in {where}" if where else ""
    count = breaking_change_count if isinstance(breaking_change_count, int) else None
    tally = f" ({count} breaking change{'s' if count != 1 else ''})" if count is not None else ""

    payload: Dict[str, Any] = {
        "event": RepositoryNotificationEvent.BREAKING_CHANGE.value,
        "repositoryId": _clean_str(repository_id),
        "summary": f"Sync of {label} introduced a breaking change{scope}{tally}.",
    }
    review_href = repository_href(repository_id, "files")
    if review_href is not None:
        payload["reviewHref"] = review_href
    if count is not None:
        payload["breakingChangeCount"] = count
    for key, value in (
        ("repositoryFullName", repository_full_name),
        ("branch", branch),
        ("path", path),
        ("projectId", project_id),
        ("versionId", version_id),
        ("parentVersionId", parent_version_id),
        ("changeReportId", change_report_id),
        ("maxSeverity", max_severity),
        ("sourceCommitSha", source_commit_sha),
    ):
        cleaned = _clean_str(value)
        if cleaned is not None:
            payload[key] = cleaned
    return payload


def build_repeated_failures_notification(
    *,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    consecutive_failures: int,
    pause_threshold: Optional[int] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the payload for a repository whose refreshes keep failing.

    This is the warning shot before the RAR-3.4 auto-pause: the repository is still on its
    cadence, but every recent attempt has errored. ``remainingBeforePause`` tells the
    recipient how much runway is left, when a threshold is configured.

    Args:
        repository_id: The repository that keeps failing.
        repository_full_name: Human-readable ``owner/name``, when known.
        consecutive_failures: The current consecutive-failure count.
        pause_threshold: The auto-pause threshold, when one is configured. ``0`` or ``None``
            means the repository will never auto-pause.
        error: The most recent refresh error, when known.

    Returns:
        A JSON-serializable notification dict with camelCase keys.
    """
    failures = int(consecutive_failures)
    label = _clean_str(repository_full_name) or _clean_str(repository_id) or "a repository"

    payload: Dict[str, Any] = {
        "event": RepositoryNotificationEvent.REPEATED_FAILURES.value,
        "repositoryId": _clean_str(repository_id),
        "consecutiveFailures": failures,
        "summary": (
            f"{label} has failed to refresh {failures} time"
            f"{'s' if failures != 1 else ''} in a row."
        ),
    }
    detail_href = repository_href(repository_id, "settings")
    if detail_href is not None:
        payload["repositoryHref"] = detail_href
    if pause_threshold is not None and int(pause_threshold) > 0:
        threshold = int(pause_threshold)
        payload["pauseThreshold"] = threshold
        payload["remainingBeforePause"] = max(threshold - failures, 0)
    for key, value in (
        ("repositoryFullName", repository_full_name),
        ("error", error),
    ):
        cleaned = _clean_str(value)
        if cleaned is not None:
            payload[key] = cleaned
    return payload


def _auto_pause_summary(payload: Mapping[str, Any]) -> str:
    """Return the human sentence for an auto-pause payload (which carries no ``summary``)."""
    label = (
        _clean_str(payload.get("repositoryFullName"))
        or _clean_str(payload.get("repositoryId"))
        or "a repository"
    )
    failures = payload.get("consecutiveFailures")
    tally = f" after {failures} consecutive failures" if isinstance(failures, int) else ""
    return f"Auto-refresh paused for {label}{tally}; it must be resumed manually."


#: Payload keys rendered in a Slack message's context line, in the order they appear.
_SLACK_CONTEXT_KEYS = (
    ("branch", "branch"),
    ("path", "path"),
    ("maxSeverity", "severity"),
    ("remainingBeforePause", "refreshes before pause"),
    ("error", "error"),
    ("reviewHref", "review"),
    ("resumeHref", "resume"),
    ("repositoryHref", "repository"),
)


def build_slack_message(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Reshape a structured payload into a Slack incoming-webhook message.

    Slack rejects a body without ``text``, so a channel pointed at ``hooks.slack.com`` cannot
    receive the structured payload directly. The message leads with the payload's ``summary``
    and appends a context line of whichever detail keys are present. Deep-links are relative
    application paths, so they are rendered as text rather than as Slack links.

    Args:
        payload: A structured notification payload from one of the builders above.

    Returns:
        A JSON-serializable Slack message with ``text`` and ``blocks``.
    """
    summary = _clean_str(payload.get("summary")) or _clean_str(payload.get("event")) or "Repository event"
    blocks: List[Dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": summary}}
    ]

    facts: List[str] = []
    for key, label in _SLACK_CONTEXT_KEYS:
        value = payload.get(key)
        if value is None:
            continue
        text = _clean_str(value)
        if text is None:
            continue
        facts.append(f"*{label}:* {text}")
    if facts:
        blocks.append(
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "  ·  ".join(facts)}],
            }
        )
    return {"text": summary, "blocks": blocks}


def body_for_channel(channel: NotificationChannel, payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the body to enqueue for one channel, shaped for its destination.

    Args:
        channel: The resolved channel the body is destined for.
        payload: The structured notification payload.

    Returns:
        The Slack message for a Slack channel, otherwise the structured payload unchanged.
    """
    if channel.kind is ChannelKind.SLACK:
        return build_slack_message(payload)
    return dict(payload)


# --- dispatch ----------------------------------------------------------------------------


def dispatch_repository_event(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    event: RepositoryNotificationEvent,
    payload: Mapping[str, Any],
    window_seconds: int = DEFAULT_THROTTLE_WINDOW_SECONDS,
    channels: Optional[Sequence[NotificationChannel]] = None,
) -> DispatchResult:
    """Apply the REPO-7.2 policy gates, then fan one event out to the tenant's channels.

    The gates run opt-out first, then channel resolution, then the throttle claim. That
    order matters at both ends: a muted event never consumes its own hourly slot, and
    neither does an event for a tenant with no channels — otherwise connecting a channel
    mid-incident would be met with an hour of silence. A gate that *errors* falls open (see
    :func:`muted_events` and :func:`claim_throttle_slot`): a lost notification is worse than
    a duplicate one.

    Best-effort: every database and per-channel failure is logged and swallowed, so a
    notification problem cannot break the scan or sync it describes.

    Args:
        db: Database handle exposing the channel, opt-out and throttle accessors.
        tenant_id: Owning tenant id (notification + subscription scope).
        repository_id: The repository the event is about.
        event: The event being dispatched.
        payload: The structured notification payload for ``event``.
        window_seconds: The throttle window; defaults to one hour.
        channels: Pre-resolved channels, for a caller dispatching several events in one pass.
            Resolved from the tenant when omitted.

    Returns:
        A :class:`DispatchResult` describing what was delivered, or why nothing was.

    Raises:
        TypeError: If ``event`` is not a :class:`RepositoryNotificationEvent`. This is a
            programming error, not a runtime condition: it would otherwise be stamped on a
            delivery as an unroutable event type and stored under an event type the throttle
            table's CHECK constraint rejects.
    """
    if not isinstance(event, RepositoryNotificationEvent):
        raise TypeError(
            f"event must be a RepositoryNotificationEvent, got {type(event).__name__}"
        )

    if event.value in muted_events(db, tenant_id, repository_id):
        logger.debug(
            "repository-event notification muted repository_id=%s event=%s",
            repository_id,
            event.value,
        )
        return DispatchResult(event=event, suppressed_reason=SUPPRESSED_MUTED)

    resolved = list(channels) if channels is not None else resolve_channels(db, tenant_id)
    if not resolved:
        return DispatchResult(event=event, suppressed_reason=SUPPRESSED_NO_CHANNELS)

    if not claim_throttle_slot(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        event=event,
        window_seconds=window_seconds,
    ):
        logger.info(
            "repository-event notification throttled repository_id=%s event=%s window=%ss",
            repository_id,
            event.value,
            window_seconds,
        )
        return DispatchResult(
            event=event,
            channels=len(resolved),
            suppressed_reason=SUPPRESSED_THROTTLED,
        )

    delivered: List[str] = []
    for channel in resolved:
        try:
            row = db.enqueue_push_webhook_delivery(
                tenant_id,
                channel.subscription_id,
                event.value,
                body_for_channel(channel, payload),
            )
            event_id = _clean_str(row.get("id")) if isinstance(row, Mapping) else None
            if event_id is not None:
                delivered.append(event_id)
        except Exception:
            # A subscription may have been deactivated or deleted between resolution and
            # the enqueue; skip it rather than fail the whole fan-out.
            logger.exception(
                "repository-event notification: failed to enqueue %s for subscription %s",
                event.value,
                channel.subscription_id,
            )
    return DispatchResult(event=event, delivered=delivered, channels=len(resolved))


def describe_repository_notification_preferences(
    db: Any,
    tenant_id: str,
    repository_id: str,
) -> List[Dict[str, Any]]:
    """Project one repository's notification settings, one entry per event type.

    Every event REPO-7.2 defines is always present, whether or not the repository has a
    stored preference for it: an operator deciding what to mute needs the full list, not
    just the exceptions someone happened to write before. Each entry also carries the
    throttle state for that pair, so "we have not heard about this repository" can be told
    apart from "we have been suppressing it".

    Args:
        db: Database handle exposing ``list_repository_notification_preferences`` and
            ``get_repository_notification_throttle``.
        tenant_id: Owning tenant id (scopes the reads for isolation).
        repository_id: The repository being described.

    Returns:
        One dict per event type, in the declaration order of
        :class:`RepositoryNotificationEvent`, with keys ``event_type``, ``enabled``,
        ``description``, ``updated_at``, ``last_notified_at`` and ``suppressed_count``.
    """
    stored: Dict[str, Mapping[str, Any]] = {}
    for row in db.list_repository_notification_preferences(tenant_id, repository_id) or []:
        if isinstance(row, Mapping):
            key = _clean_str(row.get("event_type"))
            if key is not None:
                stored[key] = row

    throttle: Dict[str, Mapping[str, Any]] = {}
    for row in db.get_repository_notification_throttle(tenant_id, repository_id) or []:
        if isinstance(row, Mapping):
            key = _clean_str(row.get("event_type"))
            if key is not None:
                throttle[key] = row

    described: List[Dict[str, Any]] = []
    for event in RepositoryNotificationEvent:
        preference = stored.get(event.value)
        state = throttle.get(event.value)
        described.append(
            {
                "event_type": event.value,
                # Absence means subscribed; only an explicit False mutes an event.
                "enabled": True if preference is None else bool(preference.get("enabled")),
                "description": EVENT_DESCRIPTIONS[event],
                "updated_at": preference.get("updated_at") if preference else None,
                "last_notified_at": state.get("last_notified_at") if state else None,
                "suppressed_count": int(state.get("suppressed_count") or 0) if state else 0,
            }
        )
    return described


def notify_repository_auto_paused(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    consecutive_failures: int,
    threshold: int,
    error: Optional[str] = None,
    window_seconds: int = DEFAULT_THROTTLE_WINDOW_SECONDS,
) -> DispatchResult:
    """Notify that a repository auto-paused its refresh after consecutive failures.

    Fired by the RAR-3.2 sweep on the transition into the pause. The payload is the RAR-5.4
    auto-pause payload (:func:`app.repository_refresh_notifications.build_auto_pause_notification`),
    unchanged, so existing subscribers keep parsing what they already parse; REPO-7.2 adds
    only the opt-out and throttle gates in front of it.

    Args:
        db: Database handle exposing the channel, opt-out, throttle and enqueue accessors.
        tenant_id: Owning tenant id.
        repository_id: The repository that auto-paused.
        repository_full_name: Human-readable ``owner/name``, when known.
        consecutive_failures: The failure count that tripped the pause.
        threshold: The configured auto-pause threshold that was reached.
        error: The last refresh error, when known.
        window_seconds: The throttle window; defaults to one hour.

    Returns:
        A :class:`DispatchResult` describing what was delivered, or why nothing was.
    """
    payload = build_auto_pause_notification(
        repository_id=repository_id,
        repository_full_name=repository_full_name,
        consecutive_failures=consecutive_failures,
        threshold=threshold,
        error=error,
    )
    # The RAR-5.4 payload predates Slack shaping and carries no human sentence; supply one
    # so a Slack channel renders something better than an event type.
    payload.setdefault("summary", _auto_pause_summary(payload))
    return dispatch_repository_event(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        event=RepositoryNotificationEvent.AUTO_PAUSED,
        payload=payload,
        window_seconds=window_seconds,
    )


def notify_repository_breaking_change(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    branch: Optional[str] = None,
    path: Optional[str] = None,
    project_id: Optional[str] = None,
    version_id: Optional[str] = None,
    parent_version_id: Optional[str] = None,
    change_report_id: Optional[str] = None,
    max_severity: Optional[str] = None,
    breaking_change_count: Optional[int] = None,
    source_commit_sha: Optional[str] = None,
    window_seconds: int = DEFAULT_THROTTLE_WINDOW_SECONDS,
) -> DispatchResult:
    """Notify that a sync introduced a breaking change.

    Called by the sync path once it has classified the version it created; every field
    beyond the repository is optional so a caller that knows less still produces a routable,
    readable notification.

    Args:
        db: Database handle exposing the channel, opt-out, throttle and enqueue accessors.
        tenant_id: Owning tenant id.
        repository_id: The repository whose sync produced the breaking change.
        repository_full_name: Human-readable ``owner/name``, when known.
        branch: The branch that was synced, when known.
        path: The repository-relative spec path, when known.
        project_id: The catalog project the sync targets, when known.
        version_id: The version the sync created, when any.
        parent_version_id: The version it supersedes, when any.
        change_report_id: The change report classifying the diff, when any.
        max_severity: The worst classified severity, when known.
        breaking_change_count: How many changes classified as breaking, when known.
        source_commit_sha: The remote commit that was synced, when known.
        window_seconds: The throttle window; defaults to one hour.

    Returns:
        A :class:`DispatchResult` describing what was delivered, or why nothing was.
    """
    payload = build_breaking_change_notification(
        repository_id=repository_id,
        repository_full_name=repository_full_name,
        branch=branch,
        path=path,
        project_id=project_id,
        version_id=version_id,
        parent_version_id=parent_version_id,
        change_report_id=change_report_id,
        max_severity=max_severity,
        breaking_change_count=breaking_change_count,
        source_commit_sha=source_commit_sha,
    )
    return dispatch_repository_event(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        event=RepositoryNotificationEvent.BREAKING_CHANGE,
        payload=payload,
        window_seconds=window_seconds,
    )


def notify_repository_repeated_failures(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    repository_full_name: Optional[str] = None,
    consecutive_failures: int,
    pause_threshold: Optional[int] = None,
    error: Optional[str] = None,
    window_seconds: int = DEFAULT_THROTTLE_WINDOW_SECONDS,
) -> DispatchResult:
    """Notify that a repository's refreshes keep failing, ahead of any auto-pause.

    Fired by the RAR-3.2 sweep on each failure once the count has reached
    :data:`REPEATED_FAILURE_THRESHOLD`. The hourly throttle is what makes that safe: a
    repository failing every tick still notifies at most once an hour.

    Args:
        db: Database handle exposing the channel, opt-out, throttle and enqueue accessors.
        tenant_id: Owning tenant id.
        repository_id: The repository that keeps failing.
        repository_full_name: Human-readable ``owner/name``, when known.
        consecutive_failures: The current consecutive-failure count.
        pause_threshold: The auto-pause threshold, when one is configured.
        error: The most recent refresh error, when known.
        window_seconds: The throttle window; defaults to one hour.

    Returns:
        A :class:`DispatchResult` describing what was delivered, or why nothing was.
    """
    payload = build_repeated_failures_notification(
        repository_id=repository_id,
        repository_full_name=repository_full_name,
        consecutive_failures=consecutive_failures,
        pause_threshold=pause_threshold,
        error=error,
    )
    return dispatch_repository_event(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        event=RepositoryNotificationEvent.REPEATED_FAILURES,
        payload=payload,
        window_seconds=window_seconds,
    )
