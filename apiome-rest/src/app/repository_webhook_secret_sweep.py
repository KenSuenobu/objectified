"""Rotation grace-window sweep (REPO-4.7, #2785).

A rotation opens a window and walks away. This sweep is what closes it, and what keeps trying
to make the window unnecessary while it is open. One tick, two jobs, in this order:

1. **Retry the provider update.** Every subscription whose rotation has not reached its
   provider — a token that lacked ``admin:repo_hook`` at the time, a provider having a bad
   afternoon, a linked account that has since been re-linked with the right scope — gets one
   more attempt per tick for as long as its window is open. This is the ticket's second
   acceptance criterion doing its work: the provider is updated to the new secret *before*
   expiration, and if it cannot be, an operator can see that coming.

2. **Retire expired secrets.** Every outgoing secret whose deadline has passed is cleared, and
   from that moment a delivery signed with it is a 401 like any other bad signature. This is
   the half that must not depend on anybody being awake: the audit finding the ticket opens
   with is a secret that outlived its usefulness, and a grace window that only ends when
   somebody remembers to end it is the same finding wearing a hat.

Retry first, retire second, on the same tick: a rotation whose window closes in the next few
seconds gets its last provider attempt before its old secret stops working, rather than a tick
after.

Exactly-once across replicas comes from the claim, not from the scheduler:
:meth:`Database.claim_expired_repository_webhook_secrets` clears and returns rows under
``FOR UPDATE SKIP LOCKED``, so several instances sweeping concurrently retire disjoint sets
and each retirement writes one audit row. The retry pass is deliberately *not* exclusive —
two instances patching the same provider hook to the same secret is idempotent, and paying for
a claim to prevent a duplicate PATCH would be the more expensive mistake.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping

from .database import Database
from .repository_webhook_rotation import (
    WEBHOOK_SECRET_EXPIRED_ACTION,
    resolve_linked_account_token,
    sync_provider_secret,
)
from .repository_webhook_subscriptions import resolve_subscription_secret

logger = logging.getLogger(__name__)

__all__ = ["process_repository_webhook_secret_sweep"]

#: Subscriptions handled per tick, per pass. Both passes are bounded so one deployment-wide
#: rotation cannot turn a tick into a several-thousand-call conversation with GitHub.
_DEFAULT_LIMIT = 50


def _retry_provider_updates(database: Database, *, limit: int) -> int:
    """Re-attempt the provider hook update for rotations still inside their window.

    Args:
        database: Database handle.
        limit: Maximum subscriptions attempted this tick.

    Returns:
        How many subscriptions are now synced as a result of this tick.
    """
    try:
        pending = database.list_repository_webhook_subscriptions_pending_provider_secret(
            limit
        )
    except Exception:  # noqa: BLE001 - a failed tick retries on the next interval
        logger.warning("webhook secret sweep: pending lookup failed", exc_info=True)
        return 0

    synced = 0
    for row in pending or []:
        secret = resolve_subscription_secret(row)
        if not secret:
            # The current secret cannot be recovered (the deployment's encryption key changed,
            # or the column is corrupt). Handing the provider a secret we cannot verify with
            # would be worse than leaving the window to expire, so this one waits for a human.
            logger.warning(
                "webhook secret sweep: current secret unrecoverable subscription_id=%s",
                row.get("id"),
            )
            continue
        token = resolve_linked_account_token(database, row)
        outcome = sync_provider_secret(
            database, row, secret=secret, access_token=token, client=None
        )
        if outcome.get("ok"):
            synced += 1

    if synced:
        logger.info(
            "webhook secret sweep: provider hook updated for %d rotation(s)", synced
        )
    return synced


def _audit_expiry(database: Database, row: Mapping[str, Any]) -> None:
    """Record that an outgoing secret stopped verifying; best-effort, never raises."""
    tenant_id = str(row.get("tenant_id") or "")
    if not tenant_id:
        return
    detail: Dict[str, Any] = {
        "repositoryId": str(row.get("repository_id") or ""),
        "provider": row.get("provider"),
        "repositoryFullName": row.get("repo_full_name"),
        "retiredSecretFingerprint": row.get("retired_secret_fingerprint"),
        "secretFingerprint": row.get("secret_fingerprint"),
        "rotationCount": int(row.get("rotation_count") or 0),
        "providerSecretSynced": bool(row.get("provider_secret_synced", True)),
    }
    if not row.get("provider_secret_synced", True):
        # The window closed with the provider still on the retired secret: from now on its
        # deliveries are 401s. Named explicitly so the audit row is actionable on its own.
        detail["warning"] = (
            "the provider hook was never updated to the current secret; its deliveries will "
            "now fail signature verification until the hook is reconfigured"
        )
        if row.get("rotation_error"):
            detail["providerError"] = row.get("rotation_error")
    try:
        database.insert_workflow_audit(
            tenant_id,
            None,
            None,
            WEBHOOK_SECRET_EXPIRED_ACTION,
            "success" if row.get("provider_secret_synced", True) else "failure",
            None,
            detail,
        )
    except Exception:
        logger.exception(
            "webhook secret sweep: expiry audit failed subscription_id=%s", row.get("id")
        )


def _retire_expired_secrets(database: Database, *, limit: int) -> List[Dict[str, Any]]:
    """Clear outgoing secrets whose grace window has closed, auditing each.

    Args:
        database: Database handle.
        limit: Maximum subscriptions retired this tick.

    Returns:
        The retired rows (already cleared in the database).
    """
    try:
        retired = database.claim_expired_repository_webhook_secrets(limit)
    except Exception:  # noqa: BLE001 - a failed tick retries on the next interval
        logger.warning("webhook secret sweep: expiry claim failed", exc_info=True)
        return []

    for row in retired or []:
        _audit_expiry(database, row)
    if retired:
        unsynced = sum(1 for r in retired if not r.get("provider_secret_synced", True))
        logger.info(
            "webhook secret sweep: retired %d rotation secret(s), %d with an unsynced provider",
            len(retired),
            unsynced,
        )
    return list(retired or [])


def process_repository_webhook_secret_sweep(
    database: Database, *, limit: int = _DEFAULT_LIMIT
) -> Dict[str, int]:
    """Run one tick of the rotation grace-window sweep (REPO-4.7).

    Args:
        database: Database handle (a per-thread instance from the startup sweep).
        limit: Maximum subscriptions handled per pass.

    Returns:
        ``{"synced": n, "retired": n}`` — provider hooks brought up to date, and outgoing
        secrets retired. Both passes run regardless of whether the other one failed: they
        protect different things.
    """
    # `limit or _DEFAULT_LIMIT` would swallow an explicit 0 into the default; None is the only
    # value that means "unspecified", the same rule the delivery-listing read follows.
    requested = _DEFAULT_LIMIT if limit is None else int(limit)
    bounded = max(1, min(500, requested))
    synced = _retry_provider_updates(database, limit=bounded)
    retired = _retire_expired_secrets(database, limit=bounded)
    return {"synced": synced, "retired": len(retired)}
