"""Human-readable rendering for the ``lint`` command (quality score + findings)."""

from __future__ import annotations

from typing import Any

import typer

from apiome_cli.output import ListColumn, emit_json, emit_list_table

#: Letter grades ordered best-to-worst for ``--min-grade`` comparisons.
GRADE_ORDER = ("A", "B", "C", "D", "F")


def grade_rank(grade: str | None) -> int:
    """Return the rank of ``grade`` (0 = best).

    An unknown, empty, or missing grade ranks **worst** — an unscored report must never
    satisfy a ``--min-grade`` gate by being absent.
    """
    normalized = (grade or "").strip().upper()
    return GRADE_ORDER.index(normalized) if normalized in GRADE_ORDER else len(GRADE_ORDER)


def grade_meets_minimum(grade: str | None, minimum: str) -> bool:
    """True when ``grade`` is at least as good as ``minimum`` (A best, F worst)."""
    return grade_rank(grade) <= grade_rank(minimum)


def _severity_sort_key(finding: dict[str, Any]) -> tuple[int, str, str]:
    order = {"error": 0, "warning": 1, "info": 2}
    severity = str(finding.get("severity", ""))
    return (order.get(severity, 3), str(finding.get("path", "")), str(finding.get("rule", "")))


def failed_policy_gates(gate_results: dict[str, Any]) -> list[str]:
    """Return gate names whose ``passed`` flag is explicitly false."""
    failed: list[str] = []
    for name, result in gate_results.items():
        if isinstance(result, dict) and result.get("passed") is False:
            failed.append(str(name))
    return sorted(failed)


def policy_evaluation_passed(policy: dict[str, Any]) -> bool:
    """True when the policy payload's ``evaluation.passed`` is true."""
    evaluation = policy.get("evaluation")
    return isinstance(evaluation, dict) and evaluation.get("passed") is True


def emit_lint_policy_summary(policy: dict[str, Any]) -> None:
    """Print a short human summary of a lint policy evaluation."""
    evaluation = policy.get("evaluation") if isinstance(policy.get("evaluation"), dict) else {}
    passed = evaluation.get("passed")
    gate_results = evaluation.get("gateResults")
    gate_results = gate_results if isinstance(gate_results, dict) else {}

    policy_version = policy.get("policyVersion")
    policy_version = policy_version if isinstance(policy_version, dict) else {}
    version_label = policy_version.get("id") or evaluation.get("policyVersionId") or "?"

    status = "yes" if passed is True else "no"
    typer.echo(f"Policy evaluation: passed {status} (policyVersion {version_label})")
    failed = failed_policy_gates(gate_results)
    if failed:
        typer.echo(f"Failed gates: {', '.join(failed)}")
    typer.echo("")


def emit_lint_command_output(
    *,
    json_mode: bool,
    report: dict[str, Any],
    policy: dict[str, Any] | None,
    fail_on_policy: bool,
) -> None:
    """Render lint report output, optionally bundling policy in JSON mode."""
    if json_mode:
        if fail_on_policy and policy is not None:
            emit_json({"lint": report, "policy": policy})
        else:
            emit_json(report)
        return

    emit_lint_report(report)
    if fail_on_policy and policy is not None:
        emit_lint_policy_summary(policy)


def lint_command_should_fail(
    report: dict[str, Any],
    *,
    min_grade: str | None,
    policy: dict[str, Any] | None,
    fail_on_policy: bool,
) -> bool:
    """True when ``--min-grade`` or ``--fail-on-policy`` gates should exit non-zero."""
    if min_grade is not None and not grade_meets_minimum(str(report.get("grade", "")), min_grade):
        return True
    return fail_on_policy and policy is not None and not policy_evaluation_passed(policy)


def gate_should_fail(gate: dict[str, Any]) -> bool:
    """True when a lint gate payload's CI verdict failed (``gate.passed`` not true).

    This is the ONLY condition that exits ``apiome lint gate`` non-zero: the verdict already
    reflects the pack's configured ``ciOutcomes`` toggles, so an unconfigured gate (or plain
    findings without policy failures) never breaks CI (#4860 AC-1).
    """
    verdict = gate.get("gate")
    return not (isinstance(verdict, dict) and verdict.get("passed") is True)


def emit_gate_output(*, json_mode: bool, gate: dict[str, Any]) -> None:
    """Render a lint gate payload: full JSON in json mode, else a human summary."""
    if json_mode:
        emit_json(gate)
        return

    verdict = gate.get("gate") if isinstance(gate.get("gate"), dict) else {}
    counts = gate.get("counts") if isinstance(gate.get("counts"), dict) else {}
    policy = gate.get("policy") if isinstance(gate.get("policy"), dict) else {}
    status = "PASSED" if verdict.get("passed") is True else "FAILED"
    scope = " (new findings only)" if gate.get("newOnly") else ""
    typer.echo(f"Lint gate: {status}{scope}")
    typer.echo(f"Policy pack: {policy.get('policyVersionId') or '?'}")
    if gate.get("baselineSubjectId"):
        typer.echo(f"Baseline: {gate['baselineSubjectId']}")
    typer.echo(
        "Findings: "
        f"{counts.get('total', 0)} total, "
        f"{counts.get('new', 0)} new, "
        f"{counts.get('unwaivedErrors', 0)} unwaived errors, "
        f"{counts.get('waived', 0)} waived"
    )
    gate_results = verdict.get("gateResults")
    failed = failed_policy_gates(gate_results if isinstance(gate_results, dict) else {})
    if failed:
        typer.echo(f"Failed gates: {', '.join(failed)}")
    links = gate.get("links") if isinstance(gate.get("links"), dict) else {}
    for name in ("evidence", "policy", "workspace"):
        if links.get(name):
            typer.echo(f"{name.capitalize()}: {links[name]}")


def emit_lint_report(report: dict[str, Any]) -> None:
    """Render a lint report as a summary header plus a findings table."""
    score = report.get("score")
    grade = report.get("grade", "?")
    version_label = report.get("versionId", "")
    severity = report.get("severityCounts") or {}

    typer.echo(f"Quality score: {score}/100  (grade {grade})")
    if version_label:
        typer.echo(f"Version: {version_label}")
    typer.echo(
        "Findings: "
        f"{severity.get('error', 0)} error, "
        f"{severity.get('warning', 0)} warning, "
        f"{severity.get('info', 0)} info"
    )
    compatibility_overall = report.get("compatibilityOverall")
    if compatibility_overall:
        base = report.get("baseRevisionId") or ""
        typer.echo(f"Compatibility vs {base}: {compatibility_overall}")

    # MFI-4.4: when the persisted (import-time) score is out of date relative to this live
    # recompute, surface the stored score so a CI run can see the drift.
    if report.get("scoreIsStale"):
        captured_score = report.get("capturedScore")
        captured_grade = report.get("capturedGrade")
        typer.echo(
            f"Stored score: {captured_score}/100  (grade {captured_grade}) — out of date; "
            "showing live recompute above."
        )
    typer.echo("")

    findings = list(report.get("findings") or [])
    findings.sort(key=_severity_sort_key)
    columns: tuple[ListColumn, ...] = (
        ("Severity", "severity", None),
        ("Rule", "rule", None),
        ("Path", "path", None),
        ("Message", "message", None),
    )
    emit_list_table(
        findings,
        columns,
        total=len(findings),
        empty_message="No findings — clean bill of health.",
        min_width=120,
    )
