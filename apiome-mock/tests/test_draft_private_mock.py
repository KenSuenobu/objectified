"""Draft private mock access tests (#4446, SIM-2.5)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.api_key import ValidatedApiKey
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec, get_mock_access_status

PETSTORE_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "example": [{"id": 7, "name": "Rex"}],
                            }
                        },
                    }
                }
            }
        }
    },
}


def _compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="2.0.0-draft",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
    )


def _validated_key() -> ValidatedApiKey:
    return ValidatedApiKey(
        id=uuid4(),
        tenant_id=uuid4(),
        tenant_slug="demo",
    )


@pytest.fixture
def mock_client(monkeypatch: pytest.MonkeyPatch, mock_pool: object) -> TestClient:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch(
            "apiome_mock.server.resolve_limits_for_tenant",
            new=AsyncMock(return_value=None),
        ),
        patch("apiome_mock.server.record_mock_request"),
        patch(
            "apiome_mock.server.validate_api_key_for_tenant",
            new=AsyncMock(return_value=None),
        ),
    ):
        app = create_app()
        app.state.db_pool = mock_pool
        app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
    get_settings.cache_clear()


def test_private_draft_requires_api_key(mock_pool: object) -> None:
    with patch(
        "apiome_mock.spec_loader._fetch_access_row",
        new=AsyncMock(
            return_value={
                "mock_enabled": True,
                "published": False,
                "mock_settings": {"mode": "private"},
                "is_public_spec": False,
            }
        ),
    ):
        status = asyncio.run(
            get_mock_access_status(
                mock_pool,
                tenant="demo",
                project="petstore",
                version="2.0.0-draft",
                api_key=None,
            )
        )
    assert status == "missing"


def test_private_draft_allows_valid_api_key(mock_pool: object) -> None:
    with patch(
        "apiome_mock.spec_loader._fetch_access_row",
        new=AsyncMock(
            return_value={
                "mock_enabled": True,
                "published": False,
                "mock_settings": {"mode": "private"},
                "is_public_spec": False,
            }
        ),
    ):
        status = asyncio.run(
            get_mock_access_status(
                mock_pool,
                tenant="demo",
                project="petstore",
                version="2.0.0-draft",
                api_key=_validated_key(),
            )
        )
    assert status == "ok"


def test_anonymous_private_draft_returns_404(mock_client: TestClient) -> None:
    with patch(
        "apiome_mock.handler.get_mock_access_status",
        new=AsyncMock(return_value="missing"),
    ):
        response = mock_client.get("/demo/petstore/2.0.0-draft/pets")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


def test_invalid_api_key_returns_401(mock_client: TestClient) -> None:
    with patch(
        "apiome_mock.server.validate_api_key_for_tenant",
        new=AsyncMock(return_value=None),
    ):
        response = mock_client.get(
            "/demo/petstore/2.0.0-draft/pets",
            headers={"X-Api-Key": "ak_test_invalid_key_value"},
        )
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"


def test_valid_api_key_serves_private_draft(mock_client: TestClient) -> None:
    compiled = _compiled()
    validated = _validated_key()
    with (
        patch(
            "apiome_mock.server.validate_api_key_for_tenant",
            new=AsyncMock(return_value=validated),
        ),
        patch(
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=compiled),
        ),
    ):
        response = mock_client.get(
            "/demo/petstore/2.0.0-draft/pets",
            headers={"X-Api-Key": "ak_test_valid_key_value"},
        )
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]
