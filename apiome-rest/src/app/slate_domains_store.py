"""Persistence for custom domains — Slate 10.1 (private-suite#119).

Reads and writes ``apiome.slate_domains`` (V186, extended by V241). Follows
:mod:`app.slate_cache_store` exactly: a small ``_DbLike`` protocol rather than a dependency on the
concrete ``Database`` singleton, so the whole surface is exercisable against a fake connection.

Three rules live here rather than in the route layer, because they are properties of the table
and would otherwise have to be re-asserted by every caller:

**A host belongs to one tenant, globally.** ``UNIQUE (host)`` makes a second claim on a hostname
fail at the database, and :func:`attach_domain` turns that into
:class:`SlateDomainConflictError` rather than letting an ``IntegrityError`` reach a handler. The
conflict message deliberately does not say *which* tenant holds it: that a host is taken is
something anyone can observe by resolving it; who holds it is not.

**Exactly one primary per lane.** ``uq_slate_domains_primary_per_environment`` enforces it, so
:func:`set_primary` demotes inside the same transaction as it promotes — two statements that must
not be separable, since a crash between them would leave a lane with no canonical host.

**Verified and verified-at move together.** V241 constrains them as a pair, so
:func:`record_verification` writes both from one outcome and clearing verification clears both.
No caller can construct a row that claims verification without a timestamp.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol, Sequence

__all__ = [
    "DOMAIN_COLUMNS",
    "SlateDomainConflictError",
    "SlateDomainStoreError",
    "attach_domain",
    "detach_domain",
    "get_domain",
    "get_domain_by_host",
    "list_domains",
    "list_renewal_candidates",
    "record_certificate",
    "record_certificate_error",
    "record_verification",
    "set_auto_renew",
    "set_primary",
]

#: Every column the API reads back, in a stable order shared by SELECT and RETURNING.
DOMAIN_COLUMNS = (
    "id, tenant_id, site_id, environment_id, host, is_primary, tls_status, verification_status, "
    "verification_token, verification_method, verification_checked_at, verification_error, "
    "verified_at, dns_target, certificate_issuer, certificate_expires_at, certificate_issued_at, "
    "certificate_serial, certificate_checked_at, tls_protocol, tls_error, auto_renew, "
    "created_at, updated_at"
)


class _DbLike(Protocol):
    """Minimal database surface used by this module."""

    def connect(self) -> Any: ...


class SlateDomainStoreError(Exception):
    """A domain row was missing or a lane could not be resolved.

    Attributes:
        code: Machine-readable reason — ``domain_not_found`` or ``environment_not_found``.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class SlateDomainConflictError(Exception):
    """Another tenant, or another lane, already holds this hostname.

    A hostname resolves to one place globally, so two claims on it are a routing ambiguity rather
    than a merge conflict. The message names the host and nothing about who holds it.
    """

    def __init__(self, host: str) -> None:
        self.host = host
        super().__init__(
            f"'{host}' is already attached to a site. A hostname can serve one site, so detach it "
            "there before attaching it here."
        )


def _as_dict(row: Any) -> Optional[Dict[str, Any]]:
    """Normalize a cursor row to a plain dict, preserving None."""
    return None if row is None else dict(row)


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _fetch_one(cursor: Any, query: str, params: Sequence[Any]) -> Optional[Dict[str, Any]]:
    """Execute a query and return the first row as a plain dict, or None."""
    cursor.execute(query, params)
    return _as_dict(cursor.fetchone())


def _now() -> datetime:
    """Current UTC time, isolated so tests can patch one place."""
    return datetime.now(timezone.utc)


def _is_unique_violation(exc: Exception) -> bool:
    """Whether an exception is Postgres' unique-violation (SQLSTATE 23505).

    Checked by code rather than by exception class so the module keeps working against a fake
    connection in tests, where ``psycopg2.errors.UniqueViolation`` is not what gets raised.

    Args:
        exc: The exception a write raised.

    Returns:
        True when it reports SQLSTATE 23505.
    """
    code = getattr(exc, "pgcode", None)
    if code == "23505":
        return True
    return "23505" in str(getattr(exc, "pgerror", "") or "") or "duplicate key" in str(exc).lower()


# ─── Reads ───────────────────────────────────────────────────────────────────


def get_environment_scope(
    db: _DbLike, *, tenant_id: str, environment_id: str
) -> Optional[Dict[str, Any]]:
    """Resolve a lane to its site, scoped to the caller's tenant.

    Args:
        db: Database handle exposing ``connect()``.
        tenant_id: Caller's tenant. A scope miss returns None so the REST layer answers 404 rather
            than confirming to another tenant that the lane exists.
        environment_id: The lane.

    Returns:
        ``{"id", "site_id", "tenant_id", "kind", "name"}``, or None.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            """
            SELECT id, site_id, tenant_id, kind, name
              FROM apiome.slate_environments
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            """,
            (environment_id, tenant_id),
        )


def list_domains(db: _DbLike, *, tenant_id: str, environment_id: str) -> List[Dict[str, Any]]:
    """List a lane's domains, canonical host first.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        environment_id: The lane.

    Returns:
        The rows, primary first then alphabetical — the order the inventory is displayed in.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_all(
            cursor,
            f"""
            SELECT {DOMAIN_COLUMNS}
              FROM apiome.slate_domains
             WHERE environment_id = %s::uuid AND tenant_id = %s::uuid
             ORDER BY is_primary DESC, host
            """,
            (environment_id, tenant_id),
        )


def get_domain(db: _DbLike, *, tenant_id: str, domain_id: str) -> Optional[Dict[str, Any]]:
    """Load one domain by id, scoped to its tenant.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant; a scope miss returns None.
        domain_id: The domain.

    Returns:
        The row, or None.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            f"""
            SELECT {DOMAIN_COLUMNS}
              FROM apiome.slate_domains
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            """,
            (domain_id, tenant_id),
        )


def get_domain_by_host(db: _DbLike, *, host: str) -> Optional[Dict[str, Any]]:
    """Load one domain by hostname, across every tenant.

    Deliberately *not* tenant-scoped: its caller is the edge's on-demand TLS ``ask`` endpoint,
    which holds no session and asks only "may this hostname be issued for". Because a hostname is
    globally unique this cannot return another tenant's row for a host the caller supplied — the
    caller supplied the host precisely because a browser asked for it.

    Args:
        db: Database handle.
        host: The canonical hostname.

    Returns:
        The row, or None when no site claims the host.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            f"""
            SELECT {DOMAIN_COLUMNS}
              FROM apiome.slate_domains
             WHERE host = %s
            """,
            (host,),
        )


def list_renewal_candidates(
    db: _DbLike, *, before: datetime, limit: int = 100
) -> List[Dict[str, Any]]:
    """List auto-renewing domains whose observed certificate expires before ``before``.

    The read behind a renewal sweep: it reports which hosts *should* have been renewed by the
    edge, so a certificate the edge silently failed to renew becomes visible instead of lapsing.

    Args:
        db: Database handle.
        before: Expiry cutoff.
        limit: Maximum rows.

    Returns:
        The rows, soonest expiry first.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_all(
            cursor,
            f"""
            SELECT {DOMAIN_COLUMNS}
              FROM apiome.slate_domains
             WHERE auto_renew
               AND certificate_expires_at IS NOT NULL
               AND certificate_expires_at < %s
             ORDER BY certificate_expires_at
             LIMIT %s
            """,
            (before, limit),
        )


# ─── Writes ──────────────────────────────────────────────────────────────────


def attach_domain(
    db: _DbLike,
    *,
    tenant_id: str,
    site_id: str,
    environment_id: str,
    host: str,
    dns_target: str,
    verification_method: str,
    verification_token: str,
    is_primary: bool = False,
) -> Dict[str, Any]:
    """Attach a hostname to a lane, unverified and with no certificate.

    A newly attached domain is ``verification_status = 'pending'`` and ``tls_status = 'pending'``:
    nothing has been proven and, because the edge will not be authorized to order a certificate
    until it has been, nothing is provisioning either.

    Args:
        db: Database handle.
        tenant_id: Owning tenant.
        site_id: Site the domain serves.
        environment_id: Lane it routes to.
        host: The canonical hostname.
        dns_target: The platform hostname it must be pointed at.
        verification_method: ``cname`` or ``txt``.
        verification_token: The ownership token the tenant publishes.
        is_primary: Whether this becomes the lane's canonical host.

    Returns:
        The inserted row.

    Raises:
        SlateDomainConflictError: When the hostname is already attached anywhere.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        if is_primary:
            cursor.execute(
                """
                UPDATE apiome.slate_domains
                   SET is_primary = FALSE, updated_at = %s
                 WHERE environment_id = %s::uuid AND is_primary
                """,
                (_now(), environment_id),
            )
        try:
            row = _fetch_one(
                cursor,
                f"""
                INSERT INTO apiome.slate_domains (
                    tenant_id, site_id, environment_id, host, is_primary,
                    tls_status, verification_status, verification_method,
                    verification_token, dns_target, auto_renew, updated_at
                ) VALUES (
                    %s::uuid, %s::uuid, %s::uuid, %s, %s,
                    'pending', 'pending', %s,
                    %s, %s, TRUE, %s
                )
                RETURNING {DOMAIN_COLUMNS}
                """,
                (
                    tenant_id,
                    site_id,
                    environment_id,
                    host,
                    is_primary,
                    verification_method,
                    verification_token,
                    dns_target,
                    _now(),
                ),
            )
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed conflict or unchanged
            if _is_unique_violation(exc):
                raise SlateDomainConflictError(host) from exc
            raise
    if row is None:  # pragma: no cover - RETURNING always yields a row on a successful INSERT
        raise SlateDomainStoreError("domain_not_found", f"'{host}' could not be attached.")
    return row


def record_verification(
    db: _DbLike,
    *,
    tenant_id: str,
    domain_id: str,
    verified: bool,
    detail: str,
    checked_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Record the outcome of an ownership check.

    A pass sets ``verification_status``, ``verified_at`` and moves ``tls_status`` from ``pending``
    to ``provisioning`` — the point at which the edge becomes authorized to order a certificate,
    and therefore the first moment "provisioning" is a true statement. A fail clears
    ``verified_at`` with it, because V241 constrains the pair, and records what was observed.

    A re-check never rewrites what was measured about the certificate. A domain serving a valid
    certificate whose DNS has since been repointed is exactly that — the observed issuer and
    expiry stay, ``tls_status`` stays ``active``, and only the verification fields change. Only a
    lane that was still waiting for issuance falls back to ``pending``, because with authorization
    withdrawn nothing is provisioning it any more.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain.
        verified: Whether ownership was proven.
        detail: What was observed — stored as ``verification_error`` on failure.
        checked_at: When the check ran; now when omitted.

    Returns:
        The updated row.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    moment = checked_at or _now()
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            f"""
            UPDATE apiome.slate_domains
               SET verification_status = %s,
                   verified_at = %s,
                   verification_checked_at = %s,
                   verification_error = %s,
                   tls_status = CASE
                       WHEN %s AND tls_status = 'pending' THEN 'provisioning'
                       WHEN NOT %s AND tls_status = 'provisioning' THEN 'pending'
                       ELSE tls_status
                   END,
                   updated_at = %s
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (
                "verified" if verified else "failed",
                moment if verified else None,
                moment,
                None if verified else detail,
                verified,
                verified,
                moment,
                domain_id,
                tenant_id,
            ),
        )
    if row is None:
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row


def record_certificate(
    db: _DbLike,
    *,
    tenant_id: str,
    domain_id: str,
    issuer: str,
    serial: Optional[str],
    issued_at: Optional[datetime],
    expires_at: Optional[datetime],
    protocol: str,
    checked_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Record what a TLS probe observed the host serving.

    ``tls_status`` becomes ``active`` only when an expiry was actually read: V241 refuses an
    ``active`` row without one, so a certificate whose validity window could not be parsed is
    reported as still provisioning rather than as active-with-unknown-expiry.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain.
        issuer: Issuing CA as the probe phrased it.
        serial: Certificate serial; changes on renewal.
        issued_at: Observed ``notBefore``.
        expires_at: Observed ``notAfter``.
        protocol: Negotiated protocol, e.g. ``TLSv1.3``.
        checked_at: When the handshake completed; now when omitted.

    Returns:
        The updated row.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    moment = checked_at or _now()
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            f"""
            UPDATE apiome.slate_domains
               SET tls_status = CASE WHEN %s IS NULL THEN 'provisioning' ELSE 'active' END,
                   certificate_issuer = %s,
                   certificate_serial = %s,
                   certificate_issued_at = %s,
                   certificate_expires_at = %s,
                   certificate_checked_at = %s,
                   tls_protocol = %s,
                   tls_error = NULL,
                   updated_at = %s
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (
                expires_at,
                issuer,
                serial,
                issued_at,
                expires_at,
                moment,
                protocol,
                moment,
                domain_id,
                tenant_id,
            ),
        )
    if row is None:
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row


def record_certificate_error(
    db: _DbLike,
    *,
    tenant_id: str,
    domain_id: str,
    error: str,
    checked_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Record that the host could not be probed, or served something that does not verify.

    The previously observed certificate fields are left in place rather than cleared. They are the
    last thing that was true, and erasing them would replace "we saw a valid certificate an hour
    ago and cannot reach the host now" with "there has never been a certificate" — a materially
    different and less useful statement during an outage.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain.
        error: Why the probe failed.
        checked_at: When it ran; now when omitted.

    Returns:
        The updated row.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    moment = checked_at or _now()
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            f"""
            UPDATE apiome.slate_domains
               SET tls_status = 'error',
                   tls_error = %s,
                   certificate_checked_at = %s,
                   updated_at = %s
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (error, moment, moment, domain_id, tenant_id),
        )
    if row is None:
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row


def set_primary(db: _DbLike, *, tenant_id: str, domain_id: str) -> Dict[str, Any]:
    """Make one domain the lane's canonical host, demoting whichever held it.

    Both statements run on the same connection before either is observable, because
    ``uq_slate_domains_primary_per_environment`` permits exactly one primary per lane: promoting
    first would violate it, and demoting first without promoting would leave the lane with none.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain to promote.

    Returns:
        The promoted row.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        target = _fetch_one(
            cursor,
            """
            SELECT id, environment_id
              FROM apiome.slate_domains
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            """,
            (domain_id, tenant_id),
        )
        if target is None:
            raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")

        moment = _now()
        cursor.execute(
            """
            UPDATE apiome.slate_domains
               SET is_primary = FALSE, updated_at = %s
             WHERE environment_id = %s::uuid AND is_primary AND id <> %s::uuid
            """,
            (moment, str(target["environment_id"]), domain_id),
        )
        row = _fetch_one(
            cursor,
            f"""
            UPDATE apiome.slate_domains
               SET is_primary = TRUE, updated_at = %s
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (moment, domain_id, tenant_id),
        )
    if row is None:  # pragma: no cover - the target was just read under the same connection
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row


def set_auto_renew(db: _DbLike, *, tenant_id: str, domain_id: str, enabled: bool) -> Dict[str, Any]:
    """Switch automatic certificate renewal on or off for a domain.

    Switching it off also withdraws the edge's authorization to obtain a certificate for the host
    at all (:func:`app.slate_domains.authorize_issuance` refuses it), which is what makes this a
    way to park a domain rather than a setting that only takes effect in 90 days.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain.
        enabled: Whether the edge may renew.

    Returns:
        The updated row.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            f"""
            UPDATE apiome.slate_domains
               SET auto_renew = %s, updated_at = %s
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (enabled, _now(), domain_id, tenant_id),
        )
    if row is None:
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row


def detach_domain(db: _DbLike, *, tenant_id: str, domain_id: str) -> Dict[str, Any]:
    """Remove a domain from its lane.

    A hard delete, not a soft one: the row's whole purpose is to make ``UNIQUE (host)`` and the
    issuance authorization true statements, and a retained tombstone would keep a hostname claimed
    after the tenant stopped using it — including against a different tenant who later buys it.

    Args:
        db: Database handle.
        tenant_id: Caller's tenant.
        domain_id: The domain.

    Returns:
        The deleted row, so the caller can report what was removed.

    Raises:
        SlateDomainStoreError: ``domain_not_found`` when no row matched.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            f"""
            DELETE FROM apiome.slate_domains
             WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {DOMAIN_COLUMNS}
            """,
            (domain_id, tenant_id),
        )
    if row is None:
        raise SlateDomainStoreError("domain_not_found", f"Domain {domain_id} was not found.")
    return row
