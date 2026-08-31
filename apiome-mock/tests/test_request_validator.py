"""Unit tests for incoming request validation (SIM-1.4, #4419)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

from app.mock_routing import MockOperation, extract_operations
from fastapi import Request

from apiome_mock.request_validator import validate_operation_request

VALIDATION_SPEC = {
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
                    {
                        "name": "X-Trace-Id",
                        "in": "header",
                        "required": False,
                        "schema": {"type": "string", "format": "uuid"},
                    },
                ],
                "responses": {"200": {"description": "ok"}},
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
                                "properties": {
                                    "name": {"type": "string"},
                                    "tag": {"type": "string"},
                                },
                            }
                        }
                    },
                },
                "responses": {"201": {"description": "created"}},
            },
        }
    },
}


def _operation(method: str) -> MockOperation:
    operations = extract_operations(VALIDATION_SPEC)
    for op in operations:
        if op.method == method:
            return op
    raise AssertionError(f"missing operation {method}")


def _request(
    *,
    method: str = "GET",
    query: str = "",
    headers: dict[str, str] | None = None,
    body: bytes = b"",
) -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": "/pets/7",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "query_string": query.encode(),
    }
    request = Request(scope)
    request.body = AsyncMock(return_value=body)  # type: ignore[method-assign]
    return request


def _validate(
    request: Request,
    operation: MockOperation,
    path_params: dict[str, str],
) -> object:
    return asyncio.run(validate_operation_request(request, operation, path_params, VALIDATION_SPEC))


def test_valid_request_passes() -> None:
    op = _operation("GET")
    request = _request(query="status=available")
    assert _validate(request, op, {"petId": "7"}) is None


def test_invalid_enum_query_returns_400() -> None:
    op = _operation("GET")
    request = _request(query="status=unknown")
    failure = _validate(request, op, {"petId": "7"})
    assert failure is not None
    assert failure.status == 400
    assert any(v["location"] == "query.status" for v in failure.violations)


def test_missing_required_query_returns_400() -> None:
    op = _operation("GET")
    request = _request()
    failure = _validate(request, op, {"petId": "7"})
    assert failure is not None
    assert failure.status == 400
    assert any(v["location"] == "query.status" for v in failure.violations)


def test_invalid_path_param_type_returns_400() -> None:
    op = _operation("GET")
    request = _request(query="status=available")
    failure = _validate(request, op, {"petId": "not-int"})
    assert failure is not None
    assert failure.status == 400
    assert any(v["location"] == "path.petId" for v in failure.violations)


def test_wrong_content_type_returns_415() -> None:
    op = _operation("POST")
    request = _request(
        method="POST",
        headers={"content-type": "text/plain"},
        body=b"hello",
    )
    failure = _validate(request, op, {"petId": "7"})
    assert failure is not None
    assert failure.status == 415


def test_invalid_json_body_returns_400() -> None:
    op = _operation("POST")
    request = _request(
        method="POST",
        headers={"content-type": "application/json"},
        body=b"{not-json",
    )
    failure = _validate(request, op, {"petId": "7"})
    assert failure is not None
    assert failure.status == 400
    assert any(v["location"] == "body" for v in failure.violations)


def test_missing_required_body_returns_400() -> None:
    op = _operation("POST")
    request = _request(method="POST")
    failure = _validate(request, op, {"petId": "7"})
    assert failure is not None
    assert failure.status == 400
    assert any("required" in v["message"] for v in failure.violations)


def test_mock_control_query_params_are_ignored() -> None:
    op = _operation("GET")
    request = _request(query="status=available&__seed=1&__status=404")
    assert _validate(request, op, {"petId": "7"}) is None


def test_valid_json_body_passes() -> None:
    op = _operation("POST")
    request = _request(
        method="POST",
        headers={"content-type": "application/json"},
        body=b'{"name": "Rex"}',
    )
    assert _validate(request, op, {"petId": "7"}) is None
