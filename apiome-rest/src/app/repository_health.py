"""Per-repository health roll-up for the dashboard badge (REPO-6.5, #2798).

The repository surface exposes plenty of individual signals — scan job outcomes,
per-spec quality attempts, the linked account a private repository authenticates
with — but nothing that answers an operator's first question at a glance: *is
this repository fine?* REPO-6.5 collapses those signals into one three-valued
badge rendered on the repository rows (REPO-6.1) and the repository detail header
(REPO-6.2).

Three inputs feed it, exactly as the roadmap specifies:

* **Scan success rate over the last 30 days** — the share of finished scan jobs
  (``apiome.tenant_repository_file_scan_jobs``) that succeeded. This is the
  dominant signal: a repository whose tree cannot be indexed has nothing else
  worth reporting.
* **Parse-error count** — discovered specs on the default branch whose REPO-2.8
  quality attempt errored, or which the attempt could not parse. These are
  per-spec problems, so they degrade a repository rather than break it.
* **Token health (REPO-7.4)** — whether the linked account a ``linked_account``
  repository authenticates with is still connected, still holds an access token,
  and is not expired or about to expire.

Two rules hold regardless of thresholds:

* **Token issues always demote to at least ``warnings``.** Every token factor is
  emitted at ``warnings`` or worse, and :func:`compute_repository_health` clamps
  the roll-up as a belt-and-braces guarantee — a repository Apiome can no longer
  authenticate to is never shown as healthy, however clean its scan history.
* **A repository with no signal at all is healthy.** A freshly registered
  repository has no scans, no scored files and (for a public URL) no token; it
  reads as ``healthy`` rather than manufacturing an alarm out of missing data.

The module is deliberately pure and side-effect free: it takes a
:class:`RepositoryHealthSignals` snapshot — assembled in SQL by
:meth:`Database.get_repository_health_signals` — and returns a
:class:`RepositoryHealth`. Nothing here reads the database, calls a provider, or
raises; a health roll-up must never be able to fail the request that renders it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence

# --- tunables ---------------------------------------------------------------------------
#
# Every threshold below is a named constant so the rules can be read (and tested) without
# reverse-engineering an expression.

#: Trailing window the scan success rate is measured over, in days.
HEALTH_WINDOW_DAYS = 30

#: At or above this share of successful scans in the window, scanning contributes nothing.
SCAN_SUCCESS_HEALTHY_RATE = 0.9

#: Below this share of successful scans in the window, scanning is an ``error``; between the
#: two thresholds it is a ``warnings``.
SCAN_SUCCESS_ERROR_RATE = 0.5

#: Parse errors at or above this count on one branch escalate from ``warnings`` to ``error``:
#: a repository whose specs fail to parse this widely is not usable as an import source.
PARSE_ERROR_ERROR_COUNT = 10

#: Parse-error count at which the parse component of the score reaches zero.
PARSE_ERROR_SATURATION_COUNT = PARSE_ERROR_ERROR_COUNT

#: A token expiring within this many days is a ``warnings`` — enough lead time to re-link.
TOKEN_EXPIRY_WARNING_DAYS = 7

#: Score weights; they sum to 1.0. Scanning dominates because it gates everything else.
SCAN_SCORE_WEIGHT = 0.55
PARSE_SCORE_WEIGHT = 0.25
TOKEN_SCORE_WEIGHT = 0.20


class HealthLevel(str, Enum):
    """The three badge levels, in increasing severity.

    Values are the stable wire/display codes the UI switches on.
    """

    #: Nothing is contributing a problem.
    HEALTHY = "healthy"
    #: At least one degrading factor; the repository still works.
    WARNINGS = "warnings"
    #: At least one factor that makes the repository unusable as an import source.
    ERROR = "error"


#: Severity ranking used to roll factors up to a single level and to break ties.
_LEVEL_RANK: Dict[HealthLevel, int] = {
    HealthLevel.HEALTHY: 0,
    HealthLevel.WARNINGS: 1,
    HealthLevel.ERROR: 2,
}


def level_rank(level: HealthLevel) -> int:
    """Return the severity rank of ``level`` (higher is worse).

    Args:
        level: The level to rank.

    Returns:
        ``0`` for healthy, ``1`` for warnings, ``2`` for error.
    """
    return _LEVEL_RANK[level]


def worst_level(levels: Sequence[HealthLevel]) -> HealthLevel:
    """Return the most severe level in ``levels``.

    Args:
        levels: Levels to roll up; may be empty.

    Returns:
        The most severe level, or :attr:`HealthLevel.HEALTHY` when ``levels`` is empty.
    """
    worst = HealthLevel.HEALTHY
    for lvl in levels:
        if level_rank(lvl) > level_rank(worst):
            worst = lvl
    return worst


class HealthFactorCode(str, Enum):
    """Stable machine codes for the things that can degrade a repository's health.

    The UI keys tooltip copy and iconography off these, so they are part of the API
    contract: add codes, never repurpose one.
    """

    #: Scan success rate over the window is below :data:`SCAN_SUCCESS_ERROR_RATE`.
    SCAN_FAILING = "scan-failing"
    #: Scan success rate is between the error and healthy thresholds.
    SCAN_DEGRADED = "scan-degraded"
    #: Discovered specs on the default branch failed to parse or score.
    PARSE_ERRORS = "parse-errors"
    #: The repository's linked account is no longer connected (REPO-7.4).
    TOKEN_UNLINKED = "token-unlinked"
    #: The linked account is connected but holds no access token (REPO-7.4).
    TOKEN_MISSING = "token-missing"
    #: The access token's expiry has passed (REPO-7.4).
    TOKEN_EXPIRED = "token-expired"
    #: The access token expires within :data:`TOKEN_EXPIRY_WARNING_DAYS` (REPO-7.4).
    TOKEN_EXPIRING = "token-expiring"


#: Codes produced by the token-health axis. Used by the "token issues always demote"
#: clamp, and by tests that must not have to re-list the codes by hand.
TOKEN_FACTOR_CODES = frozenset(
    {
        HealthFactorCode.TOKEN_UNLINKED,
        HealthFactorCode.TOKEN_MISSING,
        HealthFactorCode.TOKEN_EXPIRED,
        HealthFactorCode.TOKEN_EXPIRING,
    }
)


@dataclass(frozen=True)
class HealthFactor:
    """One contributing reason behind a repository's health level.

    Attributes:
        code: Stable machine code (:class:`HealthFactorCode`).
        level: How severely this factor alone rates the repository.
        summary: One-sentence, operator-facing explanation. Safe to render verbatim.
        observed_at: When this factor was most recently observed to be true, when that
            is knowable (the failing scan's finish time, the last errored quality
            attempt, the moment a token expired). ``None`` for factors describing a
            present-tense condition with no event behind it, such as a token that has
            not expired yet — those sort last when picking the most recent factor.
    """

    code: HealthFactorCode
    level: HealthLevel
    summary: str
    observed_at: Optional[datetime] = None


@dataclass(frozen=True)
class RepositoryHealthSignals:
    """Raw per-repository inputs, one snapshot as read from the database.

    Attributes:
        repository_id: The repository these signals belong to.
        scans_attempted: Finished scan jobs (succeeded or failed) in the window.
        scans_succeeded: Of those, how many succeeded.
        last_scan_finished_at: Finish time of the most recent finished scan job.
        last_scan_failed_at: Finish time of the most recent *failed* scan job.
        parse_error_count: Discovered specs on the default branch whose quality attempt
            errored or could not parse the document.
        last_parse_error_at: When the most recent of those attempts ran.
        token_required: True when the repository authenticates through a linked account
            (``source = 'linked_account'``). A public-URL repository needs no token and
            therefore has perfect token health.
        linked_account_present: Whether the linked account row still exists.
        has_access_token: Whether that row still holds a non-empty access token.
        token_expires_at: The access token's expiry, when the provider supplied one.
            ``None`` means "does not expire / unknown", which is not a problem.
    """

    repository_id: str
    scans_attempted: int = 0
    scans_succeeded: int = 0
    last_scan_finished_at: Optional[datetime] = None
    last_scan_failed_at: Optional[datetime] = None
    parse_error_count: int = 0
    last_parse_error_at: Optional[datetime] = None
    token_required: bool = False
    linked_account_present: bool = False
    has_access_token: bool = False
    token_expires_at: Optional[datetime] = None


@dataclass(frozen=True)
class RepositoryHealth:
    """The computed badge for one repository.

    Attributes:
        repository_id: The repository this describes.
        level: The badge level — the most severe contributing factor's level.
        score: 0-100 roll-up of the three weighted components; informational, the level
            is what the badge renders.
        factors: Every contributing factor, most severe first, then most recent first.
            Empty when the repository is healthy.
        primary_factor: The most recently observed contributing factor — what the badge
            tooltip leads with. ``None`` when healthy.
        window_days: The trailing window the scan rate was measured over.
        scans_attempted: Finished scan jobs in the window (echoed for the tooltip).
        scans_succeeded: Of those, how many succeeded.
        scan_success_rate: ``scans_succeeded / scans_attempted``, or ``None`` when no
            scan finished in the window.
        parse_error_count: Parse/scoring errors counted on the default branch.
    """

    repository_id: str
    level: HealthLevel
    score: int
    factors: List[HealthFactor] = field(default_factory=list)
    primary_factor: Optional[HealthFactor] = None
    window_days: int = HEALTH_WINDOW_DAYS
    scans_attempted: int = 0
    scans_succeeded: int = 0
    scan_success_rate: Optional[float] = None
    parse_error_count: int = 0


def _as_aware(value: Optional[datetime]) -> Optional[datetime]:
    """Return ``value`` as a UTC-aware datetime so comparisons never mix tz-awareness.

    Args:
        value: A datetime that may be naive, aware, or ``None``.

    Returns:
        The same instant as a UTC-aware datetime, or ``None``.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _plural(count: int, singular: str, plural: str) -> str:
    """Return ``singular`` or ``plural`` to match ``count``."""
    return singular if count == 1 else plural


def _scan_factor(signals: RepositoryHealthSignals) -> Optional[HealthFactor]:
    """Derive the scan-reliability factor, if any.

    A repository with no finished scan in the window contributes nothing: "never
    scanned" is a lifecycle state (the repository row's own ``status`` says so), not a
    health problem.

    Args:
        signals: The repository's signal snapshot.

    Returns:
        The scan factor, or ``None`` when scans are healthy or absent.
    """
    attempted = max(0, int(signals.scans_attempted or 0))
    if attempted == 0:
        return None
    succeeded = min(attempted, max(0, int(signals.scans_succeeded or 0)))
    rate = succeeded / attempted
    if rate >= SCAN_SUCCESS_HEALTHY_RATE:
        return None

    failed = attempted - succeeded
    observed_at = _as_aware(signals.last_scan_failed_at) or _as_aware(
        signals.last_scan_finished_at
    )
    pct = round(rate * 100)
    detail = (
        f"{failed} of {attempted} {_plural(attempted, 'scan', 'scans')} failed in the last "
        f"{HEALTH_WINDOW_DAYS} days ({pct}% succeeded)."
    )
    if rate < SCAN_SUCCESS_ERROR_RATE:
        return HealthFactor(
            code=HealthFactorCode.SCAN_FAILING,
            level=HealthLevel.ERROR,
            summary=f"Scanning is failing. {detail}",
            observed_at=observed_at,
        )
    return HealthFactor(
        code=HealthFactorCode.SCAN_DEGRADED,
        level=HealthLevel.WARNINGS,
        summary=f"Scanning is unreliable. {detail}",
        observed_at=observed_at,
    )


def _parse_factor(signals: RepositoryHealthSignals) -> Optional[HealthFactor]:
    """Derive the spec parse-error factor, if any.

    Args:
        signals: The repository's signal snapshot.

    Returns:
        The parse-error factor, or ``None`` when no discovered spec failed to parse.
    """
    count = max(0, int(signals.parse_error_count or 0))
    if count == 0:
        return None
    level = HealthLevel.ERROR if count >= PARSE_ERROR_ERROR_COUNT else HealthLevel.WARNINGS
    noun = _plural(count, "spec", "specs")
    return HealthFactor(
        code=HealthFactorCode.PARSE_ERRORS,
        level=level,
        summary=(
            f"{count} discovered {noun} on the default branch could not be parsed or scored."
        ),
        observed_at=_as_aware(signals.last_parse_error_at),
    )


def _token_factor(
    signals: RepositoryHealthSignals,
    now: datetime,
) -> Optional[HealthFactor]:
    """Derive the linked-account token factor, if any (REPO-7.4).

    Only ``linked_account`` repositories have a token to be unhealthy: a public clone
    URL is read anonymously.

    Args:
        signals: The repository's signal snapshot.
        now: The instant to evaluate expiry against (UTC-aware).

    Returns:
        The token factor, or ``None`` when the repository needs no token or its token
        is healthy.
    """
    if not signals.token_required:
        return None
    if not signals.linked_account_present:
        return HealthFactor(
            code=HealthFactorCode.TOKEN_UNLINKED,
            level=HealthLevel.ERROR,
            summary=(
                "The linked account this repository authenticates with is no longer "
                "connected. Re-link the account to resume scanning."
            ),
        )
    if not signals.has_access_token:
        return HealthFactor(
            code=HealthFactorCode.TOKEN_MISSING,
            level=HealthLevel.ERROR,
            summary=(
                "The linked account holds no access token. Re-authorize the account to "
                "resume scanning."
            ),
        )

    expires_at = _as_aware(signals.token_expires_at)
    if expires_at is None:
        return None
    if expires_at <= now:
        return HealthFactor(
            code=HealthFactorCode.TOKEN_EXPIRED,
            level=HealthLevel.ERROR,
            summary=(
                "The linked account's access token has expired. Re-authorize the account "
                "to resume scanning."
            ),
            observed_at=expires_at,
        )
    if expires_at <= now + timedelta(days=TOKEN_EXPIRY_WARNING_DAYS):
        return HealthFactor(
            code=HealthFactorCode.TOKEN_EXPIRING,
            level=HealthLevel.WARNINGS,
            # Deliberately no observed_at: nothing has happened yet, so this must not
            # outrank a factor that actually occurred when picking the most recent one.
            summary=(
                "The linked account's access token expires within "
                f"{TOKEN_EXPIRY_WARNING_DAYS} days. Re-authorize the account to avoid an "
                "interruption."
            ),
        )
    return None


def _scan_component(signals: RepositoryHealthSignals) -> float:
    """Return the 0.0-1.0 scan component of the score (1.0 when nothing was scanned)."""
    attempted = max(0, int(signals.scans_attempted or 0))
    if attempted == 0:
        return 1.0
    succeeded = min(attempted, max(0, int(signals.scans_succeeded or 0)))
    return succeeded / attempted


def _parse_component(signals: RepositoryHealthSignals) -> float:
    """Return the 0.0-1.0 parse component of the score, saturating at the error count."""
    count = max(0, int(signals.parse_error_count or 0))
    if count == 0:
        return 1.0
    return max(0.0, 1.0 - (count / PARSE_ERROR_SATURATION_COUNT))


def _token_component(factor: Optional[HealthFactor]) -> float:
    """Return the 0.0-1.0 token component of the score, derived from the token factor."""
    if factor is None:
        return 1.0
    return 0.5 if factor.level is HealthLevel.WARNINGS else 0.0


def _sort_key_by_severity(factor: HealthFactor) -> tuple:
    """Order factors most severe first, then most recently observed first."""
    observed = factor.observed_at
    return (
        -level_rank(factor.level),
        0 if observed is not None else 1,
        -(observed.timestamp() if observed is not None else 0.0),
        factor.code.value,
    )


def _sort_key_by_recency(factor: HealthFactor) -> tuple:
    """Order factors most recently observed first, then most severe first.

    Factors with no observation time sort last: they describe a standing condition, not
    an event, so they should never be presented as "the most recent" thing that happened.
    """
    observed = factor.observed_at
    return (
        0 if observed is not None else 1,
        -(observed.timestamp() if observed is not None else 0.0),
        -level_rank(factor.level),
        factor.code.value,
    )


def compute_repository_health(
    signals: RepositoryHealthSignals,
    *,
    now: Optional[datetime] = None,
) -> RepositoryHealth:
    """Roll one repository's signals up into a health badge (REPO-6.5).

    The level is the most severe contributing factor's level, with one clamp: a token
    factor always leaves the repository at ``warnings`` or worse, so a repository Apiome
    cannot authenticate to can never read as healthy.

    Args:
        signals: The repository's signal snapshot, as assembled by
            :meth:`Database.get_repository_health_signals`.
        now: The instant to evaluate token expiry against; defaults to the current UTC
            time. Injected by tests so expiry cases are deterministic.

    Returns:
        The computed :class:`RepositoryHealth`, with ``factors`` ordered most severe
        first and ``primary_factor`` set to the most recently observed one.
    """
    evaluated_at = _as_aware(now) or datetime.now(timezone.utc)

    token_factor = _token_factor(signals, evaluated_at)
    factors = [
        f
        for f in (_scan_factor(signals), _parse_factor(signals), token_factor)
        if f is not None
    ]

    level = worst_level([f.level for f in factors])
    # Belt and braces: the token factors are constructed at warnings-or-worse, so this
    # cannot fire today. It is the guarantee itself, expressed once, so a future token
    # factor added at a lower level cannot quietly let a broken credential read healthy.
    if token_factor is not None and level is HealthLevel.HEALTHY:
        level = HealthLevel.WARNINGS

    score = round(
        100.0
        * (
            SCAN_SCORE_WEIGHT * _scan_component(signals)
            + PARSE_SCORE_WEIGHT * _parse_component(signals)
            + TOKEN_SCORE_WEIGHT * _token_component(token_factor)
        )
    )

    ordered = sorted(factors, key=_sort_key_by_severity)
    primary = min(factors, key=_sort_key_by_recency) if factors else None

    attempted = max(0, int(signals.scans_attempted or 0))
    succeeded = min(attempted, max(0, int(signals.scans_succeeded or 0)))
    return RepositoryHealth(
        repository_id=signals.repository_id,
        level=level,
        score=max(0, min(100, int(score))),
        factors=ordered,
        primary_factor=primary,
        window_days=HEALTH_WINDOW_DAYS,
        scans_attempted=attempted,
        scans_succeeded=succeeded,
        scan_success_rate=(succeeded / attempted) if attempted else None,
        parse_error_count=max(0, int(signals.parse_error_count or 0)),
    )


def signals_from_row(row: Dict[str, Any]) -> RepositoryHealthSignals:
    """Adapt one :meth:`Database.get_repository_health_signals` row to signals.

    Every field is read defensively — a row from an older deployment (or a fake in a
    test) may omit any of them — because health must degrade to "no signal", never to an
    exception.

    Args:
        row: One row from the health-signals query.

    Returns:
        The parsed :class:`RepositoryHealthSignals`.
    """

    def _int(key: str) -> int:
        value = row.get(key)
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    def _dt(key: str) -> Optional[datetime]:
        value = row.get(key)
        if isinstance(value, datetime):
            return value
        if isinstance(value, str) and value.strip():
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
        return None

    return RepositoryHealthSignals(
        repository_id=str(row.get("repository_id") or row.get("id") or ""),
        scans_attempted=_int("scans_attempted"),
        scans_succeeded=_int("scans_succeeded"),
        last_scan_finished_at=_dt("last_scan_finished_at"),
        last_scan_failed_at=_dt("last_scan_failed_at"),
        parse_error_count=_int("parse_error_count"),
        last_parse_error_at=_dt("last_parse_error_at"),
        token_required=bool(row.get("token_required")),
        linked_account_present=bool(row.get("linked_account_present")),
        has_access_token=bool(row.get("has_access_token")),
        token_expires_at=_dt("token_expires_at"),
    )


def health_to_payload(health: RepositoryHealth) -> Dict[str, Any]:
    """Project a :class:`RepositoryHealth` to the plain dict the API model consumes.

    Args:
        health: The computed health.

    Returns:
        A JSON-ready dict with ISO-8601 timestamps.
    """

    def _factor(f: HealthFactor) -> Dict[str, Any]:
        return {
            "code": f.code.value,
            "level": f.level.value,
            "summary": f.summary,
            "observed_at": f.observed_at.isoformat() if f.observed_at else None,
        }

    return {
        "level": health.level.value,
        "score": health.score,
        "window_days": health.window_days,
        "scans_attempted": health.scans_attempted,
        "scans_succeeded": health.scans_succeeded,
        "scan_success_rate": health.scan_success_rate,
        "parse_error_count": health.parse_error_count,
        "primary_factor": _factor(health.primary_factor) if health.primary_factor else None,
        "factors": [_factor(f) for f in health.factors],
    }


def health_payloads_for_rows(
    rows: Sequence[Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
) -> Dict[str, Dict[str, Any]]:
    """Compute health payloads for a batch of signal rows, keyed by repository id.

    This is the shape the list endpoint wants: one query, one pass, then a lookup per
    repository row.

    Args:
        rows: Rows from :meth:`Database.get_repository_health_signals`.
        now: Evaluation instant for token expiry; defaults to the current UTC time.

    Returns:
        ``{repository_id: payload}``; repositories whose id could not be read are skipped.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows or []:
        signals = signals_from_row(row)
        if not signals.repository_id:
            continue
        out[signals.repository_id] = health_to_payload(
            compute_repository_health(signals, now=now)
        )
    return out
