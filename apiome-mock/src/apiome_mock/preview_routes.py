"""Internal HTTP surface for dry-run mock rendering (#5528, MSC-1.2).

``POST /__preview__`` takes a portable mock bundle plus a synthetic request and returns what the
mock would serve, with the decision trace. It exists because the *engine* lives here while the
*control plane* — version records, RBAC, the editor and the CLI — lives in apiome-rest, and
apiome-rest cannot import this package (apiome-mock depends on apiome-rest, not the other way
round). So apiome-rest authenticates the caller, authorizes them against the version, builds the
bundle (from the stored settings, or from an unsaved draft), and asks this endpoint to render it.

The bundle is the right unit for that hop: it is the same self-contained document the portable
runtime already serves, it embeds only the allowlisted, credential-redacted settings keys, and it
carries content digests this endpoint verifies. A preview therefore renders exactly the
configuration a portable bundle would, with no second projection to keep in step.

Security posture, mirroring the ``X-Internal-Service-Token`` convention apiome-rest established
for its own service-to-server read path:

* **Fail closed.** With no ``APIOME_MOCK_INTERNAL_TOKEN`` configured the endpoint is off and
  answers ``503``; it never renders for an unauthenticated caller.
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
from apiome_mock.preview import PreviewRequest, render_preview
from apiome_mock.settings import Settings, get_settings

_log = structlog.get_logger(__name__)

#: Path of the internal preview endpoint. Double-underscored so it can never collide with a
#: tenant slug, and single-segment so it cannot shadow the three-segment data-plane catch-all.
PREVIEW_PATH = "/__preview__"

#: Header carrying the shared internal token, matching apiome-rest's existing convention.
INTERNAL_TOKEN_HEADER = "X-Internal-Service-Token"

#: Largest synthetic request path a preview will route (defensive; the caller also bounds it).
MAX_PATH_LENGTH = 2048

#: Largest number of headers one synthetic request may declare.
MAX_HEADERS = 64

#: Largest number of query parameter values one synthetic request may declare.
MAX_QUERY_VALUES = 128


class PreviewRequestModel(BaseModel):
    """The synthetic request to render (the wire form of :class:`~apiome_mock.preview.PreviewRequest`).

    Declared a second time as ``app.models.MockPreviewRequestSpec``, because apiome-rest cannot
    import this package. The fields must stay identical — ``extra="forbid"`` on both sides turns
    any divergence into a 422 — and ``test_mock_preview.py`` asserts they do.
    """

    model_config = ConfigDict(extra="forbid")

    method: str = Field(default="GET", max_length=16, description="HTTP method.")
    path: str = Field(
        default="/",
        max_length=MAX_PATH_LENGTH,
        description="Path relative to the version root; a ?query suffix is merged into `query`.",
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

    def to_preview_request(self) -> PreviewRequest:
        """Convert to the engine's request dataclass.

        Returns:
            The equivalent :class:`~apiome_mock.preview.PreviewRequest`.

        Raises:
            HTTPException: ``422`` when the request declares more headers or query values than a
                preview will carry.
        """
        if len(self.headers) > MAX_HEADERS:
            raise HTTPException(status_code=422, detail=f"At most {MAX_HEADERS} request headers are allowed.")
        values = sum(len(v) if isinstance(v, list) else 1 for v in self.query.values())
        if values > MAX_QUERY_VALUES:
            raise HTTPException(
                status_code=422,
                detail=f"At most {MAX_QUERY_VALUES} query parameter values are allowed.",
            )
        return PreviewRequest(
            method=self.method,
            path=self.path,
            headers=dict(self.headers),
            query=dict(self.query),
            body=self.body,
            scenario=self.scenario,
            seed=self.seed,
        )


class PreviewPayload(BaseModel):
    """One preview call: the bundle to render and the request to render against it."""

    model_config = ConfigDict(extra="forbid")

    bundle: Dict[str, Any] = Field(description="A portable mock bundle document (app.mock_bundle format).")
    request: PreviewRequestModel = Field(
        default_factory=PreviewRequestModel,
        description="The synthetic request; defaults to GET / when omitted.",
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
            detail="Mock preview is disabled: set APIOME_MOCK_INTERNAL_TOKEN to enable it (#5528, MSC-1.2).",
        )
    if not presented:
        raise HTTPException(status_code=401, detail="Internal service authentication required.")
    if not hmac.compare_digest(presented, configured):
        raise HTTPException(status_code=403, detail="Internal service token is not valid.")


def create_preview_router() -> APIRouter:
    """Build the router carrying the internal preview endpoint.

    Returns:
        A router with ``POST /__preview__`` registered.
    """
    router = APIRouter(tags=["preview"])

    @router.post(PREVIEW_PATH)
    async def preview(
        payload: PreviewPayload,
        x_internal_service_token: Optional[str] = Header(default=None, alias=INTERNAL_TOKEN_HEADER),
    ) -> Dict[str, Any]:
        """Render one synthetic request against a bundle and report what the mock would serve.

        Args:
            payload: The bundle and the synthetic request.
            x_internal_service_token: The shared internal token.

        Returns:
            The preview result: matched operation, status, headers, media type, body, and the
            decision trace naming which layer produced the body.

        Raises:
            HTTPException: ``503``/``401``/``403`` from the token gate; ``422`` when the bundle
                fails verification (with the structured problem list) or the request exceeds a
                preview's declared limits.
        """
        settings = get_settings()
        _require_internal_token(x_internal_service_token, settings)
        request = payload.request.to_preview_request()

        try:
            # No secret and no signature requirement: this bundle came over an authenticated
            # internal hop and was built moments ago by the control plane, so a signature would
            # attest to nothing the token has not already established. Content digests are still
            # verified, which is what protects against a truncated or garbled payload.
            bundle = load_bundle_document(payload.bundle)
        except MockBundleIncompatibleError as exc:
            raise HTTPException(status_code=422, detail=exc.as_dict()) from exc
        except MockBundleError as exc:
            raise HTTPException(status_code=422, detail=exc.as_dict()) from exc

        result = await render_preview(bundle.to_compiled_spec(), request)
        _log.info(
            "mock_preview",
            tenant=bundle.tenant_slug,
            project=bundle.project_slug,
            version=bundle.version_label,
            method=request.method.upper(),
            operation=result.operation,
            status=result.status,
            layer=result.trace.layer,
        )
        return result.as_dict()

    return router
