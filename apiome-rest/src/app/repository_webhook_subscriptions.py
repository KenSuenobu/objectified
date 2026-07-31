"""Webhook subscription lifecycle — provisioning at registration time (REPO-4.3, #2781).

The ticket asks for the subscription to be created "at registration time (REPO-1.4 path)",
so :func:`provision_repository_webhook` is called from ``create_tenant_repository`` right
after the repository row lands. It does two separable things, and keeping them separable is
the point:

1. **Mint and store the secret.** Always. A generated 256-bit secret, Fernet-encrypted with
   the same key as outbound webhook signing (:mod:`app.push_webhook_crypto`), written
   write-once into ``apiome.repository_webhook_subscription``. From this moment the
   ingestion endpoint will honour a correctly-signed delivery for this repository, whether
   or not anybody at the provider has been told about us yet.

2. **Ask the provider to create the hook.** Best-effort, and honestly reported. Creating a
   GitHub hook needs ``admin:repo_hook`` on a token we only have for a *linked-account*
   registration; a repository registered from a public URL has no token at all, and a linked
   token whose OAuth grant omitted the scope gets a 404 (GitHub's deliberate answer for "you
   may not know whether this exists"). Rather than pretend, the subscription records
   ``registration_state``: ``registered`` when the provider confirmed a hook, ``failed`` with
   the provider's reason when it refused, ``local`` when there was no token to try with.

Nothing here raises. Registration of a repository must not fail because a hook could not be
created; the tenant still has polling, and REPO-4.3 is an accelerator on top of it.

**The secret never leaves the server.** It is returned in the :class:`ProvisionResult` so
this module can hand it to the provider during hook creation, and it is recoverable from the
ciphertext for signature verification. Those are the only two uses. Per the ticket's fourth
acceptance criterion no REST response carries it, so a subscription left in the ``local``
state cannot be completed by an operator pasting the secret in by hand: the way to attach a
hook is to re-register the repository from a linked account whose token carries
``admin:repo_hook``. :func:`describe_subscription`, the projection every REST response goes
through, has no branch that can emit the secret — only a fingerprint of it.

**Rotation (REPO-4.7, #2785)** adds a second secret to the same discipline rather than a
second mechanism. :func:`resolve_subscription_secrets` returns every secret a delivery may
legitimately be signed with — one in the steady state, two while a rotation's grace window is
open — and :func:`update_github_webhook_secret` is how a rotated secret reaches the provider.
The orchestration lives in :mod:`app.repository_webhook_rotation`; what stays here is the
provider conversation and the projection, so there is still exactly one place where a
subscription becomes JSON.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

import httpx

from .push_webhook_crypto import decrypt_signing_secret, encrypt_signing_secret
from .repository_webhook_ingest import (
    generate_webhook_secret,
    normalize_provider,
    secret_fingerprint,
    signature_header_for_provider,
)

_logger = logging.getLogger(__name__)

__all__ = [
    "REGISTRATION_LOCAL",
    "REGISTRATION_REGISTERED",
    "REGISTRATION_FAILED",
    "SECRET_GENERATION_CURRENT",
    "SECRET_GENERATION_PREVIOUS",
    "WEBHOOK_REGISTERED_ACTION",
    "ProvisionResult",
    "webhook_endpoint_path",
    "webhook_endpoint_url",
    "resolve_subscription_secret",
    "resolve_subscription_secrets",
    "previous_secret_is_live",
    "describe_subscription",
    "iso_timestamp",
    "register_github_webhook",
    "update_github_webhook_secret",
    "provision_repository_webhook",
]

#: Secret held here; nobody has pointed the provider at us.
REGISTRATION_LOCAL = "local"
#: The provider confirmed a hook and returned its id.
REGISTRATION_REGISTERED = "registered"
#: The provider refused; ``registration_error`` carries the reason.
REGISTRATION_FAILED = "failed"

#: Which of a subscription's two secrets verified a delivery (REPO-4.7). Recorded on the
#: acceptance audit, because "this delivery only verified because a rotation window was still
#: open" is exactly what an operator needs to see before that window closes.
SECRET_GENERATION_CURRENT = "current"
SECRET_GENERATION_PREVIOUS = "previous"

#: Workflow-audit action written when a provider hook is created for a repository.
WEBHOOK_REGISTERED_ACTION = "repository.webhook.registered"

#: GitHub hook events we subscribe to — exactly the two the dispatcher acts on.
_GITHUB_HOOK_EVENTS = ("push", "pull_request")

#: How long to wait on the provider's hook-creation call. Registration is user-facing and
#: synchronous; a provider having a slow day must not hold the request open.
_REGISTER_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class ProvisionResult:
    """Outcome of provisioning a repository's webhook subscription.

    Attributes:
        subscription: The stored subscription row (never carrying ``secret_enc``), or
            ``None`` when nothing could be stored.
        secret: The plaintext signing secret, for server-side use only — hook creation is
            the one thing that needs it here. It must not be placed in a REST response
            (acceptance criterion 4). ``None`` when the subscription already existed (the
            secret is write-once) or when provisioning failed.
        state: The resulting :data:`REGISTRATION_LOCAL` / :data:`REGISTRATION_REGISTERED` /
            :data:`REGISTRATION_FAILED`.
        error: Why the provider refused, when it did.
    """

    subscription: Optional[Dict[str, Any]]
    secret: Optional[str]
    state: str
    error: Optional[str] = None


def webhook_endpoint_path(provider: str) -> str:
    """Return the ingestion path a provider should deliver to.

    Args:
        provider: A provider id.

    Returns:
        The path, for example ``/v1/repositories/webhook/github``.
    """
    return f"/v1/repositories/webhook/{normalize_provider(provider) or 'github'}"


def webhook_endpoint_url(provider: str, base_url: Optional[str] = None) -> Optional[str]:
    """Build the absolute delivery URL an operator pastes into the provider.

    Args:
        provider: A provider id.
        base_url: The deployment's public base URL. Defaults to
            ``APIOME_REPOSITORY_WEBHOOK_BASE_URL``.

    Returns:
        The absolute URL, or ``None`` when no public base URL is configured — in which case
        the UI shows the path and lets the operator supply their own host, rather than
        inventing one that would silently never receive a delivery.
    """
    from .config import settings

    base = (base_url if base_url is not None else settings.repository_webhook_base_url) or ""
    base = str(base).strip().rstrip("/")
    if not base:
        return None
    return f"{base}{webhook_endpoint_path(provider)}"


def resolve_subscription_secret(row: Dict[str, Any]) -> Optional[str]:
    """Recover a subscription's plaintext **current** signing secret for verification.

    Args:
        row: A subscription row from
            :meth:`Database.find_repository_webhook_subscriptions` (the only read that
            selects ``secret_enc``).

    Returns:
        The plaintext secret, or ``None`` when the row has no ciphertext or the deployment's
        encryption key cannot decrypt it. ``None`` makes verification fail closed.
    """
    return _decrypt(row.get("secret_enc"))


def _decrypt(blob: Any) -> Optional[str]:
    """Decrypt one ciphertext column, treating every failure as "no secret"."""
    if not blob:
        return None
    try:
        return decrypt_signing_secret(bytes(blob))
    except (TypeError, ValueError):
        # A corrupt or non-bytes column is a broken subscription, not an authenticated one.
        return None


def previous_secret_is_live(row: Mapping[str, Any], *, now: Optional[datetime] = None) -> bool:
    """Whether a subscription's outgoing secret is still inside its grace window (REPO-4.7).

    Args:
        row: A subscription row carrying ``previous_secret_expires_at``.
        now: The instant to judge against; defaults to now, in UTC.

    Returns:
        True only when there is an outgoing secret **and** a deadline **and** the deadline has
        not passed. A missing deadline is treated as expired rather than as "no deadline, so
        forever": the database constraint makes that state unreachable, and if it were ever
        reached the safe reading is that the secret is retired.
    """
    if not row.get("previous_secret_enc"):
        return False
    expires_at = row.get("previous_secret_expires_at")
    if expires_at is None:
        return False
    if not isinstance(expires_at, datetime):
        return False
    moment = now or datetime.now(timezone.utc)
    # A naive column value is read as UTC; the database stores TIMESTAMPTZ, so the only way to
    # get one here is a fake in a test, and assuming UTC is what that fake means.
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return expires_at > moment


def resolve_subscription_secrets(
    row: Mapping[str, Any], *, now: Optional[datetime] = None
) -> List[Tuple[str, str]]:
    """Every secret a delivery for this subscription may legitimately be signed with.

    During a rotation grace window that is two secrets, and accepting either is the whole
    point of REPO-4.7: the provider may not have been updated yet, and deliveries signed
    before the rotation may still be in flight. Outside a window it is one, so the ordinary
    case is unchanged.

    The current secret is tried first, so a verification in the steady state costs one HMAC
    and the extra work only exists while a rotation is open.

    Args:
        row: A subscription row from :meth:`Database.find_repository_webhook_subscriptions`.
        now: The instant to judge the grace window against; defaults to now.

    Returns:
        ``[(secret, generation), ...]`` where generation is :data:`SECRET_GENERATION_CURRENT`
        or :data:`SECRET_GENERATION_PREVIOUS`. Empty when nothing could be recovered, which
        makes verification fail closed.
    """
    candidates: List[Tuple[str, str]] = []
    current = _decrypt(row.get("secret_enc"))
    if current:
        candidates.append((current, SECRET_GENERATION_CURRENT))
    if previous_secret_is_live(row, now=now):
        previous = _decrypt(row.get("previous_secret_enc"))
        # A previous secret that decrypts to the current one carries no information and would
        # only make an expiry look meaningful when it is not.
        if previous and previous != current:
            candidates.append((previous, SECRET_GENERATION_PREVIOUS))
    return candidates


def update_github_webhook_secret(
    *,
    access_token: str,
    owner: str,
    repo: str,
    hook_id: str,
    delivery_url: str,
    secret: str,
    client: Optional[httpx.Client] = None,
) -> Dict[str, Any]:
    """Point an existing GitHub hook at a rotated signing secret (REPO-4.7).

    GitHub's hook ``config`` is **replaced**, not merged, by a PATCH — sending only the secret
    would blank the delivery URL and silently detach the hook. The full config is therefore
    rebuilt from the same helper the creation path uses, so the two can never drift into
    sending different content types or TLS settings.

    Args:
        access_token: A linked-account OAuth token; needs ``admin:repo_hook``.
        owner: Repository owner.
        repo: Repository name.
        hook_id: The provider hook identifier recorded at registration time.
        delivery_url: The absolute delivery URL, re-sent because config is replaced wholesale.
        secret: The **new** signing secret.
        client: Optional pre-opened HTTP client (tests inject one).

    Returns:
        ``{"ok": True}`` on success, or ``{"ok": False, "error": "..."}``. Never raises: a
        provider that refuses leaves the rotation relying on its grace window, which is a
        recorded state rather than an exception.
    """
    payload = {"config": _github_hook_config(delivery_url, secret)}
    url = f"https://api.github.com/repos/{owner}/{repo}/hooks/{hook_id}"

    owned_client = client is None
    http = client or httpx.Client(timeout=_REGISTER_TIMEOUT_SECONDS)
    try:
        resp = http.patch(url, json=payload, headers=_github_headers(access_token))
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"GitHub hook update failed: {exc}"}
    finally:
        if owned_client:
            http.close()

    if resp.status_code in (200, 201):
        return {"ok": True}
    if resp.status_code in (403, 404):
        return {
            "ok": False,
            "error": (
                f"GitHub refused the hook update (HTTP {resp.status_code}): the linked "
                "account's token needs admin:repo_hook on this repository, and the hook must "
                "still exist."
            ),
        }
    return {"ok": False, "error": f"GitHub hook update failed: HTTP {resp.status_code}"}


def describe_subscription(
    row: Optional[Dict[str, Any]], *, base_url: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Project a subscription into the shape a REST response may carry.

    Acceptance criterion 4 in the ticket — *the secret is not returned in REST responses* —
    is enforced here and nowhere else, so there is a single place to audit. The projection is
    built from an explicit key list rather than by deleting sensitive keys from the row: a
    column added to the table later is absent from the response by default instead of leaking
    until somebody remembers to exclude it.

    Args:
        row: A subscription row, or ``None``.
        base_url: Override for the deployment's public base URL.

    Returns:
        A JSON-serialisable dict with camelCase keys, or ``None`` when ``row`` is ``None``.
    """
    if row is None:
        return None
    provider = str(row.get("provider") or "github")
    return {
        "id": str(row.get("id") or ""),
        "provider": provider,
        "repositoryFullName": row.get("repo_full_name"),
        "registrationState": row.get("registration_state") or REGISTRATION_LOCAL,
        "registrationError": row.get("registration_error"),
        "providerHookId": row.get("provider_hook_id"),
        # A fingerprint, not the secret: it confirms which secret is held without revealing it.
        "secretFingerprint": row.get("secret_fingerprint"),
        # Rotation (REPO-4.7). Same discipline: fingerprints and a deadline, never a secret.
        # `providerSecretSynced` false is the state that needs an operator's attention — the
        # provider is still signing with the outgoing secret, and `previousSecretExpiresAt` is
        # when that stops working.
        "previousSecretFingerprint": row.get("previous_secret_fingerprint"),
        "previousSecretExpiresAt": iso_timestamp(row.get("previous_secret_expires_at")),
        "rotatedAt": iso_timestamp(row.get("rotated_at")),
        "rotationCount": int(row.get("rotation_count") or 0),
        "providerSecretSynced": bool(row.get("provider_secret_synced", True)),
        "rotationError": row.get("rotation_error"),
        "prPreviewEnabled": bool(row.get("pr_preview_enabled", True)),
        "signatureHeader": signature_header_for_provider(provider),
        "endpointPath": webhook_endpoint_path(provider),
        "endpointUrl": webhook_endpoint_url(provider, base_url),
        "eventCount": int(row.get("event_count") or 0),
        "lastEventAt": iso_timestamp(row.get("last_event_at")),
        "lastDeliveryId": row.get("last_delivery_id"),
        "createdAt": iso_timestamp(row.get("created_at")),
        "updatedAt": iso_timestamp(row.get("updated_at")),
    }


def iso_timestamp(value: Any) -> Optional[str]:
    """Render a timestamp as ISO-8601, passing strings through and ``None`` as ``None``.

    Shared with :mod:`app.repository_webhook_rotation`, which renders the same columns into
    audit detail; two copies would be two places for a timestamp to be formatted differently.

    Args:
        value: A datetime, a string, or ``None``.

    Returns:
        The ISO-8601 rendering, or ``None``.
    """
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def _github_headers(access_token: str) -> Dict[str, str]:
    """Headers for a GitHub hook administration call, pinned to one API version."""
    return {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": f"Bearer {access_token}",
    }


def _github_hook_config(delivery_url: str, secret: str) -> Dict[str, str]:
    """The hook ``config`` object, shared by creation and by secret rotation.

    Shared deliberately: GitHub replaces the whole config on a PATCH, so a rotation that built
    its own object would be one forgotten key away from switching a hook to form-encoded
    deliveries (which the ingestion path does not parse) or to ``insecure_ssl``.

    Args:
        delivery_url: The absolute URL GitHub posts deliveries to.
        secret: The signing secret GitHub signs deliveries with.

    Returns:
        The config object to send.
    """
    return {
        "url": delivery_url,
        "content_type": "json",
        "secret": secret,
        "insecure_ssl": "0",
    }


def register_github_webhook(
    *,
    access_token: str,
    owner: str,
    repo: str,
    delivery_url: str,
    secret: str,
    client: Optional[httpx.Client] = None,
) -> Dict[str, Any]:
    """Ask GitHub to create a push/pull_request hook for this repository.

    Args:
        access_token: A linked-account OAuth token; needs ``admin:repo_hook``.
        owner: Repository owner.
        repo: Repository name.
        delivery_url: The absolute URL GitHub should POST deliveries to.
        secret: The HMAC signing secret GitHub will sign deliveries with.
        client: Optional pre-opened HTTP client (tests inject one).

    Returns:
        ``{"ok": True, "hook_id": "<id>"}`` on success, or ``{"ok": False, "error": "..."}``
        with a short human-readable reason. Never raises: a provider that refuses is a
        recorded state, not an exception that fails repository registration.
    """
    payload = {
        "name": "web",
        "active": True,
        "events": list(_GITHUB_HOOK_EVENTS),
        "config": _github_hook_config(delivery_url, secret),
    }
    url = f"https://api.github.com/repos/{owner}/{repo}/hooks"

    owned_client = client is None
    http = client or httpx.Client(timeout=_REGISTER_TIMEOUT_SECONDS)
    try:
        resp = http.post(url, json=payload, headers=_github_headers(access_token))
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"GitHub hook request failed: {exc}"}
    finally:
        if owned_client:
            http.close()

    if resp.status_code in (200, 201):
        try:
            body = resp.json()
        except ValueError:
            body = {}
        hook_id = body.get("id") if isinstance(body, dict) else None
        return {"ok": True, "hook_id": (str(hook_id) if hook_id is not None else None)}

    if resp.status_code in (403, 404):
        # GitHub answers 404 rather than 403 when the token simply lacks admin:repo_hook, so
        # the two collapse into one honest message instead of a misleading "not found".
        return {
            "ok": False,
            "error": (
                "GitHub refused hook creation (HTTP "
                f"{resp.status_code}): the linked account's token needs admin:repo_hook on "
                "this repository. Re-link the account with that scope and re-register the "
                "repository to attach a hook."
            ),
        }
    if resp.status_code == 422:
        return {
            "ok": False,
            "error": "GitHub rejected the hook as invalid or already present (HTTP 422).",
        }
    return {"ok": False, "error": f"GitHub hook creation failed: HTTP {resp.status_code}"}


def _record_registration_audit(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    provider: str,
    state: str,
    hook_id: Optional[str],
    error: Optional[str],
    actor_id: Optional[str],
) -> None:
    """Write one :data:`WEBHOOK_REGISTERED_ACTION` row; best-effort, never raises."""
    detail: Dict[str, Any] = {
        "repositoryId": str(repository_id or ""),
        "provider": provider,
        "registrationState": state,
    }
    if hook_id:
        detail["providerHookId"] = hook_id
    if error:
        detail["error"] = error
    try:
        db.insert_workflow_audit(
            tenant_id,
            None,
            None,
            WEBHOOK_REGISTERED_ACTION,
            "success" if state == REGISTRATION_REGISTERED else "failure",
            actor_id,
            detail,
        )
    except Exception:
        _logger.exception(
            "repository webhook registration audit failed repository_id=%s", repository_id
        )


def provision_repository_webhook(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    provider: str,
    repo_full_name: Optional[str],
    access_token: Optional[str] = None,
    actor_id: Optional[str] = None,
    client: Optional[httpx.Client] = None,
) -> ProvisionResult:
    """Provision a repository's webhook subscription at registration time (REPO-4.3).

    Mints and stores the signing secret, then — only when a token and a public delivery URL
    are both available — asks the provider to create the hook and records how that went.
    Never raises: repository registration succeeds whether or not the hook could be created,
    and the tenant keeps the RAR-3.1 polling cadence either way.

    Args:
        db: Database handle.
        tenant_id: Owning tenant id.
        repository_id: The freshly registered repository.
        provider: Provider id from the repository row.
        repo_full_name: ``owner/name`` for the repository; lowercased before storage.
        access_token: A linked-account token to create the hook with, when one exists.
        actor_id: The user who registered the repository (for the audit row).
        client: Optional pre-opened HTTP client (tests inject one).

    Returns:
        A :class:`ProvisionResult`. ``subscription`` is ``None`` when nothing could be
        stored (an unsupported provider, no repository full name, or a store error).
    """
    key = normalize_provider(provider)
    full_name = str(repo_full_name or "").strip().lower()
    if not key or not full_name:
        # Nothing to resolve a delivery against; polling remains the only sync path.
        return ProvisionResult(
            subscription=None,
            secret=None,
            state=REGISTRATION_LOCAL,
            error=(
                f"provider {provider!r} does not support webhook ingestion"
                if not key
                else "repository has no owner/name to resolve deliveries against"
            ),
        )

    secret = generate_webhook_secret()
    try:
        subscription = db.insert_repository_webhook_subscription(
            tenant_id=tenant_id,
            repository_id=repository_id,
            provider=key,
            repo_full_name=full_name,
            secret_enc=encrypt_signing_secret(secret),
            secret_fingerprint=secret_fingerprint(secret),
        )
    except Exception as exc:
        _logger.warning(
            "repository webhook subscription not created repository_id=%s: %s",
            repository_id,
            exc,
        )
        return ProvisionResult(
            subscription=None, secret=None, state=REGISTRATION_LOCAL, error=str(exc)
        )

    if subscription is None:
        # A subscription already exists. Its secret is write-once and deliberately not
        # recoverable for display, so nothing is returned and nothing is overwritten.
        return ProvisionResult(
            subscription=None,
            secret=None,
            state=REGISTRATION_LOCAL,
            error="a webhook subscription already exists for this repository",
        )

    delivery_url = webhook_endpoint_url(key)
    if not access_token or not delivery_url or key != "github":
        reason = (
            "no linked-account token is available to create the hook with"
            if not access_token
            else (
                "APIOME_REPOSITORY_WEBHOOK_BASE_URL is not configured, so there is no "
                "public delivery URL to register"
                if not delivery_url
                else f"automatic hook creation is not implemented for {key}"
            )
        )
        return ProvisionResult(
            subscription=subscription,
            secret=secret,
            state=REGISTRATION_LOCAL,
            error=reason,
        )

    owner, _, repo = full_name.partition("/")
    outcome = register_github_webhook(
        access_token=access_token,
        owner=owner,
        repo=repo,
        delivery_url=delivery_url,
        secret=secret,
        client=client,
    )
    state = REGISTRATION_REGISTERED if outcome.get("ok") else REGISTRATION_FAILED
    error = None if outcome.get("ok") else str(outcome.get("error") or "")
    hook_id = outcome.get("hook_id") if outcome.get("ok") else None

    try:
        updated = db.update_repository_webhook_registration(
            str(subscription["id"]),
            registration_state=state,
            provider_hook_id=hook_id,
            registration_error=error,
        )
        if updated:
            subscription = updated
    except Exception:
        _logger.exception(
            "repository webhook registration state not recorded repository_id=%s",
            repository_id,
        )

    _record_registration_audit(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        provider=key,
        state=state,
        hook_id=hook_id,
        error=error,
        actor_id=actor_id,
    )

    return ProvisionResult(
        subscription=subscription, secret=secret, state=state, error=error
    )
