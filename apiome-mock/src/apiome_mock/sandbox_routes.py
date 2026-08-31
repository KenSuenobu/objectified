"""Internal HTTP surface for serving hosted sandboxes (#5532, MSC-2.2).

``POST /__sandbox__`` takes a portable mock bundle plus a described request and returns what the
mock served — chaos applied, session state kept. It is how apiome-rest's ``/v1/mock/{id}/…`` data
plane answers a request now that the second resolver that used to live there is gone: apiome-rest
owns the sandbox's lifecycle (existence, expiry, rate limit, usage accounting) and this endpoint
owns the one thing MSC-2.2 consolidated, which is deciding what to serve.

The shape deliberately mirrors ``/__preview__``: same token gate, same bundle-as-the-unit-of-hop,
same request projection. What differs is the semantics behind it — see
:mod:`apiome_mock.sandbox` — and the ``sandbox`` identifier, which scopes session state to one
instance so two sandboxes frozen from the same version cannot see each other's stateful CRUD.

Security posture is identical to the preview endpoint's:

* **Fail closed.** With no ``APIOME_MOCK_INTERNAL_TOKEN`` configured the endpoint is off and
  answers ``503``; it never serves for an unauthenticated caller.
* **Constant-time comparison**, so a mismatch leaks no token bytes through timing.
* **Server-to-server only.** Nothing here is reachable from a browser; the mock's public data
  plane is the ``/{tenant}/{project}/{version}`` catch-all and is unaffected.
"""

from __future__ import annotations

import hmac
from typing import Any, Dict, List, Optional, Union

import structlog
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from apiome_mock.bundle import MockBundleError, MockBundleIncompatibleError, load_bundle_document
from apiome_mock.sandbox import SandboxSessionStores, serve_sandbox_request
from apiome_mock.settings import Settings, get_settings
from apiome_mock.synthetic import SyntheticRequest

_log = structlog.get_logger(__name__)

#: Path of the internal sandbox endpoint. Double-underscored so it can never collide with a tenant
#: slug, and single-segment so it cannot shadow the three-segment data-plane catch-all.
SANDBOX_PATH = "/__sandbox__"

#: Header carrying the shared internal token, matching apiome-rest's existing convention.
INTERNAL_TOKEN_HEADER = "X-Internal-Service-Token"

#: Largest request path a sandbox will route (defensive; the caller also bounds it).
MAX_PATH_LENGTH = 2048

#: Largest number of headers one request may forward.
MAX_HEADERS = 128

#: Largest number of query parameter values one request may forward.
MAX_QUERY_VALUES = 256

#: Largest sandbox identifier accepted; ids are opaque to this service.
MAX_SANDBOX_ID_LENGTH = 128


class SandboxRequestModel(BaseModel):
    """The request to serve (the wire form of :class:`~apiome_mock.synthetic.SyntheticRequest`).

    Declared a second time as ``app.models.MockSandboxRequestSpec``, because apiome-rest cannot
    import this package. The fields must stay identical — ``extra="forbid"`` on both sides turns
    any divergence into a 422 — and ``test_mock_sandbox.py`` asserts they do.
    """

    model_config = ConfigDict(extra="forbid")

    method: str = Field(default="GET", max_length=16, description="HTTP method.")
    path: str = Field(
        default="/",
        max_length=MAX_PATH_LENGTH,
        description="Path relative to the sandbox root; a ?query suffix is merged into `query`.",
    )
    headers: Dict[str, str] = Field(default_factory=dict, description="Request headers.")
    query: Dict[str, Union[str, List[str]]] = Field(
        default_factory=dict,
        description="Query parameters; a bare string is a single-valued parameter.",
    )
    body: Any = Field(default=None, description="Request body: a JSON value, a string, or null.")
    scenario: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Shorthand for the X-Mock-Scenario header.",
    )
    seed: Optional[int] = Field(default=None, description="Shorthand for the ?__seed= parameter.")

    def to_synthetic_request(self) -> SyntheticRequest:
        """Convert to the engine's request dataclass.

        Returns:
            The equivalent :class:`~apiome_mock.synthetic.SyntheticRequest`.

        Raises:
            HTTPException: ``422`` when the request declares more headers or query values than a
                sandbox will forward.
        """
        if len(self.headers) > MAX_HEADERS:
            raise HTTPException(status_code=422, detail=f"At most {MAX_HEADERS} request headers are allowed.")
        values = sum(len(v) if isinstance(v, list) else 1 for v in self.query.values())
        if values > MAX_QUERY_VALUES:
            raise HTTPException(
                status_code=422,
                detail=f"At most {MAX_QUERY_VALUES} query parameter values are allowed.",
            )
        return SyntheticRequest(
            method=self.method,
            path=self.path,
            headers=dict(self.headers),
            query=dict(self.query),
            body=self.body,
            scenario=self.scenario,
            seed=self.seed,
        )


class SandboxPayload(BaseModel):
    """One sandbox call: which sandbox, the bundle it serves, and the request to serve."""

    model_config = ConfigDict(extra="forbid")

    sandbox: str = Field(
        max_length=MAX_SANDBOX_ID_LENGTH,
        description="Opaque sandbox identifier; scopes session state to one instance.",
    )
    bundle: Dict[str, Any] = Field(description="A portable mock bundle document (app.mock_bundle format).")
    request: SandboxRequestModel = Field(
        default_factory=SandboxRequestModel,
        description="The request to serve; defaults to GET / when omitted.",
    )


def _require_internal_token(presented: Optional[str], settings: Settings) -> None:
    """Gate the endpoint on the shared internal token.

    Args:
        presented: The value of the :data:`INTERNAL_TOKEN_HEADER` header, if any.
        settings: Resolved runtime settings.

    Raises:
        HTTPException: ``503`` when no token is configured (the endpoint is disabled), ``401``
            when the header is absent, ``403`` when it is present but wrong.
    """
    configured = (settings.internal_token or "").strip()
    if not configured:
        raise HTTPException(
            status_code=503,
            detail="Sandbox serving is disabled: set APIOME_MOCK_INTERNAL_TOKEN to enable it (#5532, MSC-2.2).",
        )
    if not presented:
        raise HTTPException(status_code=401, detail="Internal service authentication required.")
    if not hmac.compare_digest(presented, configured):
        raise HTTPException(status_code=403, detail="Internal service token is not valid.")


def create_sandbox_router(stores: Optional[SandboxSessionStores] = None) -> APIRouter:
    """Build the router carrying the internal sandbox endpoint.

    Args:
        stores: Registry backing per-sandbox session state; a fresh one is created when omitted.
            Injectable so tests can assert on isolation and eviction.

    Returns:
        A router with ``POST /__sandbox__`` registered.
    """
    session_stores = stores if stores is not None else SandboxSessionStores()
    router = APIRouter(tags=["sandbox"])

    @router.post(SANDBOX_PATH)
    async def sandbox(
        payload: SandboxPayload,
        x_internal_service_token: Optional[str] = Header(default=None, alias=INTERNAL_TOKEN_HEADER),
    ) -> Dict[str, Any]:
        """Serve one request against a sandbox's bundle and return what the mock served.

        Args:
            payload: The sandbox id, its bundle, and the request to serve.
            x_internal_service_token: The shared internal token.

        Returns:
            The served response: status, headers, media type, body, and the matched operation.

        Raises:
            HTTPException: ``503``/``401``/``403`` from the token gate; ``422`` when the bundle
                fails verification (with the structured problem list) or the request exceeds a
                sandbox's declared limits.
        """
        settings = get_settings()
        _require_internal_token(x_internal_service_token, settings)
        request = payload.request.to_synthetic_request()

        try:
            # No secret and no signature requirement, for the same reason as the preview endpoint:
            # the bundle crossed one authenticated internal hop. Content digests are still
            # verified, which is what protects against a truncated or garbled payload.
            bundle = load_bundle_document(payload.bundle)
        except MockBundleIncompatibleError as exc:
            raise HTTPException(status_code=422, detail=exc.as_dict()) from exc
        except MockBundleError as exc:
            raise HTTPException(status_code=422, detail=exc.as_dict()) from exc

        result = await serve_sandbox_request(
            bundle.to_compiled_spec(),
            request,
            session_store=session_stores.for_sandbox(payload.sandbox),
        )
        _log.info(
            "mock_sandbox_served",
            sandbox=payload.sandbox,
            tenant=bundle.tenant_slug,
            project=bundle.project_slug,
            version=bundle.version_label,
            method=request.method.upper(),
            operation=result.operation,
            status=result.status,
            scenario=result.scenario,
        )
        return result.as_dict()

    return router
