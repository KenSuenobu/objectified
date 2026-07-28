"""Unit tests for PostgresSessionStore with a mocked pool (#4453)."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from apiome_mock.postgres_session_store import PostgresSessionStore
from apiome_mock.session_store import SessionCapacityError, SessionCaps, SessionKey


class _FakeCursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self._rows = rows or []
        self.rowcount = 0
        self.execute = AsyncMock(return_value=None)

    async def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)

    async def __aenter__(self) -> _FakeCursor:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


def test_postgres_list_and_get_roundtrip() -> None:
    caps = SessionCaps(
        ttl_seconds=3600,
        max_resources=10,
        max_bytes=10_000,
        max_sessions=10,
    )
    key = SessionKey("demo", "petstore", "1.0.0", "s1")

    cursor = _FakeCursor([{"resource": {"id": 1, "name": "Rex"}}])
    # First two executes are purge + touch; third is SELECT.
    cursor.execute = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    tx = AsyncMock()
    tx.__aenter__.return_value = None
    tx.__aexit__.return_value = None
    conn.transaction = MagicMock(return_value=tx)

    cm = AsyncMock()
    cm.__aenter__.return_value = conn
    cm.__aexit__.return_value = None
    pool = MagicMock()
    pool.connection = MagicMock(return_value=cm)

    store = PostgresSessionStore(pool, caps)

    async def _run() -> None:
        listed = await store.list_resources(key, "/pets")
        assert listed == [{"id": 1, "name": "Rex"}]

    asyncio.run(_run())


def _pool_with_cursor(rows: list[dict[str, Any]] | None = None) -> tuple[MagicMock, _FakeCursor]:
    """Build a mocked pool whose single connection yields one fake cursor."""
    cursor = _FakeCursor(rows)
    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    tx = AsyncMock()
    tx.__aenter__.return_value = None
    tx.__aexit__.return_value = None
    conn.transaction = MagicMock(return_value=tx)
    cm = AsyncMock()
    cm.__aenter__.return_value = conn
    cm.__aexit__.return_value = None
    pool = MagicMock()
    pool.connection = MagicMock(return_value=cm)
    return pool, cursor


def _caps(max_resources: int = 10, max_bytes: int = 10_000) -> SessionCaps:
    return SessionCaps(
        ttl_seconds=3600,
        max_resources=max_resources,
        max_bytes=max_bytes,
        max_sessions=10,
    )


KEY = SessionKey("demo", "petstore", "1.0.0", "s1")


def test_replace_session_seeds_in_one_transaction() -> None:
    pool, cursor = _pool_with_cursor([{"resource_count": 0, "total_bytes": 0, "session_count": 0}])
    store = PostgresSessionStore(pool, _caps())

    async def _run() -> None:
        count, size = await store.replace_session(
            KEY,
            {"/pets": [("1", {"id": 1, "name": "Rex"}), ("2", {"id": 2, "name": "Bella"})]},
        )
        assert count == 2
        assert size > 0

    asyncio.run(_run())
    statements = [call.args[0] for call in cursor.execute.await_args_list]
    assert any("DELETE FROM apiome.mock_session_state" in sql for sql in statements)
    assert sum("INSERT INTO apiome.mock_session_state" in sql for sql in statements) == 2
    # The DELETE clears the whole session namespace, not one collection/resource.
    delete_sql = next(sql for sql in statements if "DELETE" in sql and "session_token" in sql)
    assert "collection_path" not in delete_sql
    assert "resource_id" not in delete_sql


def test_replace_session_empty_seed_only_deletes() -> None:
    pool, cursor = _pool_with_cursor()
    store = PostgresSessionStore(pool, _caps())

    async def _run() -> None:
        assert await store.replace_session(KEY, {}) == (0, 0)

    asyncio.run(_run())
    statements = [call.args[0] for call in cursor.execute.await_args_list]
    assert any("DELETE FROM apiome.mock_session_state" in sql for sql in statements)
    assert not any("INSERT" in sql for sql in statements)


def test_replace_session_caps_fail_before_any_write() -> None:
    pool, cursor = _pool_with_cursor()
    store = PostgresSessionStore(pool, _caps(max_resources=1))

    async def _run() -> None:
        with pytest.raises(SessionCapacityError):
            await store.replace_session(
                KEY,
                {"/pets": [("1", {"id": 1}), ("2", {"id": 2})]},
            )

    asyncio.run(_run())
    cursor.execute.assert_not_awaited()


def test_replace_session_dedupes_duplicate_ids_last_wins() -> None:
    pool, cursor = _pool_with_cursor([{"resource_count": 0, "total_bytes": 0, "session_count": 0}])
    store = PostgresSessionStore(pool, _caps())

    async def _run() -> None:
        count, _ = await store.replace_session(
            KEY,
            {"/pets": [("1", {"id": 1, "name": "first"}), ("1", {"id": 1, "name": "second"})]},
        )
        assert count == 1

    asyncio.run(_run())
    inserts = [
        call.args[1]
        for call in cursor.execute.await_args_list
        if "INSERT INTO apiome.mock_session_state" in call.args[0]
    ]
    assert len(inserts) == 1
    assert '"second"' in inserts[0][6]
