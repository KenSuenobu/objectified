"""Per-tenant refresh quota + fairness unit tests (RAR-3.5, #3526).

Pure-module tests over ``app.repository_refresh_quota``: the round-robin
interleave the sweep applies to its due list, the windowed quota tracker, and
the settings/usage loader (including its best-effort degradation contract).
The sweep-level integration — deferral without anchor advance, mid-repo
bounding, fairness under load — is covered in
``tests/test_repository_refresh_sweep.py``.
"""

import pytest

import app.config as config
from app.repository_refresh_quota import (
    DEFAULT_TENANT_QUOTA_WINDOW_SECONDS,
    TenantRefreshQuotaTracker,
    interleave_due_rows_by_tenant,
    load_tenant_refresh_quota_tracker,
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
    """Fake DB exposing only the window-usage count the loader needs."""

    def __init__(self, counts=None, error=None):
        self._counts = counts or {}
        self._error = error
        self.windows = []

    def count_recent_repository_refresh_jobs_by_tenant(self, window_seconds):
        self.windows.append(window_seconds)
        if self._error is not None:
            raise self._error
        return dict(self._counts)


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
