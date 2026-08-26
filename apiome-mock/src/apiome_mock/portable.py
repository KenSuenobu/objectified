"""Portable (bundle-backed) mock runtime application (#4742, PMR-1.2).

The hosted runtime in :mod:`apiome_mock.server` resolves every request against Postgres. This
module builds the *same* mock from a single :class:`~apiome_mock.bundle.LoadedBundle`: no database,
no network, no tenant credentials — which is what lets ``apiome mock run`` and the official image
serve a version-pinned mock on a laptop, in CI, or inside an air-gapped network.

Behavioral parity is structural rather than aspirational. Both apps hand the request to
:func:`apiome_mock.handler.serve_compiled_request` with a
:class:`~apiome_mock.spec_loader.CompiledSpec`, so routing, request validation, scenarios, chaos,
stateful CRUD, and example-first response resolution are literally the same code path. What the
portable runtime deliberately does *not* carry is everything that is inherently hosted: API-key
authentication, per-tenant quotas and usage accounting, private-draft access checks, and the
gRPC/SSE/WebSocket transports, all of which need the control-plane database.

Two operational endpoints are always reserved, ahead of any spec path:

``GET /health``
    Liveness. 200 as soon as the process is serving HTTP.
``GET /ready``
    Readiness. 503 until the bundle is compiled and the app has started, then 200 with the
    bundle's identity and digest — the value a CI job should assert before sending traffic.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import RequestResponseEndpoint

from apiome_mock import __version__
from apiome_mock.bundle import LoadedBundle
from apiome_mock.callback_dispatch import build_dispatcher
from apiome_mock.handler import serve_compiled_request
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.portable_config import PortableSettings
from apiome_mock.problems import not_found
from apiome_mock.session_store import SessionCaps

__all__ = [
    "HEALTH_PATH",
    "MOCK_METHODS",
    "READY_PATH",
    "create_portable_app",
]

_log = structlog.get_logger(__name__)

#: Liveness probe path; reserved, never routed to the spec.
HEALTH_PATH = "/health"

#: Readiness probe path; reserved, never routed to the spec.
READY_PATH = "/ready"

#: HTTP methods the mock catch-all accepts (the hosted runtime accepts the same set).
MOCK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


def _session_caps(settings: PortableSettings) -> SessionCaps:
    """Translate the declared session knobs into store caps."""
    return SessionCaps(
        ttl_seconds=settings.session_ttl_seconds,
        max_resources=settings.session_max_resources,
        max_bytes=settings.session_max_bytes,
        max_sessions=settings.session_max_sessions,
    )


def _bundle_summary(bundle: LoadedBundle) -> dict[str, object]:
    """Describe the loaded bundle for readiness output and startup logs.

    Args:
        bundle: The verified bundle being served.

    Returns:
        A JSON-serializable summary: identity, digest, signing state, and content counts. It
        carries no spec bodies and no settings values, so it is safe to log at INFO.
    """
    return {
        "digest": bundle.digest,
        "tenant": bundle.tenant_slug,
        "project": bundle.project_slug,
        "version": bundle.version_label,
        "signed": bundle.signed,
        "operations": len(bundle.operations),
        "scenarios": sorted(bundle.scenarios),
        "fixtures": sorted(str(entry.get("name", "")) for entry in bundle.fixtures),
        "callbacks": sorted(bundle.callbacks),
    }


def version_prefix(bundle: LoadedBundle) -> str:
    """Return the hosted-shape path prefix a bundle is served under.

    Args:
        bundle: The verified bundle being served.

    Returns:
        ``/{tenant}/{project}/{version}`` — the same prefix the hosted mock serves this version at.
    """
    return f"/{bundle.tenant_slug}/{bundle.project_slug}/{bundle.version_label}"


def _relative_path(full_path: str, *, prefix: str, base_path: str) -> str | None:
    """Map an incoming request path to a spec-relative path.

    Args:
        full_path: The request path captured by the catch-all route, without a leading slash.
        prefix: The bundle's ``/{tenant}/{project}/{version}`` prefix.
        base_path: ``"version"`` (hosted URL shape) or ``"root"`` (spec paths at ``/``).

    Returns:
        The spec-relative path (always leading-slash normalized), or ``None`` when the request
        does not belong to this bundle — which the caller answers with 404.
    """
    incoming = "/" + full_path.strip("/") if full_path.strip("/") else "/"
    if base_path == "root":
        return incoming
    if incoming == prefix:
        return "/"
    if incoming.startswith(prefix + "/"):
        return incoming[len(prefix) :]
    return None


def create_portable_app(bundle: LoadedBundle, settings: PortableSettings) -> FastAPI:
    """Build the FastAPI application that serves one mock bundle.

    Args:
        bundle: A bundle already loaded and verified by :func:`apiome_mock.bundle.load_bundle_file`
            — verification happens before the server starts so a bad bundle fails the process
            rather than every request.
        settings: Resolved portable runtime configuration.

    Returns:
        The application, with ``/health``, ``/ready``, and the mock catch-all registered.
    """
    compiled = bundle.to_compiled_spec()
    prefix = version_prefix(bundle)
    summary = _bundle_summary(bundle)
    session_store = InMemorySessionStore(_session_caps(settings))
    dispatcher = build_dispatcher(
        enabled=settings.callbacks_enabled,
        allow_private_destinations=settings.callback_allow_private,
        timeout_seconds=settings.callback_timeout_seconds,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.ready = True
        _log.info(
            "portable_runtime_ready",
            runtime_version=__version__,
            base_path=settings.base_path,
            mount=prefix if settings.base_path == "version" else "/",
            callbacks_enabled=dispatcher is not None,
            **summary,
        )
        yield
        app.state.ready = False
        if dispatcher is not None:
            await dispatcher.aclose()
        _log.info("portable_runtime_stopped", digest=bundle.digest)

    app = FastAPI(title="Apiome Mock (portable)", lifespan=lifespan)
    app.state.ready = False
    app.state.bundle = bundle
    app.state.compiled_spec = compiled
    app.state.session_store = session_store
    app.state.callback_dispatcher = dispatcher
    app.state.portable_settings = settings

    if settings.access_log:

        @app.middleware("http")
        async def access_log(request: Request, call_next: RequestResponseEndpoint) -> Response:
            """Emit one structured ``mock_request`` line per request."""
            started = time.perf_counter()
            response: Response = await call_next(request)
            _log.info(
                "mock_request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round((time.perf_counter() - started) * 1000, 3),
                digest=bundle.digest,
            )
            return response

    @app.get(HEALTH_PATH)
    async def health() -> JSONResponse:
        """Liveness: the process is up and serving HTTP."""
        return JSONResponse({"status": "ok"})

    @app.get(READY_PATH)
    async def ready() -> JSONResponse:
        """Readiness: the bundle is verified, compiled, and mounted."""
        if not app.state.ready:
            return JSONResponse({"status": "starting"}, status_code=503)
        return JSONResponse(
            {
                "status": "ready",
                "runtime": {
                    "name": "apiome-mock",
                    "version": __version__,
                    "mode": "portable",
                    "basePath": settings.base_path,
                    "mount": prefix if settings.base_path == "version" else "/",
                },
                "bundle": summary,
            }
        )

    @app.api_route("/{full_path:path}", methods=MOCK_METHODS)
    async def mock_route(request: Request, full_path: str = "") -> Response:
        """Serve every non-reserved path from the bundle's compiled spec."""
        relative = _relative_path(full_path, prefix=prefix, base_path=settings.base_path)
        if relative is None:
            return not_found(
                f"This runtime serves {prefix} only; nothing is mounted at /{full_path.strip('/')}.",
                instance="/" + full_path.strip("/"),
            )
        return await serve_compiled_request(
            request,
            compiled=compiled,
            tenant=bundle.tenant_slug,
            project=bundle.project_slug,
            version=bundle.version_label,
            path=relative,
            session_store=session_store,
            callback_dispatcher=dispatcher,
        )

    return app
