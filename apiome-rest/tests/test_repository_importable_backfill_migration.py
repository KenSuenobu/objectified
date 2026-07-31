"""Guardrails for the importable-count recount migration (JSON Schema)."""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V220__repository_importable_json_schema_backfill.sql"

# The recount exists so already-indexed repositories gain their JSON Schema rows without
# re-walking a Git tree. These fragments pin the properties that make that true:
#   - it reads the indexed file table, never a provider API
#   - the JSON arm keys on the stored `path` shape, not on `detected_kind` alone
#   - it is scoped to the repository's default branch and skips soft-deleted rows
#   - it is idempotent: only rows whose count actually changes are written
_REQUIRED_FRAGMENTS = (
    "UPDATE apiome.tenant_repositories r",
    "FROM apiome.tenant_repository_files f",
    "f.detected_kind ILIKE 'json%' AND (",
    "f.path ILIKE '%.schema.json'",
    "f.path ILIKE '%/schemas/%.json'",
    "f.path ILIKE 'schemas/%.json'",
    "c.branch = COALESCE(NULLIF(r.default_branch, ''), 'main')",
    "r.deleted_at IS NULL",
    "r.importable_count IS DISTINCT FROM c.importable_count",
)


def test_migration_recounts_importable_from_indexed_paths(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_does_not_touch_total_files(repo_root: Path) -> None:
    """Only the importable tally is restated; the indexed total is already correct."""
    text = (repo_root / _MIGRATION).read_text()
    assert "total_files =" not in text
