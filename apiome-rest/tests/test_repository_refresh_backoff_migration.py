"""Guardrails for the refresh backoff + auto-pause migration (RAR-3.4, #3525)."""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V224__refresh_backoff_auto_pause_rar_3_4.sql"

# Fragments the migration must keep so the backoff/auto-pause state survives
# accidental edits. Acceptance criteria for #3525: a consecutive-failure counter
# (default 0 so existing repos read healthy), a backoff anchor, and the pause
# timestamp + reason a manual resume clears.
_REQUIRED_FRAGMENTS = (
    "ALTER TABLE apiome.tenant_repositories",
    "ADD COLUMN IF NOT EXISTS refresh_consecutive_failures INTEGER NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS refresh_backoff_until TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS refresh_paused_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS refresh_pause_reason TEXT",
    "ck_tenant_repositories_refresh_failures_nonnegative",
    "CHECK (refresh_consecutive_failures >= 0)",
)


def test_migration_adds_backoff_and_pause_columns(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_failure_counter_defaults_to_zero(repo_root: Path) -> None:
    """Existing repositories must read as healthy (0 failures, not paused)."""
    text = (repo_root / _MIGRATION).read_text()
    assert "refresh_consecutive_failures INTEGER NOT NULL DEFAULT 0" in text
    # The pause columns must be nullable (no NOT NULL) so pre-existing rows are unpaused.
    assert "refresh_paused_at TIMESTAMPTZ NOT NULL" not in text
    assert "refresh_backoff_until TIMESTAMPTZ NOT NULL" not in text
