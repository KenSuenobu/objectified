"""Guardrails for the health-badge indexes (REPO-6.5, #2798).

The badge is drawn on every row of the repositories screen, so its two aggregates run once
per repository on the busiest repository read there is. V231 is what keeps that affordable:
without it the scan-rate window is a filter over a repository's whole job history and the
parse-error count is a sequential scan of a monorepo's file table. The Python side runs
against fakes, so these fragments are what pin the migration to the query shapes
``Database.get_repository_health_signals`` emits.
"""

from pathlib import Path

_MIGRATION = "apiome-db/scripts/V231__repository_health_badge_indexes_repo_6_5.sql"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def test_the_scan_window_is_indexed_in_the_order_the_aggregate_reads_it(
    repo_root: Path,
) -> None:
    """Leading ``repository_id`` picks the repository; descending ``created_at`` turns the
    trailing window into a bounded range scan from the newest end."""
    text = _migration_text(repo_root)
    assert "idx_tenant_repo_file_scan_jobs_repo_recent" in text
    assert (
        "ON apiome.tenant_repository_file_scan_jobs (repository_id, created_at DESC)"
        in text
    )


def test_the_scan_aggregate_can_be_answered_without_touching_the_heap(
    repo_root: Path,
) -> None:
    text = _migration_text(repo_root)
    assert "INCLUDE (status, finished_at)" in text


def test_the_parse_error_index_is_partial_on_the_daos_own_predicate(
    repo_root: Path,
) -> None:
    """A full index over the file table would be the size of the table; the errors are a
    handful of rows, and on a healthy repository there are none at all."""
    text = _migration_text(repo_root)
    assert "idx_tenant_repository_files_parse_errors" in text
    assert "ON apiome.tenant_repository_files (repository_id, branch)" in text
    assert "WHERE quality_status = 'error' OR quality_reason = 'parse-failed'" in text


def test_the_parse_error_index_carries_the_timestamp_the_tooltip_dates_itself_with(
    repo_root: Path,
) -> None:
    text = _migration_text(repo_root)
    assert "INCLUDE (quality_scored_at)" in text


def test_the_migration_only_adds_indexes(repo_root: Path) -> None:
    """A read-path migration that alters data cannot be re-run or rolled back cheaply."""
    text = _migration_text(repo_root).upper()
    for forbidden in ("ALTER TABLE", "DROP TABLE", "UPDATE ", "DELETE FROM", "INSERT INTO"):
        assert forbidden not in text, forbidden


def test_every_index_is_created_idempotently(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert text.count("CREATE INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


def test_the_indexes_are_documented_in_the_catalog(repo_root: Path) -> None:
    """A bare index name tells the next operator nothing about what it is for."""
    text = _migration_text(repo_root)
    assert text.count("COMMENT ON INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


def test_the_migration_sets_the_schema_it_writes_into(repo_root: Path) -> None:
    assert "SET search_path TO apiome, public;" in _migration_text(repo_root)
