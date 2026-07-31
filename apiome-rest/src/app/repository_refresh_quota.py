"""Per-tenant refresh quotas + sweep fairness (RAR-3.5, #3526).

Extends the REPO-4.6 per-tenant polling-quota concept to the auto-refresh loop:
without a bound, one tenant with many repositories (or a very fast cadence)
could monopolize the refresh sweep and starve every other tenant. This module
holds the two pure pieces the sweep composes:

1. **Round-robin fairness** — :func:`interleave_due_rows_by_tenant` reorders the
   globally oldest-first due list from ``list_due_repositories`` into a
   round-robin across tenants (one repo per tenant per round), so a tenant with
   hundreds of due repos cannot occupy the head of the sweep and push everyone
   else past the tick.

2. **Windowed quota accounting** — :class:`TenantRefreshQuotaTracker` bounds
   the number of refresh jobs a tenant may enqueue per rolling window. It is
   seeded with the jobs each tenant already enqueued inside the current window
   (a database count) and decremented in memory as the tick enqueues more, so
   the bound holds across ticks, workers restarting mid-window, and multi-repo
   tenants alike.

A tenant that exhausts its quota has its remaining due repos *deferred*: the
sweep skips them without advancing their cadence anchor and without recording a
failure (deferral is a scheduling decision, not an error — matching the
REPO-4.6 rule that a quota deferral never counts against the repo). The repos
stay due and are picked up by a later tick once the window rolls.

Both knobs are configured in :mod:`app.config`:

- ``APIOME_REFRESH_TENANT_QUOTA`` — max refresh jobs per tenant per window
  (default 60; ``<= 0`` disables the quota entirely, fairness interleaving
  still applies).
- ``APIOME_REFRESH_TENANT_QUOTA_WINDOW`` — rolling window length in seconds
  (default 3600).

Manual "Refresh Now" (RAR-5.2) does not run through the sweep and is therefore
never quota-limited, consistent with how the RAR-3.3 kill switch and RAR-3.4
backoff treat the manual path.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

_logger = logging.getLogger(__name__)

#: Default maximum refresh jobs one tenant may enqueue per window when the
#: setting is absent (mirrors the REPO-4.6 default of 60 polls/hour).
DEFAULT_TENANT_QUOTA_JOBS = 60

#: Default rolling quota window in seconds (one hour).
DEFAULT_TENANT_QUOTA_WINDOW_SECONDS = 3600


def interleave_due_rows_by_tenant(
    rows: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reorder due-repository rows into a round-robin across tenants.

    The input order (oldest ``last_refreshed_at`` first, from
    ``list_due_repositories``) is preserved *within* each tenant, and tenants
    take turns in order of their first appearance: round one takes each
    tenant's most-overdue repo, round two the next, and so on. With a single
    tenant (or an empty list) the input order is returned unchanged.

    Args:
        rows: Due-repository rows, each carrying a ``tenant_id`` key.

    Returns:
        A new list containing the same rows, round-robin interleaved by tenant.
    """
    by_tenant: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        by_tenant.setdefault(str(row.get("tenant_id")), []).append(row)
    if len(by_tenant) <= 1:
        return list(rows)

    interleaved: List[Dict[str, Any]] = []
    queues = list(by_tenant.values())
    depth = 0
    while len(interleaved) < len(rows):
        for queue in queues:
            if depth < len(queue):
                interleaved.append(queue[depth])
        depth += 1
    return interleaved


class TenantRefreshQuotaTracker:
    """Tracks each tenant's remaining refresh-job budget for one sweep tick.

    The tracker is seeded with the number of jobs each tenant has already
    enqueued inside the current rolling window (from
    ``count_recent_repository_refresh_jobs_by_tenant``) and consumed in memory
    as the tick enqueues more, so a single tick can never push a tenant past
    the bound no matter how many due repos it has.

    Args:
        quota: Maximum refresh jobs per tenant per window. Must be positive —
            a disabled quota is represented by *no tracker* (``None``), not by
            a tracker with a sentinel value.
        used_by_tenant: Jobs already enqueued in the current window, keyed by
            tenant id. Tenants absent from the mapping have used none.
    """

    def __init__(self, quota: int, used_by_tenant: Mapping[str, int]) -> None:
        if quota <= 0:
            raise ValueError("quota must be positive; disable with a None tracker")
        self._quota = int(quota)
        self._used: Dict[str, int] = {
            str(tenant_id): max(0, int(count or 0))
            for tenant_id, count in used_by_tenant.items()
        }

    @property
    def quota(self) -> int:
        """The per-tenant-per-window job bound this tracker enforces."""
        return self._quota

    def remaining(self, tenant_id: str) -> int:
        """Refresh jobs the tenant may still enqueue this window (never < 0).

        Args:
            tenant_id: The tenant to look up.

        Returns:
            The tenant's remaining budget, floored at 0.
        """
        return max(0, self._quota - self._used.get(str(tenant_id), 0))

    def is_exhausted(self, tenant_id: str) -> bool:
        """True when the tenant has no refresh-job budget left this window.

        Args:
            tenant_id: The tenant to check.

        Returns:
            True when :meth:`remaining` is 0 for the tenant.
        """
        return self.remaining(tenant_id) <= 0

    def consume(self, tenant_id: str, jobs: int) -> None:
        """Record ``jobs`` newly enqueued refresh jobs against the tenant.

        Args:
            tenant_id: The tenant that enqueued the jobs.
            jobs: Number of jobs enqueued (non-positive values are ignored).
        """
        if jobs <= 0:
            return
        key = str(tenant_id)
        self._used[key] = self._used.get(key, 0) + int(jobs)


def load_tenant_refresh_quota_tracker(db: Any) -> Optional[TenantRefreshQuotaTracker]:
    """Build the quota tracker for one sweep tick from settings + window usage.

    Reads the configured per-tenant quota and window, then counts the refresh
    jobs each tenant has already enqueued inside the window. Best-effort by
    contract: the quota is a protective bound, so a failure to count (for
    example a transient database error) is logged and the tick proceeds
    *unlimited* rather than blocking all refresh work.

    Args:
        db: Database handle exposing
            ``count_recent_repository_refresh_jobs_by_tenant``.

    Returns:
        A seeded :class:`TenantRefreshQuotaTracker`, or ``None`` when the
        quota is disabled (``APIOME_REFRESH_TENANT_QUOTA <= 0``) or the window
        usage could not be read.
    """
    from .config import settings

    quota = int(settings.refresh_tenant_quota_jobs)
    if quota <= 0:
        return None

    window_seconds = int(settings.refresh_tenant_quota_window_seconds)
    if window_seconds <= 0:
        window_seconds = DEFAULT_TENANT_QUOTA_WINDOW_SECONDS

    try:
        used = db.count_recent_repository_refresh_jobs_by_tenant(window_seconds)
    except Exception:
        _logger.exception(
            "tenant refresh quota usage count failed; sweep proceeding unlimited"
        )
        return None
    return TenantRefreshQuotaTracker(quota, used or {})
