"""The per-repository health roll-up (REPO-6.5, #2798).

``compute_repository_health`` is the whole of the badge's meaning: three raw signals in,
one of three levels out, plus the factor a tooltip explains it with. These tests pin the
thresholds, the precedence between the axes, the two invariants the ticket states
outright — token issues never read as healthy, an unobserved repository is healthy — and
the ordering rules that decide which factor the tooltip leads with.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.repository_health import (
    HEALTH_WINDOW_DAYS,
    PARSE_ERROR_ERROR_COUNT,
    SCAN_SUCCESS_ERROR_RATE,
    SCAN_SUCCESS_HEALTHY_RATE,
    TOKEN_EXPIRY_WARNING_DAYS,
    TOKEN_FACTOR_CODES,
    HealthFactor,
    HealthFactorCode,
    HealthLevel,
    RepositoryHealthSignals,
    compute_repository_health,
    health_payloads_for_rows,
    health_to_payload,
    level_rank,
    signals_from_row,
    worst_level,
)

_NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
_REPO = "880e8400-e29b-41d4-a716-446655440003"


def _signals(**overrides) -> RepositoryHealthSignals:
    """A repository with nothing wrong with it; override one axis per test."""
    base = {
        "repository_id": _REPO,
        "scans_attempted": 20,
        "scans_succeeded": 20,
        "last_scan_finished_at": _NOW - timedelta(hours=1),
        "last_scan_failed_at": None,
        "parse_error_count": 0,
        "last_parse_error_at": None,
        "token_required": True,
        "linked_account_present": True,
        "has_access_token": True,
        "token_expires_at": _NOW + timedelta(days=90),
    }
    base.update(overrides)
    return RepositoryHealthSignals(**base)


def _health(**overrides):
    return compute_repository_health(_signals(**overrides), now=_NOW)


def _codes(health) -> set:
    return {f.code for f in health.factors}


# --- the baseline -----------------------------------------------------------------------


def test_a_repository_with_nothing_wrong_is_healthy() -> None:
    health = _health()
    assert health.level is HealthLevel.HEALTHY
    assert health.factors == []
    assert health.primary_factor is None
    assert health.score == 100


def test_a_brand_new_repository_with_no_signal_at_all_is_healthy() -> None:
    """A repository registered a minute ago has no scans and no scored files. Missing
    data must not manufacture an alarm — the row's own status already says "pending"."""
    health = compute_repository_health(
        RepositoryHealthSignals(repository_id=_REPO), now=_NOW
    )
    assert health.level is HealthLevel.HEALTHY
    assert health.scan_success_rate is None
    assert health.score == 100


def test_only_three_levels_exist() -> None:
    """The badge is a three-state signal; a fourth value would have nothing to render."""
    assert {level.value for level in HealthLevel} == {"healthy", "warnings", "error"}


def test_levels_rank_by_severity() -> None:
    assert level_rank(HealthLevel.HEALTHY) < level_rank(HealthLevel.WARNINGS)
    assert level_rank(HealthLevel.WARNINGS) < level_rank(HealthLevel.ERROR)
    assert worst_level([]) is HealthLevel.HEALTHY
    assert worst_level([HealthLevel.WARNINGS, HealthLevel.ERROR]) is HealthLevel.ERROR
    assert worst_level([HealthLevel.HEALTHY, HealthLevel.WARNINGS]) is HealthLevel.WARNINGS


# --- scan success rate ------------------------------------------------------------------


def test_a_clean_scan_history_contributes_nothing() -> None:
    assert _codes(_health(scans_attempted=30, scans_succeeded=30)) == set()


def test_scans_just_below_the_healthy_rate_are_a_warning() -> None:
    """19/20 = 95% is fine; 17/20 = 85% is a warning, not yet an error."""
    assert _codes(_health(scans_attempted=20, scans_succeeded=19)) == set()
    health = _health(scans_attempted=20, scans_succeeded=17)
    assert health.level is HealthLevel.WARNINGS
    assert _codes(health) == {HealthFactorCode.SCAN_DEGRADED}


def test_the_healthy_rate_boundary_is_inclusive() -> None:
    """Exactly at the threshold is healthy, so 90% does not flicker between renders."""
    attempted = 10
    succeeded = int(SCAN_SUCCESS_HEALTHY_RATE * attempted)
    assert _codes(_health(scans_attempted=attempted, scans_succeeded=succeeded)) == set()


def test_fewer_than_half_the_scans_succeeding_is_an_error() -> None:
    health = _health(scans_attempted=10, scans_succeeded=4)
    assert health.level is HealthLevel.ERROR
    assert _codes(health) == {HealthFactorCode.SCAN_FAILING}


def test_the_error_rate_boundary_is_inclusive_of_warnings() -> None:
    """Exactly at the error threshold is still only a warning."""
    attempted = 10
    succeeded = int(SCAN_SUCCESS_ERROR_RATE * attempted)
    health = _health(scans_attempted=attempted, scans_succeeded=succeeded)
    assert health.level is HealthLevel.WARNINGS


def test_a_single_failed_scan_and_nothing_else_reads_as_failing() -> None:
    """A repository whose only scan in 30 days failed cannot be indexed at all."""
    health = _health(
        scans_attempted=1,
        scans_succeeded=0,
        last_scan_failed_at=_NOW - timedelta(minutes=5),
    )
    assert health.level is HealthLevel.ERROR
    assert health.primary_factor is not None
    assert health.primary_factor.code is HealthFactorCode.SCAN_FAILING


def test_the_scan_factor_explains_itself_with_real_numbers() -> None:
    health = _health(scans_attempted=8, scans_succeeded=2)
    summary = health.factors[0].summary
    assert "6 of 8 scans failed" in summary
    assert f"last {HEALTH_WINDOW_DAYS} days" in summary
    assert "25% succeeded" in summary


def test_one_scan_is_described_in_the_singular() -> None:
    health = _health(scans_attempted=1, scans_succeeded=0)
    assert "1 of 1 scan failed" in health.factors[0].summary


def test_the_scan_factor_is_observed_at_the_last_failure() -> None:
    failed_at = _NOW - timedelta(hours=3)
    health = _health(
        scans_attempted=4,
        scans_succeeded=1,
        last_scan_finished_at=_NOW - timedelta(minutes=1),
        last_scan_failed_at=failed_at,
    )
    assert health.factors[0].observed_at == failed_at


def test_the_scan_factor_falls_back_to_the_last_finished_scan() -> None:
    """Older rows may not carry a failure timestamp; the factor still dates itself."""
    finished_at = _NOW - timedelta(hours=6)
    health = _health(
        scans_attempted=4,
        scans_succeeded=1,
        last_scan_finished_at=finished_at,
        last_scan_failed_at=None,
    )
    assert health.factors[0].observed_at == finished_at


def test_more_successes_than_attempts_cannot_push_the_rate_above_one() -> None:
    """Defensive: a miscounted aggregate must not invent a >100% success rate."""
    health = _health(scans_attempted=3, scans_succeeded=9)
    assert health.scan_success_rate == 1.0
    assert health.scans_succeeded == 3
    assert health.level is HealthLevel.HEALTHY


def test_negative_counts_are_floored_at_zero() -> None:
    health = _health(scans_attempted=-5, scans_succeeded=-5, parse_error_count=-2)
    assert health.scans_attempted == 0
    assert health.parse_error_count == 0
    assert health.level is HealthLevel.HEALTHY


# --- parse errors -----------------------------------------------------------------------


def test_no_parse_errors_contribute_nothing() -> None:
    assert _codes(_health(parse_error_count=0)) == set()


def test_a_handful_of_parse_errors_is_a_warning() -> None:
    """Individual unparseable specs degrade a repository; they do not break it."""
    health = _health(parse_error_count=2, last_parse_error_at=_NOW - timedelta(days=1))
    assert health.level is HealthLevel.WARNINGS
    assert _codes(health) == {HealthFactorCode.PARSE_ERRORS}
    assert "2 discovered specs" in health.factors[0].summary


def test_one_parse_error_is_described_in_the_singular() -> None:
    health = _health(parse_error_count=1)
    assert "1 discovered spec on the default branch" in health.factors[0].summary


def test_parse_errors_at_scale_escalate_to_an_error() -> None:
    """When this many specs fail to parse the repository is not usable as a source."""
    health = _health(parse_error_count=PARSE_ERROR_ERROR_COUNT)
    assert health.level is HealthLevel.ERROR
    assert health.factors[0].code is HealthFactorCode.PARSE_ERRORS


def test_just_under_the_parse_escalation_is_still_a_warning() -> None:
    health = _health(parse_error_count=PARSE_ERROR_ERROR_COUNT - 1)
    assert health.level is HealthLevel.WARNINGS


def test_the_parse_factor_is_observed_at_the_last_failed_attempt() -> None:
    at = _NOW - timedelta(days=4)
    health = _health(parse_error_count=3, last_parse_error_at=at)
    assert health.factors[0].observed_at == at


# --- token health (REPO-7.4) ------------------------------------------------------------


def test_a_public_url_repository_has_no_token_to_be_unhealthy() -> None:
    """A public clone URL is read anonymously; there is nothing to expire."""
    health = _health(
        token_required=False,
        linked_account_present=False,
        has_access_token=False,
        token_expires_at=None,
    )
    assert health.level is HealthLevel.HEALTHY
    assert health.score == 100


def test_a_disconnected_linked_account_is_an_error() -> None:
    health = _health(linked_account_present=False, has_access_token=False)
    assert health.level is HealthLevel.ERROR
    assert _codes(health) == {HealthFactorCode.TOKEN_UNLINKED}


def test_a_linked_account_with_no_access_token_is_an_error() -> None:
    health = _health(has_access_token=False)
    assert health.level is HealthLevel.ERROR
    assert _codes(health) == {HealthFactorCode.TOKEN_MISSING}


def test_an_expired_token_is_an_error_dated_at_its_expiry() -> None:
    expired_at = _NOW - timedelta(hours=2)
    health = _health(token_expires_at=expired_at)
    assert health.level is HealthLevel.ERROR
    assert health.factors[0].code is HealthFactorCode.TOKEN_EXPIRED
    assert health.factors[0].observed_at == expired_at


def test_a_token_expiring_within_the_lead_time_is_a_warning() -> None:
    health = _health(
        token_expires_at=_NOW + timedelta(days=TOKEN_EXPIRY_WARNING_DAYS - 1)
    )
    assert health.level is HealthLevel.WARNINGS
    assert _codes(health) == {HealthFactorCode.TOKEN_EXPIRING}


def test_a_token_expiring_beyond_the_lead_time_contributes_nothing() -> None:
    health = _health(
        token_expires_at=_NOW + timedelta(days=TOKEN_EXPIRY_WARNING_DAYS + 1)
    )
    assert health.level is HealthLevel.HEALTHY


def test_a_token_that_never_expires_contributes_nothing() -> None:
    """A GitHub PAT with no expiry reports no ``token_expires_at``; that is not a problem."""
    assert _health(token_expires_at=None).level is HealthLevel.HEALTHY


def test_a_naive_expiry_timestamp_is_read_as_utc() -> None:
    """Some drivers hand back naive datetimes; comparing them must not raise."""
    health = _health(token_expires_at=(_NOW - timedelta(days=1)).replace(tzinfo=None))
    assert health.level is HealthLevel.ERROR
    assert health.factors[0].code is HealthFactorCode.TOKEN_EXPIRED


@pytest.mark.parametrize(
    "overrides",
    [
        {"linked_account_present": False, "has_access_token": False},
        {"has_access_token": False},
        {"token_expires_at": _NOW - timedelta(minutes=1)},
        {"token_expires_at": _NOW + timedelta(days=1)},
    ],
    ids=["unlinked", "no-token", "expired", "expiring"],
)
def test_a_token_issue_always_demotes_at_least_to_warnings(overrides) -> None:
    """The ticket's hard rule: a repository Apiome cannot authenticate to is never green,
    however spotless its scan history and however clean its specs."""
    health = _health(scans_attempted=50, scans_succeeded=50, parse_error_count=0, **overrides)
    assert health.level is not HealthLevel.HEALTHY
    assert _codes(health) & TOKEN_FACTOR_CODES


def test_every_token_factor_is_emitted_at_warnings_or_worse() -> None:
    """The clamp above is belt and braces; this is the property that makes it redundant."""
    for overrides in (
        {"linked_account_present": False},
        {"has_access_token": False},
        {"token_expires_at": _NOW - timedelta(days=1)},
        {"token_expires_at": _NOW + timedelta(days=1)},
    ):
        for factor in _health(**overrides).factors:
            if factor.code in TOKEN_FACTOR_CODES:
                assert level_rank(factor.level) >= level_rank(HealthLevel.WARNINGS)


# --- roll-up, ordering and the tooltip factor -------------------------------------------


def test_the_level_is_the_worst_contributing_factor() -> None:
    health = _health(
        scans_attempted=10,
        scans_succeeded=2,
        parse_error_count=1,
        token_expires_at=_NOW + timedelta(days=1),
    )
    assert health.level is HealthLevel.ERROR
    assert len(health.factors) == 3


def test_factors_are_listed_most_severe_first() -> None:
    health = _health(
        scans_attempted=10,
        scans_succeeded=2,
        parse_error_count=1,
        last_parse_error_at=_NOW - timedelta(minutes=1),
    )
    assert [f.level for f in health.factors] == [HealthLevel.ERROR, HealthLevel.WARNINGS]


def test_the_primary_factor_is_the_most_recently_observed_one() -> None:
    """The tooltip leads with what most recently happened, not with what is worst — an
    operator wants to know what changed."""
    health = _health(
        scans_attempted=10,
        scans_succeeded=2,
        last_scan_failed_at=_NOW - timedelta(days=9),
        parse_error_count=1,
        last_parse_error_at=_NOW - timedelta(minutes=30),
    )
    assert health.level is HealthLevel.ERROR
    assert health.primary_factor is not None
    assert health.primary_factor.code is HealthFactorCode.PARSE_ERRORS


def test_a_factor_with_no_observation_time_never_wins_the_tooltip() -> None:
    """"Token expires soon" has not happened yet; a scan that actually failed has."""
    health = _health(
        scans_attempted=10,
        scans_succeeded=2,
        last_scan_failed_at=_NOW - timedelta(days=20),
        token_expires_at=_NOW + timedelta(days=1),
    )
    assert health.primary_factor is not None
    assert health.primary_factor.code is HealthFactorCode.SCAN_FAILING


def test_the_most_severe_undated_factor_wins_when_nothing_is_dated() -> None:
    health = _health(
        scans_attempted=0,
        scans_succeeded=0,
        last_scan_finished_at=None,
        linked_account_present=False,
    )
    assert health.primary_factor is not None
    assert health.primary_factor.code is HealthFactorCode.TOKEN_UNLINKED


def test_the_primary_factor_is_always_one_of_the_listed_factors() -> None:
    health = _health(scans_attempted=10, scans_succeeded=2, parse_error_count=4)
    assert health.primary_factor in health.factors


# --- score ------------------------------------------------------------------------------


def test_the_score_falls_with_the_scan_rate() -> None:
    clean = _health().score
    degraded = _health(scans_attempted=10, scans_succeeded=5).score
    broken = _health(scans_attempted=10, scans_succeeded=0).score
    assert clean > degraded > broken


def test_the_score_falls_with_parse_errors_and_saturates() -> None:
    assert _health(parse_error_count=1).score > _health(parse_error_count=5).score
    floor = _health(parse_error_count=PARSE_ERROR_ERROR_COUNT).score
    assert _health(parse_error_count=PARSE_ERROR_ERROR_COUNT * 10).score == floor


def test_the_score_falls_with_token_health() -> None:
    expiring = _health(token_expires_at=_NOW + timedelta(days=1)).score
    expired = _health(token_expires_at=_NOW - timedelta(days=1)).score
    assert 100 > expiring > expired


def test_the_score_stays_inside_zero_to_one_hundred() -> None:
    worst = _health(
        scans_attempted=10,
        scans_succeeded=0,
        parse_error_count=500,
        linked_account_present=False,
        has_access_token=False,
    )
    assert worst.score == 0
    assert _health().score == 100


# --- row adaptation and payload projection ----------------------------------------------


def test_signals_are_read_from_a_database_row() -> None:
    row = {
        "repository_id": _REPO,
        "scans_attempted": 9,
        "scans_succeeded": 3,
        "last_scan_finished_at": _NOW,
        "last_scan_failed_at": _NOW,
        "parse_error_count": 2,
        "last_parse_error_at": _NOW,
        "token_required": True,
        "linked_account_present": True,
        "has_access_token": True,
        "token_expires_at": _NOW + timedelta(days=30),
    }
    signals = signals_from_row(row)
    assert signals.repository_id == _REPO
    assert signals.scans_attempted == 9
    assert signals.parse_error_count == 2
    assert signals.token_required is True


def test_iso_timestamps_from_a_row_are_parsed() -> None:
    signals = signals_from_row(
        {"repository_id": _REPO, "last_parse_error_at": "2026-07-30T10:00:00Z"}
    )
    assert signals.last_parse_error_at == datetime(
        2026, 7, 30, 10, 0, 0, tzinfo=timezone.utc
    )


def test_an_unreadable_row_degrades_to_no_signal_rather_than_raising() -> None:
    """Health decorates a listing; a malformed row must never fail the request."""
    signals = signals_from_row(
        {
            "repository_id": _REPO,
            "scans_attempted": "not-a-number",
            "last_parse_error_at": "not-a-date",
            "token_expires_at": None,
        }
    )
    assert signals.scans_attempted == 0
    assert signals.last_parse_error_at is None
    assert compute_repository_health(signals, now=_NOW).level is HealthLevel.HEALTHY


def test_the_payload_is_json_ready() -> None:
    payload = health_to_payload(_health(parse_error_count=3, last_parse_error_at=_NOW))
    assert payload["level"] == "warnings"
    assert payload["primary_factor"]["code"] == "parse-errors"
    assert payload["primary_factor"]["observed_at"] == _NOW.isoformat()
    assert isinstance(payload["factors"], list)
    assert payload["parse_error_count"] == 3


def test_a_healthy_payload_carries_no_factors() -> None:
    payload = health_to_payload(_health())
    assert payload["level"] == "healthy"
    assert payload["primary_factor"] is None
    assert payload["factors"] == []


def test_a_batch_of_rows_is_keyed_by_repository_id() -> None:
    other = "990e8400-e29b-41d4-a716-446655440007"
    payloads = health_payloads_for_rows(
        [
            {"repository_id": _REPO, "scans_attempted": 4, "scans_succeeded": 0},
            {"repository_id": other, "scans_attempted": 4, "scans_succeeded": 4},
        ],
        now=_NOW,
    )
    assert set(payloads) == {_REPO, other}
    assert payloads[_REPO]["level"] == "error"
    assert payloads[other]["level"] == "healthy"


def test_a_row_without_an_id_is_skipped_rather_than_keyed_on_empty_string() -> None:
    assert health_payloads_for_rows([{"scans_attempted": 4}], now=_NOW) == {}


def test_an_empty_batch_is_an_empty_mapping() -> None:
    assert health_payloads_for_rows([], now=_NOW) == {}


def test_factors_are_immutable_value_objects() -> None:
    """Callers project factors into responses; one must not be able to edit another's."""
    factor = HealthFactor(
        code=HealthFactorCode.PARSE_ERRORS, level=HealthLevel.WARNINGS, summary="x"
    )
    with pytest.raises(Exception):
        factor.summary = "y"  # type: ignore[misc]
