"""Unit tests for the shared export artifact store driver (IXH-6.1, #5120)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.config import settings
from app.export_artifact_store import (
    BACKEND_DB,
    DefaultExportArtifactStore,
    ExportArtifactExpired,
    ExportArtifactNotFound,
    ExportArtifactStoreNotConfigured,
    ExportArtifactTooLarge,
    body_as_bytes,
    content_sha256_hex,
    content_sha256_hex_only,
    digest_header_value,
)


def test_content_sha256_and_digest_headers_round_trip():
    data = b"hello-export"
    digest = content_sha256_hex(data)
    assert digest.startswith("sha256:")
    assert len(content_sha256_hex_only(digest)) == 64
    header = digest_header_value(digest)
    assert header.startswith("sha-256=")


def test_put_and_get_via_db_backend():
    store = DefaultExportArtifactStore()
    body = b'{"openapi":"3.1.0"}'
    record = store.put(
        job_id="job-1",
        tenant_slug="acme",
        body=body,
        media_type="application/json",
        filename="openapi.json",
        expires_at=None,
    )
    assert record.backend == BACKEND_DB
    assert record.content_sha256 == content_sha256_hex(body)
    loaded = store.get("acme", "job-1")
    assert loaded.content == body
    assert loaded.filename == "openapi.json"


def test_get_wrong_tenant_is_not_found():
    store = DefaultExportArtifactStore()
    store.put(
        job_id="job-2",
        tenant_slug="acme",
        body=b"secret",
        media_type="text/plain",
        filename="x.txt",
        expires_at=None,
    )
    with pytest.raises(ExportArtifactNotFound):
        store.get("other", "job-2")


def test_get_expired_raises():
    store = DefaultExportArtifactStore()
    store.put(
        job_id="job-3",
        tenant_slug="acme",
        body=b"stale",
        media_type="text/plain",
        filename="x.txt",
        expires_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    with pytest.raises(ExportArtifactExpired):
        store.get("acme", "job-3")


def test_size_cap_raises_too_large(monkeypatch):
    monkeypatch.setattr(settings, "export_artifact_max_bytes", 10)
    monkeypatch.setattr(settings, "export_artifact_db_max_bytes", 10)
    store = DefaultExportArtifactStore()
    with pytest.raises(ExportArtifactTooLarge) as excinfo:
        store.put(
            job_id="job-4",
            tenant_slug="acme",
            body=b"x" * 20,
            media_type="text/plain",
            filename="x.txt",
            expires_at=None,
        )
    assert excinfo.value.size_bytes == 20
    assert excinfo.value.max_bytes == 10


def test_object_store_stub_selected_above_db_max(monkeypatch):
    monkeypatch.setattr(settings, "export_artifact_max_bytes", 1000)
    monkeypatch.setattr(settings, "export_artifact_db_max_bytes", 10)
    store = DefaultExportArtifactStore()
    with pytest.raises(ExportArtifactStoreNotConfigured):
        store.put(
            job_id="job-5",
            tenant_slug="acme",
            body=b"x" * 50,
            media_type="text/plain",
            filename="x.txt",
            expires_at=None,
        )


def test_body_as_bytes_encodes_str():
    assert body_as_bytes("abc") == b"abc"
    assert body_as_bytes(b"abc") == b"abc"
