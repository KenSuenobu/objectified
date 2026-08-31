"""Guardrails for the mock-instance engine fold migration (#5532, MSC-2.2)."""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V250__mock_instance_engine_fold_5532.sql"

# Fragments the migration must contain so the fold's storage survives accidental edits.
# Acceptance criteria for #5532:
#   - somewhere to keep the apiome-mock-shaped settings each instance is now served from;
#   - somewhere to report rules that could not be translated, so none is silently dropped;
#   - the legacy config retained as the pre-fold record it is diffed against.
_REQUIRED_FRAGMENTS = (
    "ADD COLUMN IF NOT EXISTS settings JSONB",
    "ADD COLUMN IF NOT EXISTS migration_notes JSONB NOT NULL DEFAULT '[]'::jsonb",
    "idx_mock_instances_unfolded",
    "WHERE settings IS NULL",
    "COMMENT ON COLUMN mock_instances.settings",
    "COMMENT ON COLUMN mock_instances.migration_notes",
    "COMMENT ON COLUMN mock_instances.config",
)


def test_migration_adds_the_fold_columns(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_sets_odb_search_path(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    assert "SET search_path TO apiome, public;" in text


def test_migration_keeps_the_legacy_config_column(repo_root: Path) -> None:
    """The pre-fold record is what a migrated instance is diffed against; dropping it loses that."""
    text = (repo_root / _MIGRATION).read_text()
    assert "DROP COLUMN" not in text.upper()
