"""Apply session-scoped CRUD against a SessionStore (#4453)."""

from __future__ import annotations

import json
from typing import Any

from app.mock_routing import MockOperation
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from apiome_mock.crud_resources import (
    CrudAction,
    CrudMatch,
    build_crud_resources,
    extract_or_synthesize_id,
    match_crud_operation,
)
from apiome_mock.problems import bad_request, not_found
from apiome_mock.response_resolver import select_default_success_status
from apiome_mock.session_store import (
    MOCK_SESSION_HEADER,
    SessionCapacityError,
    SessionKey,
    SessionStore,
)


def parse_mock_session_token(request: Request) -> str | None:
    """Return the ``X-Mock-Session`` token, or ``None`` when absent/blank."""
    raw = request.headers.get(MOCK_SESSION_HEADER) or request.headers.get(
        MOCK_SESSION_HEADER.lower(),
    )
    if raw is None:
        return None
    token = raw.strip()
    return token or None


async def _read_json_object(request: Request) -> dict[str, Any]:
    body_bytes = await request.body()
    if not body_bytes:
        return {}
    try:
        parsed = json.loads(body_bytes)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_response(status: int, body: Any) -> Response:
    if body is None:
        return Response(status_code=status)
    return JSONResponse(status_code=status, content=body)


async def try_handle_stateful_crud(
    request: Request,
    *,
    tenant: str,
    project: str,
    version: str,
    relative_path: str,
    instance: str,
    operation: MockOperation,
    path_params: dict[str, str],
    operations: tuple[MockOperation, ...],
    spec: dict[str, Any],
    store: SessionStore,
    session_token: str,
) -> Response | None:
    """Handle CRUD when the operation is collection/item shaped; else ``None``."""
    del relative_path  # classification uses operation templates + path_params
    resources = build_crud_resources(operations)
    matched = match_crud_operation(operation, path_params, resources)
    if matched is None:
        return None

    key = SessionKey(
        tenant=tenant,
        project=project,
        version=version,
        session_token=session_token,
    )
    try:
        return await _dispatch_crud(
            request,
            key=key,
            matched=matched,
            operation=operation,
            spec=spec,
            store=store,
            instance=instance,
        )
    except SessionCapacityError as exc:
        return bad_request(exc.detail, instance=instance)


async def _dispatch_crud(
    request: Request,
    *,
    key: SessionKey,
    matched: CrudMatch,
    operation: MockOperation,
    spec: dict[str, Any],
    store: SessionStore,
    instance: str,
) -> Response:
    collection = matched.resource.collection_path
    status, _ = select_default_success_status(operation.operation)

    if matched.action == CrudAction.LIST:
        items = await store.list_resources(key, collection)
        return _json_response(status, items)

    if matched.action == CrudAction.READ:
        assert matched.resource_id is not None
        resource = await store.get_resource(key, collection, matched.resource_id)
        if resource is None:
            return not_found(
                f"No resource {matched.resource_id!r} in session store for {collection}.",
                instance=instance,
            )
        return _json_response(status, resource)

    if matched.action == CrudAction.DELETE:
        assert matched.resource_id is not None
        existed = await store.delete_resource(key, collection, matched.resource_id)
        if not existed:
            return not_found(
                f"No resource {matched.resource_id!r} in session store for {collection}.",
                instance=instance,
            )
        # Prefer 204 when defined; otherwise default success with empty body.
        responses = operation.operation.get("responses")
        if isinstance(responses, dict) and ("204" in responses or 204 in responses):
            return _json_response(204, None)
        return _json_response(status, None)

    if matched.action == CrudAction.CREATE:
        body = await _read_json_object(request)
        next_int = await store.next_integer_id(key, collection)
        resource_id, payload, _ = extract_or_synthesize_id(
            body,
            resource=matched.resource,
            operation=operation,
            spec=spec,
            next_int=next_int,
        )
        stored = await store.put_resource(
            key,
            collection,
            resource_id,
            payload,
            replace=True,
        )
        return _json_response(status, stored)

    if matched.action == CrudAction.UPDATE:
        assert matched.resource_id is not None
        existing = await store.get_resource(key, collection, matched.resource_id)
        body = await _read_json_object(request)
        if request.method.upper() == "PATCH" and existing is not None:
            payload = {**existing, **body}
        else:
            payload = dict(body)
        typed_id: Any = int(matched.resource_id) if matched.resource_id.isdigit() else matched.resource_id
        if existing is not None:
            for candidate in (matched.resource.id_param, "id"):
                if candidate in existing:
                    typed_id = existing[candidate]
                    payload[candidate] = typed_id
                    break
            else:
                payload[matched.resource.id_param] = typed_id
        else:
            payload[matched.resource.id_param] = typed_id
            if matched.resource.id_param != "id":
                payload.setdefault("id", typed_id)
        stored = await store.put_resource(
            key,
            collection,
            matched.resource_id,
            payload,
            replace=True,
        )
        return _json_response(status, stored)

    raise RuntimeError(f"Unhandled CRUD action: {matched.action}")
