"""Tests for ``apiome mock preview`` — hosted and offline (#5530, MSC-1.4)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from apiome_cli.client import mock_preview_local
from apiome_cli.client.mock_preview_local import (
    OfflinePreviewError,
    build_preview_plan,
    run_preview_plan,
)
from apiome_cli.client.mock_run import MockRuntimeUnavailableError
from apiome_cli.exit_codes import EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app
from apiome_cli.mock_config import CONFIG_FORMAT

runner = CliRunner()

_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
_PREVIEW_URL = (
    f"http://localhost:8000/v1/versions/acme-corp/{_PROJECT_ID}/{_VERSION_ID}/mock/preview"
)

_PROJECT = {"id": _PROJECT_ID, "name": "Payments API", "slug": "payments-api"}
_VERSION_LOOKUP = {"id": _VERSION_ID, "project_id": _PROJECT_ID, "version": "1.0.0"}

_RESULT = {
    "operation": "GET /pets/{petId}",
    "pathParams": {"petId": "42"},
    "status": 200,
    "headers": {"content-type": "application/json", "x-mock-correlation": "path-params"},
    "mediaType": "application/json",
    "body": {"id": 42, "name": "Rex"},
    "bodyEncoding": "json",
    "trace": {
        "layer": "correlation",
        "detail": "Correlation (path-params) rewrote the response.",
        "scenario": None,
        "ruleIndex": None,
        "seed": 7,
        "seedSource": "correlation",
        "correlationMode": "inferred",
        "correlationApplied": ["path-params"],
        "correlationPointers": ["/id"],
        "schemaValid": True,
        "bodySource": "example",
        "exampleName": None,
    },
    "chaos": {"suppressed": True, "delayMs": 100, "jitterMs": 20, "errorRate": 5.0},
    "draft": False,
}


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tier-2 commands require an API key and tenant scope."""
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _scope(httpx_mock: object) -> None:
    httpx_mock.add_response(
        url="http://localhost:8000/v1/projects/acme-corp/by-slug/payments-api",
        json=_PROJECT,
    )
    httpx_mock.add_response(
        url=f"http://localhost:8000/v1/versions/acme-corp/{_PROJECT_ID}/by-version/1.0.0",
        json=_VERSION_LOOKUP,
    )


def _config_file(tmp_path: Path) -> Path:
    path = tmp_path / "mock-config.json"
    path.write_text(
        json.dumps(
            {
                "configFormat": CONFIG_FORMAT,
                "configFormatVersion": 1,
                "correlation": {"mode": "path-params", "operations": {}},
                "scenarios": {},
                "chaos": None,
                "fixturePacks": {},
            }
        ),
        encoding="utf-8",
    )
    return path


# --------------------------------------------------------------------------- target selection


def test_preview_needs_a_target() -> None:
    result = runner.invoke(app, ["mock", "preview"])
    assert result.exit_code == EXIT_USAGE
    assert "needs a target" in result.stderr


def test_preview_refuses_both_a_version_and_a_bundle(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    result = runner.invoke(
        app, ["mock", "preview", "payments-api", "1.0.0", "--bundle", str(bundle)]
    )
    assert result.exit_code == EXIT_USAGE
    assert "not both" in result.stderr


def test_preview_refuses_a_config_file_with_a_bundle(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    result = runner.invoke(
        app,
        ["mock", "preview", "--bundle", str(bundle), "--file", str(_config_file(tmp_path))],
    )
    assert result.exit_code == EXIT_USAGE
    assert "no meaning with --bundle" in result.stderr


def test_a_malformed_header_is_a_usage_error() -> None:
    result = runner.invoke(app, ["mock", "preview", "payments-api", "1.0.0", "-H", "Accept"])
    assert result.exit_code == EXIT_USAGE
    assert "Name: value" in result.stderr


# --------------------------------------------------------------------------- hosted


@pytest.mark.usefixtures("api_key_env")
def test_hosted_preview_prints_the_response_and_the_trace(httpx_mock: object) -> None:
    _scope(httpx_mock)
    httpx_mock.add_response(url=_PREVIEW_URL, method="POST", json=_RESULT)

    result = runner.invoke(
        app, ["mock", "preview", "payments-api", "1.0.0", "--path", "/pets/42"]
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert "GET /pets/42 → 200 application/json" in result.stdout
    assert "GET /pets/{petId}" in result.stdout
    assert "correlation  inferred — path-params" in result.stdout
    assert "reported, not applied" in result.stdout
    assert '"name": "Rex"' in result.stdout


@pytest.mark.usefixtures("api_key_env")
def test_hosted_preview_sends_the_request_the_options_describe(httpx_mock: object) -> None:
    _scope(httpx_mock)
    httpx_mock.add_response(url=_PREVIEW_URL, method="POST", json=_RESULT)

    runner.invoke(
        app,
        [
            "mock", "preview", "payments-api", "1.0.0",
            "-X", "post", "--path", "/pets",
            "-H", "Accept: application/json",
            "-q", "tag=cat", "-q", "tag=dog",
            "--body", '{"name": "Milo"}',
            "--scenario", "outage",
            "--seed", "7",
        ],
    )
    posted = json.loads(
        [r for r in httpx_mock.get_requests() if r.method == "POST"][0].content
    )
    assert posted == {
        "request": {
            "method": "POST",
            "path": "/pets",
            "headers": {"Accept": "application/json"},
            "query": {"tag": ["cat", "dog"]},
            "body": {"name": "Milo"},
            "scenario": "outage",
            "seed": 7,
        }
    }


@pytest.mark.usefixtures("api_key_env")
def test_hosted_preview_json_mode_emits_the_raw_result(httpx_mock: object) -> None:
    _scope(httpx_mock)
    httpx_mock.add_response(url=_PREVIEW_URL, method="POST", json=_RESULT)

    result = runner.invoke(
        app, ["--json", "mock", "preview", "payments-api", "1.0.0", "--path", "/pets/42"]
    )
    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout) == _RESULT


@pytest.mark.usefixtures("api_key_env")
def test_a_config_file_is_sent_as_the_draft_settings(httpx_mock: object, tmp_path: Path) -> None:
    _scope(httpx_mock)
    httpx_mock.add_response(url=_PREVIEW_URL, method="POST", json={**_RESULT, "draft": True})

    result = runner.invoke(
        app,
        [
            "mock", "preview", "payments-api", "1.0.0",
            "--path", "/pets/42", "--file", str(_config_file(tmp_path)),
        ],
    )
    assert result.exit_code == EXIT_SUCCESS
    posted = json.loads([r for r in httpx_mock.get_requests() if r.method == "POST"][0].content)
    assert posted["settings"] == {
        "correlation": {"mode": "path-params", "operations": {}},
        "scenarios": {},
        "activeScenario": None,
        "chaos": None,
        "fixturePacks": {},
    }
    assert "unsaved draft" in result.stdout


@pytest.mark.usefixtures("api_key_env")
def test_a_rejected_draft_reports_errors_against_the_file(
    httpx_mock: object, tmp_path: Path
) -> None:
    _scope(httpx_mock)
    httpx_mock.add_response(
        url=_PREVIEW_URL,
        method="POST",
        status_code=422,
        json={
            "detail": {
                "message": "Draft mock settings failed validation.",
                "errors": ["Correlation, operation 'GET /nope': no operation GET /nope exists."],
            }
        },
    )
    path = _config_file(tmp_path)

    result = runner.invoke(
        app, ["mock", "preview", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert str(path) in result.stderr
    assert 'correlation.operations["GET /nope"]' in result.stderr


@pytest.mark.usefixtures("api_key_env")
def test_a_preview_of_an_error_status_still_exits_zero(httpx_mock: object) -> None:
    """The exit code reports whether the preview ran, not what the mock would answer."""
    _scope(httpx_mock)
    httpx_mock.add_response(
        url=_PREVIEW_URL,
        method="POST",
        json={**_RESULT, "status": 404, "operation": None, "body": None, "bodyEncoding": "empty"},
    )

    result = runner.invoke(app, ["mock", "preview", "payments-api", "1.0.0", "--path", "/nope"])
    assert result.exit_code == EXIT_SUCCESS
    assert "no operation matched" in result.stdout


# --------------------------------------------------------------------------- offline plans


def _which(*available: str):
    return lambda name: f"/usr/bin/{name}" if name in available else None


def test_the_local_plan_reads_the_request_from_stdin(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, which=_which("apiome-mock"))
    assert plan.runtime == "local"
    assert plan.argv[:2] == ("apiome-mock", "preview")
    assert "--request-file" in plan.argv and "-" in plan.argv
    assert "--json" in plan.argv


def test_the_docker_plan_mounts_the_bundle_and_keeps_stdin_open(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, runtime="docker", which=_which("docker"))
    assert plan.runtime == "docker"
    assert "--interactive" in plan.argv
    assert any(str(bundle.resolve()) in part for part in plan.argv)
    assert plan.image is not None and plan.image in plan.argv


def test_the_docker_plan_forwards_the_signing_secret_by_name(tmp_path: Path) -> None:
    """The secret must never appear in argv, only its variable name."""
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(
        bundle, runtime="docker", secret_present=True, which=_which("docker")
    )
    assert "APIOME_MOCK_BUNDLE_SECRET" in plan.argv
    assert plan.forwards_secret is True


def test_require_signature_reaches_the_runtime(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, require_signature=True, which=_which("apiome-mock"))
    assert "--require-signature" in plan.argv


def test_a_container_render_is_given_time_to_pull_the_image(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    local = build_preview_plan(bundle, which=_which("apiome-mock"))
    docker = build_preview_plan(bundle, runtime="docker", which=_which("docker"))
    assert docker.timeout_seconds > local.timeout_seconds


def test_no_runtime_available_is_reported(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    with pytest.raises(MockRuntimeUnavailableError):
        build_preview_plan(bundle, which=_which())


# --------------------------------------------------------------------------- offline execution


def _completed(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_the_request_document_goes_to_the_child_stdin(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, which=_which("apiome-mock"))
    seen: dict[str, object] = {}

    def fake_run(argv, **kwargs):
        seen.update(kwargs)
        seen["argv"] = argv
        return _completed(stdout=json.dumps(_RESULT))

    assert run_preview_plan(plan, {"path": "/pets"}, run=fake_run)["status"] == 200
    assert json.loads(str(seen["input"])) == {"path": "/pets"}
    assert seen["argv"] == list(plan.argv)


def test_a_runtime_failure_preserves_its_own_message(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, which=_which("apiome-mock"))

    with pytest.raises(OfflinePreviewError, match="Bundle digest mismatch"):
        run_preview_plan(
            plan,
            {},
            run=lambda *a, **k: _completed(returncode=3, stderr="Bundle digest mismatch."),
        )


def test_output_that_is_not_a_preview_result_is_reported(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, which=_which("apiome-mock"))

    with pytest.raises(OfflinePreviewError, match="did not print a preview result"):
        run_preview_plan(plan, {}, run=lambda *a, **k: _completed(stdout="not json"))


def test_a_missing_executable_is_reported(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    plan = build_preview_plan(bundle, which=_which("apiome-mock"))

    def explode(*_args, **_kwargs):
        raise FileNotFoundError("apiome-mock")

    with pytest.raises(OfflinePreviewError, match="Failed to launch"):
        run_preview_plan(plan, {}, run=explode)


# --------------------------------------------------------------------------- offline command


def test_offline_preview_needs_no_credentials_and_prints_the_same_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--bundle contacts no control plane: no API key, no tenant, no base URL."""
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        mock_preview_local,
        "select_runtime",
        lambda requested, which: "local",
    )
    monkeypatch.setattr(
        mock_preview_local.subprocess,
        "run",
        lambda *a, **k: _completed(stdout=json.dumps({k: v for k, v in _RESULT.items() if k != "draft"})),
    )

    result = runner.invoke(
        app, ["--json", "mock", "preview", "--bundle", str(bundle), "--path", "/pets/42"]
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert json.loads(result.stdout) == _RESULT


def test_offline_preview_reports_a_missing_bundle(tmp_path: Path) -> None:
    result = runner.invoke(app, ["mock", "preview", "--bundle", str(tmp_path / "absent.json")])
    assert result.exit_code == EXIT_USAGE
    assert "Bundle not found" in result.stderr


def test_offline_preview_rejects_an_unknown_runtime(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle.json"
    bundle.write_text("{}", encoding="utf-8")
    result = runner.invoke(
        app, ["mock", "preview", "--bundle", str(bundle), "--runtime", "podman"]
    )
    assert result.exit_code == EXIT_USAGE
    assert "Unknown --runtime" in result.stderr
