"""Custom domain persistence — Slate 10.1 (private-suite#119).

Exercises :mod:`app.slate_domains_store` against a scripted fake connection, following the
``test_slate_cache_store.py`` precedent. No live Postgres: this asserts the SQL these functions
emit and the ordering discipline around it.

The properties that get the most attention, because each fails silently:

* **Every read and write is tenant-scoped.** A query that forgot ``tenant_id`` works perfectly in
  every single-tenant test and leaks across tenants in production. The one deliberate exception —
  :func:`get_domain_by_host`, which the unauthenticated on-demand TLS gate calls — is asserted to
  be the exception rather than allowed to look like an oversight.
* **Promoting a canonical host demotes the incumbent first.** ``uq_slate_domains_primary_per_
  environment`` permits one primary per lane, so the wrong order violates the index and the
  missing demotion leaves the lane with two.
* **Verified and verified-at move together**, because V241 constrains them as a pair.
* **A duplicate host surfaces as a typed conflict**, not as an ``IntegrityError`` reaching a
  handler as a 500.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.slate_domains_store import (
    SlateDomainConflictError,
    SlateDomainStoreError,
    attach_domain,
    detach_domain,
    get_domain,
    get_domain_by_host,
    get_environment_scope,
    list_domains,
    list_renewal_candidates,
    record_certificate,
    record_certificate_error,
    record_verification,
    set_auto_renew,
    set_primary,
)

TENANT = "11111111-1111-1111-1111-111111111111"
SITE = "22222222-2222-2222-2222-222222222222"
ENV = "33333333-3333-3333-3333-333333333333"
DOMAIN = "44444444-4444-4444-4444-444444444444"
OTHER_DOMAIN = "55555555-5555-5555-5555-555555555555"
HOST = "payments-docs.acme.io"
NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)


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
    """A psycopg2-shaped connection whose results are scripted per statement."""

    def __init__(self, results: Optional[List[Any]] = None) -> None:
        self.results = list(results or [])
        self.statements: List[tuple] = []
        self._pending: Any = None
        self.raise_on: Optional[tuple] = None

    def _advance(self) -> None:
        if self.raise_on and self.raise_on[0] in self.statements[-1][0]:
            raise self.raise_on[1]
        # One result slot per statement, replaced on each execute. A statement whose result is
        # never fetched — the demotion UPDATE inside a primary swap — must not shift the result
        # the *next* statement fetches, which a queue would do.
        self._pending = self.results.pop(0) if self.results else None

    def _take(self) -> Any:
        value = self._pending
        self._pending = None
        return value

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)


class FakeDb:
    """Minimal ``_DbLike`` returning one connection."""

    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    def connect(self) -> FakeConnection:
        return self._conn


class UniqueViolationError(Exception):
    """Stands in for psycopg2's unique-violation, identified by SQLSTATE like the real one."""

    pgcode = "23505"


def db_with(*results: Any) -> tuple[FakeDb, FakeConnection]:
    """Build a fake database whose statements return ``results`` in order."""
    conn = FakeConnection(list(results))
    return FakeDb(conn), conn


def domain_row(**overrides) -> Dict[str, Any]:
    """A domain row as the columns list returns it."""
    row = {
        "id": DOMAIN,
        "tenant_id": TENANT,
        "site_id": SITE,
        "environment_id": ENV,
        "host": HOST,
        "is_primary": False,
        "tls_status": "pending",
        "verification_status": "pending",
        "verification_method": "cname",
        "auto_renew": True,
    }
    row.update(overrides)
    return row


def statements(conn: FakeConnection) -> List[str]:
    """Every statement the call emitted, whitespace-collapsed."""
    return [sql for sql, _ in conn.statements]


def written_columns(sql: str) -> str:
    """The part of an UPDATE that assigns values, excluding WHERE and RETURNING.

    Every statement here returns the full column list, so "does this write X" has to be asked of
    the SET clause rather than of the whole statement.

    Args:
        sql: The whitespace-collapsed statement.

    Returns:
        The text between ``SET`` and the first ``WHERE``.
    """
    return sql.split(" SET ", 1)[1].split(" WHERE ", 1)[0]


class TestReads:
    """Scoping, ordering, and the one route that is deliberately not tenant-scoped."""

    def test_listing_is_tenant_scoped_and_puts_the_canonical_host_first(self) -> None:
        db, conn = db_with([domain_row()])
        list_domains(db, tenant_id=TENANT, environment_id=ENV)
        sql, params = conn.statements[0]
        assert "tenant_id = %s::uuid" in sql
        assert "ORDER BY is_primary DESC, host" in sql
        assert params == (ENV, TENANT)

    def test_getting_one_domain_is_tenant_scoped(self) -> None:
        db, conn = db_with(domain_row())
        assert get_domain(db, tenant_id=TENANT, domain_id=DOMAIN) is not None
        assert conn.statements[0][1] == (DOMAIN, TENANT)

    def test_a_domain_in_another_tenant_reads_as_absent(self) -> None:
        db, _ = db_with(None)
        assert get_domain(db, tenant_id=TENANT, domain_id=DOMAIN) is None

    def test_the_host_lookup_is_deliberately_not_tenant_scoped(self) -> None:
        # Its caller is the edge's on-demand TLS gate, which holds no session. A hostname is
        # globally unique, so this cannot return "another tenant's" row for a host the caller
        # did not already have.
        db, conn = db_with(domain_row())
        get_domain_by_host(db, host=HOST)
        sql, params = conn.statements[0]
        assert sql.split(" WHERE ", 1)[1] == "host = %s"
        assert params == (HOST,)

    def test_the_lane_lookup_is_tenant_scoped_so_a_scope_miss_can_answer_404(self) -> None:
        db, conn = db_with(None)
        assert get_environment_scope(db, tenant_id=TENANT, environment_id=ENV) is None
        assert conn.statements[0][1] == (ENV, TENANT)

    def test_renewal_candidates_are_auto_renewing_and_soonest_first(self) -> None:
        db, conn = db_with([domain_row()])
        cutoff = NOW + timedelta(days=30)
        list_renewal_candidates(db, before=cutoff, limit=10)
        sql, params = conn.statements[0]
        assert "auto_renew" in sql
        assert "ORDER BY certificate_expires_at" in sql
        assert params == (cutoff, 10)


class TestAttach:
    """Adding a hostname, and the global uniqueness that makes it meaningful."""

    def test_a_new_domain_starts_pending_on_both_axes(self) -> None:
        db, conn = db_with(domain_row())
        attach_domain(
            db,
            tenant_id=TENANT,
            site_id=SITE,
            environment_id=ENV,
            host=HOST,
            dns_target="sites.apiome.app",
            verification_method="cname",
            verification_token="tok",
        )
        sql = statements(conn)[0]
        assert "'pending', 'pending'" in sql
        assert "INSERT INTO apiome.slate_domains" in sql

    def test_attaching_as_primary_demotes_the_incumbent_first(self) -> None:
        db, conn = db_with(None, domain_row(is_primary=True))
        attach_domain(
            db,
            tenant_id=TENANT,
            site_id=SITE,
            environment_id=ENV,
            host=HOST,
            dns_target="sites.apiome.app",
            verification_method="cname",
            verification_token="tok",
            is_primary=True,
        )
        emitted = statements(conn)
        assert "is_primary = FALSE" in emitted[0]
        assert "INSERT INTO" in emitted[1]

    def test_a_duplicate_host_becomes_a_typed_conflict_not_an_integrity_error(self) -> None:
        db, conn = db_with(domain_row())
        conn.raise_on = ("INSERT INTO apiome.slate_domains", UniqueViolationError("duplicate key"))
        with pytest.raises(SlateDomainConflictError) as exc:
            attach_domain(
                db,
                tenant_id=TENANT,
                site_id=SITE,
                environment_id=ENV,
                host=HOST,
                dns_target="sites.apiome.app",
                verification_method="cname",
                verification_token="tok",
            )
        assert exc.value.host == HOST
        assert "already attached" in str(exc.value)

    def test_an_unrelated_database_error_is_not_disguised_as_a_conflict(self) -> None:
        db, conn = db_with(domain_row())
        conn.raise_on = ("INSERT INTO apiome.slate_domains", RuntimeError("connection reset"))
        with pytest.raises(RuntimeError):
            attach_domain(
                db,
                tenant_id=TENANT,
                site_id=SITE,
                environment_id=ENV,
                host=HOST,
                dns_target="sites.apiome.app",
                verification_method="cname",
                verification_token="tok",
            )


class TestRecordVerification:
    """The verified/verified-at pair, and what a check does and does not rewrite."""

    def test_a_pass_records_the_timestamp_alongside_the_status(self) -> None:
        db, conn = db_with(domain_row(verification_status="verified"))
        record_verification(
            db, tenant_id=TENANT, domain_id=DOMAIN, verified=True, detail="ok", checked_at=NOW
        )
        _, params = conn.statements[0]
        assert params[0] == "verified"
        assert params[1] == NOW  # verified_at
        assert params[3] is None  # no error recorded on a pass

    def test_a_failure_clears_the_timestamp_and_stores_what_was_observed(self) -> None:
        db, conn = db_with(domain_row(verification_status="failed"))
        record_verification(
            db,
            tenant_id=TENANT,
            domain_id=DOMAIN,
            verified=False,
            detail="points at ghs.googlehosted.com",
            checked_at=NOW,
        )
        _, params = conn.statements[0]
        assert params[0] == "failed"
        assert params[1] is None
        assert params[3] == "points at ghs.googlehosted.com"

    def test_a_pass_promotes_a_pending_lane_to_provisioning(self) -> None:
        db, conn = db_with(domain_row())
        record_verification(db, tenant_id=TENANT, domain_id=DOMAIN, verified=True, detail="ok")
        sql = statements(conn)[0]
        assert "WHEN %s AND tls_status = 'pending' THEN 'provisioning'" in sql

    def test_a_recheck_never_rewrites_what_was_measured_about_the_certificate(self) -> None:
        # A domain serving a valid certificate whose DNS has since been repointed is exactly that.
        db, conn = db_with(domain_row())
        record_verification(db, tenant_id=TENANT, domain_id=DOMAIN, verified=False, detail="gone")
        written = written_columns(statements(conn)[0])
        assert "certificate_expires_at" not in written
        assert "certificate_issuer" not in written

    def test_a_vanished_row_is_a_typed_not_found(self) -> None:
        db, _ = db_with(None)
        with pytest.raises(SlateDomainStoreError) as exc:
            record_verification(db, tenant_id=TENANT, domain_id=DOMAIN, verified=True, detail="ok")
        assert exc.value.code == "domain_not_found"


class TestRecordCertificate:
    """Observations of the live host."""

    def test_an_observed_expiry_makes_the_domain_active(self) -> None:
        db, conn = db_with(domain_row(tls_status="active"))
        record_certificate(
            db,
            tenant_id=TENANT,
            domain_id=DOMAIN,
            issuer="Let's Encrypt (R11)",
            serial="04A1",
            issued_at=NOW,
            expires_at=NOW + timedelta(days=90),
            protocol="TLSv1.3",
            checked_at=NOW,
        )
        sql, params = conn.statements[0]
        assert "WHEN %s IS NULL THEN 'provisioning' ELSE 'active'" in sql
        assert params[0] == NOW + timedelta(days=90)
        assert params[6] == "TLSv1.3"

    def test_an_unparseable_expiry_leaves_the_domain_provisioning_rather_than_active(self) -> None:
        # V241 refuses an active row with no expiry, so this is the constraint expressed in SQL
        # rather than a write that would be rejected at the database.
        db, conn = db_with(domain_row())
        record_certificate(
            db,
            tenant_id=TENANT,
            domain_id=DOMAIN,
            issuer="Internal CA",
            serial=None,
            issued_at=None,
            expires_at=None,
            protocol="TLSv1.3",
        )
        assert conn.statements[0][1][0] is None

    def test_a_successful_probe_clears_a_previous_error(self) -> None:
        db, conn = db_with(domain_row())
        record_certificate(
            db,
            tenant_id=TENANT,
            domain_id=DOMAIN,
            issuer="Let's Encrypt (R11)",
            serial="04A1",
            issued_at=NOW,
            expires_at=NOW + timedelta(days=90),
            protocol="TLSv1.3",
        )
        assert "tls_error = NULL" in statements(conn)[0]

    def test_a_failed_probe_keeps_the_last_thing_that_was_true(self) -> None:
        # "We saw a valid certificate an hour ago and cannot reach the host now" is a materially
        # more useful statement during an outage than "there has never been a certificate".
        db, conn = db_with(domain_row(tls_status="error"))
        record_certificate_error(
            db, tenant_id=TENANT, domain_id=DOMAIN, error="unreachable", checked_at=NOW
        )
        sql, params = conn.statements[0]
        written = written_columns(sql)
        assert "tls_status = 'error'" in written
        assert "certificate_expires_at" not in written
        assert "certificate_issuer" not in written
        assert params[0] == "unreachable"


class TestPrimaryRenewalAndDetach:
    """Ordering, the renewal switch, and why removal is a hard delete."""

    def test_promoting_demotes_the_incumbent_before_promoting_the_target(self) -> None:
        db, conn = db_with(
            {"id": DOMAIN, "environment_id": ENV}, None, domain_row(is_primary=True)
        )
        set_primary(db, tenant_id=TENANT, domain_id=DOMAIN)
        emitted = statements(conn)
        assert "SELECT id, environment_id" in emitted[0]
        assert "is_primary = FALSE" in emitted[1]
        assert "is_primary = TRUE" in emitted[2]

    def test_the_demotion_excludes_the_domain_being_promoted(self) -> None:
        db, conn = db_with(
            {"id": DOMAIN, "environment_id": ENV}, None, domain_row(is_primary=True)
        )
        set_primary(db, tenant_id=TENANT, domain_id=DOMAIN)
        sql, params = conn.statements[1]
        assert "id <> %s::uuid" in sql
        assert params[-1] == DOMAIN

    def test_promoting_a_domain_in_another_tenant_is_a_typed_not_found(self) -> None:
        db, conn = db_with(None)
        with pytest.raises(SlateDomainStoreError) as exc:
            set_primary(db, tenant_id=TENANT, domain_id=OTHER_DOMAIN)
        assert exc.value.code == "domain_not_found"
        # Nothing was demoted on the way to discovering the domain does not exist.
        assert len(conn.statements) == 1

    def test_the_renewal_switch_is_tenant_scoped(self) -> None:
        db, conn = db_with(domain_row(auto_renew=False))
        set_auto_renew(db, tenant_id=TENANT, domain_id=DOMAIN, enabled=False)
        sql, params = conn.statements[0]
        assert "auto_renew = %s" in sql
        assert params[0] is False
        assert params[-2:] == (DOMAIN, TENANT)

    def test_detaching_deletes_the_row_so_the_hostname_is_genuinely_released(self) -> None:
        db, conn = db_with(domain_row())
        detach_domain(db, tenant_id=TENANT, domain_id=DOMAIN)
        sql, params = conn.statements[0]
        assert sql.startswith("DELETE FROM apiome.slate_domains")
        assert "deleted_at" not in sql
        assert params == (DOMAIN, TENANT)

    def test_detaching_a_domain_in_another_tenant_is_a_typed_not_found(self) -> None:
        db, _ = db_with(None)
        with pytest.raises(SlateDomainStoreError) as exc:
            detach_domain(db, tenant_id=TENANT, domain_id=DOMAIN)
        assert exc.value.code == "domain_not_found"
