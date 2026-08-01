"""Guardrails for the notification-policy schema (REPO-7.2, #2800).

V232 is what makes two of the three REPO-7.2 promises enforceable rather than aspirational:
the unique key on ``(repository_id, event_type)`` is the conflict target the atomic throttle
claim depends on, and the CHECK constraints are what stop an opt-out being written against an
event type that does not exist — the one failure mode nobody notices until the pager goes
off. The Python side runs against fakes, so these fragments are what pin the migration to the
statements the DAOs actually emit.
"""

from pathlib import Path

import pytest

from app.repository_event_notifications import ALL_EVENT_TYPES

_MIGRATION = "apiome-db/scripts/V232__repository_notification_policy_repo_7_2.sql"

_TABLES = (
    "apiome.repository_notification_preference",
    "apiome.repository_notification_throttle",
)


def _migration_text(repo_root: Path) -> str:
    return (repo_root / _MIGRATION).read_text()


# --- the tables the DAOs write into ------------------------------------------------------


@pytest.mark.parametrize("table", _TABLES)
def test_each_policy_table_is_created_idempotently(repo_root: Path, table: str) -> None:
    assert f"CREATE TABLE IF NOT EXISTS {table} (" in _migration_text(repo_root)


@pytest.mark.parametrize("table", _TABLES)
def test_policy_state_is_dropped_with_the_repository_it_describes(
    repo_root: Path, table: str
) -> None:
    """A deregistered repository must not leave an opt-out behind that silently applies to
    whatever reuses its id."""
    text = _migration_text(repo_root)
    body = text.split(f"CREATE TABLE IF NOT EXISTS {table} (", 1)[1].split(");", 1)[0]
    assert "REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE" in body
    assert "REFERENCES apiome.tenants(id) ON DELETE CASCADE" in body


# --- the throttle's atomicity ------------------------------------------------------------


def test_the_throttle_has_the_unique_key_its_claim_conflicts_on(repo_root: Path) -> None:
    """Without this constraint the DAO's ``ON CONFLICT (repository_id, event_type)`` has no
    arbiter and the claim errors instead of throttling."""
    text = _migration_text(repo_root)
    assert "CONSTRAINT uq_repository_notification_throttle_repo_event" in text
    assert "UNIQUE (repository_id, event_type)" in text


def test_a_preference_cannot_be_written_twice_for_one_event(repo_root: Path) -> None:
    """Two rows for one pair make "is this muted" a question with two answers."""
    assert "CONSTRAINT uq_repository_notification_preference_repo_event" in _migration_text(
        repo_root
    )


def test_the_suppression_counter_cannot_go_backwards_into_nonsense(repo_root: Path) -> None:
    assert "suppressed_count BIGINT NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0)" in (
        _migration_text(repo_root)
    )


# --- the event vocabulary ----------------------------------------------------------------


@pytest.mark.parametrize("event_type", ALL_EVENT_TYPES)
def test_every_application_event_is_accepted_by_the_schema(
    repo_root: Path, event_type: str
) -> None:
    """A CHECK that lags the enum turns a real notification into an insert failure."""
    assert f"'{event_type}'" in _migration_text(repo_root)


@pytest.mark.parametrize("table", _TABLES)
def test_each_table_constrains_its_event_type(repo_root: Path, table: str) -> None:
    text = _migration_text(repo_root)
    body = text.split(f"CREATE TABLE IF NOT EXISTS {table} (", 1)[1].split(");", 1)[0]
    assert "CHECK (event_type IN (" in body


def test_the_schema_accepts_no_event_the_application_cannot_send(repo_root: Path) -> None:
    """Both CHECK lists must be exactly the enum — an extra value is an event type with no
    dispatcher and no way to be delivered."""
    text = _migration_text(repo_root)
    quoted = {
        line.strip().strip(",").strip("'")
        for line in text.splitlines()
        if line.strip().startswith("'repository.refresh.")
    }
    assert quoted == set(ALL_EVENT_TYPES)


# --- read paths --------------------------------------------------------------------------


def test_the_gate_read_is_backed_by_a_partial_index(repo_root: Path) -> None:
    """The dispatcher asks "what is muted here" before every notifiable event, and on a
    healthy deployment the answer is nothing — so the index should hold nothing."""
    text = _migration_text(repo_root)
    assert "idx_repository_notification_preference_muted" in text
    assert "ON apiome.repository_notification_preference (repository_id)" in text
    assert "WHERE enabled = FALSE" in text


def test_every_index_is_created_idempotently(repo_root: Path) -> None:
    text = _migration_text(repo_root)
    assert text.count("CREATE INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


def test_every_index_is_documented_in_the_catalog(repo_root: Path) -> None:
    """A bare index name tells the next operator nothing about what it is for."""
    text = _migration_text(repo_root)
    assert text.count("COMMENT ON INDEX") == text.count("CREATE INDEX IF NOT EXISTS")


@pytest.mark.parametrize("table", _TABLES)
def test_each_table_is_documented_in_the_catalog(repo_root: Path, table: str) -> None:
    assert f"COMMENT ON TABLE {table} IS" in _migration_text(repo_root)


# --- blast radius ------------------------------------------------------------------------


def test_the_migration_touches_no_existing_data(repo_root: Path) -> None:
    """Policy state starts empty by design: no row means subscribed, which is the correct
    default for every repository that already exists."""
    statements = "\n".join(
        line
        for line in _migration_text(repo_root).upper().splitlines()
        if not line.lstrip().startswith("--")
    )
    for forbidden in ("ALTER TABLE", "DROP TABLE", "UPDATE ", "DELETE FROM", "INSERT INTO"):
        assert forbidden not in statements, forbidden


def test_the_migration_sets_the_schema_it_writes_into(repo_root: Path) -> None:
    assert "SET search_path TO apiome, public;" in _migration_text(repo_root)
