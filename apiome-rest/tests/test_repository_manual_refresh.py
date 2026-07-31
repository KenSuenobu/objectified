"""Manual one-shot "Refresh Now" tests (RAR-5.2, #3533).

Deterministic, DB-free fixtures over ``app.repository_manual_refresh`` using a
fake ``Database`` that records calls. The GitHub walk
(``scan_repository_branch_into_index``) is monkeypatched so no network is touched.

Covers the acceptance criteria:
  - per-file and per-repo refresh both enqueue spec-faithful jobs;
  - the stored spec snapshot (not defaults) rides each enqueued job;
  - the RAR-2.2 freshness gate is honored (up-to-date files do not enqueue);
  - it works regardless of the auto-refresh cadence / opt-out (the manual path
    never consults due-selection, ``auto_refresh_enabled``, or the kill switch);
  - branch scoping (explicit branch vs. all spec branches) and the per-file path
    filter behave as specified;
  - an unknown repository (wrong tenant) returns ``None`` (caller → 404).
"""

from datetime import datetime, timedelta, timezone

import pytest

import app.repository_refresh_sweep as sweep
from app.repository_file_scan import ScanPass
from app.repository_manual_refresh import refresh_repository_now

NOW = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
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
    """Records manual-refresh interactions; no real database."""

    def __init__(self, *, repo=None, branches=None, candidates=None):
        self._repo = repo
        self._branches = branches if branches is not None else {}
        self._candidates = candidates if candidates is not None else {}
        self.enqueued = []
        self.scanned = []
        # Track active (queued/running) lineages to emulate the idempotent insert.
        self._active_lineage = set()
        # Sweep-only methods that must NOT be called by the manual path.
        self.due_calls = 0
        self.mark_refreshed_calls = 0
        self.lock_calls = 0

    def get_tenant_repository(self, tenant_id, repository_id):
        if self._repo is None:
            return None
        return dict(self._repo)

    def list_repository_import_spec_branches(self, repository_id):
        return list(self._branches.get(repository_id, []))

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

    # --- sweep-only surface: presence here lets us assert it is never used ---
    def list_due_repositories(self):
        self.due_calls += 1
        return []

    def mark_repository_refreshed(self, repository_id):
        self.mark_refreshed_calls += 1
        return True

    def try_acquire_repository_refresh_lock(self, repository_id):
        self.lock_calls += 1
        return True


@pytest.fixture(autouse=True)
def _patch_scan(monkeypatch):
    """Replace the GitHub walk with a recorder so no network is hit."""

    def _fake_scan(db, repo_row, branch):
        db.scanned.append((str(repo_row["id"]), branch))
        return ScanPass(total_files=1, importable_count=1, completed=True, resumed=False)

    monkeypatch.setattr(sweep, "scan_repository_branch_into_index", _fake_scan)


def _repo():
    return {"id": "r1", "tenant_id": "t1", "provider": "github"}


def test_per_repo_refresh_enqueues_stale_files_only():
    """Whole-repo refresh enqueues only stale + newer files across all spec branches."""
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
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale, up_to_date]},
    )

    result = refresh_repository_now(db, tenant_id="t1", repository_id="r1")

    assert result is not None
    assert result.enqueued == 1
    assert result.skipped == 1
    assert result.branches == ["main"]
    assert [j["path"] for j in db.enqueued] == ["api/openapi.yaml"]


def test_enqueued_job_carries_stored_spec_not_defaults():
    """The manual job replays the captured spec snapshot, not importer defaults."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    refresh_repository_now(db, tenant_id="t1", repository_id="r1")

    job = db.enqueued[0]
    assert job["import_spec_id"] == "spec-api/openapi.yaml"
    assert job["source_kind"] == "openapi-3"
    assert job["options_json"] == {"naming_convention": "camelCase"}
    assert job["remote_blob_sha"] == "blob-new"
    assert job["refresh_reason"] == "newer-content"


def test_per_file_refresh_filters_to_one_path():
    """A per-file refresh enqueues only the named path even when others are stale."""
    target = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    other_stale = _candidate(
        "api/other.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new2",
        last_committed_at=OLDER, last_blob="blob-old2",
    )
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [target, other_stale]},
    )

    result = refresh_repository_now(
        db, tenant_id="t1", repository_id="r1", branch="main", path="api/openapi.yaml"
    )

    assert result.enqueued == 1
    assert [j["path"] for j in db.enqueued] == ["api/openapi.yaml"]


def test_per_file_up_to_date_is_a_no_op():
    """Refresh Now on an up-to-date file enqueues nothing (freshness gate)."""
    up_to_date = _candidate(
        "api/openapi.yaml",
        remote_committed_at=OLDER, remote_blob="blob-x",
        last_committed_at=OLDER, last_blob="blob-x",
    )
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [up_to_date]},
    )

    result = refresh_repository_now(
        db, tenant_id="t1", repository_id="r1", branch="main", path="api/openapi.yaml"
    )

    assert result.enqueued == 0
    assert result.skipped == 1
    assert db.enqueued == []


def test_explicit_branch_skips_spec_branch_lookup():
    """An explicit branch is used directly without walking all spec branches."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        repo=_repo(),
        # Only the 'dev' branch is registered, but the caller asks for 'release'.
        branches={"r1": ["dev"]},
        candidates={("r1", "release"): [stale]},
    )

    result = refresh_repository_now(
        db, tenant_id="t1", repository_id="r1", branch="release"
    )

    assert result.branches == ["release"]
    assert result.enqueued == 1


def test_bypasses_cadence_and_auto_refresh_gates():
    """The manual path never consults due-selection, anchors, or advisory locks."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["main"]},
        candidates={("r1", "main"): [stale]},
    )

    refresh_repository_now(db, tenant_id="t1", repository_id="r1")

    assert db.due_calls == 0
    assert db.mark_refreshed_calls == 0
    assert db.lock_calls == 0


def test_unknown_repository_returns_none():
    """A repository not owned by the tenant yields None (caller maps to 404)."""
    db = FakeDB(repo=None)

    result = refresh_repository_now(db, tenant_id="t1", repository_id="missing")

    assert result is None
    assert db.enqueued == []


def test_bad_branch_does_not_abort_other_branches():
    """One branch that raises during rescan does not stop the others."""
    stale = _candidate(
        "api/openapi.yaml",
        remote_committed_at=NEWER, remote_blob="blob-new",
        last_committed_at=OLDER, last_blob="blob-old",
    )
    db = FakeDB(
        repo=_repo(),
        branches={"r1": ["bad", "main"]},
        candidates={("r1", "main"): [stale]},
    )

    original = sweep.enqueue_stale_files_for_branch

    def _maybe_raise(db_, repo_row, branch, **kwargs):
        if branch == "bad":
            raise RuntimeError("github exploded")
        return original(db_, repo_row, branch, **kwargs)

    # Patch the symbol the manual module imported.
    import app.repository_manual_refresh as manual

    manual.enqueue_stale_files_for_branch = _maybe_raise
    try:
        result = refresh_repository_now(db, tenant_id="t1", repository_id="r1")
    finally:
        manual.enqueue_stale_files_for_branch = original

    assert result.enqueued == 1
    assert result.branches == ["main"]  # only the branch that succeeded
