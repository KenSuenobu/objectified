"""Quality-rank telemetry and grade drift over revisions — IXH-2.7 (#5102).

Grades already exist everywhere a document is graded: the import pre-flight (IXH-2.1) scores a
candidate, a committed import captures the score onto its revision (MFI-4.2), the export
pre-flight (IXH-2.4) ranks targets by readiness, and the delivery gate (IXH-2.5) judges a
delivery. What did **not** exist was any view *across* those events — so nobody could see that a
team's imports have been trending downward, or that one format consistently grades low, which is
as likely to be an **adapter gap** as a spec problem.

This module is that series. It has three parts, and they are deliberately separate:

1. **Attribution** (:func:`attribute_rule_hits`) — pure. Splits a lint report's rule hits into
   findings the *adapter* is answerable for and findings the *specification* is answerable for,
   so an adapter-suppressed grade is distinguishable from a genuinely poor spec.
2. **Recording** (:func:`record_observation` and the four ``observe_*`` helpers) — the only part
   that writes. Every call is **best-effort**: a telemetry fault must never fail an import, an
   export, or a pre-flight, so every write is wrapped and logged rather than raised.
3. **Aggregation** (:func:`build_quality_rank_series`) — pure. Rows in, one per-format series
   out, ready for the lint workspace surface.

Attribution, in detail
----------------------
A finding is **adapter-attributable** when it describes something *apiome's intake* could not do
with the source, not something wrong with the source. Today exactly one rule family qualifies:
the MFI-29.4 intake rules (``intake.*``), which fire when an external ``$ref`` was never resolved
or was refused — the model is incomplete because the adapter left a hole in it. Everything else
is **spec-attributable** and is classed by the rule id's namespace (``documentation``,
``naming``, ``security``, …), which is the same namespace the GOV-1.2 rule registry uses, so the
breakdown needs no second vocabulary and no registry read.

An adapter's *declared* parser limits (:data:`~app.import_preview_manifest.KNOWN_PARSER_LIMITS`,
IXH-3.1) are recorded alongside as :attr:`QualityRankObservation.declared_parser_limits` and are
**never** folded into the finding counts: a declaration says "this adapter does not read X yet",
which is evidence about the adapter but is not a finding anybody raised about this document.
Mixing the two would inflate an adapter's finding tally with facts that have nothing to do with
the document being graded.

Bounded growth
--------------
Observations are events, so they accrue with traffic. Two bounds keep the table proportional to
the window that is actually served rather than to the age of the deployment:

* **Retention** — :func:`prune_quality_rank_observations` deletes rows older than
  ``settings.quality_rank_retention_days`` (default 180). It runs on the IXH-6.3 retention
  sweep tick, which is already the deployment's retention worker.
* **Write caps** — an export pre-flight ranks every registered target (30-odd), so only the top
  :data:`EXPORT_PREFLIGHT_RANK_SAMPLE` ranked targets are recorded, and unavailable targets
  (which are not gradable at all) are skipped entirely.

The read API caps its own window at :data:`MAX_WINDOW_DAYS` and its format count at
:data:`MAX_SERIES_FORMATS`, and states truncation rather than silently dropping rows.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

__all__ = [
    "ADAPTER_ATTRIBUTION",
    "ATTRIBUTION_INTAKE_RESOLUTION",
    "EXPORT_PREFLIGHT_RANK_SAMPLE",
    "GRADES",
    "MAX_SERIES_FORMATS",
    "MAX_WINDOW_DAYS",
    "OUTCOMES",
    "SPEC_ATTRIBUTION",
    "STAGE_COMMITTED",
    "STAGE_PREFLIGHT",
    "QualityRankObservation",
    "attribute_rule_hits",
    "build_quality_rank_series",
    "declared_parser_limit_count",
    "load_quality_rank_observations",
    "observe_delivery",
    "observe_export_preflight",
    "observe_import_commit",
    "observe_import_preflight",
    "outcome_for_band",
    "outcome_for_verdict",
    "prune_quality_rank_observations",
    "record_observation",
]

# --- Vocabularies ---------------------------------------------------------------------------

#: Which half of the pipeline produced a grade.
SCOPE_IMPORT = "import"
SCOPE_EXPORT = "export"

#: A predicted grade (nothing was committed) versus one recorded for work that happened.
STAGE_PREFLIGHT = "preflight"
STAGE_COMMITTED = "committed"

#: The two attribution sides of the breakdown.
ADAPTER_ATTRIBUTION = "adapter"
SPEC_ATTRIBUTION = "spec"

#: The adapter-attributable class for intake rules that left the model incomplete (MFI-29.4).
ATTRIBUTION_INTAKE_RESOLUTION = "intake-resolution"

#: Rule-id namespaces whose findings are the *adapter's* doing, mapped to their breakdown class.
#: Additive: a future adapter-emitted rule family joins this table rather than growing a branch.
_ADAPTER_RULE_NAMESPACES: Mapping[str, str] = {
    "intake": ATTRIBUTION_INTAKE_RESOLUTION,
}

#: Class used for a finding whose rule id carries no namespace at all.
_UNNAMESPACED_CLASS = "other"

#: Letter grades, best first — the grade-distribution key order.
GRADES: Tuple[str, ...] = ("A", "B", "C", "D", "F")

#: Distribution bucket for an observation that produced no grade at all.
UNGRADED = "ungraded"

#: Gate outcomes an observation can record.
OUTCOMES: Tuple[str, ...] = ("pass", "warn", "block", "error")

#: Export readiness bands that are worth recording (``unavailable`` targets are not gradable).
_RECORDED_BANDS: Tuple[str, ...] = ("ready", "caution", "blocked")

#: How many of an export pre-flight's ranked targets are recorded per run. The ranking is
#: readiness-ordered, so the head of it is both the part a user acts on and the part that carries
#: the readiness signal; recording all 30-odd targets per pre-flight would grow the series with
#: rows nobody reads.
EXPORT_PREFLIGHT_RANK_SAMPLE = 5

#: Widest window :func:`build_quality_rank_series` will aggregate, in days.
MAX_WINDOW_DAYS = 180

#: Most formats one series response describes; the rest are dropped and the response says so.
MAX_SERIES_FORMATS = 24

#: Hard cap on rows one series read pulls, so a busy tenant cannot make the read unbounded.
MAX_SERIES_ROWS = 20000


# --- Attribution ----------------------------------------------------------------------------


def _rule_namespace(rule_id: str) -> str:
    """The namespace segment of a rule id (``documentation.foo`` -> ``documentation``)."""
    text = str(rule_id or "").strip()
    if not text:
        return _UNNAMESPACED_CLASS
    head = text.split(".", 1)[0].strip()
    return head or _UNNAMESPACED_CLASS


def attribute_rule_hits(
    rule_hits: Optional[Mapping[str, int]],
) -> Tuple[Dict[str, Dict[str, int]], int, int]:
    """Split a lint report's rule hits into adapter- and spec-attributable classes.

    Pure and total: an unknown rule id is spec-attributable by construction, because a rule this
    module does not recognise describes the document (every rule pack does) unless it was
    explicitly declared an intake rule. Defaulting the *other* way would blame the adapter for
    every new rule anybody adds.

    Args:
        rule_hits: ``{rule id: finding count}`` from a :class:`~app.import_source.LintReport`.

    Returns:
        ``(breakdown, adapter_total, spec_total)`` where ``breakdown`` is
        ``{"adapter": {class: count}, "spec": {class: count}}`` with empty sides omitted, and the
        totals are the summed finding counts on each side.
    """
    adapter: Dict[str, int] = {}
    spec: Dict[str, int] = {}
    for rule_id, raw_count in (rule_hits or {}).items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        namespace = _rule_namespace(rule_id)
        adapter_class = _ADAPTER_RULE_NAMESPACES.get(namespace)
        if adapter_class is not None:
            adapter[adapter_class] = adapter.get(adapter_class, 0) + count
        else:
            spec[namespace] = spec.get(namespace, 0) + count

    breakdown: Dict[str, Dict[str, int]] = {}
    if adapter:
        breakdown[ADAPTER_ATTRIBUTION] = dict(sorted(adapter.items()))
    if spec:
        breakdown[SPEC_ATTRIBUTION] = dict(sorted(spec.items()))
    return breakdown, sum(adapter.values()), sum(spec.values())


def declared_parser_limit_count(adapter_key: Optional[str]) -> int:
    """How many parser limits an adapter *declares* it does not read yet (IXH-3.1).

    Read from :data:`app.import_preview_manifest.KNOWN_PARSER_LIMITS`, the repository's single
    declaration table, so a limit fixed there stops being reported here in the same change. The
    import is deferred (that module pulls the whole import pipeline) and a failure degrades to
    ``0`` — telemetry never justifies an import cost.

    Args:
        adapter_key: The adapter registry key, or ``None``.

    Returns:
        The number of declared limits; ``0`` when the adapter declares none.
    """
    key = str(adapter_key or "").strip().lower()
    if not key:
        return 0
    try:
        from .import_preview_manifest import KNOWN_PARSER_LIMITS
    except Exception:  # noqa: BLE001 - telemetry must not fail on an import cycle/absence
        logger.debug("declared parser limits unavailable", exc_info=True)
        return 0
    return len(KNOWN_PARSER_LIMITS.get(key, ()))


def outcome_for_verdict(verdict: Optional[str], *, gradable: bool = True) -> str:
    """Map a policy verdict onto the recorded gate outcome.

    Args:
        verdict: ``pass`` | ``warn`` | ``block``, or ``None`` when no policy was evaluated.
        gradable: False when the candidate never produced a grade at all, which is recorded as
            ``error`` — a distinct fact from "graded and passed".

    Returns:
        One of :data:`OUTCOMES`.
    """
    if not gradable:
        return "error"
    text = str(verdict or "pass").strip().lower()
    return text if text in OUTCOMES else "pass"


def outcome_for_band(band: Optional[str]) -> str:
    """Map an export readiness band onto the recorded gate outcome."""
    text = str(band or "").strip().lower()
    if text == "ready":
        return "pass"
    if text == "caution":
        return "warn"
    if text == "blocked":
        return "block"
    return "error"


# --- The observation ------------------------------------------------------------------------


@dataclass
class QualityRankObservation:
    """One recorded grade, ready to persist.

    A plain record rather than a Pydantic model: it is written, never returned over the API, and
    keeping it dependency-free lets the recording helpers be unit-tested without a database.

    Attributes:
        tenant_id: Tenant the observation belongs to.
        scope: ``import`` | ``export``.
        stage: ``preflight`` | ``committed``.
        outcome: What the gate decided (:data:`OUTCOMES`).
        format_key: Source format (import) or target format (export).
        adapter_key: Adapter registry key (import) or emitter/target key (export).
        project_id: Owning artifact/project, when the subject had one.
        version_record_id: The graded revision, when the subject was one.
        style_guide_id: Style guide that scored the report (``None`` for the fallback guide).
        style_guide_fingerprint: That guide's content hash — the value that changes a score.
        style_guide_source: ``builtin`` | ``custom`` | ``fallback``.
        policy_version_id: Quality policy version in force (``None`` for the default).
        policy_content_fingerprint: That policy's content fingerprint.
        verdict: The policy verdict, when one was evaluated.
        blocking: Whether the verdict refused the operation.
        score: 0-100 lint score, or ``None`` when ungradable.
        grade: A-F lint grade, or ``None`` when ungradable.
        report_fingerprint: Fingerprint of the lint report behind the grade.
        error_count: Error-severity findings.
        warning_count: Warning-severity findings.
        info_count: Info-severity findings.
        adapter_finding_count: Findings attributable to the adapter.
        spec_finding_count: Findings attributable to the specification.
        attribution: ``{"adapter": {class: count}, "spec": {class: count}}``.
        declared_parser_limits: The adapter's declared parser-limit count (not findings).
        readiness: Export readiness composite, export only.
        rank: 1-based rank in the export pre-flight ranking, export only.
        band: Export readiness band, export only.
        preserved_percent: Projected preserved-construct percentage, when measured.
    """

    tenant_id: str
    scope: str
    stage: str
    outcome: str
    format_key: Optional[str] = None
    adapter_key: Optional[str] = None
    project_id: Optional[str] = None
    version_record_id: Optional[str] = None
    style_guide_id: Optional[str] = None
    style_guide_fingerprint: Optional[str] = None
    style_guide_source: Optional[str] = None
    policy_version_id: Optional[str] = None
    policy_content_fingerprint: Optional[str] = None
    verdict: Optional[str] = None
    blocking: bool = False
    score: Optional[int] = None
    grade: Optional[str] = None
    report_fingerprint: Optional[str] = None
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    adapter_finding_count: int = 0
    spec_finding_count: int = 0
    attribution: Dict[str, Dict[str, int]] = field(default_factory=dict)
    declared_parser_limits: int = 0
    readiness: Optional[int] = None
    rank: Optional[int] = None
    band: Optional[str] = None
    preserved_percent: Optional[int] = None

    def as_row(self) -> Dict[str, Any]:
        """The keyword arguments :meth:`Database.record_quality_rank_observation` takes."""
        return {
            "tenant_id": self.tenant_id,
            "scope": self.scope,
            "stage": self.stage,
            "outcome": self.outcome,
            "format_key": self.format_key,
            "adapter_key": self.adapter_key,
            "project_id": self.project_id,
            "version_record_id": self.version_record_id,
            "style_guide_id": self.style_guide_id,
            "style_guide_fingerprint": self.style_guide_fingerprint,
            "style_guide_source": self.style_guide_source,
            "policy_version_id": self.policy_version_id,
            "policy_content_fingerprint": self.policy_content_fingerprint,
            "verdict": self.verdict,
            "blocking": self.blocking,
            "score": self.score,
            "grade": self.grade,
            "report_fingerprint": self.report_fingerprint,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "info_count": self.info_count,
            "adapter_finding_count": self.adapter_finding_count,
            "spec_finding_count": self.spec_finding_count,
            "attribution": self.attribution,
            "declared_parser_limits": self.declared_parser_limits,
            "readiness": self.readiness,
            "rank": self.rank,
            "band": self.band,
            "preserved_percent": self.preserved_percent,
        }


def _severity(counts: Optional[Mapping[str, Any]], key: str) -> int:
    """One severity tally from a lint report's ``severity_counts``, defaulting to zero."""
    try:
        return max(0, int((counts or {}).get(key) or 0))
    except (TypeError, ValueError):
        return 0


def _clean_grade(value: Any) -> Optional[str]:
    """Keep a letter grade only when it is one this series can bucket."""
    text = str(value or "").strip().upper()
    return text if text in GRADES else None


def _clean_percent(value: Any) -> Optional[int]:
    """Clamp a 0-100 measurement, or ``None`` when there was none."""
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(100, number))


def _observation_from_lint(
    *,
    tenant_id: str,
    scope: str,
    stage: str,
    outcome: str,
    lint: Any,
    adapter_key: Optional[str],
    format_key: Optional[str],
) -> QualityRankObservation:
    """Build the lint-derived part of an observation shared by every recording helper.

    Args:
        tenant_id: Owning tenant.
        scope: ``import`` | ``export``.
        stage: ``preflight`` | ``committed``.
        outcome: The recorded gate outcome.
        lint: Anything carrying ``score`` / ``grade`` / ``severity_counts`` / ``rule_hits`` /
            ``report_fingerprint`` (a :class:`~app.import_source.LintReport` or its response
            model), or ``None`` when nothing was graded.
        adapter_key: Adapter/emitter registry key.
        format_key: Source/target format key.

    Returns:
        The populated observation, with attribution already computed.
    """
    severity_counts = getattr(lint, "severity_counts", None) if lint is not None else None
    rule_hits = getattr(lint, "rule_hits", None) if lint is not None else None
    breakdown, adapter_findings, spec_findings = attribute_rule_hits(rule_hits)
    return QualityRankObservation(
        tenant_id=tenant_id,
        scope=scope,
        stage=stage,
        outcome=outcome,
        format_key=format_key,
        adapter_key=adapter_key,
        score=_clean_percent(getattr(lint, "score", None) if lint is not None else None),
        grade=_clean_grade(getattr(lint, "grade", None) if lint is not None else None),
        report_fingerprint=(
            getattr(lint, "report_fingerprint", None) if lint is not None else None
        ),
        error_count=_severity(severity_counts, "error"),
        warning_count=_severity(severity_counts, "warning"),
        info_count=_severity(severity_counts, "info"),
        adapter_finding_count=adapter_findings,
        spec_finding_count=spec_findings,
        attribution=breakdown,
        declared_parser_limits=declared_parser_limit_count(adapter_key),
    )


def _apply_policy(observation: QualityRankObservation, policy: Any) -> QualityRankObservation:
    """Copy the policy verdict fields off an ``ImportPreflightPolicy``-shaped object."""
    if policy is None:
        return observation
    observation.verdict = getattr(policy, "verdict", None)
    observation.blocking = bool(getattr(policy, "blocking", False))
    observation.policy_version_id = getattr(policy, "policy_version_id", None)
    observation.policy_content_fingerprint = getattr(
        policy, "policy_content_fingerprint", None
    )
    return observation


def _apply_style_guide(
    observation: QualityRankObservation, guide: Any
) -> QualityRankObservation:
    """Copy the style-guide identity off a compiled guide (or its response model)."""
    if guide is None:
        return observation
    observation.style_guide_id = getattr(guide, "guide_id", None)
    observation.style_guide_fingerprint = getattr(guide, "fingerprint", None)
    observation.style_guide_source = getattr(guide, "source", None)
    return observation


# --- Recording ------------------------------------------------------------------------------


def record_observation(observation: QualityRankObservation) -> Optional[str]:
    """Persist one observation, best-effort.

    Best-effort is the contract, not a shortcut: this runs on the import, export, and pre-flight
    paths, and a telemetry table that is unreachable (or a migration that has not run yet) must
    not cost a user their import. Every failure is logged at warning and swallowed.

    Args:
        observation: The observation to store.

    Returns:
        The stored row id, or ``None`` when nothing was written.
    """
    if not observation.tenant_id:
        return None
    try:
        from .database import db

        row = db.record_quality_rank_observation(**observation.as_row())
    except Exception:  # noqa: BLE001 - telemetry never fails the work it observes
        logger.warning(
            "Could not record a quality-rank observation (scope=%s stage=%s format=%s)",
            observation.scope,
            observation.stage,
            observation.format_key,
            exc_info=True,
        )
        return None
    return str(row["id"]) if row and row.get("id") else None


def observe_import_preflight(
    report: Any,
    *,
    tenant_id: str,
) -> Optional[str]:
    """Record the grade an import pre-flight produced (IXH-2.1).

    Args:
        report: The :class:`~app.models.ImportPreflightReport` the run produced.
        tenant_id: The tenant the pre-flight ran for.

    Returns:
        The stored row id, or ``None`` when nothing was recorded.
    """
    if not tenant_id or report is None:
        return None
    detection = getattr(report, "detection", None)
    lint = getattr(report, "lint", None)
    policy = getattr(report, "policy", None)
    gradable = bool(getattr(report, "ok", False)) and lint is not None
    observation = _observation_from_lint(
        tenant_id=tenant_id,
        scope=SCOPE_IMPORT,
        stage=STAGE_PREFLIGHT,
        outcome=outcome_for_verdict(
            getattr(policy, "verdict", None), gradable=gradable
        ),
        lint=lint,
        adapter_key=getattr(detection, "adapter_key", None),
        # The canonical format the run produced is the comparable key; before a run reaches
        # normalize there is none, so the adapter key stands in.
        format_key=getattr(report, "format", None)
        or getattr(detection, "adapter_key", None),
    )
    _apply_policy(observation, policy)
    _apply_style_guide(observation, getattr(report, "style_guide", None))
    return record_observation(observation)


def observe_import_commit(
    *,
    tenant_id: str,
    adapter_key: Optional[str],
    format_key: Optional[str],
    lint: Any,
    style_guide: Any = None,
    project_id: Optional[str] = None,
    version_record_id: Optional[str] = None,
) -> Optional[str]:
    """Record the grade a **committed** import landed with (MFI-4.2's roll-up).

    The committed half of the series: a pre-flight says what a document would score, this says
    what actually entered the catalog. Both are recorded so the two can be compared — a tenant
    whose committed grades trail its pre-flight grades is waiving its way past its own policy.

    Args:
        tenant_id: The importing tenant.
        adapter_key: The adapter that ran.
        format_key: The canonical format the import produced.
        lint: The rolled-up lint report the revision was scored with.
        style_guide: The resolved style guide that scored it, when one was applied.
        project_id: The catalog item / project the revision landed in.
        version_record_id: The committed revision.

    Returns:
        The stored row id, or ``None`` when nothing was recorded.
    """
    if not tenant_id:
        return None
    observation = _observation_from_lint(
        tenant_id=tenant_id,
        scope=SCOPE_IMPORT,
        stage=STAGE_COMMITTED,
        outcome=outcome_for_verdict("pass", gradable=lint is not None),
        lint=lint,
        adapter_key=adapter_key,
        format_key=format_key or adapter_key,
    )
    observation.project_id = project_id
    observation.version_record_id = version_record_id
    _apply_style_guide(observation, style_guide)
    return record_observation(observation)


def observe_export_preflight(
    report: Any,
    *,
    tenant_id: str,
    project_id: Optional[str] = None,
    sample: int = EXPORT_PREFLIGHT_RANK_SAMPLE,
) -> List[str]:
    """Record the readiness ranks an export pre-flight produced (IXH-2.4).

    Records the head of the ranking only — see :data:`EXPORT_PREFLIGHT_RANK_SAMPLE` — and skips
    targets banded ``unavailable``, which have no readiness to trend (the emitter is not
    installed, so their score says nothing about the source's quality).

    Args:
        report: The :class:`~app.export_preflight.ExportPreflightReport`.
        tenant_id: The tenant the pre-flight ran for.
        project_id: The owning artifact/project.
        sample: How many ranked targets to record (clamped to at least one).

    Returns:
        The stored row ids, in rank order.
    """
    if not tenant_id or report is None:
        return []
    lint = getattr(report, "lint", None)
    guide = getattr(report, "style_guide", None)
    version_record_id = getattr(report, "version_record_id", None)
    stored: List[str] = []
    for target in list(getattr(report, "targets", None) or [])[: max(1, int(sample))]:
        band = str(getattr(target, "band", "") or "")
        if band not in _RECORDED_BANDS:
            continue
        policy = getattr(target, "policy", None)
        observation = _observation_from_lint(
            tenant_id=tenant_id,
            scope=SCOPE_EXPORT,
            stage=STAGE_PREFLIGHT,
            outcome=outcome_for_band(band),
            lint=lint,
            adapter_key=getattr(target, "key", None),
            format_key=getattr(target, "format", None) or getattr(target, "key", None),
        )
        observation.project_id = project_id
        observation.version_record_id = version_record_id
        observation.readiness = _clean_percent(getattr(target, "readiness", None))
        observation.rank = getattr(target, "rank", None) or None
        observation.band = band
        observation.preserved_percent = _clean_percent(
            getattr(getattr(target, "fidelity", None), "preserved_percent", None)
        )
        _apply_policy(observation, policy)
        _apply_style_guide(observation, guide)
        row_id = record_observation(observation)
        if row_id:
            stored.append(row_id)
    return stored


def observe_delivery(
    decision: Any,
    *,
    tenant_id: str,
    lint: Any = None,
    adapter_key: Optional[str] = None,
    project_id: Optional[str] = None,
    version_record_id: Optional[str] = None,
) -> Optional[str]:
    """Record a delivery gate decision (IXH-2.5) as a committed export observation.

    Args:
        decision: The :class:`~app.export_delivery_gate.DeliveryGateReport`.
        tenant_id: The delivering tenant.
        lint: The source's lint report the gate judged, when it could be linted.
        adapter_key: The target's registry key, defaulting to the decision's target format.
        project_id: The owning artifact/project.
        version_record_id: The source revision.

    Returns:
        The stored row id, or ``None`` when nothing was recorded.
    """
    if not tenant_id or decision is None:
        return None
    target_format = str(getattr(decision, "target", "") or "") or None
    policy = getattr(decision, "policy", None)
    observation = _observation_from_lint(
        tenant_id=tenant_id,
        scope=SCOPE_EXPORT,
        stage=STAGE_COMMITTED,
        outcome=_delivery_outcome(decision),
        lint=lint,
        adapter_key=adapter_key or target_format,
        format_key=target_format,
    )
    observation.project_id = project_id
    observation.version_record_id = version_record_id
    observation.preserved_percent = _clean_percent(
        getattr(decision, "preserved_percent", None)
    )
    if lint is None:
        # The gate's own roll-up is the only grade a degraded lint leaves behind.
        observation.score = _clean_percent(getattr(decision, "source_score", None))
        observation.grade = _clean_grade(getattr(decision, "source_grade", None))
        observation.report_fingerprint = getattr(
            decision, "source_report_fingerprint", None
        )
    _apply_policy(observation, policy)
    return record_observation(observation)


def _delivery_outcome(decision: Any) -> str:
    """Map a delivery gate decision onto the recorded outcome."""
    if bool(getattr(decision, "blocks_delivery", False)):
        return "block"
    if bool(getattr(decision, "warns", False)):
        return "warn"
    return "pass"


# --- Retention ------------------------------------------------------------------------------


def prune_quality_rank_observations(
    database: Any, *, now: Optional[datetime] = None, retention_days: Optional[int] = None
) -> int:
    """Delete observations older than the retention window (acceptance criterion 4).

    Args:
        database: The :class:`~app.database.Database` handle to prune with.
        now: Retention clock base; defaults to UTC now.
        retention_days: Window override; defaults to ``settings.quality_rank_retention_days``.
            ``<= 0`` keeps observations forever, which is the documented way to disable this.

    Returns:
        The number of rows deleted (``0`` when retention is disabled or the prune failed).
    """
    try:
        days = retention_days
        if days is None:
            from .config import settings

            days = int(settings.quality_rank_retention_days)
        if days <= 0:
            return 0
        clock = now or datetime.now(timezone.utc)
        if clock.tzinfo is None:
            clock = clock.replace(tzinfo=timezone.utc)
        return int(
            database.prune_quality_rank_observations(older_than=clock - timedelta(days=days))
        )
    except Exception:  # noqa: BLE001 - a failed prune retries on the next sweep tick, and it
        # shares a tick with the other retention steps, so it must not abort them either.
        logger.warning("quality-rank observation prune failed", exc_info=True)
        return 0


# --- Reading --------------------------------------------------------------------------------


def load_quality_rank_observations(
    tenant_id: str,
    *,
    since: datetime,
    project_id: Optional[str] = None,
    scope: Optional[str] = None,
    stage: Optional[str] = None,
) -> List[Mapping[str, Any]]:
    """Load one tenant's observations inside a window (the only read that touches the DB).

    Args:
        tenant_id: Tenant scope.
        since: Window start.
        project_id: Restrict to one artifact/project.
        scope: Restrict to ``import`` or ``export``.
        stage: Restrict to ``preflight`` or ``committed``.

    Returns:
        The observation rows, newest first; empty when the read failed (the series then simply
        reports nothing rather than failing the workspace).
    """
    try:
        from .database import db

        return db.list_quality_rank_observations(
            tenant_id,
            since=since,
            project_id=project_id,
            scope=scope,
            stage=stage,
            limit=MAX_SERIES_ROWS,
        )
    except Exception:  # noqa: BLE001 - a telemetry read must not break the lint workspace
        logger.warning(
            "Could not read quality-rank observations for tenant %s", tenant_id, exc_info=True
        )
        return []


# --- Aggregation ----------------------------------------------------------------------------


def _parse_dt(value: Any) -> Optional[datetime]:
    """Parse a datetime or ISO string into an aware UTC datetime (lenient)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@dataclass
class _Bucket:
    """Mutable accumulator for one (scope, format) group or one of its days."""

    observations: int = 0
    score_sum: int = 0
    score_count: int = 0
    readiness_sum: int = 0
    readiness_count: int = 0
    grades: Dict[str, int] = field(default_factory=lambda: {g: 0 for g in (*GRADES, UNGRADED)})

    def add(self, row: Mapping[str, Any]) -> None:
        """Fold one observation row into this bucket."""
        self.observations += 1
        score = row.get("score")
        if score is not None:
            self.score_sum += int(score)
            self.score_count += 1
        readiness = row.get("readiness")
        if readiness is not None:
            self.readiness_sum += int(readiness)
            self.readiness_count += 1
        grade = _clean_grade(row.get("grade")) or UNGRADED
        self.grades[grade] = self.grades.get(grade, 0) + 1

    @property
    def average_score(self) -> Optional[int]:
        """Mean score over the *scored* observations, or ``None`` when none were scored."""
        return round(self.score_sum / self.score_count) if self.score_count else None

    @property
    def average_readiness(self) -> Optional[int]:
        """Mean export readiness, or ``None`` when no observation carried one."""
        return (
            round(self.readiness_sum / self.readiness_count)
            if self.readiness_count
            else None
        )


def build_quality_rank_series(
    rows: Sequence[Mapping[str, Any]],
    *,
    days: int,
    now: Optional[datetime] = None,
    max_formats: int = MAX_SERIES_FORMATS,
) -> Dict[str, Any]:
    """Aggregate observation rows into the per-format grade series (pure).

    Grades are grouped by ``(scope, format_key)`` — the split acceptance criterion 2 asks for —
    and each group carries both a rollup and a daily point series over the window. A day with no
    observation for a format is present with ``observations = 0`` and ``averageScore = null``: a
    gap is a gap, never a zero, so a format nobody imported does not read as a format that
    crashed to nothing.

    Args:
        rows: Observation rows (any order); rows outside the window are ignored.
        days: Window size in days (clamped to ``1..``:data:`MAX_WINDOW_DAYS`).
        now: Window end; defaults to UTC now.
        max_formats: Most format groups to describe, busiest first.

    Returns:
        ``{"days", "window_start", "window_end", "observation_count", "truncated",
        "format_limit", "stages", "outcomes", "formats": [...]}`` where each format entry carries
        its rollup, its attribution split, and its ``points`` day series (oldest day first).
    """
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        clock = clock.replace(tzinfo=timezone.utc)
    window_days = max(1, min(int(days), MAX_WINDOW_DAYS))
    start_date = (clock - timedelta(days=window_days - 1)).date()
    day_keys = [(start_date + timedelta(days=i)).isoformat() for i in range(window_days)]
    day_index = set(day_keys)

    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    stages: Dict[str, int] = {STAGE_PREFLIGHT: 0, STAGE_COMMITTED: 0}
    outcomes: Dict[str, int] = {outcome: 0 for outcome in OUTCOMES}
    counted = 0

    for row in rows:
        occurred = _parse_dt(row.get("occurred_at"))
        if occurred is None:
            continue
        day = occurred.date().isoformat()
        if day not in day_index:
            continue
        counted += 1
        stage = str(row.get("stage") or "")
        if stage in stages:
            stages[stage] += 1
        outcome = str(row.get("outcome") or "")
        if outcome in outcomes:
            outcomes[outcome] += 1

        scope = str(row.get("scope") or "")
        format_key = str(row.get("format_key") or "") or "unknown"
        key = (scope, format_key)
        group = groups.get(key)
        if group is None:
            group = {
                "scope": scope,
                "format_key": format_key,
                "adapter_keys": set(),
                "style_guide_fingerprints": set(),
                "total": _Bucket(),
                "days": {},
                "outcomes": {outcome_key: 0 for outcome_key in OUTCOMES},
                "adapter_findings": 0,
                "spec_findings": 0,
                "declared_parser_limits": 0,
                "attribution": {ADAPTER_ATTRIBUTION: {}, SPEC_ATTRIBUTION: {}},
                "blocked": 0,
                "best_rank": None,
                "first": None,
                "last": None,
            }
            groups[key] = group

        adapter_key = str(row.get("adapter_key") or "")
        if adapter_key:
            group["adapter_keys"].add(adapter_key)
        guide_fingerprint = str(row.get("style_guide_fingerprint") or "")
        if guide_fingerprint:
            group["style_guide_fingerprints"].add(guide_fingerprint)

        group["total"].add(row)
        group["days"].setdefault(day, _Bucket()).add(row)
        if outcome in group["outcomes"]:
            group["outcomes"][outcome] += 1
        group["adapter_findings"] += max(0, int(row.get("adapter_finding_count") or 0))
        group["spec_findings"] += max(0, int(row.get("spec_finding_count") or 0))
        group["declared_parser_limits"] = max(
            group["declared_parser_limits"], int(row.get("declared_parser_limits") or 0)
        )
        if row.get("blocking"):
            group["blocked"] += 1
        rank = row.get("rank")
        if rank is not None:
            best = group["best_rank"]
            group["best_rank"] = int(rank) if best is None else min(best, int(rank))
        _merge_attribution(group["attribution"], row.get("attribution"))

        # Score drift needs the window's oldest and newest *scored* observations.
        if row.get("score") is not None:
            stamped = (occurred, int(row["score"]), _clean_grade(row.get("grade")))
            # Strict comparisons on both ends: rows arrive newest-first, so two observations
            # sharing a timestamp resolve to the same pair on every run.
            if group["first"] is None or stamped[0] < group["first"][0]:
                group["first"] = stamped
            if group["last"] is None or stamped[0] > group["last"][0]:
                group["last"] = stamped

    ordered = sorted(
        groups.values(),
        key=lambda g: (-g["total"].observations, g["scope"], g["format_key"]),
    )
    limit = max(1, int(max_formats))
    truncated = len(ordered) > limit

    formats: List[Dict[str, Any]] = []
    for group in ordered[:limit]:
        total: _Bucket = group["total"]
        first = group["first"]
        last = group["last"]
        formats.append(
            {
                "scope": group["scope"],
                "format_key": group["format_key"],
                "adapter_keys": sorted(group["adapter_keys"]),
                "style_guide_versions": sorted(group["style_guide_fingerprints"]),
                "observations": total.observations,
                "grade_distribution": dict(total.grades),
                "average_score": total.average_score,
                "average_readiness": total.average_readiness,
                "latest_score": last[1] if last else None,
                "latest_grade": last[2] if last else None,
                "score_delta": (last[1] - first[1]) if (first and last) else None,
                "outcomes": dict(group["outcomes"]),
                "blocked_count": group["blocked"],
                "best_rank": group["best_rank"],
                "adapter_finding_count": group["adapter_findings"],
                "spec_finding_count": group["spec_findings"],
                "declared_parser_limits": group["declared_parser_limits"],
                "attribution": {
                    ADAPTER_ATTRIBUTION: dict(
                        sorted(group["attribution"][ADAPTER_ATTRIBUTION].items())
                    ),
                    SPEC_ATTRIBUTION: dict(
                        sorted(group["attribution"][SPEC_ATTRIBUTION].items())
                    ),
                },
                "points": [
                    _point(day, group["days"].get(day)) for day in day_keys
                ],
            }
        )

    return {
        "days": window_days,
        "window_start": day_keys[0],
        "window_end": day_keys[-1],
        "observation_count": counted,
        "truncated": truncated,
        "format_limit": limit,
        "stages": stages,
        "outcomes": outcomes,
        "formats": formats,
    }


def _point(day: str, bucket: Optional[_Bucket]) -> Dict[str, Any]:
    """One day in a format's series; an absent bucket is a gap, not a zero score."""
    if bucket is None:
        return {
            "date": day,
            "observations": 0,
            "average_score": None,
            "average_readiness": None,
            "grade_distribution": {g: 0 for g in (*GRADES, UNGRADED)},
        }
    return {
        "date": day,
        "observations": bucket.observations,
        "average_score": bucket.average_score,
        "average_readiness": bucket.average_readiness,
        "grade_distribution": dict(bucket.grades),
    }


def _merge_attribution(target: Dict[str, Dict[str, int]], raw: Any) -> None:
    """Fold one row's stored attribution map into a group's running totals."""
    if not isinstance(raw, Mapping):
        return
    for side in (ADAPTER_ATTRIBUTION, SPEC_ATTRIBUTION):
        classes = raw.get(side)
        if not isinstance(classes, Mapping):
            continue
        bucket = target.setdefault(side, {})
        for name, value in classes.items():
            try:
                count = int(value)
            except (TypeError, ValueError):
                continue
            if count <= 0:
                continue
            bucket[str(name)] = bucket.get(str(name), 0) + count
