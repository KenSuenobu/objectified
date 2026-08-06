"""Property-name search against a real server — DUW-5.3 (private-suite#2590).

The unit suite (``test_workspace_property_store.py``) pins the SQL and the projection. What it
cannot prove is the ticket's actual acceptance criterion, which is about a *catalog*: that
``customer_id · used by 14 classes`` equals what ``SELECT COUNT(DISTINCT class_id)`` says over the
same version. That needs rows.

The seeded catalog is built to break a count that is subtly wrong rather than obviously wrong:

* a property carried at **two nesting levels of one class**, which a ``COUNT(*)`` would count twice;
* the same name on a **soft-deleted class** and on a **class in another version**, neither of which
  is in this version's catalog;
* a name differing only by **case**, which the search must find and the count must keep apart;
* a name containing a **LIKE wildcard**, which must match itself rather than everything.

Marked ``requires_db`` and skipped without ``DATABASE_URL``. To run against an ephemeral server, no
installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_workspace_property_db.py -m requires_db'

Everything happens inside a transaction that is always rolled back, so a live database is left
exactly as it was found — which is also why the prerequisite subset of the schema is created here
rather than assumed.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

import pytest

from app.workspace_property_store import (
    DEFAULT_OWNER_LIMIT,
    DEFAULT_PROPERTY_LIMIT,
    search_version_properties,
)

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

#: How many classes carry ``customer_id`` in the seeded version. Written out rather than derived, so
#: a test that agrees with the SQL is agreeing with a number a reader can count in the seed below.
CUSTOMER_ID_USERS = 14

#: The subset of the apiome schema a property search touches. Narrower than production — only the
#: columns :mod:`app.workspace_property_store` selects. ``domain_id`` is V242's column (DUW-1.1),
#: declared here rather than migrated in because nothing in this module depends on how the migration
#: fills it.
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
    domain_id UUID,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schema JSONB DEFAULT '{}'::jsonb,
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT classes_version_name_unique UNIQUE (version_id, name)
);
CREATE TABLE apiome.class_properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    property_id UUID,
    parent_id UUID REFERENCES apiome.class_properties(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    data JSONB DEFAULT '{}'::jsonb
);
"""

#: The catalog the counts are checked against.
#:
#: Fourteen classes carry ``customer_id``: `Customer`, `Invoice`, and twelve `Ledger` rows. One of
#: those fourteen carries it *twice* — once nested — which is what separates "how many classes use
#: it" from "how many property rows have that name".
_SEED = f"""
INSERT INTO apiome.projects (id, name) VALUES ('{PROJECT}'::uuid, 'Primary');
INSERT INTO apiome.versions (id, project_id, version_id) VALUES
  ('{VERSION}'::uuid, '{PROJECT}'::uuid, '2.1'),
  ('{OTHER_VERSION}'::uuid, '{PROJECT}'::uuid, '3.0');

INSERT INTO apiome.classes (version_id, domain_id, name, schema) VALUES
  ('{VERSION}'::uuid, '{CUSTOMERS_DOMAIN}'::uuid, 'Customer', '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, '{BILLING_DOMAIN}'::uuid,   'Invoice',  '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, NULL,                       'Shared',   '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, '{CUSTOMERS_DOMAIN}'::uuid, 'CustomerStatus',
   '{{"type":"string","enum":["active","closed"]}}'::jsonb);

INSERT INTO apiome.classes (version_id, domain_id, name, schema)
SELECT '{VERSION}'::uuid, '{BILLING_DOMAIN}'::uuid, 'Ledger' || lpad(i::text, 2, '0'),
       '{{"type":"object"}}'::jsonb
  FROM generate_series(1, 12) AS i;

-- Present in the table, absent from every count: a soft-deleted class and one in another version,
-- both carrying the property under test so they would be conspicuous if they leaked.
INSERT INTO apiome.classes (version_id, domain_id, name, deleted_at)
VALUES ('{VERSION}'::uuid, NULL, 'AbandonedCustomer', CURRENT_TIMESTAMP);
INSERT INTO apiome.classes (version_id, domain_id, name)
VALUES ('{OTHER_VERSION}'::uuid, NULL, 'Customer');

-- `customer_id` on every Ledger, on Invoice, on Customer, and on the two classes that must not
-- count. That is fourteen live classes in this version.
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'customer_id', '{{"type":"string"}}'::jsonb
  FROM apiome.classes
 WHERE name LIKE 'Ledger%' OR name IN ('Invoice', 'Customer', 'AbandonedCustomer');
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'customer_id', '{{"type":"string"}}'::jsonb
  FROM apiome.classes WHERE version_id = '{OTHER_VERSION}'::uuid;

-- The same name a second time on one class, nested under its first row: one class, two rows.
INSERT INTO apiome.class_properties (class_id, parent_id, name, data)
SELECT cp.class_id, cp.id, 'customer_id', '{{"type":"string"}}'::jsonb
  FROM apiome.class_properties cp
  JOIN apiome.classes c ON c.id = cp.class_id
 WHERE c.name = 'Invoice' AND cp.name = 'customer_id';

-- A name differing from it only by case, on two classes.
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'CustomerID', '{{"type":"string"}}'::jsonb
  FROM apiome.classes WHERE name IN ('Customer', 'Shared');

-- Names that must not be dragged in by a wildcard the reader did not type.
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'customer_ref', '{{"type":"string"}}'::jsonb
  FROM apiome.classes WHERE name = 'Customer';
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'pct_%', '{{"type":"number"}}'::jsonb
  FROM apiome.classes WHERE name IN ('Invoice', 'Shared');
INSERT INTO apiome.class_properties (class_id, name, data)
SELECT id, 'pctx', '{{"type":"number"}}'::jsonb
  FROM apiome.classes WHERE name = 'Customer';

ANALYZE apiome.classes;
ANALYZE apiome.class_properties;
"""


class TransactionDb:
    """A ``_DbLike`` over one open transaction.

    ``commit`` and ``rollback`` are no-ops: the store commits after every read (correctly — a bare
    SELECT still opens a transaction and holding it idle blocks VACUUM), but committing here would
    persist the seeded catalog into whatever cluster ``DATABASE_URL`` points at. That the store
    *does* commit is asserted against the fake connection in ``test_workspace_property_store.py``,
    where it can be observed without writing anything anywhere.
    """

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def connect(self) -> "TransactionDb":
        return self

    def cursor(self) -> Any:
        return self._conn.cursor()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


@pytest.fixture
def catalog():
    """The seeded catalog, rolled back when the test ends.

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
            cursor.execute("SELECT to_regclass('apiome.classes') IS NOT NULL AS present")
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
                pytest.skip("uuid-ossp is not resolvable on this cluster.")

            cursor.execute(_PREREQUISITE_SCHEMA)
            cursor.execute(_SEED)

        yield TransactionDb(conn)
    finally:
        conn.rollback()
        conn.close()


def search(
    catalog: TransactionDb,
    query: str,
    *,
    limit: int = DEFAULT_PROPERTY_LIMIT,
    owner_limit: int = DEFAULT_OWNER_LIMIT,
) -> Dict[str, Any]:
    """Search the seeded version."""
    return search_version_properties(
        catalog, version_id=VERSION, query=query, limit=limit, owner_limit=owner_limit
    )


def hits_by_name(result: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The result's hits, keyed by property name."""
    return {hit["name"]: hit for hit in result["properties"]}


def scalar(catalog: TransactionDb, query: str, params: tuple) -> int:
    """One count straight from SQL — the truth a usage count is checked against."""
    with catalog.cursor() as cursor:
        cursor.execute(query, params)
        return int(cursor.fetchone()["n"])


#: The query that defines the band's number, written once so the assertion and the claim agree.
_TRUTH = """
SELECT COUNT(DISTINCT cp.class_id) AS n
  FROM apiome.class_properties cp
  JOIN apiome.classes c ON c.id = cp.class_id
 WHERE c.version_id = %s::uuid AND c.deleted_at IS NULL AND cp.name = %s
"""


class TestAcceptanceCountsMatchSqlTruth:
    """"Counts match SQL truth." Every usage count, against the query that defines it."""

    @pytest.mark.parametrize(
        "query", ["customer", "customer_id", "cust", "CUSTOMER_ID", "id"]
    )
    def test_every_returned_count_equals_its_own_select_count(self, catalog, query):
        result = search(catalog, query)

        assert result["properties"], f"{query!r} matched nothing; the fixture would prove nothing"
        for hit in result["properties"]:
            assert hit["class_count"] == scalar(catalog, _TRUTH, (VERSION, hit["name"]))

    def test_the_mockups_own_row_is_the_catalogs_own_number(self, catalog):
        hit = hits_by_name(search(catalog, "customer_id"))["customer_id"]

        assert hit["class_count"] == CUSTOMER_ID_USERS

    def test_counts_a_class_once_however_many_rows_carry_the_name(self, catalog):
        rows = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.class_properties cp "
            "  JOIN apiome.classes c ON c.id = cp.class_id "
            " WHERE c.version_id = %s::uuid AND c.deleted_at IS NULL AND cp.name = %s",
            (VERSION, "customer_id"),
        )
        hit = hits_by_name(search(catalog, "customer_id"))["customer_id"]

        # The nested duplicate makes these differ, which is the point of seeding it.
        assert rows == CUSTOMER_ID_USERS + 1
        assert hit["class_count"] == CUSTOMER_ID_USERS

    def test_a_deleted_class_and_another_version_are_not_in_the_count(self, catalog):
        hit = hits_by_name(search(catalog, "customer_id"))["customer_id"]
        listed = {owner["class_name"] for owner in hit["owners"]}

        assert "AbandonedCustomer" not in listed
        assert hit["class_count"] == CUSTOMER_ID_USERS


class TestMatching:
    """What a query finds, and what it must not."""

    def test_matches_case_insensitively_while_keeping_names_apart(self, catalog):
        names = hits_by_name(search(catalog, "customerid"))

        # `CustomerID` is found by a lower-case query, and is its own name with its own count.
        assert "CustomerID" in names
        assert names["CustomerID"]["class_count"] == 2
        assert "customer_id" not in names

    def test_a_wildcard_in_the_query_matches_itself(self, catalog):
        names = hits_by_name(search(catalog, "pct_%"))

        assert list(names) == ["pct_%"]
        assert names["pct_%"]["class_count"] == 2

    def test_an_underscore_is_not_a_single_character_wildcard(self, catalog):
        names = hits_by_name(search(catalog, "pct_"))

        assert "pctx" not in names

    def test_ranks_a_prefix_match_above_a_mid_word_one(self, catalog):
        ordered = [hit["name"] for hit in search(catalog, "customer")["properties"]]

        # Every name starting with the query comes before any that merely contains it.
        prefixed = [name for name in ordered if name.lower().startswith("customer")]
        assert ordered[: len(prefixed)] == prefixed

    def test_ranks_the_most_widely_used_name_first_among_equals(self, catalog):
        ordered = [hit["name"] for hit in search(catalog, "customer")["properties"]]

        assert ordered[0] == "customer_id"

    def test_finds_nothing_for_a_name_this_version_does_not_carry(self, catalog):
        result = search(catalog, "no_such_property")

        assert result["properties"] == []
        assert result["total"] == 0


class TestOwners:
    """The classes behind a count: what the palette opens and lists."""

    def test_lists_owning_classes_alphabetically_with_their_folders(self, catalog):
        hit = hits_by_name(search(catalog, "customer_id", owner_limit=3))["customer_id"]
        names = [owner["class_name"] for owner in hit["owners"]]

        assert names == sorted(names)
        assert names[0] == "Customer"
        assert hit["owners"][0]["domain_id"] == CUSTOMERS_DOMAIN

    def test_lists_a_class_once_even_when_it_carries_the_name_twice(self, catalog):
        hit = hits_by_name(search(catalog, "customer_id", owner_limit=50))["customer_id"]
        names: List[str] = [owner["class_name"] for owner in hit["owners"]]

        assert names.count("Invoice") == 1
        assert len(names) == CUSTOMER_ID_USERS

    def test_says_when_the_owner_list_is_shorter_than_the_count(self, catalog):
        hit = hits_by_name(search(catalog, "customer_id", owner_limit=2))["customer_id"]

        assert len(hit["owners"]) == 2
        assert hit["owners_truncated"] is True
        assert hit["class_count"] == CUSTOMER_ID_USERS

    def test_classifies_an_owner_the_way_the_tree_does(self, catalog):
        hit = hits_by_name(search(catalog, "CustomerID"))["CustomerID"]
        kinds = {owner["class_name"]: owner["kind"] for owner in hit["owners"]}

        assert kinds["Customer"] == "object"

    def test_an_enum_owner_is_labelled_from_its_own_schema(self, catalog):
        with catalog.cursor() as cursor:
            cursor.execute(
                "INSERT INTO apiome.class_properties (class_id, name, data) "
                "SELECT id, 'customer_id', '{}'::jsonb FROM apiome.classes "
                " WHERE version_id = %s::uuid AND name = 'CustomerStatus'",
                (VERSION,),
            )
        hit = hits_by_name(search(catalog, "customer_id", owner_limit=50))["customer_id"]
        kinds = {owner["class_name"]: owner["kind"] for owner in hit["owners"]}

        assert kinds["CustomerStatus"] == "enum"
        assert hit["class_count"] == CUSTOMER_ID_USERS + 1


class TestCaps:
    """A capped answer says how much it capped."""

    def test_reports_the_whole_match_set_when_it_returns_a_slice(self, catalog):
        result = search(catalog, "customer", limit=1)

        assert len(result["properties"]) == 1
        assert result["total"] > 1
        assert result["truncated"] is True

    def test_does_not_claim_to_have_capped_when_it_returned_everything(self, catalog):
        result = search(catalog, "customer")

        assert result["total"] == len(result["properties"])
        assert result["truncated"] is False
