"""Integration tests for X-Mock-Session stateful CRUD (#4453)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_CRUD_SPEC = {
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
                                "examples": {
                                    "sample": {
                                        "value": [{"id": 7, "name": "Rex"}],
                                    }
                                },
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                },
                            }
                        },
                    }
                },
            },
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/NewPet"},
                        }
                    },
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [
                {
                    "name": "petId",
                    "in": "path",
                    "required": True,
                    "schema": {"type": "integer"},
                }
            ],
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
            "put": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                        }
                    },
                },
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
            "patch": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/NewPet"},
                        }
                    },
                },
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
            "delete": {"responses": {"204": {"description": "deleted"}}},
        },
        "/healthz": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": {"ok": True}}},
                            }
                        },
                    }
                },
            }
        },
    },
    "components": {
        "schemas": {
            "NewPet": {
                "type": "object",
                "required": ["name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
            },
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
            },
        }
    },
}


def _compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_CRUD_SPEC,
        operations=tuple(extract_operations(PETSTORE_CRUD_SPEC)),
    )


@pytest.fixture
def session_store() -> InMemorySessionStore:
    return InMemorySessionStore(
        SessionCaps(
            ttl_seconds=3600.0,
            max_resources=5,
            max_bytes=1_048_576,
            max_sessions=100,
        ),
    )


@pytest.fixture
def mock_client(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    session_store: InMemorySessionStore,
) -> TestClient:
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
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=_compiled()),
        ),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = session_store
            yield client
    get_settings.cache_clear()


def test_without_session_header_remains_stateless(mock_client: TestClient) -> None:
    response = mock_client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]


def test_session_crud_post_get_delete(mock_client: TestClient) -> None:
    headers = {"X-Mock-Session": "s1", "Content-Type": "application/json"}

    created = mock_client.post(
        "/demo/petstore/1.0.0/pets",
        headers=headers,
        json={"name": "Fido"},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Fido"
    assert "id" in body
    pet_id = body["id"]

    collection = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert collection.status_code == 200
    assert collection.json() == [body]

    by_id = mock_client.get(f"/demo/petstore/1.0.0/pets/{pet_id}", headers=headers)
    assert by_id.status_code == 200
    assert by_id.json() == body

    deleted = mock_client.delete(f"/demo/petstore/1.0.0/pets/{pet_id}", headers=headers)
    assert deleted.status_code == 204

    missing = mock_client.get(f"/demo/petstore/1.0.0/pets/{pet_id}", headers=headers)
    assert missing.status_code == 404

    empty = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []


def test_sessions_are_isolated(mock_client: TestClient) -> None:
    h1 = {"X-Mock-Session": "s1", "Content-Type": "application/json"}
    h2 = {"X-Mock-Session": "s2", "Content-Type": "application/json"}

    mock_client.post("/demo/petstore/1.0.0/pets", headers=h1, json={"name": "A"})
    mock_client.post("/demo/petstore/1.0.0/pets", headers=h2, json={"name": "B"})

    assert mock_client.get("/demo/petstore/1.0.0/pets", headers=h1).json()[0]["name"] == "A"
    assert mock_client.get("/demo/petstore/1.0.0/pets", headers=h2).json()[0]["name"] == "B"


def test_put_and_patch_update(mock_client: TestClient) -> None:
    headers = {"X-Mock-Session": "s1", "Content-Type": "application/json"}
    created = mock_client.post(
        "/demo/petstore/1.0.0/pets",
        headers=headers,
        json={"name": "Fido"},
    ).json()
    pet_id = created["id"]

    put = mock_client.put(
        f"/demo/petstore/1.0.0/pets/{pet_id}",
        headers=headers,
        json={"id": pet_id, "name": "Rex"},
    )
    assert put.status_code == 200
    assert put.json()["name"] == "Rex"

    patched = mock_client.patch(
        f"/demo/petstore/1.0.0/pets/{pet_id}",
        headers=headers,
        json={"name": "Max"},
    )
    assert patched.status_code == 200
    assert patched.json() == {"id": pet_id, "name": "Max"}


def test_resource_cap_returns_400(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    tiny = InMemorySessionStore(
        SessionCaps(ttl_seconds=3600, max_resources=1, max_bytes=1_048_576, max_sessions=10),
    )
    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch(
            "apiome_mock.server.resolve_limits_for_tenant",
            new=AsyncMock(return_value=None),
        ),
        patch("apiome_mock.server.record_mock_request"),
        patch(
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=_compiled()),
        ),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = tiny
            headers = {"X-Mock-Session": "s1", "Content-Type": "application/json"}
            first = client.post("/demo/petstore/1.0.0/pets", headers=headers, json={"name": "A"})
            assert first.status_code == 201
            second = client.post("/demo/petstore/1.0.0/pets", headers=headers, json={"name": "B"})
            assert second.status_code == 400
            assert "resource limit" in second.json()["detail"]
    get_settings.cache_clear()


def test_non_crud_path_falls_through(mock_client: TestClient) -> None:
    headers = {"X-Mock-Session": "s1"}
    response = mock_client.get("/demo/petstore/1.0.0/healthz", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_ttl_expiry_wipes_session(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    clock = {"now": 1_000.0}

    def now() -> float:
        return clock["now"]

    store = InMemorySessionStore(
        SessionCaps(ttl_seconds=10.0, max_resources=10, max_bytes=1_048_576, max_sessions=10),
        clock=now,
    )
    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch(
            "apiome_mock.server.resolve_limits_for_tenant",
            new=AsyncMock(return_value=None),
        ),
        patch("apiome_mock.server.record_mock_request"),
        patch(
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=_compiled()),
        ),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = store
            headers = {"X-Mock-Session": "s1", "Content-Type": "application/json"}
            created = client.post(
                "/demo/petstore/1.0.0/pets",
                headers=headers,
                json={"name": "Fido"},
            )
            assert created.status_code == 201
            pet_id = created.json()["id"]
            clock["now"] = 1_020.0
            missing = client.get(f"/demo/petstore/1.0.0/pets/{pet_id}", headers=headers)
            assert missing.status_code == 404
    get_settings.cache_clear()
