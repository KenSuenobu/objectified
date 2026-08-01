"""Guardrails for the per-tenant polling-quota migration (REPO-4.6, #2784).

The Python side runs against fakes, so these fragments are what pin the real schema to the
contract the scheduler assumes: the column the DAO reads and writes, its default, the rail
that keeps a negative quota out of the table, and the enterprise backfill that must not
clobber a hand-tuned value.
"""

from pathlib import Path

from app.repository_refresh_quota import (
    DEFAULT_TENANT_QUOTA_JOBS,
    ENTERPRISE_TENANT_QUOTA_JOBS,
)

_MIGRATION = "apiome-db/scripts/V229__per_tenant_polling_quota_repo_4_6.sql"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def test_the_column_the_dao_reads_exists(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "ALTER TABLE apiome.tenants" in text
    assert "ADD COLUMN IF NOT EXISTS repository_polls_per_hour INTEGER NOT NULL DEFAULT 60" in text


def test_the_column_default_matches_the_application_default(repo_root: Path) -> None:
    """The migration and app.repository_refresh_quota must not drift apart."""
    assert DEFAULT_TENANT_QUOTA_JOBS == 60
    assert f"DEFAULT {DEFAULT_TENANT_QUOTA_JOBS}" in _migration_text(repo_root)


def test_a_negative_quota_cannot_be_stored(repo_root: Path) -> None:
    """0 is 'unlimited'; anything below it has no meaning the scheduler could honor."""
    text = _migration_text(repo_root)
    assert "CHECK (repository_polls_per_hour >= 0)" in text


def test_the_check_is_dropped_before_it_is_added(repo_root: Path) -> None:
    """Re-running the migration must not fail on an already-present constraint."""
    text = _migration_text(repo_root)
    drop_at = text.index("DROP CONSTRAINT IF EXISTS ck_tenants_repository_polls_per_hour_non_negative")
    add_at = text.index("ADD CONSTRAINT ck_tenants_repository_polls_per_hour_non_negative")
    assert drop_at < add_at


def test_the_enterprise_tier_is_backfilled(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert f"SET    repository_polls_per_hour = {ENTERPRISE_TENANT_QUOTA_JOBS}" in text
    assert "l.license_type = 'sponsor'" in text


def test_the_backfill_never_clobbers_a_tuned_value(repo_root: Path) -> None:
    """Only rows still at the default are raised, so a re-run is safe and an operator's
    deliberate value survives."""
    assert (
        f"AND  t.repository_polls_per_hour = {DEFAULT_TENANT_QUOTA_JOBS}"
        in _migration_text(repo_root)
    )


def test_the_scheduler_lookup_is_indexed(repo_root: Path) -> None:
    """The sweep reads every live tenant's quota once per tick."""
    text = _migration_text(repo_root)
    assert "CREATE INDEX IF NOT EXISTS idx_tenants_repository_polls_per_hour" in text
    assert "WHERE deleted_at IS NULL" in text


def test_the_column_is_documented(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "COMMENT ON COLUMN apiome.tenants.repository_polls_per_hour IS" in text
    # The two rules an operator most needs from the column comment.
    assert "0 means unlimited" in text
    assert "never counted as a refresh failure" in text
