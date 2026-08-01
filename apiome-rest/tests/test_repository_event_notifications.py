"""Policy and shaping for repository scan/sync notifications (REPO-7.2, #2800).

Three promises are made to an operator, and each is a way the feature can go wrong:

* a muted event is never delivered — but a *broken* preference read must not mute anything;
* at most one notification per repository per event type per hour — but a broken throttle
  must not silence the incident that broke it;
* a channel receives a body its destination will actually accept.

These tests hold all three, plus the best-effort contract every sibling notifier shares: a
notification problem can never fail the scan or sync it describes.
"""

from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.repository_event_notifications import (
    ALL_EVENT_TYPES,
    DEFAULT_THROTTLE_WINDOW_SECONDS,
    EVENT_DESCRIPTIONS,
    REPEATED_FAILURE_THRESHOLD,
    SUPPRESSED_MUTED,
    SUPPRESSED_NO_CHANNELS,
    SUPPRESSED_THROTTLED,
    ChannelKind,
    NotificationChannel,
    RepositoryNotificationEvent,
    build_breaking_change_notification,
    build_repeated_failures_notification,
    build_slack_message,
    channel_kind_for_url,
    coerce_event,
    describe_repository_notification_preferences,
    dispatch_repository_event,
    notify_repository_auto_paused,
    notify_repository_breaking_change,
    notify_repository_repeated_failures,
    resolve_channels,
)

_TENANT = "t-1"
_REPO = "r-1"


class FakeDB:
    """A database stand-in recording what the dispatcher asked of it.

    Each seam can be told to raise, which is how the fail-open contracts are exercised.
    """

    def __init__(
        self,
        *,
        channels: Optional[List[Dict[str, Any]]] = None,
        muted: Optional[List[str]] = None,
        claim: bool = True,
        preferences: Optional[List[Dict[str, Any]]] = None,
        throttle: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self._channels = (
            channels
            if channels is not None
            else [{"id": "sub-1", "url": "https://example.com/hook"}]
        )
        self._muted = muted or []
        self._claim = claim
        self._preferences = preferences or []
        self._throttle = throttle or []
        self.enqueued: List[Tuple[str, str, str, Dict[str, Any]]] = []
        self.claims: List[Tuple[str, str, str, int]] = []
        self.channels_raises = False
        self.muted_raises = False
        self.claim_raises = False
        self.enqueue_raises_for: List[str] = []

    # --- channel resolution -------------------------------------------------------------

    def list_active_push_webhook_subscription_channels(
        self, tenant_id: str
    ) -> List[Dict[str, Any]]:
        if self.channels_raises:
            raise RuntimeError("channels down")
        assert tenant_id == _TENANT
        return list(self._channels)

    # --- policy -------------------------------------------------------------------------

    def list_muted_repository_notification_events(
        self, tenant_id: str, repository_id: str
    ) -> List[str]:
        if self.muted_raises:
            raise RuntimeError("preferences down")
        assert (tenant_id, repository_id) == (_TENANT, _REPO)
        return list(self._muted)

    def claim_repository_notification_slot(
        self, tenant_id: str, repository_id: str, event_type: str, window_seconds: int
    ) -> bool:
        if self.claim_raises:
            raise RuntimeError("throttle down")
        self.claims.append((tenant_id, repository_id, event_type, window_seconds))
        return self._claim

    def list_repository_notification_preferences(
        self, tenant_id: str, repository_id: str
    ) -> List[Dict[str, Any]]:
        return list(self._preferences)

    def get_repository_notification_throttle(
        self, tenant_id: str, repository_id: str
    ) -> List[Dict[str, Any]]:
        return list(self._throttle)

    # --- delivery -----------------------------------------------------------------------

    def enqueue_push_webhook_delivery(
        self,
        tenant_id: str,
        subscription_id: str,
        event_type: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        if subscription_id in self.enqueue_raises_for:
            raise RuntimeError("subscription vanished")
        self.enqueued.append((tenant_id, subscription_id, event_type, payload))
        return {"id": f"evt-{len(self.enqueued)}"}


def _dispatch(db: FakeDB, **overrides: Any):
    kwargs: Dict[str, Any] = {
        "tenant_id": _TENANT,
        "repository_id": _REPO,
        "event": RepositoryNotificationEvent.AUTO_PAUSED,
        "payload": {"event": "x", "summary": "s"},
    }
    kwargs.update(overrides)
    return dispatch_repository_event(db, **kwargs)


# --- the event vocabulary ----------------------------------------------------------------


def test_every_event_stays_in_the_namespace_subscribers_already_route_on() -> None:
    """RAR-5.4 taught subscribers to filter on repository.refresh.*; a fourth prefix would
    silently miss every existing routing rule."""
    for event_type in ALL_EVENT_TYPES:
        assert event_type.startswith("repository.refresh.")


def test_every_event_can_be_explained_to_the_operator_muting_it() -> None:
    for event in RepositoryNotificationEvent:
        assert EVENT_DESCRIPTIONS[event].strip()


@pytest.mark.parametrize("raw", ALL_EVENT_TYPES)
def test_a_stored_event_type_round_trips_back_to_its_enum(raw: str) -> None:
    assert coerce_event(raw) is RepositoryNotificationEvent(raw)


@pytest.mark.parametrize("raw", ["", "   ", None, "repository.refresh.nope", 7, object()])
def test_an_unknown_event_type_is_rejected_rather_than_raising(raw: Any) -> None:
    """The API turns this into a 400; a raise here would be a 500 on a typo."""
    assert coerce_event(raw) is None


def test_the_enum_survives_a_round_trip_through_its_own_member() -> None:
    assert coerce_event(RepositoryNotificationEvent.BREAKING_CHANGE) is (
        RepositoryNotificationEvent.BREAKING_CHANGE
    )


# --- channel resolution ------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://hooks.slack.com/services/T000/B000/XXX",
        "https://HOOKS.SLACK.COM/services/T000/B000/XXX",
        "https://slack.com/api/webhook",
    ],
)
def test_a_slack_destination_is_recognised(url: str) -> None:
    assert channel_kind_for_url(url) is ChannelKind.SLACK


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/hook",
        "https://notslack.com/hook",
        "https://slack.com.evil.test/hook",
        None,
        "",
        "not-a-url",
    ],
)
def test_everything_else_is_a_generic_webhook(url: Optional[str]) -> None:
    """``slack.com.evil.test`` matters: suffix matching without the dot boundary would hand a
    Slack-shaped body — and the tenant's event stream — to an attacker-controlled host."""
    assert channel_kind_for_url(url) is ChannelKind.WEBHOOK


def test_channels_are_resolved_from_the_tenants_active_subscriptions() -> None:
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://example.com/hook"},
            {"id": "sub-2", "url": "https://hooks.slack.com/services/T/B/X"},
        ]
    )
    channels = resolve_channels(db, _TENANT)
    assert [c.subscription_id for c in channels] == ["sub-1", "sub-2"]
    assert [c.kind for c in channels] == [ChannelKind.WEBHOOK, ChannelKind.SLACK]


def test_a_subscription_row_without_an_id_is_skipped_not_enqueued_against() -> None:
    db = FakeDB(channels=[{"url": "https://example.com/hook"}, {"id": "  "}, "junk"])
    assert resolve_channels(db, _TENANT) == []


def test_a_channel_lookup_failure_yields_no_channels_rather_than_raising() -> None:
    db = FakeDB()
    db.channels_raises = True
    assert resolve_channels(db, _TENANT) == []


# --- the opt-out gate --------------------------------------------------------------------


def test_a_muted_event_never_reaches_a_channel() -> None:
    db = FakeDB(muted=[RepositoryNotificationEvent.AUTO_PAUSED.value])
    result = _dispatch(db)
    assert result.suppressed_reason == SUPPRESSED_MUTED
    assert result.delivered == []
    assert db.enqueued == []


def test_muting_one_event_leaves_the_others_speaking() -> None:
    """The opt-out is per event type, not per repository."""
    db = FakeDB(muted=[RepositoryNotificationEvent.AUTO_PAUSED.value])
    result = _dispatch(db, event=RepositoryNotificationEvent.BREAKING_CHANGE)
    assert not result.suppressed
    assert len(db.enqueued) == 1


def test_a_muted_event_is_settled_before_the_throttle_is_touched() -> None:
    """Cheapest gate first, and a muted event must not consume its own hourly slot."""
    db = FakeDB(muted=[RepositoryNotificationEvent.AUTO_PAUSED.value])
    _dispatch(db)
    assert db.claims == []


def test_a_broken_preference_read_delivers_rather_than_going_silent() -> None:
    """Failing closed here would mute a repository precisely when the database is unhappy —
    the moment an operator most needs to hear from it."""
    db = FakeDB()
    db.muted_raises = True
    result = _dispatch(db)
    assert not result.suppressed
    assert len(db.enqueued) == 1


# --- the throttle gate -------------------------------------------------------------------


def test_the_throttle_is_claimed_per_repository_per_event_type_per_hour() -> None:
    db = FakeDB()
    _dispatch(db)
    assert db.claims == [
        (_TENANT, _REPO, RepositoryNotificationEvent.AUTO_PAUSED.value, 3600)
    ]
    assert DEFAULT_THROTTLE_WINDOW_SECONDS == 3600


def test_a_lost_claim_suppresses_the_notification() -> None:
    db = FakeDB(claim=False)
    result = _dispatch(db)
    assert result.suppressed_reason == SUPPRESSED_THROTTLED
    assert db.enqueued == []


def test_a_throttled_dispatch_still_reports_the_channels_it_would_have_reached() -> None:
    """Telemetry needs "we suppressed something that had somewhere to go"."""
    db = FakeDB(claim=False)
    assert _dispatch(db).channels == 1


def test_a_broken_throttle_delivers_rather_than_going_silent() -> None:
    db = FakeDB()
    db.claim_raises = True
    result = _dispatch(db)
    assert not result.suppressed
    assert len(db.enqueued) == 1


def test_a_tenant_with_no_channels_does_not_burn_its_hourly_slot() -> None:
    """Otherwise connecting a channel mid-incident would be met with an hour of silence."""
    db = FakeDB(channels=[])
    result = _dispatch(db)
    assert result.suppressed_reason == SUPPRESSED_NO_CHANNELS
    assert db.claims == []


# --- fan-out -----------------------------------------------------------------------------


def test_one_event_produces_one_delivery_per_channel() -> None:
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://example.com/hook"},
            {"id": "sub-2", "url": "https://other.test/hook"},
        ]
    )
    result = _dispatch(db)
    assert result.delivered == ["evt-1", "evt-2"]
    assert result.channels == 2


def test_the_event_type_is_stamped_on_every_delivery() -> None:
    db = FakeDB()
    _dispatch(db, event=RepositoryNotificationEvent.REPEATED_FAILURES)
    assert db.enqueued[0][2] == RepositoryNotificationEvent.REPEATED_FAILURES.value


def test_the_throttle_is_claimed_once_for_the_whole_fan_out() -> None:
    """Per-channel claiming would let a two-channel tenant halve its own quiet window."""
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://a.test/h"},
            {"id": "sub-2", "url": "https://b.test/h"},
        ]
    )
    _dispatch(db)
    assert len(db.claims) == 1


def test_one_dead_channel_does_not_take_the_others_down_with_it() -> None:
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://a.test/h"},
            {"id": "sub-2", "url": "https://b.test/h"},
        ]
    )
    db.enqueue_raises_for = ["sub-1"]
    result = _dispatch(db)
    assert result.delivered == ["evt-1"]
    assert [row[1] for row in db.enqueued] == ["sub-2"]


def test_pre_resolved_channels_are_used_without_a_second_lookup() -> None:
    db = FakeDB()
    db.channels_raises = True  # would return nothing if it were consulted
    result = _dispatch(
        db,
        channels=[NotificationChannel("sub-9", "https://a.test/h", ChannelKind.WEBHOOK)],
    )
    assert result.delivered == ["evt-1"]


def test_dispatching_something_that_is_not_an_event_is_a_programming_error() -> None:
    db = FakeDB()
    with pytest.raises(TypeError):
        _dispatch(db, event="repository.refresh.auto_paused")


# --- per-channel body shaping ------------------------------------------------------------


def test_a_generic_channel_receives_the_structured_payload() -> None:
    db = FakeDB(channels=[{"id": "sub-1", "url": "https://example.com/hook"}])
    _dispatch(db, payload={"event": "e", "summary": "s", "branch": "main"})
    assert db.enqueued[0][3] == {"event": "e", "summary": "s", "branch": "main"}


def test_a_slack_channel_receives_a_slack_message() -> None:
    """Slack rejects a body with no ``text``; sending the structured payload would make every
    delivery to a Slack channel dead-letter."""
    db = FakeDB(channels=[{"id": "sub-1", "url": "https://hooks.slack.com/services/T/B/X"}])
    _dispatch(db, payload={"event": "e", "summary": "the repository paused"})
    body = db.enqueued[0][3]
    assert body["text"] == "the repository paused"
    assert body["blocks"][0]["text"]["text"] == "the repository paused"


def test_mixed_channels_each_get_their_own_shape_from_one_event() -> None:
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://example.com/hook"},
            {"id": "sub-2", "url": "https://hooks.slack.com/services/T/B/X"},
        ]
    )
    _dispatch(db, payload={"event": "e", "summary": "s"})
    generic, slack = db.enqueued[0][3], db.enqueued[1][3]
    assert "text" not in generic
    assert "text" in slack


def test_the_structured_payload_is_copied_not_handed_to_the_queue_by_reference() -> None:
    """Two channels sharing one dict is one mutation away from a cross-channel bug."""
    db = FakeDB(
        channels=[
            {"id": "sub-1", "url": "https://a.test/h"},
            {"id": "sub-2", "url": "https://b.test/h"},
        ]
    )
    payload = {"event": "e", "summary": "s"}
    _dispatch(db, payload=payload)
    assert db.enqueued[0][3] is not payload
    assert db.enqueued[0][3] is not db.enqueued[1][3]


def test_a_slack_message_carries_the_detail_that_is_present_and_no_placeholders() -> None:
    message = build_slack_message(
        {"summary": "s", "branch": "main", "path": None, "error": "boom"}
    )
    context = message["blocks"][1]["elements"][0]["text"]
    assert "*branch:* main" in context
    assert "*error:* boom" in context
    assert "path" not in context


def test_a_slack_message_with_no_detail_is_just_the_sentence() -> None:
    message = build_slack_message({"summary": "s"})
    assert len(message["blocks"]) == 1


def test_a_slack_message_falls_back_to_the_event_type_when_there_is_no_sentence() -> None:
    assert build_slack_message({"event": "repository.refresh.auto_paused"})["text"] == (
        "repository.refresh.auto_paused"
    )


# --- payloads ----------------------------------------------------------------------------


def test_a_breaking_change_payload_leads_with_what_happened() -> None:
    payload = build_breaking_change_notification(
        repository_id=_REPO,
        repository_full_name="octocat/Hello-World",
        path="api/openapi.yaml",
        breaking_change_count=3,
    )
    assert payload["event"] == RepositoryNotificationEvent.BREAKING_CHANGE.value
    assert payload["summary"] == (
        "Sync of octocat/Hello-World introduced a breaking change in api/openapi.yaml "
        "(3 breaking changes)."
    )


def test_a_single_breaking_change_is_not_pluralised() -> None:
    payload = build_breaking_change_notification(
        repository_id=_REPO, breaking_change_count=1
    )
    assert "(1 breaking change)" in payload["summary"]


def test_a_breaking_change_payload_omits_links_it_has_no_value_for() -> None:
    payload = build_breaking_change_notification(repository_id=_REPO)
    for absent in ("branch", "path", "versionId", "changeReportId", "breakingChangeCount"):
        assert absent not in payload


def test_a_breaking_change_payload_links_to_the_files_view() -> None:
    payload = build_breaking_change_notification(repository_id=_REPO)
    assert payload["reviewHref"] == "/ade/dashboard/repositories/r-1/preview?tab=files"


def test_a_zero_breaking_change_count_is_still_reported() -> None:
    """0 is a value, not an absence: a caller that classified and found none said so."""
    payload = build_breaking_change_notification(
        repository_id=_REPO, breaking_change_count=0
    )
    assert payload["breakingChangeCount"] == 0


def test_a_repeated_failures_payload_says_how_much_runway_is_left() -> None:
    payload = build_repeated_failures_notification(
        repository_id=_REPO, consecutive_failures=3, pause_threshold=8
    )
    assert payload["pauseThreshold"] == 8
    assert payload["remainingBeforePause"] == 5


def test_runway_never_goes_negative() -> None:
    payload = build_repeated_failures_notification(
        repository_id=_REPO, consecutive_failures=12, pause_threshold=8
    )
    assert payload["remainingBeforePause"] == 0


def test_a_repository_that_can_never_pause_is_not_told_about_a_pause() -> None:
    payload = build_repeated_failures_notification(
        repository_id=_REPO, consecutive_failures=3, pause_threshold=0
    )
    assert "pauseThreshold" not in payload
    assert "remainingBeforePause" not in payload


# --- entrypoints -------------------------------------------------------------------------


def test_the_auto_pause_entrypoint_keeps_the_rar_5_4_payload_subscribers_already_parse() -> None:
    db = FakeDB()
    notify_repository_auto_paused(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO,
        repository_full_name="octocat/Hello-World",
        consecutive_failures=8,
        threshold=8,
        error="bad credentials",
    )
    payload = db.enqueued[0][3]
    assert payload["event"] == RepositoryNotificationEvent.AUTO_PAUSED.value
    assert payload["consecutiveFailures"] == 8
    assert payload["threshold"] == 8
    assert payload["resumeHref"].endswith("tab=settings")
    assert payload["error"] == "bad credentials"


def test_the_auto_pause_payload_gains_a_sentence_for_slack() -> None:
    """The RAR-5.4 payload predates Slack shaping and carries no human summary."""
    db = FakeDB()
    notify_repository_auto_paused(
        db,
        tenant_id=_TENANT,
        repository_id=_REPO,
        repository_full_name="octocat/Hello-World",
        consecutive_failures=8,
        threshold=8,
    )
    summary = db.enqueued[0][3]["summary"]
    assert "octocat/Hello-World" in summary
    assert "8 consecutive failures" in summary


def test_each_entrypoint_claims_its_own_event_types_slot() -> None:
    """A shared slot would let an auto-pause silence the breaking change that followed it."""
    db = FakeDB()
    notify_repository_auto_paused(
        db, tenant_id=_TENANT, repository_id=_REPO, consecutive_failures=8, threshold=8
    )
    notify_repository_breaking_change(db, tenant_id=_TENANT, repository_id=_REPO)
    notify_repository_repeated_failures(
        db, tenant_id=_TENANT, repository_id=_REPO, consecutive_failures=3
    )
    assert [claim[2] for claim in db.claims] == ALL_EVENT_TYPES


def test_a_muted_entrypoint_delivers_nothing() -> None:
    db = FakeDB(muted=[RepositoryNotificationEvent.BREAKING_CHANGE.value])
    result = notify_repository_breaking_change(
        db, tenant_id=_TENANT, repository_id=_REPO, version_id="v1"
    )
    assert result.suppressed_reason == SUPPRESSED_MUTED
    assert db.enqueued == []


def test_the_repeated_failure_threshold_leaves_room_for_transient_noise() -> None:
    """Notifying on the first failure would page on every provider blip."""
    assert REPEATED_FAILURE_THRESHOLD > 1


# --- the preferences projection ----------------------------------------------------------


def test_every_event_is_described_even_with_nothing_stored() -> None:
    """An operator choosing what to mute needs the full list, not the exceptions someone
    happened to write earlier."""
    described = describe_repository_notification_preferences(FakeDB(), _TENANT, _REPO)
    assert [row["event_type"] for row in described] == ALL_EVENT_TYPES
    assert all(row["enabled"] for row in described)
    assert all(row["suppressed_count"] == 0 for row in described)


def test_a_stored_opt_out_is_reflected() -> None:
    db = FakeDB(
        preferences=[
            {
                "event_type": RepositoryNotificationEvent.AUTO_PAUSED.value,
                "enabled": False,
                "updated_at": "2026-07-31T00:00:00Z",
            }
        ]
    )
    described = describe_repository_notification_preferences(db, _TENANT, _REPO)
    by_event = {row["event_type"]: row for row in described}
    assert by_event[RepositoryNotificationEvent.AUTO_PAUSED.value]["enabled"] is False
    assert by_event[RepositoryNotificationEvent.BREAKING_CHANGE.value]["enabled"] is True


def test_throttle_state_is_joined_onto_the_description() -> None:
    db = FakeDB(
        throttle=[
            {
                "event_type": RepositoryNotificationEvent.REPEATED_FAILURES.value,
                "last_notified_at": "2026-07-31T10:00:00Z",
                "suppressed_count": 41,
            }
        ]
    )
    by_event = {
        row["event_type"]: row
        for row in describe_repository_notification_preferences(db, _TENANT, _REPO)
    }
    entry = by_event[RepositoryNotificationEvent.REPEATED_FAILURES.value]
    assert entry["last_notified_at"] == "2026-07-31T10:00:00Z"
    assert entry["suppressed_count"] == 41


def test_a_row_for_an_event_that_no_longer_exists_is_ignored() -> None:
    """A retired event type left in the table must not appear in the API's answer."""
    db = FakeDB(preferences=[{"event_type": "repository.refresh.retired", "enabled": False}])
    described = describe_repository_notification_preferences(db, _TENANT, _REPO)
    assert [row["event_type"] for row in described] == ALL_EVENT_TYPES
