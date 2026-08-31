"""Integration-style HTTP tests with mocked spec resolution."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

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
                        "content": {
                            "application/json": {
                                "examples": {
                                    "sample": {
                                        "value": [
                                            {"id": 7, "name": "Rex"},
                                        ]
                                    }
                                },
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                    "minItems": 1,
                                },
                            }
                        },
                    }
                },
            }
        }
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
            }
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
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
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
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
    ):
        app = create_app()
        app.state.db_pool = mock_pool
        app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
    get_settings.cache_clear()


def test_get_pets_returns_200_json(mock_client: TestClient) -> None:
    compiled = _compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body == [{"id": 7, "name": "Rex"}]


def test_mock_disabled_returns_problem_json(mock_client: TestClient) -> None:
    with patch(
        "apiome_mock.handler.get_mock_access_status",
        new=AsyncMock(return_value="disabled"),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert "mock-disabled" in response.text
    assert "disabled" in response.text.lower()


def test_prefer_example_header_selects_named_example(mock_client: TestClient) -> None:
    compiled = _compiled()
    spec = {
        **PETSTORE_SPEC,
        "paths": {
            "/pets": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "examples": {
                                        "a": {"value": [{"id": 1, "name": "A"}]},
                                        "b": {"value": [{"id": 2, "name": "B"}]},
                                    }
                                }
                            },
                        }
                    }
                }
            }
        },
    }
    compiled = CompiledSpec(
        revision_id=compiled.revision_id,
        tenant_slug=compiled.tenant_slug,
        project_slug=compiled.project_slug,
        version_label=compiled.version_label,
        updated_at=compiled.updated_at,
        spec=spec,
        operations=tuple(extract_operations(spec)),
    )
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets",
            headers={"Prefer": "example=b"},
        )
    assert response.status_code == 200
    assert response.json() == [{"id": 2, "name": "B"}]


def test_accept_xml_returns_xml_example(mock_client: TestClient) -> None:
    compiled = _compiled()
    spec = {
        **PETSTORE_SPEC,
        "paths": {
            "/pets": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {"example": {"pets": []}},
                                "application/xml": {"example": "<pets/>"},
                            },
                        }
                    }
                }
            }
        },
    }
    compiled = CompiledSpec(
        revision_id=compiled.revision_id,
        tenant_slug=compiled.tenant_slug,
        project_slug=compiled.project_slug,
        version_label=compiled.version_label,
        updated_at=compiled.updated_at,
        spec=spec,
        operations=tuple(extract_operations(spec)),
    )
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets",
            headers={"Accept": "application/xml"},
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert response.text == "<pets/>"


def test_unacceptable_accept_returns_406_problem_json(mock_client: TestClient) -> None:
    compiled = _compiled()
    spec = {
        **PETSTORE_SPEC,
        "paths": {
            "/pets": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {"example": {"pets": []}},
                            },
                        }
                    }
                }
            }
        },
    }
    compiled = CompiledSpec(
        revision_id=compiled.revision_id,
        tenant_slug=compiled.tenant_slug,
        project_slug=compiled.project_slug,
        version_label=compiled.version_label,
        updated_at=compiled.updated_at,
        spec=spec,
        operations=tuple(extract_operations(spec)),
    )
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets",
            headers={"Accept": "application/pdf"},
        )
    assert response.status_code == 406
    assert response.headers["content-type"] == "application/problem+json"


def test_structured_xml_example_returns_json_content_type(mock_client: TestClient) -> None:
    compiled = _compiled()
    spec = {
        **PETSTORE_SPEC,
        "paths": {
            "/pets": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/xml": {"example": {"pets": []}},
                            },
                        }
                    }
                }
            }
        },
    }
    compiled = CompiledSpec(
        revision_id=compiled.revision_id,
        tenant_slug=compiled.tenant_slug,
        project_slug=compiled.project_slug,
        version_label=compiled.version_label,
        updated_at=compiled.updated_at,
        spec=spec,
        operations=tuple(extract_operations(spec)),
    )
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets",
            headers={"Accept": "application/xml"},
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"pets": []}


def test_unknown_spec_returns_problem_json(mock_client: TestClient) -> None:
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=None),
    ):
        response = mock_client.get("/missing/project/1.0.0/pets")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["status"] == 404


def test_wrong_method_returns_405_problem_json(mock_client: TestClient) -> None:
    compiled = _compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.delete("/demo/petstore/1.0.0/pets")
    assert response.status_code == 405
    assert response.headers["content-type"] == "application/problem+json"
    assert "GET" in response.headers.get("allow", "")


def test_unknown_path_returns_404_problem_json(mock_client: TestClient) -> None:
    compiled = _compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/unknown")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


def test_schema_synthesis_when_no_examples(mock_client: TestClient) -> None:
    compiled = _compiled()
    spec = {
        **PETSTORE_SPEC,
        "paths": {
            "/pets": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["id", "email"],
                                        "properties": {
                                            "id": {"type": "string", "format": "uuid"},
                                            "email": {"type": "string", "format": "email"},
                                        },
                                    }
                                }
                            },
                        }
                    }
                }
            }
        },
    }
    compiled = CompiledSpec(
        revision_id=compiled.revision_id,
        tenant_slug=compiled.tenant_slug,
        project_slug=compiled.project_slug,
        version_label=compiled.version_label,
        updated_at=compiled.updated_at,
        spec=spec,
        operations=tuple(extract_operations(spec)),
    )
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        first = mock_client.get("/demo/petstore/1.0.0/pets?__seed=stable")
        second = mock_client.get("/demo/petstore/1.0.0/pets?__seed=stable")
    assert first.status_code == 200
    assert first.json() == second.json()
    assert "@" in first.json()["email"]


VALIDATION_INTEGRATION_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Validation", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "parameters": [
                    {
                        "name": "petId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string", "enum": ["available", "pending", "sold"]},
                    },
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "example": {"id": 1, "status": "available"},
                            }
                        },
                    },
                    "400": {
                        "description": "bad input",
                        "content": {
                            "application/json": {
                                "example": {"code": "INVALID_STATUS", "message": "status is invalid"},
                            }
                        },
                    },
                    "404": {
                        "description": "missing",
                        "content": {
                            "application/json": {
                                "example": {"code": "NOT_FOUND", "message": "pet not found"},
                            }
                        },
                    },
                },
            },
            "post": {
                "parameters": [
                    {
                        "name": "petId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                    }
                ],
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name"],
                                "properties": {"name": {"type": "string"}},
                            }
                        }
                    },
                },
                "responses": {
                    "201": {"description": "created"},
                    "415": {
                        "description": "unsupported media type",
                        "content": {
                            "application/json": {
                                "example": {"code": "UNSUPPORTED_MEDIA_TYPE"},
                            }
                        },
                    },
                },
            },
        }
    },
}


def _validation_compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=VALIDATION_INTEGRATION_SPEC,
        operations=tuple(extract_operations(VALIDATION_INTEGRATION_SPEC)),
    )


def test_invalid_enum_returns_spec_400_body(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/pets/7?status=invalid")
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"code": "INVALID_STATUS", "message": "status is invalid"}


def test_forced_status_query_returns_operation_example(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/pets/7?status=available&__status=404")
    assert response.status_code == 404
    assert response.json() == {"code": "NOT_FOUND", "message": "pet not found"}


def test_forced_status_prefer_header_overrides_query(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets/7?status=available&__status=404",
            headers={"Prefer": "code=400"},
        )
    assert response.status_code == 400
    assert response.json() == {"code": "INVALID_STATUS", "message": "status is invalid"}


def test_wrong_content_type_returns_spec_415_body(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.post(
            "/demo/petstore/1.0.0/pets/7",
            content="plain",
            headers={"Content-Type": "text/plain"},
        )
    assert response.status_code == 415
    assert response.json() == {"code": "UNSUPPORTED_MEDIA_TYPE"}


def test_undefined_forced_status_returns_problem_json(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get(
            "/demo/petstore/1.0.0/pets/7?status=available&__status=418",
        )
    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["requestedStatus"] == 418
    assert "418" in body["detail"]


def test_valid_request_still_returns_success(mock_client: TestClient) -> None:
    compiled = _validation_compiled()
    with patch(
        "apiome_mock.handler.load_compiled_spec",
        new=AsyncMock(return_value=compiled),
    ):
        response = mock_client.get("/demo/petstore/1.0.0/pets/7?status=available")
    assert response.status_code == 200
    assert response.json() == {"id": 1, "status": "available"}
