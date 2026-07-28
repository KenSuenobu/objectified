"""Unit tests for InMemorySessionStore (#4453)."""

from __future__ import annotations

import asyncio

import pytest

from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.session_store import SessionCapacityError, SessionCaps, SessionKey


@pytest.fixture
def caps() -> SessionCaps:
    return SessionCaps(
        ttl_seconds=3600.0,
        max_resources=3,
        max_bytes=10_000,
        max_sessions=2,
    )


@pytest.fixture
def key() -> SessionKey:
    return SessionKey("demo", "petstore", "1.0.0", "s1")


def test_put_list_get_delete(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)

    async def _run() -> None:
        await store.put_resource(key, "/pets", "1", {"id": 1, "name": "Rex"}, replace=True)
        listed = await store.list_resources(key, "/pets")
        assert listed == [{"id": 1, "name": "Rex"}]
        got = await store.get_resource(key, "/pets", "1")
        assert got == {"id": 1, "name": "Rex"}
        assert await store.delete_resource(key, "/pets", "1") is True
        assert await store.get_resource(key, "/pets", "1") is None
        assert await store.list_resources(key, "/pets") == []

    asyncio.run(_run())


def test_session_isolation(caps: SessionCaps) -> None:
    store = InMemorySessionStore(caps)
    a = SessionKey("demo", "petstore", "1.0.0", "s1")
    b = SessionKey("demo", "petstore", "1.0.0", "s2")

    async def _run() -> None:
        await store.put_resource(a, "/pets", "1", {"id": 1, "name": "A"}, replace=True)
        await store.put_resource(b, "/pets", "1", {"id": 1, "name": "B"}, replace=True)
        assert await store.list_resources(a, "/pets") == [{"id": 1, "name": "A"}]
        assert await store.list_resources(b, "/pets") == [{"id": 1, "name": "B"}]

    asyncio.run(_run())


def test_sliding_ttl_expiry(key: SessionKey) -> None:
    clock = {"now": 1000.0}

    def now() -> float:
        return clock["now"]

    short = SessionCaps(
        ttl_seconds=10.0,
        max_resources=10,
        max_bytes=10_000,
        max_sessions=10,
    )
    store = InMemorySessionStore(short, clock=now)

    async def _run() -> None:
        await store.put_resource(key, "/pets", "1", {"id": 1, "name": "Rex"}, replace=True)
        clock["now"] = 1005.0
        assert await store.get_resource(key, "/pets", "1") is not None
        clock["now"] = 1020.0
        assert await store.get_resource(key, "/pets", "1") is None

    asyncio.run(_run())


def test_resource_cap(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)

    async def _run() -> None:
        await store.put_resource(key, "/pets", "1", {"id": 1}, replace=True)
        await store.put_resource(key, "/pets", "2", {"id": 2}, replace=True)
        await store.put_resource(key, "/pets", "3", {"id": 3}, replace=True)
        with pytest.raises(SessionCapacityError):
            await store.put_resource(key, "/pets", "4", {"id": 4}, replace=True)

    asyncio.run(_run())


def test_next_integer_id(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)

    async def _run() -> None:
        assert await store.next_integer_id(key, "/pets") == 1
        await store.put_resource(key, "/pets", "5", {"id": 5}, replace=True)
        assert await store.next_integer_id(key, "/pets") == 6

    asyncio.run(_run())


def test_replace_session_seeds_and_reports_counts(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)

    async def _run() -> None:
        await store.put_resource(key, "/orders", "9", {"id": 9}, replace=True)
        count, size = await store.replace_session(
            key,
            {"/pets": [("1", {"id": 1, "name": "Rex"}), ("2", {"id": 2, "name": "Bella"})]},
        )
        assert count == 2
        assert size > 0
        # Previous state is gone; only the seed remains.
        assert await store.list_resources(key, "/orders") == []
        assert await store.get_resource(key, "/pets", "2") == {"id": 2, "name": "Bella"}
        # Integer id allocation continues after the highest seeded numeric id.
        assert await store.next_integer_id(key, "/pets") == 3

    asyncio.run(_run())


def test_replace_session_empty_clears_and_frees_the_slot(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)
    other = SessionKey("demo", "petstore", "1.0.0", "s2")
    third = SessionKey("demo", "petstore", "1.0.0", "s3")

    async def _run() -> None:
        await store.put_resource(key, "/pets", "1", {"id": 1}, replace=True)
        await store.put_resource(other, "/pets", "1", {"id": 1}, replace=True)
        assert await store.replace_session(key, {}) == (0, 0)
        assert await store.list_resources(key, "/pets") == []
        # max_sessions is 2; the cleared slot is reusable by a brand-new session.
        await store.put_resource(third, "/pets", "1", {"id": 1}, replace=True)

    asyncio.run(_run())


def test_replace_session_failure_keeps_previous_state(caps: SessionCaps, key: SessionKey) -> None:
    store = InMemorySessionStore(caps)
    oversized = {"/pets": [(str(i), {"id": i}) for i in range(1, 5)]}  # max_resources is 3

    async def _run() -> None:
        await store.put_resource(key, "/pets", "1", {"id": 1, "name": "Keep"}, replace=True)
        with pytest.raises(SessionCapacityError):
            await store.replace_session(key, oversized)
        assert await store.get_resource(key, "/pets", "1") == {"id": 1, "name": "Keep"}

    asyncio.run(_run())


def test_replace_session_byte_cap(key: SessionKey) -> None:
    tiny = SessionCaps(ttl_seconds=3600.0, max_resources=100, max_bytes=10, max_sessions=2)
    store = InMemorySessionStore(tiny)

    async def _run() -> None:
        with pytest.raises(SessionCapacityError):
            await store.replace_session(key, {"/pets": [("1", {"id": 1, "name": "too-big"})]})

    asyncio.run(_run())


def test_replace_session_new_session_respects_session_cap(caps: SessionCaps) -> None:
    store = InMemorySessionStore(caps)
    seed = {"/pets": [("1", {"id": 1})]}

    async def _run() -> None:
        await store.replace_session(SessionKey("demo", "petstore", "1.0.0", "s1"), seed)
        await store.replace_session(SessionKey("demo", "petstore", "1.0.0", "s2"), seed)
        with pytest.raises(SessionCapacityError):
            await store.replace_session(SessionKey("demo", "petstore", "1.0.0", "s3"), seed)
        # Re-seeding an existing session does not need a new slot.
        await store.replace_session(SessionKey("demo", "petstore", "1.0.0", "s1"), seed)

    asyncio.run(_run())


def test_replace_session_only_touches_its_own_namespace() -> None:
    roomy = SessionCaps(ttl_seconds=3600.0, max_resources=3, max_bytes=10_000, max_sessions=10)
    store = InMemorySessionStore(roomy)
    mine = SessionKey("demo", "petstore", "1.0.0", "shared")
    other_version = SessionKey("demo", "petstore", "2.0.0", "shared")
    other_tenant = SessionKey("acme", "petstore", "1.0.0", "shared")

    async def _run() -> None:
        await store.put_resource(other_version, "/pets", "1", {"id": 1, "name": "V2"}, replace=True)
        await store.put_resource(other_tenant, "/pets", "1", {"id": 1, "name": "Acme"}, replace=True)
        await store.replace_session(mine, {"/pets": [("1", {"id": 1, "name": "Mine"})]})
        await store.replace_session(mine, {})
        assert await store.get_resource(other_version, "/pets", "1") == {"id": 1, "name": "V2"}
        assert await store.get_resource(other_tenant, "/pets", "1") == {"id": 1, "name": "Acme"}

    asyncio.run(_run())
