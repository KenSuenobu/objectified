"""Freshness signal capture at import (RAR-2.1, #3518).

The repository auto-refresh needs a comparable recency anchor per imported file.
These tests cover the three pieces that produce and persist it:

  1. The scan reads the branch tip commit (SHA + committed-at) from the provider
     branch API already used by ``fetch_github_tree_blobs`` and stamps every
     indexed file row with it.
  2. ``replace_tenant_repository_files`` persists those columns.
  3. ``upsert_repository_import_spec`` copies the indexed row's
     ``blob_sha`` / ``commit_sha`` / ``committed_at`` into the import lineage's
     ``last_imported_*`` anchors via a LEFT JOIN, and the read model surfaces them.
  4. The migration adds the columns.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

from app.database import Database
from app.models import repository_import_spec_read_from_row
from app.repository_file_scan import fetch_github_tree_blobs

_MIGRATION = "apiome-db/scripts/V106__freshness_signal_capture_at_import_rar_2.sql"


# --- scan: branch tip commit attached to every blob -------------------------


def _fake_response(payload: Dict[str, Any], status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    return resp


def test_fetch_github_tree_blobs_captures_branch_tip_commit() -> None:
    branch_payload = {
        "commit": {
            "sha": "tipcommitsha111",
            "commit": {
                "committer": {"date": "2026-06-20T10:00:00Z"},
                "tree": {"sha": "treesha999"},
            },
        }
    }
    tree_payload = {
        "truncated": False,
        "tree": [
            {"type": "blob", "path": "openapi/petstore.yaml", "size": 1234, "sha": "blobsha123"},
            {"type": "blob", "path": "README.md", "size": 10, "sha": "blobsha456"},
            {"type": "tree", "path": "openapi", "sha": "ignoreme"},
        ],
    }

    client = MagicMock()
    client.get.side_effect = [_fake_response(branch_payload), _fake_response(tree_payload)]
    client_cm = MagicMock()
    client_cm.__enter__.return_value = client
    client_cm.__exit__.return_value = False

    with patch("app.repository_file_scan.httpx.Client", return_value=client_cm):
        blobs = fetch_github_tree_blobs("acme", "petstore", "main", None)

    # Only blobs (not trees) are indexed, and every one carries the tip commit.
    assert [b["path"] for b in blobs] == ["openapi/petstore.yaml", "README.md"]
    for b in blobs:
        assert b["commit_sha"] == "tipcommitsha111"
        assert b["committed_at"] == "2026-06-20T10:00:00Z"
    assert blobs[0]["blob_sha"] == "blobsha123"


def test_fetch_github_tree_blobs_tolerates_missing_commit_metadata() -> None:
    # A branch payload without committer date / tip sha must not crash the scan;
    # the anchors fall back to None (newer-than then degrades to checksum-only).
    branch_payload = {"commit": {"commit": {"tree": {"sha": "treesha999"}}}}
    tree_payload = {
        "truncated": False,
        "tree": [{"type": "blob", "path": "a.yaml", "size": 1, "sha": "b1"}],
    }

    client = MagicMock()
    client.get.side_effect = [_fake_response(branch_payload), _fake_response(tree_payload)]
    client_cm = MagicMock()
    client_cm.__enter__.return_value = client
    client_cm.__exit__.return_value = False

    with patch("app.repository_file_scan.httpx.Client", return_value=client_cm):
        blobs = fetch_github_tree_blobs("acme", "petstore", "main", None)

    assert blobs[0]["commit_sha"] is None
    assert blobs[0]["committed_at"] is None


# --- DAO: persist scan recency + copy it into the import anchor --------------


class _FakeCursor:
    """Records executed statements and returns a canned row."""

    def __init__(self, row: Optional[Dict[str, Any]]):
        self.row = row
        self.executed: List[Any] = []
        # ``Database._execute_write`` reads this after a DELETE/UPDATE.
        self.rowcount = 0

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def executemany(self, query: str, seq: Any) -> None:
        self.executed.append((query, list(seq)))

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.row


class _FakeConn:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor
        self.closed = False
        self.committed = False

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:  # pragma: no cover - only on error paths
        pass


def _db_with(cursor: _FakeCursor) -> Database:
    db = Database()
    db.connect = lambda: _FakeConn(cursor)  # type: ignore[method-assign]
    return db


def test_replace_tenant_repository_files_persists_commit_recency() -> None:
    cursor = _FakeCursor(None)
    db = _db_with(cursor)

    files = [
        {
            "path": "a.yaml",
            "name": "a.yaml",
            "ext": "yaml",
            "size_bytes": 12,
            "blob_sha": "blob1",
            "detected_kind": "openapi-candidate",
            "commit_sha": "tip1",
            "committed_at": "2026-06-20T10:00:00Z",
        }
    ]
    db.replace_tenant_repository_files("11111111-1111-1111-1111-111111111111", "main", files)

    insert = next(q for q in cursor.executed if "INSERT INTO apiome.tenant_repository_files" in q[0])
    assert "commit_sha, committed_at" in insert[0]
    # The per-row tuple includes the two new trailing values.
    row_tuple = insert[1][0]
    assert row_tuple[-2] == "tip1"
    assert row_tuple[-1] == "2026-06-20T10:00:00Z"


def test_upsert_repository_import_spec_copies_freshness_from_file_row() -> None:
    returned = {
        "id": "spec-1",
        "tenant_id": "t1",
        "repository_id": "r1",
        "branch": "main",
        "path": "a.yaml",
        "project_id": "p1",
        "source_kind": "openapi-3",
        "format_override": None,
        "content_type": None,
        "options_json": {},
        "spec_schema_version": 1,
        "created_by": None,
        "last_imported_commit_sha": "tip1",
        "last_imported_committed_at": "2026-06-20T10:00:00Z",
        "last_imported_blob_sha": "blob1",
        "created_at": None,
        "updated_at": None,
    }
    cursor = _FakeCursor(returned)
    db = _db_with(cursor)

    row = db.upsert_repository_import_spec(
        tenant_id="t1",
        repository_id="r1",
        branch="main",
        path="a.yaml",
        project_id="p1",
        source_kind="openapi-3",
        options={},
    )

    query, params = cursor.executed[0]
    # The anchors are written from the matching scan row via a LEFT JOIN, not bound.
    assert "LEFT JOIN apiome.tenant_repository_files trf" in query
    assert "trf.commit_sha, trf.committed_at, trf.blob_sha" in query
    assert "last_imported_commit_sha = EXCLUDED.last_imported_commit_sha" in query
    # The JOIN reuses branch + path, so they appear again before the WHERE binds.
    assert params[11] == "main"
    assert params[12] == "a.yaml"
    # The returned row carries the captured anchors back to the caller.
    assert row["last_imported_commit_sha"] == "tip1"
    assert row["last_imported_blob_sha"] == "blob1"


def test_read_model_surfaces_freshness_anchors() -> None:
    read = repository_import_spec_read_from_row(
        {
            "source_kind": "openapi-3",
            "options_json": {},
            "spec_schema_version": 1,
            "last_imported_commit_sha": "tip1",
            "last_imported_committed_at": "2026-06-20T10:00:00Z",
            "last_imported_blob_sha": "blob1",
        }
    )
    assert read.last_imported_commit_sha == "tip1"
    assert read.last_imported_committed_at == "2026-06-20T10:00:00Z"
    assert read.last_imported_blob_sha == "blob1"


# --- migration --------------------------------------------------------------


def test_migration_adds_freshness_columns(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    required = (
        "ALTER TABLE apiome.tenant_repository_files",
        "ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(64)",
        "ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ",
        "ALTER TABLE apiome.repository_import_spec",
        "ADD COLUMN IF NOT EXISTS last_imported_commit_sha VARCHAR(64)",
        "ADD COLUMN IF NOT EXISTS last_imported_committed_at TIMESTAMPTZ",
        "ADD COLUMN IF NOT EXISTS last_imported_blob_sha VARCHAR(64)",
    )
    missing = [frag for frag in required if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"
