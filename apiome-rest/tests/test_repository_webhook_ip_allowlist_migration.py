"""Guardrails for the webhook IP allowlist schema (REPO-7.6, #2804).

The Python side runs against fakes, so these fragments are what pin V234 to the statements
the DAO actually emits. The two that matter most are the unique keys: without
``uq_webhook_provider_ip_range_provider_cidr`` the daily refresh appends a full copy of the
provider's list every day instead of upserting, and without
``uq_tenant_webhook_ip_allowlist_tenant_cidr`` a tenant can hold two rows for one range and
has to disable both in lockstep to actually close the hole.
"""

from pathlib import Path

import pytest

from app.repository_webhook_ingest import SUPPORTED_PROVIDERS

_MIGRATION = "apiome-db/scripts/V234__repository_webhook_ip_allowlist_repo_7_6.sql"

_RANGE_TABLE = "apiome.webhook_provider_ip_range"
_REFRESH_TABLE = "apiome.webhook_provider_ip_refresh"
_ENTRY_TABLE = "apiome.tenant_webhook_ip_allowlist"
_POLICY_TABLE = "apiome.tenant_webhook_ip_policy"


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


def _table_body(repo_root: Path, table: str) -> str:
    text = _migration_text(repo_root)
    return text.split(f"CREATE TABLE IF NOT EXISTS {table} (", 1)[1].split(");", 1)[0]


# --- the four tables ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "table", [_RANGE_TABLE, _REFRESH_TABLE, _ENTRY_TABLE, _POLICY_TABLE]
)
def test_every_table_is_created_idempotently(repo_root: Path, table: str) -> None:
    assert f"CREATE TABLE IF NOT EXISTS {table} (" in _migration_text(repo_root)


@pytest.mark.parametrize("table", [_ENTRY_TABLE, _POLICY_TABLE])
def test_tenant_scoped_rows_are_dropped_with_their_tenant(
    repo_root: Path, table: str
) -> None:
    """A deleted tenant must not leave allowlist rows behind that a reused id inherits —
    which would be an inherited hole in someone else's filter."""
    assert "REFERENCES apiome.tenants(id) ON DELETE CASCADE" in _table_body(
        repo_root, table
    )


@pytest.mark.parametrize("table", [_ENTRY_TABLE, _POLICY_TABLE])
def test_an_entry_outlives_the_account_that_created_it(
    repo_root: Path, table: str
) -> None:
    """Losing the attribution when someone leaves is better than losing the filter."""
    assert "REFERENCES apiome.users(id) ON DELETE SET NULL" in _table_body(repo_root, table)


# --- the keys the DAO conflicts on -------------------------------------------------------


def test_the_range_cache_has_the_key_the_refresh_upserts_on(repo_root: Path) -> None:
    """Without it the daily refresh appends the provider's whole list every day and the
    guard scans an ever-growing table of duplicates."""
    text = _migration_text(repo_root)
    assert "CONSTRAINT uq_webhook_provider_ip_range_provider_cidr" in text
    assert "UNIQUE (provider, cidr)" in text


def test_a_tenant_holds_at_most_one_row_per_range(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "CONSTRAINT uq_tenant_webhook_ip_allowlist_tenant_cidr" in text
    assert "UNIQUE (tenant_id, cidr)" in text


def test_refresh_state_is_keyed_by_provider(repo_root: Path) -> None:
    assert "provider        VARCHAR(32) PRIMARY KEY" in _migration_text(repo_root)


def test_the_policy_is_keyed_by_tenant(repo_root: Path) -> None:
    assert "tenant_id           UUID PRIMARY KEY" in _migration_text(repo_root)


# --- the vocabulary the application writes -----------------------------------------------


@pytest.mark.parametrize("provider", SUPPORTED_PROVIDERS)
def test_every_verifiable_provider_is_accepted_by_the_schema(
    repo_root: Path, provider: str
) -> None:
    """A range for a provider whose deliveries cannot be verified would be an allowlist
    entry protecting nothing, so the CHECK and the application list must agree."""
    text = _migration_text(repo_root)
    assert f"'{provider}'" in text


@pytest.mark.parametrize("source", ["provider", "configured"])
def test_both_range_sources_are_accepted(repo_root: Path, source: str) -> None:
    body = _table_body(repo_root, _RANGE_TABLE)
    assert f"'{source}'" in body


@pytest.mark.parametrize("outcome", ["pending", "success", "failure", "skipped"])
def test_every_refresh_outcome_the_writer_emits_is_accepted(
    repo_root: Path, outcome: str
) -> None:
    body = _table_body(repo_root, _REFRESH_TABLE)
    assert f"'{outcome}'" in body


# --- the columns the decision depends on -------------------------------------------------


@pytest.mark.parametrize("table", [_RANGE_TABLE, _ENTRY_TABLE])
def test_the_address_family_is_stored_and_constrained(
    repo_root: Path, table: str
) -> None:
    """Denormalised so the guard reads only the family of the address in hand, and
    CHECK-constrained because a third value would silently match nothing."""
    assert "family" in _table_body(repo_root, table)
    assert "CHECK (family IN (4, 6))" in _table_body(repo_root, table)


def test_enforcement_defaults_to_on_for_a_tenant_that_writes_a_policy_row(
    repo_root: Path,
) -> None:
    """The bypass has to be an explicit act; a row created for any other reason must not
    silently turn the filter off."""
    assert "enforcement_enabled BOOLEAN NOT NULL DEFAULT TRUE" in _table_body(
        repo_root, _POLICY_TABLE
    )


def test_an_entry_is_enabled_when_it_is_added(repo_root: Path) -> None:
    assert "enabled     BOOLEAN NOT NULL DEFAULT TRUE" in _table_body(
        repo_root, _ENTRY_TABLE
    )


def test_the_last_success_timestamp_is_separate_from_the_last_attempt(
    repo_root: Path,
) -> None:
    """The gap between them is the only thing that says "stale because it keeps failing"
    rather than "fresh"."""
    body = _table_body(repo_root, _REFRESH_TABLE)
    assert "last_attempt_at TIMESTAMPTZ" in body
    assert "last_success_at TIMESTAMPTZ" in body


# --- the indexes the guard's reads need --------------------------------------------------


def test_the_provider_range_lookup_is_indexed(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert "idx_webhook_provider_ip_range_lookup" in text
    assert f"ON {_RANGE_TABLE} (provider, family)" in text


def test_the_tenant_entry_lookup_is_indexed_on_the_rows_it_actually_reads(
    repo_root: Path,
) -> None:
    """Partial on ``enabled = TRUE`` because a disabled entry is never consulted on the
    delivery path."""
    text = _migration_text(repo_root)
    assert "idx_tenant_webhook_ip_allowlist_enabled" in text
    assert "WHERE enabled = TRUE" in text


# --- documentation -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "table", [_RANGE_TABLE, _REFRESH_TABLE, _ENTRY_TABLE, _POLICY_TABLE]
)
def test_every_table_explains_itself_in_the_catalog(repo_root: Path, table: str) -> None:
    assert f"COMMENT ON TABLE {table} IS" in _migration_text(repo_root)
