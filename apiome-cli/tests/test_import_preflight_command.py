"""End-to-end tests for ``apiome import preflight`` against a mocked API (IXH-2.6, #5101)."""

from __future__ import annotations

import base64
import json
from pathlib import Path

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
_PREFLIGHT_URL = f"{_BASE}/v1/tenants/acme-corp/import/preflight"

_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Payments API", "version": "1.0.0"},
    "paths": {},
}


@pytest.fixture(autouse=True)
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


@pytest.fixture
def spec_file(tmp_path: Path) -> Path:
    path = tmp_path / "payments.json"
    path.write_text(json.dumps(_SPEC), encoding="utf-8")
    return path


def _report(
    *,
    ok: bool = True,
    score: int = 88,
    grade: str = "B",
    severity_counts: dict | None = None,
    findings: list[dict] | None = None,
    policy: dict | None = None,
    error: dict | None = None,
) -> dict:
    return {
        "ok": ok,
        "detection": {
            "adapter_key": "openapi",
            "requested_adapter_key": None,
            "detected_adapter_key": "openapi",
            "detected_format": "openapi-3.1",
            "confidence": 0.98,
            "reason": "openapi: 3.1.0",
            "matched": True,
            "importable": True,
            "ambiguous": False,
            "agrees_with_request": True,
            "archive_root": None,
            "archive_members": [],
        },
        "routing": {"target": "project", "reason": "Document declares paths."},
        "paradigm": "rest",
        "format": "openapi-3.1",
        "counts": {"services": 1, "operations": 4, "types": 9, "channels": 0},
        "fingerprint": "sha256:deadbeef",
        "lint": None
        if not ok
        else {
            "score": score,
            "grade": grade,
            "report_fingerprint": "lintfp",
            "severity_counts": severity_counts or {"warning": 2},
            "rule_hits": {"naming.operation-id": 2},
            "categories": [],
            "findings": findings
            or [
                {
                    "rank": 1,
                    "id": "f1",
                    "rule": "naming.operation-id",
                    "severity": "warning",
                    "category": "naming",
                    "message": "operationId is missing.",
                    "path": "/paths/~1pay/post",
                    "weight": 2.0,
                    "rule_penalty": 4.0,
                    "remediation": "Add an operationId.",
                    "docs_url": None,
                }
            ],
        },
        "style_guide": {
            "guide_id": None,
            "name": "Apiome defaults",
            "source": "fallback",
            "fingerprint": "guidefp0123456789",
        },
        "policy": policy
        or {
            "verdict": "pass",
            "blocking": False,
            "source": "default",
            "reason": "No quality policy configured.",
            "threshold_score": None,
            "allow_override": True,
            "scope": "import",
            "format_key": "openapi",
            "min_grade": None,
            "block_on_severity": None,
            "enforcement": "advisory",
            "failures": [],
            "override_roles": [],
            "policy_version_id": None,
            "policy_content_fingerprint": None,
            "waiver_id": None,
            "waiver_expires_at": None,
        },
        "secret_scrub": None,
        "error": error,
        "cache": {"hit": False, "key": "k", "content_hash": "0123456789abcdef0123"},
    }


def _mock_preflight(httpx_mock: object, payload: dict) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_PREFLIGHT_URL, method="POST", json=payload
    )


def test_preflight_prints_a_readable_report(httpx_mock: object, spec_file: Path) -> None:
    _mock_preflight(httpx_mock, _report())
    result = runner.invoke(app, ["import", "preflight", str(spec_file)])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert "Pre-flight: OK (openapi-3.1 via openapi, confidence 0.98)" in result.stdout
    assert "Lint: 88/100 (grade B)" in result.stdout
    assert "Policy (import): pass" in result.stdout
    assert "naming.operation-id" in result.stdout


def test_preflight_json_mode_emits_the_report_verbatim(
    httpx_mock: object, spec_file: Path
) -> None:
    """AC-1: ``--json`` is the API's report, byte-for-byte in structure."""
    payload = _report()
    _mock_preflight(httpx_mock, payload)
    result = runner.invoke(app, ["--json", "import", "preflight", str(spec_file)])
    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout) == payload


def test_preflight_sends_the_document_and_hints(httpx_mock: object, spec_file: Path) -> None:
    _mock_preflight(httpx_mock, _report())
    result = runner.invoke(
        app,
        ["import", "preflight", "--file", str(spec_file), "--format", "openapi", "--target", "project"],
    )
    assert result.exit_code == EXIT_SUCCESS
    request = httpx_mock.get_requests()[-1]  # type: ignore[attr-defined]
    body = json.loads(request.content)
    assert base64.b64decode(body["document_base64"]) == spec_file.read_bytes()
    assert body["source_kind"] == "openapi"
    assert body["import_target"] == "project"
    assert body["filename"] == "payments.json"
    assert body["input_kind"] == "file"
    assert "url" not in body


def test_preflight_min_grade_exits_quality_gate(httpx_mock: object, spec_file: Path) -> None:
    """AC-2: the threshold code is distinct from transport (1) and usage/auth (2)."""
    _mock_preflight(httpx_mock, _report(score=61, grade="D"))
    result = runner.invoke(app, ["import", "preflight", str(spec_file), "--min-grade", "B"])
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "--min-grade B: grade is D." in result.stderr


def test_preflight_fail_on_exits_quality_gate(httpx_mock: object, spec_file: Path) -> None:
    _mock_preflight(httpx_mock, _report(severity_counts={"error": 1, "warning": 2}))
    result = runner.invoke(app, ["import", "preflight", str(spec_file), "--fail-on", "error"])
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "--fail-on error: 1 finding at or above error." in result.stderr


def test_preflight_policy_block_exits_policy_blocked(
    httpx_mock: object, spec_file: Path
) -> None:
    _mock_preflight(
        httpx_mock,
        _report(
            score=54,
            grade="F",
            policy={
                "verdict": "block",
                "blocking": True,
                "source": "tenant",
                "reason": "Score 54 is below the required 80.",
                "threshold_score": 80,
                "allow_override": True,
                "scope": "import",
                "format_key": "openapi",
                "min_grade": "C",
                "block_on_severity": None,
                "enforcement": "block",
                "failures": [{"kind": "score", "required": 80, "actual": 54}],
                "override_roles": ["owner"],
                "policy_version_id": "pv1",
                "policy_content_fingerprint": "pfp",
                "waiver_id": None,
                "waiver_expires_at": None,
            },
        ),
    )
    result = runner.invoke(app, ["import", "preflight", str(spec_file)])
    assert result.exit_code == EXIT_POLICY_BLOCKED
    assert "Quality policy blocks this import" in result.stderr
    assert "Missed floor: score requires 80, actual 54" in result.stdout


def test_preflight_reports_a_waiver_rather_than_passing_silently(
    httpx_mock: object, spec_file: Path
) -> None:
    """AC-4: a waived shortfall passes, but the waiver reference is on the report."""
    _mock_preflight(
        httpx_mock,
        _report(
            score=71,
            grade="C",
            policy={
                "verdict": "warn",
                "blocking": False,
                "source": "tenant",
                "reason": "Score 71 is below the required 80; waived.",
                "threshold_score": 80,
                "allow_override": True,
                "scope": "import",
                "format_key": "openapi",
                "min_grade": None,
                "block_on_severity": None,
                "enforcement": "block",
                "failures": [{"kind": "score", "required": 80, "actual": 71}],
                "override_roles": [],
                "policy_version_id": "pv1",
                "policy_content_fingerprint": "pfp",
                "waiver_id": "wv-42",
                "waiver_expires_at": "2026-09-01T00:00:00Z",
            },
        ),
    )
    result = runner.invoke(app, ["import", "preflight", str(spec_file)])
    assert result.exit_code == EXIT_SUCCESS
    assert "Waived by waiver wv-42 (expires 2026-09-01T00:00:00Z)" in result.stdout
    assert "Waived floor: score requires 80, actual 71" in result.stdout


def test_preflight_unimportable_candidate_exits_five(
    httpx_mock: object, spec_file: Path
) -> None:
    _mock_preflight(
        httpx_mock,
        _report(
            ok=False,
            error={
                "code": "FORMAT_MISMATCH",
                "category": "format",
                "message": "No adapter recognized this document.",
                "remediation": "Name the format with --format.",
                "retriable": False,
            },
        ),
    )
    result = runner.invoke(app, ["import", "preflight", str(spec_file)])
    assert result.exit_code == EXIT_PREFLIGHT_UNUSABLE
    assert "Pre-flight: NOT IMPORTABLE" in result.stdout
    assert "Error: FORMAT_MISMATCH" in result.stdout
    assert "Candidate is not importable" in result.stderr


def test_preflight_rejects_an_off_ladder_min_grade(spec_file: Path) -> None:
    """A typo must exit as usage (2), never as a quality failure."""
    result = runner.invoke(app, ["import", "preflight", str(spec_file), "--min-grade", "E"])
    assert result.exit_code == EXIT_USAGE
    assert "--min-grade" in result.stderr


def test_preflight_rejects_an_off_ladder_fail_on(spec_file: Path) -> None:
    result = runner.invoke(app, ["import", "preflight", str(spec_file), "--fail-on", "fatal"])
    assert result.exit_code == EXIT_USAGE


def test_preflight_rejects_an_unknown_target(spec_file: Path) -> None:
    result = runner.invoke(app, ["import", "preflight", str(spec_file), "--target", "nowhere"])
    assert result.exit_code == EXIT_USAGE


def test_preflight_requires_exactly_one_input(spec_file: Path) -> None:
    assert runner.invoke(app, ["import", "preflight"]).exit_code == EXIT_USAGE
    both = runner.invoke(
        app, ["import", "preflight", str(spec_file), "--file", str(spec_file)]
    )
    assert both.exit_code == EXIT_USAGE
