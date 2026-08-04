"""Domain folder persistence — DUW-1.1 (private-suite#2568).

Exercises :mod:`app.domains_store` against a scripted fake connection, following the
``test_slate_domains_store.py`` precedent. No live Postgres here: this asserts the SQL these
functions emit and the transaction discipline around it. The database's own guarantees — the CHECK
constraints, the membership guard, the soft-delete release trigger — are proven against a real
server in ``test_domains_migration.py``.

The properties that get the most attention, because each fails silently:

* **Every write commits.** A store function that never calls ``commit()`` passes any test that
  reads back through the same open transaction and loses the write in production.
* **`shared/` is NULL, everywhere.** ``None`` and the string ``"shared"`` must both reach the
  database as NULL; if either leaked through as a literal the assignment would be rejected as a bad
  UUID, or worse, match nothing and silently no-op.
* **A soft delete is an UPDATE, never a DELETE.** The whole no-content-loss guarantee rests on it.
* **Uniqueness surfaces as a typed conflict** naming which field collided, not as an
  ``IntegrityError`` reaching a handler as a 500.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.domains_store import (
    SHARED_DOMAIN_ID,
    DomainConflictError,
    DomainScopeError,
    assign_class,
    assign_path,
    count_members,
    create_domain,
    delete_domain,
    get_class,
    get_domain,
    get_path,
    is_valid_slug,
    list_domains,
    next_sort_order,
    resolve_domain_id,
    shared_bucket,
    slugify,
    update_domain,
)

VERSION = "11111111-1111-1111-1111-111111111111"
DOMAIN = "22222222-2222-2222-2222-222222222222"
CLASS = "33333333-3333-3333-3333-333333333333"
PATH = "44444444-4444-4444-4444-444444444444"


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.conn._take()

    def fetchall(self) -> List[Dict[str, Any]]:
        value = self.conn._take()
        return value if isinstance(value, list) else ([] if value is None else [value])

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeConnection:
    """A psycopg2-shaped connection whose results are scripted per statement.

    Unlike the slate variant this counts ``commit``/``rollback``, because "the write was committed"
    is one of the things these tests exist to prove.
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


class UniqueViolationError(Exception):
    """Stands in for psycopg2's unique-violation, identified by SQLSTATE like the real one."""

    pgcode = "23505"

    def __init__(self, constraint: str = "uq_domains_version_slug") -> None:
        super().__init__(f'duplicate key value violates unique constraint "{constraint}"')


class ForeignKeyViolationError(Exception):
    """Stands in for the membership guard's ``foreign_key_violation``."""

    pgcode = "23503"


def db_with(*results: Any) -> tuple[FakeDb, FakeConnection]:
    """Build a fake database whose statements return ``results`` in order."""
    conn = FakeConnection(list(results))
    return FakeDb(conn), conn


def domain_row(**overrides) -> Dict[str, Any]:
    """A domain row as ``DOMAIN_COLUMNS`` returns it."""
    row = {
        "id": DOMAIN,
        "version_id": VERSION,
        "name": "customers",
        "slug": "customers",
        "sort_order": 0,
        "deleted_at": None,
        "created_at": "2026-08-04T00:00:00Z",
        "updated_at": "2026-08-04T00:00:00Z",
    }
    row.update(overrides)
    return row


# ─── Pure helpers ────────────────────────────────────────────────────────────


class TestSlugs:
    """The slug rules, which mirror V242's CHECK constraints."""

    @pytest.mark.parametrize(
        "name,expected",
        [
            ("Customers", "customers"),
            ("user_profiles", "user-profiles"),
            ("Billing & Invoices", "billing-invoices"),
            ("  spaced  out  ", "spaced-out"),
            ("v1", "v1"),
            ("--dashes--", "dashes"),
        ],
    )
    def test_slugify_reduces_to_the_accepted_format(self, name: str, expected: str) -> None:
        assert slugify(name) == expected

    @pytest.mark.parametrize("name", ["", "   ", "!!!", "---"])
    def test_slugify_returns_none_when_nothing_survives(self, name: str) -> None:
        assert slugify(name) is None

    def test_shared_can_never_be_derived(self) -> None:
        # The reserved slug is the derived bucket's; a stored domain taking it would put two
        # different memberships behind one folder.
        assert slugify("Shared") is None
        assert slugify("shared") is None
        assert is_valid_slug("shared") is False

    @pytest.mark.parametrize("slug", ["customers", "user-profiles", "v1", "a1"])
    def test_valid_slugs_are_accepted(self, slug: str) -> None:
        assert is_valid_slug(slug) is True

    @pytest.mark.parametrize(
        "slug", ["Customers", "user_profiles", "-leading", "trailing-", "double--hyphen", "", "a b"]
    )
    def test_invalid_slugs_are_rejected(self, slug: str) -> None:
        assert is_valid_slug(slug) is False


class TestSharedBucket:
    """The derived ``shared/`` folder."""

    def test_it_has_no_id_and_is_flagged_virtual(self) -> None:
        bucket = shared_bucket(VERSION, 3)
        assert bucket["id"] is None
        assert bucket["virtual"] is True
        assert bucket["slug"] == SHARED_DOMAIN_ID
        assert bucket["version_id"] == VERSION
        assert bucket["sort_order"] == 3

    @pytest.mark.parametrize("supplied", [None, SHARED_DOMAIN_ID])
    def test_both_spellings_of_shared_resolve_to_null(self, supplied: Optional[str]) -> None:
        assert resolve_domain_id(supplied) is None

    def test_a_real_id_passes_through(self) -> None:
        assert resolve_domain_id(DOMAIN) == DOMAIN


# ─── Reads ───────────────────────────────────────────────────────────────────


class TestReads:
    def test_list_domains_is_version_scoped_and_ordered(self) -> None:
        db, conn = db_with([domain_row()])
        rows = list_domains(db, version_id=VERSION)

        assert len(rows) == 1
        sql, params = conn.statements[0]
        assert "WHERE version_id = %s::uuid AND deleted_at IS NULL" in sql
        # Ties broken by slug so the tree is stable when two domains share a sort_order.
        assert "ORDER BY sort_order, slug" in sql
        assert params == (VERSION,)

    def test_get_domain_hides_soft_deleted_rows_by_default(self) -> None:
        db, conn = db_with(None)
        assert get_domain(db, domain_id=DOMAIN) is None
        assert "deleted_at IS NULL" in conn.statements[0][0]

    @pytest.mark.parametrize("bad_id", ["not-a-uuid", "shared", "", "123", None])
    def test_get_domain_rejects_a_non_uuid_without_querying(self, bad_id: Optional[str]) -> None:
        # A non-UUID would raise InvalidTextRepresentation at the `::uuid` cast — a 500 for what is
        # really "no such domain". It must not reach the database at all.
        db, conn = db_with(domain_row())
        assert get_domain(db, domain_id=bad_id) is None
        assert conn.statements == []

    @pytest.mark.parametrize(
        "ok_id",
        [
            "22222222-2222-2222-2222-222222222222",  # non-RFC-4122 variant nibble
            "00000000-0000-0000-0000-000000000000",  # the nil UUID
            "00000000-0000-4000-8000-000000000004",  # a conforming v4
        ],
    )
    def test_get_domain_accepts_anything_the_uuid_column_would(self, ok_id: str) -> None:
        # The guard must not be stricter than the column: an RFC-4122-strict check would answer
        # "not found" for a row that exists.
        db, conn = db_with(domain_row(id=ok_id))
        assert get_domain(db, domain_id=ok_id) is not None
        assert conn.statements[0][1] == (ok_id,)

    def test_get_domain_can_include_deleted_rows(self) -> None:
        db, conn = db_with(domain_row(deleted_at="2026-08-04T00:00:00Z"))
        row = get_domain(db, domain_id=DOMAIN, include_deleted=True)
        assert row is not None
        assert "deleted_at IS NULL" not in conn.statements[0][0]

    def test_next_sort_order_starts_at_zero_for_an_empty_version(self) -> None:
        db, _ = db_with({"next": 0})
        assert next_sort_order(db, version_id=VERSION) == 0

    def test_next_sort_order_places_a_new_domain_last(self) -> None:
        db, conn = db_with({"next": 4})
        assert next_sort_order(db, version_id=VERSION) == 4
        assert "COALESCE(MAX(sort_order) + 1, 0)" in conn.statements[0][0]

    def test_next_sort_order_tolerates_a_null_aggregate(self) -> None:
        db, _ = db_with({"next": None})
        assert next_sort_order(db, version_id=VERSION) == 0

    def test_get_class_excludes_soft_deleted_classes(self) -> None:
        db, conn = db_with({"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None})
        assert get_class(db, class_id=CLASS) is not None
        assert "deleted_at IS NULL" in conn.statements[0][0]

    @pytest.mark.parametrize("getter,kwarg", [(get_class, "class_id"), (get_path, "path_id")])
    def test_member_reads_reject_a_non_uuid_without_querying(self, getter, kwarg: str) -> None:
        # These ids arrive straight from a URL path segment, so a garbage value must answer
        # "not found" rather than blowing up at the `::uuid` cast.
        db, conn = db_with({"id": CLASS})
        assert getter(db, **{kwarg: "not-a-uuid"}) is None
        assert conn.statements == []

    def test_get_path_has_no_soft_delete_predicate(self) -> None:
        # version_path carries no deleted_at column; filtering on one would be a SQL error.
        db, conn = db_with({"id": PATH, "version_id": VERSION, "pathname": "/v1/customers", "domain_id": None})
        assert get_path(db, path_id=PATH) is not None
        assert "deleted_at" not in conn.statements[0][0]


class TestCountMembers:
    """Counts behind the delete endpoint's "what moved" report."""

    def test_a_real_domain_counts_by_domain_id(self) -> None:
        db, conn = db_with({"n": 3}, {"n": 4})
        counts = count_members(db, domain_id=DOMAIN, version_id=VERSION)

        assert counts == {"class_count": 3, "path_count": 4}
        assert all("domain_id = %s::uuid" in sql for sql, _ in conn.statements)
        assert conn.statements[0][1] == (VERSION, DOMAIN)

    def test_the_shared_bucket_counts_by_null_domain(self) -> None:
        db, conn = db_with({"n": 8}, {"n": 0})
        counts = count_members(db, domain_id=None, version_id=VERSION)

        # The mockup's `shared/ 8 classes · 0 ops`.
        assert counts == {"class_count": 8, "path_count": 0}
        assert all("domain_id IS NULL" in sql for sql, _ in conn.statements)
        assert conn.statements[0][1] == (VERSION,)

    def test_soft_deleted_classes_are_never_counted(self) -> None:
        db, conn = db_with({"n": 1}, {"n": 1})
        count_members(db, domain_id=DOMAIN, version_id=VERSION)

        class_sql, path_sql = conn.statements[0][0], conn.statements[1][0]
        assert "deleted_at IS NULL" in class_sql
        assert "deleted_at" not in path_sql

    def test_missing_aggregates_read_as_zero(self) -> None:
        db, _ = db_with(None, None)
        assert count_members(db, domain_id=DOMAIN, version_id=VERSION) == {
            "class_count": 0,
            "path_count": 0,
        }


# ─── Writes ──────────────────────────────────────────────────────────────────


class TestCreateDomain:
    def test_it_inserts_and_commits(self) -> None:
        db, conn = db_with(domain_row())
        row = create_domain(db, version_id=VERSION, name="customers", slug="customers", sort_order=0)

        assert row["slug"] == "customers"
        assert conn.commits == 1
        assert conn.rollbacks == 0
        sql, params = conn.statements[0]
        assert "INSERT INTO apiome.domains" in sql
        assert params == (VERSION, "customers", "customers", 0)

    def test_a_duplicate_slug_becomes_a_typed_conflict(self) -> None:
        db, conn = db_with()
        conn.raise_on = ("INSERT INTO apiome.domains", UniqueViolationError("uq_domains_version_slug"))

        with pytest.raises(DomainConflictError) as excinfo:
            create_domain(db, version_id=VERSION, name="Customers", slug="customers", sort_order=0)

        assert excinfo.value.field == "slug"
        assert excinfo.value.value == "customers"
        assert conn.rollbacks == 1
        assert conn.commits == 0

    def test_a_duplicate_name_names_the_name_field(self) -> None:
        db, conn = db_with()
        conn.raise_on = ("INSERT INTO apiome.domains", UniqueViolationError("uq_domains_version_name"))

        with pytest.raises(DomainConflictError) as excinfo:
            create_domain(db, version_id=VERSION, name="Customers", slug="customers-2", sort_order=0)

        assert excinfo.value.field == "name"
        assert excinfo.value.value == "Customers"

    def test_an_unrelated_error_is_not_swallowed(self) -> None:
        db, conn = db_with()
        conn.raise_on = ("INSERT INTO apiome.domains", RuntimeError("connection reset"))

        with pytest.raises(RuntimeError):
            create_domain(db, version_id=VERSION, name="customers", slug="customers", sort_order=0)
        assert conn.rollbacks == 1


class TestUpdateDomain:
    def test_only_supplied_fields_are_written(self) -> None:
        db, conn = db_with(domain_row(name="Customers"))
        update_domain(db, domain_id=DOMAIN, name="Customers")

        sql, params = conn.statements[0]
        assert "SET name = %s" in sql
        # A rename must not reset a tree position the caller never mentioned.
        assert "sort_order" not in sql.split("WHERE")[0]
        assert params == ("Customers", DOMAIN)

    def test_every_field_can_be_written_at_once(self) -> None:
        db, conn = db_with(domain_row())
        update_domain(db, domain_id=DOMAIN, name="Billing", slug="billing", sort_order=2)

        sql, params = conn.statements[0]
        assert "SET name = %s, slug = %s, sort_order = %s" in sql
        assert params == ("Billing", "billing", 2, DOMAIN)

    def test_sort_order_zero_is_written_not_treated_as_absent(self) -> None:
        # 0 is falsy and is also the first position in the tree; an `if sort_order:` test here
        # would make "move to the top" silently do nothing.
        db, conn = db_with(domain_row(sort_order=0))
        update_domain(db, domain_id=DOMAIN, sort_order=0)

        sql, params = conn.statements[0]
        assert "SET sort_order = %s" in sql
        assert params == (0, DOMAIN)

    def test_an_empty_update_reads_back_without_writing(self) -> None:
        db, conn = db_with(domain_row())
        row = update_domain(db, domain_id=DOMAIN)

        assert row is not None
        assert conn.commits == 0
        assert "UPDATE" not in conn.statements[0][0]

    def test_it_refuses_to_edit_a_deleted_domain(self) -> None:
        db, conn = db_with(None)
        assert update_domain(db, domain_id=DOMAIN, name="Nope") is None
        assert "deleted_at IS NULL" in conn.statements[0][0]

    def test_a_conflicting_rename_becomes_a_typed_conflict(self) -> None:
        db, conn = db_with()
        conn.raise_on = ("UPDATE apiome.domains", UniqueViolationError("uq_domains_version_name"))

        with pytest.raises(DomainConflictError) as excinfo:
            update_domain(db, domain_id=DOMAIN, name="Billing")
        assert excinfo.value.field == "name"
        assert conn.rollbacks == 1


class TestDeleteDomain:
    def test_it_soft_deletes_and_never_issues_a_delete(self) -> None:
        db, conn = db_with(domain_row(deleted_at="2026-08-04T00:00:00Z"))
        row = delete_domain(db, domain_id=DOMAIN)

        assert row is not None
        sql = conn.statements[0][0]
        assert "UPDATE apiome.domains" in sql
        assert "SET deleted_at = CURRENT_TIMESTAMP" in sql
        # The no-content-loss guarantee rests on this never being a DELETE.
        assert "DELETE FROM" not in sql
        assert conn.commits == 1

    def test_the_release_is_left_to_the_trigger(self) -> None:
        # V242's trg_domains_soft_delete_release nulls the members. Re-doing it here would let a
        # future writer that skips this module strand members behind the tombstone.
        db, conn = db_with(domain_row())
        delete_domain(db, domain_id=DOMAIN)

        assert len(conn.statements) == 1
        assert "apiome.classes" not in conn.statements[0][0]
        assert "apiome.version_path" not in conn.statements[0][0]

    def test_deleting_twice_reports_not_found(self) -> None:
        db, conn = db_with(None)
        assert delete_domain(db, domain_id=DOMAIN) is None
        assert "deleted_at IS NULL" in conn.statements[0][0]


class TestAssignment:
    def test_assigning_a_class_writes_the_domain_and_commits(self) -> None:
        db, conn = db_with({"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": DOMAIN})
        row = assign_class(db, class_id=CLASS, domain_id=DOMAIN)

        assert row["domain_id"] == DOMAIN
        sql, params = conn.statements[0]
        assert "UPDATE apiome.classes" in sql
        assert "SET domain_id = %s::uuid" in sql
        assert "deleted_at IS NULL" in sql
        assert params == (DOMAIN, CLASS)
        assert conn.commits == 1

    def test_releasing_a_class_stores_null(self) -> None:
        db, conn = db_with({"id": CLASS, "version_id": VERSION, "name": "Customer", "domain_id": None})
        row = assign_class(db, class_id=CLASS, domain_id=None)

        assert row["domain_id"] is None
        assert conn.statements[0][1] == (None, CLASS)

    def test_assigning_a_path_writes_the_domain(self) -> None:
        db, conn = db_with({"id": PATH, "version_id": VERSION, "pathname": "/v1/customers", "domain_id": DOMAIN})
        row = assign_path(db, path_id=PATH, domain_id=DOMAIN)

        assert row["pathname"] == "/v1/customers"
        sql, params = conn.statements[0]
        assert "UPDATE apiome.version_path" in sql
        # version_path has no soft delete, so a deleted_at predicate would be a SQL error.
        assert "deleted_at" not in sql
        assert params == (DOMAIN, PATH)

    def test_a_missing_member_returns_none(self) -> None:
        db, _ = db_with(None)
        assert assign_class(db, class_id=CLASS, domain_id=None) is None

    @pytest.mark.parametrize("assign,kwargs", [(assign_class, {"class_id": CLASS}), (assign_path, {"path_id": PATH})])
    def test_the_membership_guard_becomes_a_scope_error(self, assign, kwargs) -> None:
        db, conn = db_with()
        conn.raise_on = ("UPDATE apiome.", ForeignKeyViolationError("cross-version"))

        with pytest.raises(DomainScopeError):
            assign(db, domain_id=DOMAIN, **kwargs)
        assert conn.rollbacks == 1
        assert conn.commits == 0

    def test_a_guard_message_without_a_sqlstate_is_still_recognized(self) -> None:
        # A fake or a driver that drops pgcode must not turn the guard into a 500.
        db, conn = db_with()
        conn.raise_on = (
            "UPDATE apiome.classes",
            RuntimeError("domain X belongs to version A, but this item belongs to version B"),
        )
        with pytest.raises(DomainScopeError):
            assign_class(db, class_id=CLASS, domain_id=DOMAIN)

    def test_an_unrelated_error_is_not_mistaken_for_a_scope_violation(self) -> None:
        db, conn = db_with()
        conn.raise_on = ("UPDATE apiome.classes", RuntimeError("connection reset"))

        with pytest.raises(RuntimeError):
            assign_class(db, class_id=CLASS, domain_id=DOMAIN)
