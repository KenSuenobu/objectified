"""End-to-end tests for ``apiome export preflight`` against a mocked API (IXH-2.6, #5101)."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import (
    EXIT_POLICY_BLOCKED,
    EXIT_PREFLIGHT_UNUSABLE,
    EXIT_QUALITY_GATE,
    EXIT_SUCCESS,
    EXIT_USAGE,
)
from apiome_cli.main import app

runner = CliRunner()

_BASE = "http://localhost:8000"
_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_PROJECT = {"id": _PROJECT_ID, "name": "Payments API", "slug": "payments-api", "enabled": True}
_PROJECT_URL = f"{_BASE}/v1/projects/acme-corp/by-slug/payments-api"
_PREFLIGHT_URL = f"{_BASE}/v1/tenants/acme-corp/export/preflight"


@pytest.fixture(autouse=True)
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _policy(
    *,
    verdict: str = "pass",
    blocking: bool = False,
    reason: str = "No export quality policy configured.",
    failures: list[dict] | None = None,
    waiver_id: str | None = None,
) -> dict:
    return {
        "verdict": verdict,
        "blocking": blocking,
        "source": "default",
        "reason": reason,
        "threshold_score": None,
        "allow_override": True,
        "scope": "export",
        "format_key": "openapi",
        "min_grade": None,
        "block_on_severity": None,
        "enforcement": "block" if blocking else "advisory",
        "failures": failures or [],
        "override_roles": [],
        "policy_version_id": None,
        "policy_content_fingerprint": None,
        "waiver_id": waiver_id,
        "waiver_expires_at": None,
    }


def _target(
    *,
    key: str = "openapi",
    rank: int = 1,
    band: str = "ready",
    readiness: int = 94,
    tier: str = "lossless",
    preserved: float = 100.0,
    policy: dict | None = None,
) -> dict:
    return {
        "rank": rank,
        "key": key,
        "format": f"{key}-3.1",
        "descriptor": {"key": key, "format": f"{key}-3.1", "label": key.title()},
        "capability_profile": {},
        "readiness": readiness,
        "band": band,
        "blocked": band == "blocked",
        "selectable": band in {"ready", "caution"},
        "rationale": "Every construct survives the trip.",
        "fidelity": {"summary": {"tier": tier, "preserved_percent": preserved}},
        "capability": {
            "verdict": "full",
            "required": ["operations"],
            "supported": ["operations"],
            "missing": [],
            "synthesized": [],
            "reason": "The target declares every axis this source uses.",
        },
        "policy": policy or _policy(),
    }


def _report(
    *,
    score: int = 88,
    grade: str = "B",
    severity_counts: dict | None = None,
    targets: list[dict] | None = None,
) -> dict:
    return {
        "artifact": _PROJECT_ID,
        "version": "1.0.0",
        "version_record_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "version_label": "1.0.0",
        "paradigm": "rest",
        "format": "openapi-3.1",
        "lint": {
            "score": score,
            "grade": grade,
            "report_fingerprint": "lintfp",
            "severity_counts": severity_counts or {"warning": 1},
            "rule_hits": {},
            "categories": [],
            "findings": [],
        },
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


def _mock_project(httpx_mock: object) -> None:
    httpx_mock.add_response(url=_PROJECT_URL, json=_PROJECT)  # type: ignore[attr-defined]


def _mock_preflight(httpx_mock: object, payload: dict) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_PREFLIGHT_URL, method="POST", json=payload
    )


def _invoke(*extra: str, json_mode: bool = False):
    prefix = ["--json"] if json_mode else []
    return runner.invoke(
        app, [*prefix, "export", "preflight", "--project", "payments-api", *extra]
    )


def test_export_preflight_prints_a_readable_table(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report())
    result = _invoke()
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert f"Export pre-flight: {_PROJECT_ID} @ 1.0.0 (openapi-3.1, rest)" in result.stdout
    assert "Source lint: 88/100 (grade B)" in result.stdout
    assert "openapi" in result.stdout
    assert "lossless" in result.stdout


def test_export_preflight_json_mode_emits_the_report_verbatim(httpx_mock: object) -> None:
    """AC-1: ``--json`` is the API's report, byte-for-byte in structure."""
    payload = _report()
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, payload)
    result = _invoke(json_mode=True)
    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout) == payload


def test_export_preflight_sends_version_and_target_filter(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report())
    result = _invoke("--version", "1.0.0", "--to", "openapi", "--to", "protobuf")
    assert result.exit_code == EXIT_SUCCESS
    body = json.loads(httpx_mock.get_requests()[-1].content)  # type: ignore[attr-defined]
    assert body == {
        "artifact": _PROJECT_ID,
        "version": "1.0.0",
        "targets": ["openapi", "protobuf"],
    }


def test_export_preflight_min_grade_exits_quality_gate(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(score=58, grade="D"))
    result = _invoke("--min-grade", "B")
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "--min-grade B: grade is D." in result.stderr


def test_export_preflight_fail_on_exits_quality_gate(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(severity_counts={"error": 2}))
    result = _invoke("--fail-on", "error")
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "--fail-on error: 2 findings at or above error." in result.stderr


def test_export_preflight_blocked_target_is_ranked_not_hidden(httpx_mock: object) -> None:
    blocked = _target(
        band="blocked",
        readiness=40,
        policy=_policy(
            verdict="block",
            blocking=True,
            reason="Source grade D is below the required B.",
            failures=[{"kind": "grade", "required": "B", "actual": "D"}],
        ),
    )
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(targets=[blocked]))
    result = _invoke()
    assert result.exit_code == EXIT_POLICY_BLOCKED
    assert "Blocked target openapi:" in result.stdout
    assert "Source grade D is below the required B." in result.stdout
    assert "Quality policy blocks every ranked target — openapi." in result.stderr


def test_export_preflight_passes_when_one_target_survives(httpx_mock: object) -> None:
    """A single blocked exotic target must not fail a ranking that still has somewhere to go."""
    targets = [
        _target(band="ready"),
        _target(key="protobuf", rank=2, band="blocked", policy=_policy(verdict="block", blocking=True)),
    ]
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(targets=targets))
    result = _invoke()
    assert result.exit_code == EXIT_SUCCESS
    assert "Blocked target protobuf:" in result.stdout


def test_export_preflight_waived_target_is_marked_waived(httpx_mock: object) -> None:
    """AC-4: a waived export verdict shows as waived rather than as a clean pass."""
    waived = _target(policy=_policy(verdict="warn", reason="Waived.", waiver_id="wv-7"))
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(targets=[waived]))
    result = _invoke()
    assert result.exit_code == EXIT_SUCCESS
    assert "waived" in result.stdout


def test_export_preflight_unavailable_only_exits_five(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(targets=[_target(band="unavailable")]))
    result = _invoke()
    assert result.exit_code == EXIT_PREFLIGHT_UNUSABLE
    assert "No ranked export target can run in this deployment." in result.stderr


def test_export_preflight_empty_ranking_exits_five(httpx_mock: object) -> None:
    _mock_project(httpx_mock)
    _mock_preflight(httpx_mock, _report(targets=[]))
    result = _invoke()
    assert result.exit_code == EXIT_PREFLIGHT_UNUSABLE
    assert "No export targets were ranked for this revision." in result.stdout


def test_export_preflight_rejects_an_off_ladder_flag() -> None:
    assert _invoke("--min-grade", "E").exit_code == EXIT_USAGE
    assert _invoke("--fail-on", "fatal").exit_code == EXIT_USAGE


def test_export_preflight_requires_a_project() -> None:
    result = runner.invoke(app, ["export", "preflight"])
    assert result.exit_code == EXIT_USAGE
