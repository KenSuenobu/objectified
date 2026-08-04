"""Domain summary against a real server — DUW-1.3 (private-suite#2570).

The unit suite (``test_workspace_summary_store.py``) pins the SQL and the projection. What it
cannot prove is the ticket's actual claim, which is about a *catalog*: that every badge equals what
``SELECT COUNT(*)`` says over the same folder, and that answering costs four statements and well
under 300 ms on the 218-path catalog the acceptance criteria name. That needs rows.

The seeded catalog is the mockup's tree, at the mockup's numbers — ``customers/ 3·4``,
``billing/ 5·9``, ``webhooks/ 2·3``, ``shared/ 8`` and ``0 ops`` — sitting next to a bulk folder
large enough that none of those numbers could come from a page. An empty folder is in there too:
one that vanished from the tree would make a newly created folder look like a failed write.

Marked ``requires_db`` and skipped without ``DATABASE_URL``. To run against an ephemeral server, no
installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_workspace_summary_db.py -m requires_db'

Everything happens inside a transaction that is always rolled back, so a live database is left
exactly as it was found — which is also why the prerequisite subset of the schema is created here
rather than assumed. V242 itself is applied rather than hand-written, so the ``domain_id`` columns
and their constraints are the real ones.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.workspace_summary_store import load_version_summary

MIGRATION = "apiome-db/scripts/V242__domain_model_for_schemas_and_paths_2568.sql"

_db_url = os.environ.get("DATABASE_URL")

pytestmark = [
    pytest.mark.requires_db,
    pytest.mark.skipif(
        not _db_url, reason="DATABASE_URL not set – skipping live-DB integration tests"
    ),
]

PROJECT = "00000000-0000-4000-8000-000000000001"
VERSION = "00000000-0000-4000-8000-0000000000a1"
OTHER_VERSION = "00000000-0000-4000-8000-0000000000a2"

CUSTOMERS_DOMAIN = "00000000-0000-4000-8000-0000000000b1"
BILLING_DOMAIN = "00000000-0000-4000-8000-0000000000b2"
WEBHOOKS_DOMAIN = "00000000-0000-4000-8000-0000000000b3"
BULK_DOMAIN = "00000000-0000-4000-8000-0000000000b4"
EMPTY_DOMAIN = "00000000-0000-4000-8000-0000000000b5"

#: The catalog size the acceptance criteria name.
CATALOG_PATHS = 218
CATALOG_CLASSES = 250

#: Paths belonging to a mockup folder; the rest pad ``bulk/``.
NAMED_PATHS = 7
BULK_PATHS = CATALOG_PATHS - NAMED_PATHS

#: Classes belonging to a mockup folder or to ``shared/``; the rest pad ``bulk/``.
NAMED_CLASSES = 20
BULK_CLASSES = CATALOG_CLASSES - NAMED_CLASSES

#: The ticket's latency budget, and how many samples it is judged over.
P95_BUDGET_MS = 300.0
LATENCY_SAMPLES = 20

#: The subset of the apiome schema a summary touches. Narrower than production — only the columns
#: :mod:`app.workspace_summary_store` selects — but the ``domain_id`` columns come from V242.
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
    description TEXT,
    schema JSONB DEFAULT '{}'::jsonb,
    enabled BOOLEAN DEFAULT TRUE,
    canvas_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT classes_version_name_unique UNIQUE (version_id, name)
);
-- Tags are read by nothing in this module. They exist because V242's class backfill files a class
-- under the domain its project tag slugifies to, and the migration is applied here rather than
-- hand-written, so the tables it touches have to be present.
CREATE TABLE apiome.tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES apiome.projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(50) DEFAULT 'default',
    description TEXT,
    CONSTRAINT tags_project_name_unique UNIQUE (project_id, name)
);
CREATE TABLE apiome.class_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES apiome.tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT class_tags_class_tag_unique UNIQUE (class_id, tag_id)
);
CREATE TABLE apiome.version_path (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES apiome.versions(id) ON DELETE CASCADE,
    pathname VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version_id, pathname)
);
CREATE TABLE apiome.path_operation (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version_path_id, operation)
);
CREATE TABLE apiome.path_operation_description (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    summary VARCHAR(4096),
    description TEXT,
    operation_id VARCHAR(255),
    metadata JSONB,
    UNIQUE (path_operation_id)
);
"""

#: The mockup's own catalog. Schema bodies are the real thing — an enum component keeps its ``enum``
#: array and a union its ``oneOf`` once ``properties``/``required`` are stripped into property rows
#: — because how a class is classified is read out of exactly that column.
_SEED = f"""
INSERT INTO apiome.projects (id, name) VALUES ('{PROJECT}'::uuid, 'Primary');
INSERT INTO apiome.versions (id, project_id, version_id) VALUES
  ('{VERSION}'::uuid, '{PROJECT}'::uuid, '2.1'),
  ('{OTHER_VERSION}'::uuid, '{PROJECT}'::uuid, '3.0');

-- customers/ — three objects and one enum, which is the mockup's `3 classes` above a list of four.
INSERT INTO apiome.classes (version_id, name, schema) VALUES
  ('{VERSION}'::uuid, 'Customer',      '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'Address',       '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'ContactMethod', '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'CountryCode',   '{{"type":"string","enum":["US","CA","MX"]}}'::jsonb);

-- billing/ — five objects.
INSERT INTO apiome.classes (version_id, name, schema)
SELECT '{VERSION}'::uuid, 'Billing' || i, '{{"type":"object"}}'::jsonb
  FROM generate_series(1, 5) AS i;

-- webhooks/ — two objects and one union, so `union` is classified apart from `enum`.
INSERT INTO apiome.classes (version_id, name, schema) VALUES
  ('{VERSION}'::uuid, 'WebhookDelivery', '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'WebhookAttempt',  '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'WebhookEvent',
   '{{"oneOf":[{{"$ref":"#/components/schemas/A"}},{{"$ref":"#/components/schemas/B"}}]}}'::jsonb);

-- shared/ — the eight the mockup badges, left with no domain.
INSERT INTO apiome.classes (version_id, name, schema)
SELECT '{VERSION}'::uuid, 'Shared' || i, '{{"type":"object"}}'::jsonb
  FROM generate_series(1, 8) AS i;

-- bulk/ — the rest of the 250. These exist to be counted and *not* listed.
INSERT INTO apiome.classes (version_id, name, schema)
SELECT '{VERSION}'::uuid, 'Bulk' || lpad(i::text, 4, '0'), '{{"type":"object"}}'::jsonb
  FROM generate_series(1, {BULK_CLASSES}) AS i;

-- Present in the table, absent from every count: a soft-deleted class and one in another version,
-- both named so they would be conspicuous if they leaked.
INSERT INTO apiome.classes (version_id, name, deleted_at) VALUES
  ('{VERSION}'::uuid, 'AbandonedCustomer', CURRENT_TIMESTAMP);
INSERT INTO apiome.classes (version_id, name) VALUES ('{OTHER_VERSION}'::uuid, 'Customer');

INSERT INTO apiome.version_path (version_id, pathname, metadata) VALUES
  ('{VERSION}'::uuid, '/v1/customers',      '{{"summary":"Customer collection"}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/customers/{{id}}','{{"summary":"One customer"}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/billing/invoices',      '{{}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/billing/invoices/{{id}}','{{}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/billing/coupons',       '{{}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/webhooks',              '{{}}'::jsonb),
  ('{VERSION}'::uuid, '/v1/webhooks/{{id}}',        '{{}}'::jsonb);

INSERT INTO apiome.version_path (version_id, pathname)
SELECT '{VERSION}'::uuid, '/v1/bulk/' || lpad(i::text, 4, '0')
  FROM generate_series(1, {BULK_PATHS}) AS i;

-- customers/ 4 ops. Inserted DELETE-first so the verb ordering is not insertion order either.
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['POST','GET']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/customers';
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['DELETE','GET']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/customers/{{id}}';

-- billing/ 9 ops across its three paths.
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['GET','POST','DELETE']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/billing/%';

-- webhooks/ 3 ops across its two paths.
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['GET','POST']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/webhooks';
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, 'GET' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/webhooks/{{id}}';

-- One operation apiece for the bulk paths, so the bulk folder's op count is not zero.
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, 'GET' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/bulk/%';

-- Only one operation carries a description row, so the LEFT JOIN has both cases to cover.
INSERT INTO apiome.path_operation_description (path_operation_id, operation_id, summary, metadata)
SELECT po.id, 'customers.list', 'List customers', '{{"deprecated": true}}'::jsonb
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
 WHERE vp.version_id = '{VERSION}'::uuid
   AND vp.pathname = '/v1/customers' AND po.operation = 'GET';
"""

#: Domains are assigned explicitly rather than left to V242's backfill: the backfill's heuristics
#: are DUW-1.1's behaviour and are tested there, and a summary test that depended on them would
#: fail for the wrong reason if they were ever tuned. Its output is therefore cleared first — a
#: hard delete, whose ``ON DELETE SET NULL`` releases every member back to ``shared/``.
_ASSIGN_DOMAINS = f"""
DELETE FROM apiome.domains WHERE version_id = '{VERSION}'::uuid;

INSERT INTO apiome.domains (id, version_id, name, slug, sort_order) VALUES
  ('{CUSTOMERS_DOMAIN}'::uuid, '{VERSION}'::uuid, 'customers', 'customers', 0),
  ('{BILLING_DOMAIN}'::uuid,   '{VERSION}'::uuid, 'billing',   'billing',   1),
  ('{WEBHOOKS_DOMAIN}'::uuid,  '{VERSION}'::uuid, 'webhooks',  'webhooks',  2),
  ('{BULK_DOMAIN}'::uuid,      '{VERSION}'::uuid, 'bulk',      'bulk',      3),
  ('{EMPTY_DOMAIN}'::uuid,     '{VERSION}'::uuid, 'archive',   'archive',   4);

UPDATE apiome.classes SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid
   AND name IN ('Customer', 'Address', 'ContactMethod', 'CountryCode');
UPDATE apiome.classes SET domain_id = '{BILLING_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name LIKE 'Billing%';
UPDATE apiome.classes SET domain_id = '{WEBHOOKS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name LIKE 'Webhook%';
UPDATE apiome.classes SET domain_id = '{BULK_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name LIKE 'Bulk%';

UPDATE apiome.version_path SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/customers%';
UPDATE apiome.version_path SET domain_id = '{BILLING_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/billing/%';
UPDATE apiome.version_path SET domain_id = '{WEBHOOKS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/webhooks%';
UPDATE apiome.version_path SET domain_id = '{BULK_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/bulk/%';

ANALYZE apiome.classes;
ANALYZE apiome.version_path;
ANALYZE apiome.path_operation;
"""


class CountingCursor:
    """A cursor that tallies every statement executed through it."""

    def __init__(self, cursor: Any, tally: List[str]) -> None:
        self._cursor = cursor
        self._tally = tally

    def execute(self, query: str, params: Any = None) -> Any:
        self._tally.append(" ".join(query.split()))
        return self._cursor.execute(query, params)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)

    def __enter__(self) -> "CountingCursor":
        self._cursor.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._cursor.__exit__(*exc)


class TransactionDb:
    """A ``_DbLike`` over one open transaction, counting statements.

    ``commit`` and ``rollback`` are no-ops: the store commits after every read (correctly — a bare
    SELECT still opens a transaction and holding it idle blocks VACUUM), but committing here would
    persist the seeded catalog into whatever cluster ``DATABASE_URL`` points at. That the store
    *does* commit is asserted against the fake connection in ``test_workspace_summary_store.py``,
    where it can be observed without writing anything anywhere.
    """

    def __init__(self, conn: Any) -> None:
        self._conn = conn
        self.statements: List[str] = []

    def connect(self) -> "TransactionDb":
        return self

    def cursor(self) -> CountingCursor:
        return CountingCursor(self._conn.cursor(), self.statements)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


@pytest.fixture
def catalog(repo_root: Path):
    """The mockup's tree inside a 218-path, 250-class catalog, rolled back when the test ends.

    Skips rather than colliding when ``DATABASE_URL`` already carries the real schema: building
    ``apiome.classes`` on top of a populated dev database would fail anyway, and half-running
    against real data is not what this suite is for.
    """
    psycopg2 = pytest.importorskip("psycopg2")
    from psycopg2.extras import RealDictCursor

    conn = psycopg2.connect(_db_url, cursor_factory=RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT to_regclass('apiome.classes') IS NOT NULL "
                "    OR to_regclass('apiome.domains') IS NOT NULL AS present"
            )
            if cursor.fetchone()["present"]:
                pytest.skip(
                    "DATABASE_URL already carries the apiome schema; point this suite at a "
                    "scratch cluster (see the module docstring's pg_virtualenv invocation)."
                )

            cursor.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
            try:
                cursor.execute("SELECT uuid_generate_v4()")
            except psycopg2.Error:
                conn.rollback()
                pytest.skip("uuid-ossp is not resolvable on this cluster; cannot apply V242.")

            cursor.execute(_PREREQUISITE_SCHEMA)
            cursor.execute(_SEED)
            cursor.execute((repo_root / MIGRATION).read_text())
            cursor.execute(_ASSIGN_DOMAINS)

        yield TransactionDb(conn)
    finally:
        conn.rollback()
        conn.close()


def summarize(catalog: TransactionDb, member_limit: int = 50) -> Dict[str, Dict[str, Any]]:
    """Summarize the seeded version, keyed by folder slug."""
    folders = load_version_summary(catalog, version_id=VERSION, member_limit=member_limit)
    return {folder["slug"]: folder for folder in folders}


def scalar(catalog: TransactionDb, query: str, params: tuple) -> int:
    """One count straight from SQL — the truth a badge is checked against."""
    with catalog.cursor() as cursor:
        cursor.execute(query, params)
        return int(cursor.fetchone()["n"])


class TestCatalogSize:
    """The fixture is only interesting if it is actually the size it claims."""

    def test_the_catalog_is_the_size_the_criteria_name(self, catalog):
        paths = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.version_path WHERE version_id = %s::uuid",
            (VERSION,),
        )
        classes = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.classes "
            " WHERE version_id = %s::uuid AND deleted_at IS NULL",
            (VERSION,),
        )

        assert (paths, classes) == (CATALOG_PATHS, CATALOG_CLASSES)


class TestAcceptanceCountsMatchSqlTruth:
    """"Counts match SQL truth." Every badge, checked against the query that defines it."""

    @pytest.mark.parametrize(
        "slug,domain_id",
        [
            ("customers", CUSTOMERS_DOMAIN),
            ("billing", BILLING_DOMAIN),
            ("webhooks", WEBHOOKS_DOMAIN),
            ("bulk", BULK_DOMAIN),
            ("archive", EMPTY_DOMAIN),
        ],
    )
    def test_a_folders_counts_equal_its_own_select_count(self, catalog, slug, domain_id):
        folder = summarize(catalog)[slug]

        members = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.classes "
            " WHERE version_id = %s::uuid AND deleted_at IS NULL AND domain_id = %s::uuid",
            (VERSION, domain_id),
        )
        paths = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.version_path "
            " WHERE version_id = %s::uuid AND domain_id = %s::uuid",
            (VERSION, domain_id),
        )
        ops = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.path_operation po "
            "  JOIN apiome.version_path vp ON vp.id = po.version_path_id "
            " WHERE vp.version_id = %s::uuid AND vp.domain_id = %s::uuid",
            (VERSION, domain_id),
        )

        assert folder["class_count"] + folder["enum_count"] == members
        assert folder["path_count"] == paths
        assert folder["op_count"] == ops

    def test_the_shared_bucket_counts_the_members_with_no_domain(self, catalog):
        shared = summarize(catalog)["shared"]

        members = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.classes "
            " WHERE version_id = %s::uuid AND deleted_at IS NULL AND domain_id IS NULL",
            (VERSION,),
        )

        assert shared["class_count"] + shared["enum_count"] == members
        assert shared["path_count"] == 0

    def test_a_soft_deleted_class_is_in_no_badge(self, catalog):
        folders = summarize(catalog)

        assert sum(f["class_count"] + f["enum_count"] for f in folders.values()) == CATALOG_CLASSES

    def test_another_versions_catalog_is_in_no_badge(self, catalog):
        # `OTHER_VERSION` holds a class named `Customer` too. A summary that dropped the version
        # predicate would badge `shared/` with it.
        folders = summarize(catalog)
        names = [row["name"] for row in folders["shared"]["classes"]]

        assert "Customer" not in names
        assert folders["shared"]["class_count"] == 8


class TestAcceptanceThreePanelsRender:
    """"The response renders all three mockup tree panels with zero additional requests."""

    def test_the_folder_badges_are_the_mockups_own_numbers(self, catalog):
        folders = summarize(catalog)

        assert (folders["customers"]["class_count"], folders["customers"]["op_count"]) == (3, 4)
        assert (folders["billing"]["class_count"], folders["billing"]["op_count"]) == (5, 9)
        assert (folders["webhooks"]["class_count"], folders["webhooks"]["op_count"]) == (2, 3)
        assert (folders["shared"]["class_count"], folders["shared"]["op_count"]) == (8, 0)

    def test_the_schemas_lens_gets_its_two_groups(self, catalog):
        customers = summarize(catalog)["customers"]
        by_kind = {row["name"]: row["kind"] for row in customers["classes"]}

        assert by_kind == {
            "Address": "object",
            "ContactMethod": "object",
            "Customer": "object",
            "CountryCode": "enum",
        }
        assert customers["enum_count"] == 1

    def test_a_union_is_classified_apart_from_an_enum(self, catalog):
        webhooks = summarize(catalog)["webhooks"]
        by_kind = {row["name"]: row["kind"] for row in webhooks["classes"]}

        assert by_kind["WebhookEvent"] == "union"
        assert webhooks["enum_count"] == 1

    def test_objects_are_listed_before_enums_and_unions(self, catalog):
        kinds = [row["kind"] for row in summarize(catalog)["customers"]["classes"]]

        assert kinds == sorted(kinds, key=lambda kind: kind != "object")

    def test_the_paths_lens_gets_its_verbs_in_method_order(self, catalog):
        paths = {p["pathname"]: p for p in summarize(catalog)["customers"]["paths"]}

        assert [op["operation"] for op in paths["/v1/customers"]["operations"]] == ["GET", "POST"]
        assert [op["operation"] for op in paths["/v1/customers/{id}"]["operations"]] == [
            "GET",
            "DELETE",
        ]

    def test_an_operation_carries_what_its_row_draws(self, catalog):
        paths = {p["pathname"]: p for p in summarize(catalog)["customers"]["paths"]}
        get = paths["/v1/customers"]["operations"][0]

        assert (get["operation_id"], get["summary"], get["deprecated"]) == (
            "customers.list",
            "List customers",
            True,
        )

    def test_an_operation_without_a_description_row_is_still_listed(self, catalog):
        paths = {p["pathname"]: p for p in summarize(catalog)["customers"]["paths"]}
        post = paths["/v1/customers"]["operations"][1]

        assert (post["operation_id"], post["summary"], post["deprecated"]) == (None, None, False)

    def test_a_per_path_count_agrees_with_its_own_operations(self, catalog):
        for folder in summarize(catalog).values():
            for path in folder["paths"]:
                assert path["op_count"] == len(path["operations"])

    def test_an_empty_folder_is_in_the_tree_with_zeroes(self, catalog):
        archive = summarize(catalog)["archive"]

        assert archive["class_count"] == archive["path_count"] == archive["op_count"] == 0
        assert archive["classes"] == archive["paths"] == []
        assert archive["classes_truncated"] is False

    def test_the_shared_bucket_sorts_last_and_carries_no_id(self, catalog):
        folders = load_version_summary(catalog, version_id=VERSION, member_limit=50)

        assert [f["slug"] for f in folders] == [
            "customers",
            "billing",
            "webhooks",
            "bulk",
            "archive",
            "shared",
        ]
        assert folders[-1]["id"] is None and folders[-1]["virtual"] is True


class TestBoundedness:
    """A summary is a tree, not a catalog: the badges are exhaustive, the lists are not."""

    def test_a_large_folder_is_capped_and_says_so(self, catalog):
        bulk = summarize(catalog, member_limit=10)["bulk"]

        assert len(bulk["classes"]) == 10
        assert bulk["class_count"] == BULK_CLASSES
        assert bulk["classes_truncated"] is True
        assert len(bulk["paths"]) == 10
        assert bulk["paths_truncated"] is True

    def test_a_small_folder_beside_it_is_complete(self, catalog):
        customers = summarize(catalog, member_limit=10)["customers"]

        assert len(customers["classes"]) == 4
        assert customers["classes_truncated"] is False
        assert customers["paths_truncated"] is False

    def test_badges_do_not_move_with_the_member_limit(self, catalog):
        def badges(limit: int):
            return {
                slug: (f["class_count"], f["enum_count"], f["path_count"], f["op_count"])
                for slug, f in summarize(catalog, member_limit=limit).items()
            }

        assert badges(0) == badges(5) == badges(200)

    def test_zero_returns_badges_without_members(self, catalog):
        folders = summarize(catalog, member_limit=0)

        assert all(f["classes"] == [] and f["paths"] == [] for f in folders.values())
        assert folders["customers"]["class_count"] == 3

    def test_the_cap_is_per_folder_not_per_response(self, catalog):
        # Two folders of five each under a limit of five is ten rows, not five: the tree expands
        # folders independently, so a global cap would starve whichever sorted last.
        folders = summarize(catalog, member_limit=5)

        assert len(folders["billing"]["classes"]) == 5
        assert len(folders["customers"]["classes"]) == 4


class TestAcceptanceCost:
    """"p95 < 300 ms on the 218-path catalog" — and the shape that keeps it there."""

    def test_a_summary_of_the_whole_catalog_is_four_statements(self, catalog):
        # An N+1 over folders would show up here as 2 + 2×len(domains).
        summarize(catalog)

        assert len(catalog.statements) == 4

    def test_six_folders_cost_what_one_would(self, catalog):
        before = len(catalog.statements)
        summarize(catalog, member_limit=200)

        assert len(catalog.statements) - before == 4

    def test_p95_is_inside_the_budget(self, catalog):
        samples = []
        for _ in range(LATENCY_SAMPLES):
            started = time.perf_counter()
            load_version_summary(catalog, version_id=VERSION, member_limit=50)
            samples.append((time.perf_counter() - started) * 1000.0)

        samples.sort()
        p95 = samples[int(round(0.95 * (len(samples) - 1)))]

        assert p95 < P95_BUDGET_MS, f"p95 {p95:.1f} ms over the {P95_BUDGET_MS:.0f} ms budget"
