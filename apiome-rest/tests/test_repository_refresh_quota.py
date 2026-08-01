"""Per-tenant polling quota + fairness unit tests (REPO-4.6 #2784, RAR-3.5 #3526).

Pure-module tests over ``app.repository_refresh_quota``: the round-robin
interleave the sweep applies to its due list, the persisted-quota resolution
rules, the windowed quota tracker, the settings/usage loader (including its
best-effort degradation contract), and the per-tenant quota projection the REST
surface returns. The sweep-level integration — deferral without anchor advance,
mid-repo bounding, fairness under load — is covered in
``tests/test_repository_refresh_sweep.py``.
"""

import pytest

import app.config as config
from app.repository_refresh_quota import (
    DEFAULT_TENANT_QUOTA_JOBS,
    DEFAULT_TENANT_QUOTA_WINDOW_SECONDS,
    ENTERPRISE_TENANT_QUOTA_JOBS,
    TenantRefreshQuotaTracker,
    describe_tenant_polling_quota,
    interleave_due_rows_by_tenant,
    load_tenant_refresh_quota_tracker,
    resolve_tenant_polls_per_hour,
)


def _row(repo_id: str, tenant_id: str) -> dict:
    """Minimal due-repository row for interleave tests."""
    return {"id": repo_id, "tenant_id": tenant_id}


# ----------------------------------------------------------- interleave


def test_interleave_empty_list():
    assert interleave_due_rows_by_tenant([]) == []


def test_interleave_single_tenant_order_unchanged():
    rows = [_row("r1", "t1"), _row("r2", "t1"), _row("r3", "t1")]
    assert interleave_due_rows_by_tenant(rows) == rows


def test_interleave_round_robins_tenants():
    """One repo per tenant per round; tenants ordered by first appearance."""
    rows = [
        _row("a1", "t1"),
        _row("a2", "t1"),
        _row("a3", "t1"),
        _row("b1", "t2"),
        _row("b2", "t2"),
        _row("c1", "t3"),
    ]
    ordered = [r["id"] for r in interleave_due_rows_by_tenant(rows)]
    assert ordered == ["a1", "b1", "c1", "a2", "b2", "a3"]


def test_interleave_preserves_within_tenant_order():
    """Each tenant's repos keep their (oldest-first) relative order."""
    rows = [
        _row("b1", "t2"),
        _row("a1", "t1"),
        _row("b2", "t2"),
        _row("a2", "t1"),
    ]
    ordered = [r["id"] for r in interleave_due_rows_by_tenant(rows)]
    assert ordered == ["b1", "a1", "b2", "a2"]
    # Relative order inside each tenant is untouched.
    assert ordered.index("a1") < ordered.index("a2")
    assert ordered.index("b1") < ordered.index("b2")


def test_interleave_keeps_every_row_exactly_once():
    rows = [_row(f"r{i}", f"t{i % 3}") for i in range(10)]
    ordered = interleave_due_rows_by_tenant(rows)
    assert sorted(r["id"] for r in ordered) == sorted(r["id"] for r in rows)


# ----------------------------------------------------------- tracker


def test_tracker_remaining_and_consume():
    tracker = TenantRefreshQuotaTracker(5, {"t1": 3})
    assert tracker.quota == 5
    assert tracker.remaining("t1") == 2
    tracker.consume("t1", 2)
    assert tracker.remaining("t1") == 0
    assert tracker.is_exhausted("t1")


def test_tracker_unknown_tenant_has_full_budget():
    tracker = TenantRefreshQuotaTracker(4, {})
    assert tracker.remaining("t-new") == 4
    assert not tracker.is_exhausted("t-new")


def test_tracker_overuse_floors_remaining_at_zero():
    """A tenant already past the bound (quota lowered mid-window) reads as 0, not negative."""
    tracker = TenantRefreshQuotaTracker(3, {"t1": 10})
    assert tracker.remaining("t1") == 0
    assert tracker.is_exhausted("t1")


def test_tracker_ignores_nonpositive_consume_and_seed():
    tracker = TenantRefreshQuotaTracker(3, {"t1": -2, "t2": None})
    assert tracker.remaining("t1") == 3
    assert tracker.remaining("t2") == 3
    tracker.consume("t1", 0)
    tracker.consume("t1", -5)
    assert tracker.remaining("t1") == 3


def test_tracker_rejects_nonpositive_quota():
    """Disabled quota is 'no tracker', never a sentinel-valued tracker."""
    with pytest.raises(ValueError):
        TenantRefreshQuotaTracker(0, {})


# ----------------------------------------------------------- loader


class _CountingDB:
    """Fake DB exposing the window-usage count and per-tenant limits the loader reads."""

    def __init__(self, counts=None, error=None, limits=None, limits_error=None):
        self._counts = counts or {}
        self._error = error
        self._limits = limits
        self._limits_error = limits_error
        self.windows = []

    def count_recent_repository_refresh_jobs_by_tenant(self, window_seconds):
        self.windows.append(window_seconds)
        if self._error is not None:
            raise self._error
        return dict(self._counts)

    def list_tenant_repository_polls_per_hour(self):
        if self._limits_error is not None:
            raise self._limits_error
        return dict(self._limits or {})

    def get_tenant_repository_polls_per_hour(self, tenant_id):
        if self._limits_error is not None:
            raise self._limits_error
        return (self._limits or {}).get(tenant_id)


def test_loader_disabled_quota_returns_none(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 0)
    db = _CountingDB()
    assert load_tenant_refresh_quota_tracker(db) is None
    assert db.windows == []  # disabled -> usage never queried


def test_loader_seeds_tracker_from_window_usage(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 10)
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_window_seconds", 900)
    db = _CountingDB(counts={"t1": 4})
    tracker = load_tenant_refresh_quota_tracker(db)
    assert tracker is not None
    assert db.windows == [900]
    assert tracker.remaining("t1") == 6
    assert tracker.remaining("t2") == 10


def test_loader_nonpositive_window_falls_back_to_default(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 10)
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_window_seconds", 0)
    db = _CountingDB()
    tracker = load_tenant_refresh_quota_tracker(db)
    assert tracker is not None
    assert db.windows == [DEFAULT_TENANT_QUOTA_WINDOW_SECONDS]


def test_loader_count_error_degrades_to_unlimited(monkeypatch):
    """A usage-count failure disables the bound for the tick, never blocks refresh."""
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 10)
    db = _CountingDB(error=RuntimeError("db down"))
    assert load_tenant_refresh_quota_tracker(db) is None


# --------------------------------------------- REPO-4.6 persisted quota resolution


def test_resolve_unset_uses_the_default():
    assert resolve_tenant_polls_per_hour(None) == DEFAULT_TENANT_QUOTA_JOBS
    assert resolve_tenant_polls_per_hour(None, default_quota=25) == 25


def test_resolve_zero_is_unlimited():
    """A stored 0 is a deliberate opt-out, not an unset value."""
    assert resolve_tenant_polls_per_hour(0) is None
    assert resolve_tenant_polls_per_hour(0, default_quota=600) is None


def test_resolve_negative_is_treated_as_unset():
    """The column's CHECK forbids negatives; if one appears it is not trusted."""
    assert resolve_tenant_polls_per_hour(-5, default_quota=42) == 42


def test_resolve_honors_the_enterprise_allowance():
    assert resolve_tenant_polls_per_hour(ENTERPRISE_TENANT_QUOTA_JOBS) == 600


def test_resolve_nonpositive_default_is_unlimited():
    """Quotas disabled deployment-wide resolve to unbounded, not to zero budget."""
    assert resolve_tenant_polls_per_hour(None, default_quota=0) is None


# --------------------------------------------- REPO-4.6 per-tenant tracker limits


def test_tracker_uses_persisted_limit_over_the_default():
    tracker = TenantRefreshQuotaTracker(60, {}, {"t1": 5})
    assert tracker.quota_for("t1") == 5
    assert tracker.remaining("t1") == 5
    # A tenant with no persisted row still gets the default.
    assert tracker.quota_for("t2") == 60
    assert tracker.remaining("t2") == 60


def test_tracker_zero_limit_tenant_is_unlimited():
    tracker = TenantRefreshQuotaTracker(60, {"t1": 10_000}, {"t1": 0})
    assert tracker.quota_for("t1") is None
    assert tracker.remaining("t1") is None
    assert not tracker.is_exhausted("t1")


def test_tracker_tracks_usage_for_unlimited_tenants_too():
    """Usage keeps accumulating so telemetry and a later quota change see real volume."""
    tracker = TenantRefreshQuotaTracker(60, {}, {"t1": 0})
    tracker.consume("t1", 5)
    assert tracker.remaining("t1") is None
    assert not tracker.is_exhausted("t1")


def test_tracker_persisted_limit_can_exhaust_independently():
    tracker = TenantRefreshQuotaTracker(60, {"small": 2, "big": 2}, {"small": 2, "big": 600})
    assert tracker.is_exhausted("small")
    assert not tracker.is_exhausted("big")
    assert tracker.remaining("big") == 598


def test_loader_seeds_persisted_limits(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    db = _CountingDB(counts={"t1": 1}, limits={"t1": 600})
    tracker = load_tenant_refresh_quota_tracker(db)
    assert tracker is not None
    assert tracker.quota_for("t1") == 600
    assert tracker.remaining("t1") == 599


def test_loader_limits_error_falls_back_to_the_default(monkeypatch):
    """Unlike a usage-count failure, a limits failure still leaves the sweep bounded."""
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 7)
    db = _CountingDB(limits_error=RuntimeError("limits query failed"))
    tracker = load_tenant_refresh_quota_tracker(db)
    assert tracker is not None
    assert tracker.quota_for("t1") == 7


# --------------------------------------------- REPO-4.6 quota projection


def test_describe_reports_persisted_quota_and_usage(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_window_seconds", 3600)
    db = _CountingDB(counts={"t1": 15}, limits={"t1": 600})

    quota = describe_tenant_polling_quota(db, "t1")

    assert quota == {
        "polls_per_hour": 600,
        "effective_polls_per_hour": 600,
        "window_seconds": 3600,
        "used_this_window": 15,
        "remaining_this_window": 585,
        "enforced": True,
    }


def test_describe_reports_the_default_for_an_unconfigured_tenant(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    db = _CountingDB()

    quota = describe_tenant_polling_quota(db, "t-new")

    assert quota["polls_per_hour"] == 60
    assert quota["effective_polls_per_hour"] == 60
    assert quota["enforced"] is True


def test_describe_reports_an_unlimited_tenant(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    db = _CountingDB(counts={"t1": 99}, limits={"t1": 0})

    quota = describe_tenant_polling_quota(db, "t1")

    assert quota["polls_per_hour"] == 0
    assert quota["effective_polls_per_hour"] is None
    assert quota["remaining_this_window"] is None
    assert quota["enforced"] is False
    assert quota["used_this_window"] == 99  # usage is still reported


def test_describe_reports_not_enforced_when_quotas_are_disabled(monkeypatch):
    """The stored value is retained and reported even while the kill switch is off."""
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 0)
    db = _CountingDB(limits={"t1": 120})

    quota = describe_tenant_polling_quota(db, "t1")

    assert quota["polls_per_hour"] == 120
    assert quota["effective_polls_per_hour"] is None
    assert quota["enforced"] is False


def test_describe_usage_error_reports_zero_used(monkeypatch):
    """An operator asking 'what is my quota?' still gets an answer."""
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    db = _CountingDB(error=RuntimeError("db down"), limits={"t1": 60})

    quota = describe_tenant_polling_quota(db, "t1")

    assert quota["used_this_window"] == 0
    assert quota["remaining_this_window"] == 60


def test_describe_nonpositive_window_falls_back_to_the_default(monkeypatch):
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_window_seconds", -1)
    db = _CountingDB()

    quota = describe_tenant_polling_quota(db, "t1")

    assert quota["window_seconds"] == DEFAULT_TENANT_QUOTA_WINDOW_SECONDS
    assert db.windows == [DEFAULT_TENANT_QUOTA_WINDOW_SECONDS]
