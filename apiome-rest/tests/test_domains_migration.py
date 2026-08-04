"""Structural and live guarantees of V242 — the domain model (DUW-1.1, private-suite#2568).

Two layers, because they fail differently.

:class:`TestMigrationText` reads the SQL and pins the shape of it. It runs everywhere, needs no
server, and catches an edit that quietly drops a constraint.

:class:`TestLiveSchema` applies the migration to a real Postgres and exercises what the text cannot
prove: that the CHECKs reject what they claim to, that the membership guard actually fires, that a
soft delete really does release its members, and that the backfill sorts a realistic catalog into
the folders the mockup shows. These are marked ``requires_db`` and skip without ``DATABASE_URL``.

To run them against an ephemeral server, no installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_domains_migration.py -m requires_db'

The migration is applied inside a transaction that is always rolled back, so a live database is
left exactly as it was found — which is also why the whole prerequisite subset of the schema is
created here rather than assumed: the test must work on an empty database as readily as on a
migrated one.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List, Optional

import pytest

MIGRATION = "apiome-db/scripts/V242__domain_model_for_schemas_and_paths_2568.sql"

_db_url = os.environ.get("DATABASE_URL")

#: The registered ``requires_db`` marker, so ``-m requires_db`` selects these — which is what
#: pyproject documents the marker for.
_requires_db = pytest.mark.requires_db

#: Applied alongside it so a normal run without a server skips rather than errors. These must be
#: two stacked decorators: passing one mark as an argument to another does not compose them, it
#: just hands the mark object over as a parameter and the skip silently never applies.
_skip_without_db = pytest.mark.skipif(
    not _db_url,
    reason="DATABASE_URL not set – skipping live-DB integration tests",
)

#: The subset of the apiome schema V242 depends on. Created in the test transaction under a private
#: schema name so a live database's real tables are never touched.
_PREREQUISITE_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS apiome;

CREATE TABLE apiome.projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);
CREATE TABLE apiome.versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES apiome.projects(id) ON DELETE CASCADE,
    version_id VARCHAR(255) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE apiome.classes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES apiome.versions(id),
    name VARCHAR(255) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT classes_version_name_unique UNIQUE (version_id, name)
);
CREATE TABLE apiome.version_path (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES apiome.versions(id) ON DELETE CASCADE,
    pathname VARCHAR(255) NOT NULL,
    UNIQUE (version_id, pathname)
);
CREATE TABLE apiome.tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES apiome.projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    CONSTRAINT tags_project_name_unique UNIQUE (project_id, name)
);
CREATE TABLE apiome.class_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES apiome.tags(id) ON DELETE CASCADE,
    CONSTRAINT class_tags_class_tag_unique UNIQUE (class_id, tag_id)
);
"""

PROJECT = "00000000-0000-4000-8000-000000000001"
OTHER_PROJECT = "00000000-0000-4000-8000-000000000002"
VERSION = "00000000-0000-4000-8000-0000000000a1"
OTHER_VERSION = "00000000-0000-4000-8000-0000000000a2"

#: A catalog shaped like the ones the backfill has to cope with: a version prefix on every path
#: (the `Apiome REST API` catalog's `/v1/…`), templated segments, mixed case, punctuation, a
#: literal `shared` segment, and paths with no groupable segment at all.
_SEED = f"""
INSERT INTO apiome.projects (id, name) VALUES
  ('{PROJECT}'::uuid, 'Primary'), ('{OTHER_PROJECT}'::uuid, 'Other');
INSERT INTO apiome.versions (id, project_id, version_id) VALUES
  ('{VERSION}'::uuid, '{PROJECT}'::uuid, '1.0.0'),
  ('{OTHER_VERSION}'::uuid, '{OTHER_PROJECT}'::uuid, '1.0.0');

INSERT INTO apiome.version_path (version_id, pathname) VALUES
  ('{VERSION}'::uuid, '/v1/customers'),
  ('{VERSION}'::uuid, '/v1/customers/{{customerId}}'),
  ('{VERSION}'::uuid, '/v1/customers/{{customerId}}/addresses'),
  ('{VERSION}'::uuid, '/v2/billing/invoices'),
  ('{VERSION}'::uuid, '/Webhooks/Events'),
  ('{VERSION}'::uuid, '/v1/user_profiles/list'),
  ('{VERSION}'::uuid, '/v1/{{tenantId}}'),
  ('{VERSION}'::uuid, '/'),
  ('{VERSION}'::uuid, '/v1/shared/health'),
  ('{OTHER_VERSION}'::uuid, '/v1/billing/plans');

INSERT INTO apiome.tags (id, project_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000d1'::uuid, '{PROJECT}'::uuid, 'Customers'),
  ('00000000-0000-4000-8000-0000000000d2'::uuid, '{PROJECT}'::uuid, 'billing'),
  ('00000000-0000-4000-8000-0000000000d3'::uuid, '{PROJECT}'::uuid, 'internal'),
  ('00000000-0000-4000-8000-0000000000d4'::uuid, '{OTHER_PROJECT}'::uuid, 'customers');

INSERT INTO apiome.classes (id, version_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000e1'::uuid, '{VERSION}'::uuid, 'Customer'),
  ('00000000-0000-4000-8000-0000000000e2'::uuid, '{VERSION}'::uuid, 'Invoice'),
  ('00000000-0000-4000-8000-0000000000e3'::uuid, '{VERSION}'::uuid, 'Ledger'),
  ('00000000-0000-4000-8000-0000000000e4'::uuid, '{VERSION}'::uuid, 'AuditEntry'),
  ('00000000-0000-4000-8000-0000000000e5'::uuid, '{VERSION}'::uuid, 'Address'),
  ('00000000-0000-4000-8000-0000000000e6'::uuid, '{OTHER_VERSION}'::uuid, 'Customer');

INSERT INTO apiome.class_tags (class_id, tag_id) VALUES
  ('00000000-0000-4000-8000-0000000000e1'::uuid, '00000000-0000-4000-8000-0000000000d1'::uuid),
  ('00000000-0000-4000-8000-0000000000e2'::uuid, '00000000-0000-4000-8000-0000000000d2'::uuid),
  ('00000000-0000-4000-8000-0000000000e3'::uuid, '00000000-0000-4000-8000-0000000000d1'::uuid),
  ('00000000-0000-4000-8000-0000000000e3'::uuid, '00000000-0000-4000-8000-0000000000d2'::uuid),
  ('00000000-0000-4000-8000-0000000000e4'::uuid, '00000000-0000-4000-8000-0000000000d3'::uuid),
  ('00000000-0000-4000-8000-0000000000e6'::uuid, '00000000-0000-4000-8000-0000000000d4'::uuid);
"""


@pytest.fixture
def sql(repo_root: Path) -> str:
    return (repo_root / MIGRATION).read_text()


class TestMigrationText:
    """What the migration file must say. Runs without a server."""

    def test_it_lands_in_the_apiome_schema(self, sql: str) -> None:
        assert "SET search_path TO apiome, public;" in sql
        assert "CREATE TABLE IF NOT EXISTS apiome.domains" in sql

    def test_the_shared_slug_is_reserved(self, sql: str) -> None:
        # `shared/` is the derived bucket for domain_id IS NULL. A row taking the slug would put
        # two different memberships behind one folder.
        assert "CONSTRAINT domains_slug_not_reserved CHECK (slug <> 'shared')" in sql

    def test_the_slug_format_is_constrained(self, sql: str) -> None:
        assert "CONSTRAINT domains_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')" in sql

    def test_membership_columns_are_nullable_and_never_cascade(self, sql: str) -> None:
        # NULL *is* the shared/ membership, and a hard delete must degrade to "moved to shared/"
        # rather than taking the catalog content with it.
        for table in ("apiome.classes", "apiome.version_path"):
            assert (
                f"ALTER TABLE {table}\n    ADD COLUMN IF NOT EXISTS domain_id UUID "
                "REFERENCES apiome.domains(id) ON DELETE SET NULL"
            ) in sql
        assert "ON DELETE CASCADE" not in sql.split("ADD COLUMN IF NOT EXISTS domain_id")[1]

    def test_uniqueness_applies_only_to_live_domains(self, sql: str) -> None:
        # Partial, so deleting `billing/` frees the name for a later one.
        assert (
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_version_slug\n"
            "    ON apiome.domains (version_id, slug) WHERE deleted_at IS NULL"
        ) in sql
        assert (
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_version_name\n"
            "    ON apiome.domains (version_id, lower(name)) WHERE deleted_at IS NULL"
        ) in sql

    def test_the_membership_guard_exists_on_both_member_tables(self, sql: str) -> None:
        assert "CREATE OR REPLACE FUNCTION apiome.domain_membership_version_guard()" in sql
        assert "trg_classes_domain_version_guard" in sql
        assert "trg_version_path_domain_version_guard" in sql
        # Restricted to the columns that can break the invariant, so ordinary edits stay cheap.
        assert "BEFORE INSERT OR UPDATE OF domain_id, version_id ON apiome.classes" in sql
        assert "BEFORE INSERT OR UPDATE OF domain_id, version_id ON apiome.version_path" in sql

    def test_a_soft_delete_releases_members(self, sql: str) -> None:
        assert "CREATE OR REPLACE FUNCTION apiome.domain_soft_delete_release()" in sql
        assert "AFTER UPDATE OF deleted_at ON apiome.domains" in sql
        assert "UPDATE apiome.classes      SET domain_id = NULL WHERE domain_id = NEW.id;" in sql
        assert "UPDATE apiome.version_path SET domain_id = NULL WHERE domain_id = NEW.id;" in sql

    def test_the_backfill_skips_version_prefixes_and_templates(self, sql: str) -> None:
        assert "CONTINUE WHEN v_segment LIKE '{%';" in sql
        assert "CONTINUE WHEN v_segment ~ '^v[0-9]+$';" in sql

    def test_class_backfill_is_project_scoped_and_deterministic(self, sql: str) -> None:
        # apiome.tags is project-scoped; without this join another project's `billing` tag would
        # file this project's classes.
        assert "WHERE v.project_id = t.project_id" in sql
        assert "SELECT DISTINCT ON (ct.class_id)" in sql
        assert "ORDER BY ct.class_id, d.sort_order, d.slug" in sql

    def test_the_backfill_helpers_do_not_outlive_the_migration(self, sql: str) -> None:
        assert "DROP FUNCTION IF EXISTS apiome.duw2568_domain_segment(TEXT);" in sql
        assert "DROP FUNCTION IF EXISTS apiome.duw2568_slugify(TEXT);" in sql

    def test_it_documents_its_rollback(self, sql: str) -> None:
        assert "Rollback notes" in sql
        assert "DROP TABLE IF EXISTS apiome.domains;" in sql


@_requires_db
@_skip_without_db
class TestLiveSchema:
    """What the database actually enforces. Requires DATABASE_URL; see the module docstring."""

    @pytest.fixture
    def cur(self, repo_root: Path):
        """A cursor on a schema built from scratch, rolled back when the test ends.

        Builds the prerequisite tables itself, so it needs a *scratch* cluster. If ``DATABASE_URL``
        points at a database that already carries the real schema, the fixture skips rather than
        colliding with it — creating ``apiome.classes`` on top of a populated dev database would
        fail anyway, and half-running against real data is not what this test is for.
        """
        psycopg2 = pytest.importorskip("psycopg2")
        conn = psycopg2.connect(_db_url)
        conn.autocommit = False
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT to_regclass('apiome.classes') IS NOT NULL "
                    "    OR to_regclass('apiome.domains') IS NOT NULL"
                )
                if cursor.fetchone()[0]:
                    pytest.skip(
                        "DATABASE_URL already carries the apiome schema; point this suite at a "
                        "scratch cluster (see the module docstring's pg_virtualenv invocation)."
                    )

                # uuid_generate_v4() is V242's default for domains.id, so the migration cannot be
                # applied without it. Resolve it before building anything, and say so plainly if
                # the cluster cannot provide it rather than failing later inside the migration.
                cursor.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
                try:
                    cursor.execute("SELECT uuid_generate_v4()")
                except psycopg2.Error:
                    conn.rollback()
                    pytest.skip("uuid-ossp is not resolvable on this cluster; cannot apply V242.")

                cursor.execute(_PREREQUISITE_SCHEMA)
                cursor.execute(_SEED)
                cursor.execute((repo_root / MIGRATION).read_text())
                yield cursor
        finally:
            conn.rollback()
            conn.close()

    @staticmethod
    def _fails(cur, statement: str, params: Optional[tuple] = None) -> str:
        """Assert a statement is rejected, and return the error. Uses a savepoint so the aborted
        transaction does not poison the rest of the test."""
        cur.execute("SAVEPOINT probe")
        try:
            cur.execute(statement, params)
        except Exception as exc:  # noqa: BLE001 - the rejection is the assertion
            cur.execute("ROLLBACK TO SAVEPOINT probe")
            return str(exc)
        cur.execute("ROLLBACK TO SAVEPOINT probe")
        pytest.fail(f"Statement was accepted but should have been rejected: {statement}")

    @staticmethod
    def _scalar(cur, query: str, params: Optional[tuple] = None) -> Any:
        cur.execute(query, params)
        row = cur.fetchone()
        return row[0] if row else None

    @staticmethod
    def _column(cur, query: str, params: Optional[tuple] = None) -> List[Any]:
        cur.execute(query, params)
        return [r[0] for r in cur.fetchall()]

    # ─── Backfill ────────────────────────────────────────────────────────────

    def test_domains_are_seeded_from_the_first_meaningful_path_segment(self, cur) -> None:
        slugs = self._column(
            cur,
            "SELECT slug FROM apiome.domains WHERE version_id = %s::uuid ORDER BY sort_order",
            (VERSION,),
        )
        # `/v1/` and `/{tenantId}` name no folder; `user_profiles` slugifies; `Webhooks` folds.
        assert slugs == ["billing", "customers", "user-profiles", "webhooks"]

    def test_a_literal_shared_segment_never_becomes_a_row(self, cur) -> None:
        assert self._scalar(cur, "SELECT count(*) FROM apiome.domains WHERE slug = 'shared'") == 0
        assert (
            self._scalar(
                cur,
                "SELECT domain_id FROM apiome.version_path WHERE pathname = '/v1/shared/health'",
            )
            is None
        )

    def test_seeded_domains_do_not_span_versions(self, cur) -> None:
        # Both versions have a `billing`; they must be two distinct rows.
        ids = self._column(cur, "SELECT id FROM apiome.domains WHERE slug = 'billing'")
        assert len(ids) == 2
        assert len(set(ids)) == 2

    def test_every_path_resolves_to_exactly_one_domain_or_shared(self, cur) -> None:
        # The ticket's first acceptance criterion, asserted as an absence: no path is unaccounted
        # for, and none can be in two folders because domain_id is a single column.
        placement = dict(
            self._column_pairs(
                cur,
                """
                SELECT vp.pathname, COALESCE(d.slug, 'shared')
                  FROM apiome.version_path vp
             LEFT JOIN apiome.domains d ON d.id = vp.domain_id
                 WHERE vp.version_id = %s::uuid
                """,
                (VERSION,),
            )
        )
        assert placement == {
            "/v1/customers": "customers",
            "/v1/customers/{customerId}": "customers",
            "/v1/customers/{customerId}/addresses": "customers",
            "/v2/billing/invoices": "billing",
            "/Webhooks/Events": "webhooks",
            "/v1/user_profiles/list": "user-profiles",
            "/v1/{tenantId}": "shared",
            "/": "shared",
            "/v1/shared/health": "shared",
        }

    def test_classes_follow_their_tags_into_domains(self, cur) -> None:
        placement = dict(
            self._column_pairs(
                cur,
                """
                SELECT c.name, COALESCE(d.slug, 'shared')
                  FROM apiome.classes c
             LEFT JOIN apiome.domains d ON d.id = c.domain_id
                 WHERE c.version_id = %s::uuid
                """,
                (VERSION,),
            )
        )
        assert placement == {
            "Customer": "customers",  # tag `Customers` folds to the `customers` domain
            "Invoice": "billing",
            "Ledger": "billing",  # two matching tags: lowest sort_order wins, deterministically
            "AuditEntry": "shared",  # tag `internal` matches no domain
            "Address": "shared",  # no tags at all
        }

    def test_a_tag_from_another_project_never_files_a_class(self, cur) -> None:
        # Both projects have a `customers` tag. Project 2 has no `customers` domain, so its class
        # must land in shared/ rather than in project 1's folder.
        assert (
            self._scalar(
                cur,
                "SELECT domain_id FROM apiome.classes WHERE version_id = %s::uuid",
                (OTHER_VERSION,),
            )
            is None
        )

    # ─── Constraints ─────────────────────────────────────────────────────────

    def test_the_reserved_slug_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, 'Shared', 'shared')",
            (VERSION,),
        )
        assert "domains_slug_not_reserved" in error

    @pytest.mark.parametrize("slug", ["Customers", "under_score", "-leading", "trailing-", "a b", ""])
    def test_malformed_slugs_are_rejected(self, cur, slug: str) -> None:
        error = self._fails(
            cur,
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, 'Any', %s)",
            (VERSION, slug),
        )
        assert "domains_slug_format" in error

    def test_a_blank_name_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, '   ', 'ok')",
            (VERSION,),
        )
        assert "domains_name_not_blank" in error

    def test_a_duplicate_live_slug_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, 'Billing 2', 'billing')",
            (VERSION,),
        )
        assert "uq_domains_version_slug" in error

    def test_a_duplicate_name_differing_only_in_case_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, 'BILLING', 'billing-two')",
            (VERSION,),
        )
        assert "uq_domains_version_name" in error

    def test_a_slug_is_reusable_after_a_soft_delete(self, cur) -> None:
        cur.execute(
            "UPDATE apiome.domains SET deleted_at = now() WHERE slug = 'billing' AND version_id = %s::uuid",
            (VERSION,),
        )
        cur.execute(
            "INSERT INTO apiome.domains (version_id, name, slug) VALUES (%s::uuid, 'billing', 'billing')",
            (VERSION,),
        )
        assert (
            self._scalar(
                cur,
                "SELECT count(*) FROM apiome.domains WHERE slug = 'billing' AND version_id = %s::uuid",
                (VERSION,),
            )
            == 2
        )

    # ─── Membership guard ────────────────────────────────────────────────────

    def test_a_cross_version_assignment_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            """
            UPDATE apiome.classes SET domain_id =
                (SELECT id FROM apiome.domains WHERE version_id = %s::uuid LIMIT 1)
             WHERE version_id = %s::uuid AND name = 'Address'
            """,
            (OTHER_VERSION, VERSION),
        )
        assert "belongs to version" in error

    def test_a_cross_version_path_assignment_is_rejected(self, cur) -> None:
        error = self._fails(
            cur,
            """
            UPDATE apiome.version_path SET domain_id =
                (SELECT id FROM apiome.domains WHERE version_id = %s::uuid LIMIT 1)
             WHERE version_id = %s::uuid AND pathname = '/'
            """,
            (OTHER_VERSION, VERSION),
        )
        assert "belongs to version" in error

    def test_assigning_to_a_soft_deleted_domain_is_rejected(self, cur) -> None:
        cur.execute(
            "UPDATE apiome.domains SET deleted_at = now() WHERE slug = 'customers' AND version_id = %s::uuid",
            (VERSION,),
        )
        error = self._fails(
            cur,
            """
            UPDATE apiome.classes SET domain_id =
                (SELECT id FROM apiome.domains WHERE slug = 'customers' AND version_id = %s::uuid)
             WHERE version_id = %s::uuid AND name = 'Address'
            """,
            (VERSION, VERSION),
        )
        assert "does not exist or has been deleted" in error

    def test_assigning_null_is_always_legal(self, cur) -> None:
        cur.execute(
            "UPDATE apiome.classes SET domain_id = NULL WHERE version_id = %s::uuid", (VERSION,)
        )
        assert (
            self._scalar(
                cur,
                "SELECT count(*) FROM apiome.classes WHERE version_id = %s::uuid AND domain_id IS NULL",
                (VERSION,),
            )
            == 5
        )

    # ─── Delete never loses content ──────────────────────────────────────────

    def test_a_soft_delete_releases_members_and_keeps_them(self, cur) -> None:
        before_classes = self._scalar(
            cur, "SELECT count(*) FROM apiome.classes WHERE version_id = %s::uuid", (VERSION,)
        )
        before_paths = self._scalar(
            cur, "SELECT count(*) FROM apiome.version_path WHERE version_id = %s::uuid", (VERSION,)
        )
        domain_id = self._scalar(
            cur,
            "SELECT id FROM apiome.domains WHERE slug = 'customers' AND version_id = %s::uuid",
            (VERSION,),
        )
        assert self._scalar(
            cur, "SELECT count(*) FROM apiome.version_path WHERE domain_id = %s", (domain_id,)
        ) == 3

        cur.execute("UPDATE apiome.domains SET deleted_at = now() WHERE id = %s", (domain_id,))

        # Members released...
        assert self._scalar(
            cur, "SELECT count(*) FROM apiome.version_path WHERE domain_id = %s", (domain_id,)
        ) == 0
        assert self._scalar(
            cur, "SELECT count(*) FROM apiome.classes WHERE domain_id = %s", (domain_id,)
        ) == 0
        # ...and still present.
        assert (
            self._scalar(
                cur, "SELECT count(*) FROM apiome.classes WHERE version_id = %s::uuid", (VERSION,)
            )
            == before_classes
        )
        assert (
            self._scalar(
                cur,
                "SELECT count(*) FROM apiome.version_path WHERE version_id = %s::uuid",
                (VERSION,),
            )
            == before_paths
        )

    def test_a_hard_delete_also_keeps_content(self, cur) -> None:
        before = self._scalar(
            cur, "SELECT count(*) FROM apiome.classes WHERE version_id = %s::uuid", (VERSION,)
        )
        cur.execute(
            "DELETE FROM apiome.domains WHERE slug = 'customers' AND version_id = %s::uuid",
            (VERSION,),
        )
        assert (
            self._scalar(
                cur, "SELECT count(*) FROM apiome.classes WHERE version_id = %s::uuid", (VERSION,)
            )
            == before
        )

    # ─── Helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _column_pairs(cur, query: str, params: Optional[tuple] = None) -> List[tuple]:
        cur.execute(query, params)
        return [(r[0], r[1]) for r in cur.fetchall()]
