"""Guardrails for the cross-repo spec catalog indexes (REPO-6.4, #2797).

The catalog's acceptance bar is "works at 10k+ files", and the whole of that claim rests on
V230's indexes: without them the search is a sequential scan and every row re-reads a
repository's entire import history. The Python side runs against fakes, so these fragments are
what pin the migration to the query shapes ``Database.tenant_repository_spec_catalog`` emits.
"""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V230__cross_repo_spec_catalog_indexes_repo_6_4.sql"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def test_the_search_index_is_a_trigram_index(repo_root: Path) -> None:
    """`path ILIKE '%term%'` has a leading wildcard; only a trigram index can serve it."""
    text = _migration_text(repo_root)
    assert "CREATE EXTENSION IF NOT EXISTS pg_trgm" in text
    assert "idx_tenant_repository_files_path_trgm" in text
    assert "USING gin (path gin_trgm_ops)" in text


def test_repository_names_are_searchable_too(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "idx_tenant_repositories_full_name_trgm" in text
    assert "USING gin (repository_full_name gin_trgm_ops)" in text


def test_a_missing_extension_degrades_instead_of_failing_the_migration(repo_root: Path) -> None:
    """A missing search index is a performance regression, not a correctness one — and a
    managed Postgres may not let the migration role install contrib extensions at all."""
    text = _migration_text(repo_root)
    assert "EXCEPTION" in text
    assert "insufficient_privilege" in text
    assert "undefined_file" in text
    assert "RAISE NOTICE" in text


def test_the_latest_import_lookup_is_indexed_in_the_order_the_lateral_reads_it(
    repo_root: Path,
) -> None:
    text = _migration_text(repo_root)
    assert "idx_tenant_repository_imports_repo_branch_path_recent" in text
    assert (
        "ON apiome.tenant_repository_imports (repository_id, branch, path, created_at DESC)"
        in text
    )


def test_the_project_filter_is_indexed(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "idx_repository_import_spec_project" in text
    assert "ON apiome.repository_import_spec (project_id)" in text


def test_the_migration_only_adds_indexes(repo_root: Path) -> None:
    """A read-path migration that alters data cannot be re-run or rolled back cheaply."""
    text = _migration_text(repo_root).upper()
    for forbidden in ("ALTER TABLE", "DROP TABLE", "UPDATE ", "DELETE FROM", "INSERT INTO"):
        assert forbidden not in text, forbidden


def test_every_index_is_created_idempotently(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert text.count("CREATE INDEX") == text.count("CREATE INDEX IF NOT EXISTS")
