"""Durable per-tenant quota & rate-limit telemetry (REPO-7.3, #2801).

:mod:`app.repository_polling_telemetry` counts quota events in process memory: exact,
free, and gone on the next restart — and per replica, so no single process ever holds
the tenant's real numbers. That is enough to answer "what is happening right now" and
nothing else. REPO-7.3 is the durable half: the same events, accumulated into a rolling
window table (``apiome.repository_quota_window``, migration V233) that survives restarts,
merges across replicas, and can be asked "what did last Tuesday look like".

Five metrics, in two families:

===================  ======  ===========================================================
Metric               Window  Meaning
===================  ======  ===========================================================
``polls``            hour    Refresh jobs the sweep enqueued — the unit REPO-4.6's
                             ``repository_polls_per_hour`` actually bounds.
``polls_deferred``   hour    Due repositories skipped because the tenant was out of
                             budget. Never a failure: they stay due.
``files_deferred``   hour    Stale files left unenqueued when a tenant's budget ran out
                             part-way through one repository.
``scans``            day     Repository branch scan passes (REPO-2.5), completed or
                             paused on their wall-clock budget.
``bytes_scanned``    day     Bytes of repository content those passes indexed. Stored
                             raw; the dashboard renders MB.
===================  ======  ===========================================================

**A window boundary is the reset.** Nothing zeroes a counter. An increment lands on the
bucket its timestamp falls in, so crossing a boundary simply writes to a different row and
the new window begins at zero. That holds across restarts, across replicas, and across a
tick that straddles the boundary — none of which a "reset the counter" job would survive.

**Deferrals are counted apart from work.** ``polls`` says how much refreshing happened;
``polls_deferred`` / ``files_deferred`` say how much the quota pushed into a later window.
Folding them together would erase the one signal an operator opens this dashboard for.

**Recording never fails a caller.** :func:`record_quota_usage` swallows and logs every
database error. Telemetry that can abort a sweep tick is worse than no telemetry: it turns
an observability problem into a refresh outage.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence

_logger = logging.getLogger(__name__)

#: Refresh jobs enqueued by the sweep (the unit REPO-4.6's quota bounds).
METRIC_POLLS = "polls"
#: Due repositories skipped because their tenant had no polling budget left.
METRIC_POLLS_DEFERRED = "polls_deferred"
#: Stale files left unenqueued when a tenant's budget ran out mid-repository.
METRIC_FILES_DEFERRED = "files_deferred"
#: Repository branch scan passes (REPO-2.5), completed or budget-paused.
METRIC_SCANS = "scans"
#: Bytes of repository content indexed by those scan passes.
METRIC_BYTES_SCANNED = "bytes_scanned"

#: Hourly bucket — matches the REPO-4.6 "polls per hour" quota window.
WINDOW_HOUR = "hour"
#: Daily bucket — scan volume is a daily shape, not an hourly one.
WINDOW_DAY = "day"

#: Bucket width for each metric. Also the metric allow-list: a name absent from this
#: mapping is rejected before it can reach the V233 CHECK constraint as an error.
WINDOW_KIND_BY_METRIC: Mapping[str, str] = {
    METRIC_POLLS: WINDOW_HOUR,
    METRIC_POLLS_DEFERRED: WINDOW_HOUR,
    METRIC_FILES_DEFERRED: WINDOW_HOUR,
    METRIC_SCANS: WINDOW_DAY,
    METRIC_BYTES_SCANNED: WINDOW_DAY,
}

#: Every metric, in the order the dashboard presents them: work first, then what the
#: quota deferred, then scan volume.
ALL_METRICS: Sequence[str] = (
    METRIC_POLLS,
    METRIC_POLLS_DEFERRED,
    METRIC_FILES_DEFERRED,
    METRIC_SCANS,
    METRIC_BYTES_SCANNED,
)

#: The metrics that count deferred work rather than performed work. Surfaced separately
#: in the projection so a caller can style or group them without re-deriving the list.
DEFERRAL_METRICS = frozenset({METRIC_POLLS_DEFERRED, METRIC_FILES_DEFERRED})

#: Unit of a metric's stored ``amount``, for callers that format it.
UNIT_COUNT = "count"
UNIT_BYTES = "bytes"

#: Stored unit per metric. Only ``bytes_scanned`` is not a plain count.
UNIT_BY_METRIC: Mapping[str, str] = {
    metric: (UNIT_BYTES if metric == METRIC_BYTES_SCANNED else UNIT_COUNT)
    for metric in ALL_METRICS
}

#: One line per metric, carried in the projection so the dashboard does not hold a second
#: copy of the vocabulary that could drift from this one.
METRIC_LABELS: Mapping[str, str] = {
    METRIC_POLLS: "Polls",
    METRIC_POLLS_DEFERRED: "Repositories deferred",
    METRIC_FILES_DEFERRED: "Files deferred",
    METRIC_SCANS: "Scans",
    METRIC_BYTES_SCANNED: "Content scanned",
}

METRIC_DESCRIPTIONS: Mapping[str, str] = {
    METRIC_POLLS: (
        "Refresh jobs the auto-refresh sweep enqueued for this tenant. This is the unit "
        "the polling quota bounds."
    ),
    METRIC_POLLS_DEFERRED: (
        "Due repositories the sweep skipped because the tenant had no polling budget left. "
        "They stay due and are picked up once the window rolls — a deferral is never a "
        "failure."
    ),
    METRIC_FILES_DEFERRED: (
        "Stale files left unenqueued because the tenant's budget ran out part-way through a "
        "repository. They stay stale for a later window."
    ),
    METRIC_SCANS: (
        "Repository branch scan passes, counted whether the pass finished or paused on its "
        "wall-clock budget to resume later."
    ),
    METRIC_BYTES_SCANNED: (
        "Repository content indexed by those scan passes. Recorded in bytes; the dashboard "
        "renders megabytes."
    ),
}

#: Trailing days the dashboard requests by default (the REPO-7.3 acceptance criterion).
DEFAULT_TELEMETRY_DAYS = 7
#: Ceiling on a caller-supplied range. Beyond this the read stops being a dashboard query.
MAX_TELEMETRY_DAYS = 90
#: How long counter rows are kept before the retention sweep prunes them. Comfortably
#: longer than :data:`MAX_TELEMETRY_DAYS` so the widest supported read is never truncated
#: by retention.
DEFAULT_RETENTION_DAYS = 120

#: Bytes in one megabyte, for callers rendering :data:`METRIC_BYTES_SCANNED`.
BYTES_PER_MEGABYTE = 1_048_576


def window_kind_for(metric: str) -> str:
    """Return the bucket width one metric accumulates into.

    Args:
        metric: A member of :data:`ALL_METRICS`.

    Returns:
        :data:`WINDOW_HOUR` or :data:`WINDOW_DAY`.

    Raises:
        ValueError: When ``metric`` is not a known metric. Raised rather than defaulted:
            a silently-accepted typo would create a counter nobody ever reads.
    """
    kind = WINDOW_KIND_BY_METRIC.get(metric)
    if kind is None:
        raise ValueError(f"unsupported quota telemetry metric: {metric!r}")
    return kind


def _as_utc(moment: Optional[datetime]) -> datetime:
    """Coerce a moment to an aware UTC datetime, defaulting to now.

    Args:
        moment: The instant to normalize. ``None`` means "now". A naive datetime is read
            as UTC rather than local time, so a caller's timezone can never shift a
            bucket boundary.

    Returns:
        The same instant, timezone-aware in UTC.
    """
    base = moment or datetime.now(timezone.utc)
    if base.tzinfo is None:
        return base.replace(tzinfo=timezone.utc)
    return base.astimezone(timezone.utc)


def floor_to_window(moment: Optional[datetime], window_kind: str) -> datetime:
    """Truncate a moment down to the start of its bucket, in UTC.

    Every writer and every reader derives bucket identity through this one function, so
    "which window is this" has a single answer regardless of who is asking.

    Args:
        moment: The instant to bucket. ``None`` means now.
        window_kind: :data:`WINDOW_HOUR` or :data:`WINDOW_DAY`.

    Returns:
        The bucket's inclusive start, timezone-aware in UTC.

    Raises:
        ValueError: When ``window_kind`` is neither hour nor day.
    """
    base = _as_utc(moment)
    if window_kind == WINDOW_HOUR:
        return base.replace(minute=0, second=0, microsecond=0)
    if window_kind == WINDOW_DAY:
        return base.replace(hour=0, minute=0, second=0, microsecond=0)
    raise ValueError(f"unsupported quota telemetry window kind: {window_kind!r}")


def record_quota_usage(
    db: Any,
    tenant_id: str,
    metric: str,
    amount: int = 1,
    *,
    now: Optional[datetime] = None,
) -> bool:
    """Add ``amount`` to one tenant's counter for the current window.

    Best-effort by contract. Every database error is logged and swallowed, because every
    caller is a sweep tick doing real work: a telemetry write that can raise would let an
    observability problem stop repositories from refreshing.

    A non-positive ``amount`` is a no-op rather than an error — callers pass counts
    straight through (``result.deferred``, a chunk's byte total), and "nothing happened"
    is a legitimate value for those, not a bug worth a stack trace.

    Args:
        db: Database handle exposing ``increment_repository_quota_window``.
        tenant_id: The tenant the usage belongs to.
        metric: A member of :data:`ALL_METRICS`.
        amount: How much to add (default 1). Values ``<= 0`` are ignored.
        now: Clock override for tests; defaults to the current UTC time.

    Returns:
        True when a counter was incremented, False when the call was a no-op or the write
        failed.

    Raises:
        ValueError: When ``metric`` is unknown. This one *is* raised: an unknown metric is
            a programming error at the call site, not a runtime condition, and swallowing
            it would leave a permanently blank series with no diagnostic.
    """
    window_kind = window_kind_for(metric)
    delta = int(amount or 0)
    if delta <= 0:
        return False

    try:
        db.increment_repository_quota_window(
            tenant_id=str(tenant_id),
            metric=metric,
            window_kind=window_kind,
            window_start=floor_to_window(now, window_kind),
            amount=delta,
        )
        return True
    except Exception:
        _logger.warning(
            "repository quota telemetry write failed tenant_id=%s metric=%s amount=%s",
            tenant_id,
            metric,
            delta,
            exc_info=True,
        )
        return False


def resolve_telemetry_days(days: Optional[int]) -> int:
    """Clamp a requested trailing range to something a dashboard read can serve.

    Args:
        days: The caller's requested range in days, or ``None`` for the default.

    Returns:
        A value in ``[1, MAX_TELEMETRY_DAYS]``; :data:`DEFAULT_TELEMETRY_DAYS` when
        ``days`` is ``None`` or unparseable.
    """
    if days is None:
        return DEFAULT_TELEMETRY_DAYS
    try:
        requested = int(days)
    except (TypeError, ValueError):
        return DEFAULT_TELEMETRY_DAYS
    return max(1, min(MAX_TELEMETRY_DAYS, requested))


def _day_keys(end_day: datetime, days: int) -> List[str]:
    """Build the ISO date keys of the trailing ``days`` days, oldest first.

    Args:
        end_day: The most recent day bucket (already floored to a day).
        days: How many days the series spans, including ``end_day``.

    Returns:
        ``days`` ``YYYY-MM-DD`` strings in ascending order.
    """
    start = end_day - timedelta(days=days - 1)
    return [(start + timedelta(days=offset)).date().isoformat() for offset in range(days)]


def _empty_daily_series(day_keys: Sequence[str]) -> Dict[str, int]:
    """Return a zero-filled ``{date: 0}`` map covering every day in the range.

    Pre-filling is what makes a quiet day render as a zero rather than as a gap. A
    sparkline that silently drops missing days redraws the same shape for "steady low
    traffic" and "nothing happened for three days", which is the opposite of the point.

    Args:
        day_keys: The ISO date keys of the range, oldest first.

    Returns:
        A new mapping with every key present and 0.
    """
    return {key: 0 for key in day_keys}


def _project_metric(
    metric: str,
    daily: Mapping[str, int],
    day_keys: Sequence[str],
    current_window: int,
) -> Dict[str, Any]:
    """Shape one metric's daily series into the projection the API returns.

    Args:
        metric: The metric being projected.
        daily: ``{ISO date: total}`` for that metric, already zero-filled.
        day_keys: The range's date keys, oldest first — the series order.
        current_window: The metric's live-bucket value (current hour or today).

    Returns:
        A JSON-serializable mapping describing the metric and its series.
    """
    points = [{"date": key, "value": int(daily.get(key, 0))} for key in day_keys]
    values = [point["value"] for point in points]
    return {
        "metric": metric,
        "label": METRIC_LABELS[metric],
        "description": METRIC_DESCRIPTIONS[metric],
        "window_kind": window_kind_for(metric),
        "unit": UNIT_BY_METRIC[metric],
        "deferral": metric in DEFERRAL_METRICS,
        "points": points,
        "total": sum(values),
        "peak": max(values) if values else 0,
        "current_window": int(current_window),
    }


def describe_quota_telemetry(
    db: Any,
    tenant_id: str,
    *,
    days: Optional[int] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Project one tenant's quota telemetry over a trailing range (REPO-7.3).

    Every metric is reported for every day in the range, including metrics with no stored
    rows at all: a tenant that has never been deferred should see a flat zero line, which
    is a meaningful answer, rather than a missing panel that reads as "unavailable".

    Hourly metrics are summed into their days for the series, and separately reported at
    their live-bucket value in ``current_window`` — the number an operator compares
    against ``polls_per_hour`` right now. Daily metrics report today's bucket there.

    A read failure degrades to an all-zero projection flagged with ``available: False``
    rather than raising: the surrounding page still renders, and the flag says plainly
    that the zeros are absence of data, not absence of activity.

    Args:
        db: Database handle exposing ``list_repository_quota_windows``.
        tenant_id: The tenant to describe.
        days: Trailing range in days; clamped by :func:`resolve_telemetry_days`.
        now: Clock override for tests; defaults to the current UTC time.

    Returns:
        A mapping with ``days``, ``range_start`` / ``range_end`` (ISO 8601), ``available``,
        and ``metrics`` — one projection per member of :data:`ALL_METRICS`, in that order.
    """
    span = resolve_telemetry_days(days)
    clock = _as_utc(now)
    end_day = floor_to_window(clock, WINDOW_DAY)
    range_start = end_day - timedelta(days=span - 1)
    day_keys = _day_keys(end_day, span)

    daily: Dict[str, Dict[str, int]] = {
        metric: _empty_daily_series(day_keys) for metric in ALL_METRICS
    }
    current: Dict[str, int] = {metric: 0 for metric in ALL_METRICS}
    current_bucket = {
        metric: floor_to_window(clock, window_kind_for(metric)) for metric in ALL_METRICS
    }

    available = True
    try:
        rows = db.list_repository_quota_windows(str(tenant_id), since=range_start) or []
    except Exception:
        _logger.warning(
            "repository quota telemetry read failed tenant_id=%s", tenant_id, exc_info=True
        )
        rows = []
        available = False

    for row in rows:
        metric = str(row.get("metric") or "")
        series = daily.get(metric)
        if series is None:
            # A metric this build does not know about (an older or newer schema). Skipping
            # it keeps the dashboard rendering the metrics it does understand.
            continue
        window_start = row.get("window_start")
        if not isinstance(window_start, datetime):
            continue
        bucket = _as_utc(window_start)
        amount = max(0, int(row.get("amount") or 0))

        key = bucket.date().isoformat()
        if key in series:
            series[key] += amount
        if bucket == current_bucket[metric]:
            current[metric] += amount

    return {
        "days": span,
        "range_start": range_start.isoformat(),
        "range_end": end_day.isoformat(),
        "available": available,
        "metrics": [
            _project_metric(metric, daily[metric], day_keys, current[metric])
            for metric in ALL_METRICS
        ],
    }
