"""Guardrails for the RAR-1.6 historical import-spec backfill migration (#3517).

The migration seeds a conservative default spec for every historical
``tenant_repository_imports`` row that predates spec capture (RAR-1.2), flagged
``backfilled = TRUE`` so seeded specs stay distinguishable from user-authored
ones. These fragment checks pin the properties the acceptance criteria rely on:

* every historical lineage gains a spec row flagged ``backfilled = TRUE``;
* the seeded spec is the system defaults (empty options blob, current envelope
  version) with a *detected* source kind, never an invented one;
* the freshness anchors make the row refresh-eligible without triggering a
  spurious re-import wave (checksum-only gating when the historical blob SHA is
  known, current-scan anchoring otherwise);
* the migration is idempotent and re-runnable (IF NOT EXISTS column add,
  NOT EXISTS insert guard, ON CONFLICT DO NOTHING) and never overwrites a
  user-authored spec.
"""

from pathlib import Path
from typing import Any, Dict, Optional

from app.database import Database

_MIGRATION = "apiome-db/scripts/V223__backfill_import_specs_for_historical_rar_1_6.sql"

_REQUIRED_FRAGMENTS = (
    # The distinguishing flag, re-runnable column add, and its documentation.
    "ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE",
    "COMMENT ON COLUMN apiome.repository_import_spec.backfilled",
    # One spec per historical lineage, seeded from the latest audit row.
    "INSERT INTO apiome.repository_import_spec (",
    "SELECT DISTINCT ON (tri.repository_id, tri.branch, tri.path)",
    "FROM apiome.tenant_repository_imports tri",
    "ORDER BY tri.repository_id, tri.branch, tri.path, tri.created_at DESC",
    # System defaults + current envelope version, flagged as backfilled.
    "'{}'::jsonb, 1, tri.imported_by",
    # Detected source kind: arazzo from the scan index or filename, else openapi.
    "WHEN trf.detected_kind ILIKE 'arazzo%' THEN 'arazzo'",
    "ELSE 'openapi'",
    # Conservative freshness anchors: checksum-only gating when the historical
    # blob is known, current-scan anchoring when it is not.
    "CASE WHEN b.imported_blob_sha IS NOT NULL THEN NULL ELSE trf.commit_sha END",
    "CASE WHEN b.imported_blob_sha IS NOT NULL THEN NULL ELSE trf.committed_at END",
    "COALESCE(b.imported_blob_sha, trf.blob_sha)",
    # Idempotent + re-runnable, never clobbering a user-authored spec.
    "WHERE NOT EXISTS (",
    "ON CONFLICT ON CONSTRAINT uq_repository_import_spec_repo_branch_path DO NOTHING",
    # Soft-deleted repositories and projects are skipped, like the live capture.
    "tr.deleted_at IS NULL",
    "p.deleted_at IS NULL",
)


def test_backfill_migration_pins_acceptance_criteria(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_backfill_rows_are_flagged_backfilled_true(repo_root: Path) -> None:
    """The seeded rows carry backfilled = TRUE (the last inserted column)."""
    text = (repo_root / _MIGRATION).read_text()
    assert "backfilled" in text.split("INSERT INTO apiome.repository_import_spec (", 1)[1]
    # The SELECT's final projected value is the literal TRUE for the flag.
    assert "TRUE\nFROM apiome.tenant_repository_imports tri" in text


def test_backfill_never_updates_existing_specs(repo_root: Path) -> None:
    """Re-running must be a no-op for existing rows: insert-only, no UPDATE arm."""
    text = (repo_root / _MIGRATION).read_text()
    assert "DO UPDATE" not in text
    assert "DO NOTHING" in text


# --- genuine captures clear the flag ----------------------------------------


class _FakeCursor:
    """Records executed queries and returns one canned row from fetchone()."""

    def __init__(self, row: Optional[Dict[str, Any]]) -> None:
        self.row = row
        self.executed: list = []

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.row

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConn:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        return None

    def rollback(self) -> None:  # pragma: no cover - only on error paths
        return None


def test_genuine_capture_clears_backfilled_flag() -> None:
    """The DAO upsert writes backfilled=FALSE on insert *and* on conflict-update,
    so a lineage seeded by the migration becomes user-authored on the first real
    re-import — keeping the flag a truthful 'imported before spec capture' marker."""
    cursor = _FakeCursor(
        {
            "id": "spec-1",
            "source_kind": "openapi",
            "options_json": {},
            "spec_schema_version": 1,
            "backfilled": False,
        }
    )
    db = Database()
    db.connect = lambda: _FakeConn(cursor)  # type: ignore[method-assign]

    row = db.upsert_repository_import_spec(
        tenant_id="t1",
        repository_id="r1",
        branch="main",
        path="a.yaml",
        project_id="p1",
        source_kind="openapi",
        options={},
    )

    query, _params = cursor.executed[0]
    assert "backfilled" in query
    assert "backfilled = FALSE" in query  # conflict arm clears a seeded flag
    assert "trf.commit_sha, trf.committed_at, trf.blob_sha,\n                   FALSE" in query
    assert row["backfilled"] is False
