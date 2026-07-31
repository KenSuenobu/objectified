"""Per-tenant rate limiting middleware (#3612).

Public and authenticated endpoints are rate limited so a single tenant (or a
single unauthenticated client) cannot exhaust the service for everyone. The
limiter is an in-process fixed-window counter:

* **Identity / key** — requests are bucketed, in priority order, by API key
  (``X-API-Key``, hashed — naturally per tenant and cheap, no DB hit), then by
  the tenant slug parsed from the path (covers JWT and unauthenticated
  tenant-scoped routes per tenant), then by client IP (everything else).
* **Tier** — requests carrying any credential (API key or ``Authorization``)
  use the higher *authenticated* limit; the rest use the lower *public* limit.
* **Response** — over-limit requests get ``429`` with ``Retry-After``; every
  response carries ``X-RateLimit-{Limit,Remaining,Reset}``.

Limits and the on/off switch are configuration-driven (see ``app/config.py``).

Scope/limitation: the counter lives in process memory, so limits are enforced
per replica. A single replica (the current deployment) enforces the configured
limit exactly; horizontal scaling would multiply the effective limit by the
replica count and needs a shared store (Redis) — tracked as a follow-up.
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass
from typing import Dict, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import settings

# Paths never rate limited: liveness/readiness/health probes, the root banner, and the
# interactive API docs / schema.
_EXEMPT_PATHS = frozenset(
    {"/", "/health", "/livez", "/readyz", "/docs", "/redoc", "/openapi.json"}
)

# Top-level ``/v1`` areas whose second path segment is NOT a tenant slug, so we
# do not mis-key their requests onto a bogus "tenant" bucket. Everything else
# under ``/v1`` is assumed tenant-scoped (``/v1/<area>/<tenant_slug>/...``).
# ``repositories`` is here for the REPO-4.3 webhook ingress (/v1/repositories/webhook/{provider}):
# its second segment is the literal "webhook", so without this entry every provider delivery
# for every tenant would share one bogus ``tenant:webhook`` bucket and one busy repository
# could throttle everybody else's pushes. Falling through to the per-IP bucket keys deliveries
# by the provider address that sent them, which is the right granularity for an endpoint that
# carries no tenant credential.
_NON_TENANT_AREAS = frozenset({"browse", "tenants", "platform", "repositories"})

# Sweep stale buckets once the table grows past this many keys, so a flood of
# distinct IPs/tenants cannot grow memory without bound.
_PRUNE_THRESHOLD = 10_000


@dataclass
class _Window:
    """A single fixed window: how many requests so far and when it resets."""

    count: int
    reset_at: float


class FixedWindowRateLimiter:
    """Thread-safe in-process fixed-window rate limiter.

    Each key gets a window of ``window_seconds``; the first request in a window
    starts the clock and subsequent requests increment the count until the
    window rolls over.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._windows: Dict[str, _Window] = {}

    def check(
        self, key: str, limit: int, window_seconds: int, now: float
    ) -> Tuple[bool, int, int, int]:
        """Record a hit for ``key`` and report whether it is within ``limit``.

        Args:
            key: Bucket identifier.
            limit: Max requests allowed per window.
            window_seconds: Window length in seconds.
            now: Monotonic timestamp (``time.monotonic()``).

        Returns:
            ``(allowed, remaining, reset_after_seconds, retry_after_seconds)``.
            ``remaining`` is requests left in the current window;
            ``reset_after_seconds`` is seconds until the window rolls over;
            ``retry_after_seconds`` equals it and is ``0`` when allowed.
        """
        with self._lock:
            window = self._windows.get(key)
            if window is None or now >= window.reset_at:
                window = _Window(count=0, reset_at=now + window_seconds)
                self._windows[key] = window
            window.count += 1
            count = window.count
            reset_after = max(0, int(round(window.reset_at - now)))

            if len(self._windows) > _PRUNE_THRESHOLD:
                self._prune(now)

        allowed = count <= limit
        remaining = max(0, limit - count)
        retry_after = reset_after if not allowed else 0
        return allowed, remaining, reset_after, retry_after

    def _prune(self, now: float) -> None:
        """Drop windows that have already reset. Caller must hold the lock."""
        expired = [k for k, w in self._windows.items() if now >= w.reset_at]
        for k in expired:
            del self._windows[k]


def _client_ip(request: Request) -> str:
    """Best-effort client address (the direct peer; forwarded headers are not
    trusted to avoid trivial spoofing of the rate-limit key)."""
    client = request.client
    return client.host if client and client.host else "unknown"


def _tenant_from_path(path: str) -> str | None:
    """Extract the tenant slug from a ``/v1/<area>/<tenant_slug>/...`` path.

    Returns ``None`` for non-versioned paths and for the areas whose second
    segment is not a tenant slug (see :data:`_NON_TENANT_AREAS`).
    """
    segments = [s for s in path.split("/") if s]
    if len(segments) < 3 or segments[0] != "v1":
        return None
    if segments[1] in _NON_TENANT_AREAS:
        return None
    return segments[2]


def resolve_identity(request: Request) -> Tuple[str, bool]:
    """Resolve the rate-limit bucket key and authenticated tier for a request.

    Returns ``(key, is_authenticated)``. The key is prefixed by its source
    (``key:`` / ``tenant:`` / ``ip:``) so the namespaces never collide.
    """
    api_key = request.headers.get("x-api-key")
    if api_key:
        digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]
        return f"key:{digest}", True

    is_authenticated = bool(request.headers.get("authorization"))
    tenant = _tenant_from_path(request.url.path)
    if tenant:
        return f"tenant:{tenant}", is_authenticated
    return f"ip:{_client_ip(request)}", is_authenticated


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Starlette middleware enforcing the per-tenant fixed-window limits."""

    def __init__(self, app, limiter: FixedWindowRateLimiter | None = None) -> None:
        super().__init__(app)
        self._limiter = limiter or FixedWindowRateLimiter()

    async def dispatch(self, request: Request, call_next):
        if not settings.rate_limit_enabled or request.url.path in _EXEMPT_PATHS:
            return await call_next(request)

        key, is_authenticated = resolve_identity(request)
        limit = (
            settings.rate_limit_authenticated_per_minute
            if is_authenticated
            else settings.rate_limit_public_per_minute
        )
        window_seconds = max(1, settings.rate_limit_window_seconds)
        tier = "auth" if is_authenticated else "pub"

        allowed, remaining, reset_after, retry_after = self._limiter.check(
            f"{tier}:{key}", limit, window_seconds, time.monotonic()
        )

        headers = {
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": str(remaining),
            "X-RateLimit-Reset": str(reset_after),
        }

        if not allowed:
            headers["Retry-After"] = str(retry_after)
            # Use the consistent error envelope (#3617) so a throttled caller gets the same shape as
            # every other REST error, including the request id for correlation. ``detail`` is kept
            # for backward compatibility.
            from .observability import build_error_envelope  # local import avoids a cycle

            detail_message = "Rate limit exceeded. Slow down and retry later."
            return JSONResponse(
                status_code=429,
                content=build_error_envelope(
                    status_code=429,
                    message=detail_message,
                    detail=detail_message,
                    error_type="rate_limited",
                    request_id=getattr(request.state, "request_id", None),
                ),
                headers=headers,
            )

        response: Response = await call_next(request)
        for name, value in headers.items():
            response.headers[name] = value
        return response
