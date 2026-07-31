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

    def __init__(self, *, due=None, branches=None, candidates=None, lock_result=True):
        self._due = due if due is not None else []
        self._branches = branches if branches is not None else {}
        self._candidates = candidates if candidates is not None else {}
        self._lock_result = lock_result
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
        # Track active (queued/running) lineages to emulate the idempotent insert.
        self._active_lineage = set()

    # --- due selection / lock ---
    def list_due_repositories(self):
        return list(self._due)

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


def test_auto_pause_transition_fires_notification_once(monkeypatch):
    """newly_paused=True fires the RAR-5.4 auto-pause notification exactly once."""
    import app.repository_refresh_notifications as notifications

    def _boom(db, repo_row, branch):
        raise ValueError("bad credentials")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)

    notified = []
    monkeypatch.setattr(
        notifications,
        "notify_refresh_auto_paused",
        lambda db, **kwargs: notified.append(kwargs) or [],
    )

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

    assert len(notified) == 1
    assert notified[0]["repository_id"] == "r1"
    assert notified[0]["tenant_id"] == "t1"
    assert notified[0]["repository_full_name"] == "octocat/Hello-World"
    assert notified[0]["consecutive_failures"] == 8
    assert "bad credentials" in notified[0]["error"]


def test_already_paused_failure_does_not_renotify(monkeypatch):
    """paused=True but newly_paused=False (renewal) stays silent."""
    import app.repository_refresh_notifications as notifications

    def _boom(db, repo_row, branch):
        raise ValueError("still broken")

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _boom)

    notified = []
    monkeypatch.setattr(
        notifications,
        "notify_refresh_auto_paused",
        lambda db, **kwargs: notified.append(kwargs) or [],
    )

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

    assert notified == []
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
