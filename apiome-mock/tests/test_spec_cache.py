"""Compiled spec LRU cache tests."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import uuid4

from app.mock_routing import extract_operations

from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "array"}}},
                    }
                }
            }
        }
    },
}


def _compiled() -> CompiledSpec:
    operations = tuple(extract_operations(PETSTORE_SPEC))
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=operations,
    )


def test_cache_hit_and_lru_eviction() -> None:
    cache = SpecCache(max_entries=1, ttl_seconds=60.0)
    first = _compiled()
    second = _compiled()
    second = CompiledSpec(
        revision_id=second.revision_id,
        tenant_slug="other",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=second.updated_at,
        spec=second.spec,
        operations=second.operations,
    )
    cache.put(first)
    cache.put(second)
    assert cache.get("demo", "petstore", "1.0.0") is None
    assert cache.get("other", "petstore", "1.0.0") is not None


def test_cache_ttl_expiry(monkeypatch) -> None:
    cache = SpecCache(max_entries=8, ttl_seconds=0.01)
    compiled = _compiled()
    cache.put(compiled)
    assert cache.get("demo", "petstore", "1.0.0") is not None
    time.sleep(0.02)
    assert cache.get("demo", "petstore", "1.0.0") is None


def test_cache_invalidate() -> None:
    cache = SpecCache(max_entries=8, ttl_seconds=60.0)
    compiled = _compiled()
    cache.put(compiled)
    cache.invalidate("demo", "petstore", "1.0.0")
    assert cache.get("demo", "petstore", "1.0.0") is None
