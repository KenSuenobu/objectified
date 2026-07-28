"""Session data lifecycle control endpoints (#4745, PMR-2.2).

Every mock version reserves the ``__mock__`` path segment for the runtime's own control plane —
the data-lifecycle operations tests drive between requests. The routes live *inside*
:func:`apiome_mock.handler.serve_compiled_request`'s path space, so the hosted runtime and the
portable runtime expose them identically, under the same version prefix as the mocked API:

``GET  /{tenant}/{project}/{version}/__mock__/fixture-packs``
    List the version's fixture packs: name, digest, format version, and content shape (fixture
    data names, per-collection resource counts). No session required. This is how a test
    discovers what it can reset to and pins the exact seed data by digest.

``POST /{tenant}/{project}/{version}/__mock__/session/reset``
    Reset the calling session (``X-Mock-Session`` header, required) — atomically discard all of
    its stateful CRUD resources and sequence counters. With a JSON body ``{"pack": "<name>"}``
    the session is seeded with that pack's collections instead of left empty, giving the test
    deterministic state: the same pack always produces the same resources, and the response
    echoes the pack digest so the test can assert exactly what it got.

Control routes are deliberately *not* subject to scenario overrides, chaos injection, or spec
routing: they are infrastructure, and a chaos-delayed reset would defeat its purpose. They also
never cross namespaces — the reset key is built from the URL coordinates plus the caller's own
session token, so one tenant/version/session can never touch another's state (the acceptance
boundary of PMR-2.2).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from apiome_mock.fixture_packs import FixturePack, pack_summary
from apiome_mock.problems import (
    bad_request,
    method_not_allowed,
    not_found,
    session_required,
    session_store_unavailable,
    unknown_fixture_pack,
)
from apiome_mock.session_store import (
    MOCK_SESSION_HEADER,
    SessionCapacityError,
    SessionKey,
    SessionStore,
)
from apiome_mock.spec_loader import CompiledSpec
from apiome_mock.stateful_handler import parse_mock_session_token

__all__ = [
    "MOCK_CONTROL_SEGMENT",
    "is_lifecycle_path",
    "handle_lifecycle_request",
]

#: Reserved first path segment for runtime control routes; spec paths never shadow it.
MOCK_CONTROL_SEGMENT = "__mock__"

_FIXTURE_PACKS_PATH = f"/{MOCK_CONTROL_SEGMENT}/fixture-packs"
_SESSION_RESET_PATH = f"/{MOCK_CONTROL_SEGMENT}/session/reset"


def is_lifecycle_path(relative_path: str) -> bool:
    """Whether a spec-relative path belongs to the reserved ``__mock__`` control namespace."""
    return relative_path == f"/{MOCK_CONTROL_SEGMENT}" or relative_path.startswith(f"/{MOCK_CONTROL_SEGMENT}/")


async def _read_reset_body(request: Request) -> tuple[dict[str, Any] | None, str | None]:
    """Parse the optional reset request body.

    Returns:
        ``(body, error)`` — the parsed JSON object (``{}`` when the body is empty) and an error
        message when the body is present but not a JSON object.
    """
    raw = await request.body()
    if not raw:
        return {}, None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, "Request body must be a JSON object (or empty)."
    if not isinstance(parsed, dict):
        return None, "Request body must be a JSON object (or empty)."
    return parsed, None


def _list_fixture_packs(compiled: CompiledSpec) -> Response:
    """Serve the fixture pack listing."""
    packs = [pack_summary(compiled.fixture_packs[name]) for name in sorted(compiled.fixture_packs)]
    return JSONResponse({"packs": packs})


async def _reset_session(
    request: Request,
    *,
    compiled: CompiledSpec,
    tenant: str,
    project: str,
    version: str,
    instance: str,
    store: SessionStore | None,
) -> Response:
    """Reset (and optionally seed) the calling session."""
    if store is None:
        return session_store_unavailable(
            "This deployment has no session store; stateful sessions are disabled.",
            instance=instance,
        )
    token = parse_mock_session_token(request)
    if token is None:
        return session_required(
            f"Session reset requires the {MOCK_SESSION_HEADER} header naming the session to reset.",
            instance=instance,
        )

    body, body_error = await _read_reset_body(request)
    if body is None:
        return bad_request(body_error or "Invalid request body.", instance=instance)

    pack: FixturePack | None = None
    pack_name = body.get("pack")
    if pack_name is not None:
        if not isinstance(pack_name, str) or not pack_name.strip():
            return bad_request("'pack' must be a non-empty fixture pack name.", instance=instance)
        pack = compiled.fixture_packs.get(pack_name.strip())
        if pack is None:
            return unknown_fixture_pack(
                f"No fixture pack named {pack_name.strip()!r} is defined for {tenant}/{project}/{version}.",
                instance=instance,
                available=sorted(compiled.fixture_packs),
            )

    key = SessionKey(tenant=tenant, project=project, version=version, session_token=token)
    seed = pack.collections if pack is not None else {}
    try:
        resource_count, _ = await store.replace_session(key, seed)
    except SessionCapacityError as exc:
        return bad_request(exc.detail, instance=instance)

    payload: dict[str, Any] = {
        "session": token,
        "reset": True,
        "pack": pack.name if pack is not None else None,
        "packDigest": pack.digest if pack is not None else None,
        "collections": len(seed),
        "resources": resource_count,
    }
    return JSONResponse(payload)


async def handle_lifecycle_request(
    request: Request,
    *,
    relative_path: str,
    compiled: CompiledSpec,
    tenant: str,
    project: str,
    version: str,
    instance: str,
    store: SessionStore | None,
) -> Response:
    """Route one request within the reserved ``__mock__`` namespace.

    Args:
        request: The incoming request (already known to target ``__mock__``).
        relative_path: The spec-relative path (leading-slash normalized).
        compiled: The compiled spec being served (source of the fixture packs).
        tenant: Tenant slug from the URL.
        project: Project slug from the URL.
        version: Version label from the URL.
        instance: Problem ``instance`` path for error bodies.
        store: The deployment's session store (``None`` disables session operations).

    Returns:
        The control response — never ``None``: unknown control paths get a 404 problem rather
        than falling through to spec routing, so the namespace stays fully reserved.
    """
    method = request.method.upper()
    if relative_path == _FIXTURE_PACKS_PATH:
        if method not in ("GET", "HEAD"):
            return method_not_allowed(
                f"Method {method} is not allowed for {relative_path}.",
                instance=instance,
                allow=["GET", "HEAD"],
            )
        return _list_fixture_packs(compiled)

    if relative_path == _SESSION_RESET_PATH:
        if method != "POST":
            return method_not_allowed(
                f"Method {method} is not allowed for {relative_path}.",
                instance=instance,
                allow=["POST"],
            )
        return await _reset_session(
            request,
            compiled=compiled,
            tenant=tenant,
            project=project,
            version=version,
            instance=instance,
            store=store,
        )

    return not_found(
        f"No mock control endpoint at {relative_path}. "
        f"Available: GET {_FIXTURE_PACKS_PATH}, POST {_SESSION_RESET_PATH}.",
        instance=instance,
    )
