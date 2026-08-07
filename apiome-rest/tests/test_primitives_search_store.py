"""Bounded primitives search — DWX-3.1 (private-suite#2683).

Exercises :mod:`app.primitives_search_store` against a scripted fake connection, following the
``test_workspace_property_store.py`` precedent. No live Postgres here: this asserts the SQL these
functions emit, how many statements they emit it in, and how rows become a page. That the SQL
*classifies correctly* — that ``SCOPE_EXPRESSION`` puts every row in the tab
:func:`~app.primitives_search_store.classify_scope` puts it in — is proven against a server in
``test_primitives_search_db.py``, because only real rows can prove it.

The properties that get the most attention, because each fails silently:

* **No page exceeds its limit.** The statement asks for ``limit + 1`` rows so it can tell whether
  there is a next page; returning that extra row would break the endpoint's one hard promise.
* **The counts are the match set, not the page.** Switching tabs must not need a second request,
  and a badge derived from the returned rows would read ``25`` forever.
* **A cursor is refused, never ignored.** Silently dropping a malformed cursor restarts a paging
  client at page one, which it cannot detect and will therefore do forever.
* **A wildcard in a query matches itself.** A type named ``pct_%`` must not search for everything.
* **The scope vocabulary is closed.** A misspelled scope that quietly listed every tab would make
  an unbounded read look like a bounded one.
* **Reads commit.** A SELECT opens a transaction too; leaving the shared connection idle in one
  holds locks and blocks VACUUM.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.primitives_search_store import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    SCOPES,
    InvalidCursorError,
    clamp_limit,
    classify_scope,
    decode_cursor,
    encode_cursor,
    normalize_namespace,
    normalize_query,
    normalize_scope,
    search_primitives,
)

TENANT = "11111111-1111-1111-1111-111111111111"

#: The canonical scope cases, shared with the designer's jest parity test. See the file's own
#: ``purpose`` field.
_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "primitive_scope_cases.json").read_text("utf-8")
)

#: Pinned so a one-sided edit of the two fixture copies fails here rather than drifting silently.
EXPECTED_FIXTURE_REVISION = 1


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

    def fetchall(self) -> List[Dict[str, Any]]:
        return list(self.conn.current or [])

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *_exc: Any) -> None:
        return None


class FakeConnection:
    """A connection that replays a scripted list of result sets, one per statement."""

    def __init__(self, results: Sequence[Sequence[Dict[str, Any]]]) -> None:
        self.results = [list(r) for r in results]
        self.statements: List[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self._index = -1

    def _advance(self) -> None:
        self._index += 1

    @property
    def current(self) -> List[Dict[str, Any]]:
        if 0 <= self._index < len(self.results):
            return self.results[self._index]
        return []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeDb:
    """Database handle exposing the one method the store uses."""

    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn

    def connect(self) -> FakeConnection:
        return self.conn


def counts_rows(**by_scope: int) -> List[Dict[str, Any]]:
    """The counts statement's result set."""
    return [{"scope": scope, "n": n} for scope, n in by_scope.items()]


def row(
    name: str,
    *,
    primitive_id: Optional[str] = None,
    namespace: Optional[str] = "std/v0/types",
    scope: str = "core",
    rank: int = 0,
) -> Dict[str, Any]:
    """One row of the page statement, carrying the internal ordering columns too."""
    sort_key = f"{namespace}/{name}" if namespace else name
    return {
        "id": primitive_id or f"00000000-0000-4000-8000-{abs(hash(name)) % 10**12:012d}",
        "tenant_id": TENANT,
        "name": name,
        "description": None,
        "category": "string",
        "schema": {"type": "string"},
        "tags": [],
        "created_by": None,
        "is_system": scope in ("standard", "core"),
        "is_public": False,
        "usage_count": 0,
        "source": "imported" if scope == "custom" else "human",
        "schema_id": None,
        "draft": "2020-12",
        "namespace": namespace,
        "base_uri": None,
        "refs": [],
        "created_at": None,
        "updated_at": None,
        "scope": scope,
        "type_ref": sort_key if namespace else None,
        "sort_key": sort_key,
        "namespace_key": namespace or "",
        "rank": rank,
    }


def run(
    results: Sequence[Sequence[Dict[str, Any]]], **kwargs: Any
) -> tuple[Dict[str, Any], FakeConnection]:
    """Run one search against scripted results and hand back the answer and the connection."""
    conn = FakeConnection(results)
    result = search_primitives(FakeDb(conn), tenant_id=TENANT, **kwargs)
    return result, conn


# ─── Parameter normalization ─────────────────────────────────────────────────


class TestNormalization:
    """The parameters, before any statement is built."""

    def test_query_is_trimmed(self) -> None:
        assert normalize_query("  date  ") == "date"

    def test_missing_query_is_empty_not_none(self) -> None:
        assert normalize_query(None) == ""

    def test_no_minimum_query_length(self) -> None:
        """Unlike the palette, a one-character query is answered: every page is capped anyway."""
        assert normalize_query("d") == "d"

    def test_namespace_loses_trailing_slashes(self) -> None:
        assert normalize_namespace("std/v0/types//") == "std/v0/types"

    def test_blank_namespace_is_no_filter(self) -> None:
        """`?namespace=` is an unfilled form field, not a request for the namespace-less rows."""
        assert normalize_namespace("   ") is None
        assert normalize_namespace(None) is None

    @pytest.mark.parametrize("scope", SCOPES)
    def test_every_tab_is_accepted(self, scope: str) -> None:
        assert normalize_scope(scope.upper()) == scope

    def test_absent_scope_means_every_scope(self) -> None:
        assert normalize_scope(None) is None
        assert normalize_scope("") is None

    def test_unknown_scope_is_refused(self) -> None:
        """Refused, not ignored: a silently-ignored scope would list every tab at once."""
        with pytest.raises(ValueError) as exc:
            normalize_scope("standrad")
        assert "standrad" in str(exc.value)

    def test_limit_defaults(self) -> None:
        assert clamp_limit(None) == DEFAULT_LIMIT

    def test_limit_is_clamped_not_rejected(self) -> None:
        assert clamp_limit(5_000) == MAX_LIMIT
        assert clamp_limit(-3) == 0

    def test_limit_zero_is_meaningful(self) -> None:
        assert clamp_limit(0) == 0


# ─── Cursor ──────────────────────────────────────────────────────────────────


class TestCursor:
    """The opaque continuation token."""

    def test_round_trips(self) -> None:
        token = encode_cursor(1, "std/v0/types/date", TENANT)
        assert decode_cursor(token) == (1, "std/v0/types/date", TENANT)

    def test_is_url_safe_and_unpadded(self) -> None:
        token = encode_cursor(0, "tenant/acme/types/sku?&=", TENANT)
        assert "=" not in token and "+" not in token and "/" not in token

    def test_absent_cursor_is_no_position(self) -> None:
        assert decode_cursor(None) is None
        assert decode_cursor("  ") is None

    @pytest.mark.parametrize(
        "bad",
        [
            "not-base64!!",
            "*",
            # Valid base64 that decodes to bytes which are not UTF-8 JSON.
            "_____w",
            # Valid base64 of valid JSON that is not an object.
            "WzEsMiwzXQ",
        ],
    )
    def test_garbage_is_refused(self, bad: str) -> None:
        with pytest.raises(InvalidCursorError):
            decode_cursor(bad)

    def test_a_cursor_from_another_version_is_refused(self) -> None:
        """Misreading a cursor skips or repeats rows without saying so; refusing one is loud."""
        import base64

        payload = base64.urlsafe_b64encode(b'{"v":99,"r":0,"k":"a","i":"b"}').decode().rstrip("=")
        with pytest.raises(InvalidCursorError):
            decode_cursor(payload)

    def test_a_cursor_missing_its_position_is_refused(self) -> None:
        import base64

        payload = base64.urlsafe_b64encode(b'{"v":1,"r":0,"k":"a"}').decode().rstrip("=")
        with pytest.raises(InvalidCursorError):
            decode_cursor(payload)


# ─── Statements ──────────────────────────────────────────────────────────────


class TestStatements:
    """What the store asks the database, and how often."""

    def test_two_statements_for_a_page(self) -> None:
        _, conn = run([counts_rows(core=1), [row("date")]], limit=5)
        assert len(conn.statements) == 2

    def test_a_badges_only_request_costs_one_statement(self) -> None:
        """`limit=0` asks for the tab counts alone; there is no page to fetch."""
        result, conn = run([counts_rows(core=3, tenant=2)], limit=0)
        assert len(conn.statements) == 1
        assert result["items"] == []
        assert result["counts"]["core"] == 3

    def test_reads_commit(self) -> None:
        _, conn = run([counts_rows(), []], limit=5)
        assert conn.commits == 1 and conn.rollbacks == 0

    def test_a_failed_read_rolls_back(self) -> None:
        class Exploding(FakeConnection):
            def cursor(self) -> Any:
                raise RuntimeError("boom")

        conn = Exploding([])
        with pytest.raises(RuntimeError):
            search_primitives(FakeDb(conn), tenant_id=TENANT, limit=5)
        assert conn.rollbacks == 1 and conn.commits == 0

    def test_visibility_is_the_tenant_and_the_system_rows(self) -> None:
        _, conn = run([counts_rows(), []], limit=5)
        sql, params = conn.statements[0]
        assert "tenant_id = %s OR is_system = true" in sql
        assert params[:2] == (TENANT, TENANT)

    def test_rows_are_deduplicated_by_identity(self) -> None:
        """Same dedupe as the classic listing, so the two shapes list the same catalog."""
        sql, _ = run([counts_rows(), []], limit=5)[1].statements[0]
        assert "DISTINCT ON (namespace, name)" in sql

    def test_the_page_asks_for_one_more_row_than_it_returns(self) -> None:
        _, conn = run([counts_rows(core=1), [row("date")]], limit=25)
        _, params = conn.statements[1]
        assert params[-1] == 26

    def test_the_page_orders_by_rank_then_ref_then_id(self) -> None:
        sql, _ = run([counts_rows(), [row("date")]], limit=5)[1].statements[1]
        assert "ORDER BY rank ASC, sort_key ASC, id ASC" in sql

    def test_a_query_matches_the_five_documented_fields(self) -> None:
        sql, params = run([counts_rows(), []], query="dat", limit=5)[1].statements[0]
        for field in ("name ILIKE", "namespace, '') ILIKE", "type_ref, '') ILIKE",
                      "schema_id, '') ILIKE", "description, '') ILIKE", "unnest("):
            assert field in sql, field
        assert params.count("%dat%") == 6

    def test_a_wildcard_in_a_query_matches_itself(self) -> None:
        _, conn = run([counts_rows(), []], query="pct_%", limit=5)
        _, params = conn.statements[0]
        assert "%pct\\_\\%%" in params

    def test_a_prefix_match_outranks_a_containment_one(self) -> None:
        sql, params = run([counts_rows(), []], query="dat", limit=5)[1].statements[0]
        assert "THEN 0 ELSE 1 END" in sql
        assert "dat%" in params

    def test_an_empty_query_ranks_every_row_equally(self) -> None:
        """With nothing to rank by, the ordering reduces to the alphabetical listing."""
        sql, params = run([counts_rows(), []], limit=5)[1].statements[0]
        assert "(0) AS rank" in " ".join(sql.split())
        assert not any(isinstance(p, str) and p.endswith("%") for p in params)

    def test_the_counts_ignore_the_scope_filter(self) -> None:
        """The badges are the four tab sizes for this query; filtering them would flatten three."""
        _, conn = run([counts_rows(core=4), [row("date")]], scope="core", limit=5)
        counts_sql, _ = conn.statements[0]
        page_sql, page_params = conn.statements[1]
        assert "scope = %s" not in counts_sql
        assert "scope = %s" in page_sql
        assert "core" in page_params

    def test_a_cursor_becomes_a_row_comparison(self) -> None:
        _, conn = run(
            [counts_rows(core=9), [row("date")]],
            limit=5,
            cursor=(0, "std/v0/types/city", "00000000-0000-4000-8000-000000000001"),
        )
        page_sql, page_params = conn.statements[1]
        assert "(rank, sort_key, id) > (%s, %s, %s::uuid)" in page_sql
        assert "std/v0/types/city" in page_params

    def test_namespace_and_category_narrow_the_match(self) -> None:
        _, conn = run(
            [counts_rows(), []], namespace="std/v0/types", category="string", limit=5
        )
        sql, params = conn.statements[0]
        assert "category = %s" in sql and "namespace_key = %s" in sql
        assert "string" in params and "std/v0/types" in params


# ─── Projection ──────────────────────────────────────────────────────────────


class TestPage:
    """What the store hands back."""

    def test_no_page_exceeds_its_limit(self) -> None:
        """The extra row exists to answer 'is there more', and must never be returned."""
        rows = [row(f"t{i}") for i in range(4)]
        result, _ = run([counts_rows(core=9), rows], limit=3)
        assert len(result["items"]) == 3

    def test_the_extra_row_becomes_the_next_cursor(self) -> None:
        rows = [row("alpha"), row("beta"), row("gamma"), row("delta")]
        result, _ = run([counts_rows(core=9), rows], limit=3)
        assert decode_cursor(result["next_cursor"]) == (0, rows[2]["sort_key"], rows[2]["id"])

    def test_the_last_page_offers_no_cursor(self) -> None:
        """A cursor handed out at the end would return an empty page forever."""
        result, _ = run([counts_rows(core=2), [row("alpha"), row("beta")]], limit=5)
        assert result["next_cursor"] is None
        assert result["truncated"] is False

    def test_every_tab_has_a_number_even_when_it_has_no_rows(self) -> None:
        result, _ = run([counts_rows(core=2), [row("alpha")]], limit=5)
        assert set(result["counts"]) == set(SCOPES)
        assert result["counts"]["custom"] == 0

    def test_total_is_the_applied_scope_when_one_is_named(self) -> None:
        result, _ = run(
            [counts_rows(standard=7, core=4, tenant=1), [row("alpha")]], scope="core", limit=5
        )
        assert result["total"] == 4

    def test_total_is_every_scope_when_none_is_named(self) -> None:
        result, _ = run([counts_rows(standard=7, core=4, tenant=1), [row("alpha")]], limit=5)
        assert result["total"] == 12

    def test_items_carry_their_tab(self) -> None:
        result, _ = run([counts_rows(custom=1), [row("Sku", scope="custom")]], limit=5)
        assert result["items"][0]["scope"] == "custom"

    def test_items_drop_the_internal_ordering_columns(self) -> None:
        """`sort_key`, `namespace_key`, `rank` and `type_ref` are how the page is built, not what
        it means; leaking them would make them contract."""
        result, _ = run([counts_rows(core=1), [row("date")]], limit=5)
        item = result["items"][0]
        for internal in ("sort_key", "namespace_key", "rank", "type_ref"):
            assert internal not in item
        assert item["name"] == "date"

    def test_a_badges_only_answer_admits_it_is_not_the_whole(self) -> None:
        result, _ = run([counts_rows(core=9)], limit=0)
        assert result["truncated"] is True and result["total"] == 9

    def test_the_applied_limit_comes_back(self) -> None:
        result, _ = run([counts_rows(), []], limit=7)
        assert result["limit"] == 7


# ─── Scope parity ────────────────────────────────────────────────────────────


class TestScopeClassification:
    """The Python half of the three-way parity chain.

    The designer's ``classifyPrimitive`` is checked against the same fixture in
    ``private-suite/designer/tests/unit/workspace-primitives-scope-parity.test.ts``, and the SQL is
    checked against this function over the same rows in ``test_primitives_search_db.py``.
    """

    def test_the_fixture_has_not_drifted(self) -> None:
        assert _FIXTURE["revision"] == EXPECTED_FIXTURE_REVISION

    @pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda c: c["why"][:60])
    def test_matches_the_shared_fixture(self, case: Dict[str, Any]) -> None:
        assert (
            classify_scope(case["is_system"], case["namespace"], case["source"])
            == case["expected"]
        )

    def test_every_expectation_is_a_real_tab(self) -> None:
        assert {case["expected"] for case in _FIXTURE["cases"]} <= set(SCOPES)

    def test_the_fixture_covers_all_four_tabs(self) -> None:
        assert {case["expected"] for case in _FIXTURE["cases"]} == set(SCOPES)
