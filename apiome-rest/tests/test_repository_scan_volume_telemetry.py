"""Scan-volume telemetry from the repository walk (REPO-7.3, #2801).

``scan_repository_branch_into_index`` is the single choke point every repository walk goes
through — the one-shot scan job and the auto-refresh sweep both call it — so it is where
the ``scans`` and ``bytes_scanned`` counters are recorded. These tests drive that function
with a stubbed walker (no network, no database) and pin what reaches the counters: that a
pass is counted whether it finished or paused, that a failing pass is not counted as scan
volume, and that a byte total is per pass rather than per branch.
"""

from typing import Any, Dict, List, Optional, Sequence

import pytest

import app.repository_file_scan as file_scan
from app.repository_quota_window import (
    METRIC_BYTES_SCANNED,
    METRIC_SCANS,
    WINDOW_DAY,
)
from app.repository_scan_budget import ScanCursor, TransientScanError

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO = "880e8400-e29b-41d4-a716-446655440003"

_REPO_ROW = {
    "id": _REPO,
    "tenant_id": _TENANT,
    "provider": "github",
    "visibility": "public",
    "default_branch": "main",
    "repository_full_name": "acme/widgets",
}


class FakeDB:
    """Records the counter writes; every other DAO call is an inert stub."""

    def __init__(self) -> None:
        self.quota_windows: List[Dict[str, Any]] = []
        self.appended: List[Sequence[Dict[str, Any]]] = []
        self.cursors_saved: List[Dict[str, Any]] = []

    # --- REPO-7.3 counters ---
    def increment_repository_quota_window(
        self, *, tenant_id, metric, window_kind, window_start, amount
    ) -> None:
        self.quota_windows.append(
            {
                "tenant_id": tenant_id,
                "metric": metric,
                "window_kind": window_kind,
                "window_start": window_start,
                "amount": amount,
            }
        )

    def total(self, metric: str) -> int:
        return sum(r["amount"] for r in self.quota_windows if r["metric"] == metric)

    def calls_for(self, metric: str) -> int:
        return sum(1 for r in self.quota_windows if r["metric"] == metric)

    # --- the walk's persistence surface ---
    def get_repository_scan_cursor(self, repository_id, branch) -> Optional[Dict[str, Any]]:
        return None

    def clear_repository_scan_cursor(self, repository_id, branch) -> None:
        return None

    def save_repository_scan_cursor(self, repository_id, branch, **kwargs) -> None:
        self.cursors_saved.append({"branch": branch, **kwargs})

    def delete_tenant_repository_files(self, repository_id, branch) -> None:
        return None

    def append_tenant_repository_files(self, repository_id, branch, chunk) -> None:
        self.appended.append(list(chunk))

    def count_tenant_repository_files(self, repository_id, branch):
        return (sum(len(c) for c in self.appended), 0)

    def update_tenant_repository_after_file_scan(self, **kwargs) -> None:
        return None

    def get_tenant_repository_scan_budget_seconds(self, tenant_id) -> Optional[int]:
        return None


def _entry(path: str, size_bytes: Any) -> Dict[str, Any]:
    return {"path": path, "detected_kind": "openapi-3", "size_bytes": size_bytes}


@pytest.fixture(autouse=True)
def _stub_provider(monkeypatch):
    """Resolve the repository without touching GitHub or the linked-account store."""
    monkeypatch.setattr(file_scan, "_github_owner_repo", lambda row: ("acme", "widgets"))
    monkeypatch.setattr(file_scan, "_resolve_scan_token", lambda db, row: None)


def _walk(chunks: List[List[Dict[str, Any]]], *, completed: bool = True, raises: bool = False):
    """Build a stub walker that feeds ``chunks`` to the sink, then reports an outcome."""

    def _fake_walk(owner, repo, branch, token, *, on_chunk, cursor, budget, chunk_size):
        for chunk in chunks:
            on_chunk(chunk)
        if raises:
            raise TransientScanError("github 502", cursor=ScanCursor(tree_sha="abc"))
        return file_scan.WalkOutcome(
            completed=completed,
            cursor=None if completed else ScanCursor(tree_sha="abc"),
            truncated_prefixes=(),
        )

    return _fake_walk


def _scan(db: FakeDB, monkeypatch, walker) -> Any:
    monkeypatch.setattr(file_scan, "walk_github_tree_in_chunks", walker)
    return file_scan.scan_repository_branch_into_index(db, dict(_REPO_ROW), "main")


# --- the pass counter --------------------------------------------------------------------


def test_a_completed_pass_is_counted_once(monkeypatch) -> None:
    db = FakeDB()
    _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100)]]))
    assert db.total(METRIC_SCANS) == 1


def test_a_pass_that_paused_on_its_budget_is_still_counted(monkeypatch) -> None:
    """It made the same provider calls and occupied the same scan worker; that cost is
    exactly what the metric exists to expose."""
    db = FakeDB()
    result = _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100)]], completed=False))
    assert result.completed is False
    assert db.total(METRIC_SCANS) == 1


def test_a_pass_that_raised_records_no_scan_volume(monkeypatch) -> None:
    """Counting a failing walk as scan volume would make a broken repository read as a busy
    one on the dashboard."""
    db = FakeDB()
    monkeypatch.setattr(
        file_scan, "walk_github_tree_in_chunks", _walk([[_entry("a.yaml", 100)]], raises=True)
    )
    with pytest.raises(TransientScanError):
        file_scan.scan_repository_branch_into_index(db, dict(_REPO_ROW), "main")
    assert db.quota_windows == []


def test_scan_volume_buckets_daily(monkeypatch) -> None:
    db = FakeDB()
    _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100)]]))
    assert all(row["window_kind"] == WINDOW_DAY for row in db.quota_windows)


def test_the_counter_is_attributed_to_the_repositorys_tenant(monkeypatch) -> None:
    db = FakeDB()
    _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100)]]))
    assert {row["tenant_id"] for row in db.quota_windows} == {_TENANT}


# --- the byte counter --------------------------------------------------------------------


def test_bytes_are_summed_across_every_chunk_the_pass_walked(monkeypatch) -> None:
    db = FakeDB()
    _scan(
        db,
        monkeypatch,
        _walk([[_entry("a.yaml", 100), _entry("b.yaml", 250)], [_entry("c.yaml", 650)]]),
    )
    assert db.total(METRIC_BYTES_SCANNED) == 1000


def test_the_pass_reports_its_own_byte_total(monkeypatch) -> None:
    """Exposed on ``ScanPass`` so a caller can log or assert the volume without reading it
    back out of the counter table."""
    db = FakeDB()
    result = _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100), _entry("b.yaml", 250)]]))
    assert result.bytes_scanned == 350


@pytest.mark.parametrize("size", [None, "12", -5])
def test_an_entry_with_no_usable_size_contributes_nothing(monkeypatch, size: Any) -> None:
    """Sub-trees and submodules carry no size, and a provider that reports one as a string
    must not make the byte total a TypeError in the middle of a scan."""
    db = FakeDB()
    _scan(db, monkeypatch, _walk([[_entry("a.yaml", size), _entry("b.yaml", 400)]]))
    assert db.total(METRIC_BYTES_SCANNED) == 400


def test_a_pass_that_indexed_nothing_still_counts_as_a_pass(monkeypatch) -> None:
    """Zero bytes is a real answer — an empty branch was still walked — but it writes no
    byte row, because a zero-valued counter row carries no information."""
    db = FakeDB()
    _scan(db, monkeypatch, _walk([]))
    assert db.calls_for(METRIC_SCANS) == 1
    assert db.calls_for(METRIC_BYTES_SCANNED) == 0


# --- degradation -------------------------------------------------------------------------


def test_a_counter_write_failure_never_fails_a_scan_that_succeeded(monkeypatch) -> None:
    db = FakeDB()

    def _boom(**kwargs):
        raise RuntimeError("counter table is gone")

    db.increment_repository_quota_window = _boom  # type: ignore[method-assign]
    result = _scan(db, monkeypatch, _walk([[_entry("a.yaml", 100)]]))
    assert result.completed is True
    assert result.total_files == 1
