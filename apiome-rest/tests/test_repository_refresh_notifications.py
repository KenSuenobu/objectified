"""Refresh-cycle notification tests (RAR-5.4, #3535).

Deterministic, DB-free fixtures over ``app.repository_refresh_notifications`` using a
fake ``Database`` that captures the active-subscription listing and the
``enqueue_push_webhook_delivery`` fan-out. Covers both acceptance criteria —
*notifications fire on new-version / divergence / failure refresh outcomes* and
*notification preferences honored; links to the change report / review action* —
plus the notifiability rule (``unchanged`` is silent), payload assembly, the
preference parser, best-effort fan-out, and enum guarding.
"""

import pytest

from app.repository_refresh_audit import RefreshOutcome, RefreshTrigger
from app.repository_refresh_notifications import (
    EVENT_TYPE_BY_OUTCOME,
    NOTIFIABLE_OUTCOMES,
    RefreshNotificationPreferences,
    build_refresh_notification,
    build_review_href,
    notify_refresh_outcome,
    should_notify,
)


class FakeDB:
    """Captures the subscription listing and each ``enqueue_push_webhook_delivery`` call."""

    def __init__(self, subscription_ids=None, *, list_raises=False, enqueue_fail_ids=()):
        self._subscription_ids = list(subscription_ids or [])
        self._list_raises = list_raises
        self._enqueue_fail_ids = set(enqueue_fail_ids)
        self.list_calls = []
        self.enqueue_calls = []

    def list_active_push_webhook_subscription_ids(self, tenant_id):
        self.list_calls.append(tenant_id)
        if self._list_raises:
            raise RuntimeError("boom listing subscriptions")
        return list(self._subscription_ids)

    def enqueue_push_webhook_delivery(self, tenant_id, subscription_id, event_type, payload):
        self.enqueue_calls.append(
            {
                "tenant_id": tenant_id,
                "subscription_id": subscription_id,
                "event_type": event_type,
                "payload": payload,
            }
        )
        if subscription_id in self._enqueue_fail_ids:
            raise ValueError("subscription_inactive")
        return {"id": f"evt-{subscription_id}"}


# --------------------------------------------------------------- should_notify


def test_notifiable_outcomes_are_the_three_interesting_ones():
    assert NOTIFIABLE_OUTCOMES == frozenset(
        {RefreshOutcome.NEW_VERSION, RefreshOutcome.DIVERGED, RefreshOutcome.FAILED}
    )
    # Every notifiable outcome has an event type, and unchanged has none.
    assert set(EVENT_TYPE_BY_OUTCOME) == NOTIFIABLE_OUTCOMES
    assert RefreshOutcome.UNCHANGED not in EVENT_TYPE_BY_OUTCOME


@pytest.mark.parametrize(
    "outcome",
    [RefreshOutcome.NEW_VERSION, RefreshOutcome.DIVERGED, RefreshOutcome.FAILED],
)
def test_should_notify_true_for_notifiable_outcomes_by_default(outcome):
    assert should_notify(outcome) is True


def test_should_notify_false_for_unchanged():
    assert should_notify(RefreshOutcome.UNCHANGED) is False
    # Even with all toggles on, unchanged never notifies.
    assert should_notify(RefreshOutcome.UNCHANGED, RefreshNotificationPreferences()) is False


def test_should_notify_respects_each_muted_toggle():
    prefs = RefreshNotificationPreferences(
        notify_new_version=False, notify_diverged=False, notify_failed=False
    )
    assert should_notify(RefreshOutcome.NEW_VERSION, prefs) is False
    assert should_notify(RefreshOutcome.DIVERGED, prefs) is False
    assert should_notify(RefreshOutcome.FAILED, prefs) is False


def test_should_notify_independent_toggles():
    # Mute only divergence; the other two still fire.
    prefs = RefreshNotificationPreferences(notify_diverged=False)
    assert should_notify(RefreshOutcome.NEW_VERSION, prefs) is True
    assert should_notify(RefreshOutcome.DIVERGED, prefs) is False
    assert should_notify(RefreshOutcome.FAILED, prefs) is True


# --------------------------------------------------- preference parsing


def test_preferences_from_none_is_all_on():
    prefs = RefreshNotificationPreferences.from_mapping(None)
    assert prefs == RefreshNotificationPreferences(True, True, True)


def test_preferences_from_empty_is_all_on():
    assert RefreshNotificationPreferences.from_mapping({}) == RefreshNotificationPreferences()


def test_preferences_partial_blob_fails_open():
    # Only the failed toggle is set; the rest keep their default (on).
    prefs = RefreshNotificationPreferences.from_mapping({"notify_failed": False})
    assert prefs.notify_new_version is True
    assert prefs.notify_diverged is True
    assert prefs.notify_failed is False


def test_preferences_accepts_repo12_5_aliases():
    prefs = RefreshNotificationPreferences.from_mapping(
        {
            "refresh_new_version": False,
            "refresh_diverged": True,
            "refresh_failed": False,
        }
    )
    assert prefs.notify_new_version is False
    assert prefs.notify_diverged is True
    assert prefs.notify_failed is False


def test_preferences_none_value_keeps_default():
    # An explicit null in the blob is treated as "unset" → default on.
    prefs = RefreshNotificationPreferences.from_mapping({"notify_failed": None})
    assert prefs.notify_failed is True


# ------------------------------------------------------ build_review_href


def test_build_review_href_matches_ui_convention():
    href = build_review_href("repo-1", "main", "specs/api.yaml")
    assert href == (
        "/ade/dashboard/repositories/repo-1/preview?tab=files&path=specs%2Fapi.yaml&branch=main"
    )


def test_build_review_href_url_encodes_repository_id():
    href = build_review_href("a/b id", "main", "x.yaml")
    assert href.startswith("/ade/dashboard/repositories/a%2Fb%20id/preview?")


def test_build_review_href_none_without_repository():
    assert build_review_href("", "main", "x.yaml") is None
    assert build_review_href(None, "main", "x.yaml") is None


def test_build_review_href_omits_blank_path_and_branch():
    href = build_review_href("repo-1", "", "")
    assert href == "/ade/dashboard/repositories/repo-1/preview?tab=files"


# -------------------------------------------------- build_refresh_notification


def test_build_notification_new_version_full_payload():
    payload = build_refresh_notification(
        trigger=RefreshTrigger.SCHEDULED,
        outcome=RefreshOutcome.NEW_VERSION,
        repository_id="repo-1",
        branch="main",
        path="specs/api.yaml",
        project_id="proj-1",
        version_id="ver-2",
        parent_version_id="ver-1",
        change_report_id="cr-9",
        source_commit_sha="abc123",
    )
    assert payload["event"] == "repository.refresh.new_version"
    assert payload["trigger"] == "scheduled"
    assert payload["outcome"] == "new-version"
    assert payload["repositoryId"] == "repo-1"
    assert payload["branch"] == "main"
    assert payload["path"] == "specs/api.yaml"
    assert payload["projectId"] == "proj-1"
    assert payload["versionId"] == "ver-2"
    assert payload["parentVersionId"] == "ver-1"
    # Links to the change report (id) and the review action (href).
    assert payload["changeReportId"] == "cr-9"
    assert payload["sourceCommitSha"] == "abc123"
    assert payload["reviewHref"] == (
        "/ade/dashboard/repositories/repo-1/preview?tab=files&path=specs%2Fapi.yaml&branch=main"
    )


def test_build_notification_failed_carries_error_and_no_empty_links():
    payload = build_refresh_notification(
        trigger=RefreshTrigger.MANUAL,
        outcome=RefreshOutcome.FAILED,
        repository_id="repo-1",
        branch="main",
        path="specs/api.yaml",
        error="parse error at line 3",
    )
    assert payload["event"] == "repository.refresh.failed"
    assert payload["outcome"] == "failed"
    assert payload["error"] == "parse error at line 3"
    # A failed cycle has no version / change report — those keys are omitted, not null.
    for absent in ("versionId", "parentVersionId", "changeReportId", "projectId", "sourceCommitSha"):
        assert absent not in payload
    # The review action link is still present so the recipient can investigate.
    assert "reviewHref" in payload


def test_build_notification_diverged_event_type():
    payload = build_refresh_notification(
        trigger=RefreshTrigger.WEBHOOK,
        outcome=RefreshOutcome.DIVERGED,
        repository_id="repo-1",
        branch="main",
        path="x.yaml",
    )
    assert payload["event"] == "repository.refresh.diverged"
    assert payload["outcome"] == "diverged"


def test_build_notification_extra_does_not_override_reserved_keys():
    payload = build_refresh_notification(
        trigger=RefreshTrigger.SCHEDULED,
        outcome=RefreshOutcome.NEW_VERSION,
        repository_id="repo-1",
        branch="main",
        path="x.yaml",
        extra={"outcome": "hacked", "custom": "kept"},
    )
    assert payload["outcome"] == "new-version"  # reserved key wins
    assert payload["custom"] == "kept"


def test_build_notification_rejects_non_notifiable_outcome():
    with pytest.raises(ValueError):
        build_refresh_notification(
            trigger=RefreshTrigger.SCHEDULED,
            outcome=RefreshOutcome.UNCHANGED,
            repository_id="repo-1",
            branch="main",
            path="x.yaml",
        )


def test_build_notification_enum_guarding():
    with pytest.raises(TypeError):
        build_refresh_notification(
            trigger="scheduled",
            outcome=RefreshOutcome.NEW_VERSION,
            repository_id="repo-1",
            branch="main",
            path="x.yaml",
        )
    with pytest.raises(TypeError):
        build_refresh_notification(
            trigger=RefreshTrigger.SCHEDULED,
            outcome="new-version",
            repository_id="repo-1",
            branch="main",
            path="x.yaml",
        )


# ----------------------------------------------------- notify_refresh_outcome


def _notify(db, outcome, **kwargs):
    return notify_refresh_outcome(
        db,
        tenant_id="tenant-1",
        repository_id="repo-1",
        branch="main",
        path="specs/api.yaml",
        trigger=RefreshTrigger.SCHEDULED,
        outcome=outcome,
        **kwargs,
    )


def test_notify_fans_out_one_delivery_per_active_subscription():
    db = FakeDB(["sub-a", "sub-b"])
    event_ids = _notify(db, RefreshOutcome.NEW_VERSION)

    assert event_ids == ["evt-sub-a", "evt-sub-b"]
    assert db.list_calls == ["tenant-1"]
    assert [c["subscription_id"] for c in db.enqueue_calls] == ["sub-a", "sub-b"]
    # Every enqueue carries the same tenant, event type, and payload.
    for call in db.enqueue_calls:
        assert call["tenant_id"] == "tenant-1"
        assert call["event_type"] == "repository.refresh.new_version"
        assert call["payload"]["outcome"] == "new-version"
        assert call["payload"]["reviewHref"].startswith("/ade/dashboard/repositories/repo-1/")


def test_notify_unchanged_is_silent():
    db = FakeDB(["sub-a"])
    assert _notify(db, RefreshOutcome.UNCHANGED) == []
    # No subscriptions are even listed for a silent outcome.
    assert db.list_calls == []
    assert db.enqueue_calls == []


def test_notify_muted_preference_enqueues_nothing():
    db = FakeDB(["sub-a"])
    prefs = RefreshNotificationPreferences(notify_failed=False)
    assert _notify(db, RefreshOutcome.FAILED, preferences=prefs) == []
    assert db.enqueue_calls == []


def test_notify_no_active_subscriptions_returns_empty():
    db = FakeDB([])
    assert _notify(db, RefreshOutcome.FAILED) == []
    assert db.list_calls == ["tenant-1"]
    assert db.enqueue_calls == []


def test_notify_best_effort_when_listing_raises():
    db = FakeDB(["sub-a"], list_raises=True)
    # Listing blows up but the call must not raise.
    assert _notify(db, RefreshOutcome.NEW_VERSION) == []
    assert db.enqueue_calls == []


def test_notify_skips_failed_enqueue_but_continues():
    db = FakeDB(["sub-a", "sub-b", "sub-c"], enqueue_fail_ids={"sub-b"})
    event_ids = _notify(db, RefreshOutcome.DIVERGED)
    # sub-b failed; sub-a and sub-c still delivered.
    assert event_ids == ["evt-sub-a", "evt-sub-c"]
    assert [c["subscription_id"] for c in db.enqueue_calls] == ["sub-a", "sub-b", "sub-c"]


def test_notify_enum_guarding():
    db = FakeDB(["sub-a"])
    with pytest.raises(TypeError):
        notify_refresh_outcome(
            db,
            tenant_id="tenant-1",
            repository_id="repo-1",
            branch="main",
            path="x.yaml",
            trigger="scheduled",
            outcome=RefreshOutcome.NEW_VERSION,
        )


# ------------------------------------------------- auto-pause (RAR-3.4, #3525)


def test_auto_pause_payload_full():
    from app.repository_refresh_notifications import (
        EVENT_TYPE_AUTO_PAUSED,
        build_auto_pause_notification,
    )

    payload = build_auto_pause_notification(
        repository_id="repo-1",
        repository_full_name="octocat/Hello-World",
        consecutive_failures=8,
        threshold=8,
        error="GitHub API: 401 bad credentials",
    )
    assert payload["event"] == EVENT_TYPE_AUTO_PAUSED
    assert payload["repositoryId"] == "repo-1"
    assert payload["repositoryFullName"] == "octocat/Hello-World"
    assert payload["consecutiveFailures"] == 8
    assert payload["threshold"] == 8
    assert payload["error"] == "GitHub API: 401 bad credentials"
    # Deep-link to the Settings tab, where the resume action lives.
    assert payload["resumeHref"] == "/ade/dashboard/repositories/repo-1/preview?tab=settings"


def test_auto_pause_payload_omits_missing_optionals():
    from app.repository_refresh_notifications import build_auto_pause_notification

    payload = build_auto_pause_notification(
        repository_id="repo-1", consecutive_failures=8, threshold=8
    )
    assert "repositoryFullName" not in payload
    assert "error" not in payload


def test_auto_pause_href_url_encodes_repository_id():
    from app.repository_refresh_notifications import build_auto_pause_notification

    payload = build_auto_pause_notification(
        repository_id="repo/1", consecutive_failures=8, threshold=8
    )
    assert payload["resumeHref"] == "/ade/dashboard/repositories/repo%2F1/preview?tab=settings"


def test_notify_auto_paused_fans_out_per_subscription():
    from app.repository_refresh_notifications import (
        EVENT_TYPE_AUTO_PAUSED,
        notify_refresh_auto_paused,
    )

    db = FakeDB(["sub-a", "sub-b"])
    event_ids = notify_refresh_auto_paused(
        db,
        tenant_id="tenant-1",
        repository_id="repo-1",
        consecutive_failures=8,
        threshold=8,
        error="boom",
    )
    assert event_ids == ["evt-sub-a", "evt-sub-b"]
    assert all(c["event_type"] == EVENT_TYPE_AUTO_PAUSED for c in db.enqueue_calls)
    assert db.enqueue_calls[0]["payload"]["consecutiveFailures"] == 8


def test_notify_auto_paused_muted_preference_enqueues_nothing():
    from app.repository_refresh_notifications import notify_refresh_auto_paused

    db = FakeDB(["sub-a"])
    prefs = RefreshNotificationPreferences(notify_auto_paused=False)
    assert (
        notify_refresh_auto_paused(
            db,
            tenant_id="tenant-1",
            repository_id="repo-1",
            consecutive_failures=8,
            threshold=8,
            preferences=prefs,
        )
        == []
    )
    assert db.enqueue_calls == []


def test_notify_auto_paused_best_effort_when_listing_raises():
    from app.repository_refresh_notifications import notify_refresh_auto_paused

    db = FakeDB(["sub-a"], list_raises=True)
    assert (
        notify_refresh_auto_paused(
            db,
            tenant_id="tenant-1",
            repository_id="repo-1",
            consecutive_failures=8,
            threshold=8,
        )
        == []
    )


def test_auto_pause_preference_parsed_from_blob():
    prefs = RefreshNotificationPreferences.from_mapping({"notify_auto_paused": False})
    assert prefs.notify_auto_paused is False
    # REPO-12.5-style alias.
    prefs = RefreshNotificationPreferences.from_mapping({"refresh_auto_paused": False})
    assert prefs.notify_auto_paused is False
    # Absent key defaults on (fails open).
    prefs = RefreshNotificationPreferences.from_mapping({"refresh_failed": False})
    assert prefs.notify_auto_paused is True
