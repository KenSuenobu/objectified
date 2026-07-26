"""Async job retention sweep (IXH-6.3, #5122).

The shared ``apiome.async_job`` store (V158) turned a restart-bounded in-memory list into an
unbounded table. This sweep:

1. Reaps expired export artifact *bytes* via :meth:`Database.reap_expired_export_job_artifacts`
   (IXH-6.1 helper — content cleared, row may linger until the job is deleted).
2. Claims terminal job rows past the configured per-(kind, state) retention window under
   ``FOR UPDATE SKIP LOCKED``, writes a slim ``async_job_history`` summary, then deletes the
   live job (CASCADE removes any leftover ``export_job_artifact`` row).
3. Prunes ``async_job_history`` rows older than ``async_job_history_retention_days``.

Exactly-once / multi-instance safety comes from the claim (SKIP LOCKED), not the scheduler —
every instance runs the tick; only one wins each row. Failures log and retry next interval.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

from .config import settings
from .database import Database

logger = logging.getLogger(__name__)

__all__ = [
    "async_job_retention_policies",
    "process_async_job_retention_sweep",
]

# (kind, terminal_state) → settings attribute holding retention hours (0 = keep forever).
_RETENTION_SETTING_KEYS: Tuple[Tuple[str, str, str], ...] = (
    ("export", "completed", "async_job_retention_export_completed_hours"),
    ("export", "failed", "async_job_retention_export_failed_hours"),
    ("export", "canceled", "async_job_retention_export_canceled_hours"),
    ("spec_import", "completed", "async_job_retention_spec_import_completed_hours"),
    ("spec_import", "failed", "async_job_retention_spec_import_failed_hours"),
    ("spec_import", "canceled", "async_job_retention_spec_import_canceled_hours"),
)


def async_job_retention_policies(
    *,
    now: Optional[datetime] = None,
) -> Dict[Tuple[str, str], datetime]:
    """Build ``{(kind, state): cutoff}`` from settings (hours ``<= 0`` are omitted).

    A job is eligible when ``state`` is terminal and ``updated_at <= cutoff`` for its
    ``(kind, state)`` pair.

    Args:
        now: Retention clock base; defaults to UTC now.

    Returns:
        Mapping of enabled (kind, state) pairs to their absolute cutoff timestamps.
    """
    base = now or datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    policies: Dict[Tuple[str, str], datetime] = {}
    for kind, state, attr in _RETENTION_SETTING_KEYS:
        hours = int(getattr(settings, attr))
        if hours <= 0:
            continue
        policies[(kind, state)] = base - timedelta(hours=hours)
    return policies


def process_async_job_retention_sweep(
    database: Database,
    *,
    now: Optional[datetime] = None,
    batch_size: Optional[int] = None,
    history_retention_days: Optional[int] = None,
) -> Dict[str, int]:
    """Run one retention tick: reap artifacts, delete expired jobs, prune history.

    Args:
        database: Per-thread database handle (fresh connection from the startup loop).
        now: Optional clock override for tests.
        batch_size: Max rows per claim/reap/prune step; defaults to
            ``settings.async_job_retention_sweep_batch_size``.
        history_retention_days: History prune window; defaults to
            ``settings.async_job_history_retention_days``. ``<= 0`` skips history prune.

    Returns:
        Counts: ``artifacts_reaped``, ``jobs_deleted``, ``history_pruned``.
    """
    limit = (
        batch_size
        if batch_size is not None
        else max(1, int(settings.async_job_retention_sweep_batch_size))
    )
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        clock = clock.replace(tzinfo=timezone.utc)

    artifacts_reaped = 0
    try:
        artifacts_reaped = int(
            database.reap_expired_export_job_artifacts(now=clock, limit=limit)
        )
    except Exception:  # noqa: BLE001 - a failed tick retries on the next interval
        logger.warning("async job retention sweep: artifact reap failed", exc_info=True)

    jobs_deleted = 0
    policies = async_job_retention_policies(now=clock)
    if policies:
        try:
            deleted = database.reap_expired_async_jobs(
                policies=policies, limit=limit, now=clock
            )
            jobs_deleted = len(deleted)
        except Exception:  # noqa: BLE001
            logger.warning("async job retention sweep: job reap failed", exc_info=True)

    history_pruned = 0
    days = (
        history_retention_days
        if history_retention_days is not None
        else int(settings.async_job_history_retention_days)
    )
    if days > 0:
        try:
            history_pruned = int(
                database.prune_async_job_history(
                    older_than=clock - timedelta(days=days), limit=limit
                )
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "async job retention sweep: history prune failed", exc_info=True
            )

    if artifacts_reaped or jobs_deleted or history_pruned:
        logger.info(
            "async job retention sweep: artifacts_reaped=%d jobs_deleted=%d history_pruned=%d",
            artifacts_reaped,
            jobs_deleted,
            history_pruned,
        )
    return {
        "artifacts_reaped": artifacts_reaped,
        "jobs_deleted": jobs_deleted,
        "history_pruned": history_pruned,
    }
