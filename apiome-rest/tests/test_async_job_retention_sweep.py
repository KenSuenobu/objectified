"""Unit tests for the async job retention sweep (IXH-6.3, #5122)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.async_job_retention_sweep import (
    async_job_retention_policies,
    process_async_job_retention_sweep,
)


class FakeDb:
    def __init__(self):
        self.reap_artifact_calls = []
        self.reap_job_calls = []
        self.prune_calls = []
        self.quota_window_prune_calls = []
        self.quality_rank_prune_calls = []
        self.suite_run_prune_calls = []
        self._job_batches = []
        self._artifact_counts = []
        self._prune_counts = []
        self._quota_window_prune_counts = []
        self._quality_rank_prune_counts = []
        self._suite_run_prune_counts = []

    def reap_expired_export_job_artifacts(self, *, now=None, limit=100):
        self.reap_artifact_calls.append((now, limit))
        if self._artifact_counts:
            return self._artifact_counts.pop(0)
        return 0

    def reap_expired_async_jobs(self, *, policies, limit=100, now=None):
        self.reap_job_calls.append((policies, limit, now))
        if self._job_batches:
            return self._job_batches.pop(0)
        return []

    def prune_async_job_history(self, *, older_than, limit=100):
        self.prune_calls.append((older_than, limit))
        if self._prune_counts:
            return self._prune_counts.pop(0)
        return 0

    def prune_repository_quota_windows(self, *, older_than):
        self.quota_window_prune_calls.append(older_than)
        if self._quota_window_prune_counts:
            return self._quota_window_prune_counts.pop(0)
        return 0

    def prune_quality_rank_observations(self, *, older_than):
        self.quality_rank_prune_calls.append(older_than)
        if self._quality_rank_prune_counts:
            return self._quality_rank_prune_counts.pop(0)
        return 0

    def prune_schema_suite_runs_by_age(self, older_than, keep_min):
        self.suite_run_prune_calls.append((older_than, keep_min))
        if self._suite_run_prune_counts:
            return self._suite_run_prune_counts.pop(0)
        return 0


def test_policies_omit_zero_hours():
    with patch("app.async_job_retention_sweep.settings") as settings:
        settings.async_job_retention_export_completed_hours = 168
        settings.async_job_retention_export_failed_hours = 0
        settings.async_job_retention_export_canceled_hours = 168
        settings.async_job_retention_spec_import_completed_hours = 168
        settings.async_job_retention_spec_import_failed_hours = 720
        settings.async_job_retention_spec_import_canceled_hours = 168
        now = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
        policies = async_job_retention_policies(now=now)
    assert ("export", "failed") not in policies
    assert policies[("export", "completed")] == now - timedelta(hours=168)
    assert policies[("spec_import", "failed")] == now - timedelta(hours=720)


def test_sweep_reaps_artifacts_jobs_and_history():
    db = FakeDb()
    db._artifact_counts = [3]
    db._job_batches = [
        [
            {"job_id": "a", "kind": "export", "tenant_slug": "t", "state": "completed"},
            {"job_id": "b", "kind": "export", "tenant_slug": "t", "state": "failed"},
        ]
    ]
    db._prune_counts = [1]
    db._quota_window_prune_counts = [4]
    db._quality_rank_prune_counts = [5]
    db._suite_run_prune_counts = [6]
    now = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
    with patch("app.async_job_retention_sweep.settings") as settings:
        settings.async_job_retention_export_completed_hours = 1
        settings.async_job_retention_export_failed_hours = 1
        settings.async_job_retention_export_canceled_hours = 1
        settings.async_job_retention_spec_import_completed_hours = 1
        settings.async_job_retention_spec_import_failed_hours = 1
        settings.async_job_retention_spec_import_canceled_hours = 1
        settings.async_job_history_retention_days = 90
        settings.async_job_retention_sweep_batch_size = 50
        settings.repository_quota_window_retention_days = 120
        settings.quality_rank_retention_days = 180
        result = process_async_job_retention_sweep(
            db, now=now, batch_size=50, schema_suite_run_retention_days=180,
            schema_suite_run_keep_min=20,
        )
    assert result == {
        "artifacts_reaped": 3,
        "jobs_deleted": 2,
        "history_pruned": 1,
        "quota_windows_pruned": 4,
        "quality_ranks_pruned": 5,
        "suite_runs_pruned": 6,
    }
    assert db.reap_artifact_calls[0][1] == 50
    assert len(db.reap_job_calls[0][0]) == 6
    assert db.prune_calls[0][0] == now - timedelta(days=90)
    assert db.quota_window_prune_calls[0] == now - timedelta(days=120)
    assert db.quality_rank_prune_calls[0] == now - timedelta(days=180)
    assert db.suite_run_prune_calls[0] == (now - timedelta(days=180), 20)


def test_sweep_second_tick_is_idempotent_when_empty():
    db = FakeDb()
    first = process_async_job_retention_sweep(db, batch_size=10, history_retention_days=30)
    second = process_async_job_retention_sweep(db, batch_size=10, history_retention_days=30)
    assert first == {
        "artifacts_reaped": 0,
        "jobs_deleted": 0,
        "history_pruned": 0,
        "quota_windows_pruned": 0,
        "quality_ranks_pruned": 0,
        "suite_runs_pruned": 0,
    }
    assert second == first
    assert len(db.reap_artifact_calls) == 2
    assert len(db.reap_job_calls) == 2


def test_sweep_survives_partial_failures():
    class BrokenArtifacts(FakeDb):
        def reap_expired_export_job_artifacts(self, **kwargs):
            raise RuntimeError("artifacts down")

    class BrokenJobs(FakeDb):
        def reap_expired_async_jobs(self, **kwargs):
            raise RuntimeError("jobs down")

        def reap_expired_export_job_artifacts(self, **kwargs):
            return 2

    assert process_async_job_retention_sweep(BrokenArtifacts(), batch_size=5)[
        "artifacts_reaped"
    ] == 0
    result = process_async_job_retention_sweep(BrokenJobs(), batch_size=5)
    assert result["artifacts_reaped"] == 2
    assert result["jobs_deleted"] == 0


def test_history_prune_skipped_when_days_non_positive():
    db = FakeDb()
    process_async_job_retention_sweep(db, history_retention_days=0)
    assert db.prune_calls == []


# --- REPO-7.3 (#2801): quota telemetry counter retention ------------------------------------


def test_quota_window_prune_is_bounded_by_its_own_retention_window():
    """The counters outlive job history deliberately: the telemetry API will serve a 90-day
    range, so a 30-day counter retention would silently truncate a supported read."""
    db = FakeDb()
    now = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
    process_async_job_retention_sweep(
        db, now=now, history_retention_days=30, quota_window_retention_days=120
    )
    assert db.quota_window_prune_calls == [now - timedelta(days=120)]


def test_quota_window_prune_skipped_when_days_non_positive():
    """The documented way to keep counters forever."""
    db = FakeDb()
    process_async_job_retention_sweep(db, quota_window_retention_days=0)
    assert db.quota_window_prune_calls == []


def test_a_failed_quota_window_prune_does_not_lose_the_rest_of_the_tick():
    class BrokenQuotaWindows(FakeDb):
        def prune_repository_quota_windows(self, **kwargs):
            raise RuntimeError("quota window table is gone")

        def reap_expired_export_job_artifacts(self, **kwargs):
            return 2

    result = process_async_job_retention_sweep(
        BrokenQuotaWindows(), history_retention_days=30, quota_window_retention_days=120
    )
    assert result["artifacts_reaped"] == 2
    assert result["quota_windows_pruned"] == 0


# --- IXH-2.7 (#5102): quality-rank observation retention -------------------------------------


def test_quality_rank_prune_is_bounded_by_its_own_retention_window():
    """Grade observations are events, so retention is what keeps the series table bounded."""
    db = FakeDb()
    db._quality_rank_prune_counts = [12]
    now = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
    result = process_async_job_retention_sweep(
        db, now=now, history_retention_days=30, quality_rank_retention_days=180
    )
    assert db.quality_rank_prune_calls == [now - timedelta(days=180)]
    assert result["quality_ranks_pruned"] == 12


def test_quality_rank_prune_skipped_when_days_non_positive():
    """The documented way to keep observations forever."""
    db = FakeDb()
    process_async_job_retention_sweep(db, quality_rank_retention_days=0)
    assert db.quality_rank_prune_calls == []


def test_a_failed_quality_rank_prune_does_not_lose_the_rest_of_the_tick():
    class BrokenQualityRanks(FakeDb):
        def prune_quality_rank_observations(self, **kwargs):
            raise RuntimeError("observation table is gone")

        def reap_expired_export_job_artifacts(self, **kwargs):
            return 2

    result = process_async_job_retention_sweep(
        BrokenQualityRanks(), history_retention_days=30, quality_rank_retention_days=180
    )
    assert result["artifacts_reaped"] == 2
    assert result["quality_ranks_pruned"] == 0


# --- IXH-5.7 (#5119): schema test suite run retention ----------------------------------------


def test_suite_run_prune_keeps_the_newest_runs_regardless_of_age():
    """The keep_min floor rides along so a rarely-run suite never loses its baseline."""
    db = FakeDb()
    db._suite_run_prune_counts = [7]
    now = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
    result = process_async_job_retention_sweep(
        db,
        now=now,
        history_retention_days=30,
        schema_suite_run_retention_days=90,
        schema_suite_run_keep_min=5,
    )
    assert db.suite_run_prune_calls == [(now - timedelta(days=90), 5)]
    assert result["suite_runs_pruned"] == 7


def test_suite_run_prune_skipped_when_days_non_positive():
    """The documented way to keep run history forever (the per-suite cap still applies)."""
    db = FakeDb()
    process_async_job_retention_sweep(db, schema_suite_run_retention_days=0)
    assert db.suite_run_prune_calls == []


def test_a_failed_suite_run_prune_does_not_lose_the_rest_of_the_tick():
    class BrokenSuiteRuns(FakeDb):
        def prune_schema_suite_runs_by_age(self, older_than, keep_min):
            raise RuntimeError("suite run table is gone")

        def reap_expired_export_job_artifacts(self, **kwargs):
            return 2

    result = process_async_job_retention_sweep(
        BrokenSuiteRuns(), history_retention_days=30, schema_suite_run_retention_days=90
    )
    assert result["artifacts_reaped"] == 2
    assert result["suite_runs_pruned"] == 0
