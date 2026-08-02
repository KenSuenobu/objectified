"""Retention behavior of schema test suite runs — IXH-5.7 (#5119).

Two halves, both bounded and both tested here at the store seam: the prune-on-write cap that
rides every run insert, and the age prune the IXH-6.3 sweep drives (whose sweep-side wiring is
covered in ``test_async_job_retention_sweep.py``).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, List
from unittest.mock import patch

from app import schema_suite_store as store


class RecordingDb:
    """Records prune calls and returns scripted counts."""

    def __init__(self, *, age_prune_result: Any = 0, cap_prune_result: int = 0) -> None:
        self.age_calls: List[Any] = []
        self.cap_calls: List[Any] = []
        self._age_prune_result = age_prune_result
        self._cap_prune_result = cap_prune_result

    def prune_schema_suite_runs_by_age(self, older_than, keep_min):
        if isinstance(self._age_prune_result, Exception):
            raise self._age_prune_result
        self.age_calls.append((older_than, keep_min))
        return self._age_prune_result

    def prune_schema_suite_runs_over_cap(self, suite_id, max_per_suite):
        self.cap_calls.append((suite_id, max_per_suite))
        return self._cap_prune_result


def _settings(**overrides: Any) -> SimpleNamespace:
    """The retention settings the store reads, with per-test overrides."""
    values = {
        "schema_suite_run_retention_days": 180,
        "schema_suite_run_keep_min": 20,
        "schema_suite_run_max_per_suite": 200,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_age_prune_resolves_window_and_floor_from_settings() -> None:
    db = RecordingDb(age_prune_result=9)
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    with patch.object(store, "settings", _settings(schema_suite_run_retention_days=90,
                                                   schema_suite_run_keep_min=7)):
        pruned = store.prune_schema_suite_runs(db, now=now)
    assert pruned == 9
    assert db.age_calls == [(now - timedelta(days=90), 7)]


def test_age_prune_overrides_beat_settings() -> None:
    """The sweep's per-arg overrides pass straight through, like its sibling prunes."""
    db = RecordingDb(age_prune_result=1)
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    with patch.object(store, "settings", _settings()):
        store.prune_schema_suite_runs(db, now=now, retention_days=30, keep_min=3)
    assert db.age_calls == [(now - timedelta(days=30), 3)]


def test_age_prune_disabled_at_zero_or_below() -> None:
    """The documented way to keep run history forever."""
    db = RecordingDb()
    with patch.object(store, "settings", _settings(schema_suite_run_retention_days=0)):
        assert store.prune_schema_suite_runs(db) == 0
    assert store.prune_schema_suite_runs(RecordingDb(), retention_days=-5) == 0
    assert db.age_calls == []


def test_age_prune_survives_a_database_fault() -> None:
    """The sweep tick must survive a bad prune and retry next interval."""
    db = RecordingDb(age_prune_result=RuntimeError("table gone"))
    with patch.object(store, "settings", _settings()):
        assert store.prune_schema_suite_runs(db) == 0


def test_insert_run_prunes_that_suite_over_the_cap() -> None:
    """Prune-on-write rides every successful insert, scoped to the suite that grew."""
    recording = RecordingDb()
    suite_id = "6a8f7c1e-0000-4000-8000-000000000001"

    class InsertingDb(RecordingDb):
        def insert_schema_test_suite_run(self, **kwargs):
            return {"id": "run-1", "suite_id": suite_id}

        def prune_schema_suite_runs_over_cap(self, sid, cap):
            recording.cap_calls.append((sid, cap))
            return 1

    with patch.object(store, "db", InsertingDb()), patch.object(
        store, "settings", _settings(schema_suite_run_max_per_suite=42)
    ):
        run = store.insert_run(suite_id=suite_id, tenant_id="t", suite_version=1,
                               requested_ref="r", resolved_revision_id=None,
                               resolved_version_label=None, trigger="manual",
                               status="completed", total=0, passed=0, failed=0,
                               errored=0, regression=False, baseline_run_id=None,
                               message=None, results=[])
    assert run == {"id": "run-1", "suite_id": suite_id}
    assert recording.cap_calls == [(suite_id, 42)]


def test_cap_prune_disabled_at_zero_or_below() -> None:
    db = RecordingDb()
    with patch.object(store, "db", db), patch.object(
        store, "settings", _settings(schema_suite_run_max_per_suite=0)
    ):
        assert store.prune_runs_over_cap("6a8f7c1e-0000-4000-8000-000000000001") == 0
    assert db.cap_calls == []
