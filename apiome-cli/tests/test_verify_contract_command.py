"""Tests for ``apiome verify contract`` — ECA-2.2 (#4733).

The CLI executes nothing locally: it posts the run, fetches the export artifact, prints
evidence + failure lines, and maps the stored outcome to an exit code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.client.contract_verify import (
    build_run_request,
    build_suite_options,
    exit_code_for_run,
    format_operation_failure,
    format_run_error,
    non_passing_operations,
    parse_context_pairs,
)
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

pytestmark = pytest.mark.usefixtures("api_key_env")

runner = CliRunner()

_DIGEST = "sha256:" + "a" * 64
_RUN_ID = "33333333-3333-4333-8333-333333333333"
_RUN_URL = (
    "http://localhost:8000/v1/tenants/acme-corp/contracts/project/petstore/1.0.0/run"
)
_EXPORT_JSON_URL = (
    f"http://localhost:8000/v1/tenants/acme-corp/verification-runs/{_RUN_ID}/export"
    "?format=json"
)
_EXPORT_JUNIT_URL = (
    f"http://localhost:8000/v1/tenants/acme-corp/verification-runs/{_RUN_ID}/export"
    "?format=junit"
)


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _run_record(**overrides: Any) -> dict[str, Any]:
    run: dict[str, Any] = {
        "id": _RUN_ID,
        "tenant_id": "acme-corp",
        "suite_digest": _DIGEST,
        "target_slug": "mock",
        "target_environment": "mock",
        "target_network_class": "private",
        "target_base_url": "http://localhost:8775/acme-corp/petstore/1.0.0",
        "runner_name": "apiome-contract-runner",
        "outcome": "passed",
        "counts": {
            "total": 2,
            "passed": 2,
            "failed": 0,
            "errored": 0,
            "skipped": 0,
        },
        "operations": [
            {
                "case_id": "case_ok",
                "operation_key": "GET /pets",
                "outcome": "passed",
            }
        ],
    }
    run.update(overrides)
    return run


def _payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "ok": True,
        "version_ref": "project/petstore/1.0.0",
        "suite_digest": _DIGEST,
        "run": _run_record(),
        "created": True,
    }
    body.update(overrides)
    return body


def _mock_run_and_export(
    httpx_mock: Any,
    *,
    payload: dict[str, Any] | None = None,
    fmt: str = "json",
    artifact: str | None = None,
    status_code: int = 201,
) -> None:
    body = payload if payload is not None else _payload()
    httpx_mock.add_response(url=_RUN_URL, method="POST", json=body, status_code=status_code)
    export_url = _EXPORT_JUNIT_URL if fmt == "junit" else _EXPORT_JSON_URL
    if artifact is None:
        artifact = (
            '<?xml version="1.0"?><testsuite name="contract"/>'
            if fmt == "junit"
            else json.dumps(body.get("run") or {}, sort_keys=True)
        )
    httpx_mock.add_response(url=export_url, method="GET", text=artifact)


def test_parse_context_pairs_accepts_key_value() -> None:
    assert parse_context_pairs(["commit=abc", "branch=main"]) == {
        "commit": "abc",
        "branch": "main",
    }


def test_parse_context_pairs_rejects_bad_entries() -> None:
    with pytest.raises(ValueError, match="KEY=VALUE"):
        parse_context_pairs(["novalue"])
    with pytest.raises(ValueError, match="non-empty key"):
        parse_context_pairs(["=value"])


def test_build_run_request_and_options() -> None:
    options = build_suite_options(
        seed=3,
        examples=True,
        generated=False,
        negative=True,
        operation=["GET /pets"],
        max_operations=10,
    )
    body = build_run_request(
        target_ref="mock",
        options=options,
        idempotency_key="ci-1",
        context={"commit": "abc"},
    )
    assert body == {
        "target_ref": "mock",
        "options": {
            "seed": 3,
            "include_declared_examples": True,
            "include_generated": False,
            "include_negative": True,
            "operations": ["GET /pets"],
            "max_operations": 10,
        },
        "idempotency_key": "ci-1",
        "context": {"commit": "abc"},
    }


def test_exit_code_for_run_gates_on_outcome() -> None:
    assert exit_code_for_run(_payload()) == EXIT_SUCCESS
    assert (
        exit_code_for_run(_payload(run=_run_record(outcome="failed"))) == EXIT_ERROR
    )
    assert exit_code_for_run({"ok": False, "error": {"code": "X"}}) == EXIT_ERROR


def test_non_passing_operations_and_format() -> None:
    run = _run_record(
        operations=[
            {"case_id": "a", "outcome": "passed"},
            {
                "case_id": "b",
                "outcome": "failed",
                "failure_code": "status-mismatch",
                "failure_message": "wanted 200",
                "operation_key": "GET /pets",
                "expected_status": "200",
                "actual_status": 500,
            },
            {"case_id": "c", "outcome": "skipped"},
        ]
    )
    failures = non_passing_operations(run)
    assert len(failures) == 1
    line = format_operation_failure(failures[0])
    assert "status-mismatch" in line
    assert "case_b" not in line
    assert "b" in line
    assert "GET /pets" in line


def test_format_run_error_includes_remediation() -> None:
    lines = format_run_error(
        {"code": "FORMAT_MISMATCH", "message": "no cases", "remediation": "widen options"}
    )
    assert lines[0].startswith("[FORMAT_MISMATCH]")
    assert "remediation: widen options" in lines[1]


def test_it_summarizes_a_passing_run(httpx_mock: Any) -> None:
    _mock_run_and_export(httpx_mock)

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    assert "Contract verification for project/petstore/1.0.0" in result.stdout
    assert f"evidence: {_RUN_ID}" in result.stdout
    assert "passed" in result.stdout
    assert _DIGEST in result.stdout


def test_it_forwards_options_target_context_and_idempotency(httpx_mock: Any) -> None:
    _mock_run_and_export(httpx_mock)

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
            "--seed",
            "7",
            "--no-generated",
            "--operation",
            "GET /pets",
            "--max-operations",
            "4",
            "--idempotency-key",
            "build-42",
            "--context",
            "commit=abc123",
            "--context",
            "branch=main",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    sent = json.loads(httpx_mock.get_requests()[0].content)
    assert sent["target_ref"] == "mock"
    assert sent["idempotency_key"] == "build-42"
    assert sent["context"] == {"commit": "abc123", "branch": "main"}
    assert sent["options"] == {
        "seed": 7,
        "include_declared_examples": True,
        "include_generated": False,
        "include_negative": True,
        "operations": ["GET /pets"],
        "max_operations": 4,
    }


def test_failed_run_prints_evidence_and_operation_failures(httpx_mock: Any) -> None:
    payload = _payload(
        run=_run_record(
            outcome="failed",
            counts={
                "total": 2,
                "passed": 1,
                "failed": 1,
                "errored": 0,
                "skipped": 0,
            },
            operations=[
                {"case_id": "ok", "outcome": "passed"},
                {
                    "case_id": "bad",
                    "outcome": "failed",
                    "failure_code": "response-schema-mismatch",
                    "failure_message": "missing required field name",
                    "operation_key": "GET /pets/{id}",
                    "expected_status": "200",
                    "actual_status": 200,
                },
            ],
        )
    )
    _mock_run_and_export(httpx_mock, payload=payload)

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
        ],
    )

    assert result.exit_code == EXIT_ERROR
    assert f"evidence: {_RUN_ID}" in result.stdout
    assert "response-schema-mismatch" in result.stdout
    assert "missing required field name" in result.stdout
    assert "bad" in result.stdout


def test_ok_false_exits_with_taxonomy_error(httpx_mock: Any) -> None:
    httpx_mock.add_response(
        url=_RUN_URL,
        method="POST",
        json={
            "ok": False,
            "version_ref": "project/petstore/1.0.0",
            "error": {
                "code": "SOURCE_AUTH_REQUIRED",
                "message": "env var STAGING_TOKEN is unset",
                "remediation": "export STAGING_TOKEN before running",
            },
        },
        status_code=200,
    )

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "staging",
        ],
    )

    assert result.exit_code == EXIT_ERROR
    assert "SOURCE_AUTH_REQUIRED" in result.stderr
    assert "STAGING_TOKEN" in result.stderr
    assert "remediation:" in result.stderr


def test_junit_out_writes_artifact(httpx_mock: Any, tmp_path: Path) -> None:
    junit = '<?xml version="1.0"?><testsuite tests="1" failures="0"/>'
    _mock_run_and_export(httpx_mock, fmt="junit", artifact=junit)
    out = tmp_path / "contract.xml"

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
            "--format",
            "junit",
            "--out",
            str(out),
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    assert out.read_text(encoding="utf-8") == junit
    assert "wrote junit artifact" in result.stdout
    assert f"evidence: {_RUN_ID}" in result.stdout


def test_junit_without_out_emits_xml_on_stdout(httpx_mock: Any) -> None:
    junit = '<?xml version="1.0"?><testsuite tests="1"/>'
    _mock_run_and_export(httpx_mock, fmt="junit", artifact=junit)

    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
            "--format",
            "junit",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    assert result.stdout.strip() == junit


def test_global_json_emits_run_payload(httpx_mock: Any) -> None:
    payload = _payload()
    _mock_run_and_export(httpx_mock, payload=payload)

    result = runner.invoke(
        app,
        [
            "--json",
            "verify",
            "contract",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--target",
            "mock",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    parsed = json.loads(result.stdout)
    assert parsed["ok"] is True
    assert parsed["run"]["id"] == _RUN_ID


def test_unknown_format_and_kind_are_usage_errors() -> None:
    bad_format = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "p",
            "--version",
            "1",
            "--target",
            "t",
            "--format",
            "sarif",
        ],
    )
    assert bad_format.exit_code == EXIT_USAGE
    assert "json, junit" in bad_format.stderr

    bad_kind = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "p",
            "--version",
            "1",
            "--target",
            "t",
            "--kind",
            "registry",
        ],
    )
    assert bad_kind.exit_code == EXIT_USAGE
    assert "project, catalog" in bad_kind.stderr


def test_bad_context_is_usage_error() -> None:
    result = runner.invoke(
        app,
        [
            "verify",
            "contract",
            "--project",
            "p",
            "--version",
            "1",
            "--target",
            "t",
            "--context",
            "not-a-pair",
        ],
    )
    assert result.exit_code == EXIT_USAGE
    assert "KEY=VALUE" in result.stderr
