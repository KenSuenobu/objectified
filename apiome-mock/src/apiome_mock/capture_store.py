"""Persistence for guarded proxy captures (#4747, PMR-2.4).

The runtime's write half of the review queue: it resolves the version a capture belongs to from
the URL coordinates the mock already has, inserts the *already redacted* record, and appends an
audit row so the tenant ledger shows that recording happened at all — not only that it was
authorized.

Two rules are enforced here rather than trusted to the caller:

* **Scope.** Every statement is bound to ``tenant_id`` *and* the resolved ``versions.id``. A
  capture recorded against one version can never be written into another's queue, and a mock
  serving a version the tenant does not own resolves to nothing and stores nothing.
* **Best effort, never fatal.** Capture is an opt-in development aid layered on the data plane. A
  database failure here degrades to "not recorded" — reported on the response and in the logs —
  and never turns a served request into a 500. :mod:`apiome_mock.capture` owns that policy; this
  module simply returns ``None`` when it cannot resolve the version.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Mapping, Sequence
from uuid import UUID

import structlog
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from apiome_mock.audit import insert_mock_audit_entry

__all__ = [
    "CAPTURE_AUDIT_ACTION",
    "count_pending_captures",
    "insert_capture_exchange",
    "resolve_version_id",
]

_log = structlog.get_logger(__name__)

#: Ledger action recorded for every stored capture. Distinct from ``mock.request`` because the two
#: answer different questions: one is "traffic was served", this is "traffic was recorded".
CAPTURE_AUDIT_ACTION = "mock.capture"

_RESOLVE_VERSION = """
    SELECT v.id
    FROM apiome.versions v
    INNER JOIN apiome.projects p ON p.id = v.project_id AND p.deleted_at IS NULL
    INNER JOIN apiome.tenants t ON t.id = p.tenant_id AND t.deleted_at IS NULL
    WHERE t.slug = %(tenant)s
      AND p.slug = %(project)s
      AND v.version_id = %(version)s
      AND p.tenant_id = %(tenant_id)s
      AND v.deleted_at IS NULL
    LIMIT 1
"""

_COUNT_PENDING = """
    SELECT COUNT(*) AS pending
    FROM apiome.mock_capture_exchange
    WHERE version_id = %(version_id)s
      AND tenant_id = %(tenant_id)s
      AND review_state = 'pending'
      AND expires_at > CURRENT_TIMESTAMP
"""

_INSERT_CAPTURE = """
    INSERT INTO apiome.mock_capture_exchange
      (tenant_id, version_id, upstream, allowlist_entry, policy_digest, captured_by,
       operation_key, request_method, request_path, status_code, exchange, exchange_digest,
       redactions, redaction_count, schema_valid, validation_errors, expires_at)
    VALUES
      (%(tenant_id)s, %(version_id)s, %(upstream)s, %(allowlist_entry)s, %(policy_digest)s,
       %(captured_by)s, %(operation_key)s, %(method)s, %(path)s, %(status_code)s,
       %(exchange)s::jsonb, %(digest)s, %(redactions)s::jsonb, %(redaction_count)s,
       %(schema_valid)s, %(validation_errors)s::jsonb, %(expires_at)s)
    RETURNING id
"""


async def resolve_version_id(
    pool: AsyncConnectionPool,
    *,
    tenant_id: UUID,
    tenant: str,
    project: str,
    version: str,
) -> UUID | None:
    """Resolve the ``versions.id`` a mock's URL coordinates name, within one tenant.

    Args:
        pool: The runtime's database pool.
        tenant_id: The tenant the caller's API key belongs to; the row must be inside it.
        tenant: Tenant slug from the URL.
        project: Project slug from the URL.
        version: Version label from the URL.

    Returns:
        The version record id, or ``None`` when the coordinates name nothing in this tenant.
    """
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                _RESOLVE_VERSION,
                {"tenant": tenant, "project": project, "version": version, "tenant_id": tenant_id},
            )
            row = await cur.fetchone()
    return row["id"] if row else None


async def count_pending_captures(
    pool: AsyncConnectionPool,
    *,
    tenant_id: UUID,
    tenant: str,
    project: str,
    version: str,
) -> int:
    """Return how many unreviewed captures this version already holds.

    The runtime stops recording once the queue is full. An unbounded queue would let one
    long-running capture session fill storage with traffic nobody has looked at — exactly the
    accumulation the retention rule exists to prevent.

    Args:
        pool: The runtime's database pool.
        tenant_id: Tenant scope.
        tenant: Tenant slug from the URL.
        project: Project slug from the URL.
        version: Version label from the URL.

    Returns:
        The pending count (``0`` when the version cannot be resolved).
    """
    version_id = await resolve_version_id(pool, tenant_id=tenant_id, tenant=tenant, project=project, version=version)
    if version_id is None:
        return 0
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(_COUNT_PENDING, {"version_id": version_id, "tenant_id": tenant_id})
            row = await cur.fetchone()
    return int(row["pending"]) if row else 0


async def insert_capture_exchange(
    pool: AsyncConnectionPool,
    *,
    tenant_id: UUID,
    tenant: str,
    project: str,
    version: str,
    upstream: str,
    allowlist_entry: str,
    policy_digest: str,
    api_key_id: UUID | None,
    operation_key: str | None,
    method: str,
    path: str,
    status_code: int,
    record: Mapping[str, Any],
    digest: str,
    redactions: Sequence[Mapping[str, str]],
    schema_valid: bool | None,
    validation_errors: Sequence[str],
    expires_at: datetime,
) -> str | None:
    """Store one redacted capture in the review queue and audit that it happened.

    The caller is responsible for the record being redacted and credential-clean; this function
    stores what it is given. The audit row it appends carries the capture's coordinates, upstream,
    and redaction count — never any captured content.

    Args:
        pool: The runtime's database pool.
        tenant_id: Tenant that owns the capture.
        tenant: Tenant slug from the URL.
        project: Project slug from the URL.
        version: Version label from the URL.
        upstream: Fetched upstream URL, query string already removed.
        allowlist_entry: The allowlist entry that authorized the fetch.
        policy_digest: Digest of the capture policy in force.
        api_key_id: The API key that drove the capture.
        operation_key: The matched spec operation, when the request matched one.
        method: Request method.
        path: Request path relative to the version prefix.
        status_code: Upstream response status.
        record: The redacted ``apiome.mock.capture/v1`` document.
        digest: Content digest of that document.
        redactions: The redaction decision list.
        schema_valid: Whether the response matched the contract (``None`` when unchecked).
        validation_errors: Schema validation errors for the response.
        expires_at: When retention removes the capture.

    Returns:
        The new capture's id, or ``None`` when the version could not be resolved.
    """
    version_id = await resolve_version_id(pool, tenant_id=tenant_id, tenant=tenant, project=project, version=version)
    if version_id is None:
        _log.warning(
            "mock_capture_version_unresolved",
            tenant=tenant,
            project=project,
            version=version,
        )
        return None

    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                _INSERT_CAPTURE,
                {
                    "tenant_id": tenant_id,
                    "version_id": version_id,
                    "upstream": upstream,
                    "allowlist_entry": allowlist_entry,
                    "policy_digest": policy_digest,
                    "captured_by": api_key_id,
                    "operation_key": operation_key,
                    "method": method,
                    "path": path,
                    "status_code": status_code,
                    "exchange": json.dumps(record, sort_keys=True, default=str),
                    "digest": digest,
                    "redactions": json.dumps(list(redactions), default=str),
                    "redaction_count": len(redactions),
                    "schema_valid": schema_valid,
                    "validation_errors": json.dumps(list(validation_errors), default=str),
                    "expires_at": expires_at,
                },
            )
            row = await cur.fetchone()
        await conn.commit()

    capture_id = str(row["id"]) if row else None
    if capture_id is None:
        return None

    await insert_mock_audit_entry(
        pool,
        tenant_id=tenant_id,
        actor_label=str(api_key_id) if api_key_id else "capture",
        action=CAPTURE_AUDIT_ACTION,
        target=f"{project}/{version} {method} {path}",
        detail={
            "projectSlug": project,
            "versionLabel": version,
            "method": method,
            "path": path,
            "statusCode": status_code,
            "upstream": upstream,
            "allowlistEntry": allowlist_entry,
            "policyDigest": policy_digest,
            "captureId": capture_id,
            "redactions": len(redactions),
            "schemaValid": schema_valid,
            "apiKeyId": str(api_key_id) if api_key_id else None,
        },
    )
    return capture_id
