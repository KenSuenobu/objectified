"""Selection-scoped catalog persistence — DUW-1.2 (private-suite#2569).

Exercises :mod:`app.scoped_catalog_store` against a scripted fake connection, following the
``test_domains_store.py`` precedent. No live Postgres here: this asserts the SQL these functions
emit, the number of statements they emit it in, and the transaction discipline around them. That
the SQL is *right* — that a domain filter really selects a folder, that ordering is stable across a
real catalog — is proven against a server in ``test_scoped_catalog_db.py``.

The properties that get the most attention, because each fails silently:

* **A bounded read stays a bulk read.** Three statements for classes and two for paths, whatever
  the page size. An N+1 introduced here would pass every functional test and only show up as
  latency on a catalog nobody has in a test fixture.
* **Every read is scoped by version, even in id mode.** That predicate is the tenancy boundary; an
  id-only WHERE clause would return another tenant's class to a caller who guessed its UUID.
* **Ids that do not resolve are named.** A selection can outlive what it selects, and a silently
  short response leaves a hole on the canvas with no explanation.
* **Reads commit.** A SELECT opens a transaction too; leaving the shared connection idle in one
  holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.scoped_catalog_store import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    clamp_page_size,
    load_classes_by_domain,
    load_classes_by_ids,
    load_paths_by_domain,
    load_paths_by_ids,
    normalize_ids,
)

VERSION = "11111111-1111-1111-1111-111111111111"
DOMAIN = "22222222-2222-2222-2222-222222222222"
CLASS_A = "33333333-3333-3333-3333-33333333aaaa"
CLASS_B = "33333333-3333-3333-3333-33333333bbbb"
CLASS_C = "33333333-3333-3333-3333-33333333cccc"
PATH_A = "44444444-4444-4444-4444-44444444aaaa"
PATH_B = "44444444-4444-4444-4444-44444444bbbb"


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

    def fetchone(self) -> Optional[Dict[str, Any]]:
        value = self.conn._take()
        if isinstance(value, list):
            return value[0] if value else None
        return value

    def fetchall(self) -> List[Dict[str, Any]]:
        value = self.conn._take()
        return value if isinstance(value, list) else ([] if value is None else [value])

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeConnection:
    """A psycopg2-shaped connection whose results are scripted per statement.

    Counts ``commit``/``rollback``, because "the read committed" is one of the things these tests
    exist to prove.
    """

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


def class_row(class_id: str, name: str, **overrides) -> Dict[str, Any]:
    row = {
        "id": class_id,
        "version_id": VERSION,
        "domain_id": DOMAIN,
        "name": name,
        "description": None,
        "schema": {},
        "enabled": True,
        "canvas_metadata": {},
        "created_at": "2026-08-04T00:00:00Z",
        "updated_at": "2026-08-04T00:00:00Z",
    }
    row.update(overrides)
    return row


def path_row(path_id: str, pathname: str, **overrides) -> Dict[str, Any]:
    row = {
        "id": path_id,
        "version_id": VERSION,
        "domain_id": DOMAIN,
        "pathname": pathname,
        "metadata": {},
        "summary": None,
        "description": None,
        "created_at": "2026-08-04T00:00:00Z",
        "updated_at": "2026-08-04T00:00:00Z",
    }
    row.update(overrides)
    return row


class TestNormalizeIds:
    """The id selector accepts both spellings a client may naturally send."""

    def test_repeated_parameters(self):
        assert normalize_ids([CLASS_A, CLASS_B]) == ([CLASS_A, CLASS_B], [])

    def test_comma_separated_values(self):
        assert normalize_ids([f"{CLASS_A},{CLASS_B}"]) == ([CLASS_A, CLASS_B], [])

    def test_the_two_spellings_mix(self):
        ids, malformed = normalize_ids([f"{CLASS_A},{CLASS_B}", CLASS_C])
        assert ids == [CLASS_A, CLASS_B, CLASS_C]
        assert malformed == []

    def test_duplicates_collapse_so_they_are_charged_once_against_the_cap(self):
        ids, _ = normalize_ids([CLASS_A, CLASS_A, f"{CLASS_A},{CLASS_B}"])
        assert ids == [CLASS_A, CLASS_B]

    def test_order_is_preserved(self):
        ids, _ = normalize_ids([CLASS_C, CLASS_A, CLASS_B])
        assert ids == [CLASS_C, CLASS_A, CLASS_B]

    def test_blank_entries_are_dropped_not_reported(self):
        # `?class_ids=a,,b` is punctuation, not a request for a class named "".
        ids, malformed = normalize_ids([f"{CLASS_A},,{CLASS_B}", "   "])
        assert ids == [CLASS_A, CLASS_B]
        assert malformed == []

    def test_non_uuids_are_separated_rather_than_sent_to_postgres(self):
        # Reaching the `::uuid` cast would raise InvalidTextRepresentation — a 500 for what is
        # really "no such class".
        ids, malformed = normalize_ids([CLASS_A, "not-an-id"])
        assert ids == [CLASS_A]
        assert malformed == ["not-an-id"]

    def test_none_selects_nothing(self):
        assert normalize_ids(None) == ([], [])


class TestClampPageSize:
    def test_absent_limit_takes_the_default(self):
        assert clamp_page_size(None) == DEFAULT_PAGE_SIZE

    def test_a_limit_over_the_cap_is_clamped_not_rejected(self):
        # A domain listing always hands back a cursor, so the caller has a working continuation.
        assert clamp_page_size(10_000) == MAX_PAGE_SIZE

    def test_a_limit_under_one_still_returns_a_page(self):
        assert clamp_page_size(0) == 1
        assert clamp_page_size(-5) == 1

    def test_a_limit_inside_the_cap_is_honoured(self):
        assert clamp_page_size(7) == 7


class TestLoadClassesByIds:
    def test_three_ids_yield_three_classes_in_three_statements(self):
        # The ticket's first acceptance criterion, and the property that makes it cheap: hydration
        # cost tracks the selection, not the catalog.
        conn = FakeConnection(
            [
                [class_row(CLASS_A, "Address"), class_row(CLASS_B, "Customer"), class_row(CLASS_C, "Order")],
                [{"id": "p1", "class_id": CLASS_B, "name": "id"}],
                [{"id": "t1", "class_id": CLASS_B, "tag_name": "core"}],
            ]
        )
        page = load_classes_by_ids(
            FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A, CLASS_B, CLASS_C]
        )

        assert [c["name"] for c in page.items] == ["Address", "Customer", "Order"]
        assert page.total == 3
        assert page.missing_ids == []
        # An id selection is the page; there is nothing to continue to.
        assert page.next_offset is None
        assert len(conn.statements) == 3

    def test_properties_and_tags_land_on_their_own_class(self):
        conn = FakeConnection(
            [
                [class_row(CLASS_A, "Address"), class_row(CLASS_B, "Customer")],
                [
                    {"id": "p1", "class_id": CLASS_A, "name": "street"},
                    {"id": "p2", "class_id": CLASS_B, "name": "id"},
                    {"id": "p3", "class_id": CLASS_B, "name": "name"},
                ],
                [{"id": "t1", "class_id": CLASS_B, "tag_name": "core"}],
            ]
        )
        page = load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A, CLASS_B])

        by_name = {c["name"]: c for c in page.items}
        assert [p["name"] for p in by_name["Address"]["properties"]] == ["street"]
        assert [p["name"] for p in by_name["Customer"]["properties"]] == ["id", "name"]
        # A class with no tags gets an empty list, not a missing key — the client renders it either
        # way and a second query to establish emptiness would be waste.
        assert by_name["Address"]["tags"] == []
        assert [t["tag_name"] for t in by_name["Customer"]["tags"]] == ["core"]

    def test_the_selection_is_scoped_by_version_not_by_id_alone(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A])

        query, params = conn.statements[0]
        assert "version_id = %s::uuid" in query
        assert "deleted_at IS NULL" in query
        assert params[0] == VERSION

    def test_ordering_is_stable(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A])

        # Name alone is not a total order across a soft-deleted collision; the id breaks the tie so
        # two identical requests place canvas nodes identically.
        assert "ORDER BY name ASC, id ASC" in conn.statements[0][0]

    def test_ids_that_no_longer_resolve_are_named(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        page = load_classes_by_ids(
            FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A, CLASS_B, CLASS_C]
        )

        assert page.total == 1
        assert page.missing_ids == [CLASS_B, CLASS_C]

    def test_malformed_entries_join_the_missing_ids(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        page = load_classes_by_ids(
            FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A], malformed_ids=["nope"]
        )

        assert page.missing_ids == ["nope"]

    def test_a_differently_spelled_id_is_not_reported_missing(self):
        # Postgres accepts uppercase and unhyphenated UUIDs but never emits them. Comparing raw
        # strings would report a class as missing that is right there in `items`.
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        page = load_classes_by_ids(
            FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A.upper().replace("-", "")]
        )

        assert page.total == 1
        assert page.missing_ids == []

    def test_an_empty_selection_never_touches_the_database(self):
        conn = FakeConnection([])
        page = load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[])

        assert page.items == []
        assert page.total == 0
        assert conn.statements == []

    def test_a_selection_that_resolves_to_nothing_skips_hydration(self):
        conn = FakeConnection([[]])
        page = load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A])

        assert page.items == []
        assert page.missing_ids == [CLASS_A]
        assert len(conn.statements) == 1

    def test_the_read_commits(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")], [], []])
        load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A])

        assert conn.commits == 1
        assert conn.rollbacks == 0

    def test_a_failed_read_rolls_back(self):
        conn = FakeConnection([[class_row(CLASS_A, "Address")]])
        conn.raise_on = ("class_properties", RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            load_classes_by_ids(FakeDb(conn), version_id=VERSION, class_ids=[CLASS_A])

        assert conn.rollbacks == 1
        assert conn.commits == 0


class TestLoadClassesByDomain:
    def test_it_pages_and_reports_the_whole_membership(self):
        conn = FakeConnection(
            [
                {"n": 40},
                [class_row(CLASS_A, "Address"), class_row(CLASS_B, "Customer")],
                [],
                [],
            ]
        )
        page = load_classes_by_domain(
            FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=2, offset=0
        )

        assert len(page.items) == 2
        # `total` is the folder, not the page — that is what the node-budget notice is sized on.
        assert page.total == 40
        assert page.next_offset == 2
        assert len(conn.statements) == 4

    def test_the_last_page_offers_no_cursor(self):
        conn = FakeConnection([{"n": 3}, [class_row(CLASS_C, "Order")], [], []])
        page = load_classes_by_domain(
            FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=2, offset=2
        )

        assert page.next_offset is None

    def test_paging_past_the_end_terminates(self):
        # Without the empty-page guard a client that paged too far would be handed a cursor
        # pointing at the same empty page forever.
        conn = FakeConnection([{"n": 3}, []])
        page = load_classes_by_domain(
            FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=2, offset=99
        )

        assert page.items == []
        assert page.next_offset is None

    def test_the_shared_bucket_is_a_null_predicate_not_a_value(self):
        conn = FakeConnection([{"n": 8}, [class_row(CLASS_A, "Address", domain_id=None)], [], []])
        load_classes_by_domain(FakeDb(conn), version_id=VERSION, domain_id=None, limit=50)

        count_query, count_params = conn.statements[0]
        assert "domain_id IS NULL" in count_query
        # Only the version is bound: there is no id for "no domain".
        assert count_params == (VERSION,)

    def test_a_real_domain_binds_its_id(self):
        conn = FakeConnection([{"n": 1}, [class_row(CLASS_A, "Address")], [], []])
        load_classes_by_domain(FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=50)

        count_query, count_params = conn.statements[0]
        assert "domain_id = %s::uuid" in count_query
        assert count_params == (VERSION, DOMAIN)

    def test_the_page_is_limited_in_sql_not_in_python(self):
        conn = FakeConnection([{"n": 500}, [class_row(CLASS_A, "Address")], [], []])
        load_classes_by_domain(
            FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=25, offset=75
        )

        page_query, page_params = conn.statements[1]
        assert "LIMIT %s OFFSET %s" in page_query
        assert page_params[-2:] == (25, 75)

    def test_a_domain_listing_reports_no_missing_ids(self):
        conn = FakeConnection([{"n": 1}, [class_row(CLASS_A, "Address")], [], []])
        page = load_classes_by_domain(FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=50)

        assert page.missing_ids == []


class TestLoadPathsByIds:
    def test_two_ids_yield_two_paths_in_two_statements(self):
        conn = FakeConnection(
            [
                [path_row(PATH_A, "/customers"), path_row(PATH_B, "/customers/{id}")],
                [
                    {"id": "o1", "version_path_id": PATH_A, "operation": "GET"},
                    {"id": "o2", "version_path_id": PATH_A, "operation": "POST"},
                ],
            ]
        )
        page = load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A, PATH_B])

        assert [p["pathname"] for p in page.items] == ["/customers", "/customers/{id}"]
        assert [o["operation"] for o in page.items[0]["operations"]] == ["GET", "POST"]
        assert page.items[1]["operations"] == []
        assert len(conn.statements) == 2

    def test_operations_are_one_bulk_read_not_one_per_path(self):
        conn = FakeConnection([[path_row(PATH_A, "/a"), path_row(PATH_B, "/b")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A, PATH_B])

        ops_query, ops_params = conn.statements[1]
        assert "version_path_id = ANY(%s::uuid[])" in ops_query
        assert ops_params == ([PATH_A, PATH_B],)

    def test_operations_carry_their_operation_id_and_summary(self):
        # The mockup's paths lens draws the operationId beside every verb; without the join the
        # tree would need a round trip per operation to render a row.
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        ops_query = conn.statements[1][0]
        assert "path_operation_description" in ops_query
        assert "pod.operation_id" in ops_query
        assert "LEFT JOIN" in ops_query  # an operation with no description row still appears

    def test_operations_carry_the_status_codes_they_declare(self):
        # The paths lens draws `200·400·401` on every lane (private-suite#2583); the aggregate
        # rides the statement the operations already cost rather than buying one per operation.
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        ops_query = conn.statements[1][0]
        assert "path_operation_response_link" in ops_query
        assert "shared_path_response" in ops_query
        assert "array_agg(spr.status_code ORDER BY spr.status_code)" in ops_query
        # An operation that declares none renders an empty lane, not a missing key.
        assert "COALESCE(codes.response_codes, ARRAY[]::text[])" in ops_query

    def test_the_status_codes_cost_no_extra_statement(self):
        conn = FakeConnection([[path_row(PATH_A, "/a"), path_row(PATH_B, "/b")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A, PATH_B])

        assert len(conn.statements) == 2

    def test_the_response_bodies_themselves_stay_with_the_per_path_read(self):
        # Only the label is bulk-read: schemas, content types and examples are inspector-sized
        # data for one selected operation, which is the habit this endpoint exists to break.
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        ops_query = conn.statements[1][0]
        assert "shared_path_response_content" not in ops_query
        assert "inline_schema" not in ops_query
        assert "spr.data" not in ops_query

    def test_operations_order_by_http_method(self):
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        assert "WHEN 'GET' THEN 1" in conn.statements[1][0]

    def test_paths_have_no_soft_delete_predicate(self):
        # `apiome.version_path` has no `deleted_at`; asserting one would be a silent empty result.
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        assert "deleted_at" not in conn.statements[0][0]

    def test_the_read_is_version_scoped_and_stably_ordered(self):
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        query, params = conn.statements[0]
        assert "version_id = %s::uuid" in query
        assert "ORDER BY pathname ASC, id ASC" in query
        assert params[0] == VERSION

    def test_ids_that_no_longer_resolve_are_named(self):
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        page = load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A, PATH_B])

        assert page.missing_ids == [PATH_B]

    def test_the_read_commits(self):
        conn = FakeConnection([[path_row(PATH_A, "/a")], []])
        load_paths_by_ids(FakeDb(conn), version_id=VERSION, path_ids=[PATH_A])

        assert conn.commits == 1


class TestLoadPathsByDomain:
    def test_it_pages_and_reports_the_whole_membership(self):
        conn = FakeConnection([{"n": 218}, [path_row(PATH_A, "/a"), path_row(PATH_B, "/b")], []])
        page = load_paths_by_domain(
            FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=2, offset=0
        )

        assert len(page.items) == 2
        assert page.total == 218
        assert page.next_offset == 2
        assert len(conn.statements) == 3

    def test_the_shared_bucket_is_a_null_predicate(self):
        conn = FakeConnection([{"n": 4}, [path_row(PATH_A, "/a", domain_id=None)], []])
        load_paths_by_domain(FakeDb(conn), version_id=VERSION, domain_id=None, limit=50)

        query, params = conn.statements[0]
        assert "domain_id IS NULL" in query
        assert params == (VERSION,)

    def test_the_read_commits(self):
        conn = FakeConnection([{"n": 1}, [path_row(PATH_A, "/a")], []])
        load_paths_by_domain(FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=50)

        assert conn.commits == 1

    def test_a_failed_read_rolls_back(self):
        conn = FakeConnection([{"n": 1}])
        conn.raise_on = ("ORDER BY pathname", RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            load_paths_by_domain(FakeDb(conn), version_id=VERSION, domain_id=DOMAIN, limit=50)

        assert conn.rollbacks == 1
