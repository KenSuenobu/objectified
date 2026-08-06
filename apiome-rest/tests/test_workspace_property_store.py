"""Property-name search aggregation — DUW-5.3 (private-suite#2590).

Exercises :mod:`app.workspace_property_store` against a scripted fake connection, following the
``test_workspace_summary_store.py`` precedent. No live Postgres here: this asserts the SQL these
functions emit, how many statements they emit it in, and how rows are projected onto hits. That the
SQL *counts correctly* — that ``used by 14 classes`` equals what ``SELECT COUNT(DISTINCT class_id)``
says — is proven against a server in ``test_workspace_property_db.py``, because only a real catalog
can prove it.

The properties that get the most attention, because each fails silently:

* **A class is counted once, however many times it carries the name.** ``class_properties`` holds
  nested rows, so a class with ``customer_id`` at two levels would otherwise be two users of it.
* **The count is not the length of the owner list.** ``class_count`` covers the whole version;
  ``owners`` is capped. A count derived from the returned rows would shrink as the cap tightened.
* **A wildcard in a query matches itself.** A property named ``pct_%`` must not search for
  everything.
* **A short query costs nothing.** No statement is issued at all — the palette asks on every pause.
* **Reads commit.** A SELECT opens a transaction too; leaving the shared connection idle in one
  holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.workspace_property_store import (
    DEFAULT_OWNER_LIMIT,
    DEFAULT_PROPERTY_LIMIT,
    MAX_OWNER_LIMIT,
    MAX_PROPERTY_LIMIT,
    MIN_QUERY_LENGTH,
    clamp_owner_limit,
    clamp_property_limit,
    like_pattern,
    normalize_query,
    search_version_properties,
)

VERSION = "11111111-1111-1111-1111-111111111111"
CUSTOMERS = "22222222-2222-2222-2222-2222222222aa"
INVOICE = "33333333-3333-3333-3333-33333333aaaa"
CUSTOMER = "33333333-3333-3333-3333-33333333bbbb"
PAYMENT = "33333333-3333-3333-3333-33333333cccc"


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

    def fetchall(self) -> List[Dict[str, Any]]:
        value = self.conn._take()
        return value if isinstance(value, list) else ([] if value is None else [value])

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeConnection:
    """A psycopg2-shaped connection whose results are scripted per statement."""

    def __init__(self, results: Optional[List[Any]] = None) -> None:
        self.results = list(results or [])
        self.statements: List[tuple] = []
        self.commits = 0
        self.rollbacks = 0
        self._pending: Any = None
        self.raise_on: Optional[tuple] = None

    def _advance(self) -> None:
        if self.raise_on and self.raise_on[0] in self.statements[-1][0]:
            raise self.raise_on[1]
        self._pending = self.results.pop(0) if self.results else None

    def _take(self) -> Any:
        value = self._pending
        self._pending = None
        return value

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeDb:
    """Minimal ``_DbLike`` returning one connection."""

    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    def connect(self) -> FakeConnection:
        return self._conn


# ─── Row builders ────────────────────────────────────────────────────────────


def match(name: str, class_count: int, match_count: int) -> Dict[str, Any]:
    """One row of the match statement: a property name, its usage, and the match-set size."""
    return {"name": name, "class_count": class_count, "match_count": match_count}


def owner(
    property_name: str,
    class_id: str,
    class_name: str,
    *,
    domain_id: Optional[str] = CUSTOMERS,
    kind: str = "object",
) -> Dict[str, Any]:
    """One row of the owners statement: a class carrying a matched property."""
    return {
        "property_name": property_name,
        "class_id": class_id,
        "class_name": class_name,
        "domain_id": domain_id,
        "kind": kind,
    }


def search(
    results: List[Any],
    *,
    query: str = "customer",
    limit: int = DEFAULT_PROPERTY_LIMIT,
    owner_limit: int = DEFAULT_OWNER_LIMIT,
) -> tuple:
    """Run one search against scripted results.

    Args:
        results: What each statement returns, in order.
        query: The normalized query.
        limit: The property-name cap.
        owner_limit: The per-name owner cap.

    Returns:
        ``(result, connection)`` — the answer, and the connection for statement assertions.
    """
    conn = FakeConnection(results)
    result = search_version_properties(
        FakeDb(conn),
        version_id=VERSION,
        query=query,
        limit=limit,
        owner_limit=owner_limit,
    )
    return result, conn


# ─── The query, before it reaches SQL ────────────────────────────────────────


class TestQueryNormalization:
    """What the caller typed, reduced to what the statements compare."""

    def test_trims_and_tolerates_nothing_at_all(self):
        assert normalize_query("  customer_id  ") == "customer_id"
        assert normalize_query(None) == ""
        assert normalize_query("   ") == ""

    def test_keeps_case_because_the_match_is_case_insensitive_not_the_name(self):
        # The name comes back as the catalog spells it; ILIKE is what makes the match forgiving.
        assert normalize_query("CustomerId") == "CustomerId"

    def test_wraps_a_query_in_wildcards_and_escapes_the_ones_it_contains(self):
        assert like_pattern("customer") == "%customer%"
        assert like_pattern("customer", prefix=True) == "customer%"
        # `id_` must not match `idx`: the underscore is a literal the reader typed.
        assert like_pattern("id_") == "%id\\_%"
        assert like_pattern("pct_%") == "%pct\\_\\%%"
        assert like_pattern("a\\b") == "%a\\\\b%"


class TestLimits:
    """Limits are clamped rather than rejected, and zero means zero."""

    @pytest.mark.parametrize(
        "requested,expected",
        [
            (None, DEFAULT_PROPERTY_LIMIT),
            (5, 5),
            (0, 0),
            (-3, 0),
            (MAX_PROPERTY_LIMIT + 100, MAX_PROPERTY_LIMIT),
        ],
    )
    def test_clamps_the_property_limit(self, requested, expected):
        assert clamp_property_limit(requested) == expected

    @pytest.mark.parametrize(
        "requested,expected",
        [
            (None, DEFAULT_OWNER_LIMIT),
            (3, 3),
            (0, 0),
            (MAX_OWNER_LIMIT + 1, MAX_OWNER_LIMIT),
        ],
    )
    def test_clamps_the_owner_limit(self, requested, expected):
        assert clamp_owner_limit(requested) == expected


# ─── The statements ──────────────────────────────────────────────────────────


class TestStatements:
    """What reaches Postgres, and how much of it."""

    def test_answers_a_short_query_without_asking_the_database(self):
        result, conn = search([], query="c" * (MIN_QUERY_LENGTH - 1))

        assert conn.statements == []
        assert result["properties"] == []
        assert result["total"] == 0
        assert result["truncated"] is False

    def test_costs_two_statements_however_many_names_matched(self):
        _, conn = search(
            [
                [match("customer_id", 14, 2), match("customer_ref", 3, 2)],
                [owner("customer_id", INVOICE, "Invoice")],
            ]
        )

        assert len(conn.statements) == 2

    def test_scopes_both_statements_to_the_version_and_skips_deleted_classes(self):
        _, conn = search([[match("customer_id", 14, 1)], [owner("customer_id", INVOICE, "Invoice")]])

        for statement, params in conn.statements:
            assert "c.version_id = %s::uuid" in statement
            assert "c.deleted_at IS NULL" in statement
            assert params[0] == VERSION

    def test_counts_distinct_classes_rather_than_property_rows(self):
        _, conn = search([[match("customer_id", 14, 1)], []])

        assert "COUNT(DISTINCT cp.class_id)" in conn.statements[0][0]

    def test_sends_the_containment_and_prefix_patterns_and_the_cap(self):
        _, conn = search([[match("customer_id", 14, 1)], []], query="customer", limit=7)

        _, params = conn.statements[0]
        assert params == (VERSION, "%customer%", "customer%", 7)

    def test_asks_for_owners_of_exactly_the_names_it_is_returning(self):
        _, conn = search(
            [
                [match("customer_id", 14, 2), match("customer_ref", 3, 2)],
                [owner("customer_id", INVOICE, "Invoice")],
            ],
            owner_limit=4,
        )

        _, params = conn.statements[1]
        assert params == (VERSION, ["customer_id", "customer_ref"], 4)

    def test_skips_the_owner_statement_when_nothing_matched(self):
        result, conn = search([[]])

        assert len(conn.statements) == 1
        assert result["properties"] == []

    def test_skips_the_owner_statement_when_no_owners_were_asked_for(self):
        result, conn = search([[match("customer_id", 14, 1)]], owner_limit=0)

        assert len(conn.statements) == 1
        assert result["properties"][0]["owners"] == []
        # Counts are unaffected by the owner cap, which is the whole reason zero is allowed.
        assert result["properties"][0]["class_count"] == 14

    def test_asks_nothing_when_no_names_were_asked_for(self):
        result, conn = search([], limit=0)

        assert conn.statements == []
        assert result["limit"] == 0

    def test_deduplicates_owners_before_ranking_them(self):
        # A class carrying the name at two nesting levels must not spend two of the owner slots.
        _, conn = search([[match("customer_id", 14, 1)], []])

        assert "SELECT DISTINCT" in conn.statements[1][0]
        assert "PARTITION BY property_name" in conn.statements[1][0]

    def test_commits_the_read_and_rolls_back_a_failed_one(self):
        _, conn = search([[match("customer_id", 14, 1)], []])
        assert (conn.commits, conn.rollbacks) == (1, 0)

        failing = FakeConnection([[match("customer_id", 14, 1)]])
        failing.raise_on = ("class_properties", RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            search_version_properties(
                FakeDb(failing),
                version_id=VERSION,
                query="customer",
                limit=DEFAULT_PROPERTY_LIMIT,
                owner_limit=DEFAULT_OWNER_LIMIT,
            )
        assert (failing.commits, failing.rollbacks) == (0, 1)


# ─── The projection ──────────────────────────────────────────────────────────


class TestProjection:
    """How rows become the band's hits."""

    def test_carries_the_usage_count_and_the_owners_behind_it(self):
        result, _ = search(
            [
                [match("customer_id", 3, 1)],
                [
                    owner("customer_id", CUSTOMER, "Customer"),
                    owner("customer_id", INVOICE, "Invoice", domain_id=None),
                    owner("customer_id", PAYMENT, "Payment", kind="union"),
                ],
            ]
        )

        hit = result["properties"][0]
        assert hit["name"] == "customer_id"
        assert hit["class_count"] == 3
        assert [o["class_name"] for o in hit["owners"]] == ["Customer", "Invoice", "Payment"]
        assert hit["owners"][1]["domain_id"] is None
        assert hit["owners"][2]["kind"] == "union"
        assert hit["owners_truncated"] is False

    def test_says_when_a_property_has_more_owners_than_it_lists(self):
        result, _ = search(
            [
                [match("customer_id", 14, 1)],
                [owner("customer_id", INVOICE, "Invoice")],
            ],
            owner_limit=1,
        )

        hit = result["properties"][0]
        assert hit["class_count"] == 14
        assert len(hit["owners"]) == 1
        assert hit["owners_truncated"] is True

    def test_keeps_the_order_the_statement_ranked_the_names_in(self):
        result, _ = search(
            [
                [match("customer_id", 14, 3), match("id", 40, 3), match("customer_ref", 2, 3)],
                [],
            ]
        )

        assert [hit["name"] for hit in result["properties"]] == [
            "customer_id",
            "id",
            "customer_ref",
        ]

    def test_reports_the_whole_match_set_and_that_it_capped(self):
        result, _ = search([[match("customer_id", 14, 9), match("id", 40, 9)], []], limit=2)

        assert result["total"] == 9
        assert result["truncated"] is True
        assert result["limit"] == 2

    def test_does_not_claim_to_have_capped_when_it_returned_everything(self):
        result, _ = search([[match("customer_id", 14, 1)], []])

        assert result["total"] == 1
        assert result["truncated"] is False

    def test_leaves_a_name_with_no_owner_rows_listed_but_counted(self):
        # The owner cap was zero, or the rows raced a delete: the count is still the catalog's.
        result, _ = search([[match("customer_id", 14, 1)], []])

        hit = result["properties"][0]
        assert hit["owners"] == []
        assert hit["class_count"] == 14
        assert hit["owners_truncated"] is True

    def test_stringifies_ids_so_a_uuid_column_does_not_leak_its_type(self):
        import uuid

        raw = uuid.UUID(INVOICE)
        result, _ = search(
            [
                [match("customer_id", 1, 1)],
                [{"property_name": "customer_id", "class_id": raw, "class_name": "Invoice",
                  "domain_id": uuid.UUID(CUSTOMERS), "kind": "object"}],
            ]
        )

        listed = result["properties"][0]["owners"][0]
        assert listed["class_id"] == INVOICE
        assert listed["domain_id"] == CUSTOMERS
