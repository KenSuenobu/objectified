"""Refresh sweep orchestration tests (RAR-3.2, #3523).

Deterministic, DB-free fixtures over ``app.repository_refresh_sweep`` using a fake
``Database`` that records calls. The GitHub walk
(``scan_repository_branch_into_index``) is monkeypatched so no network is touched.

Covers the acceptance criteria:
  - only stale + newer files enqueue (up-to-date / stale-guarded files do not);
  - each enqueued job carries the stored spec snapshot;
  - per-repo single-flight via the advisory lock (a held lock skips the repo);
  - ``last_refreshed_at`` is advanced each tick, including on rescan failure.

Plus the RAR-3.4 (#3525) backoff/auto-pause bookkeeping the sweep feeds:
  - a failed tick records a refresh failure (with the branch error detail);
  - a successful tick resets the failure counter (only when it was non-zero);
  - the auto-pause transition fires the RAR-5.4 notification exactly once;
  - bookkeeping/notification errors never abort the sweep.

Plus the RAR-3.5 (#3526) per-tenant quotas / fairness:
  - the due list is round-robin interleaved across tenants;
  - a tenant over its windowed quota has its repos deferred (no lock, no
    anchor advance, no failure) while other tenants proceed;
  - the quota bounds enqueues mid-repo and across a tenant's repos in one tick;
  - deferral never records a refresh failure;
  - a disabled quota (<= 0) or a usage-count error degrades to unlimited;
  - the manual path (no ``max_enqueues``) is never quota-limited.

Plus the REPO-4.6 (#2784) persisted per-tenant polling quota:
  - ``tenants.repository_polls_per_hour`` overrides the setting default, in both
    the more- and less-generous direction, and tenants bound independently;
  - a stored ``0`` means that tenant is unlimited;
  - a limits-read failure falls back to the default (still bounded), unlike a
    usage-count failure which degrades to unlimited;
  - dispatches and both kinds of deferral are counted in the in-process polling
    telemetry, and a deferral is never recorded as a failure.

Plus the REPO-7.3 (#2801) durable rolling-window counters:
  - a dispatch records the jobs it enqueued (the unit the quota bounds), and both
    kinds of deferral are counted as metrics of their own, never folded into it;
  - a tick that enqueued nothing writes no row at all;
  - counters are attributed per tenant;
  - a counter write failure never becomes a refresh failure and never blocks a
    deferral.
"""

from datetime import datetime, timedelta, timezone

import pytest

import app.repository_refresh_sweep as sweep
from app.repository_file_scan import ScanPass
from app.repository_refresh_sweep import process_repository_refresh_sweep

NOW = datetime(2026, 6, 21, 12, 0, 0, tzinfo=timezone.utc)
OLDER = (NOW - timedelta(days=2)).isoformat()
NEWER = (NOW - timedelta(hours=1)).isoformat()


def _candidate(path: str, *, remote_committed_at, remote_blob, last_committed_at, last_blob):
    """Build a refresh-candidate row as ``list_repository_refresh_candidates`` returns."""
    return {
        "import_spec_id": f"spec-{path}",
        "tenant_id": "t1",
        "repository_id": "r1",
        "branch": "main",
        "path": path,
        "project_id": "p1",
        "source_kind": "openapi-3",
        "format_override": None,
        "content_type": "application/yaml",
        "options_json": {"naming_convention": "camelCase"},
        "spec_schema_version": 1,
        "created_by": "u1",
        "last_imported_commit_sha": "old-commit",
        "last_imported_committed_at": last_committed_at,
        "last_imported_blob_sha": last_blob,
        "remote_commit_sha": "new-commit",
        "remote_committed_at": remote_committed_at,
        "remote_blob_sha": remote_blob,
    }


class FakeDB:
    """Records sweep interactions; no real database."""

    def __init__(
        self,
        *,
        due=None,
        branches=None,
        candidates=None,
        lock_result=True,
        recent_jobs_by_tenant=None,
        polls_per_hour_by_tenant=None,
    ):
        self._due = due if due is not None else []
        self._branches = branches if branches is not None else {}
        self._candidates = candidates if candidates is not None else {}
        self._lock_result = lock_result
        # RAR-3.5: jobs already enqueued per tenant inside the quota window.
        self._recent_jobs_by_tenant = recent_jobs_by_tenant or {}
        # REPO-4.6: persisted tenants.repository_polls_per_hour per tenant.
        self._polls_per_hour_by_tenant = polls_per_hour_by_tenant or {}
        self.acquired = []
        self.released = []
        self.scanned = []
        self.enqueued = []
        self.refreshed = []
        # RAR-3.4 bookkeeping recorders + the canned outcome record_..._failure returns.
        self.failures_recorded = []
        self.successes_recorded = []
        self.failure_outcome = {
            "consecutive_failures": 1,
            "backoff_seconds": 600,
            "paused": False,
            "newly_paused": False,
        }
        # REPO-7.3: durable rolling-window counter writes.
        self.quota_windows = []
        # Track active (queued/running) lineages to emulate the idempotent insert.
        self._active_lineage = set()

    # --- due selection / lock ---
    def list_due_repositories(self):
        return list(self._due)

    # --- RAR-3.5 tenant quota window usage ---
    def count_recent_repository_refresh_jobs_by_tenant(self, window_seconds):
        return dict(self._recent_jobs_by_tenant)

    # --- REPO-4.6 persisted per-tenant polling quotas ---
    def list_tenant_repository_polls_per_hour(self):
        return dict(self._polls_per_hour_by_tenant)

    def try_acquire_repository_refresh_lock(self, repository_id):
        self.acquired.append(repository_id)
        return self._lock_result

    def release_repository_refresh_lock(self, repository_id):
        self.released.append(repository_id)

    # --- per-repo work ---
    def list_repository_import_spec_branches(self, repository_id):
        return list(self._branches.get(repository_id, []))

    def get_tenant_repository(self, tenant_id, repository_id):
        return {"id": repository_id, "tenant_id": tenant_id, "provider": "github"}

    def list_repository_refresh_candidates(self, repository_id, branch):
        return list(self._candidates.get((repository_id, branch), []))

    def enqueue_repository_refresh_job(self, **kwargs):
        key = (kwargs["repository_id"], kwargs["branch"], kwargs["path"])
        if key in self._active_lineage:
            return None  # idempotent no-op (active job already exists)
        self._active_lineage.add(key)
        row = dict(kwargs)
        row["id"] = f"job-{kwargs['path']}"
        self.enqueued.append(row)
        return row

    def mark_repository_refreshed(self, repository_id):
        self.refreshed.append(repository_id)
        return True

    # --- RAR-3.4 failure bookkeeping ---
    def record_repository_refresh_failure(self, repository_id, *, error=None):
        self.failures_recorded.append({"repository_id": repository_id, "error": error})
        return dict(self.failure_outcome)

    def record_repository_refresh_success(self, repository_id):
        self.successes_recorded.append(repository_id)
        return True

    # --- REPO-7.3 durable quota telemetry ---
    def increment_repository_quota_window(
        self, *, tenant_id, metric, window_kind, window_start, amount
    ):
        self.quota_windows.append(
            {
                "tenant_id": tenant_id,
                "metric": metric,
                "window_kind": window_kind,
                "window_start": window_start,
                "amount": amount,
            }
        )

    def quota_total(self, metric, tenant_id="t1"):
        """Sum every increment recorded for one (tenant, metric) pair."""
        return sum(
            row["amount"]
            for row in self.quota_windows
            if row["metric"] == metric and row["tenant_id"] == tenant_id
        )


@pytest.fixture(autouse=True)
def _patch_scan(monkeypatch):
    """Replace the GitHub walk with a recorder so no network is hit."""
    calls = []

    def _fake_scan(db, repo_row, branch):
        calls.append((str(repo_row["id"]), branch))
        db.scanned.append((str(repo_row["id"]), branch))
        return ScanPass(total_files=1, importable_count=1, completed=True, resumed=False)

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _fake_scan)
    return calls


def test_only_stale_files_enqueue():
    """A stale file enqueues; an up-to-date and a stale-guarded file do not."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    up_to_date = _candidate(
        "api/unchanged.yaml",
        remote_committed_at=OLDER, remote_blob="blob-x",
        last_committed_at=OLDER, last_blob="blob-x",
    )
    reverted = _candidate(  # remote commit OLDER than last import -> stale guard
        "api/reverted.yaml",
        remote_committed_at=OLDER, remote_blob="blob-different",
        last_committed_at=NEWER, last_blob="blob-old",
    )
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale, up_to_date, reverted]},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["api/openapi.yaml"]


def test_enqueued_job_carries_stored_spec():
    """The job snapshot carries the stored spec + the remote signals that fired it."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    process_repository_refresh_sweep(db)

    job = db.enqueued[0]
    assert job["import_spec_id"] == "spec-api/openapi.yaml"
    assert job["project_id"] == "p1"
    assert job["source_kind"] == "openapi-3"
    assert job["content_type"] == "application/yaml"
    assert job["options_json"] == {"naming_convention": "camelCase"}
    assert job["remote_blob_sha"] == "blob-new"
    assert job["remote_commit_sha"] == "new-commit"
    assert job["refresh_reason"] == "newer-content"


def test_lock_held_skips_repo():
    """A repo whose advisory lock is held is skipped: no scan, no enqueue, no anchor."""
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
        lock_result=False,
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 0
    assert db.acquired == ["r1"]
    assert db.released == []          # never acquired -> never released
    assert db.scanned == []
    assert db.refreshed == []         # anchor NOT advanced when we never held the lock


def test_anchor_advanced_and_lock_released_each_tick():
    """Even with nothing to enqueue, the anchor advances and the lock releases."""
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": []},          # no specs -> no GitHub walk
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 0
    assert db.scanned == []           # branch list empty -> walker untouched
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


def test_anchor_advanced_on_rescan_failure(monkeypatch):
    """A GitHub walk failure still advances the anchor and releases the lock."""

    def _boom(db, repo_row, branch):
        raise ValueError("GitHub branches API error: HTTP 503")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 0
    assert db.refreshed == ["r1"]     # advanced despite the failure
    assert db.released == ["r1"]


def test_idempotent_enqueue_not_double_counted():
    """A second tick over an already-queued lineage enqueues nothing new."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    first = process_repository_refresh_sweep(db)
    second = process_repository_refresh_sweep(db)

    assert first == 1
    assert second == 0                # active job already exists -> no-op
    assert len(db.enqueued) == 1


def test_global_kill_switch_halts_sweep(monkeypatch):
    """APIOME_REFRESH_ENABLED=False halts the tick before any repo work (RAR-3.3)."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_enabled", False)

    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 0
    # Halt is total: no lock taken, no scan, no enqueue, no anchor advance.
    assert db.acquired == []
    assert db.scanned == []
    assert db.enqueued == []
    assert db.refreshed == []


def test_global_kill_switch_enabled_runs_sweep(monkeypatch):
    """With the kill switch explicitly enabled the sweep behaves normally (RAR-3.3)."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_enabled", True)

    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert db.refreshed == ["r1"]


def test_multiple_branches_each_rescanned():
    """Every branch with a stored spec is rescanned and evaluated."""
    stale_main = _candidate(
        "main.yaml",
        remote_committed_at=NEWER, remote_blob="b1",
        last_committed_at=OLDER, last_blob="b0",
    )
    stale_dev = dict(stale_main, path="dev.yaml", branch="dev")
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main", "dev"]},
        candidates={
            ("r1", "main"): [stale_main],
            ("r1", "dev"): [stale_dev],
        },
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 2
    assert db.scanned == [("r1", "main"), ("r1", "dev")]


# ----------------------------------------------- RAR-3.4 backoff / auto-pause


def test_rescan_failure_records_refresh_failure(monkeypatch):
    """A failed branch rescan records a refresh failure with the error detail."""

    def _boom(db, repo_row, branch):
        raise ValueError("GitHub branches API error: HTTP 503")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    process_repository_refresh_sweep(db)

    assert len(db.failures_recorded) == 1
    assert db.failures_recorded[0]["repository_id"] == "r1"
    assert "HTTP 503" in db.failures_recorded[0]["error"]
    assert db.successes_recorded == []
    # The tick still advances the anchor and releases the lock.
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


def test_success_after_failures_resets_counter():
    """A good tick on a repo with prior failures resets its counter (AC: reset on success)."""
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1", "refresh_consecutive_failures": 3}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    process_repository_refresh_sweep(db)

    assert db.successes_recorded == ["r1"]
    assert db.failures_recorded == []


def test_healthy_success_skips_reset_write():
    """A good tick on an already-healthy repo (0 failures) skips the reset UPDATE."""
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1", "refresh_consecutive_failures": 0}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    process_repository_refresh_sweep(db)

    assert db.successes_recorded == []
    assert db.failures_recorded == []


def _capture_repository_notifications(monkeypatch):
    """Record the REPO-7.2 notification entrypoints the sweep calls, without delivering.

    Returns a ``{event_name: [kwargs, ...]}`` dict populated as the sweep runs.
    """
    import app.repository_event_notifications as notifications

    captured = {"auto_paused": [], "repeated_failures": []}
    for name, key in (
        ("notify_repository_auto_paused", "auto_paused"),
        ("notify_repository_repeated_failures", "repeated_failures"),
    ):
        monkeypatch.setattr(
            notifications,
            name,
            lambda db, _bucket=captured[key], **kwargs: _bucket.append(kwargs) or [],
        )
    return captured


def test_auto_pause_transition_fires_notification_once(monkeypatch):
    """newly_paused=True fires the REPO-7.2 auto-pause notification exactly once."""

    def _boom(db, repo_row, branch):
        raise ValueError("bad credentials")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)
    captured = _capture_repository_notifications(monkeypatch)

    db = FakeDB(
        due=[
            {
                "id": "r1",
                "tenant_id": "t1",
                "repository_full_name": "octocat/Hello-World",
                "refresh_consecutive_failures": 7,
            }
        ],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )
    db.failure_outcome = {
        "consecutive_failures": 8,
        "backoff_seconds": 9600,
        "paused": True,
        "newly_paused": True,
    }

    process_repository_refresh_sweep(db)

    notified = captured["auto_paused"]
    assert len(notified) == 1
    assert notified[0]["repository_id"] == "r1"
    assert notified[0]["tenant_id"] == "t1"
    assert notified[0]["repository_full_name"] == "octocat/Hello-World"
    assert notified[0]["consecutive_failures"] == 8
    assert "bad credentials" in notified[0]["error"]


def test_a_newly_paused_repository_is_not_also_warned_about_repeated_failures(monkeypatch):
    """The pause is the stronger statement; pairing it with the warning is just noise."""

    def _boom(db, repo_row, branch):
        raise ValueError("bad credentials")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)
    captured = _capture_repository_notifications(monkeypatch)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1", "refresh_consecutive_failures": 7}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )
    db.failure_outcome = {
        "consecutive_failures": 8,
        "backoff_seconds": 9600,
        "paused": True,
        "newly_paused": True,
    }

    process_repository_refresh_sweep(db)

    assert captured["repeated_failures"] == []


def test_repeated_failures_warn_before_the_pause(monkeypatch):
    """An unpaused repository past the warning threshold gets the REPO-7.2 warning shot; the
    hourly throttle is what keeps it from firing on every tick."""

    def _boom(db, repo_row, branch):
        raise ValueError("clone timed out")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)
    captured = _capture_repository_notifications(monkeypatch)

    db = FakeDB(
        due=[
            {
                "id": "r1",
                "tenant_id": "t1",
                "repository_full_name": "octocat/Hello-World",
                "refresh_consecutive_failures": 2,
            }
        ],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )
    db.failure_outcome = {
        "consecutive_failures": 3,
        "backoff_seconds": 600,
        "paused": False,
        "newly_paused": False,
    }

    process_repository_refresh_sweep(db)

    warned = captured["repeated_failures"]
    assert len(warned) == 1
    assert warned[0]["consecutive_failures"] == 3
    assert warned[0]["repository_full_name"] == "octocat/Hello-World"
    assert captured["auto_paused"] == []


def test_a_first_failure_is_not_worth_telling_anyone_about(monkeypatch):
    """Below the threshold a failure is a provider blip; the RAR-3.4 backoff handles it."""

    def _boom(db, repo_row, branch):
        raise ValueError("transient")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)
    captured = _capture_repository_notifications(monkeypatch)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )
    db.failure_outcome = {
        "consecutive_failures": 1,
        "backoff_seconds": 60,
        "paused": False,
        "newly_paused": False,
    }

    process_repository_refresh_sweep(db)

    assert captured["repeated_failures"] == []
    assert captured["auto_paused"] == []


def test_already_paused_failure_does_not_renotify(monkeypatch):
    """paused=True but newly_paused=False (renewal) stays silent on both events."""

    def _boom(db, repo_row, branch):
        raise ValueError("still broken")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)
    captured = _capture_repository_notifications(monkeypatch)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )
    db.failure_outcome = {
        "consecutive_failures": 9,
        "backoff_seconds": 9600,
        "paused": True,
        "newly_paused": False,
    }

    process_repository_refresh_sweep(db)

    assert captured["auto_paused"] == []
    assert captured["repeated_failures"] == []
    assert len(db.failures_recorded) == 1


def test_bookkeeping_error_does_not_abort_sweep(monkeypatch):
    """A record_..._failure crash is swallowed: anchor advances, lock releases, next repo runs."""

    def _boom(db, repo_row, branch):
        raise ValueError("walk failed")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)

    db = FakeDB(
        due=[
            {"id": "r1", "tenant_id": "t1"},
            {"id": "r2", "tenant_id": "t1"},
        ],
        branches={"r1": ["main"], "r2": []},
        candidates={("r1", "main"): []},
    )

    def _record_boom(repository_id, *, error=None):
        raise RuntimeError("bookkeeping DB down")

    db.record_repository_refresh_failure = _record_boom

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 0
    assert db.refreshed == ["r1", "r2"]   # both repos still processed
    assert db.released == ["r1", "r2"]


def test_repo_level_error_counts_as_failed_tick(monkeypatch):
    """An error outside the branch loop (e.g. branch listing) records a failure too."""
    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    def _listing_boom(repository_id):
        raise RuntimeError("branch listing query failed")

    db.list_repository_import_spec_branches = _listing_boom

    process_repository_refresh_sweep(db)

    assert len(db.failures_recorded) == 1
    assert "branch listing query failed" in db.failures_recorded[0]["error"]
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


# ----------------------------------------------- RAR-3.5 tenant quotas / fairness


def _stale(path):
    """A stale + newer candidate (always passes the freshness gate)."""
    return _candidate(
        path,
        remote_committed_at=NEWER, remote_blob=f"new-{path}",
        last_committed_at=OLDER, last_blob=f"old-{path}",
    )


def test_sweep_round_robins_tenants():
    """Due repos are processed one-per-tenant per round, not tenant-clustered."""
    db = FakeDB(
        due=[
            {"id": "a1", "tenant_id": "t1"},
            {"id": "a2", "tenant_id": "t1"},
            {"id": "a3", "tenant_id": "t1"},
            {"id": "b1", "tenant_id": "t2"},
        ],
        branches={},  # no specs anywhere: order is all we observe
    )

    process_repository_refresh_sweep(db)

    # t2's repo runs second, after t1's most-overdue repo — not after all of t1.
    assert db.refreshed == ["a1", "b1", "a2", "a3"]


def test_tenant_over_quota_is_deferred_others_proceed(monkeypatch):
    """An exhausted tenant's repos defer (no lock/anchor/failure); others run."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 2)

    db = FakeDB(
        due=[
            {"id": "a1", "tenant_id": "t1"},
            {"id": "b1", "tenant_id": "t2"},
        ],
        branches={"a1": ["main"], "b1": ["main"]},
        candidates={("a1", "main"): [_stale("a.yaml")], ("b1", "main"): [_stale("b.yaml")]},
        recent_jobs_by_tenant={"t1": 2},  # t1 already at its window bound
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["b.yaml"]
    # Deferral is total for a1: never locked, never scanned, anchor untouched,
    # and no RAR-3.4 failure recorded (deferral is not an error).
    assert db.acquired == ["b1"]
    assert db.refreshed == ["b1"]
    assert db.scanned == [("b1", "main")]
    assert db.failures_recorded == []


def test_quota_bounds_enqueues_mid_repo(monkeypatch):
    """A repo with more stale files than budget enqueues up to the bound, defers the rest."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["one.yaml"]
    # The deferred file is not a failure and the tick completes normally.
    assert db.failures_recorded == []
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


def test_quota_spent_skips_remaining_branch_walks(monkeypatch):
    """Once the budget is spent, later branches are not even rescanned (no provider calls)."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main", "dev"]},
        candidates={
            ("r1", "main"): [_stale("main.yaml")],
            ("r1", "dev"): [_stale("dev.yaml")],
        },
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["main.yaml"]
    assert db.scanned == [("r1", "main")]  # dev walk skipped entirely
    assert db.failures_recorded == []


def test_quota_spans_tenant_repos_within_one_tick(monkeypatch):
    """A tenant's budget is shared across its repos inside a single tick."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[
            {"id": "rA", "tenant_id": "t1"},
            {"id": "rB", "tenant_id": "t1"},
        ],
        branches={"rA": ["main"], "rB": ["main"]},
        candidates={("rA", "main"): [_stale("a.yaml")], ("rB", "main"): [_stale("b.yaml")]},
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["a.yaml"]
    # rB deferred before its lock: stays due for a later tick once the window rolls.
    assert db.acquired == ["rA"]
    assert db.refreshed == ["rA"]
    assert db.failures_recorded == []


def test_quota_disabled_is_unlimited(monkeypatch):
    """APIOME_REFRESH_TENANT_QUOTA <= 0 disables the bound entirely."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 0)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        recent_jobs_by_tenant={"t1": 10_000},  # would exhaust any enabled quota
    )

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 2


def test_quota_usage_count_error_degrades_to_unlimited(monkeypatch):
    """A window-usage count failure never blocks the sweep (protective bound only)."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
    )

    def _count_boom(window_seconds):
        raise RuntimeError("quota usage query failed")

    db.count_recent_repository_refresh_jobs_by_tenant = _count_boom

    enqueued = process_repository_refresh_sweep(db)

    assert enqueued == 2  # degraded to unlimited for the tick
    assert db.refreshed == ["r1"]


def test_manual_path_without_budget_is_never_limited():
    """enqueue_stale_files_for_branch without max_enqueues (manual path) has no bound."""
    db = FakeDB(
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
    )
    repo_row = {"id": "r1", "tenant_id": "t1", "provider": "github"}

    result = sweep.enqueue_stale_files_for_branch(db, repo_row, "main")

    assert result.enqueued == 2
    assert result.deferred == 0


# ------------------------------------------- REPO-4.6 persisted per-tenant quota


@pytest.fixture()
def telemetry():
    """A clean polling-telemetry registry per test (the registry is process-wide)."""
    from app.repository_polling_telemetry import polling_telemetry

    polling_telemetry.reset()
    yield polling_telemetry
    polling_telemetry.reset()


def test_persisted_tenant_quota_overrides_the_setting_default(monkeypatch):
    """tenants.repository_polls_per_hour wins over APIOME_REFRESH_TENANT_QUOTA."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        polls_per_hour_by_tenant={"t1": 5},  # generous tenant beats the stingy default
    )

    assert process_repository_refresh_sweep(db) == 2


def test_persisted_tenant_quota_can_be_stricter_than_the_default(monkeypatch):
    """A tenant tuned below the deployment default is bounded at its own value."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        polls_per_hour_by_tenant={"t1": 1},
    )

    assert process_repository_refresh_sweep(db) == 1
    assert [j["path"] for j in db.enqueued] == ["one.yaml"]
    assert db.failures_recorded == []


def test_zero_polls_per_hour_makes_one_tenant_unlimited(monkeypatch):
    """0 on the tenant row is 'unlimited', not 'defer everything'."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        recent_jobs_by_tenant={"t1": 10_000},  # would exhaust any finite bound
        polls_per_hour_by_tenant={"t1": 0},
    )

    assert process_repository_refresh_sweep(db) == 2
    assert db.refreshed == ["r1"]


def test_tenant_quotas_are_independent(monkeypatch):
    """One tenant exhausting its (small) quota does not bound another tenant's."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[
            {"id": "a1", "tenant_id": "noisy"},
            {"id": "b1", "tenant_id": "quiet"},
        ],
        branches={"a1": ["main"], "b1": ["main"]},
        candidates={
            ("a1", "main"): [_stale("a1.yaml"), _stale("a2.yaml")],
            ("b1", "main"): [_stale("b1.yaml"), _stale("b2.yaml")],
        },
        polls_per_hour_by_tenant={"noisy": 1, "quiet": 600},
    )

    assert process_repository_refresh_sweep(db) == 3
    assert [j["path"] for j in db.enqueued] == ["a1.yaml", "b1.yaml", "b2.yaml"]


def test_persisted_quota_read_error_falls_back_to_the_default(monkeypatch):
    """A limits-read failure still bounds the sweep at the configured default."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 1)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
    )

    def _limits_boom():
        raise RuntimeError("tenant quota query failed")

    db.list_tenant_repository_polls_per_hour = _limits_boom

    # Falls back to the default (1), not to unlimited: the bound still protects.
    assert process_repository_refresh_sweep(db) == 1


def test_deferral_emits_telemetry_and_no_failure(monkeypatch, telemetry):
    """A deferred repo is counted for REPO-7.3 and never recorded as a failure."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[
            {"id": "rA", "tenant_id": "t1"},
            {"id": "rB", "tenant_id": "t1"},
        ],
        branches={"rA": ["main"], "rB": ["main"]},
        candidates={("rA", "main"): [_stale("a.yaml")], ("rB", "main"): [_stale("b.yaml")]},
        polls_per_hour_by_tenant={"t1": 1},
    )

    process_repository_refresh_sweep(db)

    snapshot = telemetry.snapshot()
    assert snapshot["totals"]["poll_dispatched"] == 1
    assert snapshot["totals"]["repository_deferred"] == 1
    assert snapshot["by_tenant"]["t1"]["repository_deferred"] == 1
    # A deferral is a scheduling decision, never a failure.
    assert db.failures_recorded == []
    assert "failed" not in snapshot["totals"]


def test_mid_repo_file_deferral_is_counted(monkeypatch, telemetry):
    """Stale files left unenqueued when the budget runs out are counted separately."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={
            ("r1", "main"): [_stale("one.yaml"), _stale("two.yaml"), _stale("three.yaml")]
        },
        polls_per_hour_by_tenant={"t1": 1},
    )

    process_repository_refresh_sweep(db)

    snapshot = telemetry.snapshot()
    assert snapshot["totals"]["files_deferred"] == 1
    assert snapshot["totals"]["files_deferred_jobs"] == 2  # two files left stale
    assert snapshot["totals"]["poll_dispatched_jobs"] == 1
    assert db.failures_recorded == []


def test_telemetry_failure_never_becomes_a_refresh_failure(monkeypatch, telemetry):
    """A broken counter must not turn a healthy poll into a recorded failure."""
    import app.config as config
    import app.repository_polling_telemetry as telemetry_module

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    def _record_boom(*args, **kwargs):
        raise RuntimeError("counter exploded")

    monkeypatch.setattr(telemetry_module.polling_telemetry, "record", _record_boom)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml")]},
    )

    assert process_repository_refresh_sweep(db) == 1
    assert db.failures_recorded == []
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


def test_telemetry_failure_never_blocks_a_deferral(monkeypatch, telemetry):
    """The deferral still happens (no lock, no anchor) when counting it fails."""
    import app.config as config
    import app.repository_polling_telemetry as telemetry_module

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    def _record_boom(*args, **kwargs):
        raise RuntimeError("counter exploded")

    monkeypatch.setattr(telemetry_module.polling_telemetry, "record", _record_boom)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml")]},
        recent_jobs_by_tenant={"t1": 60},  # already at the bound
    )

    assert process_repository_refresh_sweep(db) == 0
    assert db.acquired == []
    assert db.refreshed == []
    assert db.failures_recorded == []


def test_dispatch_telemetry_records_quota_and_jobs(monkeypatch, telemetry):
    """A within-quota poll is counted with the jobs it enqueued."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        polls_per_hour_by_tenant={"t1": 600},
    )

    process_repository_refresh_sweep(db)

    snapshot = telemetry.snapshot()
    assert snapshot["totals"]["poll_dispatched"] == 1
    assert snapshot["totals"]["poll_dispatched_jobs"] == 2
    assert "repository_deferred" not in snapshot["totals"]
    assert "files_deferred" not in snapshot["totals"]


# --- REPO-7.3 (#2801): durable rolling-window counters -------------------------------------
#
# The in-process registry above answers "what is happening right now" and dies with the
# process. These tests cover the second recording path: the same facts accumulated into
# per-tenant window rows a 7-day dashboard can read a restart later.


def test_a_dispatch_records_the_jobs_it_enqueued(monkeypatch, telemetry):
    """`polls` counts jobs, not repositories, because jobs are the unit REPO-4.6's
    pollsPerHour bounds — a series a reader can hold against the quota directly."""
    import app.config as config
    from app.repository_quota_window import METRIC_POLLS, WINDOW_HOUR

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml"), _stale("two.yaml")]},
        polls_per_hour_by_tenant={"t1": 600},
    )

    process_repository_refresh_sweep(db)

    assert db.quota_total(METRIC_POLLS) == 2
    polls = [row for row in db.quota_windows if row["metric"] == METRIC_POLLS]
    assert polls[0]["window_kind"] == WINDOW_HOUR


def test_a_deferred_repository_is_counted_apart_from_the_work_that_happened(
    monkeypatch, telemetry
):
    """Folding deferrals into `polls` would erase the one signal the dashboard exists for:
    a tenant parked against its ceiling would look like a tenant doing less work."""
    import app.config as config
    from app.repository_quota_window import METRIC_POLLS, METRIC_POLLS_DEFERRED

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "rA", "tenant_id": "t1"}, {"id": "rB", "tenant_id": "t1"}],
        branches={"rA": ["main"], "rB": ["main"]},
        candidates={("rA", "main"): [_stale("a.yaml")], ("rB", "main"): [_stale("b.yaml")]},
        polls_per_hour_by_tenant={"t1": 1},
    )

    process_repository_refresh_sweep(db)

    assert db.quota_total(METRIC_POLLS_DEFERRED) == 1
    assert db.quota_total(METRIC_POLLS) == 1


def test_files_left_stale_mid_repository_are_counted_separately(monkeypatch, telemetry):
    import app.config as config
    from app.repository_quota_window import METRIC_FILES_DEFERRED

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={
            ("r1", "main"): [_stale("one.yaml"), _stale("two.yaml"), _stale("three.yaml")]
        },
        polls_per_hour_by_tenant={"t1": 1},
    )

    process_repository_refresh_sweep(db)

    assert db.quota_total(METRIC_FILES_DEFERRED) == 2


def test_a_tick_that_enqueued_nothing_writes_no_counter_row(monkeypatch, telemetry):
    """A repository polled with nothing stale is the common case; a zero row per tick per
    repository would cost more storage than the counters it carries."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): []},
    )

    process_repository_refresh_sweep(db)

    assert db.quota_windows == []


def test_counters_are_attributed_per_tenant(monkeypatch, telemetry):
    import app.config as config
    from app.repository_quota_window import METRIC_POLLS

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "rA", "tenant_id": "t1"}, {"id": "rB", "tenant_id": "t2"}],
        branches={"rA": ["main"], "rB": ["main"]},
        candidates={
            ("rA", "main"): [_stale("a.yaml")],
            ("rB", "main"): [_stale("b.yaml"), _stale("c.yaml")],
        },
        polls_per_hour_by_tenant={"t1": 600, "t2": 600},
    )

    process_repository_refresh_sweep(db)

    assert db.quota_total(METRIC_POLLS, "t1") == 1
    assert db.quota_total(METRIC_POLLS, "t2") == 2


def test_a_counter_write_failure_never_becomes_a_refresh_failure(monkeypatch, telemetry):
    """The durable path gets the same contract as the in-process one: an observability
    problem must not stop repositories refreshing."""
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml")]},
    )

    def _increment_boom(**kwargs):
        raise RuntimeError("counter table is gone")

    db.increment_repository_quota_window = _increment_boom

    assert process_repository_refresh_sweep(db) == 1
    assert db.failures_recorded == []
    assert db.refreshed == ["r1"]
    assert db.released == ["r1"]


def test_a_counter_write_failure_never_blocks_a_deferral(monkeypatch, telemetry):
    import app.config as config

    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)

    db = FakeDB(
        due=[{"id": "r1", "tenant_id": "t1"}],
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [_stale("one.yaml")]},
        recent_jobs_by_tenant={"t1": 60},  # already at the bound
    )

    def _increment_boom(**kwargs):
        raise RuntimeError("counter table is gone")

    db.increment_repository_quota_window = _increment_boom

    assert process_repository_refresh_sweep(db) == 0
    assert db.acquired == []
    assert db.refreshed == []
    assert db.failures_recorded == []
