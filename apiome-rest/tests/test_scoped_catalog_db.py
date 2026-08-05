"""Selection-scoped catalog reads against a real server — DUW-1.2 (private-suite#2569).

The unit suites (``test_scoped_catalog_store.py``, ``test_scoped_catalog_routes.py``) pin the SQL
and the route contract. What they cannot prove is the ticket's actual claim, which is about a
*catalog*: that asking for three classes returns three classes and does three queries whatever the
version holds. That needs rows, so this suite builds the 218-path catalog the acceptance criteria
name and runs the store against it.

Marked ``requires_db`` and skipped without ``DATABASE_URL``. To run against an ephemeral server, no
installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_scoped_catalog_db.py -m requires_db'

Everything happens inside a transaction that is always rolled back, so a live database is left
exactly as it was found — which is also why the prerequisite subset of the schema is created here
rather than assumed. V242 itself is applied rather than hand-written, so the ``domain_id`` columns
and their constraints are the real ones.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List

import pytest

from app.scoped_catalog_store import (
    load_classes_by_domain,
    load_classes_by_ids,
    load_paths_by_domain,
    load_paths_by_ids,
)

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

#: The three classes the first acceptance criterion asks for by id.
ADDRESS = "00000000-0000-4000-8000-0000000000e1"
CUSTOMER = "00000000-0000-4000-8000-0000000000e2"
ORDER = "00000000-0000-4000-8000-0000000000e3"
DELETED_CLASS = "00000000-0000-4000-8000-0000000000e4"

CUSTOMERS_PATH = "00000000-0000-4000-8000-0000000000f1"
CUSTOMER_PATH = "00000000-0000-4000-8000-0000000000f2"

#: How many paths the seeded catalog holds — the size the acceptance criteria name, and the size
#: the answer to a three-id request must be independent of.
CATALOG_PATHS = 218

#: How many classes it holds. Larger than the path count on purpose: a catalog whose classes
#: outnumber its paths is the shape that makes the legacy full-version read expensive.
CATALOG_CLASSES = 250

#: Bulk classes filed under ``billing/`` — the ones named ``Bulk0001``…``Bulk0099``. Big enough
#: that a default page cannot hold the folder.
BILLING_CLASSES = 99

#: Everything else: neither one of the three named classes nor a ``billing/`` member.
SHARED_CLASSES = CATALOG_CLASSES - 3 - BILLING_CLASSES

#: The subset of the apiome schema these reads touch. Narrower than production — only the columns
#: :mod:`app.scoped_catalog_store` selects — but the ``domain_id`` columns come from V242 itself.
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
CREATE TABLE apiome.properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    data JSONB DEFAULT '{}'::jsonb
);
CREATE TABLE apiome.class_properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    property_id UUID REFERENCES apiome.properties(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    parent_id UUID REFERENCES apiome.class_properties(id) ON DELETE CASCADE,
    primitive_id UUID,
    primitive_ref VARCHAR(255)
);
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
CREATE TABLE apiome.shared_path_response (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    status_code VARCHAR(10) NOT NULL,
    description TEXT,
    UNIQUE (version_path_id, status_code)
);
CREATE TABLE apiome.path_operation_response_link (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    shared_path_response_id UUID NOT NULL
        REFERENCES apiome.shared_path_response(id) ON DELETE CASCADE,
    metadata JSONB,
    UNIQUE (path_operation_id, shared_path_response_id)
);
"""

#: A catalog of the size the acceptance criteria name. The bulk rows exist to be *not* returned:
#: every assertion below about a three-id request is only meaningful because 247 other classes and
#: 216 other paths are sitting next to them.
_SEED = f"""
INSERT INTO apiome.projects (id, name) VALUES ('{PROJECT}'::uuid, 'Primary');
INSERT INTO apiome.versions (id, project_id, version_id) VALUES
  ('{VERSION}'::uuid, '{PROJECT}'::uuid, '1.0.0'),
  ('{OTHER_VERSION}'::uuid, '{PROJECT}'::uuid, '2.0.0');

-- Named classes, deliberately inserted out of alphabetical order so a stable ORDER BY is doing
-- real work rather than echoing insertion order.
INSERT INTO apiome.classes (id, version_id, name, description) VALUES
  ('{ORDER}'::uuid,    '{VERSION}'::uuid, 'Order',   'An order'),
  ('{CUSTOMER}'::uuid, '{VERSION}'::uuid, 'Customer','A customer'),
  ('{ADDRESS}'::uuid,  '{VERSION}'::uuid, 'Address', 'A postal address');

-- Soft-deleted: present in the table, absent from every read.
INSERT INTO apiome.classes (id, version_id, name, deleted_at) VALUES
  ('{DELETED_CLASS}'::uuid, '{VERSION}'::uuid, 'Abandoned', CURRENT_TIMESTAMP);

INSERT INTO apiome.classes (version_id, name)
SELECT '{VERSION}'::uuid, 'Bulk' || lpad(i::text, 4, '0')
  FROM generate_series(1, {CATALOG_CLASSES - 3}) AS i;

-- One class in another version carrying the same shape, so "scoped by version" has something to
-- fail against.
INSERT INTO apiome.classes (version_id, name) VALUES ('{OTHER_VERSION}'::uuid, 'Customer');

INSERT INTO apiome.properties (id, name, data) VALUES
  ('00000000-0000-4000-8000-0000000000c1'::uuid, 'uuid', '{{"type":"string"}}'::jsonb);

INSERT INTO apiome.class_properties (class_id, property_id, name, data) VALUES
  ('{CUSTOMER}'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid, 'id',   '{{"type":"string"}}'::jsonb),
  ('{CUSTOMER}'::uuid, NULL, 'name',  '{{"type":"string"}}'::jsonb),
  ('{CUSTOMER}'::uuid, NULL, 'email', '{{"type":"string"}}'::jsonb),
  ('{ADDRESS}'::uuid,  NULL, 'street','{{"type":"string"}}'::jsonb);

-- Every bulk class gets a property too, so a leaking WHERE clause shows up as extra properties
-- rather than as nothing at all.
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT c.id, 'filler', '{{"type":"string"}}'::jsonb
  FROM apiome.classes c
 WHERE c.version_id = '{VERSION}'::uuid AND c.name LIKE 'Bulk%';

INSERT INTO apiome.tags (id, project_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000d1'::uuid, '{PROJECT}'::uuid, 'core');
INSERT INTO apiome.class_tags (class_id, tag_id) VALUES
  ('{CUSTOMER}'::uuid, '00000000-0000-4000-8000-0000000000d1'::uuid);

INSERT INTO apiome.version_path (id, version_id, pathname, metadata) VALUES
  ('{CUSTOMER_PATH}'::uuid,  '{VERSION}'::uuid, '/v1/customers/{{customerId}}',
   '{{"summary":"One customer"}}'::jsonb),
  ('{CUSTOMERS_PATH}'::uuid, '{VERSION}'::uuid, '/v1/customers',
   '{{"summary":"Customer collection"}}'::jsonb);

INSERT INTO apiome.version_path (version_id, pathname)
SELECT '{VERSION}'::uuid, '/v1/bulk/' || lpad(i::text, 4, '0')
  FROM generate_series(1, {CATALOG_PATHS - 2}) AS i;

-- Inserted DELETE-first so the HTTP-method ordering is not insertion order either.
INSERT INTO apiome.path_operation (id, version_path_id, operation) VALUES
  ('00000000-0000-4000-8000-00000000aa03'::uuid, '{CUSTOMERS_PATH}'::uuid, 'DELETE'),
  ('00000000-0000-4000-8000-00000000aa02'::uuid, '{CUSTOMERS_PATH}'::uuid, 'POST'),
  ('00000000-0000-4000-8000-00000000aa01'::uuid, '{CUSTOMERS_PATH}'::uuid, 'GET');

INSERT INTO apiome.path_operation (id, version_path_id, operation) VALUES
  ('00000000-0000-4000-8000-00000000aa04'::uuid, '{CUSTOMER_PATH}'::uuid, 'GET');

INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, 'GET' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/bulk/%';

-- Only one operation carries a description row, so the LEFT JOIN has both cases to cover.
INSERT INTO apiome.path_operation_description (path_operation_id, operation_id, summary, metadata)
VALUES ('00000000-0000-4000-8000-00000000aa01'::uuid, 'listCustomers', 'List customers',
        '{{"deprecated": true}}'::jsonb);

-- Responses are shared per *path* and linked per *operation*, which is the whole reason the lane's
-- codes cannot be read off the path: every code below belongs to `/v1/customers`, and no operation
-- declares all of them. DELETE is linked to none, so the empty case is seeded rather than assumed.
INSERT INTO apiome.shared_path_response (id, version_path_id, status_code) VALUES
  ('00000000-0000-4000-8000-00000000bb01'::uuid, '{CUSTOMERS_PATH}'::uuid, '200'),
  ('00000000-0000-4000-8000-00000000bb02'::uuid, '{CUSTOMERS_PATH}'::uuid, '400'),
  ('00000000-0000-4000-8000-00000000bb03'::uuid, '{CUSTOMERS_PATH}'::uuid, '401'),
  ('00000000-0000-4000-8000-00000000bb04'::uuid, '{CUSTOMERS_PATH}'::uuid, '201'),
  ('00000000-0000-4000-8000-00000000bb05'::uuid, '{CUSTOMERS_PATH}'::uuid, 'default'),
  ('00000000-0000-4000-8000-00000000bb06'::uuid, '{CUSTOMER_PATH}'::uuid,  '404');

-- Linked out of ascending order, so the ORDER BY inside the aggregate is doing real work.
INSERT INTO apiome.path_operation_response_link (path_operation_id, shared_path_response_id) VALUES
  ('00000000-0000-4000-8000-00000000aa01'::uuid, '00000000-0000-4000-8000-00000000bb03'::uuid),
  ('00000000-0000-4000-8000-00000000aa01'::uuid, '00000000-0000-4000-8000-00000000bb01'::uuid),
  ('00000000-0000-4000-8000-00000000aa01'::uuid, '00000000-0000-4000-8000-00000000bb02'::uuid),
  ('00000000-0000-4000-8000-00000000aa02'::uuid, '00000000-0000-4000-8000-00000000bb05'::uuid),
  ('00000000-0000-4000-8000-00000000aa02'::uuid, '00000000-0000-4000-8000-00000000bb04'::uuid),
  ('00000000-0000-4000-8000-00000000aa04'::uuid, '00000000-0000-4000-8000-00000000bb06'::uuid);
"""

#: Domains are assigned explicitly rather than left to V242's backfill: the backfill's heuristics
#: are DUW-1.1's behaviour and are tested there, and a read test that depended on them would fail
#: for the wrong reason if they were ever tuned. Its output is therefore cleared first — a hard
#: delete, whose ``ON DELETE SET NULL`` releases every member back to ``shared/``.
_ASSIGN_DOMAINS = f"""
DELETE FROM apiome.domains WHERE version_id = '{VERSION}'::uuid;

INSERT INTO apiome.domains (id, version_id, name, slug, sort_order) VALUES
  ('{CUSTOMERS_DOMAIN}'::uuid, '{VERSION}'::uuid, 'customers', 'customers', 0),
  ('{BILLING_DOMAIN}'::uuid,   '{VERSION}'::uuid, 'billing',   'billing',   1);

UPDATE apiome.classes SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name IN ('Address', 'Customer', 'Order');

-- A folder big enough to need more than one page.
UPDATE apiome.classes SET domain_id = '{BILLING_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name LIKE 'Bulk00%';

UPDATE apiome.version_path SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/customers%';
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
    *does* commit is asserted against the fake connection in ``test_scoped_catalog_store.py``,
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
    """A 218-path, 250-class catalog on a scratch cluster, rolled back when the test ends.

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


def _names(page) -> List[str]:
    return [item["name"] for item in page.items]


class TestCatalogSize:
    """The fixture is only interesting if it is actually the size it claims."""

    def test_the_catalog_is_the_size_the_criteria_name(self, catalog):
        with catalog.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM apiome.version_path WHERE version_id = %s::uuid",
                (VERSION,),
            )
            assert cursor.fetchone()["n"] == CATALOG_PATHS
            cursor.execute(
                "SELECT COUNT(*) AS n FROM apiome.classes "
                " WHERE version_id = %s::uuid AND deleted_at IS NULL",
                (VERSION,),
            )
            assert cursor.fetchone()["n"] == CATALOG_CLASSES


class TestAcceptance:
    """"Requesting 3 classes returns exactly 3, with properties+tags, regardless of catalog size."""

    def test_three_ids_return_exactly_three_classes(self, catalog):
        page = load_classes_by_ids(
            catalog, version_id=VERSION, class_ids=[CUSTOMER, ADDRESS, ORDER]
        )

        assert page.total == 3
        assert _names(page) == ["Address", "Customer", "Order"]
        assert page.missing_ids == []

    def test_those_three_arrive_with_their_properties_and_tags(self, catalog):
        page = load_classes_by_ids(catalog, version_id=VERSION, class_ids=[CUSTOMER, ADDRESS])
        by_name = {item["name"]: item for item in page.items}

        assert [p["name"] for p in by_name["Customer"]["properties"]] == ["email", "id", "name"]
        assert [t["tag_name"] for t in by_name["Customer"]["tags"]] == ["core"]
        assert [p["name"] for p in by_name["Address"]["properties"]] == ["street"]
        assert by_name["Address"]["tags"] == []

    def test_no_other_classes_properties_come_along(self, catalog):
        # Every one of the 247 bulk classes has a `filler` property. One leaking into this response
        # would mean the hydration query is not restricted to the selection.
        page = load_classes_by_ids(catalog, version_id=VERSION, class_ids=[CUSTOMER])
        names = [p["name"] for p in page.items[0]["properties"]]

        assert "filler" not in names

    def test_a_library_backed_property_carries_its_source(self, catalog):
        page = load_classes_by_ids(catalog, version_id=VERSION, class_ids=[CUSTOMER])
        by_name = {p["name"]: p for p in page.items[0]["properties"]}

        assert by_name["id"]["property_source_name"] == "uuid"
        assert by_name["name"]["property_source_name"] is None

    def test_the_read_is_three_statements_on_a_250_class_catalog(self, catalog):
        # The cost that matters: hydration tracks the selection, not the version. An N+1 would show
        # up here as 2 + len(items).
        load_classes_by_ids(catalog, version_id=VERSION, class_ids=[CUSTOMER, ADDRESS, ORDER])

        assert len(catalog.statements) == 3

    def test_a_domain_page_is_four_statements_whatever_its_size(self, catalog):
        # One count, one page, two hydrations.
        load_classes_by_domain(catalog, version_id=VERSION, domain_id=BILLING_DOMAIN, limit=100)

        assert len(catalog.statements) == 4


class TestVersionScoping:
    """The version predicate is the tenancy boundary, not a convenience filter."""

    def test_a_class_id_from_another_version_does_not_resolve(self, catalog):
        page = load_classes_by_ids(catalog, version_id=OTHER_VERSION, class_ids=[CUSTOMER])

        assert page.items == []
        assert page.missing_ids == [CUSTOMER]

    def test_a_soft_deleted_class_is_never_returned(self, catalog):
        page = load_classes_by_ids(catalog, version_id=VERSION, class_ids=[DELETED_CLASS])

        assert page.items == []
        assert page.missing_ids == [DELETED_CLASS]

    def test_a_soft_deleted_class_is_not_counted_in_its_folder(self, catalog):
        page = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=None, limit=200
        )

        assert "Abandoned" not in _names(page)


class TestDomainPagination:
    def test_a_page_carries_the_whole_folders_total(self, catalog):
        page = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=CUSTOMERS_DOMAIN, limit=2
        )

        assert _names(page) == ["Address", "Customer"]
        assert page.total == 3
        assert page.next_offset == 2

    def test_paging_visits_every_member_exactly_once(self, catalog):
        seen: List[str] = []
        offset = 0
        while True:
            page = load_classes_by_domain(
                catalog, version_id=VERSION, domain_id=BILLING_DOMAIN, limit=25, offset=offset
            )
            seen.extend(_names(page))
            if page.next_offset is None:
                break
            offset = page.next_offset

        assert len(seen) == len(set(seen))
        assert len(seen) == page.total
        # Whole-folder order, not merely per-page order: an unstable sort would interleave pages.
        assert seen == sorted(seen)

    def test_the_shared_bucket_is_everything_with_no_domain(self, catalog):
        page = load_classes_by_domain(catalog, version_id=VERSION, domain_id=None, limit=500)

        assert page.total == SHARED_CLASSES
        assert all(item["domain_id"] is None for item in page.items)

    def test_the_folders_and_the_shared_bucket_partition_the_version(self, catalog):
        # Every live class is in exactly one folder, `shared/` included. If these three did not sum
        # to the catalog, the tree would be hiding rows from the user with no way to reach them.
        customers = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=CUSTOMERS_DOMAIN, limit=1
        )
        billing = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=BILLING_DOMAIN, limit=1
        )
        shared = load_classes_by_domain(catalog, version_id=VERSION, domain_id=None, limit=1)

        assert customers.total + billing.total + shared.total == CATALOG_CLASSES
        assert billing.total == BILLING_CLASSES

    def test_ordering_is_stable_across_repeated_reads(self, catalog):
        first = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=BILLING_DOMAIN, limit=40
        )
        second = load_classes_by_domain(
            catalog, version_id=VERSION, domain_id=BILLING_DOMAIN, limit=40
        )

        assert _names(first) == _names(second)


class TestScopedPaths:
    def test_ids_return_their_paths_with_operations_in_method_order(self, catalog):
        page = load_paths_by_ids(
            catalog, version_id=VERSION, path_ids=[CUSTOMER_PATH, CUSTOMERS_PATH]
        )

        assert [p["pathname"] for p in page.items] == [
            "/v1/customers",
            "/v1/customers/{customerId}",
        ]
        collection = page.items[0]
        assert [op["operation"] for op in collection["operations"]] == ["GET", "POST", "DELETE"]

    def test_an_operations_description_travels_with_it(self, catalog):
        page = load_paths_by_ids(catalog, version_id=VERSION, path_ids=[CUSTOMERS_PATH])
        operations = {op["operation"]: op for op in page.items[0]["operations"]}

        assert operations["GET"]["operation_id"] == "listCustomers"
        assert operations["GET"]["summary"] == "List customers"
        assert operations["GET"]["deprecated"] is True
        # An operation with no description row still appears, with nulls rather than absence.
        assert operations["POST"]["operation_id"] is None
        assert operations["POST"]["deprecated"] is False

    def test_the_summary_is_projected_out_of_metadata(self, catalog):
        page = load_paths_by_ids(catalog, version_id=VERSION, path_ids=[CUSTOMERS_PATH])

        assert page.items[0]["summary"] == "Customer collection"

    def test_each_operation_carries_the_codes_it_declares_not_its_paths(self, catalog):
        # The lane the paths lens draws (private-suite#2583) prints one operation's codes. All
        # five codes below hang off `/v1/customers`; GET declares three of them and POST two, so
        # a read that rolled up by path — the easy mistake — would give both the same list.
        page = load_paths_by_ids(catalog, version_id=VERSION, path_ids=[CUSTOMERS_PATH])
        operations = {op["operation"]: op for op in page.items[0]["operations"]}

        assert operations["GET"]["response_codes"] == ["200", "400", "401"]
        # Ascending by code, with `default` after the numbers rather than first.
        assert operations["POST"]["response_codes"] == ["201", "default"]
        # An operation that declares none renders an empty lane, not a missing key.
        assert operations["DELETE"]["response_codes"] == []

    def test_codes_do_not_leak_between_paths_read_in_one_page(self, catalog):
        page = load_paths_by_ids(
            catalog, version_id=VERSION, path_ids=[CUSTOMERS_PATH, CUSTOMER_PATH]
        )
        by_path = {p["pathname"]: p for p in page.items}
        item = by_path["/v1/customers/{customerId}"]["operations"][0]

        assert item["response_codes"] == ["404"]
        collection_get = next(
            op for op in by_path["/v1/customers"]["operations"] if op["operation"] == "GET"
        )
        assert collection_get["response_codes"] == ["200", "400", "401"]

    def test_the_codes_travel_with_a_domain_page_too(self, catalog):
        page = load_paths_by_domain(
            catalog, version_id=VERSION, domain_id=CUSTOMERS_DOMAIN, limit=10
        )
        collection = next(p for p in page.items if p["pathname"] == "/v1/customers")
        get = next(op for op in collection["operations"] if op["operation"] == "GET")

        assert get["response_codes"] == ["200", "400", "401"]

    def test_a_domain_page_reports_the_whole_folder(self, catalog):
        page = load_paths_by_domain(
            catalog, version_id=VERSION, domain_id=CUSTOMERS_DOMAIN, limit=1
        )

        assert page.total == 2
        assert page.next_offset == 1

    def test_the_shared_bucket_holds_the_rest_of_the_catalog(self, catalog):
        page = load_paths_by_domain(catalog, version_id=VERSION, domain_id=None, limit=10)

        assert page.total == CATALOG_PATHS - 2
        assert len(page.items) == 10

    def test_two_statements_serve_a_page_of_any_size(self, catalog):
        load_paths_by_ids(catalog, version_id=VERSION, path_ids=[CUSTOMERS_PATH, CUSTOMER_PATH])

        assert len(catalog.statements) == 2
