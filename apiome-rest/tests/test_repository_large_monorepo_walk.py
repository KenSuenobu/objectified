"""Large-monorepo support: sparse / paged repository walk (REPO-2.5, #2766).

Covers the three acceptance criteria end to end, without a network or a database:

1. *A scan can be resumed via stored cursor on a transient failure* — the walker
   raises :class:`TransientScanError` carrying its position, the scan path stores
   it, and the next pass continues from it instead of restarting.
2. *Per-scan wall-clock budget configurable per tenant (default 5 min)* — the
   budget is read from ``tenants.repository_scan_budget_seconds``, clamped into
   the configured floor/ceiling, and a pass that spends it pauses with a cursor.
3. *Walker streams entries in chunks of <= 1000* — the chunk size is capped
   regardless of configuration, and no chunk handed to the sink exceeds it.

Plus the guardrails around them: cursor serialization, expiry, the resume-attempt
cap, the DAO's streaming upsert, and the migration.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from app.database import Database
from app.repository_file_scan import (
    ScanPass,
    fetch_github_tree_blobs,
    process_next_repository_file_scan_job,
    scan_repository_branch_into_index,
    walk_github_tree_in_chunks,
)
from app.repository_scan_budget import (
    DEFAULT_SCAN_BUDGET_SECONDS,
    MAX_SCAN_RESUME_ATTEMPTS,
    MAX_WALK_CHUNK_SIZE,
    WALK_MODE_RECURSIVE,
    WALK_MODE_SPARSE,
    ScanBudget,
    ScanCursor,
    TransientScanError,
    chunked,
    is_cursor_expired,
    resolve_chunk_size,
    resolve_scan_budget_seconds,
    should_abandon_cursor,
)

_MIGRATION = "apiome-db/scripts/V221__large_monorepo_paged_scan_repo_2_5.sql"


# --- AC2: per-tenant wall-clock budget --------------------------------------


def test_budget_defaults_to_five_minutes() -> None:
    """An unconfigured tenant gets the roadmap's 5-minute default."""
    assert DEFAULT_SCAN_BUDGET_SECONDS == 300
    assert resolve_scan_budget_seconds(None) == 300
    # A non-positive stored value is "unset", not "no budget".
    assert resolve_scan_budget_seconds(0) == 300
    assert resolve_scan_budget_seconds(-30) == 300


def test_budget_honours_a_configured_tenant_value() -> None:
    assert resolve_scan_budget_seconds(900) == 900


def test_budget_clamps_into_the_configured_range() -> None:
    assert resolve_scan_budget_seconds(1, floor_seconds=5) == 5
    assert resolve_scan_budget_seconds(99_999, ceiling_seconds=3600) == 3600


def test_budget_range_survives_a_misconfigured_environment() -> None:
    """A zero/negative floor cannot disable the guard, and ceiling >= floor."""
    assert resolve_scan_budget_seconds(0, floor_seconds=0, default_seconds=0) == 1
    assert resolve_scan_budget_seconds(600, floor_seconds=100, ceiling_seconds=10) == 100


def test_scan_budget_tracks_a_monotonic_clock() -> None:
    ticks = iter([0.0, 1.0, 4.0, 10.0])
    budget = ScanBudget(5, clock=lambda: next(ticks))  # started_at = 0.0
    assert budget.seconds == 5
    assert not budget.exhausted()  # elapsed 1.0
    assert budget.remaining_seconds() == 1.0  # elapsed 4.0
    assert budget.exhausted()  # elapsed 10.0


def test_scan_budget_of_zero_is_unbounded() -> None:
    budget = ScanBudget(0, clock=lambda: 10_000.0)
    assert not budget.exhausted()
    assert budget.remaining_seconds() == float("inf")


# --- AC3: bounded chunking ---------------------------------------------------


def test_chunk_size_is_capped_at_one_thousand() -> None:
    assert MAX_WALK_CHUNK_SIZE == 1000
    assert resolve_chunk_size(None) == 1000
    assert resolve_chunk_size(0) == 1000
    assert resolve_chunk_size(50_000) == 1000
    assert resolve_chunk_size(250) == 250


def test_chunked_yields_bounded_lists_lazily() -> None:
    chunks = list(chunked(range(2500), 1000))
    assert [len(c) for c in chunks] == [1000, 1000, 500]
    # An oversized request is capped, not honored.
    assert all(len(c) <= MAX_WALK_CHUNK_SIZE for c in chunked(range(3000), 10_000))
    assert list(chunked([], 10)) == []


# --- cursor serialization ----------------------------------------------------


def test_cursor_round_trips_through_json() -> None:
    cursor = ScanCursor(
        tree_sha="tree1",
        mode=WALK_MODE_SPARSE,
        emitted=1500,
        pending=[{"sha": "d1", "prefix": "packages"}],
        tip_commit_sha="tip1",
        tip_committed_at="2026-06-20T10:00:00Z",
        truncated_prefixes=["huge"],
    )
    restored = ScanCursor.from_json(cursor.to_json())
    assert restored is not None
    assert restored.tree_sha == "tree1"
    assert restored.mode == WALK_MODE_SPARSE
    assert restored.emitted == 1500
    assert restored.pending == [{"sha": "d1", "prefix": "packages"}]
    assert restored.tip_commit_sha == "tip1"
    assert restored.truncated_prefixes == ["huge"]


@pytest.mark.parametrize(
    "payload",
    [
        None,
        "not-a-mapping",
        {},
        {"version": 99, "tree_sha": "t"},
        {"version": 1, "tree_sha": ""},
        {"version": 1, "tree_sha": "t", "pending": "nonsense"},
    ],
)
def test_unusable_cursor_payloads_are_discarded(payload: Any) -> None:
    """An untrustworthy cursor yields None so the caller restarts the walk."""
    assert ScanCursor.from_json(payload) is None


def test_cursor_drops_malformed_pending_entries() -> None:
    cursor = ScanCursor.from_json(
        {"version": 1, "tree_sha": "t", "pending": [{"sha": "ok"}, {"prefix": "no-sha"}, "junk"]}
    )
    assert cursor is not None
    assert cursor.pending == [{"sha": "ok", "prefix": ""}]


def test_cursor_expiry_and_attempt_cap() -> None:
    now = "2026-07-30T12:00:00Z"
    assert not is_cursor_expired("2026-07-30T11:00:00Z", now=now)
    assert is_cursor_expired("2026-07-01T12:00:00Z", now=now)
    # An unreadable or missing timestamp errs toward "do not resume".
    assert is_cursor_expired(None, now=now)
    assert is_cursor_expired("not-a-date", now=now)
    # Expiry can be switched off deliberately.
    assert not is_cursor_expired("2020-01-01T00:00:00Z", now=now, max_age_seconds=0)

    assert not should_abandon_cursor(0)
    assert not should_abandon_cursor(MAX_SCAN_RESUME_ATTEMPTS - 1)
    assert should_abandon_cursor(MAX_SCAN_RESUME_ATTEMPTS)


# --- the walk ----------------------------------------------------------------


def _response(payload: Dict[str, Any], status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    return resp


def _branch_payload(tree_sha: str = "root-tree") -> Dict[str, Any]:
    return {
        "commit": {
            "sha": "tip-sha",
            "commit": {
                "committer": {"date": "2026-06-20T10:00:00Z"},
                "tree": {"sha": tree_sha},
            },
        }
    }


class _FakeClient:
    """An ``httpx.Client`` stand-in returning canned responses per URL substring."""

    def __init__(self, responses: List[Any]):
        self._responses = list(responses)
        self.urls: List[str] = []

    def get(self, url: str, headers: Optional[Dict[str, str]] = None) -> Any:
        self.urls.append(url)
        if not self._responses:
            raise AssertionError(f"unexpected request: {url}")
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False


def _patch_client(client: _FakeClient) -> Any:
    return patch("app.repository_file_scan.httpx.Client", return_value=client)


def _blobs(count: int, prefix: str = "f") -> List[Dict[str, Any]]:
    return [
        {"type": "blob", "path": f"{prefix}{i}.yaml", "size": 10, "sha": f"sha{i}"}
        for i in range(count)
    ]


def test_recursive_walk_streams_bounded_chunks() -> None:
    """2,500 entries arrive as 1000 / 1000 / 500 — never one 2,500-entry list."""
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(2500)})]
    )
    seen: List[int] = []

    with _patch_client(client):
        outcome = walk_github_tree_in_chunks(
            "acme", "mono", "main", None, on_chunk=lambda c: seen.append(len(c))
        )

    assert seen == [1000, 1000, 500]
    assert outcome.completed is True
    assert outcome.cursor is None


def test_walk_caps_an_oversized_requested_chunk_size() -> None:
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(1500)})]
    )
    seen: List[int] = []

    with _patch_client(client):
        walk_github_tree_in_chunks(
            "acme", "mono", "main", None, on_chunk=lambda c: seen.append(len(c)), chunk_size=99_999
        )

    assert max(seen) <= MAX_WALK_CHUNK_SIZE


def test_walk_stamps_branch_tip_recency_on_every_entry() -> None:
    """RAR-2.1 anchors survive the rewrite to a chunked walk."""
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(3)})]
    )
    written: List[Dict[str, Any]] = []

    with _patch_client(client):
        walk_github_tree_in_chunks("acme", "mono", "main", None, on_chunk=written.extend)

    assert [w["path"] for w in written] == ["f0.yaml", "f1.yaml", "f2.yaml"]
    assert all(w["commit_sha"] == "tip-sha" for w in written)
    assert all(w["committed_at"] == "2026-06-20T10:00:00Z" for w in written)


def test_walk_pauses_on_the_wall_clock_budget_and_resumes_from_the_cursor() -> None:
    """A budget-exhausted pass returns a cursor; the next pass skips what it wrote."""
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(2500)})]
    )
    first: List[Dict[str, Any]] = []
    # monotonic() is read once per ScanBudget construction and once per check; the
    # third read jumps past the budget, so the pass stops after two chunks.
    ticks = iter([0.0, 1.0, 99.0, 99.0])

    with _patch_client(client):
        outcome = walk_github_tree_in_chunks(
            "acme",
            "mono",
            "main",
            None,
            on_chunk=first.extend,
            budget=ScanBudget(60, clock=lambda: next(ticks)),
        )

    assert outcome.completed is False
    assert outcome.cursor is not None
    assert outcome.cursor.mode == WALK_MODE_RECURSIVE
    assert outcome.cursor.emitted == len(first) == 2000
    assert outcome.cursor.tree_sha == "root-tree"

    # Second pass: same pinned tree, resuming at the stored offset.
    resume_client = _FakeClient([_response({"truncated": False, "tree": _blobs(2500)})])
    second: List[Dict[str, Any]] = []
    with _patch_client(resume_client):
        resumed = walk_github_tree_in_chunks(
            "acme", "mono", "main", None, on_chunk=second.extend, cursor=outcome.cursor
        )

    assert resumed.completed is True
    assert [w["path"] for w in second] == [f"f{i}.yaml" for i in range(2000, 2500)]
    # The resumed pass never re-reads the branch API: the cursor pins the tree.
    assert all("/branches/" not in u for u in resume_client.urls)


def test_truncated_recursive_response_falls_back_to_a_sparse_walk() -> None:
    """GitHub's own truncation signal switches the walk to a per-directory descent."""
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response({"truncated": True, "tree": []}),
            # root listing
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "README.md", "sha": "b0"},
                        {"type": "tree", "path": "services", "sha": "d1"},
                    ],
                }
            ),
            # services/ listing
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "openapi.yaml", "size": 4, "sha": "b1"},
                        {"type": "tree", "path": "billing", "sha": "d2"},
                    ],
                }
            ),
            # services/billing/ listing
            _response(
                {
                    "truncated": False,
                    "tree": [{"type": "blob", "path": "schema.prisma", "sha": "b2"}],
                }
            ),
        ]
    )
    written: List[Dict[str, Any]] = []

    with _patch_client(client):
        outcome = walk_github_tree_in_chunks("acme", "mono", "main", None, on_chunk=written.extend)

    assert outcome.completed is True
    assert sorted(w["path"] for w in written) == [
        "README.md",
        "services/billing/schema.prisma",
        "services/openapi.yaml",
    ]
    # Paths are classified from the *full* path, not the leaf name.
    kinds = {w["path"]: w["detected_kind"] for w in written}
    assert kinds["services/openapi.yaml"] == "openapi-candidate"
    assert kinds["services/billing/schema.prisma"] == "prisma-candidate"
    # Sub-tree listings use the non-recursive primitive.
    assert not any("recursive=1" in u for u in client.urls[2:])


def test_sparse_walk_pauses_at_a_directory_boundary_and_resumes() -> None:
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response({"truncated": True, "tree": []}),
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "a.yaml", "sha": "b0"},
                        {"type": "tree", "path": "pkg", "sha": "d1"},
                    ],
                }
            ),
        ]
    )
    first: List[Dict[str, Any]] = []
    # Reads: budget construction, sparse-loop check (root), sparse-loop check (pkg).
    ticks = iter([0.0, 1.0, 99.0])

    with _patch_client(client):
        outcome = walk_github_tree_in_chunks(
            "acme",
            "mono",
            "main",
            None,
            on_chunk=first.extend,
            budget=ScanBudget(60, clock=lambda: next(ticks)),
        )

    assert outcome.completed is False
    assert outcome.cursor is not None
    assert outcome.cursor.mode == WALK_MODE_SPARSE
    assert outcome.cursor.pending == [{"sha": "d1", "prefix": "pkg"}]
    assert [w["path"] for w in first] == ["a.yaml"]

    resume_client = _FakeClient(
        [_response({"truncated": False, "tree": [{"type": "blob", "path": "b.yaml", "sha": "b1"}]})]
    )
    second: List[Dict[str, Any]] = []
    with _patch_client(resume_client):
        resumed = walk_github_tree_in_chunks(
            "acme", "mono", "main", None, on_chunk=second.extend, cursor=outcome.cursor
        )

    assert resumed.completed is True
    assert [w["path"] for w in second] == ["pkg/b.yaml"]


def test_provider_truncated_directory_is_recorded_not_silent() -> None:
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response({"truncated": True, "tree": []}),
            _response({"truncated": True, "tree": [{"type": "blob", "path": "a.yaml", "sha": "b"}]}),
        ]
    )
    with _patch_client(client):
        outcome = walk_github_tree_in_chunks("acme", "mono", "main", None, on_chunk=lambda c: None)

    assert outcome.completed is True
    assert outcome.truncated_prefixes == [""]


# --- AC1: transient failure keeps a resumable position -----------------------


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_retryable_statuses_raise_a_transient_error_with_a_cursor(status: int) -> None:
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response({"truncated": True, "tree": []}),
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "a.yaml", "sha": "b0"},
                        {"type": "tree", "path": "pkg", "sha": "d1"},
                    ],
                }
            ),
            _response({}, status=status),
        ]
    )
    written: List[Dict[str, Any]] = []

    with _patch_client(client), pytest.raises(TransientScanError) as excinfo:
        walk_github_tree_in_chunks("acme", "mono", "main", None, on_chunk=written.extend)

    cursor = excinfo.value.cursor
    assert cursor is not None
    # The entry read before the failure was flushed, and the directory that failed
    # is still pending, so the resumed pass re-reads exactly it.
    assert [w["path"] for w in written] == ["a.yaml"]
    assert cursor.pending == [{"sha": "d1", "prefix": "pkg"}]


def test_network_errors_are_transient() -> None:
    import httpx

    client = _FakeClient([_response(_branch_payload()), httpx.ConnectError("boom")])
    with _patch_client(client), pytest.raises(TransientScanError):
        walk_github_tree_in_chunks("acme", "mono", "main", None, on_chunk=lambda c: None)


def test_fatal_statuses_still_raise_value_error() -> None:
    """A missing branch stays a hard failure — there is nothing to resume."""
    client = _FakeClient([_response({}, status=404)])
    with _patch_client(client), pytest.raises(ValueError, match="branch not found"):
        walk_github_tree_in_chunks("acme", "mono", "nope", None, on_chunk=lambda c: None)


def test_fetch_github_tree_blobs_still_returns_a_flat_list() -> None:
    """The unbounded convenience wrapper keeps its pre-REPO-2.5 contract."""
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "openapi/petstore.yaml", "size": 12, "sha": "b1"},
                        {"type": "tree", "path": "openapi", "sha": "ignored"},
                    ],
                }
            ),
        ]
    )
    with _patch_client(client):
        blobs = fetch_github_tree_blobs("acme", "petstore", "main", None)

    assert [b["path"] for b in blobs] == ["openapi/petstore.yaml"]
    assert blobs[0]["blob_sha"] == "b1"


# --- the scan path: cursor storage, counts, statuses -------------------------


class _FakeScanDB:
    """Records the DAO calls ``scan_repository_branch_into_index`` makes."""

    def __init__(
        self,
        *,
        cursor_row: Optional[Dict[str, Any]] = None,
        budget_seconds: Optional[int] = 300,
    ):
        self.cursor_row = cursor_row
        self.budget_seconds = budget_seconds
        self.appended: List[List[Dict[str, Any]]] = []
        self.deleted: List[str] = []
        self.saved_cursors: List[Dict[str, Any]] = []
        self.cleared = 0
        self.repo_updates: List[Dict[str, Any]] = []

    # --- reads
    def get_tenant_repository_scan_budget_seconds(self, tenant_id: str) -> Optional[int]:
        return self.budget_seconds

    def get_repository_scan_cursor(self, repository_id: str, branch: str) -> Optional[Dict[str, Any]]:
        return self.cursor_row

    def count_tenant_repository_files(self, repository_id: str, branch: str) -> Any:
        total = sum(len(c) for c in self.appended)
        return total, 0

    def get_external_auth_provider_for_user(self, *_a: Any, **_k: Any) -> None:
        return None

    # --- writes
    def delete_tenant_repository_files(self, repository_id: str, branch: str) -> None:
        self.deleted.append(branch)

    def append_tenant_repository_files(self, repository_id: str, branch: str, files: Any) -> int:
        self.appended.append(list(files))
        return len(files)

    def save_repository_scan_cursor(self, repository_id: str, branch: str, **kwargs: Any) -> None:
        self.saved_cursors.append(kwargs)
        self.cursor_row = {
            "cursor_json": kwargs["cursor_json"],
            "entries_indexed": kwargs["entries_indexed"],
            "importable_indexed": kwargs["importable_indexed"],
            "attempt_count": int((self.cursor_row or {}).get("attempt_count") or 0) + 1,
            "last_error": kwargs.get("last_error"),
            "updated_at": "2026-07-30T12:00:00Z",
        }

    def clear_repository_scan_cursor(self, repository_id: str, branch: str) -> None:
        self.cleared += 1
        self.cursor_row = None

    def update_tenant_repository_after_file_scan(self, **kwargs: Any) -> None:
        self.repo_updates.append(kwargs)


def _just_now() -> str:
    """A cursor timestamp that is always well inside the expiry window."""
    return datetime.now(timezone.utc).isoformat()


def _repo_row() -> Dict[str, Any]:
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": "22222222-2222-2222-2222-222222222222",
        "provider": "github",
        "visibility": "public",
        "repository_full_name": "acme/mono",
        "clone_url": "https://github.com/acme/mono.git",
    }


def test_fresh_scan_clears_the_branch_then_streams_chunks() -> None:
    db = _FakeScanDB()
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(1200)})]
    )

    with _patch_client(client):
        result = scan_repository_branch_into_index(db, _repo_row(), "main")

    assert isinstance(result, ScanPass)
    assert result.completed is True
    assert result.resumed is False
    # Old rows dropped once, then written in bounded chunks.
    assert db.deleted == ["main"]
    assert [len(c) for c in db.appended] == [1000, 200]
    # Completed scans clear the cursor and mark the repository ready.
    assert db.cleared == 1
    assert db.repo_updates[-1]["status"] == "ready"
    assert db.repo_updates[-1]["touch_last_scanned_at"] is True
    # Final counts come from the persisted rows, not the in-flight counters.
    assert result.total_files == 1200


def test_budget_exhausted_scan_stores_a_cursor_and_stays_scanning() -> None:
    db = _FakeScanDB(budget_seconds=60)
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(2500)})]
    )
    ticks = iter([0.0, 1.0, 99.0, 99.0])

    with _patch_client(client), patch("app.repository_scan_budget.time.monotonic", lambda: next(ticks)):
        result = scan_repository_branch_into_index(db, _repo_row(), "main")

    assert result.completed is False
    assert result.total_files == 2000
    assert db.cleared == 0
    saved = db.saved_cursors[-1]
    assert saved["entries_indexed"] == 2000
    assert saved["cursor_json"]["emitted"] == 2000
    assert saved["last_error"] is None
    assert db.repo_updates[-1]["status"] == "scanning"
    assert db.repo_updates[-1]["touch_last_scanned_at"] is False


def test_resumed_scan_appends_instead_of_clearing_the_branch() -> None:
    db = _FakeScanDB(
        cursor_row={
            "cursor_json": ScanCursor(
                tree_sha="root-tree",
                mode=WALK_MODE_RECURSIVE,
                emitted=2000,
                tip_commit_sha="tip-sha",
                tip_committed_at="2026-06-20T10:00:00Z",
            ).to_json(),
            "entries_indexed": 2000,
            "importable_indexed": 7,
            "attempt_count": 1,
            "updated_at": _just_now(),
        }
    )
    client = _FakeClient([_response({"truncated": False, "tree": _blobs(2500)})])

    with _patch_client(client):
        result = scan_repository_branch_into_index(db, _repo_row(), "main")

    assert result.resumed is True
    assert result.completed is True
    # The already-indexed rows survive: no delete, and only the tail is written.
    assert db.deleted == []
    assert [len(c) for c in db.appended] == [500]
    assert db.appended[0][0]["path"] == "f2000.yaml"


def test_transient_failure_stores_the_cursor_before_re_raising() -> None:
    db = _FakeScanDB()
    client = _FakeClient(
        [
            _response(_branch_payload()),
            _response({"truncated": True, "tree": []}),
            _response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "a.yaml", "sha": "b0"},
                        {"type": "tree", "path": "pkg", "sha": "d1"},
                    ],
                }
            ),
            _response({}, status=503),
        ]
    )

    with _patch_client(client), pytest.raises(TransientScanError):
        scan_repository_branch_into_index(db, _repo_row(), "main")

    saved = db.saved_cursors[-1]
    assert saved["entries_indexed"] == 1
    assert saved["cursor_json"]["pending"] == [{"sha": "d1", "prefix": "pkg"}]
    assert "503" in saved["last_error"]
    assert db.repo_updates[-1]["status"] == "scanning"


def test_scan_refuses_a_cursor_past_the_resume_attempt_cap() -> None:
    db = _FakeScanDB(
        cursor_row={
            "cursor_json": ScanCursor(tree_sha="root-tree").to_json(),
            "entries_indexed": 10,
            "importable_indexed": 0,
            "attempt_count": MAX_SCAN_RESUME_ATTEMPTS,
            "last_error": "GitHub tree API error: HTTP 503",
            "updated_at": _just_now(),
        }
    )

    with pytest.raises(ValueError, match="resume attempt cap"):
        scan_repository_branch_into_index(db, _repo_row(), "main")

    # The doomed cursor is dropped so a later retry starts clean.
    assert db.cleared == 1


def test_expired_cursor_is_dropped_and_the_branch_rewalked() -> None:
    db = _FakeScanDB(
        cursor_row={
            "cursor_json": ScanCursor(tree_sha="stale-tree", emitted=100).to_json(),
            "entries_indexed": 100,
            "importable_indexed": 0,
            "attempt_count": 1,
            "updated_at": "2020-01-01T00:00:00Z",
        }
    )
    client = _FakeClient(
        [_response(_branch_payload()), _response({"truncated": False, "tree": _blobs(3)})]
    )

    with _patch_client(client):
        result = scan_repository_branch_into_index(db, _repo_row(), "main")

    assert result.resumed is False
    assert db.deleted == ["main"]
    assert [w["path"] for w in db.appended[0]] == ["f0.yaml", "f1.yaml", "f2.yaml"]


def test_non_github_provider_is_still_rejected() -> None:
    db = _FakeScanDB()
    row = _repo_row()
    row["provider"] = "gitlab"
    with pytest.raises(ValueError, match="not implemented for provider"):
        scan_repository_branch_into_index(db, row, "main")


def test_private_repository_without_a_token_is_still_rejected() -> None:
    db = _FakeScanDB()
    row = _repo_row()
    row["visibility"] = "private"
    with pytest.raises(ValueError, match="linked account token"):
        scan_repository_branch_into_index(db, row, "main")


# --- the job path: pause and transient failure re-queue, they do not fail -----


class _FakeJobDB:
    """Minimal queue DAO for ``process_next_repository_file_scan_job``."""

    def __init__(
        self,
        *,
        has_cursor: bool = False,
        branch: str = "main",
        default_branch: Optional[str] = None,
    ):
        self.has_cursor = has_cursor
        self.branch = branch
        self.default_branch = default_branch
        self.claimed = False
        self.succeeded: List[str] = []
        self.requeued: List[Any] = []
        self.failed: List[Any] = []
        self.repo_updates: List[Dict[str, Any]] = []

    def claim_next_repository_file_scan_job(self) -> Optional[Dict[str, Any]]:
        if self.claimed:
            return None
        self.claimed = True
        return {
            "id": "job-1",
            "tenant_id": "t1",
            "repository_id": "r1",
            "branch": self.branch,
        }

    def get_tenant_repository(self, tenant_id: str, repository_id: str) -> Dict[str, Any]:
        row = _repo_row()
        if self.default_branch is not None:
            row["default_branch"] = self.default_branch
        return row

    def get_repository_scan_cursor(self, repository_id: str, branch: str) -> Optional[Dict[str, Any]]:
        return {"cursor_json": {}} if self.has_cursor else None

    def mark_repository_file_scan_job_succeeded(self, job_id: str) -> None:
        self.succeeded.append(job_id)

    def requeue_repository_file_scan_job(self, job_id: str, note: str) -> None:
        self.requeued.append((job_id, note))

    def mark_repository_file_scan_job_failed(self, job_id: str, message: str) -> None:
        self.failed.append((job_id, message))

    def update_tenant_repository_after_file_scan(self, **kwargs: Any) -> None:
        self.repo_updates.append(kwargs)


def test_job_is_requeued_when_the_pass_pauses_on_its_budget(monkeypatch: Any) -> None:
    db = _FakeJobDB()
    monkeypatch.setattr(
        "app.repository_file_scan.scan_repository_branch_into_index",
        lambda *a, **k: ScanPass(2000, 5, False, False),
    )

    assert process_next_repository_file_scan_job(db) == 1
    assert db.succeeded == []
    assert db.failed == []
    assert db.requeued and "budget" in db.requeued[0][1]


def test_job_is_requeued_when_a_transient_failure_left_a_cursor(monkeypatch: Any) -> None:
    db = _FakeJobDB(has_cursor=True)

    def _boom(*_a: Any, **_k: Any) -> ScanPass:
        raise TransientScanError("GitHub tree API error: HTTP 503")

    monkeypatch.setattr("app.repository_file_scan.scan_repository_branch_into_index", _boom)

    assert process_next_repository_file_scan_job(db) == 1
    assert db.failed == []
    assert db.requeued and "503" in db.requeued[0][1]


def test_job_fails_when_a_transient_failure_left_nothing_to_resume(monkeypatch: Any) -> None:
    """No cursor means no progress — fail rather than re-queue forever."""
    db = _FakeJobDB(has_cursor=False)

    def _boom(*_a: Any, **_k: Any) -> ScanPass:
        raise TransientScanError("GitHub branches API error: HTTP 503")

    monkeypatch.setattr("app.repository_file_scan.scan_repository_branch_into_index", _boom)

    assert process_next_repository_file_scan_job(db) == 1
    assert db.requeued == []
    assert db.failed and "503" in db.failed[0][1]
    assert db.repo_updates[-1]["status"] == "error"


def test_a_failed_default_branch_scan_still_marks_the_repository_errored(
    monkeypatch: Any,
) -> None:
    """The repository's status describes its default branch, so that failure is its own."""
    db = _FakeJobDB(has_cursor=False, branch="main", default_branch="main")
    monkeypatch.setattr(
        "app.repository_file_scan.scan_repository_branch_into_index",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("GitHub branch not found: main")),
    )

    assert process_next_repository_file_scan_job(db) == 1
    assert db.failed
    assert db.repo_updates[-1]["status"] == "error"


def test_a_failed_side_branch_scan_does_not_poison_the_repository(monkeypatch: Any) -> None:
    """REPO-4.3 queues ephemeral PR heads; a merge-and-delete must not error the repository.

    Before this guard, a pull-request head branch removed between the webhook delivery and
    the walk would 404, flip a perfectly healthy repository to ``error`` and zero its file
    counts — a lie about the repository, caused by a branch that no longer exists.
    """
    db = _FakeJobDB(has_cursor=False, branch="feature/gone", default_branch="main")
    monkeypatch.setattr(
        "app.repository_file_scan.scan_repository_branch_into_index",
        lambda *a, **k: (_ for _ in ()).throw(
            ValueError("GitHub branch not found: feature/gone")
        ),
    )

    assert process_next_repository_file_scan_job(db) == 1
    assert db.failed and "feature/gone" in db.failed[0][1]
    assert db.repo_updates == []


def test_a_side_branch_transient_failure_with_no_cursor_also_spares_the_repository(
    monkeypatch: Any,
) -> None:
    db = _FakeJobDB(has_cursor=False, branch="feature/gone", default_branch="main")

    def _boom(*_a: Any, **_k: Any) -> ScanPass:
        raise TransientScanError("GitHub branches API error: HTTP 503")

    monkeypatch.setattr("app.repository_file_scan.scan_repository_branch_into_index", _boom)

    assert process_next_repository_file_scan_job(db) == 1
    assert db.failed
    assert db.repo_updates == []


def test_an_unknown_default_branch_keeps_the_original_fail_loud_behaviour(
    monkeypatch: Any,
) -> None:
    """When we cannot tell whether the branch owns the status, surface the failure."""
    db = _FakeJobDB(has_cursor=False, branch="anything", default_branch="")
    monkeypatch.setattr(
        "app.repository_file_scan.scan_repository_branch_into_index",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")),
    )

    assert process_next_repository_file_scan_job(db) == 1
    assert db.repo_updates[-1]["status"] == "error"


def test_completed_pass_marks_the_job_succeeded(monkeypatch: Any) -> None:
    db = _FakeJobDB()
    monkeypatch.setattr(
        "app.repository_file_scan.scan_repository_branch_into_index",
        lambda *a, **k: ScanPass(12, 3, True, True),
    )

    assert process_next_repository_file_scan_job(db) == 1
    assert db.succeeded == ["job-1"]
    assert db.requeued == []


# --- DAO shapes --------------------------------------------------------------


class _RecordingCursor:
    """Captures executed SQL; returns a canned row for reads."""

    def __init__(self, row: Optional[Dict[str, Any]] = None):
        self.row = row
        self.executed: List[Any] = []
        self.rowcount = 1

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def executemany(self, query: str, seq: Any) -> None:
        self.executed.append((query, list(seq)))

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.row

    def fetchall(self) -> List[Dict[str, Any]]:
        return [self.row] if self.row else []


class _RecordingConn:
    def __init__(self, cursor: _RecordingCursor):
        self._cursor = cursor

    def cursor(self) -> _RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        pass

    def rollback(self) -> None:  # pragma: no cover - error paths only
        pass


def _db_with(cursor: _RecordingCursor) -> Database:
    db = Database()
    db.connect = lambda: _RecordingConn(cursor)  # type: ignore[method-assign]
    return db


def test_append_upserts_so_a_re_emitted_chunk_is_a_no_op() -> None:
    cursor = _RecordingCursor()
    written = _db_with(cursor).append_tenant_repository_files(
        "11111111-1111-1111-1111-111111111111",
        "main",
        [{"path": "a.yaml", "name": "a.yaml", "detected_kind": "openapi-candidate"}],
    )
    assert written == 1
    query, rows = cursor.executed[0]
    assert "ON CONFLICT (repository_id, branch, path) DO UPDATE" in query
    assert rows[0][2] == "a.yaml"


def test_append_of_an_empty_chunk_touches_nothing() -> None:
    cursor = _RecordingCursor()
    assert _db_with(cursor).append_tenant_repository_files("r1", "main", []) == 0
    assert cursor.executed == []


def test_replace_is_delete_plus_append() -> None:
    cursor = _RecordingCursor()
    _db_with(cursor).replace_tenant_repository_files(
        "11111111-1111-1111-1111-111111111111", "main", [{"path": "a.yaml", "name": "a.yaml"}]
    )
    assert "DELETE FROM apiome.tenant_repository_files" in cursor.executed[0][0]
    assert "INSERT INTO apiome.tenant_repository_files" in cursor.executed[1][0]


def test_save_cursor_counts_only_no_progress_passes() -> None:
    """Progress resets the stuck counter; a pass that indexed nothing bumps it."""
    cursor = _RecordingCursor()
    _db_with(cursor).save_repository_scan_cursor(
        "11111111-1111-1111-1111-111111111111",
        "main",
        cursor_json={"version": 1, "tree_sha": "t"},
        entries_indexed=10,
        importable_indexed=2,
        last_error="HTTP 503",
    )
    query, params = cursor.executed[0]
    assert "ON CONFLICT (repository_id, branch) DO UPDATE" in query
    assert (
        "WHEN EXCLUDED.entries_indexed > apiome.tenant_repository_scan_cursors.entries_indexed"
        in query
    )
    assert "ELSE apiome.tenant_repository_scan_cursors.attempt_count + 1" in query
    assert params[3] == 10 and params[4] == 2


def test_requeue_returns_the_job_to_the_back_of_the_queue() -> None:
    cursor = _RecordingCursor()
    _db_with(cursor).requeue_repository_file_scan_job("job-1", "paused")
    query, params = cursor.executed[0]
    assert "SET status = 'queued'" in query
    assert "started_at = NULL" in query
    # Fairness: a resumed pass counts as a fresh arrival, not as the original one.
    assert "requeued_at = CURRENT_TIMESTAMP" in query
    assert params == ("paused", "job-1")


def test_claim_orders_resumed_jobs_fairly() -> None:
    """A paused monorepo walk must not starve every other repository's scan."""
    cursor = _RecordingCursor()
    _db_with(cursor).claim_next_repository_file_scan_job()
    query, _ = cursor.executed[0]
    assert "ORDER BY COALESCE(requeued_at, created_at) ASC" in query


def test_scan_budget_setter_rejects_a_non_positive_value() -> None:
    cursor = _RecordingCursor()
    with pytest.raises(ValueError, match="positive"):
        _db_with(cursor).set_tenant_repository_scan_budget_seconds("t1", 0)
    assert cursor.executed == []


def test_file_counts_reuse_the_shared_importable_predicate() -> None:
    cursor = _RecordingCursor({"c": 12, "ic": 3})
    total, importable = _db_with(cursor).count_tenant_repository_files("r1", "main")
    assert (total, importable) == (12, 3)
    query, _ = cursor.executed[0]
    assert "COUNT(*) FILTER (WHERE" in query
    assert "f.detected_kind ILIKE 'openapi%%'" in query


# --- migration ---------------------------------------------------------------


def test_migration_adds_the_cursor_table_and_tenant_budget(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    required = (
        "ADD COLUMN IF NOT EXISTS repository_scan_budget_seconds INTEGER NOT NULL DEFAULT 300",
        "ck_tenants_repository_scan_budget_positive",
        "CHECK (repository_scan_budget_seconds > 0)",
        "CREATE TABLE IF NOT EXISTS apiome.tenant_repository_scan_cursors",
        "cursor_json JSONB NOT NULL",
        "attempt_count INTEGER NOT NULL DEFAULT 0",
        "uq_tenant_repository_scan_cursors_repo_branch UNIQUE (repository_id, branch)",
        "ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ",
        "idx_tenant_repo_file_scan_jobs_queued_fair",
    )
    missing = [frag for frag in required if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_default_budget_is_five_minutes(repo_root: Path) -> None:
    """The roadmap's default budget must remain 5 minutes."""
    assert "DEFAULT 300" in (repo_root / _MIGRATION).read_text()
