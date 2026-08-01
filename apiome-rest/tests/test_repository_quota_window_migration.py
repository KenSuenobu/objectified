"""Guardrails for the quota-telemetry schema (REPO-7.3, #2801).

V233 is what makes the counters trustworthy rather than approximate: the unique key is
the conflict target the atomic increment depends on, and without it two replicas sweeping
the same tenant in the same window each create a row and every dashboard read shows half
the truth. The Python side runs against fakes, so these fragments are what pin the
migration to the statements the DAO actually emits.
"""

from pathlib import Path

import pytest

from app.repository_quota_window import ALL_METRICS, WINDOW_DAY, WINDOW_HOUR

_MIGRATION = "apiome-db/scripts/V233__repository_quota_window_repo_7_3.sql"
_TABLE = "apiome.repository_quota_window"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


# --- the table the DAO writes into -------------------------------------------------------


def test_the_counter_table_is_created_idempotently(repo_root: Path) -> None:
    assert f"CREATE TABLE IF NOT EXISTS {_TABLE} (" in _migration_text(repo_root)


def test_counters_are_dropped_with_the_tenant_they_describe(repo_root: Path) -> None:
    """A deleted tenant must not leave counters behind that a reused id would inherit."""
    body = _migration_text(repo_root).split(f"CREATE TABLE IF NOT EXISTS {_TABLE} (", 1)[1]
    assert "REFERENCES apiome.tenants(id) ON DELETE CASCADE" in body.split(");", 1)[0]


# --- the atomicity the increment depends on ----------------------------------------------


def test_the_table_has_the_unique_key_the_increment_conflicts_on(repo_root: Path) -> None:
    """Without this constraint the DAO's ``ON CONFLICT (tenant_id, metric, window_start)``
    has no arbiter and the increment errors instead of accumulating."""
    text = _migration_text(repo_root)
    assert "CONSTRAINT uq_repository_quota_window_tenant_metric_start" in text
    assert "UNIQUE (tenant_id, metric, window_start)" in text


def test_the_counter_is_wide_enough_for_a_days_worth_of_bytes(repo_root: Path) -> None:
    """`bytes_scanned` on a monorepo tenant passes 2^31 in a single day; an INTEGER column
    would overflow rather than report."""
    assert "amount        BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0)" in _migration_text(
        repo_root
    )


# --- the metric vocabulary ---------------------------------------------------------------


@pytest.mark.parametrize("metric", ALL_METRICS)
def test_every_application_metric_is_accepted_by_the_schema(
    repo_root: Path, metric: str
) -> None:
    """A CHECK that lags the module turns a real increment into an insert failure — which
    ``record_quota_usage`` then swallows, leaving a silently blank series."""
    assert f"'{metric}'" in _migration_text(repo_root)


def test_the_schema_accepts_no_metric_the_application_never_writes(repo_root: Path) -> None:
    """An extra value is a counter with no writer and a panel that can only ever be flat."""
    text = _migration_text(repo_root)
    body = text.split("metric        VARCHAR(32) NOT NULL", 1)[1].split(")),", 1)[0]
    quoted = {
        line.strip().strip(",").strip("'")
        for line in body.splitlines()
        if line.strip().startswith("'")
    }
    assert quoted == set(ALL_METRICS)


def test_the_bucket_width_is_constrained_to_the_two_the_module_uses(repo_root: Path) -> None:
    assert (
        f"CHECK (window_kind IN ('{WINDOW_HOUR}', '{WINDOW_DAY}'))" in _migration_text(repo_root)
    )


# --- read paths --------------------------------------------------------------------------


def test_the_dashboard_read_is_backed_by_an_index(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "idx_repository_quota_window_tenant_recent" in text
    assert f"ON {_TABLE} (tenant_id, window_start DESC)" in text


def test_the_retention_prune_is_backed_by_an_index_of_its_own(repo_root: Path) -> None:
    """The prune selects by age across all tenants, which the tenant-leading index cannot
    serve without a full scan."""
    text = _migration_text(repo_root)
    assert "idx_repository_quota_window_start" in text
    assert f"ON {_TABLE} (window_start)" in text


def test_every_index_is_created_idempotently(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert text.count("CREATE INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


def test_every_index_is_documented_in_the_catalog(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert text.count("COMMENT ON INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


def test_the_table_is_documented_in_the_catalog(repo_root: Path) -> None:
    assert f"COMMENT ON TABLE {_TABLE} IS" in _migration_text(repo_root)


# --- blast radius ------------------------------------------------------------------------


def test_the_migration_touches_no_existing_data(repo_root: Path) -> None:
    """Counters start empty by design: there is no history to backfill, because before
    this migration nothing was durably counted."""
    statements = "\n".join(
        line
        for line in _migration_text(repo_root).upper().splitlines()
        if not line.lstrip().startswith("--")
    )
    for forbidden in ("ALTER TABLE", "DROP TABLE", "UPDATE ", "DELETE FROM", "INSERT INTO"):
        assert forbidden not in statements, forbidden


def test_the_migration_sets_the_schema_it_writes_into(repo_root: Path) -> None:
    assert "SET search_path TO apiome, public;" in _migration_text(repo_root)
