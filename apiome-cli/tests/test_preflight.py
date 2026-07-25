"""Unit tests for the pure pre-flight gate + rendering helpers (IXH-2.6, #5101)."""

from __future__ import annotations

import pytest

from apiome_cli.exit_codes import (
    EXIT_POLICY_BLOCKED,
    EXIT_PREFLIGHT_UNUSABLE,
    EXIT_QUALITY_GATE,
    EXIT_SUCCESS,
)
from apiome_cli.preflight import (
    GRADE_ORDER,
    SEVERITY_ORDER,
    PreflightFlagError,
    evaluate_export_gate,
    evaluate_import_gate,
    export_target_rows,
    finding_overflow,
    finding_rows,
    format_blocked_target_lines,
    format_export_preflight_lines,
    format_import_preflight_lines,
    format_policy_lines,
    gating_requested,
    grade_meets_minimum,
    normalize_fail_on,
    normalize_min_grade,
    selectable_targets,
    severity_count_at_or_above,
    waiver_reference,
)


def _lint(
    *,
    score: int | None = 82,
    grade: str | None = "B",
    errors: int = 0,
    warnings: int = 0,
    infos: int = 0,
    findings: list[dict] | None = None,
) -> dict:
    counts = {}
    if errors:
        counts["error"] = errors
    if warnings:
        counts["warning"] = warnings
    if infos:
        counts["info"] = infos
    return {
        "score": score,
        "grade": grade,
        "report_fingerprint": "lintfp",
        "severity_counts": counts,
        "rule_hits": {},
        "categories": [],
        "findings": findings or [],
    }


def _policy(
    *,
    verdict: str = "pass",
    blocking: bool = False,
    reason: str = "All quality floors met.",
    failures: list[dict] | None = None,
    waiver_id: str | None = None,
    waiver_expires_at: str | None = None,
    scope: str = "import",
) -> dict:
    return {
        "verdict": verdict,
        "blocking": blocking,
        "source": "tenant",
        "reason": reason,
        "enforcement": "block" if blocking else "advisory",
        "scope": scope,
        "failures": failures or [],
        "waiver_id": waiver_id,
        "waiver_expires_at": waiver_expires_at,
    }


def _import_report(
    *,
    ok: bool = True,
    lint: dict | None = None,
    policy: dict | None = None,
    error: dict | None = None,
) -> dict:
    return {
        "ok": ok,
        "detection": {
            "adapter_key": "openapi",
            "detected_adapter_key": "openapi",
            "detected_format": "openapi-3.1",
            "confidence": 0.98,
            "matched": True,
            "importable": True,
            "ambiguous": False,
            "agrees_with_request": True,
            "archive_members": [],
        },
        "routing": {"target": "project", "reason": "Document declares paths."},
        "paradigm": "rest",
        "format": "openapi-3.1",
        "counts": {"services": 1, "operations": 12, "types": 30, "channels": 0},
        "fingerprint": "sha256:abc",
        "lint": _lint() if lint is None else lint,
        "style_guide": {
            "guide_id": None,
            "name": "Apiome defaults",
            "source": "fallback",
            "fingerprint": "guidefp0123456789",
        },
        "policy": _policy() if policy is None else policy,
        "error": error,
        "cache": {"hit": False, "key": "k", "content_hash": "0123456789abcdef0123"},
    }


def _target(
    *,
    key: str = "openapi",
    rank: int = 1,
    band: str = "ready",
    readiness: int = 91,
    policy: dict | None = None,
) -> dict:
    return {
        "rank": rank,
        "key": key,
        "format": f"{key}-1.0",
        "descriptor": {},
        "capability_profile": {},
        "readiness": readiness,
        "band": band,
        "blocked": band == "blocked",
        "selectable": band in {"ready", "caution"},
        "rationale": "Everything survives.",
        "fidelity": {"summary": {"tier": "lossless", "preserved_percent": 100.0}},
        "capability": {"verdict": "full", "required": [], "supported": [], "missing": []},
        "policy": _policy(scope="export") if policy is None else policy,
    }


def _export_report(*, targets: list[dict] | None = None, lint: dict | None = None) -> dict:
    return {
        "artifact": "aaaa",
        "version": "1.0.0",
        "version_record_id": "bbbb",
        "version_label": "1.0.0",
        "paradigm": "rest",
        "format": "openapi-3.1",
        "lint": _lint() if lint is None else lint,
        "style_guide": {
            "guide_id": None,
            "name": "Apiome defaults",
            "source": "fallback",
            "fingerprint": "guidefp",
        },
        "capability_demand": ["operations", "constraints"],
        "targets": [_target()] if targets is None else targets,
        "ranking_fingerprint": "rankfp",
    }


# ---------------------------------------------------------------------------
# Flag validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["a", "B", " c ", "D", "f"])
def test_normalize_min_grade_accepts_the_ladder(value: str) -> None:
    assert normalize_min_grade(value) in GRADE_ORDER


def test_normalize_min_grade_rejects_off_ladder() -> None:
    with pytest.raises(PreflightFlagError) as excinfo:
        normalize_min_grade("E")
    assert excinfo.value.param_hint == "--min-grade"


@pytest.mark.parametrize("value", ["ERROR", "warning", " info "])
def test_normalize_fail_on_accepts_the_ladder(value: str) -> None:
    assert normalize_fail_on(value) in SEVERITY_ORDER


def test_normalize_fail_on_rejects_off_ladder() -> None:
    with pytest.raises(PreflightFlagError) as excinfo:
        normalize_fail_on("critical")
    assert excinfo.value.param_hint == "--fail-on"


def test_normalize_passes_none_through() -> None:
    assert normalize_min_grade(None) is None
    assert normalize_fail_on(None) is None


def test_gating_requested_only_when_a_flag_is_present() -> None:
    assert gating_requested(min_grade=None, fail_on=None) is False
    assert gating_requested(min_grade="B", fail_on=None) is True
    assert gating_requested(min_grade=None, fail_on="error") is True


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def test_grade_meets_minimum_orders_a_best_f_worst() -> None:
    assert grade_meets_minimum("A", "B") is True
    assert grade_meets_minimum("B", "B") is True
    assert grade_meets_minimum("C", "B") is False


def test_unknown_or_missing_grade_ranks_worst() -> None:
    assert grade_meets_minimum(None, "F") is False
    assert grade_meets_minimum("Z", "F") is False


def test_severity_count_at_or_above_sums_worse_severities() -> None:
    lint = _lint(errors=2, warnings=5, infos=9)
    assert severity_count_at_or_above(lint, "error") == 2
    assert severity_count_at_or_above(lint, "warning") == 7
    assert severity_count_at_or_above(lint, "info") == 16


def test_severity_count_tolerates_a_missing_verdict() -> None:
    assert severity_count_at_or_above(None, "error") == 0
    assert severity_count_at_or_above({}, "warning") == 0


def test_waiver_reference_renders_id_and_expiry() -> None:
    reference = waiver_reference(
        _policy(waiver_id="w-1", waiver_expires_at="2026-08-01T00:00:00Z")
    )
    assert reference == "waiver w-1 (expires 2026-08-01T00:00:00Z)"


def test_waiver_reference_is_none_when_unwaived() -> None:
    assert waiver_reference(_policy()) is None
    assert waiver_reference(None) is None


# ---------------------------------------------------------------------------
# Import gate
# ---------------------------------------------------------------------------


def test_import_gate_passes_a_clean_report() -> None:
    outcome = evaluate_import_gate(_import_report())
    assert outcome.exit_code == EXIT_SUCCESS
    assert outcome.failed is False
    assert outcome.reasons == []


def test_import_gate_min_grade_exits_quality_gate() -> None:
    outcome = evaluate_import_gate(
        _import_report(lint=_lint(score=61, grade="D")), min_grade="B"
    )
    assert outcome.exit_code == EXIT_QUALITY_GATE
    assert "--min-grade B: grade is D." in outcome.reasons


def test_import_gate_fail_on_counts_at_or_above_threshold() -> None:
    outcome = evaluate_import_gate(
        _import_report(lint=_lint(errors=0, warnings=3)), fail_on="warning"
    )
    assert outcome.exit_code == EXIT_QUALITY_GATE
    assert "--fail-on warning: 3 findings at or above warning." in outcome.reasons


def test_import_gate_fail_on_error_passes_when_only_warnings() -> None:
    outcome = evaluate_import_gate(_import_report(lint=_lint(warnings=4)), fail_on="error")
    assert outcome.exit_code == EXIT_SUCCESS


def test_import_gate_policy_block_takes_precedence_over_threshold() -> None:
    report = _import_report(
        lint=_lint(score=40, grade="F"),
        policy=_policy(
            verdict="block",
            blocking=True,
            reason="Score 40 is below the required 80.",
            failures=[{"kind": "score", "required": 80, "actual": 40}],
        ),
    )
    outcome = evaluate_import_gate(report, min_grade="B")
    assert outcome.exit_code == EXIT_POLICY_BLOCKED
    # Both reasons are still reported so CI logs name every gate that tripped.
    assert any("Quality policy blocks this import" in reason for reason in outcome.reasons)
    assert any("--min-grade B" in reason for reason in outcome.reasons)


def test_import_gate_waived_policy_does_not_block() -> None:
    """A waiver downgrades the verdict server-side, so the gate passes — visibly."""
    report = _import_report(
        policy=_policy(
            verdict="warn",
            blocking=False,
            reason="Score floor missed; waived.",
            failures=[{"kind": "score", "required": 90, "actual": 82}],
            waiver_id="w-9",
            waiver_expires_at="2026-09-01T00:00:00Z",
        )
    )
    assert evaluate_import_gate(report).exit_code == EXIT_SUCCESS
    lines = format_import_preflight_lines(report)
    assert "  Waived by waiver w-9 (expires 2026-09-01T00:00:00Z)" in lines
    assert "  Waived floor: score requires 90, actual 82" in lines


def test_import_gate_waiver_does_not_relax_caller_threshold() -> None:
    """A tenant waiver cannot lower a bar the pipeline set for itself."""
    report = _import_report(
        lint=_lint(score=61, grade="D"),
        policy=_policy(verdict="warn", blocking=False, waiver_id="w-9"),
    )
    outcome = evaluate_import_gate(report, min_grade="B")
    assert outcome.exit_code == EXIT_QUALITY_GATE


def test_import_gate_unusable_candidate_exits_five() -> None:
    report = _import_report(
        ok=False,
        lint=None,
        error={
            "code": "FORMAT_MISMATCH",
            "category": "format",
            "message": "No adapter recognized this document.",
            "remediation": "Name the format with --format.",
            "retriable": False,
        },
    )
    outcome = evaluate_import_gate(report, min_grade="A", fail_on="error")
    assert outcome.exit_code == EXIT_PREFLIGHT_UNUSABLE
    assert outcome.reasons == [
        "Candidate is not importable — FORMAT_MISMATCH: No adapter recognized this document."
    ]


# ---------------------------------------------------------------------------
# Export gate
# ---------------------------------------------------------------------------


def test_export_gate_passes_when_a_target_is_selectable() -> None:
    report = _export_report(
        targets=[_target(band="ready"), _target(key="protobuf", rank=2, band="blocked")]
    )
    assert evaluate_export_gate(report).exit_code == EXIT_SUCCESS


def test_export_gate_blocks_when_every_target_is_blocked() -> None:
    report = _export_report(
        targets=[
            _target(band="blocked"),
            _target(key="protobuf", rank=2, band="blocked"),
        ]
    )
    outcome = evaluate_export_gate(report)
    assert outcome.exit_code == EXIT_POLICY_BLOCKED
    assert outcome.reasons[0] == (
        "Quality policy blocks every ranked target — openapi, protobuf."
    )


def test_export_gate_unusable_when_every_target_is_unavailable() -> None:
    report = _export_report(targets=[_target(band="unavailable")])
    outcome = evaluate_export_gate(report)
    assert outcome.exit_code == EXIT_PREFLIGHT_UNUSABLE
    assert outcome.reasons == ["No ranked export target can run in this deployment."]


def test_export_gate_unusable_when_nothing_was_ranked() -> None:
    outcome = evaluate_export_gate(_export_report(targets=[]))
    assert outcome.exit_code == EXIT_PREFLIGHT_UNUSABLE


def test_export_gate_applies_thresholds_to_the_source_lint() -> None:
    report = _export_report(lint=_lint(score=55, grade="D", errors=1))
    outcome = evaluate_export_gate(report, min_grade="B", fail_on="error")
    assert outcome.exit_code == EXIT_QUALITY_GATE
    assert len(outcome.reasons) == 2


def test_selectable_targets_excludes_blocked_and_unavailable() -> None:
    report = _export_report(
        targets=[
            _target(band="ready"),
            _target(key="a", band="caution"),
            _target(key="b", band="blocked"),
            _target(key="c", band="unavailable"),
        ]
    )
    assert [item["key"] for item in selectable_targets(report)] == ["openapi", "a"]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_import_headline_reports_ok_and_detection() -> None:
    lines = format_import_preflight_lines(_import_report())
    assert lines[0] == "Pre-flight: OK (openapi-3.1 via openapi, confidence 0.98)"
    assert "Counts: 1 services, 12 operations, 30 types, 0 channels" in lines
    assert "Lint: 82/100 (grade B)" in lines
    assert "Cache: miss (sha256 0123456789abcdef)" in lines


def test_import_headline_reports_the_intake_error() -> None:
    lines = format_import_preflight_lines(
        _import_report(
            ok=False,
            error={"code": "INPUT_TOO_LARGE", "message": "Too big.", "remediation": "Split it."},
        )
    )
    assert lines[0].startswith("Pre-flight: NOT IMPORTABLE")
    assert "Error: INPUT_TOO_LARGE — Too big." in lines
    assert "  Remediation: Split it." in lines


def test_import_headline_flags_a_detection_disagreement() -> None:
    report = _import_report()
    report["detection"]["agrees_with_request"] = False
    report["detection"]["requested_adapter_key"] = "asyncapi"
    lines = format_import_preflight_lines(report)
    assert any("Detection disagrees with --format asyncapi" in line for line in lines)


def test_policy_lines_label_unwaived_floors_as_missed() -> None:
    lines = format_policy_lines(
        _policy(
            verdict="block",
            blocking=True,
            failures=[{"kind": "grade", "required": "B", "actual": "D"}],
        ),
        scope="import",
    )
    assert lines[0].startswith("Policy (import): block")
    assert "  Missed floor: grade requires B, actual D" in lines


def test_finding_rows_are_capped_and_overflow_is_counted() -> None:
    findings = [
        {
            "rank": index + 1,
            "rule": f"rule-{index}",
            "severity": "warning",
            "message": "m",
            "path": "/p",
            "weight": 1.0,
            "rule_penalty": 1.0,
        }
        for index in range(20)
    ]
    lint = _lint(findings=findings, warnings=20)
    assert len(finding_rows(lint)) == 15
    assert finding_overflow(lint) == 5


def test_finding_rows_tolerate_a_report_without_findings() -> None:
    assert finding_rows(None) == []
    assert finding_overflow(_lint()) == 0


def test_export_headline_and_rows() -> None:
    report = _export_report()
    lines = format_export_preflight_lines(report)
    assert lines[0] == "Export pre-flight: aaaa @ 1.0.0 (openapi-3.1, rest)"
    assert "Source lint: 82/100 (grade B)" in lines
    assert "Capability demand: operations, constraints" in lines
    assert "Ranking fingerprint: rankfp" in lines

    rows = export_target_rows(report)
    assert rows[0]["key"] == "openapi"
    assert rows[0]["fidelity"] == "lossless 100%"
    assert rows[0]["capability"] == "full"
    assert rows[0]["policy"] == "pass"


def test_export_target_policy_cell_marks_a_waiver() -> None:
    report = _export_report(
        targets=[_target(policy=_policy(verdict="warn", scope="export", waiver_id="w-2"))]
    )
    assert export_target_rows(report)[0]["policy"] == "warn (waived)"


def test_blocked_target_lines_name_the_target_and_its_reason() -> None:
    report = _export_report(
        targets=[
            _target(
                band="blocked",
                policy=_policy(
                    verdict="block",
                    blocking=True,
                    reason="Source grade D is below the required B.",
                    failures=[{"kind": "grade", "required": "B", "actual": "D"}],
                    scope="export",
                ),
            )
        ]
    )
    lines = format_blocked_target_lines(report)
    assert lines[0] == "Blocked target openapi:"
    assert any("Source grade D is below the required B." in line for line in lines)
    assert any("Missed floor: grade requires B, actual D" in line for line in lines)


def test_blocked_target_lines_are_empty_when_nothing_is_blocked() -> None:
    assert format_blocked_target_lines(_export_report()) == []
