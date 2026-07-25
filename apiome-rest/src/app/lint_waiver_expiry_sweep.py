"""Waiver-expiry notification sweep (CLX-4.2, #4860; extended by IXH-2.3, #5098).

A waiver is accepted risk with a deadline (CLX-1.3): when the deadline nears, the owner must
either remediate or renew — silently reopening at read time (which the policy engine already
does) tells nobody. This sweep runs periodically on every instance and enqueues one
``lint.waiver.expiring`` webhook per granted waiver whose ``expires_at`` falls within the
configured warning window (``lint_waiver_expiry_warning_hours``, default 72h).

**Two sources, one sweep.** Lint finding waivers (``lint_finding_decisions``, CLX-1.3) and
import/export quality waivers (``import_export_quality_waivers``, IXH-2.3) are both accepted
risk with a deadline, so they are claimed and notified on the same tick under the same warning
window rather than growing a second, near-identical mechanism.

Exactly-once across replicas comes from the claim, not the scheduler:
:meth:`Database.claim_expiring_lint_waivers` /
:meth:`Database.claim_expiring_import_export_quality_waivers` stamp ``expiry_notified_at``
under ``FOR UPDATE SKIP LOCKED`` and return only the rows this instance won. A lint waiver
re-granted with a new expiry re-arms (the decision upsert resets the marker), so renewals
notify again for their new deadline; a quality waiver is granted once and never renewed in
place, so its marker is set exactly once.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from .config import settings
from .database import Database
from .lint_notifications import notify_lint_waiver_expiring

logger = logging.getLogger(__name__)

__all__ = ["process_lint_waiver_expiry_sweep"]


def _sweep_quality_waivers(
    database: Database, *, cutoff: datetime, limit: int
) -> int:
    """Claim and notify soon-expiring import/export quality waivers (IXH-2.3, #5098).

    The quality waiver row carries the same facts a lint decision does — tenant, subject
    identity, reason, expiry — so it is projected onto the notification's decision shape and
    fans out as the same ``lint.waiver.expiring`` event. A subscriber therefore sees one event
    type for "a waiver you rely on is about to lapse", distinguished by ``kind``.

    Args:
        database: Database handle for the claim and the fan-out.
        cutoff: Notify waivers expiring at or before this instant.
        limit: Max waivers claimed this tick.

    Returns:
        The number of quality waivers claimed (and therefore notified at most once each).
    """
    try:
        claimed = database.claim_expiring_import_export_quality_waivers(
            cutoff=cutoff, limit=limit
        )
    except Exception:  # noqa: BLE001 - a failed tick retries on the next interval
        logger.warning("quality waiver expiry sweep: claim failed", exc_info=True)
        return 0
    for waiver in claimed:
        notify_lint_waiver_expiring(
            database,
            decision={
                "id": waiver.get("id"),
                "tenant_id": waiver.get("tenant_id"),
                "source_fingerprint": waiver.get("subject_key"),
                "rule_id": waiver.get("format_key"),
                "state": "waived",
                "expires_at": waiver.get("expires_at"),
                "rationale": waiver.get("reason"),
                "linked_ticket": None,
            },
            kind=f"quality:{waiver.get('scope') or 'import'}",
            href="/v1/tenants/{tenant}/governance/quality-waivers",
        )
    if claimed:
        logger.info(
            "quality waiver expiry sweep: notified %d waiver(s)", len(claimed)
        )
    return len(claimed)


def process_lint_waiver_expiry_sweep(
    database: Database,
    *,
    warning_hours: Optional[int] = None,
    limit: int = 50,
) -> int:
    """Claim soon-expiring waivers and notify each one (one sweep tick).

    Covers both waiver ledgers: lint finding decisions (CLX-1.3) and import/export quality
    waivers (IXH-2.3). Each ledger claims independently, so a failure reading one still
    notifies the other.

    Args:
        database: Database handle (a per-thread instance from the startup sweep).
        warning_hours: Warning window before expiry; defaults to
            ``settings.lint_waiver_expiry_warning_hours``.
        limit: Max waivers claimed per tick, per ledger.

    Returns:
        The total number of waivers claimed (and therefore notified at most once each).
    """
    hours = warning_hours if warning_hours is not None else int(
        settings.lint_waiver_expiry_warning_hours
    )
    cutoff = datetime.now(timezone.utc) + timedelta(hours=hours)
    try:
        claimed = database.claim_expiring_lint_waivers(cutoff=cutoff, limit=limit)
    except Exception:  # noqa: BLE001 - a failed tick retries on the next interval
        logger.warning("lint waiver expiry sweep: claim failed", exc_info=True)
        claimed = []
    for decision in claimed:
        notify_lint_waiver_expiring(database, decision=decision)
    if claimed:
        logger.info("lint waiver expiry sweep: notified %d waiver(s)", len(claimed))
    return len(claimed) + _sweep_quality_waivers(database, cutoff=cutoff, limit=limit)
