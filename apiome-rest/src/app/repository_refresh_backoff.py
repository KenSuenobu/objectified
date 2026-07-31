"""Refresh backoff + auto-pause policy for repository auto-refresh (RAR-3.4, #3525).

A repeatedly failing refresh (bad credentials, malformed spec, provider outage)
would hammer the provider and the importer every interval. This module extends the
REPO-4.5 (#2783) poll backoff/auto-pause policy to the refresh loop::

    fail → backoff x2 → … → after N fails → PAUSE (notify, require manual resume)

It is the pure, side-effect-free policy layer (like the sibling RAR-3.1
:mod:`app.repository_refresh_cadence`): the DAO
(:meth:`app.database.Database.record_repository_refresh_failure`) computes the
deferral here and stamps ``refresh_backoff_until`` / ``refresh_paused_at``; the
sweep and the REST surface only read those columns.

The multiplier table matches REPO-4.5's specification — the repository's effective
refresh interval is multiplied, and its stored ``refresh_interval_seconds`` is
**never** mutated::

    consecutive_failures ──► interval multiplier
    ─────────────────────    ───────────────────
              0                × 1   (normal)
              1                × 2
              2                × 4
              3                × 8
              4                × 16
              5+               × 32  (hard cap: APIOME_REFRESH_BACKOFF_MAX_INTERVAL,
                                      default 7 days)

After ``APIOME_REFRESH_AUTO_PAUSE_THRESHOLD`` (default 8) consecutive failures the
repository auto-pauses: it is excluded from due-selection, a RAR-5.4 notification
fires, and only a manual resume clears the pause.

This intentionally does not reuse :func:`app.mcp_discovery_backoff.compute_backoff_seconds`:
that policy grows from a fixed base (``base * 2**(n-1)``) with a ``Retry-After``
floor, while REPO-4.5 multiplies the *per-repo interval* with a bounded ×32
multiplier — different curves for different contracts.
"""

from __future__ import annotations

#: Cap on the exponent so the multiplier tops out at ×32 (2**5), per REPO-4.5.
MAX_BACKOFF_EXPONENT = 5

#: Default consecutive-failure count that trips the auto-pause (REPO-4.5: 8).
DEFAULT_AUTO_PAUSE_THRESHOLD = 8

#: Default hard cap on the computed deferral (REPO-4.5: 7 days).
DEFAULT_MAX_BACKOFF_SECONDS = 7 * 24 * 60 * 60


def compute_refresh_backoff_seconds(
    consecutive_failures: int,
    *,
    interval_seconds: int,
    max_seconds: int = DEFAULT_MAX_BACKOFF_SECONDS,
) -> int:
    """Compute how long to defer the next refresh after consecutive failures.

    The deferral is the repository's effective interval times an exponential
    multiplier: ``interval_seconds * 2 ** min(consecutive_failures, 5)``, clamped
    to ``max_seconds``. Zero (or negative) failures yield the plain interval — the
    normal cadence — so callers may apply this unconditionally.

    Args:
        consecutive_failures: Back-to-back failed refresh ticks *including* the one
            just recorded (1 on the first failure). Values below 0 count as 0.
        interval_seconds: The repository's effective refresh interval (already
            resolved through the RAR-3.1 default + floor); clamped up to 1.
        max_seconds: Hard ceiling on the deferral; clamped to at least
            ``interval_seconds`` so the result is never below one interval.

    Returns:
        The deferral in whole seconds, ``interval_seconds <= result <= max(cap, interval)``.
    """
    interval = max(1, int(interval_seconds))
    ceiling = max(interval, int(max_seconds))
    exponent = min(max(0, int(consecutive_failures)), MAX_BACKOFF_EXPONENT)
    return min(interval * (2 ** exponent), ceiling)


def should_auto_pause(
    consecutive_failures: int,
    *,
    threshold: int = DEFAULT_AUTO_PAUSE_THRESHOLD,
) -> bool:
    """Return whether the failure count has tripped the auto-pause threshold.

    Args:
        consecutive_failures: Back-to-back failed refresh ticks *including* the one
            just recorded.
        threshold: Failure count at which the repository pauses. A value of 0 or
            below disables auto-pause entirely (the repo backs off forever but is
            never paused), mirroring the MCAT-5.3 quarantine-threshold contract.

    Returns:
        ``True`` when ``threshold > 0`` and ``consecutive_failures >= threshold``.
    """
    return threshold > 0 and int(consecutive_failures) >= int(threshold)
