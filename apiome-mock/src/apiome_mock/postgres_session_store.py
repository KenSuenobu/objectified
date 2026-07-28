"""Postgres-backed session store for multi-replica mock deployments (#4453)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from apiome_mock.session_store import (
    SeedCollections,
    SessionCapacityError,
    SessionCaps,
    SessionKey,
    resource_byte_size,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_resource(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        parsed = json.loads(value)
        return dict(parsed) if isinstance(parsed, dict) else None
    return None


class PostgresSessionStore:
    """Durable session CRUD store using ``apiome.mock_session_state``."""

    def __init__(self, pool: AsyncConnectionPool, caps: SessionCaps) -> None:
        self._pool = pool
        self._caps = caps

    def _expiry(self, now: datetime) -> datetime:
        return now + timedelta(seconds=self._caps.ttl_seconds)

    async def _purge_expired(self, cur: Any, now: datetime) -> None:
        await cur.execute(
            "DELETE FROM apiome.mock_session_state WHERE expires_at <= %s",
            (now,),
        )

    async def _touch_session(
        self,
        cur: Any,
        key: SessionKey,
        now: datetime,
    ) -> None:
        expires = self._expiry(now)
        await cur.execute(
            """
            UPDATE apiome.mock_session_state
            SET expires_at = %s, last_activity_at = %s
            WHERE tenant_slug = %s
              AND project_slug = %s
              AND version_label = %s
              AND session_token = %s
              AND expires_at > %s
            """,
            (
                expires,
                now,
                key.tenant,
                key.project,
                key.version,
                key.session_token,
                now,
            ),
        )

    async def _session_stats(
        self,
        cur: Any,
        key: SessionKey,
        now: datetime,
    ) -> tuple[int, int]:
        await cur.execute(
            """
            SELECT COUNT(*)::int AS resource_count,
                   COALESCE(SUM(byte_size), 0)::int AS total_bytes
            FROM apiome.mock_session_state
            WHERE tenant_slug = %s
              AND project_slug = %s
              AND version_label = %s
              AND session_token = %s
              AND expires_at > %s
            """,
            (key.tenant, key.project, key.version, key.session_token, now),
        )
        stats = await cur.fetchone()
        if stats is None:
            return 0, 0
        return int(stats["resource_count"]), int(stats["total_bytes"])

    async def _active_session_count(self, cur: Any, now: datetime) -> int:
        await cur.execute(
            """
            SELECT COUNT(DISTINCT (tenant_slug, project_slug, version_label, session_token))::int
              AS session_count
            FROM apiome.mock_session_state
            WHERE expires_at > %s
            """,
            (now,),
        )
        stats = await cur.fetchone()
        return int(stats["session_count"]) if stats else 0

    async def list_resources(
        self,
        key: SessionKey,
        collection_path: str,
    ) -> list[dict[str, Any]]:
        now = _utcnow()
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await self._purge_expired(cur, now)
                await self._touch_session(cur, key, now)
                await cur.execute(
                    """
                    SELECT resource
                    FROM apiome.mock_session_state
                    WHERE tenant_slug = %s
                      AND project_slug = %s
                      AND version_label = %s
                      AND session_token = %s
                      AND collection_path = %s
                      AND expires_at > %s
                    ORDER BY resource_id
                    """,
                    (
                        key.tenant,
                        key.project,
                        key.version,
                        key.session_token,
                        collection_path,
                        now,
                    ),
                )
                rows = await cur.fetchall()
                out: list[dict[str, Any]] = []
                for row in rows:
                    resource = _as_resource(row["resource"])
                    if resource is not None:
                        out.append(resource)
                return out

    async def get_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
    ) -> dict[str, Any] | None:
        now = _utcnow()
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await self._purge_expired(cur, now)
                await self._touch_session(cur, key, now)
                await cur.execute(
                    """
                    SELECT resource
                    FROM apiome.mock_session_state
                    WHERE tenant_slug = %s
                      AND project_slug = %s
                      AND version_label = %s
                      AND session_token = %s
                      AND collection_path = %s
                      AND resource_id = %s
                      AND expires_at > %s
                    """,
                    (
                        key.tenant,
                        key.project,
                        key.version,
                        key.session_token,
                        collection_path,
                        resource_id,
                        now,
                    ),
                )
                row = await cur.fetchone()
                if row is None:
                    return None
                return _as_resource(row["resource"])

    async def put_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
        resource: dict[str, Any],
        *,
        replace: bool,
    ) -> dict[str, Any]:
        del replace
        payload = dict(resource)
        new_size = resource_byte_size(payload)
        now = _utcnow()
        expires = self._expiry(now)
        async with self._pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor(row_factory=dict_row) as cur:
                    await self._purge_expired(cur, now)
                    await cur.execute(
                        """
                        SELECT byte_size
                        FROM apiome.mock_session_state
                        WHERE tenant_slug = %s
                          AND project_slug = %s
                          AND version_label = %s
                          AND session_token = %s
                          AND collection_path = %s
                          AND resource_id = %s
                          AND expires_at > %s
                        FOR UPDATE
                        """,
                        (
                            key.tenant,
                            key.project,
                            key.version,
                            key.session_token,
                            collection_path,
                            resource_id,
                            now,
                        ),
                    )
                    existing_row = await cur.fetchone()
                    count, total_bytes = await self._session_stats(cur, key, now)
                    if existing_row is None:
                        if count == 0:
                            active = await self._active_session_count(cur, now)
                            if active >= self._caps.max_sessions:
                                raise SessionCapacityError(
                                    f"Session limit of {self._caps.max_sessions} reached; "
                                    "retry later or reuse an existing X-Mock-Session token.",
                                )
                        if count + 1 > self._caps.max_resources:
                            raise SessionCapacityError(
                                f"Session resource limit of {self._caps.max_resources} exceeded.",
                            )
                        if total_bytes + new_size > self._caps.max_bytes:
                            raise SessionCapacityError(
                                f"Session size limit of {self._caps.max_bytes} bytes exceeded.",
                            )
                    else:
                        old_size = int(existing_row["byte_size"])
                        if total_bytes - old_size + new_size > self._caps.max_bytes:
                            raise SessionCapacityError(
                                f"Session size limit of {self._caps.max_bytes} bytes exceeded.",
                            )

                    await cur.execute(
                        """
                        INSERT INTO apiome.mock_session_state (
                            tenant_slug, project_slug, version_label, session_token,
                            collection_path, resource_id, resource, byte_size,
                            expires_at, last_activity_at
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s
                        )
                        ON CONFLICT (
                            tenant_slug, project_slug, version_label, session_token,
                            collection_path, resource_id
                        )
                        DO UPDATE SET
                            resource = EXCLUDED.resource,
                            byte_size = EXCLUDED.byte_size,
                            expires_at = EXCLUDED.expires_at,
                            last_activity_at = EXCLUDED.last_activity_at
                        """,
                        (
                            key.tenant,
                            key.project,
                            key.version,
                            key.session_token,
                            collection_path,
                            resource_id,
                            json.dumps(payload),
                            new_size,
                            expires,
                            now,
                        ),
                    )
                    await self._touch_session(cur, key, now)
                    return payload

    async def delete_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
    ) -> bool:
        now = _utcnow()
        async with self._pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor(row_factory=dict_row) as cur:
                    await self._purge_expired(cur, now)
                    await cur.execute(
                        """
                        DELETE FROM apiome.mock_session_state
                        WHERE tenant_slug = %s
                          AND project_slug = %s
                          AND version_label = %s
                          AND session_token = %s
                          AND collection_path = %s
                          AND resource_id = %s
                          AND expires_at > %s
                        """,
                        (
                            key.tenant,
                            key.project,
                            key.version,
                            key.session_token,
                            collection_path,
                            resource_id,
                            now,
                        ),
                    )
                    deleted = cur.rowcount > 0
                    if deleted:
                        await self._touch_session(cur, key, now)
                    return deleted

    async def replace_session(
        self,
        key: SessionKey,
        collections: SeedCollections,
    ) -> tuple[int, int]:
        """Replace the session's rows in one transaction; see the protocol for semantics (#4745)."""
        # Serialize and cap-check the seed before touching the database, so a failed seed
        # aborts before the DELETE and the previous state survives (the transaction would
        # roll back anyway, but failing early avoids pointless writes).
        deduped: dict[tuple[str, str], tuple[str, int]] = {}
        for collection_path, items in collections.items():
            for resource_id, resource in items:
                payload = dict(resource)
                # Last occurrence wins on a duplicate id, matching put semantics.
                deduped[(collection_path, resource_id)] = (
                    json.dumps(payload),
                    resource_byte_size(payload),
                )
        rows = [
            (collection_path, resource_id, payload_json, size)
            for (collection_path, resource_id), (payload_json, size) in deduped.items()
        ]
        total_bytes = sum(size for _, _, _, size in rows)
        if len(rows) > self._caps.max_resources:
            raise SessionCapacityError(
                f"Session resource limit of {self._caps.max_resources} exceeded.",
            )
        if total_bytes > self._caps.max_bytes:
            raise SessionCapacityError(
                f"Session size limit of {self._caps.max_bytes} bytes exceeded.",
            )

        now = _utcnow()
        expires = self._expiry(now)
        async with self._pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor(row_factory=dict_row) as cur:
                    await self._purge_expired(cur, now)
                    if rows:
                        count, _ = await self._session_stats(cur, key, now)
                        if count == 0:
                            active = await self._active_session_count(cur, now)
                            if active >= self._caps.max_sessions:
                                raise SessionCapacityError(
                                    f"Session limit of {self._caps.max_sessions} reached; "
                                    "retry later or reuse an existing X-Mock-Session token.",
                                )
                    await cur.execute(
                        """
                        DELETE FROM apiome.mock_session_state
                        WHERE tenant_slug = %s
                          AND project_slug = %s
                          AND version_label = %s
                          AND session_token = %s
                        """,
                        (key.tenant, key.project, key.version, key.session_token),
                    )
                    for collection_path, resource_id, payload_json, size in rows:
                        await cur.execute(
                            """
                            INSERT INTO apiome.mock_session_state (
                                tenant_slug, project_slug, version_label, session_token,
                                collection_path, resource_id, resource, byte_size,
                                expires_at, last_activity_at
                            ) VALUES (
                                %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s
                            )
                            ON CONFLICT (
                                tenant_slug, project_slug, version_label, session_token,
                                collection_path, resource_id
                            )
                            DO UPDATE SET
                                resource = EXCLUDED.resource,
                                byte_size = EXCLUDED.byte_size,
                                expires_at = EXCLUDED.expires_at,
                                last_activity_at = EXCLUDED.last_activity_at
                            """,
                            (
                                key.tenant,
                                key.project,
                                key.version,
                                key.session_token,
                                collection_path,
                                resource_id,
                                payload_json,
                                size,
                                expires,
                                now,
                            ),
                        )
                    return len(rows), total_bytes

    async def next_integer_id(
        self,
        key: SessionKey,
        collection_path: str,
    ) -> int:
        now = _utcnow()
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await self._purge_expired(cur, now)
                await cur.execute(
                    """
                    SELECT resource_id
                    FROM apiome.mock_session_state
                    WHERE tenant_slug = %s
                      AND project_slug = %s
                      AND version_label = %s
                      AND session_token = %s
                      AND collection_path = %s
                      AND expires_at > %s
                    """,
                    (
                        key.tenant,
                        key.project,
                        key.version,
                        key.session_token,
                        collection_path,
                        now,
                    ),
                )
                rows = await cur.fetchall()
                current = 1
                for row in rows:
                    try:
                        current = max(current, int(row["resource_id"]) + 1)
                    except (TypeError, ValueError):
                        continue
                await self._touch_session(cur, key, now)
                return current
