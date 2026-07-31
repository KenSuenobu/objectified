"""Guardrails for the external ``$ref`` policy migration (REPO-3.9, #2778).

The Python side runs against fakes, so these fragments are what pins the real schema to the
contract the code assumes: the column names the DAO reads and writes, the CHECK that keeps an
unknown mode out of the store, and the default that makes an unconfigured tenant fail closed.
"""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V226__repository_external_ref_policy_repo_3_9.sql"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def test_the_tenant_columns_the_dao_reads_exist(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "ALTER TABLE apiome.tenants" in text
    assert "repository_external_ref_policy VARCHAR(32) NOT NULL DEFAULT 'block'" in text
    assert "repository_external_ref_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb" in text


def test_an_unconfigured_tenant_fails_closed(repo_root: Path) -> None:
    """The default is the whole security posture: a tenant nobody configured fetches nothing."""
    assert "DEFAULT 'block'" in _migration_text(repo_root)


def test_only_the_three_documented_modes_are_storable(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "ck_tenants_repository_external_ref_policy" in text
    assert "CHECK (repository_external_ref_policy IN ('block', 'inline', 'proxy-fetch'))" in text


def test_the_allowlist_must_be_a_json_array(repo_root: Path) -> None:
    """An object or scalar would read as "no patterns" and silently widen an inline tenant."""
    text = _migration_text(repo_root)
    assert "ck_tenants_repository_external_ref_allowlist_array" in text
    assert "jsonb_typeof(repository_external_ref_allowlist) = 'array'" in text


def test_the_file_warning_column_exists_and_is_nullable(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "ALTER TABLE apiome.tenant_repository_files" in text
    assert "ADD COLUMN IF NOT EXISTS external_ref_warning JSONB" in text
    assert "external_ref_warning JSONB NOT NULL" not in text


def test_warned_files_are_indexed_partially(repo_root: Path) -> None:
    """Virtually every row is NULL; a full index would be paid for on every monorepo scan."""
    text = _migration_text(repo_root)
    assert "idx_tenant_repository_files_external_ref_warning" in text
    assert "WHERE external_ref_warning IS NOT NULL" in text


def test_the_migration_is_rerunnable(repo_root: Path) -> None:
    """Every statement is idempotent, so a partially-applied migration can be replayed."""
    text = _migration_text(repo_root)
    for statement, guard in (
        ("ADD COLUMN", "IF NOT EXISTS"),
        ("CREATE INDEX", "IF NOT EXISTS"),
    ):
        for line in text.splitlines():
            if statement in line:
                assert guard in line, f"{statement!r} without {guard!r}: {line.strip()}"
    # A constraint cannot be added with IF NOT EXISTS; it is dropped first instead.
    assert text.count("DROP CONSTRAINT IF EXISTS") == text.count("ADD CONSTRAINT")
