"""Serving hosted sandboxes through the one mock engine (#5532, MSC-2.2).

A **sandbox** is an ephemeral mock instance: a row in ``mock_instances`` holding a frozen OpenAPI
document, addressed by id at ``/v1/mock/{id}/…``. Two surfaces provision them — the hosted Mock
Server (#3615) from a published version, and the Export Studio's test drive (MFX-44.5) from an
emitted artifact — and until MSC-2.2 both were served by a *second* mock engine living inside this
package, with no templates, no predicates, no stateful CRUD, no fixtures and no chaos.

That engine is gone. This module is what replaced it, and it decides nothing:

* :func:`sandbox_bundle` projects an instance into the portable mock bundle format — the same
  self-contained document a bundle download produces, and the same unit the dry-run preview
  (#5528, MSC-1.2) already sends across this hop.
* :func:`request_sandbox_serve` hands that bundle plus the caller's request to apiome-mock's
  internal ``/__sandbox__`` endpoint and returns what it served.

The bundle is the right unit for the hop for the same reasons it is right for preview: it is
already the document the portable runtime serves, it embeds only the allowlisted,
credential-redacted settings keys, and it carries content digests the far side verifies. A sandbox
therefore serves exactly the configuration a downloaded bundle would, with no second projection to
keep in step — and, crucially, no second resolver.

What stayed here is what a *sandbox* is rather than what a *mock* is: whether the instance exists,
whether it has expired, whether the caller is inside its rate limit, and what to record about the
request. Those are lifecycle concerns this package owns; resolution is not.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Mapping, Optional

import httpx

from .config import settings
from .mock_bundle import BundleIdentity, build_bundle
from .mock_settings_util import parse_mock_settings

logger = logging.getLogger(__name__)

__all__ = [
    "FORWARDED_SANDBOX_STATUSES",
    "INTERNAL_TOKEN_HEADER",
    "NOT_CONFIGURED_DETAIL",
    "SANDBOX_PATH",
    "MockSandboxError",
    "MockSandboxRejected",
    "MockSandboxUnavailable",
    "sandbox_bundle",
    "sandbox_is_configured",
    "request_sandbox_serve",
]

#: Path of apiome-mock's internal sandbox endpoint.
SANDBOX_PATH = "/__sandbox__"

#: Header carrying the shared internal token, matching the convention the preview hop established.
INTERNAL_TOKEN_HEADER = "X-Internal-Service-Token"

#: Statuses from the mock runtime that describe the *caller's* payload and are therefore safe to
#: pass through. Everything else (a rejected service token, an internal fault) is a deployment
#: problem the caller cannot act on and must not see, so it becomes a plain 502.
FORWARDED_SANDBOX_STATUSES = frozenset({413, 422})

#: The one wording for "this deployment cannot serve sandboxes", shared by the route's early guard
#: and the transport's own check so the two can never say different things.
NOT_CONFIGURED_DETAIL = (
    "The mock data plane is not configured on this deployment: set APIOME_MOCK_INTERNAL_BASE_URL "
    "and APIOME_MOCK_INTERNAL_TOKEN so mock requests can reach the mock engine."
)


class MockSandboxError(RuntimeError):
    """The sandbox request could not be served because the mock runtime could not be reached."""


class MockSandboxUnavailable(MockSandboxError):
    """Sandbox serving is not configured on this deployment (no internal URL or token)."""


class MockSandboxRejected(MockSandboxError):
    """The mock runtime refused the request; ``detail`` carries its structured explanation.

    Attributes:
        status_code: The status the mock runtime returned.
        detail: Its structured error detail.
    """

    def __init__(self, status_code: int, detail: Any) -> None:
        super().__init__(f"The mock engine rejected the sandbox request ({status_code}).")
        self.status_code = status_code
        self.detail = detail


def sandbox_is_configured() -> bool:
    """Whether this deployment can serve sandbox requests at all.

    Returns:
        ``True`` when both the internal mock URL and the shared token are configured. Both halves
        are required: without them a request would either have nowhere to go or would reach an
        endpoint that (correctly) refuses to serve an unauthenticated caller.
    """
    return bool(
        (settings.mock_internal_base_url or "").strip() and (settings.mock_internal_token or "").strip()
    )


def sandbox_bundle(instance: Mapping[str, Any]) -> Dict[str, Any]:
    """Project a mock instance into the portable bundle the engine serves it from.

    The instance's own coordinates become the bundle identity, so problem documents and session
    namespacing name the API the sandbox was frozen from rather than an opaque id. Its
    ``settings`` column — the folded, apiome-mock-shaped configuration (:mod:`app.mock_instance_config`)
    — is the settings payload.

    Args:
        instance: A ``mock_instances`` row.

    Returns:
        The bundle document to send across the internal hop.
    """
    return build_bundle(
        identity=BundleIdentity(
            tenant=str(instance.get("tenant_slug") or "sandbox"),
            project=str(instance.get("project_slug") or "sandbox"),
            version=str(instance.get("version_slug") or "sandbox"),
            revision_id=str(instance.get("version_id") or instance["id"]),
            published=True,
            protocol="openapi",
        ),
        spec=instance.get("spec") or {},
        mock_settings=parse_mock_settings(instance.get("settings")),
        # Deliberately unsigned, exactly as the preview hop is: the bundle crosses one
        # authenticated internal hop and is built moments before it is served, so a signature would
        # attest to nothing the shared token has not already established. Content digests still
        # travel and are verified on arrival.
        secret=None,
    )


async def request_sandbox_serve(
    *,
    sandbox_id: str,
    bundle: Mapping[str, Any],
    request: Mapping[str, Any],
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Ask the mock engine to serve one sandbox request.

    Args:
        sandbox_id: The instance id, which scopes session state on the far side so two sandboxes
            frozen from the same version cannot see each other's stateful CRUD.
        bundle: The sandbox's portable mock bundle document.
        request: The request to serve (``method``/``path``/``headers``/``query``/``body``/
            ``scenario``/``seed``).
        timeout: Ceiling on the round trip; defaults to the configured sandbox timeout.

    Returns:
        The served response: ``status``, ``headers``, ``mediaType``, ``body``, ``bodyEncoding``,
        ``operation`` and ``scenario``.

    Raises:
        MockSandboxUnavailable: Sandbox serving is not configured on this deployment.
        MockSandboxRejected: The runtime refused the request (bad bundle, bad token, limits).
        MockSandboxError: The runtime could not be reached or answered unintelligibly.
    """
    if not sandbox_is_configured():
        raise MockSandboxUnavailable(NOT_CONFIGURED_DETAIL)

    url = settings.mock_internal_base_url.rstrip("/") + SANDBOX_PATH
    ceiling = timeout if timeout is not None else settings.mock_sandbox_timeout_seconds
    try:
        async with httpx.AsyncClient(timeout=ceiling) as client:
            response = await client.post(
                url,
                json={"sandbox": sandbox_id, "bundle": dict(bundle), "request": dict(request)},
                headers={INTERNAL_TOKEN_HEADER: str(settings.mock_internal_token)},
            )
    except httpx.HTTPError as exc:
        logger.warning("Mock sandbox transport failure: %s", exc)
        raise MockSandboxError(f"The mock engine could not be reached: {exc}") from exc

    if response.status_code >= 400:
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text[:500]
        raise MockSandboxRejected(response.status_code, detail)

    try:
        payload = response.json()
    except ValueError as exc:
        raise MockSandboxError("The mock engine returned a response that is not JSON.") from exc
    if not isinstance(payload, dict):
        raise MockSandboxError("The mock engine returned an unexpected response shape.")
    return payload
