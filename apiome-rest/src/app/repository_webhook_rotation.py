"""Webhook signing-secret rotation (REPO-4.7, #2785).

A signing secret that has been sitting in a provider's hook configuration since the
repository was registered is an audit finding waiting to be written down. REPO-4.3 made the
secret write-once, which is the right answer to "an attacker must not be able to substitute
their own key" and the wrong answer to "this key is eighteen months old": the only way to
change it was to delete the subscription and create another, which drops the old secret the
instant it runs. Every delivery already in flight fails, and every delivery the provider sends
until somebody finishes editing the hook fails with it. A rotation nobody dares perform is a
secret that never rotates.

So a rotation here is **two secrets and a deadline**:

1. Mint a new secret and store it, carrying the outgoing one into ``previous_secret_enc`` with
   an expiry — one UPDATE, whose shape the database's guard trigger enforces, so there is no
   statement anywhere that can replace a secret without leaving the displaced one verifying.
2. Update the provider's hook to the new secret. Best-effort and honestly recorded: this needs
   a token with ``admin:repo_hook`` and a public delivery URL, and a deployment may have
   neither.
3. Until the window closes, verification accepts **either** secret
   (:func:`app.repository_webhook_subscriptions.resolve_subscription_secrets`).
4. When it closes, :mod:`app.repository_webhook_secret_sweep` clears the outgoing secret and
   the old key stops verifying — automatically, whether or not anybody was watching.

**The database first, the provider second.** The reverse order has a failure mode nothing can
rescue: if the provider is updated and the store then fails, the provider signs with a secret
this deployment has never held, and every delivery is a 401 until an operator notices. In this
order the worst case is a provider still signing with the outgoing secret — which verifies for
the whole grace window, and which the sweep keeps trying to fix on every tick.

Nothing here raises for a provider failure. A rotation that reached the database *happened*;
whether it reached GitHub is a state (``provider_secret_synced``) with a reason attached
(``rotation_error``), reported to the operator rather than rolled back underneath them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

import httpx

from .push_webhook_crypto import encrypt_signing_secret
from .repository_webhook_ingest import generate_webhook_secret, secret_fingerprint
from .repository_webhook_subscriptions import (
    iso_timestamp,
    update_github_webhook_secret,
    webhook_endpoint_url,
)

_logger = logging.getLogger(__name__)

__all__ = [
    "WEBHOOK_SECRET_ROTATED_ACTION",
    "WEBHOOK_SECRET_EXPIRED_ACTION",
    "RotationError",
    "RotationResult",
    "resolve_grace_seconds",
    "resolve_linked_account_token",
    "sync_provider_secret",
    "rotate_repository_webhook_secret",
]

#: Audit action written for every rotation, required by the ticket's third acceptance
#: criterion. Written whether or not the provider update succeeded — the rotation happened
#: either way, and the detail says how far it got.
WEBHOOK_SECRET_ROTATED_ACTION = "repository.webhook_secret_rotated"

#: Audit action written when a grace window closes and the outgoing secret stops verifying.
WEBHOOK_SECRET_EXPIRED_ACTION = "repository.webhook_secret_rotation_expired"


class RotationError(Exception):
    """A rotation could not be performed at all; nothing was changed.

    Distinct from "the rotation happened but the provider was not updated", which is a
    :class:`RotationResult` with ``provider_synced`` False. This is the case where the new
    secret was never stored, so the subscription is exactly as it was.

    Attributes:
        code: Stable machine-readable code (``no_subscription``, ``no_encryption_key``,
            ``no_secret_to_rotate``, ``store_failed``).
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class RotationResult:
    """The outcome of one rotation.

    Attributes:
        subscription: The rotated subscription row, never carrying ciphertext.
        grace_seconds: The grace window actually applied, after clamping.
        provider_synced: True when the provider's hook now holds the new secret.
        provider_error: Why it does not, when it does not. ``None`` on success.
    """

    subscription: Dict[str, Any]
    grace_seconds: int
    provider_synced: bool
    provider_error: Optional[str] = None


def resolve_grace_seconds(requested: Optional[int] = None) -> int:
    """Clamp a requested grace window to the deployment's bounds.

    Clamped rather than rejected: a rotation refused over a validation technicality is a
    rotation that does not happen, and the point of the feature is that rotating is easy. The
    bounds themselves matter in both directions — a zero-length window is the hard cutover
    this ticket exists to avoid, and an unbounded one is the long-lived secret it exists to
    close.

    Args:
        requested: The caller's requested window in seconds, or ``None`` for the deployment
            default (``APIOME_REPOSITORY_WEBHOOK_SECRET_GRACE_SECONDS``, 24h).

    Returns:
        The window to apply, within
        ``[APIOME_REPOSITORY_WEBHOOK_SECRET_MIN_GRACE_SECONDS,
        APIOME_REPOSITORY_WEBHOOK_SECRET_MAX_GRACE_SECONDS]``.
    """
    from .config import settings

    low = max(0, int(settings.repository_webhook_secret_min_grace_seconds))
    high = max(low, int(settings.repository_webhook_secret_max_grace_seconds))
    value = (
        int(settings.repository_webhook_secret_grace_seconds)
        if requested is None
        else int(requested)
    )
    return max(low, min(high, value))


def resolve_linked_account_token(db: Any, row: Mapping[str, Any]) -> Optional[str]:
    """Resolve the OAuth token a repository's provider hook can be edited with.

    The token belongs to the user who *registered* the repository, not to whoever triggered
    the rotation: a hook created under one account cannot be edited with another account's
    token, and the sweep has no caller at all. A repository registered from a public URL has
    no linked account and therefore no token — which is a state, not an error.

    Mirrors ``repository_file_scan._resolve_scan_token`` without reusing it, because that one
    raises for a private repository with no token; here a missing token means "the rotation
    stays local", which must never become an exception.

    Args:
        db: Database handle.
        row: Anything carrying ``linked_account_id`` and ``created_by`` — a
            ``tenant_repositories`` row, or a subscription row joined to one.

    Returns:
        The stored access token, or ``None`` when there is none to be had.
    """
    linked = row.get("linked_account_id")
    created_by = row.get("created_by")
    if not linked or not created_by:
        return None
    try:
        oauth = db.get_external_auth_provider_for_user(str(linked), str(created_by))
    except Exception:
        _logger.warning(
            "linked-account token lookup failed repository_id=%s",
            row.get("repository_id") or row.get("id"),
            exc_info=True,
        )
        return None
    token = (oauth or {}).get("access_token")
    return str(token) if token else None


def sync_provider_secret(
    db: Any,
    subscription: Mapping[str, Any],
    *,
    secret: str,
    access_token: Optional[str],
    client: Optional[httpx.Client] = None,
) -> Dict[str, Any]:
    """Update the provider's hook to a rotated secret and record the outcome (REPO-4.7).

    Shared by the rotation itself and by the sweep that retries it, so an operator sees the
    same ``rotation_error`` text whichever attempt produced it, and there is one place where
    "what does it take to reach the provider" is decided.

    Args:
        db: Database handle.
        subscription: The rotated subscription row (needs ``id``, ``provider``,
            ``repo_full_name``, ``provider_hook_id``).
        secret: The plaintext **current** secret to install at the provider.
        access_token: A linked-account token with ``admin:repo_hook``, when one is available.
        client: Optional pre-opened HTTP client (tests inject one).

    Returns:
        ``{"ok": bool, "error": Optional[str]}``. Never raises: every failure is a recorded
        state, because the grace window is what protects deliveries in the meantime.
    """
    provider = str(subscription.get("provider") or "").lower()
    hook_id = str(subscription.get("provider_hook_id") or "").strip()
    full_name = str(subscription.get("repo_full_name") or "").strip().lower()
    delivery_url = webhook_endpoint_url(provider)

    if not hook_id:
        error: Optional[str] = (
            "no provider hook is registered for this repository, so there is nothing to "
            "update; configure the hook with the new secret by hand"
        )
    elif provider != "github":
        error = f"automatic hook updates are not implemented for {provider or 'this provider'}"
    elif not access_token:
        error = "no linked-account token is available to update the provider hook with"
    elif not delivery_url:
        # GitHub replaces the hook config wholesale, so an update without the delivery URL
        # would detach the hook entirely. Refusing to send one is the safe answer.
        error = (
            "APIOME_REPOSITORY_WEBHOOK_BASE_URL is not configured, so the hook's delivery "
            "URL cannot be re-sent and the secret cannot be updated safely"
        )
    elif "/" not in full_name:
        error = "the subscription has no owner/name to address the provider hook with"
    else:
        owner, _, repo = full_name.partition("/")
        outcome = update_github_webhook_secret(
            access_token=access_token,
            owner=owner,
            repo=repo,
            hook_id=hook_id,
            delivery_url=delivery_url,
            secret=secret,
            client=client,
        )
        error = None if outcome.get("ok") else str(outcome.get("error") or "")

    _record_sync_state(db, subscription, synced=error is None, error=error)
    return {"ok": error is None, "error": error}


def _record_sync_state(
    db: Any, subscription: Mapping[str, Any], *, synced: bool, error: Optional[str]
) -> None:
    """Persist the provider-sync outcome; best-effort, never raises.

    A failure to write this makes the sweep retry a provider call it has already made, which
    is wasteful and harmless. A failure to write it must not turn into a failed rotation.
    """
    try:
        db.set_repository_webhook_provider_secret_synced(
            str(subscription["id"]), synced=synced, error=error
        )
    except Exception:
        _logger.exception(
            "repository webhook provider-sync state not recorded subscription_id=%s",
            subscription.get("id"),
        )


def _audit_rotation(
    db: Any,
    subscription: Mapping[str, Any],
    *,
    grace_seconds: int,
    provider_synced: bool,
    provider_error: Optional[str],
    previous_fingerprint: Optional[str],
    displaced_unsynced: bool,
    actor_id: Optional[str],
) -> None:
    """Write the ticket's ``repository.webhook_secret_rotated`` row; never raises.

    The detail names both secrets by fingerprint and carries the deadline, so the audit trail
    answers "which key replaced which, and when does the old one stop working" without ever
    having held either value.

    The ``outcome`` column follows the ledger's success/failure convention and reports the
    *provider* half, matching how REPO-4.3 audits a hook that could not be created: a rotation
    the provider never learned about is the one an operator must act on. That the rotation
    itself succeeded is never in doubt — ``rotationCount`` advanced, and the row exists.
    """
    detail: Dict[str, Any] = {
        "repositoryId": str(subscription.get("repository_id") or ""),
        "provider": subscription.get("provider"),
        "repositoryFullName": subscription.get("repo_full_name"),
        "secretFingerprint": subscription.get("secret_fingerprint"),
        "previousSecretFingerprint": previous_fingerprint,
        "graceSeconds": grace_seconds,
        "previousSecretExpiresAt": iso_timestamp(subscription.get("previous_secret_expires_at")),
        "rotationCount": int(subscription.get("rotation_count") or 0),
        "providerSecretSynced": provider_synced,
    }
    if provider_error:
        detail["providerError"] = provider_error
    if displaced_unsynced:
        # Rotating again while the *previous* rotation had not reached the provider drops a
        # secret the provider may still be signing with — a window can only hold two secrets.
        # Allowed (re-rotating is how an operator recovers once a token is fixed) but never
        # silent.
        detail["displacedUnsyncedSecret"] = True
    try:
        db.insert_workflow_audit(
            str(subscription.get("tenant_id") or ""),
            None,
            None,
            WEBHOOK_SECRET_ROTATED_ACTION,
            "success" if provider_synced else "failure",
            actor_id,
            detail,
        )
    except Exception:
        _logger.exception(
            "repository webhook rotation audit failed subscription_id=%s",
            subscription.get("id"),
        )


def rotate_repository_webhook_secret(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    grace_seconds: Optional[int] = None,
    actor_id: Optional[str] = None,
    access_token: Optional[str] = None,
    client: Optional[httpx.Client] = None,
) -> RotationResult:
    """Rotate one repository's signing secret, keeping the old one valid for a window.

    Args:
        db: Database handle.
        tenant_id: Owning tenant id (scopes the lookup).
        repository_id: The repository whose subscription to rotate.
        grace_seconds: Requested grace window; ``None`` uses the deployment default. Clamped
            by :func:`resolve_grace_seconds`.
        actor_id: The user performing the rotation, for the audit row.
        access_token: A linked-account token to update the provider hook with, when one is
            available. Without it the rotation still happens and stays unsynced.
        client: Optional pre-opened HTTP client (tests inject one).

    Returns:
        A :class:`RotationResult`. ``provider_synced`` False means the grace window is
        load-bearing: the provider is still signing with the outgoing secret, and the sweep
        will keep retrying until the window closes.

    Raises:
        RotationError: When nothing was changed — no subscription, no encryption key
            configured, no secret to rotate, or the store refused the write.
    """
    subscription = db.get_repository_webhook_subscription(tenant_id, repository_id)
    if not subscription:
        raise RotationError(
            "no_subscription",
            "this repository has no webhook subscription to rotate",
        )

    outgoing_fingerprint = subscription.get("secret_fingerprint")
    if not outgoing_fingerprint:
        # No fingerprint means no secret was ever stored — the deployment had no encryption
        # key at registration time. Rotating would install a first secret while claiming to
        # have retired one, so the honest answer is that there is nothing to rotate.
        raise RotationError(
            "no_secret_to_rotate",
            "this subscription holds no signing secret; re-register the repository once "
            "APIOME_WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEY is configured",
        )

    secret = generate_webhook_secret()
    secret_enc = encrypt_signing_secret(secret)
    if not secret_enc:
        # Rotating without an encryption key would store NULL ciphertext, and verification
        # fails closed on NULL — every delivery for this repository would start being
        # rejected. Refuse instead, having changed nothing.
        raise RotationError(
            "no_encryption_key",
            "APIOME_WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEY is not configured, so a rotated "
            "secret could not be stored and every delivery would be rejected",
        )

    window = resolve_grace_seconds(grace_seconds)
    # A window holds two secrets, so rotating while the last rotation is still unsynced drops
    # a key the provider may be signing with right now. Recorded, not refused: re-rotating
    # after fixing a token is a legitimate recovery, and refusing would trap the operator.
    displaced_unsynced = not bool(subscription.get("provider_secret_synced", True))
    if displaced_unsynced:
        _logger.warning(
            "rotating a webhook secret whose previous rotation never reached the provider "
            "repository_id=%s — the displaced secret stops verifying immediately",
            repository_id,
        )

    try:
        rotated = db.rotate_repository_webhook_secret(
            str(subscription["id"]),
            secret_enc=secret_enc,
            secret_fingerprint=secret_fingerprint(secret),
            grace_seconds=window,
        )
    except Exception as exc:
        _logger.exception(
            "repository webhook secret rotation failed repository_id=%s", repository_id
        )
        raise RotationError("store_failed", f"the rotation could not be stored: {exc}") from exc

    if rotated is None:
        raise RotationError(
            "no_secret_to_rotate",
            "this subscription holds no signing secret to rotate",
        )

    sync = sync_provider_secret(
        db, rotated, secret=secret, access_token=access_token, client=client
    )
    provider_synced = bool(sync.get("ok"))
    provider_error = sync.get("error")
    # Reflect the sync outcome in the row handed back, so the caller's response and the audit
    # row agree with each other without a second read.
    rotated["provider_secret_synced"] = provider_synced
    rotated["rotation_error"] = provider_error

    _audit_rotation(
        db,
        rotated,
        grace_seconds=window,
        provider_synced=provider_synced,
        provider_error=provider_error,
        previous_fingerprint=outgoing_fingerprint,
        displaced_unsynced=displaced_unsynced,
        actor_id=actor_id,
    )

    if not provider_synced:
        _logger.warning(
            "repository webhook secret rotated but the provider hook was not updated "
            "repository_id=%s registration_state=%s: %s",
            repository_id,
            subscription.get("registration_state"),
            provider_error,
        )

    return RotationResult(
        subscription=rotated,
        grace_seconds=window,
        provider_synced=provider_synced,
        provider_error=provider_error,
    )
