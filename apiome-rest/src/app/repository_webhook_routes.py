"""Provider webhook ingestion endpoint (REPO-4.3, #2781).

``POST /v1/repositories/webhook/{provider}`` is the one route in the repository surface with
no bearer token: a provider cannot hold one. The HMAC signature over the raw body **is** the
authentication, so the handler's only job is to hand the exact received bytes to
:func:`app.repository_webhook_dispatch.ingest_webhook_delivery` — which resolves the
repository, verifies against that repository's stored secret, and dispatches — and then map
its outcome onto a status code.

Four status codes, and no others:

``200``  The delivery was accepted. That includes deliveries deliberately ignored (a ping, a
         tag push, an untracked branch): the provider must stop retrying something that is
         working as intended, and the ledger records why nothing happened.
``400``  The body is not a JSON object, or names no repository. Not an authentication
         failure, so not a 401.
``401``  The signature did not verify for a repository registered here. Audited, per the
         ticket's acceptance criteria.
``403``  The source address is not on the allowlist (REPO-7.6). Decided *before* the body
         reaches the dispatcher, so a blocked sender never gets a signature checked at all.

The response body says what happened in the coarsest terms that are still useful — outcome,
reason code, job count. It never names a tenant, a repository id or a branch: anyone who can
reach this endpoint can send an unsigned POST, and a richer body would answer questions
about a tenant's repositories for the price of one request.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path, Request

from .database import db
from .models import RepositoryWebhookReceiptResponse
from .repository_webhook_dispatch import WebhookRejectedError, ingest_webhook_delivery
from .repository_webhook_ingest import SUPPORTED_PROVIDERS, normalize_provider
from .repository_webhook_ip_allowlist import guard_webhook_delivery

router = APIRouter(prefix="/v1/repositories", tags=["repository-webhooks"])


@router.post(
    "/webhook/{provider}",
    response_model=RepositoryWebhookReceiptResponse,
    response_model_by_alias=True,
    summary="Ingest a provider push / pull-request webhook delivery",
)
async def ingest_repository_webhook(
    request: Request,
    provider: str = Path(
        ...,
        description=(
            "Git provider that signed this delivery: "
            + " | ".join(SUPPORTED_PROVIDERS)
        ),
    ),
) -> RepositoryWebhookReceiptResponse:
    """Receive one signed provider delivery and turn it into a poll (REPO-4.3).

    Args:
        request: The inbound request; its **raw** body is what the signature covers, so it is
            read as bytes and never re-serialised from parsed JSON.
        provider: The provider path segment.

    Returns:
        A thin receipt: the outcome, its reason code, and how many scan jobs were queued.

    Raises:
        HTTPException: 400 for an unsupported provider or an unusable body; 401 when the
            signature does not verify for a repository registered here; 403 when the source
            address is not on the allowlist (REPO-7.6) — raised before any verification.
    """
    key = normalize_provider(provider)
    if not key:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "unsupported_provider",
                "message": (
                    f"Provider {provider!r} is not supported. Supported: "
                    + ", ".join(SUPPORTED_PROVIDERS)
                    + "."
                ),
            },
        )

    raw = await request.body()

    # REPO-7.6: the network filter runs here, ahead of the dispatcher, so a source address
    # nobody vouches for never reaches `verify_signature`. The 403 body says only that the
    # source was refused — naming the allowlist, the tenant or the matched range would turn
    # the endpoint into a probe for the deployment's network policy.
    decision = guard_webhook_delivery(
        db,
        provider=key,
        raw_body=raw,
        headers=request.headers,
        peer_ip=(request.client.host if request.client else None),
    )
    if not decision.allowed:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "source_not_allowed",
                "message": "This source address is not permitted to deliver webhooks here.",
            },
        )

    try:
        result = ingest_webhook_delivery(
            db, provider=key, raw_body=raw, headers=request.headers
        )
    except WebhookRejectedError as exc:
        # Uniform body for every rejection cause, so the response cannot distinguish
        # "wrong signature" from "no secret recoverable for this subscription".
        raise HTTPException(
            status_code=401, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "malformed_payload", "message": str(exc)},
        ) from exc

    return RepositoryWebhookReceiptResponse(
        accepted=True,
        outcome=result.outcome,
        reason=result.reason,
        jobs_enqueued=result.jobs_enqueued,
    )
