"""Domain summary aggregation — DUW-1.3 (private-suite#2570).

Exercises :mod:`app.workspace_summary_store` against a scripted fake connection, following the
``test_scoped_catalog_store.py`` precedent. No live Postgres here: this asserts the SQL these
functions emit, the number of statements they emit it in, and how rows are projected onto folders.
That the SQL *counts correctly* — that a badge equals what a ``SELECT COUNT(*)`` says — is proven
against a server in ``test_workspace_summary_db.py``, because only a real catalog can prove it.

The properties that get the most attention, because each fails silently:

* **One pass per member kind.** Four statements, whatever the version holds. A per-domain count
  query would be an N+1 that passes every functional test and only shows as latency on a catalog
  no fixture has.
* **`shared/` survives the join.** Its domain is NULL on both sides; ``NULL = NULL`` would drop the
  largest folder in most catalogs, silently, leaving it badged with zeroes.
* **A count is never a page's length.** Counts come from an aggregate over the whole version, so
  capping the member list must not move a badge.
* **Every folder appears**, including one with no members — a newly created folder that vanished
  from the tree would read as a failed write.
* **Reads commit.** A SELECT opens a transaction too; leaving the shared connection idle in one
  holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.workspace_summary_store import (
    DEFAULT_MEMBER_LIMIT,
    MAX_MEMBER_LIMIT,
    clamp_member_limit,
    load_version_summary,
    version_badge,
)

VERSION = "11111111-1111-1111-1111-111111111111"
CUSTOMERS = "22222222-2222-2222-2222-2222222222aa"
BILLING = "22222222-2222-2222-2222-2222222222bb"
CLASS_A = "33333333-3333-3333-3333-33333333aaaa"
CLASS_B = "33333333-3333-3333-3333-33333333bbbb"
ENUM_A = "33333333-3333-3333-3333-33333333eeee"
PATH_A = "44444444-4444-4444-4444-44444444aaaa"
PATH_B = "44444444-4444-4444-4444-44444444bbbb"
OP_A = "55555555-5555-5555-5555-55555555aaaa"
OP_B = "55555555-5555-5555-5555-55555555bbbb"


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


def domain_row(domain_id: str, slug: str, sort_order: int) -> Dict[str, Any]:
    """One ``apiome.domains`` row as the domains statement returns it."""
    return {
        "id": domain_id,
        "version_id": VERSION,
        "name": slug,
        "slug": slug,
        "sort_order": sort_order,
        "deleted_at": None,
        "created_at": "2026-08-04T00:00:00Z",
        "updated_at": "2026-08-04T00:00:00Z",
    }


def class_agg(
    domain_id: Optional[str],
    *,
    class_count: int,
    enum_count: int = 0,
    member: Optional[tuple] = None,
    rn: Optional[int] = None,
) -> Dict[str, Any]:
    """One row of the class statement: a folder's counts, optionally carrying a member.

    Args:
        domain_id: The folder, or None for ``shared/``.
        class_count: The folder's object-schema count, repeated on every one of its rows.
        enum_count: The folder's enum/union count.
        member: ``(id, name, kind)`` when this row carries a member, None when the folder has
            none — the LEFT JOIN's NULL-member row, which exists so the counts survive.
        rn: The member's rank within its folder.
    """
    row = {
        "domain_id": domain_id,
        "class_count": class_count,
        "enum_count": enum_count,
        "id": None,
        "name": None,
        "kind": None,
        "rn": rn,
    }
    if member is not None:
        row["id"], row["name"], row["kind"] = member
    return row


def path_agg(
    domain_id: Optional[str],
    *,
    path_count: int,
    op_count: int,
    member: Optional[tuple] = None,
    rn: Optional[int] = None,
) -> Dict[str, Any]:
    """One row of the path statement: a folder's counts, optionally carrying a member.

    Args:
        domain_id: The folder, or None for ``shared/``.
        path_count: The folder's path count.
        op_count: The folder's operation count across all its paths.
        member: ``(id, pathname, op_count)`` when this row carries a path.
        rn: The member's rank within its folder.
    """
    row = {
        "domain_id": domain_id,
        "path_count": path_count,
        "domain_op_count": op_count,
        "id": None,
        "pathname": None,
        "path_op_count": None,
        "rn": rn,
    }
    if member is not None:
        row["id"], row["pathname"], row["path_op_count"] = member
    return row


def operation_row(op_id: str, path_id: str, verb: str, **overrides) -> Dict[str, Any]:
    """One row of the operations statement."""
    row = {
        "id": op_id,
        "version_path_id": path_id,
        "operation": verb,
        "operation_id": None,
        "summary": None,
        "deprecated": False,
    }
    row.update(overrides)
    return row


def one_folder_script() -> List[Any]:
    """Results for a version with one folder holding two classes, one enum and one path."""
    return [
        [domain_row(CUSTOMERS, "customers", 0)],
        [
            class_agg(CUSTOMERS, class_count=2, enum_count=1, member=(CLASS_A, "Address", "object"), rn=1),
            class_agg(CUSTOMERS, class_count=2, enum_count=1, member=(CLASS_B, "Customer", "object"), rn=2),
            class_agg(CUSTOMERS, class_count=2, enum_count=1, member=(ENUM_A, "CountryCode", "enum"), rn=3),
        ],
        [path_agg(CUSTOMERS, path_count=1, op_count=2, member=(PATH_A, "/customers", 2), rn=1)],
        [
            operation_row(OP_A, PATH_A, "GET", operation_id="customers.list", summary="List"),
            operation_row(OP_B, PATH_A, "POST", operation_id="customers.create"),
        ],
    ]


def summarize(results: List[Any], *, member_limit: int = 50, badge: Optional[str] = None):
    """Run the store against a scripted connection, returning ``(folders, connection)``."""
    conn = FakeConnection(results)
    folders = load_version_summary(
        FakeDb(conn), version_id=VERSION, member_limit=member_limit, badge=badge
    )
    return folders, conn


def by_slug(folders: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {folder["slug"]: folder for folder in folders}


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestOnePassPerMemberKind:
    """The cost of a summary tracks the version, not the number of folders in it."""

    def test_a_summary_is_four_statements(self):
        _, conn = summarize(one_folder_script())

        assert len(conn.statements) == 4

    def test_forty_folders_are_still_four_statements(self):
        # The N+1 this endpoint exists to prevent: a per-domain count query would make the tree's
        # first render cost one round trip per folder.
        domains = [domain_row(f"{i:08d}-0000-4000-8000-000000000000", f"d{i}", i) for i in range(40)]
        classes = [
            class_agg(d["id"], class_count=1, member=(CLASS_A, "A", "object"), rn=1)
            for d in domains
        ]
        paths = [
            path_agg(d["id"], path_count=1, op_count=1, member=(PATH_A, "/a", 1), rn=1)
            for d in domains
        ]

        folders, conn = summarize([domains, classes, paths, []])

        assert len(folders) == 41  # every folder summarized, `shared/` included
        assert len(conn.statements) == 4

    def test_a_counts_only_summary_skips_the_operations_statement(self):
        # No path row came back, so there is nothing to fetch operations for. Three statements.
        script = [
            [domain_row(CUSTOMERS, "customers", 0)],
            [class_agg(CUSTOMERS, class_count=2, enum_count=1)],
            [path_agg(CUSTOMERS, path_count=1, op_count=2)],
        ]

        folders, conn = summarize(script, member_limit=0)

        assert len(conn.statements) == 3
        assert by_slug(folders)["customers"]["class_count"] == 2

    def test_the_member_limit_reaches_both_member_statements(self):
        _, conn = summarize(one_folder_script(), member_limit=7)
        params = [statement[1] for statement in conn.statements]

        assert params[1] == (VERSION, 7)
        assert params[2] == (VERSION, 7)

    def test_operations_are_fetched_for_the_returned_paths_in_one_statement(self):
        script = one_folder_script()
        script[2] = [
            path_agg(CUSTOMERS, path_count=2, op_count=3, member=(PATH_A, "/customers", 2), rn=1),
            path_agg(CUSTOMERS, path_count=2, op_count=3, member=(PATH_B, "/customers/{id}", 1), rn=2),
        ]

        _, conn = summarize(script)
        query, params = conn.statements[3]

        assert "path_operation" in query
        assert params == ([PATH_A, PATH_B],)


class TestScoping:
    """Every statement is scoped by the version, and by nothing else."""

    @pytest.mark.parametrize("statement", [0, 1, 2])
    def test_each_aggregate_is_scoped_by_version(self, statement):
        _, conn = summarize(one_folder_script())
        query, params = conn.statements[statement]

        assert "version_id = %s::uuid" in query
        assert params[0] == VERSION

    def test_soft_deleted_classes_are_excluded(self):
        _, conn = summarize(one_folder_script())

        assert "deleted_at IS NULL" in conn.statements[1][0]

    def test_deleted_domains_are_excluded_from_the_tree(self):
        _, conn = summarize(one_folder_script())

        assert "deleted_at IS NULL" in conn.statements[0][0]

    def test_paths_have_no_soft_delete_predicate(self):
        # `apiome.version_path` carries no `deleted_at`; asking for one would be a SQL error, and
        # asserting its absence keeps a copy-paste from introducing it.
        _, conn = summarize(one_folder_script())

        assert "deleted_at" not in conn.statements[2][0]


class TestSharedBucket:
    """`shared/` is the absence of a domain, and the join must not lose it."""

    def test_the_shared_bucket_is_joined_with_is_not_distinct_from(self):
        # `NULL = NULL` is NULL, which would drop the shared folder's counts entirely.
        _, conn = summarize(one_folder_script())

        assert "IS NOT DISTINCT FROM" in conn.statements[1][0]
        assert "IS NOT DISTINCT FROM" in conn.statements[2][0]

    def test_shared_is_listed_last_and_marked_virtual(self):
        folders, _ = summarize(one_folder_script())

        assert [f["slug"] for f in folders] == ["customers", "shared"]
        assert folders[-1]["id"] is None
        assert folders[-1]["virtual"] is True

    def test_shared_collects_the_rows_with_no_domain(self):
        script = one_folder_script()
        script[1].append(
            class_agg(None, class_count=1, member=(CLASS_B, "Money", "object"), rn=1)
        )

        folders, _ = summarize(script)
        shared = by_slug(folders)["shared"]

        assert shared["class_count"] == 1
        assert [c["name"] for c in shared["classes"]] == ["Money"]

    def test_a_real_folder_does_not_absorb_the_shared_rows(self):
        script = one_folder_script()
        script[1].append(
            class_agg(None, class_count=1, member=(CLASS_B, "Money", "object"), rn=1)
        )

        folders, _ = summarize(script)

        assert [c["name"] for c in by_slug(folders)["customers"]["classes"]] == [
            "Address",
            "Customer",
            "CountryCode",
        ]

    def test_shared_appears_even_when_it_holds_nothing(self):
        folders, _ = summarize(one_folder_script())
        shared = by_slug(folders)["shared"]

        assert shared["class_count"] == 0
        assert shared["path_count"] == 0
        assert shared["classes"] == []


class TestCounts:
    """A badge covers the folder, never the page."""

    def test_counts_and_members_disagree_without_the_badge_moving(self):
        # The folder holds 40 classes; two came back. The badge still says 40.
        script = one_folder_script()
        script[1] = [
            class_agg(CUSTOMERS, class_count=40, member=(CLASS_A, "Address", "object"), rn=1),
            class_agg(CUSTOMERS, class_count=40, member=(CLASS_B, "Customer", "object"), rn=2),
        ]

        folders, _ = summarize(script, member_limit=2)
        customers = by_slug(folders)["customers"]

        assert customers["class_count"] == 40
        assert len(customers["classes"]) == 2
        assert customers["classes_truncated"] is True

    def test_a_complete_list_is_not_flagged_truncated(self):
        folders, _ = summarize(one_folder_script())
        customers = by_slug(folders)["customers"]

        assert customers["classes_truncated"] is False
        assert customers["paths_truncated"] is False

    def test_enums_count_against_the_class_list_length_not_the_class_badge(self):
        # `class_count` badges the Schemas group only; the enum is real membership all the same, so
        # a list of three under `2 + 1` is complete, not truncated.
        folders, _ = summarize(one_folder_script())
        customers = by_slug(folders)["customers"]

        assert (customers["class_count"], customers["enum_count"]) == (2, 1)
        assert len(customers["classes"]) == 3
        assert customers["classes_truncated"] is False

    def test_the_class_and_enum_counts_partition_the_folder(self):
        # The mockup badges `customers/ 3 classes` above three objects and one enum: the enum is
        # not inside the class count. Its own group carries it.
        _, conn = summarize(one_folder_script())
        query = conn.statements[1][0]

        assert "COUNT(*) FILTER (WHERE kind = 'object')" in query
        assert "COUNT(*) FILTER (WHERE kind <> 'object')" in query

    def test_a_folder_with_paths_but_no_classes_keeps_both_counts(self):
        script = one_folder_script()
        script[1] = []

        folders, _ = summarize(script)
        customers = by_slug(folders)["customers"]

        assert customers["class_count"] == 0
        assert customers["path_count"] == 1
        assert customers["op_count"] == 2

    def test_an_empty_folder_still_draws(self):
        script = [[domain_row(BILLING, "billing", 1)], [], [], []]

        folders, _ = summarize(script)
        billing = by_slug(folders)["billing"]

        assert billing["class_count"] == billing["path_count"] == billing["op_count"] == 0
        assert billing["classes"] == billing["paths"] == []
        assert billing["classes_truncated"] is False


class TestMemberRows:
    """A tree row must be renderable from the row alone, and carry nothing more."""

    def test_a_class_row_is_id_name_kind_and_badge(self):
        folders, _ = summarize(one_folder_script(), badge="v2.1")
        first = by_slug(folders)["customers"]["classes"][0]

        assert first == {
            "id": CLASS_A,
            "name": "Address",
            "kind": "object",
            "version_badge": "v2.1",
        }

    def test_no_schema_body_properties_or_tags_come_along(self):
        folders, _ = summarize(one_folder_script())

        for row in by_slug(folders)["customers"]["classes"]:
            assert not {"schema", "properties", "tags", "canvas_metadata"} & set(row)

    def test_objects_sort_before_enums_and_unions(self):
        # A truncated list is then cut from the Enums & unions group upward, which is the order the
        # mockup draws the two groups in.
        _, conn = summarize(one_folder_script())

        assert "ORDER BY (kind <> 'object'), name ASC, id ASC" in conn.statements[1][0]

    def test_a_path_row_carries_its_operations_and_its_own_count(self):
        folders, _ = summarize(one_folder_script())
        path = by_slug(folders)["customers"]["paths"][0]

        assert path["pathname"] == "/customers"
        assert path["op_count"] == 2
        assert [op["operation"] for op in path["operations"]] == ["GET", "POST"]

    def test_an_operation_row_carries_what_the_paths_lens_draws(self):
        folders, _ = summarize(one_folder_script())
        first = by_slug(folders)["customers"]["paths"][0]["operations"][0]

        assert first == {
            "id": OP_A,
            "operation": "GET",
            "operation_id": "customers.list",
            "summary": "List",
            "deprecated": False,
        }

    def test_a_path_with_no_operations_gets_an_empty_list_not_a_missing_key(self):
        script = one_folder_script()
        script[3] = []

        folders, _ = summarize(script)

        assert by_slug(folders)["customers"]["paths"][0]["operations"] == []

    def test_operations_are_ordered_by_http_method(self):
        _, conn = summarize(one_folder_script())

        assert "WHEN 'GET' THEN 1" in conn.statements[3][0]

    def test_ids_are_strings_so_the_response_model_accepts_them(self):
        # psycopg2 hands back `uuid.UUID`; a Pydantic `str` field rejects one outright.
        import uuid

        script = one_folder_script()
        script[1] = [
            class_agg(
                uuid.UUID(CUSTOMERS),
                class_count=1,
                member=(uuid.UUID(CLASS_A), "Address", "object"),
                rn=1,
            )
        ]
        script[2] = []
        script[3] = []

        folders, _ = summarize(script)

        assert by_slug(folders)["customers"]["classes"][0]["id"] == CLASS_A

    def test_a_uuid_domain_key_still_matches_its_folder(self):
        # The folders arrive from one statement and the aggregates from another; if the two are
        # keyed differently, every folder silently badges zero.
        import uuid

        script = one_folder_script()
        script[0] = [domain_row(uuid.UUID(CUSTOMERS), "customers", 0)]

        folders, _ = summarize(script)

        assert by_slug(folders)["customers"]["class_count"] == 2


class TestTransactionDiscipline:
    """A read commits, and a failed read leaves nothing open."""

    def test_a_summary_commits(self):
        _, conn = summarize(one_folder_script())

        assert (conn.commits, conn.rollbacks) == (1, 0)

    def test_a_failure_rolls_back_and_propagates(self):
        conn = FakeConnection(one_folder_script())
        conn.raise_on = ("apiome.version_path", RuntimeError("boom"))

        with pytest.raises(RuntimeError):
            load_version_summary(FakeDb(conn), version_id=VERSION, member_limit=50)

        assert (conn.commits, conn.rollbacks) == (0, 1)


class TestMemberLimit:
    """The cap is clamped, because the scoped reads are the continuation."""

    def test_none_is_the_default(self):
        assert clamp_member_limit(None) == DEFAULT_MEMBER_LIMIT

    def test_an_over_large_limit_is_clamped_not_refused(self):
        assert clamp_member_limit(MAX_MEMBER_LIMIT + 500) == MAX_MEMBER_LIMIT

    def test_zero_is_kept_because_badges_alone_is_a_real_request(self):
        assert clamp_member_limit(0) == 0

    def test_a_negative_limit_floors_at_zero(self):
        assert clamp_member_limit(-5) == 0

    def test_a_limit_inside_the_range_is_untouched(self):
        assert clamp_member_limit(12) == 12


class TestVersionBadge:
    """The badge is the version's own label, normalized to the one spelling the tree draws."""

    @pytest.mark.parametrize(
        "label,expected",
        [
            ("2.1", "v2.1"),
            ("v2.1", "v2.1"),
            ("V2.1", "V2.1"),
            ("1.4.2-draft", "v1.4.2-draft"),
            ("  2.1  ", "v2.1"),
        ],
    )
    def test_a_label_becomes_a_badge(self, label, expected):
        assert version_badge(label) == expected

    @pytest.mark.parametrize("label", [None, "", "   "])
    def test_nothing_to_badge_with_is_no_badge(self, label):
        assert version_badge(label) is None

    def test_the_badge_lands_on_every_class_row(self):
        folders, _ = summarize(one_folder_script(), badge="v9.9")

        assert all(
            row["version_badge"] == "v9.9" for row in by_slug(folders)["customers"]["classes"]
        )

    def test_no_badge_leaves_the_field_null_rather_than_absent(self):
        folders, _ = summarize(one_folder_script())

        assert by_slug(folders)["customers"]["classes"][0]["version_badge"] is None
