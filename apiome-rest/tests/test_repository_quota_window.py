"""Rolling-window quota telemetry policy (REPO-7.3, #2801).

The whole feature rests on three claims that live in
:mod:`app.repository_quota_window` rather than in SQL: that a window boundary is the
reset (nothing zeroes a counter), that a telemetry write can never take a sweep tick
down with it, and that a metric with no rows still renders as zeros rather than as a
hole. These tests pin all three, plus the bucketing arithmetic both the writer and the
reader derive window identity from.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest

from app.repository_quota_window import (
    ALL_METRICS,
    BYTES_PER_MEGABYTE,
    DEFAULT_TELEMETRY_DAYS,
    DEFERRAL_METRICS,
    MAX_TELEMETRY_DAYS,
    METRIC_BYTES_SCANNED,
    METRIC_FILES_DEFERRED,
    METRIC_POLLS,
    METRIC_POLLS_DEFERRED,
    METRIC_SCANS,
    UNIT_BYTES,
    UNIT_COUNT,
    WINDOW_DAY,
    WINDOW_HOUR,
    describe_quota_telemetry,
    floor_to_window,
    record_quota_usage,
    resolve_telemetry_days,
    window_kind_for,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_NOW = datetime(2026, 7, 31, 14, 37, 12, 500_000, tzinfo=timezone.utc)


class _RecordingDb:
    """Captures increments and replays canned rows, standing in for the DAO."""

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None) -> None:
        self.increments: List[Dict[str, Any]] = []
        self.reads: List[Any] = []
        self._rows = rows or []

    def increment_repository_quota_window(self, **kwargs: Any) -> None:
        self.increments.append(kwargs)

    def list_repository_quota_windows(
        self, tenant_id: str, since: datetime
    ) -> List[Dict[str, Any]]:
        self.reads.append((tenant_id, since))
        return list(self._rows)


class _BrokenDb:
    """Every DAO call fails, the way a database outage presents to this module."""

    def increment_repository_quota_window(self, **kwargs: Any) -> None:
        raise RuntimeError("connection refused")

    def list_repository_quota_windows(self, *args: Any, **kwargs: Any) -> List[Any]:
        raise RuntimeError("connection refused")


def _row(metric: str, window_start: datetime, amount: int) -> Dict[str, Any]:
    return {
        "metric": metric,
        "window_kind": window_kind_for(metric),
        "window_start": window_start,
        "amount": amount,
    }


def _metric(projection: Dict[str, Any], metric: str) -> Dict[str, Any]:
    return next(m for m in projection["metrics"] if m["metric"] == metric)


# --- the metric vocabulary ---------------------------------------------------------------


def test_polling_metrics_bucket_on_the_hour_the_quota_is_enforced_in() -> None:
    """REPO-4.6 bounds polls per hour; a daily poll bucket would be uncomparable to it."""
    assert window_kind_for(METRIC_POLLS) == WINDOW_HOUR
    assert window_kind_for(METRIC_POLLS_DEFERRED) == WINDOW_HOUR
    assert window_kind_for(METRIC_FILES_DEFERRED) == WINDOW_HOUR


def test_scan_volume_buckets_daily() -> None:
    assert window_kind_for(METRIC_SCANS) == WINDOW_DAY
    assert window_kind_for(METRIC_BYTES_SCANNED) == WINDOW_DAY


def test_an_unknown_metric_is_rejected_rather_than_bucketed_somewhere() -> None:
    """A typo that quietly created a sixth counter would show up as a permanently flat
    line on a metric that is in fact being recorded — under a different name."""
    with pytest.raises(ValueError):
        window_kind_for("polls_per_hour")


def test_deferral_metrics_are_marked_apart_from_work_performed() -> None:
    assert DEFERRAL_METRICS == {METRIC_POLLS_DEFERRED, METRIC_FILES_DEFERRED}
    assert METRIC_POLLS not in DEFERRAL_METRICS


def test_a_megabyte_is_the_binary_one_the_dashboard_divides_by() -> None:
    assert BYTES_PER_MEGABYTE == 1024 * 1024


# --- bucketing ---------------------------------------------------------------------------


def test_an_hour_bucket_starts_on_the_hour() -> None:
    assert floor_to_window(_NOW, WINDOW_HOUR) == datetime(
        2026, 7, 31, 14, 0, 0, tzinfo=timezone.utc
    )


def test_a_day_bucket_starts_at_midnight_utc() -> None:
    assert floor_to_window(_NOW, WINDOW_DAY) == datetime(
        2026, 7, 31, 0, 0, 0, tzinfo=timezone.utc
    )


def test_a_naive_timestamp_is_read_as_utc_not_as_local_time() -> None:
    """A writer in a non-UTC process must not land its counter in a different bucket from
    every other replica."""
    naive = _NOW.replace(tzinfo=None)
    assert floor_to_window(naive, WINDOW_HOUR) == floor_to_window(_NOW, WINDOW_HOUR)


def test_a_non_utc_timestamp_is_converted_before_it_is_truncated() -> None:
    """Truncating first and converting after would put 23:30-04:00 in the wrong UTC day."""
    other_zone = _NOW.astimezone(timezone(timedelta(hours=-4)))
    assert floor_to_window(other_zone, WINDOW_DAY) == floor_to_window(_NOW, WINDOW_DAY)


def test_an_unknown_window_kind_is_rejected() -> None:
    with pytest.raises(ValueError):
        floor_to_window(_NOW, "week")


def test_crossing_a_boundary_selects_a_different_bucket() -> None:
    """This *is* the reset: no counter is zeroed, the next write simply lands elsewhere."""
    before = floor_to_window(datetime(2026, 7, 31, 14, 59, 59, tzinfo=timezone.utc), WINDOW_HOUR)
    after = floor_to_window(datetime(2026, 7, 31, 15, 0, 0, tzinfo=timezone.utc), WINDOW_HOUR)
    assert before != after


# --- recording ---------------------------------------------------------------------------


def test_a_recorded_metric_lands_in_its_own_bucket_width() -> None:
    db = _RecordingDb()
    record_quota_usage(db, _TENANT, METRIC_SCANS, 1, now=_NOW)
    assert db.increments == [
        {
            "tenant_id": _TENANT,
            "metric": METRIC_SCANS,
            "window_kind": WINDOW_DAY,
            "window_start": datetime(2026, 7, 31, 0, 0, tzinfo=timezone.utc),
            "amount": 1,
        }
    ]


def test_recording_reports_that_it_wrote() -> None:
    db = _RecordingDb()
    assert record_quota_usage(db, _TENANT, METRIC_POLLS, 3, now=_NOW) is True


@pytest.mark.parametrize("amount", [0, -1])
def test_a_non_positive_amount_writes_nothing(amount: int) -> None:
    """Callers pass counts straight through — `result.deferred` is 0 on almost every tick,
    and that is a fact about the world, not a bug worth a row or a stack trace."""
    db = _RecordingDb()
    assert record_quota_usage(db, _TENANT, METRIC_FILES_DEFERRED, amount, now=_NOW) is False
    assert db.increments == []


def test_a_write_failure_is_swallowed_so_a_sweep_tick_survives_it() -> None:
    """Telemetry that can raise turns an observability problem into a refresh outage."""
    assert record_quota_usage(_BrokenDb(), _TENANT, METRIC_POLLS, 5, now=_NOW) is False


def test_an_unknown_metric_still_raises_at_the_call_site() -> None:
    """Unlike a write failure, this is a programming error: swallowing it would leave a
    permanently blank series and no diagnostic anywhere."""
    with pytest.raises(ValueError):
        record_quota_usage(_RecordingDb(), _TENANT, "polls_per_second", 1, now=_NOW)


# --- range resolution --------------------------------------------------------------------


def test_the_default_range_is_the_week_the_dashboard_shows() -> None:
    assert resolve_telemetry_days(None) == DEFAULT_TELEMETRY_DAYS == 7


@pytest.mark.parametrize(
    "requested,expected", [(0, 1), (-5, 1), (MAX_TELEMETRY_DAYS + 1, MAX_TELEMETRY_DAYS)]
)
def test_a_range_outside_the_supported_span_is_clamped(requested: int, expected: int) -> None:
    assert resolve_telemetry_days(requested) == expected


def test_an_unparseable_range_falls_back_to_the_default() -> None:
    assert resolve_telemetry_days("lots") == DEFAULT_TELEMETRY_DAYS  # type: ignore[arg-type]


# --- the projection ----------------------------------------------------------------------


def test_every_metric_is_reported_even_with_no_stored_rows() -> None:
    """A tenant that has never been deferred should see a flat zero line — a real answer —
    rather than a missing panel that reads as "unavailable"."""
    projection = describe_quota_telemetry(_RecordingDb(), _TENANT, now=_NOW)
    assert [m["metric"] for m in projection["metrics"]] == list(ALL_METRICS)
    assert all(m["total"] == 0 for m in projection["metrics"])


def test_the_series_covers_every_day_in_the_range_oldest_first() -> None:
    projection = describe_quota_telemetry(_RecordingDb(), _TENANT, days=7, now=_NOW)
    dates = [p["date"] for p in _metric(projection, METRIC_POLLS)["points"]]
    assert len(dates) == 7
    assert dates == sorted(dates)
    assert dates[-1] == "2026-07-31"
    assert dates[0] == "2026-07-25"


def test_a_quiet_day_inside_the_range_is_a_zero_not_a_gap() -> None:
    """A sparkline that drops missing days draws the same shape for "steady low traffic"
    and "nothing happened for three days"."""
    today = floor_to_window(_NOW, WINDOW_HOUR)
    db = _RecordingDb([_row(METRIC_POLLS, today, 9)])
    points = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_POLLS)["points"]
    assert [p["value"] for p in points] == [0, 0, 0, 0, 0, 0, 9]


def test_hourly_buckets_are_summed_into_their_day() -> None:
    hour = floor_to_window(_NOW, WINDOW_HOUR)
    db = _RecordingDb(
        [
            _row(METRIC_POLLS, hour, 4),
            _row(METRIC_POLLS, hour - timedelta(hours=1), 6),
            _row(METRIC_POLLS, hour - timedelta(hours=2), 1),
        ]
    )
    polls = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_POLLS)
    assert polls["points"][-1]["value"] == 11
    assert polls["total"] == 11


def test_the_live_bucket_is_reported_apart_from_the_day_it_belongs_to() -> None:
    """"42 polls today" and "42 polls this hour" are different answers, and only the
    second one is comparable to pollsPerHour."""
    hour = floor_to_window(_NOW, WINDOW_HOUR)
    db = _RecordingDb(
        [_row(METRIC_POLLS, hour, 4), _row(METRIC_POLLS, hour - timedelta(hours=3), 30)]
    )
    polls = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_POLLS)
    assert polls["current_window"] == 4
    assert polls["points"][-1]["value"] == 34


def test_a_daily_metrics_live_bucket_is_today() -> None:
    day = floor_to_window(_NOW, WINDOW_DAY)
    db = _RecordingDb([_row(METRIC_SCANS, day, 12), _row(METRIC_SCANS, day - timedelta(days=1), 5)])
    scans = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_SCANS)
    assert scans["current_window"] == 12
    assert scans["total"] == 17


def test_a_row_older_than_the_range_does_not_leak_into_the_series() -> None:
    """The DAO bounds the read, but a widened window elsewhere must not silently inflate
    the oldest day."""
    stale = floor_to_window(_NOW, WINDOW_DAY) - timedelta(days=40)
    db = _RecordingDb([_row(METRIC_POLLS, stale, 999)])
    polls = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_POLLS)
    assert polls["total"] == 0


def test_the_read_is_bounded_by_the_start_of_the_oldest_day() -> None:
    db = _RecordingDb()
    describe_quota_telemetry(db, _TENANT, days=7, now=_NOW)
    _, since = db.reads[0]
    assert since == datetime(2026, 7, 25, 0, 0, tzinfo=timezone.utc)


def test_the_peak_is_the_largest_single_day_not_the_total() -> None:
    day = floor_to_window(_NOW, WINDOW_DAY)
    db = _RecordingDb(
        [_row(METRIC_SCANS, day, 3), _row(METRIC_SCANS, day - timedelta(days=1), 11)]
    )
    scans = _metric(describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_SCANS)
    assert scans["peak"] == 11
    assert scans["total"] == 14


def test_bytes_are_reported_raw_and_declared_as_bytes() -> None:
    """Rounding to MB in the projection would make a 400 KB day indistinguishable from an
    idle one. The unit says what to divide by; the dashboard divides."""
    day = floor_to_window(_NOW, WINDOW_DAY)
    db = _RecordingDb([_row(METRIC_BYTES_SCANNED, day, 3 * BYTES_PER_MEGABYTE)])
    bytes_metric = _metric(
        describe_quota_telemetry(db, _TENANT, now=_NOW), METRIC_BYTES_SCANNED
    )
    assert bytes_metric["unit"] == UNIT_BYTES
    assert bytes_metric["total"] == 3 * BYTES_PER_MEGABYTE


def test_every_other_metric_is_a_plain_count() -> None:
    projection = describe_quota_telemetry(_RecordingDb(), _TENANT, now=_NOW)
    counts = [m["unit"] for m in projection["metrics"] if m["metric"] != METRIC_BYTES_SCANNED]
    assert set(counts) == {UNIT_COUNT}


def test_a_metric_this_build_does_not_know_is_skipped_not_fatal() -> None:
    """A newer schema (or a rolled-back deploy) must not blank the metrics that do work."""
    day = floor_to_window(_NOW, WINDOW_DAY)
    db = _RecordingDb(
        [
            {
                "metric": "api_calls",
                "window_kind": WINDOW_DAY,
                "window_start": day,
                "amount": 7,
            },
            _row(METRIC_SCANS, day, 2),
        ]
    )
    projection = describe_quota_telemetry(db, _TENANT, now=_NOW)
    assert [m["metric"] for m in projection["metrics"]] == list(ALL_METRICS)
    assert _metric(projection, METRIC_SCANS)["total"] == 2


def test_a_row_with_no_usable_timestamp_is_skipped() -> None:
    db = _RecordingDb([{"metric": METRIC_SCANS, "window_start": None, "amount": 4}])
    projection = describe_quota_telemetry(db, _TENANT, now=_NOW)
    assert _metric(projection, METRIC_SCANS)["total"] == 0


def test_a_failed_read_reports_zeros_and_says_they_are_unavailable() -> None:
    """The surrounding page still renders, and the flag is what stops "no data" being
    reported to an operator as "no activity"."""
    projection = describe_quota_telemetry(_BrokenDb(), _TENANT, now=_NOW)
    assert projection["available"] is False
    assert all(m["total"] == 0 for m in projection["metrics"])
    assert len(projection["metrics"]) == len(ALL_METRICS)


def test_a_successful_read_is_marked_available() -> None:
    assert describe_quota_telemetry(_RecordingDb(), _TENANT, now=_NOW)["available"] is True


def test_the_range_is_reported_back_so_a_caller_need_not_re_derive_it() -> None:
    projection = describe_quota_telemetry(_RecordingDb(), _TENANT, days=3, now=_NOW)
    assert projection["days"] == 3
    assert projection["range_start"].startswith("2026-07-29")
    assert projection["range_end"].startswith("2026-07-31")


def test_every_metric_carries_the_vocabulary_a_dashboard_would_otherwise_duplicate() -> None:
    """A second copy of the labels in the UI is a second thing to keep in step."""
    for metric in describe_quota_telemetry(_RecordingDb(), _TENANT, now=_NOW)["metrics"]:
        assert metric["label"]
        assert metric["description"]
        assert metric["window_kind"] in {WINDOW_HOUR, WINDOW_DAY}
