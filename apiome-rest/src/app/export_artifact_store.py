"""Shared export artifact store — driver interface + DB/object-store backends (IXH-6.1, #5120).

V158 shared export *status* via ``apiome.async_job``, but download bytes stayed on the owning
process. This module persists the delivery payload (single-file UTF-8 or multi-file zip) behind
a backend interface so any instance can serve ``GET …/jobs/{id}/download``.

* **DB backend** (shipped) — size-bounded BYTEA on ``apiome.export_job_artifact``.
* **Object-store backend** (stub) — selected when size exceeds the DB threshold but is still
  under the hard cap; raises a clear configuration error until a real store is wired.

The owning instance may keep an in-memory :class:`~app.emitter.EmitResult` as a fast path;
the shared store is authoritative for non-owners and for content-hash integrity headers.
"""

from __future__ import annotations

import base64
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Protocol, runtime_checkable

from .config import settings

BACKEND_DB = "db"
BACKEND_OBJECT_STORE = "object_store"

_SHA256_PREFIX = "sha256:"


class ExportArtifactTooLarge(Exception):
    """Raised when the delivery payload exceeds ``export_artifact_max_bytes``."""

    def __init__(self, size_bytes: int, max_bytes: int) -> None:
        self.size_bytes = size_bytes
        self.max_bytes = max_bytes
        super().__init__(
            f"Export artifact is {size_bytes} bytes, which exceeds the configured size cap "
            f"of {max_bytes} bytes; reduce the source or raise "
            f"APIOME_EXPORT_ARTIFACT_MAX_BYTES."
        )


class ExportArtifactStoreNotConfigured(Exception):
    """Raised when the object-store backend is selected but not implemented/configured."""

    def __init__(self, size_bytes: int, db_max_bytes: int) -> None:
        self.size_bytes = size_bytes
        self.db_max_bytes = db_max_bytes
        super().__init__(
            f"Export artifact is {size_bytes} bytes, above the DB store limit of "
            f"{db_max_bytes} bytes, but no object-store backend is configured."
        )


class ExportArtifactExpired(Exception):
    """Raised when a shared artifact exists but its retention window has elapsed."""


class ExportArtifactNotFound(Exception):
    """Raised when no shared artifact exists for the (tenant, job) pair."""


@dataclass(frozen=True)
class ExportArtifactRecord:
    """One shared export download payload (meta + optional body)."""

    job_id: str
    tenant_slug: str
    content_sha256: str
    size_bytes: int
    media_type: str
    filename: str
    backend: str
    content: Optional[bytes]
    storage_uri: Optional[str]
    expires_at: Optional[datetime]
    reaped_at: Optional[datetime]
    created_at: Optional[datetime] = None

    @property
    def is_expired(self) -> bool:
        """True when the retention window has elapsed or the row was reaped."""
        if self.reaped_at is not None:
            return True
        if self.expires_at is None:
            return False
        now = datetime.now(timezone.utc)
        exp = self.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return now >= exp


def content_sha256_hex(data: bytes) -> str:
    """Return ``sha256:<hex>`` over the exact download body bytes."""
    return f"{_SHA256_PREFIX}{hashlib.sha256(data).hexdigest()}"


def digest_header_value(content_sha256: str) -> str:
    """RFC-style ``Digest`` header value for a ``sha256:<hex>`` digest.

    Args:
        content_sha256: Digest in ``sha256:<hex>`` form.

    Returns:
        ``sha-256=<base64>`` suitable for the ``Digest`` response header.
    """
    hex_part = content_sha256[len(_SHA256_PREFIX) :] if content_sha256.startswith(_SHA256_PREFIX) else content_sha256
    digest_bytes = bytes.fromhex(hex_part)
    return f"sha-256={base64.b64encode(digest_bytes).decode('ascii')}"


def content_sha256_hex_only(content_sha256: str) -> str:
    """Strip the ``sha256:`` prefix for the ``X-Content-SHA256`` header."""
    if content_sha256.startswith(_SHA256_PREFIX):
        return content_sha256[len(_SHA256_PREFIX) :]
    return content_sha256


def body_as_bytes(body: str | bytes) -> bytes:
    """Normalize a download body to UTF-8 bytes (str) or passthrough (bytes)."""
    return body.encode("utf-8") if isinstance(body, str) else body


def expires_at_from_ms(expires_at_ms: Optional[int]) -> Optional[datetime]:
    """Convert epoch-ms retention deadline to an aware UTC datetime (or None)."""
    if expires_at_ms is None:
        return None
    return datetime.fromtimestamp(expires_at_ms / 1000.0, tz=timezone.utc)


@runtime_checkable
class ExportArtifactBackend(Protocol):
    """Storage driver for shared export download payloads."""

    def put(self, record: ExportArtifactRecord) -> None:
        """Persist ``record`` (including content for the DB backend)."""

    def get(self, tenant_slug: str, job_id: str) -> ExportArtifactRecord:
        """Load a tenant-scoped artifact; raise NotFound / Expired as appropriate."""

    def delete(self, tenant_slug: str, job_id: str) -> bool:
        """Delete an artifact row; return True when a row was removed."""


class DbExportArtifactBackend:
    """PostgreSQL BYTEA backend for size-bounded export artifacts."""

    def put(self, record: ExportArtifactRecord) -> None:
        from .database import db

        if record.content is None:
            raise ValueError("DB backend requires content bytes")
        db.upsert_export_job_artifact(
            job_id=record.job_id,
            tenant_slug=record.tenant_slug,
            content_sha256=record.content_sha256,
            size_bytes=record.size_bytes,
            media_type=record.media_type,
            filename=record.filename,
            backend=BACKEND_DB,
            content=record.content,
            storage_uri=None,
            expires_at=record.expires_at,
        )

    def get(self, tenant_slug: str, job_id: str) -> ExportArtifactRecord:
        from .database import db

        row = db.get_export_job_artifact(job_id, tenant_slug)
        if row is None:
            raise ExportArtifactNotFound(job_id)
        record = _row_to_record(row)
        if record.is_expired:
            raise ExportArtifactExpired(job_id)
        if record.content is None:
            raise ExportArtifactExpired(job_id)
        return record

    def delete(self, tenant_slug: str, job_id: str) -> bool:
        from .database import db

        return db.delete_export_job_artifact(job_id, tenant_slug)


class ObjectStoreExportArtifactBackend:
    """Stub object-store backend — selected for large artifacts until a real store lands."""

    def put(self, record: ExportArtifactRecord) -> None:
        raise ExportArtifactStoreNotConfigured(record.size_bytes, settings.export_artifact_db_max_bytes)

    def get(self, tenant_slug: str, job_id: str) -> ExportArtifactRecord:
        raise ExportArtifactStoreNotConfigured(0, settings.export_artifact_db_max_bytes)

    def delete(self, tenant_slug: str, job_id: str) -> bool:
        raise ExportArtifactStoreNotConfigured(0, settings.export_artifact_db_max_bytes)


class ExportArtifactStore(ABC):
    """Facade: size checks, backend selection, put/get for the export engine."""

    @abstractmethod
    def put(
        self,
        *,
        job_id: str,
        tenant_slug: str,
        body: bytes,
        media_type: str,
        filename: str,
        expires_at: Optional[datetime],
    ) -> ExportArtifactRecord:
        """Validate size, hash, select backend, and persist."""

    @abstractmethod
    def get(self, tenant_slug: str, job_id: str) -> ExportArtifactRecord:
        """Load a tenant-scoped artifact (raises NotFound / Expired)."""

    @abstractmethod
    def delete(self, tenant_slug: str, job_id: str) -> bool:
        """Delete a tenant-scoped artifact row."""


class DefaultExportArtifactStore(ExportArtifactStore):
    """Production facade over the DB and (stub) object-store backends."""

    def __init__(
        self,
        *,
        db_backend: Optional[ExportArtifactBackend] = None,
        object_store_backend: Optional[ExportArtifactBackend] = None,
    ) -> None:
        self._db = db_backend or DbExportArtifactBackend()
        self._object_store = object_store_backend or ObjectStoreExportArtifactBackend()

    def select_backend(self, size_bytes: int) -> ExportArtifactBackend:
        """Choose DB vs object-store from size and the configured thresholds."""
        max_bytes = settings.export_artifact_max_bytes
        db_max = settings.export_artifact_db_max_bytes
        if size_bytes > max_bytes:
            raise ExportArtifactTooLarge(size_bytes, max_bytes)
        if size_bytes <= db_max:
            return self._db
        return self._object_store

    def put(
        self,
        *,
        job_id: str,
        tenant_slug: str,
        body: bytes,
        media_type: str,
        filename: str,
        expires_at: Optional[datetime],
    ) -> ExportArtifactRecord:
        size_bytes = len(body)
        backend = self.select_backend(size_bytes)
        digest = content_sha256_hex(body)
        backend_name = BACKEND_DB if backend is self._db else BACKEND_OBJECT_STORE
        record = ExportArtifactRecord(
            job_id=job_id,
            tenant_slug=tenant_slug,
            content_sha256=digest,
            size_bytes=size_bytes,
            media_type=media_type,
            filename=filename,
            backend=backend_name,
            content=body if backend_name == BACKEND_DB else None,
            storage_uri=None,
            expires_at=expires_at,
            reaped_at=None,
        )
        backend.put(record)
        return record

    def get(self, tenant_slug: str, job_id: str) -> ExportArtifactRecord:
        # Reads always go through the DB metadata row (even object-store backends record
        # metadata there). The DB backend.get enforces tenant scope + expiry.
        return self._db.get(tenant_slug, job_id)

    def delete(self, tenant_slug: str, job_id: str) -> bool:
        return self._db.delete(tenant_slug, job_id)


_store: Optional[ExportArtifactStore] = None


def get_export_artifact_store() -> ExportArtifactStore:
    """Return the process-wide artifact store singleton."""
    global _store
    if _store is None:
        _store = DefaultExportArtifactStore()
    return _store


def set_export_artifact_store(store: Optional[ExportArtifactStore]) -> None:
    """Replace (or clear) the process-wide store — for tests."""
    global _store
    _store = store


def put_export_artifact(
    *,
    job_id: str,
    tenant_slug: str,
    body: bytes,
    media_type: str,
    filename: str,
    expires_at_ms: Optional[int],
) -> ExportArtifactRecord:
    """Persist a delivery payload via the default store (size-checked, hashed)."""
    return get_export_artifact_store().put(
        job_id=job_id,
        tenant_slug=tenant_slug,
        body=body,
        media_type=media_type,
        filename=filename,
        expires_at=expires_at_from_ms(expires_at_ms),
    )


def get_export_artifact(tenant_slug: str, job_id: str) -> ExportArtifactRecord:
    """Load a tenant-scoped shared artifact (raises NotFound / Expired)."""
    return get_export_artifact_store().get(tenant_slug, job_id)


def _row_to_record(row: dict) -> ExportArtifactRecord:
    """Map a ``get_export_job_artifact`` row dict onto :class:`ExportArtifactRecord`."""
    content = row.get("content")
    if content is not None and not isinstance(content, (bytes, bytearray)):
        content = bytes(content)
    elif isinstance(content, bytearray):
        content = bytes(content)
    return ExportArtifactRecord(
        job_id=row["job_id"],
        tenant_slug=row["tenant_slug"],
        content_sha256=row["content_sha256"],
        size_bytes=int(row["size_bytes"]),
        media_type=row["media_type"],
        filename=row["filename"],
        backend=row["backend"],
        content=content,
        storage_uri=row.get("storage_uri"),
        expires_at=row.get("expires_at"),
        reaped_at=row.get("reaped_at"),
        created_at=row.get("created_at"),
    )
