"""Repository polling-quota telemetry (REPO-4.6, #2784).

The per-tenant polling quota is only useful if operators can *see* it working:
which tenants are being deferred, how often, and whether the deferrals are a
brief burst or a tenant permanently parked against its ceiling. This module is
the counter surface REPO-7.3 renders.

It deliberately mirrors :mod:`app.analysis_telemetry`: a single thread-safe,
in-process registry of integer counters plus one structured log line per event.
Counters are per-replica and reset on restart — this is operational visibility,
not a metrics backend.

Three event kinds are recorded, all emitted by the auto-refresh sweep
(:mod:`app.repository_refresh_sweep`):

* ``poll_dispatched`` — a due repository passed the quota check and its branches
  were polled; carries the jobs it enqueued.
* ``repository_deferred`` — a due repository was skipped *before* its lock was
  taken because its tenant had no quota left this window.
* ``files_deferred`` — a repository was polled but ran out of tenant budget
  part-way through, leaving stale files unenqueued.

A deferral is a scheduling decision, never a failure: nothing here feeds the
RAR-3.4 backoff / auto-pause bookkeeping, and the ``*_deferred`` counters are
deliberately named for what happened rather than borrowing failure vocabulary.

Per-tenant breakdowns are bounded (:data:`MAX_TRACKED_TENANTS`); once the map is
full, further tenants aggregate into the :data:`OVERFLOW_TENANT_KEY` bucket so a
deployment with very many tenants cannot grow this registry without limit. The
aggregate (all-tenant) counters are always exact.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from typing import Any, Dict, Optional

from .logging_config import get_logger

_log = get_logger("app.repository_polling_telemetry")

#: A due repository was polled (its tenant was inside its quota).
KIND_POLL_DISPATCHED = "poll_dispatched"
#: A due repository was skipped because its tenant's quota was exhausted.
KIND_REPOSITORY_DEFERRED = "repository_deferred"
#: A polled repository left stale files unenqueued when the budget ran out.
KIND_FILES_DEFERRED = "files_deferred"

#: Every kind the registry accepts. Anything else is a programming error.
ALLOWED_METRIC_KINDS = frozenset(
    {KIND_POLL_DISPATCHED, KIND_REPOSITORY_DEFERRED, KIND_FILES_DEFERRED}
)

#: Maximum tenants held in the per-tenant breakdown before overflow bucketing.
MAX_TRACKED_TENANTS = 1000

#: Bucket that absorbs tenants beyond :data:`MAX_TRACKED_TENANTS`.
OVERFLOW_TENANT_KEY = "__overflow__"


class RepositoryPollingTelemetry:
    """Thread-safe in-process polling-quota counters + structured log emitter.

    Attributes are private; read the state through :meth:`snapshot`, which
    returns a plain, JSON-serializable copy safe to hand to a REST response.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._totals: Dict[str, int] = defaultdict(int)
        self._by_tenant: Dict[str, Dict[str, int]] = {}

    def reset(self) -> None:
        """Clear every counter (used by unit tests and by an operator reset)."""
        with self._lock:
            self._totals.clear()
            self._by_tenant.clear()

    def snapshot(self) -> Dict[str, Any]:
        """Return the current counters as a plain, JSON-serializable mapping.

        Returns:
            A mapping with two keys:

            * ``totals`` — kind → count across all tenants (always exact).
            * ``by_tenant`` — tenant id → {kind → count}, bounded to
              :data:`MAX_TRACKED_TENANTS` entries plus the
              :data:`OVERFLOW_TENANT_KEY` bucket.
        """
        with self._lock:
            return {
                "totals": dict(self._totals),
                "by_tenant": {
                    tenant_id: dict(counts)
                    for tenant_id, counts in self._by_tenant.items()
                },
            }

    def _tenant_bucket(self, tenant_id: str) -> Dict[str, int]:
        """Return the counter map for a tenant, overflowing when the map is full.

        Must be called with the lock held.

        Args:
            tenant_id: The tenant to look up.

        Returns:
            The tenant's own counter map, or the shared overflow bucket once
            :data:`MAX_TRACKED_TENANTS` distinct tenants are already tracked.
        """
        existing = self._by_tenant.get(tenant_id)
        if existing is not None:
            return existing
        if len(self._by_tenant) >= MAX_TRACKED_TENANTS:
            return self._by_tenant.setdefault(OVERFLOW_TENANT_KEY, defaultdict(int))
        created: Dict[str, int] = defaultdict(int)
        self._by_tenant[tenant_id] = created
        return created

    def record(
        self,
        kind: str,
        *,
        tenant_id: str,
        repository_id: Optional[str] = None,
        quota: Optional[int] = None,
        remaining: Optional[int] = None,
        jobs: int = 0,
        n: int = 1,
    ) -> None:
        """Increment the counters for one quota event and log it.

        Args:
            kind: A member of :data:`ALLOWED_METRIC_KINDS`.
            tenant_id: The tenant the event belongs to.
            repository_id: The repository involved, when the event is about one.
            quota: The tenant's effective polls-per-window bound, when known.
                ``None`` means the tenant is unlimited.
            remaining: The tenant's budget left after the event, when known.
            jobs: Refresh jobs enqueued (``poll_dispatched``) or stale files left
                unenqueued (``files_deferred``). Accumulated into a
                ``<kind>_jobs`` counter so a dashboard can chart volume, not just
                event frequency.
            n: How many times to increment the kind counter (default 1).

        Raises:
            ValueError: When ``kind`` is not a member of
                :data:`ALLOWED_METRIC_KINDS`.
        """
        if kind not in ALLOWED_METRIC_KINDS:
            raise ValueError(f"unsupported polling telemetry kind: {kind!r}")
        if n < 1:
            return

        tenant_key = str(tenant_id)
        job_count = max(0, int(jobs or 0))

        with self._lock:
            self._totals[kind] += n
            bucket = self._tenant_bucket(tenant_key)
            bucket[kind] = bucket.get(kind, 0) + n
            if job_count:
                jobs_key = f"{kind}_jobs"
                self._totals[jobs_key] += job_count
                bucket[jobs_key] = bucket.get(jobs_key, 0) + job_count

        payload: Dict[str, Any] = {"kind": kind, "tenant_id": tenant_key, "n": n}
        if repository_id is not None:
            payload["repository_id"] = str(repository_id)
        if quota is not None:
            payload["quota"] = int(quota)
        if remaining is not None:
            payload["remaining"] = int(remaining)
        if job_count:
            payload["jobs"] = job_count

        # Deferral is a routine scheduling outcome, so it logs at INFO — an
        # operator watching for errors must not see quota pressure as one.
        _log.info("repository.polling.quota", **payload)


#: Process-wide polling-quota telemetry registry.
polling_telemetry = RepositoryPollingTelemetry()
