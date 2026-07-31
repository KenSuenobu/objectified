"""Refresh backoff + auto-pause policy tests (RAR-3.4, #3525).

Pure-function tests over ``app.repository_refresh_backoff`` — the REPO-4.5
multiplier table applied to the refresh loop — plus the config knobs. Covers the
acceptance criteria:
  - consecutive refresh failures back off exponentially (×2 … ×32, hard cap);
  - the auto-pause threshold is configurable (and 0 disables it);
  - the stored per-repo interval is an input only (never mutated here — the
    policy layer has no side effects at all).
"""

import pytest

from app.repository_refresh_backoff import (
    DEFAULT_AUTO_PAUSE_THRESHOLD,
    DEFAULT_MAX_BACKOFF_SECONDS,
    MAX_BACKOFF_EXPONENT,
    compute_refresh_backoff_seconds,
    should_auto_pause,
)

_INTERVAL = 300  # the RAR-3.1 default cadence (~5 min)


# ------------------------------------------------- compute_refresh_backoff_seconds


@pytest.mark.parametrize(
    ("failures", "multiplier"),
    [(0, 1), (1, 2), (2, 4), (3, 8), (4, 16), (5, 32)],
)
def test_multiplier_table_matches_repo_4_5(failures, multiplier):
    """The REPO-4.5 table: ×1, ×2, ×4, ×8, ×16, ×32."""
    assert (
        compute_refresh_backoff_seconds(failures, interval_seconds=_INTERVAL)
        == _INTERVAL * multiplier
    )


@pytest.mark.parametrize("failures", [6, 10, 100, 10_000])
def test_multiplier_caps_at_x32(failures):
    """Beyond 5 consecutive failures the multiplier stays at ×32 (2**5)."""
    assert (
        compute_refresh_backoff_seconds(failures, interval_seconds=_INTERVAL)
        == _INTERVAL * (2 ** MAX_BACKOFF_EXPONENT)
    )


def test_hard_cap_applies():
    """The deferral never exceeds max_seconds (default 7 days)."""
    week = 7 * 24 * 60 * 60
    assert DEFAULT_MAX_BACKOFF_SECONDS == week
    # A one-day interval ×32 would be 32 days; the cap holds it to 7.
    assert (
        compute_refresh_backoff_seconds(5, interval_seconds=24 * 60 * 60) == week
    )
    # An explicit smaller cap wins too.
    assert (
        compute_refresh_backoff_seconds(5, interval_seconds=_INTERVAL, max_seconds=1000)
        == 1000
    )


def test_cap_never_drops_below_one_interval():
    """A cap below the interval is clamped up so the result is >= one interval."""
    assert (
        compute_refresh_backoff_seconds(3, interval_seconds=_INTERVAL, max_seconds=10)
        == _INTERVAL
    )


def test_negative_failures_count_as_zero():
    assert compute_refresh_backoff_seconds(-3, interval_seconds=_INTERVAL) == _INTERVAL


def test_non_positive_interval_clamped_to_one_second():
    assert compute_refresh_backoff_seconds(0, interval_seconds=0) == 1
    assert compute_refresh_backoff_seconds(1, interval_seconds=-5) == 2


def test_huge_failure_count_does_not_overflow():
    """The exponent is capped before the math, so huge counts stay finite ints."""
    result = compute_refresh_backoff_seconds(10**9, interval_seconds=_INTERVAL)
    assert result == min(_INTERVAL * 32, DEFAULT_MAX_BACKOFF_SECONDS)


# ---------------------------------------------------------------- should_auto_pause


def test_default_threshold_matches_repo_4_5():
    """REPO-4.5 pauses after 8 consecutive failures; RAR-3.4 keeps that default."""
    assert DEFAULT_AUTO_PAUSE_THRESHOLD == 8
    assert should_auto_pause(7) is False
    assert should_auto_pause(8) is True
    assert should_auto_pause(9) is True


@pytest.mark.parametrize(
    ("failures", "threshold", "expected"),
    [
        (2, 3, False),
        (3, 3, True),
        (4, 3, True),
        (1, 1, True),
        (0, 1, False),
    ],
)
def test_threshold_boundary(failures, threshold, expected):
    assert should_auto_pause(failures, threshold=threshold) is expected


@pytest.mark.parametrize("threshold", [0, -1, -100])
def test_non_positive_threshold_disables_auto_pause(threshold):
    """threshold <= 0 disables the pause entirely (backoff-only mode)."""
    assert should_auto_pause(10**6, threshold=threshold) is False


# ---------------------------------------------------------------------- config knobs


def test_config_defaults():
    """The knobs exist with the REPO-4.5 defaults: threshold 8, cap 7 days."""
    from app.config import settings

    assert settings.refresh_auto_pause_threshold == 8
    assert settings.refresh_backoff_max_seconds == 7 * 24 * 60 * 60


def test_config_env_aliases():
    """APIOME_REFRESH_AUTO_PAUSE_THRESHOLD / APIOME_REFRESH_BACKOFF_MAX_INTERVAL are honored."""
    from app.config import Settings

    s = Settings(
        APIOME_REFRESH_AUTO_PAUSE_THRESHOLD=3,
        APIOME_REFRESH_BACKOFF_MAX_INTERVAL=3600,
    )
    assert s.refresh_auto_pause_threshold == 3
    assert s.refresh_backoff_max_seconds == 3600
