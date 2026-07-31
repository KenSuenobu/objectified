"""Tests for per-tenant rate limiting (#3612).

Two layers are exercised:

* the :class:`FixedWindowRateLimiter` counter and :func:`resolve_identity`
  key/tier logic, in isolation; and
* the middleware end-to-end on a tiny FastAPI app, asserting the ``429`` and
  the ``X-RateLimit-*`` / ``Retry-After`` headers, per-tenant isolation, the
  public-vs-authenticated tiers, and the disable switch.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.config import settings
from app.rate_limit import (
    FixedWindowRateLimiter,
    RateLimitMiddleware,
    resolve_identity,
)


def _make_request(path: str, headers: dict | None = None) -> Request:
    """Build a minimal ASGI ``Request`` for identity-resolution unit tests."""
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": raw_headers,
        "client": ("203.0.113.7", 12345),
        "query_string": b"",
    }
    return Request(scope)


# ===========================================================================
# FixedWindowRateLimiter
# ===========================================================================


def test_limiter_allows_up_to_limit_then_blocks():
    limiter = FixedWindowRateLimiter()
    results = [limiter.check("k", limit=3, window_seconds=60, now=100.0) for _ in range(4)]
    allowed = [r[0] for r in results]
    assert allowed == [True, True, True, False]
    # remaining counts down to zero and does not go negative.
    assert [r[1] for r in results] == [2, 1, 0, 0]


def test_limiter_resets_after_window():
    limiter = FixedWindowRateLimiter()
    assert limiter.check("k", 1, 60, now=100.0)[0] is True
    assert limiter.check("k", 1, 60, now=120.0)[0] is False  # same window
    assert limiter.check("k", 1, 60, now=161.0)[0] is True   # window rolled over


def test_limiter_isolates_distinct_keys():
    limiter = FixedWindowRateLimiter()
    assert limiter.check("a", 1, 60, now=100.0)[0] is True
    assert limiter.check("a", 1, 60, now=100.0)[0] is False
    # A different key has its own budget.
    assert limiter.check("b", 1, 60, now=100.0)[0] is True


def test_limiter_retry_after_zero_when_allowed_and_positive_when_blocked():
    limiter = FixedWindowRateLimiter()
    allowed, _, _, retry_after = limiter.check("k", 1, 60, now=100.0)
    assert allowed and retry_after == 0
    blocked, _, _, retry_after2 = limiter.check("k", 1, 60, now=100.0)
    assert not blocked and retry_after2 > 0


# ===========================================================================
# resolve_identity — key source and tier
# ===========================================================================


def test_identity_api_key_is_authenticated_and_hashed():
    key, authed = resolve_identity(_make_request("/v1/primitives/acme", {"X-API-Key": "secret"}))
    assert authed is True
    assert key.startswith("key:")
    assert "secret" not in key  # never leak the raw key into the bucket id


def test_identity_jwt_tenant_path_keys_by_tenant():
    key, authed = resolve_identity(
        _make_request("/v1/primitives/acme/123", {"Authorization": "Bearer x"})
    )
    assert authed is True
    assert key == "tenant:acme"


def test_identity_public_tenant_path_keys_by_tenant_unauthenticated():
    key, authed = resolve_identity(_make_request("/v1/schema/acme/proj/1.0.0"))
    assert authed is False
    assert key == "tenant:acme"


def test_identity_non_tenant_area_falls_back_to_ip():
    key, authed = resolve_identity(_make_request("/v1/browse/specs"))
    assert authed is False
    assert key == "ip:203.0.113.7"


def test_identity_webhook_ingress_buckets_by_ip_not_by_a_bogus_tenant():
    """REPO-4.3: the second segment is the literal "webhook", not a tenant slug.

    Keying it as a tenant would put every provider delivery for every tenant in one bucket,
    so one busy repository's push storm would throttle everybody else's.
    """
    key, authed = resolve_identity(_make_request("/v1/repositories/webhook/github"))
    assert authed is False
    assert key == "ip:203.0.113.7"


# ===========================================================================
# Middleware end-to-end
# ===========================================================================


def _build_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware)

    @app.get("/v1/primitives/{tenant_slug}")
    async def _list(tenant_slug: str):
        return {"tenant": tenant_slug}

    @app.get("/health")
    async def _health():
        return {"status": "ok"}

    return app


def _configure(monkeypatch, *, public=2, authed=5, enabled=True):
    monkeypatch.setattr(settings, "rate_limit_enabled", enabled)
    monkeypatch.setattr(settings, "rate_limit_public_per_minute", public)
    monkeypatch.setattr(settings, "rate_limit_authenticated_per_minute", authed)
    monkeypatch.setattr(settings, "rate_limit_window_seconds", 60)


def test_middleware_returns_429_with_headers_over_public_limit(monkeypatch):
    _configure(monkeypatch, public=2)
    client = TestClient(_build_app())

    r1 = client.get("/v1/primitives/acme")
    r2 = client.get("/v1/primitives/acme")
    r3 = client.get("/v1/primitives/acme")

    assert r1.status_code == 200 and r2.status_code == 200
    assert r3.status_code == 429
    assert r3.json()["detail"].startswith("Rate limit exceeded")
    assert r3.headers["Retry-After"]
    assert r3.headers["X-RateLimit-Limit"] == "2"
    assert r1.headers["X-RateLimit-Remaining"] == "1"
    assert r3.headers["X-RateLimit-Remaining"] == "0"


def test_middleware_isolates_tenants(monkeypatch):
    _configure(monkeypatch, public=1)
    client = TestClient(_build_app())

    assert client.get("/v1/primitives/tenant-a").status_code == 200
    assert client.get("/v1/primitives/tenant-a").status_code == 429
    # tenant-b is unaffected by tenant-a exhausting its budget.
    assert client.get("/v1/primitives/tenant-b").status_code == 200


def test_middleware_authenticated_tier_has_higher_limit(monkeypatch):
    _configure(monkeypatch, public=1, authed=3)
    client = TestClient(_build_app())
    headers = {"X-API-Key": "k-acme"}

    statuses = [client.get("/v1/primitives/acme", headers=headers).status_code for _ in range(4)]
    # 3 allowed under the authenticated tier, the 4th blocked.
    assert statuses == [200, 200, 200, 429]


def test_middleware_health_is_exempt(monkeypatch):
    _configure(monkeypatch, public=1)
    client = TestClient(_build_app())
    for _ in range(5):
        assert client.get("/health").status_code == 200


def test_middleware_disabled_passes_everything(monkeypatch):
    _configure(monkeypatch, public=1, enabled=False)
    client = TestClient(_build_app())
    for _ in range(5):
        r = client.get("/v1/primitives/acme")
        assert r.status_code == 200
        assert "X-RateLimit-Limit" not in r.headers
