"""Pre-flight report rendering and CI gating for import/export (IXH-2.6).

Pure, stream-agnostic helpers (no HTTP) so the pre-flight verdicts the CLI prints and the
exit codes it returns are unit-testable in isolation. The reports themselves are computed
server-side — ``POST …/import/preflight`` (IXH-2.1) and ``POST …/export/preflight``
(IXH-2.4) — and this module only *presents* and *grades* what the API returned. It never
re-lints, re-scores, or re-ranks anything.

Gating
------
Two thresholds are available on every pre-flight-aware command:

``--min-grade G``
    Fail when the lint grade is worse than ``G`` (``A`` best, ``F`` worst).
``--fail-on S``
    Fail when the lint report has at least one finding at or above severity ``S``
    (``error`` / ``warning`` / ``info``).

Those are the *caller's* thresholds. Independently, the tenant's quality policy (IXH-2.3)
carries its own verdict, and a ``block`` there fails whether or not the caller asked for a
threshold — that is the gate the pipeline is supposed to respect. The two are reported and
exited separately (:data:`~apiome_cli.exit_codes.EXIT_POLICY_BLOCKED` vs
:data:`~apiome_cli.exit_codes.EXIT_QUALITY_GATE`) so a CI log says which one stopped the
build.

Waivers
-------
A tenant waiver (IXH-2.3) downgrades a blocking policy verdict server-side, so a waived
payload passes the policy gate. It is never silent: the waiver id and its expiry are
printed, and every floor the payload misses is listed as *waived* rather than dropped. A
waiver does **not** relax ``--min-grade`` / ``--fail-on`` — those are the caller's own
thresholds, and a tenant-side waiver cannot lower a bar the pipeline set for itself.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from apiome_cli.exit_codes import (
    EXIT_POLICY_BLOCKED,
    EXIT_PREFLIGHT_UNUSABLE,
    EXIT_QUALITY_GATE,
    EXIT_SUCCESS,
)
from apiome_cli.output import ListColumn

# The grade ladder is shared with ``lint --min-grade`` rather than restated: one definition of
# "B is better than C" for every command that gates on a letter grade.
from apiome_cli.output_lint import GRADE_ORDER, grade_meets_minimum

#: Lint severities worst-to-least. ``--fail-on S`` trips on any finding at or above ``S``,
#: so the index in this tuple *is* the threshold.
SEVERITY_ORDER: tuple[str, ...] = ("error", "warning", "info")

#: Export readiness bands whose target a caller cannot actually export right now. The API
#: ranks targets ``ready`` → ``caution`` → ``blocked`` → ``unavailable``; the first two are
#: selectable, and these two are not.
UNUSABLE_BANDS: frozenset[str] = frozenset({"blocked", "unavailable"})

#: Findings shown in the human table before it points the caller at ``--json``. A ranked
#: report leads with the worst findings, so a truncated table still shows what matters.
MAX_FINDING_ROWS = 15

#: Shared ``--min-grade`` help text, so every gated command documents the same contract.
MIN_GRADE_HELP = (
    "Fail when the lint grade is worse than this (A best, F worst). "
    f"Exits {EXIT_QUALITY_GATE} when the threshold is missed."
)

#: Shared ``--fail-on`` help text.
FAIL_ON_HELP = (
    "Fail when the lint report has any finding at or above this severity "
    "(error, warning, info). "
    f"Exits {EXIT_QUALITY_GATE} when the threshold is missed."
)

#: Shared note on the gate exit codes, appended to the gated commands' help.
GATE_EXIT_CODE_HELP = (
    f"Gate exit codes: {EXIT_POLICY_BLOCKED} = tenant quality policy blocked, "
    f"{EXIT_QUALITY_GATE} = --min-grade/--fail-on threshold missed, "
    f"{EXIT_PREFLIGHT_UNUSABLE} = nothing gradable (candidate unimportable / no usable target). "
    "These are distinct from transport (1) and usage/auth (2) failures."
)


# ===========================================================================
# Flag validation
# ===========================================================================


class PreflightFlagError(ValueError):
    """A ``--min-grade`` / ``--fail-on`` value that is not on its ladder."""

    def __init__(self, message: str, *, param_hint: str) -> None:
        super().__init__(message)
        self.message = message
        self.param_hint = param_hint


def normalize_min_grade(value: str | None) -> str | None:
    """Validate and upper-case a ``--min-grade`` value.

    Args:
        value: The raw flag value, or ``None`` when the flag was not given.

    Returns:
        The upper-cased grade, or ``None`` when no flag was given.

    Raises:
        PreflightFlagError: When the value is not one of :data:`GRADE_ORDER`.
    """
    if value is None:
        return None
    normalized = value.strip().upper()
    if normalized not in GRADE_ORDER:
        raise PreflightFlagError(
            f"must be one of {', '.join(GRADE_ORDER)}",
            param_hint="--min-grade",
        )
    return normalized


def normalize_fail_on(value: str | None) -> str | None:
    """Validate and lower-case a ``--fail-on`` value.

    Args:
        value: The raw flag value, or ``None`` when the flag was not given.

    Returns:
        The lower-cased severity, or ``None`` when no flag was given.

    Raises:
        PreflightFlagError: When the value is not one of :data:`SEVERITY_ORDER`.
    """
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized not in SEVERITY_ORDER:
        raise PreflightFlagError(
            f"must be one of {', '.join(SEVERITY_ORDER)}",
            param_hint="--fail-on",
        )
    return normalized


def gating_requested(*, min_grade: str | None, fail_on: str | None) -> bool:
    """True when the caller asked for a client-side gate on this command.

    The import/export commands only spend a pre-flight round trip when one of the two
    threshold flags is present; without them the server's own enforcement still applies at
    commit time, so an ungated command behaves exactly as it did before IXH-2.6.
    """
    return min_grade is not None or fail_on is not None


# ===========================================================================
# Report accessors
# ===========================================================================


def _mapping(value: Any) -> Mapping[str, Any]:
    """Return ``value`` when it is a mapping, else an empty mapping."""
    return value if isinstance(value, Mapping) else {}


def severity_count_at_or_above(lint: Mapping[str, Any] | None, threshold: str) -> int:
    """Count findings at or above ``threshold`` severity in a lint verdict.

    Reads the report's own ``severity_counts`` tally rather than re-walking the finding
    list, so the count is right even when ``include_findings`` suppressed the list.

    Args:
        lint: An ``ImportPreflightLint`` mapping, or ``None``.
        threshold: One of :data:`SEVERITY_ORDER`.

    Returns:
        The number of findings at or above ``threshold``; ``0`` when there is no verdict.
    """
    counts = _mapping(_mapping(lint).get("severity_counts"))
    limit = SEVERITY_ORDER.index(threshold) if threshold in SEVERITY_ORDER else -1
    total = 0
    for index, severity in enumerate(SEVERITY_ORDER):
        if index > limit:
            break
        value = counts.get(severity)
        if isinstance(value, int):
            total += value
    return total


def waiver_reference(policy: Mapping[str, Any] | None) -> str | None:
    """Render the waiver that downgraded a policy verdict, or ``None`` when unwaived.

    Args:
        policy: An ``ImportPreflightPolicy`` mapping, or ``None``.

    Returns:
        ``"waiver <id>"``, with ``" (expires <ts>)"`` appended when the waiver carries an
        expiry, or ``None`` when no waiver applied.
    """
    resolved = _mapping(policy)
    waiver_id = resolved.get("waiver_id")
    if not isinstance(waiver_id, str) or not waiver_id.strip():
        return None
    reference = f"waiver {waiver_id.strip()}"
    expires = resolved.get("waiver_expires_at")
    if isinstance(expires, str) and expires.strip():
        reference = f"{reference} (expires {expires.strip()})"
    return reference


def policy_blocks(policy: Mapping[str, Any] | None) -> bool:
    """True when a policy verdict refuses the payload.

    ``blocking`` is the server's final say: a waiver that covers the shortfall has already
    downgraded the verdict to ``warn`` by the time the report is serialized, so a waived
    payload reads as not blocking here — exactly as the wizard sees it.
    """
    return _mapping(policy).get("blocking") is True


# ===========================================================================
# Gate evaluation
# ===========================================================================


@dataclass(frozen=True)
class GateOutcome:
    """The verdict of a pre-flight gate: one exit code plus the reasons behind it.

    Attributes:
        exit_code: :data:`~apiome_cli.exit_codes.EXIT_SUCCESS` when nothing tripped,
            otherwise the most specific gate code (see :mod:`apiome_cli.exit_codes`).
        reasons: Human-readable lines explaining every gate that tripped, in the order
            they were evaluated. Empty on success.
    """

    exit_code: int = EXIT_SUCCESS
    reasons: list[str] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        """True when the gate did not pass."""
        return self.exit_code != EXIT_SUCCESS


def _threshold_reasons(
    lint: Mapping[str, Any] | None,
    *,
    min_grade: str | None,
    fail_on: str | None,
) -> list[str]:
    """Evaluate the caller's own ``--min-grade`` / ``--fail-on`` thresholds."""
    reasons: list[str] = []
    resolved = _mapping(lint)
    if min_grade is not None:
        grade = resolved.get("grade")
        grade_text = str(grade).strip().upper() if isinstance(grade, str) and grade.strip() else None
        if not grade_meets_minimum(grade_text, min_grade):
            actual = grade_text or "none"
            reasons.append(f"--min-grade {min_grade}: grade is {actual}.")
    if fail_on is not None:
        hits = severity_count_at_or_above(resolved, fail_on)
        if hits > 0:
            plural = "finding" if hits == 1 else "findings"
            reasons.append(f"--fail-on {fail_on}: {hits} {plural} at or above {fail_on}.")
    return reasons


def evaluate_import_gate(
    report: Mapping[str, Any],
    *,
    min_grade: str | None = None,
    fail_on: str | None = None,
) -> GateOutcome:
    """Grade an ``ImportPreflightReport`` into an exit code.

    Precedence, worst first — an unusable candidate cannot be graded, and a policy block is
    the tenant's decision rather than the caller's threshold:

    1. ``ok: false`` (the candidate cannot be imported) → ``EXIT_PREFLIGHT_UNUSABLE``.
    2. The tenant policy blocks → ``EXIT_POLICY_BLOCKED``.
    3. ``--min-grade`` / ``--fail-on`` unmet → ``EXIT_QUALITY_GATE``.

    Every reason that applies is still collected, so a report that both blocks on policy and
    misses ``--min-grade`` prints both lines under the single, most-specific exit code.

    Args:
        report: The parsed pre-flight report.
        min_grade: Caller's minimum acceptable grade, or ``None``.
        fail_on: Caller's severity threshold, or ``None``.

    Returns:
        The :class:`GateOutcome` for this report.
    """
    policy = _mapping(report.get("policy"))
    lint = report.get("lint")
    reasons: list[str] = []

    if report.get("ok") is not True:
        error = _mapping(report.get("error"))
        code = error.get("code")
        message = error.get("message")
        detail = f"{code}: {message}" if code and message else (message or code or "unknown reason")
        reasons.append(f"Candidate is not importable — {detail}")
        return GateOutcome(exit_code=EXIT_PREFLIGHT_UNUSABLE, reasons=reasons)

    blocked = policy_blocks(policy)
    if blocked:
        reason = str(policy.get("reason") or "the tenant quality policy refuses this import")
        reasons.append(f"Quality policy blocks this import — {reason}")

    reasons.extend(_threshold_reasons(lint, min_grade=min_grade, fail_on=fail_on))

    if blocked:
        return GateOutcome(exit_code=EXIT_POLICY_BLOCKED, reasons=reasons)
    if reasons:
        return GateOutcome(exit_code=EXIT_QUALITY_GATE, reasons=reasons)
    return GateOutcome()


def selectable_targets(report: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Return the ranked targets a caller could actually export right now."""
    targets = report.get("targets")
    if not isinstance(targets, Sequence) or isinstance(targets, (str, bytes)):
        return []
    return [
        target
        for target in targets
        if isinstance(target, Mapping)
        and str(target.get("band", "")).strip().lower() not in UNUSABLE_BANDS
    ]


def evaluate_export_gate(
    report: Mapping[str, Any],
    *,
    min_grade: str | None = None,
    fail_on: str | None = None,
) -> GateOutcome:
    """Grade an ``ExportPreflightReport`` into an exit code.

    The export report ranks *many* targets, so "blocked" is a statement about the ranking as
    a whole: the export is refused only when **no** ranked target is selectable. A caller
    who narrowed the ranking with ``--to openapi`` therefore gets exactly "openapi is
    blocked", while a caller who ranked everything is not failed because one exotic target
    happens to be policy-blocked — they still have somewhere to export to.

    Precedence, worst first:

    1. No targets ranked at all → ``EXIT_PREFLIGHT_UNUSABLE``.
    2. Every ranked target is blocked or unavailable → ``EXIT_POLICY_BLOCKED`` when policy
       caused it, otherwise ``EXIT_PREFLIGHT_UNUSABLE`` (the emitters cannot run here).
    3. ``--min-grade`` / ``--fail-on`` unmet against the **source** lint →
       ``EXIT_QUALITY_GATE``.

    Args:
        report: The parsed pre-flight report.
        min_grade: Caller's minimum acceptable source grade, or ``None``.
        fail_on: Caller's severity threshold on the source lint, or ``None``.

    Returns:
        The :class:`GateOutcome` for this report.
    """
    targets = report.get("targets")
    ranked = [item for item in targets if isinstance(item, Mapping)] if isinstance(targets, list) else []
    reasons: list[str] = []

    if not ranked:
        reasons.append("No export targets were ranked for this revision.")
        return GateOutcome(exit_code=EXIT_PREFLIGHT_UNUSABLE, reasons=reasons)

    usable = selectable_targets(report)
    if not usable:
        blocked_names = [
            str(target.get("key", "?"))
            for target in ranked
            if str(target.get("band", "")).strip().lower() == "blocked"
        ]
        if blocked_names:
            reasons.append(
                "Quality policy blocks every ranked target — "
                f"{', '.join(sorted(blocked_names))}."
            )
            reasons.extend(_threshold_reasons(report.get("lint"), min_grade=min_grade, fail_on=fail_on))
            return GateOutcome(exit_code=EXIT_POLICY_BLOCKED, reasons=reasons)
        reasons.append("No ranked export target can run in this deployment.")
        return GateOutcome(exit_code=EXIT_PREFLIGHT_UNUSABLE, reasons=reasons)

    reasons.extend(_threshold_reasons(report.get("lint"), min_grade=min_grade, fail_on=fail_on))
    if reasons:
        return GateOutcome(exit_code=EXIT_QUALITY_GATE, reasons=reasons)
    return GateOutcome()


# ===========================================================================
# Human rendering — import
# ===========================================================================

#: Columns for the ranked lint-finding table both pre-flights print.
PREFLIGHT_FINDING_COLUMNS: tuple[ListColumn, ...] = (
    ("#", "rank", None),
    ("Severity", "severity", None),
    ("Rule", "rule", None),
    ("Path", "path", None),
    ("Message", "message", None),
)


def finding_rows(lint: Mapping[str, Any] | None, *, limit: int = MAX_FINDING_ROWS) -> list[dict[str, Any]]:
    """Return up to ``limit`` ranked finding rows for the findings table.

    The API already ranks findings by severity then rule weight, so truncating keeps the
    findings worth fixing first. Rows are returned verbatim from the report — no re-sorting.
    """
    findings = _mapping(lint).get("findings")
    if not isinstance(findings, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in findings[:limit]:
        if not isinstance(item, Mapping):
            continue
        rows.append(
            {
                "rank": item.get("rank", ""),
                "severity": item.get("severity", ""),
                "rule": item.get("rule", ""),
                "path": item.get("path", ""),
                "message": item.get("message", ""),
            }
        )
    return rows


def finding_overflow(lint: Mapping[str, Any] | None, *, limit: int = MAX_FINDING_ROWS) -> int:
    """How many ranked findings the table left out (``0`` when it showed them all)."""
    findings = _mapping(lint).get("findings")
    if not isinstance(findings, list):
        return 0
    return max(0, len(findings) - limit)


def format_lint_lines(lint: Mapping[str, Any] | None, *, subject: str = "Lint") -> list[str]:
    """Render the score/grade/severity headline of a lint verdict."""
    if not isinstance(lint, Mapping) or not lint:
        return [f"{subject}: not scored."]
    score = lint.get("score")
    grade = lint.get("grade")
    headline = f"{subject}: "
    headline += "unscored" if score is None else f"{score}/100"
    if isinstance(grade, str) and grade.strip():
        headline += f" (grade {grade.strip().upper()})"
    counts = _mapping(lint.get("severity_counts"))
    tallies = [
        f"{counts.get(severity, 0)} {severity}"
        for severity in SEVERITY_ORDER
        if isinstance(counts.get(severity), int) and counts.get(severity)
    ]
    if tallies:
        headline += f" — {', '.join(tallies)}"
    return [headline]


def format_style_guide_line(style_guide: Mapping[str, Any] | None) -> list[str]:
    """Render the identity of the style guide that governed the lint."""
    resolved = _mapping(style_guide)
    if not resolved:
        return []
    name = resolved.get("name") or "(unnamed)"
    source = resolved.get("source") or "?"
    fingerprint = str(resolved.get("fingerprint") or "")
    suffix = f", fingerprint {fingerprint[:12]}" if fingerprint else ""
    return [f"Style guide: {name} ({source}{suffix})"]


def format_policy_lines(policy: Mapping[str, Any] | None, *, scope: str) -> list[str]:
    """Render a quality-policy verdict, naming every missed floor and any waiver.

    A waived verdict is reported as waived — the waiver id and expiry are printed and each
    covered floor is labelled ``waived floor`` — so a passing pipeline still records *why*
    it passed rather than looking clean.

    Args:
        policy: An ``ImportPreflightPolicy`` mapping, or ``None``.
        scope: ``import`` or ``export``, printed in the heading.

    Returns:
        One heading line plus an indented line per waiver/floor.
    """
    resolved = _mapping(policy)
    if not resolved:
        return []
    verdict = str(resolved.get("verdict") or "pass")
    reason = str(resolved.get("reason") or "").strip()
    heading = f"Policy ({scope}): {verdict}"
    if reason:
        heading += f" — {reason}"
    lines = [heading]

    source = resolved.get("source")
    enforcement = resolved.get("enforcement")
    if isinstance(source, str) and source:
        detail = f"  Resolved from: {source}"
        if isinstance(enforcement, str) and enforcement:
            detail += f" ({enforcement})"
        lines.append(detail)

    waiver = waiver_reference(resolved)
    if waiver is not None:
        lines.append(f"  Waived by {waiver}")

    label = "Waived floor" if waiver is not None else "Missed floor"
    failures = resolved.get("failures")
    if isinstance(failures, list):
        for failure in failures:
            if not isinstance(failure, Mapping):
                continue
            kind = failure.get("kind", "?")
            required = failure.get("required")
            actual = failure.get("actual")
            lines.append(f"  {label}: {kind} requires {required}, actual {actual}")
    return lines


def format_import_preflight_lines(report: Mapping[str, Any]) -> list[str]:
    """Render the headline of an import pre-flight report (everything but the table).

    Args:
        report: The parsed ``ImportPreflightReport``.

    Returns:
        Lines for stdout, in reading order: verdict, detection, routing, counts,
        fingerprint, lint headline, style guide, policy verdict, cache provenance.
    """
    detection = _mapping(report.get("detection"))
    ok = report.get("ok") is True
    lines: list[str] = []

    adapter = detection.get("adapter_key") or detection.get("detected_adapter_key") or "none"
    detected_format = detection.get("detected_format") or report.get("format") or "unknown"
    confidence = detection.get("confidence")
    confidence_text = f", confidence {confidence:.2f}" if isinstance(confidence, (int, float)) else ""
    lines.append(
        f"Pre-flight: {'OK' if ok else 'NOT IMPORTABLE'} "
        f"({detected_format} via {adapter}{confidence_text})"
    )
    if detection.get("agrees_with_request") is False:
        requested = detection.get("requested_adapter_key") or "the requested adapter"
        lines.append(
            f"  Detection disagrees with --format {requested}; the requested adapter was used."
        )
    if detection.get("ambiguous") is True:
        lines.append("  Detection was ambiguous: leading formats tied within the margin.")
    archive_root = detection.get("archive_root")
    if isinstance(archive_root, str) and archive_root:
        lines.append(f"  Archive root: {archive_root}")

    if not ok:
        error = _mapping(report.get("error"))
        code = error.get("code") or "UNKNOWN"
        message = error.get("message") or ""
        lines.append(f"Error: {code} — {message}" if message else f"Error: {code}")
        remediation = error.get("remediation")
        if isinstance(remediation, str) and remediation.strip():
            lines.append(f"  Remediation: {remediation.strip()}")

    routing = _mapping(report.get("routing"))
    if routing:
        destination = routing.get("target") or routing.get("destination") or "?"
        routing_reason = routing.get("reason")
        line = f"Routing: {destination}"
        if isinstance(routing_reason, str) and routing_reason.strip():
            line += f" — {routing_reason.strip()}"
        lines.append(line)

    counts = _mapping(report.get("counts"))
    if counts:
        lines.append(
            "Counts: "
            + ", ".join(
                f"{counts.get(key, 0)} {key}"
                for key in ("services", "operations", "types", "channels")
            )
        )

    fingerprint = report.get("fingerprint")
    if isinstance(fingerprint, str) and fingerprint:
        lines.append(f"Fingerprint: {fingerprint}")

    lines.extend(format_lint_lines(report.get("lint")))
    lines.extend(format_style_guide_line(report.get("style_guide")))
    lines.extend(format_policy_lines(report.get("policy"), scope="import"))

    cache = _mapping(report.get("cache"))
    if cache:
        hit = "hit" if cache.get("hit") is True else "miss"
        content_hash = str(cache.get("content_hash") or "")
        lines.append(f"Cache: {hit} (sha256 {content_hash[:16]})" if content_hash else f"Cache: {hit}")
    return lines


# ===========================================================================
# Human rendering — export
# ===========================================================================

#: Columns for the ranked export-target table.
EXPORT_PREFLIGHT_TARGET_COLUMNS: tuple[ListColumn, ...] = (
    ("#", "rank", None),
    ("Target", "key", None),
    ("Format", "format", None),
    ("Band", "band", None),
    ("Readiness", "readiness", None),
    ("Fidelity", "fidelity", None),
    ("Capability", "capability", None),
    ("Policy", "policy", None),
    ("Why", "rationale", None),
)


def _target_fidelity_cell(target: Mapping[str, Any]) -> str:
    """Render one target's projected fidelity as ``tier N%``."""
    summary = _mapping(_mapping(target.get("fidelity")).get("summary"))
    tier = str(summary.get("tier") or "?")
    preserved = summary.get("preserved_percent")
    if isinstance(preserved, (int, float)):
        return f"{tier} {preserved:.0f}%"
    return tier


def _target_policy_cell(target: Mapping[str, Any]) -> str:
    """Render one target's policy verdict, marking a waiver when one was honoured."""
    policy = _mapping(target.get("policy"))
    if not policy:
        return ""
    verdict = str(policy.get("verdict") or "pass")
    return f"{verdict} (waived)" if waiver_reference(policy) is not None else verdict


def export_target_rows(report: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the ranked-target table rows for an export pre-flight report.

    Rows are emitted in the order the API ranked them (best readiness first); blocked and
    unavailable targets are included, never hidden, so the reason stays visible.
    """
    targets = report.get("targets")
    if not isinstance(targets, list):
        return []
    rows: list[dict[str, Any]] = []
    for target in targets:
        if not isinstance(target, Mapping):
            continue
        capability = _mapping(target.get("capability"))
        rows.append(
            {
                "rank": target.get("rank", ""),
                "key": target.get("key", ""),
                "format": target.get("format", ""),
                "band": target.get("band", ""),
                "readiness": target.get("readiness", ""),
                "fidelity": _target_fidelity_cell(target),
                "capability": capability.get("verdict", ""),
                "policy": _target_policy_cell(target),
                "rationale": target.get("rationale", ""),
            }
        )
    return rows


def format_export_preflight_lines(report: Mapping[str, Any]) -> list[str]:
    """Render the headline of an export pre-flight report (everything but the table).

    Args:
        report: The parsed ``ExportPreflightReport``.

    Returns:
        Lines for stdout: the resolved revision, the source lint verdict, the style guide,
        the capability demand, and the ranking fingerprint.
    """
    lines: list[str] = []
    label = report.get("version_label") or report.get("version") or report.get("version_record_id")
    source_format = report.get("format") or "unknown"
    paradigm = report.get("paradigm")
    descriptor = f"{source_format}"
    if isinstance(paradigm, str) and paradigm.strip():
        descriptor += f", {paradigm.strip()}"
    lines.append(f"Export pre-flight: {report.get('artifact', '?')} @ {label} ({descriptor})")

    lines.extend(format_lint_lines(report.get("lint"), subject="Source lint"))
    lines.extend(format_style_guide_line(report.get("style_guide")))

    demand = report.get("capability_demand")
    if isinstance(demand, list) and demand:
        lines.append(f"Capability demand: {', '.join(str(axis) for axis in demand)}")

    fingerprint = report.get("ranking_fingerprint")
    if isinstance(fingerprint, str) and fingerprint:
        lines.append(f"Ranking fingerprint: {fingerprint}")
    return lines


def format_blocked_target_lines(report: Mapping[str, Any]) -> list[str]:
    """Render the policy verdict of every blocked target, with its waiver reference.

    A blocked target is ranked and returned rather than hidden, so the caller is told which
    targets policy refuses and why — and, when a waiver has already been honoured elsewhere,
    that it was waived rather than silently allowed.
    """
    targets = report.get("targets")
    if not isinstance(targets, list):
        return []
    lines: list[str] = []
    for target in targets:
        if not isinstance(target, Mapping):
            continue
        if str(target.get("band", "")).strip().lower() != "blocked":
            continue
        lines.append(f"Blocked target {target.get('key', '?')}:")
        lines.extend(
            f"  {line}" for line in format_policy_lines(target.get("policy"), scope="export")
        )
    return lines
