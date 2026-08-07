"""Bounded primitives search against a real server — DWX-3.1 (private-suite#2683).

The unit suite (``test_primitives_search_store.py``) pins the SQL and the projection. What it
cannot prove is the ticket's actual acceptance criteria, all of which are about a *catalog*:

* **Scope parity.** ``SCOPE_EXPRESSION`` puts every row in the same tab
  :func:`~app.primitives_search_store.classify_scope` puts it in — over the canonical fixture
  ``tests/fixtures/primitive_scope_cases.json``, whose other half runs the designer's
  ``classifyPrimitive`` over the same cases in
  ``private-suite/designer/tests/unit/workspace-primitives-scope-parity.test.ts``. Three
  implementations, one rule.
* **Nothing exceeds the limit, at scale.** 5,000 primitives are seeded and paged; no response
  carries more than it promised, and walking the cursor to the end visits every row exactly once.
* **Tenancy.** Another tenant's private types are not merely filtered out — they are not in the
  visibility CTE, so no query, namespace, cursor or ``$ref`` reaches one.
* **The indexes exist and are used.** V244 is applied inside the same rolled-back transaction and
  the search's plan is checked for a sequential scan over the registry.

Marked ``requires_db`` and skipped without ``DATABASE_URL``. To run against an ephemeral server, no
installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_primitives_search_db.py -m requires_db'

Everything happens inside a transaction that is always rolled back, so a live database is left
exactly as it was found — which is also why the prerequisite subset of the schema is created here
rather than assumed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from app.primitives_search_store import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    SCOPES,
    classify_scope,
    decode_cursor,
    search_primitives,
)

_db_url = os.environ.get("DATABASE_URL")

pytestmark = [
    pytest.mark.requires_db,
    pytest.mark.skipif(
        not _db_url, reason="DATABASE_URL not set – skipping live-DB integration tests"
    ),
]

MIGRATION = "apiome-db/scripts/V244__primitives_bounded_search_indexes_2683.sql"

TENANT = "00000000-0000-4000-8000-000000000001"
OTHER_TENANT = "00000000-0000-4000-8000-000000000002"

#: The canonical scope cases, shared with the designer's jest parity test.
_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "primitive_scope_cases.json").read_text("utf-8")
)

#: How many rows the scale seed creates for the tenant. The ticket's budget is stated against
#: 5,000, so that is what is seeded rather than a number that merely sounds large.
SCALE_ROWS = 5_000

#: The subset of the apiome schema the search touches. Narrower than production — only the columns
#: :mod:`app.primitives_search_store` selects, plus the ``deleted_at`` and ``enabled`` columns V037
#: declares, so V244's indexes apply unchanged.
_PREREQUISITE_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS apiome;

CREATE TABLE apiome.tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);

CREATE TABLE apiome.primitives (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL,
    schema JSONB NOT NULL,
    tags TEXT[] DEFAULT '{}',
    tenant_id UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    created_by UUID,
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_public BOOLEAN NOT NULL DEFAULT false,
    usage_count INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT true,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    namespace TEXT,
    base_uri  TEXT,
    schema_id TEXT,
    draft     TEXT  NOT NULL DEFAULT '2020-12',
    source    TEXT  NOT NULL DEFAULT 'human',
    refs      JSONB NOT NULL DEFAULT '[]'::jsonb
);
"""

_SEED_TENANTS = f"""
INSERT INTO apiome.tenants (id, name) VALUES
    ('{TENANT}', 'acme'),
    ('{OTHER_TENANT}', 'globex');
"""


class TransactionDb:
    """A database handle over one open transaction.

    ``commit`` and ``rollback`` are no-ops: the store commits after every read (correctly — a bare
    SELECT still opens a transaction and holding it idle blocks VACUUM), but committing here would
    persist the seeded registry into whatever cluster ``DATABASE_URL`` points at. That the store
    *does* commit is asserted against the fake connection in ``test_primitives_search_store.py``,
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

    def execute_query(self, query: str, params: Any = None) -> List[Dict[str, Any]]:
        """Run one statement and return its rows, matching ``Database.execute_query``.

        Present so :meth:`get_primitives_for_tenant` below can be the *production* method rather
        than a re-typed copy of its SQL — a copy would agree with itself forever.
        """
        with self.cursor() as cursor:
            cursor.execute(query, params)
            return [dict(row) for row in (cursor.fetchall() or [])]

    def get_primitives_for_tenant(
        self, tenant_id: str, category: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """The classic unbounded listing, run against this transaction.

        Calls the real :class:`app.database.Database` method unbound, so the endpoint's other shape
        is exercised by the code that actually serves it.
        """
        from app.database import Database

        return Database.get_primitives_for_tenant(self, tenant_id, category)


def _migration_sql() -> str:
    """V244's text, located from this file rather than from the working directory."""
    root = Path(__file__).resolve().parents[2]
    return (root / MIGRATION).read_text("utf-8")


@pytest.fixture
def registry():
    """An empty registry with V244 applied, rolled back when the test ends.

    Skips rather than colliding when ``DATABASE_URL`` already carries the real schema: building
    ``apiome.primitives`` on top of a populated dev database would fail anyway, and half-running
    against real data is not what this suite is for.
    """
    psycopg2 = pytest.importorskip("psycopg2")
    from psycopg2.extras import RealDictCursor

    conn = psycopg2.connect(_db_url, cursor_factory=RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT to_regclass('apiome.primitives') IS NOT NULL AS present")
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
            cursor.execute(_SEED_TENANTS)
            cursor.execute(_migration_sql())

        yield TransactionDb(conn)
    finally:
        conn.rollback()
        conn.close()


def insert(
    registry: TransactionDb,
    name: str,
    *,
    tenant: str = TENANT,
    is_system: bool = False,
    namespace: Optional[str] = "tenant/acme/types",
    source: str = "human",
    category: str = "string",
    description: Optional[str] = None,
    tags: Optional[List[str]] = None,
    schema_id: Optional[str] = None,
) -> None:
    """Add one primitive to the seeded registry."""
    with registry.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO apiome.primitives
                (tenant_id, name, description, category, schema, tags,
                 is_system, namespace, source, schema_id)
            VALUES (%s::uuid, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s)
            """,
            (
                tenant,
                name,
                description,
                category,
                json.dumps({"type": category}),
                tags or [],
                is_system,
                namespace,
                source,
                schema_id,
            ),
        )


def search(registry: TransactionDb, **kwargs: Any) -> Dict[str, Any]:
    """Search the seeded registry as the caller's tenant."""
    kwargs.setdefault("limit", DEFAULT_LIMIT)
    return search_primitives(registry, tenant_id=TENANT, **kwargs)


def names(result: Dict[str, Any]) -> List[str]:
    """The names a result listed, in the order it listed them."""
    return [item["name"] for item in result["items"]]


class TestScopeParity:
    """The SQL classification agrees with the Python reference on every fixture case.

    The third implementation — the designer's ``classifyPrimitive`` — is checked against the same
    fixture in jest. Nothing here is allowed to pass while that one fails, because a tab whose
    server-side filter and client-side grouping disagree silently hides types.
    """

    def test_the_fixture_has_not_drifted(self) -> None:
        assert _FIXTURE["revision"] == 1

    def test_sql_matches_the_reference_for_every_case(self, registry: TransactionDb) -> None:
        for index, case in enumerate(_FIXTURE["cases"]):
            insert(
                registry,
                f"case{index:03d}",
                tenant=TENANT,
                is_system=case["is_system"],
                namespace=case["namespace"],
                source=case["source"],
            )

        result = search(registry, limit=MAX_LIMIT)
        by_name = {item["name"]: item for item in result["items"]}
        assert len(by_name) == len(_FIXTURE["cases"])

        for index, case in enumerate(_FIXTURE["cases"]):
            row = by_name[f"case{index:03d}"]
            reference = classify_scope(case["is_system"], case["namespace"], case["source"])
            assert row["scope"] == case["expected"] == reference, case["why"]

    def test_the_counts_agree_with_the_rows(self, registry: TransactionDb) -> None:
        for index, case in enumerate(_FIXTURE["cases"]):
            insert(
                registry,
                f"case{index:03d}",
                is_system=case["is_system"],
                namespace=case["namespace"],
                source=case["source"],
            )

        result = search(registry, limit=MAX_LIMIT)
        for scope in SCOPES:
            expected = sum(1 for case in _FIXTURE["cases"] if case["expected"] == scope)
            assert result["counts"][scope] == expected, scope

    def test_a_scope_filter_returns_exactly_that_tab(self, registry: TransactionDb) -> None:
        for index, case in enumerate(_FIXTURE["cases"]):
            insert(
                registry,
                f"case{index:03d}",
                is_system=case["is_system"],
                namespace=case["namespace"],
                source=case["source"],
            )

        for scope in SCOPES:
            result = search(registry, scope=scope, limit=MAX_LIMIT)
            assert {item["scope"] for item in result["items"]} <= {scope}
            assert result["total"] == result["counts"][scope]
            assert len(result["items"]) == result["counts"][scope]


class TestMatching:
    """What a query finds, and what it must not."""

    @pytest.fixture(autouse=True)
    def _seed(self, registry: TransactionDb) -> None:
        insert(registry, "date", is_system=True, namespace="std/v0/types")
        insert(registry, "date-time", is_system=True, namespace="std/v0/types")
        insert(registry, "string", is_system=True, namespace="std/v0/primitives")
        insert(
            registry,
            "PostalCode",
            namespace="tenant/acme/types",
            # Deliberately contains 'dat' but not 'date': the prefix-ranking test needs a
            # containment match to sort behind the two names 'date' starts.
            description="A checked mailing datum",
        )
        insert(registry, "Sku", namespace="tenant/acme/imported", source="imported",
               tags=["catalog", "dataset"])
        insert(registry, "pct_%", namespace="tenant/acme/types")
        insert(registry, "pctx", namespace="tenant/acme/types")
        insert(registry, "Iban", namespace="tenant/acme/types",
               schema_id="https://registry.apiome.dev/tenant/acme/types/iban")

    def test_a_query_matches_names(self, registry: TransactionDb) -> None:
        assert set(names(search(registry, query="date"))) == {"date", "date-time"}

    def test_a_query_matches_namespaces(self, registry: TransactionDb) -> None:
        assert set(names(search(registry, query="std/v0/primitives"))) == {"string"}

    def test_a_query_matches_the_registry_ref(self, registry: TransactionDb) -> None:
        """`std/v0/types/date` is the `$ref` a property binds by, and must be searchable."""
        assert set(names(search(registry, query="v0/types/date"))) == {"date", "date-time"}

    def test_a_query_matches_the_schema_id(self, registry: TransactionDb) -> None:
        assert names(search(registry, query="registry.apiome.dev")) == ["Iban"]

    def test_a_query_matches_descriptions(self, registry: TransactionDb) -> None:
        assert "PostalCode" in names(search(registry, query="mailing"))

    def test_a_query_matches_tags(self, registry: TransactionDb) -> None:
        assert names(search(registry, query="catalog")) == ["Sku"]

    def test_matching_is_case_insensitive(self, registry: TransactionDb) -> None:
        assert names(search(registry, query="POSTALcode")) == ["PostalCode"]

    def test_a_wildcard_matches_itself(self, registry: TransactionDb) -> None:
        """A type named `pct_%` must find itself, not the whole registry."""
        assert names(search(registry, query="pct_%")) == ["pct_%"]

    def test_a_prefix_match_is_listed_first(self, registry: TransactionDb) -> None:
        """`datum` appears inside PostalCode's description; `date` starts two names."""
        listed = names(search(registry, query="dat"))
        assert listed[:2] == ["date", "date-time"]
        assert "PostalCode" in listed

    def test_a_namespace_filter_is_exact(self, registry: TransactionDb) -> None:
        assert set(names(search(registry, namespace="std/v0/types"))) == {"date", "date-time"}

    def test_a_namespace_filter_excludes_children(self, registry: TransactionDb) -> None:
        assert names(search(registry, namespace="std/v0")) == []

    def test_a_category_filter_still_applies(self, registry: TransactionDb) -> None:
        insert(registry, "Money", category="number", namespace="tenant/acme/types")
        assert names(search(registry, category="number")) == ["Money"]

    def test_narrowings_compose(self, registry: TransactionDb) -> None:
        result = search(registry, query="date", scope="core", namespace="std/v0/types")
        assert set(names(result)) == {"date", "date-time"}


class TestTenancy:
    """Another tenant's private types are never in scope."""

    @pytest.fixture(autouse=True)
    def _seed(self, registry: TransactionDb) -> None:
        insert(registry, "OurSku", namespace="tenant/acme/types")
        insert(registry, "TheirSku", tenant=OTHER_TENANT, namespace="tenant/globex/types")
        insert(
            registry,
            "TheirRef",
            tenant=OTHER_TENANT,
            namespace="tenant/globex/types",
            schema_id="https://registry.apiome.dev/tenant/globex/types/theirref",
        )
        insert(registry, "SharedDate", is_system=True, namespace="std/v0/types",
               tenant=OTHER_TENANT)

    def test_a_foreign_private_type_is_not_listed(self, registry: TransactionDb) -> None:
        assert "TheirSku" not in names(search(registry, limit=MAX_LIMIT))

    def test_a_foreign_private_type_cannot_be_searched_for(self, registry: TransactionDb) -> None:
        assert names(search(registry, query="TheirSku")) == []

    def test_a_cross_tenant_ref_never_resolves(self, registry: TransactionDb) -> None:
        """Searching the exact `$id` of another tenant's type finds nothing."""
        assert names(search(registry, query="tenant/globex/types/theirref")) == []

    def test_a_foreign_namespace_filter_finds_nothing(self, registry: TransactionDb) -> None:
        assert names(search(registry, namespace="tenant/globex/types")) == []

    def test_the_counts_do_not_leak_foreign_rows(self, registry: TransactionDb) -> None:
        result = search(registry, limit=MAX_LIMIT)
        assert sum(result["counts"].values()) == len(result["items"])

    def test_a_system_row_seeded_to_another_tenant_is_still_shared(
        self, registry: TransactionDb
    ) -> None:
        """`is_system` rows are visible to everyone — that is what makes Standard and Core tabs."""
        assert "SharedDate" in names(search(registry, limit=MAX_LIMIT))

    def test_a_duplicated_system_type_is_listed_once(self, registry: TransactionDb) -> None:
        """System-core types are seeded per tenant; the caller sees one row, its own."""
        insert(registry, "SharedDate", is_system=True, namespace="std/v0/types", tenant=TENANT)
        listed = names(search(registry, limit=MAX_LIMIT))
        assert listed.count("SharedDate") == 1
        row = next(i for i in search(registry, limit=MAX_LIMIT)["items"] if i["name"] == "SharedDate")
        assert str(row["tenant_id"]) == TENANT


class TestScale:
    """5,000 primitives: the size the ticket's budget is stated against."""

    @pytest.fixture(autouse=True)
    def _seed(self, registry: TransactionDb) -> None:
        with registry.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO apiome.primitives
                    (tenant_id, name, category, schema, tags, is_system, namespace, source)
                SELECT %s::uuid,
                       'type' || lpad(i::text, 5, '0'),
                       'string',
                       '{"type":"string"}'::jsonb,
                       ARRAY['bulk'],
                       false,
                       'tenant/acme/types',
                       'human'
                  FROM generate_series(1, %s) AS s(i)
                """,
                (TENANT, SCALE_ROWS),
            )
            cursor.execute("ANALYZE apiome.primitives")

    @pytest.mark.parametrize("limit", [1, DEFAULT_LIMIT, MAX_LIMIT])
    def test_no_response_exceeds_the_limit(self, registry: TransactionDb, limit: int) -> None:
        result = search(registry, limit=limit)
        assert len(result["items"]) == limit
        assert result["total"] == SCALE_ROWS
        assert result["truncated"] is True

    def test_the_counts_still_cover_the_whole_registry(self, registry: TransactionDb) -> None:
        result = search(registry, limit=5)
        assert result["counts"]["tenant"] == SCALE_ROWS

    def test_a_narrow_query_returns_only_its_matches(self, registry: TransactionDb) -> None:
        result = search(registry, query="type04999", limit=MAX_LIMIT)
        assert names(result) == ["type04999"]
        assert result["total"] == 1

    def test_the_cursor_walks_every_row_exactly_once(self, registry: TransactionDb) -> None:
        """A keyset cursor that skipped or repeated a row would be invisible without this."""
        seen: List[str] = []
        cursor = None
        pages = 0
        while True:
            result = search(registry, limit=MAX_LIMIT, cursor=cursor)
            seen.extend(item["id"] for item in result["items"])
            pages += 1
            if result["next_cursor"] is None:
                break
            cursor = decode_cursor(result["next_cursor"])
            assert pages < (SCALE_ROWS // MAX_LIMIT) + 5, "cursor did not terminate"

        assert len(seen) == SCALE_ROWS
        assert len(set(seen)) == SCALE_ROWS

    def test_a_row_inserted_mid_walk_cannot_shift_a_page_boundary(
        self, registry: TransactionDb
    ) -> None:
        """The reason the cursor is keyset rather than an offset."""
        first = search(registry, limit=10)
        # A type that sorts before everything already handed out.
        insert(registry, "aaa-inserted", namespace="tenant/acme/types")
        second = search(registry, limit=10, cursor=decode_cursor(first["next_cursor"]))
        assert not set(names(first)) & set(names(second))
        assert "aaa-inserted" not in names(second)

    def test_the_search_does_not_scan_the_registry_sequentially(
        self, registry: TransactionDb
    ) -> None:
        """V244's reason for existing: a leading-wildcard match must not be a sequential scan.

        Skipped, not failed, when ``pg_trgm`` could not be installed — V244 degrades to a NOTICE in
        exactly that case, and a missing contrib extension is an operator's problem rather than a
        regression in this code.
        """
        with registry.cursor() as cursor:
            cursor.execute("SELECT to_regclass('apiome.idx_primitives_name_trgm') IS NOT NULL AS ok")
            if not cursor.fetchone()["ok"]:
                pytest.skip("pg_trgm is unavailable on this cluster; V244 skipped its indexes.")

            cursor.execute("SET LOCAL enable_seqscan = off")
            cursor.execute(
                """
                EXPLAIN (FORMAT JSON)
                SELECT id FROM apiome.primitives
                 WHERE tenant_id = %s::uuid AND lower(name) LIKE %s
                """,
                (TENANT, "%04999%"),
            )
            plan = json.dumps(cursor.fetchone()["QUERY PLAN"])
        assert "Bitmap Index Scan" in plan or "Index Scan" in plan, plan


class TestEndToEnd:
    """The route over a real database, with nothing mocked between them.

    ``test_primitives_search_routes.py`` patches the store, and this module drives the store
    directly; neither notices if the two disagree about the *types* the rows carry. psycopg2 hands
    back a UUID column as a plain string by default, and ``PrimitiveSchema.id`` is a `str` that
    refuses a ``uuid.UUID`` — so a driver setting that changed under this code would produce rows
    the store returns happily and the response model rejects with a 500. One case that walks the
    whole path is what makes that impossible to miss.
    """

    @pytest.fixture
    def api(self, registry: TransactionDb):
        """A ``TestClient`` whose primitives routes read the seeded, rolled-back registry."""
        from unittest.mock import patch

        from fastapi.testclient import TestClient

        from app.auth import validate_authentication
        from app.main import app

        app.dependency_overrides[validate_authentication] = lambda: {
            "auth_method": "jwt",
            "user_id": "00000000-0000-4000-8000-0000000000f1",
            "tenant_id": TENANT,
        }
        try:
            with patch("app.primitives_routes.db", registry):
                yield TestClient(app)
        finally:
            app.dependency_overrides.pop(validate_authentication, None)

    def test_a_bounded_request_serializes_real_rows(
        self, registry: TransactionDb, api: Any
    ) -> None:
        insert(registry, "date", is_system=True, namespace="std/v0/types")
        insert(registry, "string", is_system=True, namespace="std/v0/primitives")
        insert(registry, "Sku", namespace="tenant/acme/imported", source="imported")

        response = api.get("/v1/primitives/acme", params={"limit": MAX_LIMIT})
        assert response.status_code == 200, response.text

        body = response.json()
        assert {item["name"]: item["scope"] for item in body["items"]} == {
            "date": "core",
            "string": "standard",
            "Sku": "custom",
        }
        assert body["counts"] == {"standard": 1, "core": 1, "tenant": 0, "custom": 1}
        assert body["total"] == 3
        # The ids survived the round trip as strings, which is the type the model declares.
        assert all(isinstance(item["id"], str) for item in body["items"])

    def test_the_classic_shape_still_serializes_real_rows(
        self, registry: TransactionDb, api: Any
    ) -> None:
        """The unbounded listing shares the visibility scope but not the code path; both must
        survive a real driver."""
        insert(registry, "date", is_system=True, namespace="std/v0/types")

        response = api.get("/v1/primitives/acme")
        assert response.status_code == 200, response.text
        assert [row["name"] for row in response.json()] == ["date"]

    def test_paging_the_route_hands_out_a_usable_cursor(
        self, registry: TransactionDb, api: Any
    ) -> None:
        for index in range(5):
            insert(registry, f"type{index}", namespace="tenant/acme/types")

        first = api.get("/v1/primitives/acme", params={"limit": 2}).json()
        assert len(first["items"]) == 2 and first["next_cursor"]

        second = api.get(
            "/v1/primitives/acme", params={"limit": 2, "cursor": first["next_cursor"]}
        ).json()
        assert not set(i["id"] for i in first["items"]) & set(i["id"] for i in second["items"])

    def test_a_forged_cursor_is_refused_by_the_route(self, api: Any) -> None:
        response = api.get("/v1/primitives/acme", params={"cursor": "not-a-real-cursor"})
        assert response.status_code == 400


class TestIndexes:
    """V244 creates what it says it creates."""

    def test_the_dedupe_index_exists(self, registry: TransactionDb) -> None:
        assert self._index_present(registry, "idx_primitives_namespace_name_tenant")

    def test_the_scope_index_exists(self, registry: TransactionDb) -> None:
        assert self._index_present(registry, "idx_primitives_scope_columns")

    def test_the_migration_is_rerunnable(self, registry: TransactionDb) -> None:
        """Every statement is IF NOT EXISTS, so a re-applied migration is a no-op rather than an
        error — which is what makes the trigram block safe to re-run after installing pg_trgm."""
        with registry.cursor() as cursor:
            cursor.execute(_migration_sql())

    def test_the_migration_creates_no_tables_and_changes_no_columns(self) -> None:
        """A read-path migration that quietly altered the table would be a different ticket."""
        sql = _migration_sql().upper()
        for forbidden in ("CREATE TABLE", "ALTER TABLE", "DROP TABLE", "UPDATE ", "DELETE "):
            assert forbidden not in sql, forbidden

    @staticmethod
    def _index_present(registry: TransactionDb, name: str) -> bool:
        with registry.cursor() as cursor:
            cursor.execute(
                "SELECT to_regclass(%s) IS NOT NULL AS present", (f"apiome.{name}",)
            )
            return bool(cursor.fetchone()["present"])
