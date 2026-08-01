"""Per-tenant polling quotas + sweep fairness (REPO-4.6 #2784, RAR-3.5 #3526).

Without a bound, one tenant with many repositories (or a very fast cadence)
monopolizes the refresh sweep and starves every other tenant. This module holds
the three pure pieces the sweep composes:

1. **Round-robin fairness** — :func:`interleave_due_rows_by_tenant` reorders the
   globally oldest-first due list from ``list_due_repositories`` into a
   round-robin across tenants (one repo per tenant per round), so a tenant with
   hundreds of due repos cannot occupy the head of the sweep and push everyone
   else past the tick.

2. **Quota resolution** — :func:`resolve_tenant_polls_per_hour` turns the value
   persisted on ``apiome.tenants.repository_polls_per_hour`` into the effective
   bound for one tenant, applying the configured fallback when the tenant has no
   explicit value and treating ``0`` as *unlimited*.

3. **Windowed quota accounting** — :class:`TenantRefreshQuotaTracker` bounds the
   number of refresh jobs each tenant may enqueue per rolling window. It is
   seeded with the jobs each tenant already enqueued inside the current window (a
   database count) and decremented in memory as the tick enqueues more, so the
   bound holds across ticks, workers restarting mid-window, and multi-repo
   tenants alike.

A tenant that exhausts its quota has its remaining due repos *deferred*: the
sweep skips them without advancing their cadence anchor and without recording a
failure (deferral is a scheduling decision, not an error). The repos stay due
and are picked up by a later tick once the window rolls. Every deferral is
counted in :mod:`app.repository_polling_telemetry` for the REPO-7.3 dashboard.

**Where the number comes from.** REPO-4.6 makes the quota a property of the
*tenant*, persisted on ``apiome.tenants.repository_polls_per_hour`` (default 60;
the elevated/enterprise plan is seeded at 600 by migration V229). ``0`` on that
column means the tenant is explicitly unlimited. Two settings in
:mod:`app.config` remain, and now act on the deployment rather than the tenant:

- ``APIOME_REFRESH_TENANT_QUOTA`` — the fallback bound for tenants whose row
  could not be read, **and** the global kill switch: ``<= 0`` disables quota
  enforcement everywhere (fairness interleaving still applies).
- ``APIOME_REFRESH_TENANT_QUOTA_WINDOW`` — rolling window length in seconds
  (default 3600, i.e. the "per hour" in polls-per-hour).

Manual "Refresh Now" (RAR-5.2) does not run through the sweep and is therefore
never quota-limited, consistent with how the RAR-3.3 kill switch and RAR-3.4
backoff treat the manual path.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

_logger = logging.getLogger(__name__)

#: Default maximum polls (refresh jobs) one tenant may enqueue per window when
#: the tenant has no persisted value and no setting overrides it. Matches the
#: ``apiome.tenants.repository_polls_per_hour`` column default.
DEFAULT_TENANT_QUOTA_JOBS = 60

#: Polls-per-hour seeded for the elevated ("enterprise") plan by migration V229.
#: Exposed here so the application and the migration state the same number, and
#: so callers provisioning an elevated tenant do not re-invent it.
ENTERPRISE_TENANT_QUOTA_JOBS = 600

#: Default rolling quota window in seconds (one hour).
DEFAULT_TENANT_QUOTA_WINDOW_SECONDS = 3600

#: Sentinel returned by :func:`resolve_tenant_polls_per_hour` for a tenant that
#: is explicitly unlimited (``repository_polls_per_hour = 0``).
UNLIMITED: Optional[int] = None


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


def resolve_tenant_polls_per_hour(
    configured: Optional[int],
    *,
    default_quota: int = DEFAULT_TENANT_QUOTA_JOBS,
) -> Optional[int]:
    """Resolve one tenant's effective polls-per-window bound (REPO-4.6).

    The persisted column is authoritative, including the deliberate ``0`` that
    marks a tenant as unlimited. Only an *absent* value — no tenant row, a NULL
    column, or a value the database somehow holds as negative — falls back to
    the deployment default.

    Args:
        configured: The tenant's stored ``repository_polls_per_hour``, or None
            when the tenant has no persisted value. Negative values (which the
            column's CHECK forbids) are treated as unset rather than trusted.
        default_quota: Bound applied when ``configured`` is unset. A
            non-positive default means the deployment has quotas disabled, which
            resolves to unlimited.

    Returns:
        The tenant's bound as a positive integer, or ``None``
        (:data:`UNLIMITED`) when the tenant is not to be quota-limited.
    """
    if configured is None or int(configured) < 0:
        effective = int(default_quota)
    else:
        effective = int(configured)
    return effective if effective > 0 else UNLIMITED


class TenantRefreshQuotaTracker:
    """Tracks each tenant's remaining polling budget for one sweep tick.

    The tracker is seeded with the number of jobs each tenant has already
    enqueued inside the current rolling window (from
    ``count_recent_repository_refresh_jobs_by_tenant``) and consumed in memory
    as the tick enqueues more, so a single tick can never push a tenant past
    the bound no matter how many due repos it has.

    Per-tenant bounds come from ``apiome.tenants.repository_polls_per_hour``
    (REPO-4.6); ``default_quota`` covers tenants absent from that mapping.

    Args:
        default_quota: Bound for tenants with no persisted value. Must be
            positive — a deployment-wide disabled quota is represented by *no
            tracker* (``None``), not by a tracker with a sentinel value.
        used_by_tenant: Jobs already enqueued in the current window, keyed by
            tenant id. Tenants absent from the mapping have used none.
        limits_by_tenant: Persisted ``repository_polls_per_hour`` per tenant.
            A stored ``0`` makes that tenant unlimited; a tenant absent from the
            mapping uses ``default_quota``.

    Raises:
        ValueError: When ``default_quota`` is not positive.
    """

    def __init__(
        self,
        default_quota: int,
        used_by_tenant: Mapping[str, int],
        limits_by_tenant: Optional[Mapping[str, Optional[int]]] = None,
    ) -> None:
        if default_quota <= 0:
            raise ValueError("quota must be positive; disable with a None tracker")
        self._quota = int(default_quota)
        self._used: Dict[str, int] = {
            str(tenant_id): max(0, int(count or 0))
            for tenant_id, count in used_by_tenant.items()
        }
        self._limits: Dict[str, Optional[int]] = {
            str(tenant_id): resolve_tenant_polls_per_hour(
                limit, default_quota=self._quota
            )
            for tenant_id, limit in (limits_by_tenant or {}).items()
        }

    @property
    def quota(self) -> int:
        """The default per-tenant-per-window bound for unconfigured tenants."""
        return self._quota

    def quota_for(self, tenant_id: str) -> Optional[int]:
        """The effective bound for one tenant.

        Args:
            tenant_id: The tenant to look up.

        Returns:
            The tenant's persisted bound, the default when it has none, or
            ``None`` (:data:`UNLIMITED`) when the tenant is explicitly unlimited.
        """
        return self._limits.get(str(tenant_id), self._quota)

    def remaining(self, tenant_id: str) -> Optional[int]:
        """Polls the tenant may still enqueue this window.

        Args:
            tenant_id: The tenant to look up.

        Returns:
            The tenant's remaining budget floored at 0, or ``None`` when the
            tenant is unlimited. ``None`` is what the sweep passes straight
            through as "no ``max_enqueues`` bound".
        """
        limit = self.quota_for(tenant_id)
        if limit is None:
            return None
        return max(0, limit - self._used.get(str(tenant_id), 0))

    def is_exhausted(self, tenant_id: str) -> bool:
        """True when the tenant has no polling budget left this window.

        Args:
            tenant_id: The tenant to check.

        Returns:
            True when :meth:`remaining` is 0. Always False for an unlimited
            tenant.
        """
        remaining = self.remaining(tenant_id)
        return remaining is not None and remaining <= 0

    def consume(self, tenant_id: str, jobs: int) -> None:
        """Record ``jobs`` newly enqueued refresh jobs against the tenant.

        Usage is tracked for unlimited tenants too, so the telemetry and any
        later quota change see the tenant's real volume.

        Args:
            tenant_id: The tenant that enqueued the jobs.
            jobs: Number of jobs enqueued (non-positive values are ignored).
        """
        if jobs <= 0:
            return
        key = str(tenant_id)
        self._used[key] = self._used.get(key, 0) + int(jobs)


def load_tenant_refresh_quota_tracker(db: Any) -> Optional[TenantRefreshQuotaTracker]:
    """Build the quota tracker for one sweep tick from persisted limits + usage.

    Reads the deployment fallback and window from settings, the per-tenant
    ``repository_polls_per_hour`` values (REPO-4.6), and the refresh jobs each
    tenant has already enqueued inside the window.

    Best-effort by contract in two different ways, because the two reads have
    different consequences:

    * A failure to count **window usage** leaves the tracker with no idea how
      much budget is already spent, so enforcing would be arbitrary — the tick
      proceeds unlimited rather than blocking all refresh work.
    * A failure to read the **per-tenant limits** is survivable: every tenant
      simply falls back to the configured default, which still bounds the sweep.

    Args:
        db: Database handle exposing
            ``count_recent_repository_refresh_jobs_by_tenant`` and
            ``list_tenant_repository_polls_per_hour``.

    Returns:
        A seeded :class:`TenantRefreshQuotaTracker`, or ``None`` when quotas are
        disabled deployment-wide (``APIOME_REFRESH_TENANT_QUOTA <= 0``) or the
        window usage could not be read.
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

    limits: Mapping[str, Optional[int]] = {}
    try:
        limits = db.list_tenant_repository_polls_per_hour() or {}
    except Exception:
        # Survivable: the configured default still bounds every tenant.
        _logger.exception(
            "tenant polling quota read failed; sweep falling back to the default quota=%s",
            quota,
        )

    return TenantRefreshQuotaTracker(quota, used or {}, limits)


def describe_tenant_polling_quota(db: Any, tenant_id: str) -> Dict[str, Any]:
    """Project one tenant's polling quota and current window usage (REPO-4.6).

    This is the read the REST surface returns and the REPO-7.3 dashboard renders
    per tenant: the persisted bound, the bound actually being enforced right now
    (which differs when the deployment kill switch is off or the tenant is
    unlimited), and how much of the window the tenant has already spent.

    Window usage is best-effort — a counting failure reports ``0`` used rather
    than failing the read, since an operator asking "what is this tenant's
    quota?" should still get the answer.

    Args:
        db: Database handle exposing ``get_tenant_repository_polls_per_hour``
            and ``count_recent_repository_refresh_jobs_by_tenant``.
        tenant_id: The tenant to describe.

    Returns:
        A mapping with ``polls_per_hour``, ``effective_polls_per_hour``
        (``None`` when unbounded), ``window_seconds``, ``used_this_window``,
        ``remaining_this_window`` (``None`` when unbounded), and ``enforced``.
    """
    from .config import settings

    default_quota = int(settings.refresh_tenant_quota_jobs)
    window_seconds = int(settings.refresh_tenant_quota_window_seconds)
    if window_seconds <= 0:
        window_seconds = DEFAULT_TENANT_QUOTA_WINDOW_SECONDS

    stored = db.get_tenant_repository_polls_per_hour(tenant_id)
    persisted = int(stored) if stored is not None else default_quota

    if default_quota <= 0:
        # Quotas disabled deployment-wide: the stored value is retained and
        # reported, but nothing is being enforced.
        effective = UNLIMITED
    else:
        effective = resolve_tenant_polls_per_hour(stored, default_quota=default_quota)

    try:
        used = int(
            (db.count_recent_repository_refresh_jobs_by_tenant(window_seconds) or {}).get(
                str(tenant_id), 0
            )
        )
    except Exception:
        _logger.exception(
            "tenant polling quota usage count failed tenant_id=%s; reporting 0 used",
            tenant_id,
        )
        used = 0

    return {
        "polls_per_hour": max(0, persisted),
        "effective_polls_per_hour": effective,
        "window_seconds": window_seconds,
        "used_this_window": used,
        "remaining_this_window": (
            None if effective is None else max(0, effective - used)
        ),
        "enforced": effective is not None,
    }
