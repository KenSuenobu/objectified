"""In-process session store with sliding TTL and size caps (#4453)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from apiome_mock.session_store import (
    SeedCollections,
    SessionCapacityError,
    SessionCaps,
    SessionKey,
    resource_byte_size,
)


@dataclass
class _SessionData:
    collections: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    next_ids: dict[str, int] = field(default_factory=dict)
    total_bytes: int = 0
    resource_count: int = 0
    expires_at: float = 0.0
    last_activity: float = 0.0


class InMemorySessionStore:
    """Thread-safe dict-backed session store for single-node / dev deployments."""

    def __init__(self, caps: SessionCaps, *, clock: Any | None = None) -> None:
        self._caps = caps
        self._clock = clock if clock is not None else time.monotonic
        self._lock = threading.Lock()
        self._sessions: dict[SessionKey, _SessionData] = {}

    def _now(self) -> float:
        return float(self._clock())

    def _purge_expired(self, now: float) -> None:
        expired = [k for k, s in self._sessions.items() if s.expires_at <= now]
        for k in expired:
            del self._sessions[k]

    def _touch(self, session: _SessionData, now: float) -> None:
        session.last_activity = now
        session.expires_at = now + self._caps.ttl_seconds

    def _get_live(self, key: SessionKey, now: float) -> _SessionData | None:
        self._purge_expired(now)
        session = self._sessions.get(key)
        if session is None:
            return None
        if session.expires_at <= now:
            del self._sessions[key]
            return None
        self._touch(session, now)
        return session

    def _ensure(self, key: SessionKey, now: float) -> _SessionData:
        session = self._get_live(key, now)
        if session is not None:
            return session
        if len(self._sessions) >= self._caps.max_sessions:
            raise SessionCapacityError(
                f"Session limit of {self._caps.max_sessions} reached; "
                "retry later or reuse an existing X-Mock-Session token.",
            )
        session = _SessionData()
        self._touch(session, now)
        self._sessions[key] = session
        return session

    async def list_resources(
        self,
        key: SessionKey,
        collection_path: str,
    ) -> list[dict[str, Any]]:
        now = self._now()
        with self._lock:
            session = self._get_live(key, now)
            if session is None:
                return []
            items = session.collections.get(collection_path, {})
            return [dict(v) for v in items.values()]

    async def get_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
    ) -> dict[str, Any] | None:
        now = self._now()
        with self._lock:
            session = self._get_live(key, now)
            if session is None:
                return None
            resource = session.collections.get(collection_path, {}).get(resource_id)
            return dict(resource) if resource is not None else None

    async def put_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
        resource: dict[str, Any],
        *,
        replace: bool,
    ) -> dict[str, Any]:
        payload = dict(resource)
        new_size = resource_byte_size(payload)
        now = self._now()
        with self._lock:
            session = self._ensure(key, now)
            bucket = session.collections.setdefault(collection_path, {})
            existing = bucket.get(resource_id)
            if existing is not None and not replace:
                # Idempotent create: overwrite with same id when client supplied it.
                pass
            old_size = resource_byte_size(existing) if existing is not None else 0
            delta_count = 0 if existing is not None else 1
            projected_count = session.resource_count + delta_count
            projected_bytes = session.total_bytes - old_size + new_size
            if projected_count > self._caps.max_resources:
                raise SessionCapacityError(
                    f"Session resource limit of {self._caps.max_resources} exceeded.",
                )
            if projected_bytes > self._caps.max_bytes:
                raise SessionCapacityError(
                    f"Session size limit of {self._caps.max_bytes} bytes exceeded.",
                )
            bucket[resource_id] = payload
            session.resource_count = projected_count
            session.total_bytes = projected_bytes
            self._touch(session, now)
            return dict(payload)

    async def delete_resource(
        self,
        key: SessionKey,
        collection_path: str,
        resource_id: str,
    ) -> bool:
        now = self._now()
        with self._lock:
            session = self._get_live(key, now)
            if session is None:
                return False
            bucket = session.collections.get(collection_path)
            if bucket is None or resource_id not in bucket:
                return False
            existing = bucket.pop(resource_id)
            session.resource_count = max(0, session.resource_count - 1)
            session.total_bytes = max(0, session.total_bytes - resource_byte_size(existing))
            if not bucket:
                del session.collections[collection_path]
            self._touch(session, now)
            return True

    async def replace_session(
        self,
        key: SessionKey,
        collections: SeedCollections,
    ) -> tuple[int, int]:
        """Swap in a fully built session snapshot; see the protocol for semantics (#4745)."""
        # Build and cap-check the candidate state before taking the lock, so a failed seed
        # never leaves the session half-replaced.
        built: dict[str, dict[str, dict[str, Any]]] = {}
        total_bytes = 0
        resource_count = 0
        for collection_path, items in collections.items():
            bucket: dict[str, dict[str, Any]] = {}
            for resource_id, resource in items:
                bucket[resource_id] = dict(resource)
            if not bucket:
                continue
            built[collection_path] = bucket
            resource_count += len(bucket)
            total_bytes += sum(resource_byte_size(item) for item in bucket.values())
        if resource_count > self._caps.max_resources:
            raise SessionCapacityError(
                f"Session resource limit of {self._caps.max_resources} exceeded.",
            )
        if total_bytes > self._caps.max_bytes:
            raise SessionCapacityError(
                f"Session size limit of {self._caps.max_bytes} bytes exceeded.",
            )

        now = self._now()
        with self._lock:
            self._purge_expired(now)
            existing = self._sessions.get(key)
            if not built:
                if existing is not None:
                    del self._sessions[key]
                return 0, 0
            if existing is None and len(self._sessions) >= self._caps.max_sessions:
                raise SessionCapacityError(
                    f"Session limit of {self._caps.max_sessions} reached; "
                    "retry later or reuse an existing X-Mock-Session token.",
                )
            session = _SessionData(
                collections=built,
                total_bytes=total_bytes,
                resource_count=resource_count,
            )
            self._touch(session, now)
            self._sessions[key] = session
            return resource_count, total_bytes

    async def next_integer_id(
        self,
        key: SessionKey,
        collection_path: str,
    ) -> int:
        now = self._now()
        with self._lock:
            session = self._ensure(key, now)
            current = session.next_ids.get(collection_path, 0) + 1
            # Also consider max existing numeric id in the collection.
            for rid in session.collections.get(collection_path, {}):
                try:
                    current = max(current, int(rid) + 1)
                except ValueError:
                    continue
            session.next_ids[collection_path] = current
            self._touch(session, now)
            return current
