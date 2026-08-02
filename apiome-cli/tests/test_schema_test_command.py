"""Tests for ``apiome schema test`` (IXH-5.5 / #5117) against mocked REST."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pytest_httpx import HTTPXMock
from typer.testing import CliRunner

from apiome_cli.exit_codes import (
    EXIT_ERROR,
    EXIT_SCHEMA_TEST_FAILED,
    EXIT_SUCCESS,
    EXIT_USAGE,
)
from apiome_cli.main import app

pytestmark = pytest.mark.usefixtures("api_key_env")

runner = CliRunner()

_REF = "project/petstore/1.0.0/Pet"
_VALIDATE_URL = f"http://localhost:8000/v1/tenants/acme-corp/schemas/{_REF}/validate"
_SYNTHESIZE_URL = f"http://localhost:8000/v1/tenants/acme-corp/schemas/{_REF}/synthesize"

_SOURCE = {"kind": "project", "projected": True, "coordinates": {"type": "acme.Pet"}}

_TYPE_FINDING = {
    "pointer": "/age",
    "keyword": "type",
    "schema_pointer": "/properties/age/type",
    "expected": "integer",
    "actual": "'x'",
    "message": "'x' is not of type 'integer'",
}


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _validate_response(**overrides: object) -> dict:
    response: dict = {
        "ok": True,
        "valid": True,
        "validated": True,
        "validator": "jsonschema/2020-12",
        "schema_ref": _REF,
        "media_type": "application/json",
        "source": _SOURCE,
        "findings": [],
        "total_findings": 0,
        "truncated": False,
        "diagnostics": [],
        "error": None,
    }
    response.update(overrides)
    return response


def _synthesis_response(instances: list[dict], **overrides: object) -> dict:
    response: dict = {
        "ok": True,
        "synthetic": True,
        "notice": "synthetic payloads",
        "schema_ref": _REF,
        "seed": 0,
        "depth_limit": 6,
        "verified": True,
        "source": _SOURCE,
        "instances": instances,
        "counts": {"minimal": 1, "mutant": 1},
        "rejected_mutants": 0,
        "truncated": False,
        "diagnostics": [],
        "error": None,
    }
    response.update(overrides)
    return response


_MINIMAL = {
    "id": "minimal",
    "kind": "minimal",
    "title": "minimal valid instance",
    "description": "",
    "instance": {"name": "Rex"},
    "synthetic": True,
    "expected_valid": True,
    "valid": True,
    "findings": [],
}

_MUTANT = {
    "id": "mutant:type-wrong:type:/age",
    "kind": "mutant",
    "title": "type wrong at /age",
    "description": "violates type",
    "instance": {"name": "Rex", "age": "x"},
    "synthetic": True,
    "expected_valid": False,
    "valid": False,
    "findings": [_TYPE_FINDING],
    "mutation": {
        "kind": "type-wrong",
        "keyword": "type",
        "pointer": "/age",
        "reported_keyword": "type",
        "description": "Replace /age with a string.",
    },
}


def _write_payload(tmp_path: Path, name: str = "pet.json") -> Path:
    file = tmp_path / name
    file.write_text('{"name": "Rex"}', encoding="utf-8")
    return file


# ===========================================================================
# Single-payload mode
# ===========================================================================


class TestPayloadMode:
    def test_valid_payload_exits_zero(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_SUCCESS
        assert f"Schema test for {_REF} — passed" in result.stdout
        request = httpx_mock.get_request()
        body = json.loads(request.content)
        assert body == {
            "instance_text": '{"name": "Rex"}',
            "media_type": "application/json",
        }

    def test_invalid_payload_exits_schema_test_failed(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(
                valid=False, findings=[_TYPE_FINDING], total_findings=1
            ),
        )
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_SCHEMA_TEST_FAILED
        assert "FAILED" in result.stdout
        assert "failed 'type' at '/age'" in result.stdout

    def test_xml_payload_sends_xml_media_type(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(
                validator="xmllint.validate", media_type="application/xml"
            ),
        )
        file = tmp_path / "pet.xml"
        file.write_text("<pet><name>Rex</name></pet>", encoding="utf-8")
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_SUCCESS
        body = json.loads(httpx_mock.get_request().content)
        assert body["media_type"] == "application/xml"

    def test_repeatable_payloads_run_in_order(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(valid=False, findings=[_TYPE_FINDING]),
        )
        first = _write_payload(tmp_path, "a.json")
        second = _write_payload(tmp_path, "b.json")
        result = runner.invoke(
            app,
            [
                "--json",
                "schema",
                "test",
                "--schema",
                _REF,
                "--payload",
                str(first),
                "--payload",
                str(second),
            ],
        )
        assert result.exit_code == EXIT_SCHEMA_TEST_FAILED
        report = json.loads(result.stdout)
        assert [c["id"] for c in report["cases"]] == ["payload:a", "payload:b"]
        assert [c["status"] for c in report["cases"]] == ["passed", "failed"]

    def test_unserviceable_payload_exits_error(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(
                ok=False,
                valid=None,
                validated=False,
                error={
                    "code": "INPUT_TOO_LARGE",
                    "category": "resource",
                    "message": "too big",
                    "remediation": "shrink it",
                },
            ),
        )
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_ERROR
        assert "[INPUT_TOO_LARGE]" in result.stdout

    def test_missing_payload_file_is_usage_error(self, tmp_path: Path) -> None:
        result = runner.invoke(
            app,
            [
                "schema",
                "test",
                "--schema",
                _REF,
                "--payload",
                str(tmp_path / "gone.json"),
            ],
        )
        assert result.exit_code == EXIT_USAGE


# ===========================================================================
# Generated mode
# ===========================================================================


class TestGenerateMode:
    def test_generated_set_passes(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL, json=_synthesis_response([_MINIMAL, _MUTANT])
        )
        result = runner.invoke(
            app, ["--json", "schema", "test", "--schema", _REF, "--generate"]
        )
        assert result.exit_code == EXIT_SUCCESS
        body = json.loads(httpx_mock.get_request().content)
        assert body == {"seed": 0, "verify": True}
        report = json.loads(result.stdout)
        mutant = report["cases"][1]
        assert mutant["kind"] == "mutant"
        assert mutant["mutation"]["keyword"] == "type"
        assert "intended to violate 'type' — violated" in mutant["message"]

    def test_seed_is_forwarded_and_echoed(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL, json=_synthesis_response([_MINIMAL], seed=7)
        )
        result = runner.invoke(
            app,
            ["--json", "schema", "test", "--schema", _REF, "--generate", "--seed", "7"],
        )
        assert result.exit_code == EXIT_SUCCESS
        assert json.loads(httpx_mock.get_request().content)["seed"] == 7
        assert json.loads(result.stdout)["seed"] == 7

    def test_mutant_that_did_not_violate_fails_the_run(
        self, httpx_mock: HTTPXMock
    ) -> None:
        broken_mutant = {**_MUTANT, "valid": True, "findings": []}
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL, json=_synthesis_response([broken_mutant])
        )
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--generate"]
        )
        assert result.exit_code == EXIT_SCHEMA_TEST_FAILED
        assert "did not: the mutant validated cleanly" in result.stdout

    def test_rejected_mutants_are_surfaced(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL,
            json=_synthesis_response([_MINIMAL], rejected_mutants=3),
        )
        result = runner.invoke(app, ["schema", "test", "--schema", _REF, "--generate"])
        assert result.exit_code == EXIT_SUCCESS
        assert "3 generated mutant candidate(s)" in result.stdout

    def test_unserviceable_synthesis_exits_error(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL,
            json=_synthesis_response(
                [],
                ok=False,
                error={
                    "code": "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                    "category": "capability",
                    "message": "cannot generate",
                    "remediation": "simplify",
                },
            ),
        )
        result = runner.invoke(app, ["schema", "test", "--schema", _REF, "--generate"])
        assert result.exit_code == EXIT_ERROR


# ===========================================================================
# Suite mode
# ===========================================================================


class TestSuiteMode:
    def test_suite_directory_runs_files_and_generated_set(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        suite = tmp_path / "payloads"
        suite.mkdir()
        (suite / "a.json").write_text('{"name": "Rex"}', encoding="utf-8")
        (suite / "b.json").write_text('{"name": "Fido"}', encoding="utf-8")
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        httpx_mock.add_response(
            url=_SYNTHESIZE_URL, json=_synthesis_response([_MINIMAL, _MUTANT])
        )
        result = runner.invoke(
            app, ["--json", "schema", "test", "--schema", _REF, "--suite", str(suite)]
        )
        assert result.exit_code == EXIT_SUCCESS
        report = json.loads(result.stdout)
        assert [c["id"] for c in report["cases"]] == [
            "suite:a.json",
            "suite:b.json",
            "minimal",
            "mutant:type-wrong:type:/age",
        ]
        assert report["summary"] == {
            "total": 4,
            "passed": 4,
            "failed": 0,
            "errors": 0,
        }

    def test_no_generate_narrows_suite_to_files(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        suite = tmp_path / "payloads"
        suite.mkdir()
        (suite / "a.json").write_text('{"name": "Rex"}', encoding="utf-8")
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        result = runner.invoke(
            app,
            [
                "schema",
                "test",
                "--schema",
                _REF,
                "--suite",
                str(suite),
                "--no-generate",
            ],
        )
        assert result.exit_code == EXIT_SUCCESS
        # Only the validate call was made; an unrequested synthesize would fail the mock.

    def test_manifest_expectations_are_honored(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        (tmp_path / "good.json").write_text('{"name": "Rex"}', encoding="utf-8")
        (tmp_path / "bad.json").write_text('{"age": "x"}', encoding="utf-8")
        manifest = tmp_path / "corpus.manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "path": "good.json",
                            "validity_class": "valid",
                            "features": ["instance-payload"],
                        },
                        {
                            "path": "bad.json",
                            "validity_class": "invalid",
                            "features": ["instance-payload"],
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(valid=False, findings=[_TYPE_FINDING]),
        )
        result = runner.invoke(
            app,
            [
                "--json",
                "schema",
                "test",
                "--schema",
                _REF,
                "--suite",
                str(manifest),
                "--no-generate",
            ],
        )
        assert result.exit_code == EXIT_SUCCESS
        report = json.loads(result.stdout)
        assert [c["status"] for c in report["cases"]] == ["passed", "passed"]
        assert report["cases"][1]["expected_valid"] is False

    def test_empty_suite_directory_is_usage_error(self, tmp_path: Path) -> None:
        suite = tmp_path / "empty"
        suite.mkdir()
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--suite", str(suite)]
        )
        assert result.exit_code == EXIT_USAGE


# ===========================================================================
# Outputs
# ===========================================================================


class TestOutputs:
    def test_json_report_is_stable_and_machine_readable(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app,
            ["--json", "schema", "test", "--schema", _REF, "--payload", str(file)],
        )
        assert result.exit_code == EXIT_SUCCESS
        report = json.loads(result.stdout)
        assert report["command"] == "schema test"
        assert report["schema_ref"] == _REF
        assert report["source"] == _SOURCE
        assert set(report["cases"][0]) == {
            "id",
            "name",
            "source",
            "kind",
            "path",
            "expected_valid",
            "valid",
            "validated",
            "status",
            "message",
            "findings",
            "mutation",
        }

    def test_junit_file_is_written(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            json=_validate_response(valid=False, findings=[_TYPE_FINDING]),
        )
        file = _write_payload(tmp_path)
        junit_path = tmp_path / "report.xml"
        result = runner.invoke(
            app,
            [
                "schema",
                "test",
                "--schema",
                _REF,
                "--payload",
                str(file),
                "--junit",
                str(junit_path),
            ],
        )
        assert result.exit_code == EXIT_SCHEMA_TEST_FAILED
        text = junit_path.read_text(encoding="utf-8")
        assert 'tests="1" failures="1" errors="0" skipped="0"' in text
        assert f"wrote junit artifact to {junit_path}" in result.stdout

    def test_junit_to_stdout(self, httpx_mock: HTTPXMock, tmp_path: Path) -> None:
        httpx_mock.add_response(url=_VALIDATE_URL, json=_validate_response())
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app,
            [
                "schema",
                "test",
                "--schema",
                _REF,
                "--payload",
                str(file),
                "--junit",
                "-",
            ],
        )
        assert result.exit_code == EXIT_SUCCESS
        assert result.stdout.startswith('<?xml version="1.0" encoding="UTF-8"?>')
        assert "Schema test for" not in result.stdout

    def test_junit_stdout_conflicts_with_json(self, tmp_path: Path) -> None:
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app,
            [
                "--json",
                "schema",
                "test",
                "--schema",
                _REF,
                "--payload",
                str(file),
                "--junit",
                "-",
            ],
        )
        assert result.exit_code == EXIT_USAGE


# ===========================================================================
# Exit-code discrimination (transport / auth / resolution)
# ===========================================================================


class TestExitCodeDiscrimination:
    def test_no_mode_flags_is_usage_error(self) -> None:
        result = runner.invoke(app, ["schema", "test", "--schema", _REF])
        assert result.exit_code == EXIT_USAGE

    def test_unresolvable_reference_exits_usage(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL,
            status_code=404,
            json={"detail": {"message": "reference names nothing visible"}},
        )
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_USAGE

    def test_rejected_credentials_exit_usage(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL, status_code=401, json={"detail": "bad key"}
        )
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_USAGE

    def test_server_fault_exits_error(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_response(
            url=_VALIDATE_URL, status_code=500, json={"detail": "boom"}
        )
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_ERROR

    def test_transport_fault_exits_error(
        self, httpx_mock: HTTPXMock, tmp_path: Path
    ) -> None:
        httpx_mock.add_exception(httpx.ConnectError("connection refused"))
        file = _write_payload(tmp_path)
        result = runner.invoke(
            app, ["schema", "test", "--schema", _REF, "--payload", str(file)]
        )
        assert result.exit_code == EXIT_ERROR
