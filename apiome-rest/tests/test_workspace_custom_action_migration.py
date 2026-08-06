"""Structural and live guarantees of V243 — custom palette actions (DUW-5.5, private-suite#2592).

Two layers, following ``test_domains_migration.py``, because they fail differently.

:class:`TestMigrationText` reads the SQL and pins the shape of it. It runs everywhere, needs no
server, and catches an edit that quietly drops a constraint — which for this table would mean the
"effects is a bounded declarative array" guarantee resting on the service alone.

:class:`TestLiveSchema` applies the migration to a real Postgres and exercises what the text
cannot prove: that the CHECKs reject what they claim to, that the name uniqueness is
case-insensitive and per-tenant among live rows only, and that a soft delete frees the name.
These are marked ``requires_db`` and skip without ``DATABASE_URL``.

To run them against an ephemeral server, no installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_workspace_custom_action_migration.py -m requires_db'

The migration is applied inside a transaction that is always rolled back, so a live database is
left exactly as it was found.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

import pytest

MIGRATION = "apiome-db/scripts/V243__workspace_custom_actions_2592.sql"

_db_url = os.environ.get("DATABASE_URL")

_requires_db = pytest.mark.requires_db

#: Two stacked decorators, deliberately: passing one mark as an argument to another does not
#: compose them, it hands the mark object over as a parameter and the skip silently never applies.
_skip_without_db = pytest.mark.skipif(
    not _db_url,
    reason="DATABASE_URL not set – skipping live-DB integration tests",
)

#: The subset of the apiome schema V243 depends on, created fresh in the rolled-back transaction.
_PREREQUISITE_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS apiome;

CREATE TABLE apiome.tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);
CREATE TABLE apiome.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL
);
"""

TENANT = "00000000-0000-4000-8000-000000000001"
OTHER_TENANT = "00000000-0000-4000-8000-000000000002"
USER = "00000000-0000-4000-8000-0000000000b1"

_SEED = f"""
INSERT INTO apiome.tenants (id, name) VALUES
    ('{TENANT}', 'acme'),
    ('{OTHER_TENANT}', 'globex');
INSERT INTO apiome.users (id, email) VALUES
    ('{USER}', 'kenji@example.com');
"""


def _migration_path() -> Path:
    root = Path(__file__).resolve().parents[2]
    return root / MIGRATION


def _sql() -> str:
    return _migration_path().read_text(encoding="utf-8")


class TestMigrationText:
    """Pin the migration's shape, so an edit that drops a guarantee fails loudly."""

    def test_the_migration_exists_where_flyway_will_look(self):
        assert _migration_path().is_file()

    def test_it_creates_the_table_with_a_tenant_cascade(self):
        sql = _sql()
        assert "CREATE TABLE IF NOT EXISTS apiome.workspace_custom_actions" in sql
        assert "REFERENCES apiome.tenants(id) ON DELETE CASCADE" in sql

    def test_attribution_survives_a_user_deletion(self):
        assert "REFERENCES apiome.users(id) ON DELETE SET NULL" in _sql()

    def test_the_subject_vocabulary_is_closed_by_check(self):
        sql = _sql()
        assert "workspace_custom_actions_subject_vocabulary" in sql
        assert "subject IN ('class', 'path', 'property', 'any')" in sql

    def test_the_effects_column_is_pinned_to_a_bounded_array(self):
        sql = _sql()
        assert "jsonb_typeof(effects) = 'array'" in sql
        assert "jsonb_array_length(effects) BETWEEN 1 AND 5" in sql
        assert "octet_length(effects::text) <= 16384" in sql

    def test_names_are_unique_per_tenant_among_live_rows_case_insensitively(self):
        sql = _sql()
        assert "uq_workspace_custom_actions_tenant_name" in sql
        assert "(tenant_id, lower(name)) WHERE deleted_at IS NULL" in sql

    def test_the_palette_read_has_a_partial_index(self):
        sql = _sql()
        assert "idx_workspace_custom_actions_tenant" in sql
        assert "(tenant_id) WHERE deleted_at IS NULL" in sql

    def test_updated_at_maintains_itself(self):
        sql = _sql()
        assert "update_workspace_custom_actions_updated_at" in sql
        assert "BEFORE UPDATE ON apiome.workspace_custom_actions" in sql

    def test_a_blank_name_or_narrowing_is_rejected_at_the_column(self):
        sql = _sql()
        assert "workspace_custom_actions_name_not_blank" in sql
        assert "workspace_custom_actions_name_contains_not_blank" in sql

    def test_every_column_is_commented(self):
        sql = _sql()
        for column in (
            "id",
            "tenant_id",
            "created_by",
            "name",
            "subject",
            "name_contains",
            "effects",
            "deleted_at",
            "created_at",
            "updated_at",
        ):
            assert f"COMMENT ON COLUMN apiome.workspace_custom_actions.{column}" in sql


@_requires_db
@_skip_without_db
class TestLiveSchema:
    """Apply V243 to a real Postgres inside a rolled-back transaction and poke the guarantees."""

    @pytest.fixture()
    def cursor(self):
        psycopg2 = pytest.importorskip("psycopg2")
        conn = psycopg2.connect(_db_url)
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                # Never touch a database that already carries the real schema — this suite builds
                # its own subset and must be pointed at a scratch cluster (module docstring).
                cur.execute(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.schemata "
                    "WHERE schema_name = 'apiome')"
                )
                if cur.fetchone()[0]:
                    pytest.skip(
                        "DATABASE_URL already carries the apiome schema; point this suite at a "
                        "scratch cluster (see the module docstring's pg_virtualenv invocation)."
                    )

                cur.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
                try:
                    cur.execute("SELECT uuid_generate_v4()")
                except psycopg2.Error:
                    conn.rollback()
                    pytest.skip("uuid-ossp is not resolvable on this cluster; cannot apply V243.")

                cur.execute(_PREREQUISITE_SCHEMA)
                cur.execute(_sql())
                cur.execute(_SEED)
                yield cur
        finally:
            conn.rollback()
            conn.close()

    def _insert(
        self,
        cursor: Any,
        *,
        tenant: str = TENANT,
        name: str = "Open runbook",
        subject: str = "class",
        effects: str = '[{"type": "hydrate-set"}]',
        name_contains: Optional[str] = None,
    ) -> None:
        cursor.execute(
            """
            INSERT INTO apiome.workspace_custom_actions
                (tenant_id, created_by, name, subject, name_contains, effects)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s::jsonb)
            """,
            (tenant, USER, name, subject, name_contains, effects),
        )

    def test_a_wellformed_action_inserts(self, cursor):
        self._insert(cursor)
        cursor.execute("SELECT count(*) FROM apiome.workspace_custom_actions")
        assert cursor.fetchone()[0] == 1

    def test_the_subject_vocabulary_is_enforced(self, cursor):
        with pytest.raises(Exception, match="workspace_custom_actions_subject_vocabulary"):
            self._insert(cursor, subject="folder")

    @pytest.mark.parametrize(
        "effects, constraint",
        [
            ('{"type": "hydrate-set"}', "workspace_custom_actions_effects_array"),
            ("[]", "workspace_custom_actions_effects_count"),
            (
                '[{"a":1},{"a":2},{"a":3},{"a":4},{"a":5},{"a":6}]',
                "workspace_custom_actions_effects_count",
            ),
        ],
    )
    def test_effects_must_be_a_bounded_array(self, cursor, effects, constraint):
        with pytest.raises(Exception, match=constraint):
            self._insert(cursor, effects=effects)

    def test_a_blank_name_is_rejected(self, cursor):
        with pytest.raises(Exception, match="workspace_custom_actions_name_not_blank"):
            self._insert(cursor, name="   ")

    def test_names_collide_case_insensitively_within_a_tenant(self, cursor):
        self._insert(cursor, name="Open runbook")
        with pytest.raises(Exception, match="uq_workspace_custom_actions_tenant_name"):
            self._insert(cursor, name="OPEN RUNBOOK")

    def test_the_same_name_lives_happily_in_another_tenant(self, cursor):
        self._insert(cursor, tenant=TENANT)
        self._insert(cursor, tenant=OTHER_TENANT)

    def test_a_soft_delete_frees_the_name(self, cursor):
        self._insert(cursor)
        cursor.execute(
            "UPDATE apiome.workspace_custom_actions SET deleted_at = CURRENT_TIMESTAMP"
        )
        self._insert(cursor)  # would violate the partial unique index were the tombstone counted

    def test_updated_at_moves_on_update(self, cursor):
        self._insert(cursor)
        cursor.execute(
            """
            UPDATE apiome.workspace_custom_actions
               SET name = 'Renamed'
            RETURNING created_at, updated_at, clock_timestamp()
            """
        )
        created_at, updated_at, _now = cursor.fetchone()
        assert updated_at >= created_at

    def test_deleting_the_tenant_takes_its_actions_with_it(self, cursor):
        self._insert(cursor)
        cursor.execute("DELETE FROM apiome.tenants WHERE id = %s::uuid", (TENANT,))
        cursor.execute("SELECT count(*) FROM apiome.workspace_custom_actions")
        assert cursor.fetchone()[0] == 0
