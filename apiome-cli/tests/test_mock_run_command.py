"""Tests for ``apiome mock run`` — the portable mock runtime launcher (PMR-1.2, #4742).

``apiome mock run`` launches a runtime rather than implementing one, so what is worth testing is
the launch plan: the exact argv, how a runtime is chosen, and that the signing secret never reaches
a command line.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.client.mock_run import (
    CONTAINER_BUNDLE_PATH,
    DEFAULT_IMAGE,
    SECRET_ENV_VAR,
    MockRuntimeUnavailableError,
    build_run_plan,
    read_bundle_mount,
)
from apiome_cli.exit_codes import EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

runner = CliRunner()

_BUNDLE_DOCUMENT: dict[str, Any] = {
    "bundleFormat": "apiome.mock.bundle/v1",
    "manifest": {
        "api": {
            "tenant": "acme-corp",
            "project": "petstore",
            "version": "1.0.0",
            "revisionId": "11111111-2222-3333-4444-555555555555",
        }
    },
    "spec": {"openapi": "3.1.0"},
}


@pytest.fixture
def bundle(tmp_path: Path) -> Path:
    """A bundle document on disk (only its coordinates are read by the CLI)."""
    path = tmp_path / "mock-bundle.json"
    path.write_text(json.dumps(_BUNDLE_DOCUMENT), encoding="utf-8")
    return path


def _which(*available: str) -> Any:
    """Build an executable lookup that finds only the named executables."""

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in available else None

    return which


# ---------------------------------------------------------------------------
# Runtime selection
# ---------------------------------------------------------------------------


def test_auto_prefers_a_locally_installed_runtime(bundle: Path) -> None:
    """Local starts faster, needs no image pull, and reads the bundle straight off disk."""
    plan = build_run_plan(bundle, host="127.0.0.1", port=8775, which=_which("apiome-mock", "docker"))

    assert plan.runtime == "local"
    assert plan.argv[0] == "apiome-mock"


def test_auto_falls_back_to_docker(bundle: Path) -> None:
    plan = build_run_plan(bundle, host="127.0.0.1", port=8775, which=_which("docker"))

    assert plan.runtime == "docker"
    assert plan.image == DEFAULT_IMAGE


def test_auto_without_any_runtime_is_an_error(bundle: Path) -> None:
    with pytest.raises(MockRuntimeUnavailableError, match="Neither"):
        build_run_plan(bundle, host="127.0.0.1", port=8775, which=_which())


def test_requesting_a_missing_local_runtime_says_how_to_fix_it(bundle: Path) -> None:
    with pytest.raises(MockRuntimeUnavailableError, match="--runtime docker"):
        build_run_plan(bundle, host="127.0.0.1", port=8775, runtime="local", which=_which("docker"))


def test_requesting_docker_without_docker_is_an_error(bundle: Path) -> None:
    with pytest.raises(MockRuntimeUnavailableError, match="'docker' is not on PATH"):
        build_run_plan(bundle, host="127.0.0.1", port=8775, runtime="docker", which=_which("apiome-mock"))


# ---------------------------------------------------------------------------
# Plan contents
# ---------------------------------------------------------------------------


def test_local_plan_passes_the_absolute_bundle_path(tmp_path: Path, bundle: Path, monkeypatch) -> None:
    """A relative path would resolve differently for a container than for a local process."""
    monkeypatch.chdir(tmp_path)

    plan = build_run_plan(Path("mock-bundle.json"), host="127.0.0.1", port=9000, which=_which("apiome-mock"))

    assert plan.argv == (
        "apiome-mock",
        "run",
        "--bundle",
        str(bundle.resolve()),
        "--host",
        "127.0.0.1",
        "--port",
        "9000",
        "--base-path",
        "version",
    )
    assert plan.base_url == "http://127.0.0.1:9000"


def test_docker_plan_publishes_the_port_and_mounts_the_bundle_read_only(bundle: Path) -> None:
    plan = build_run_plan(bundle, host="127.0.0.1", port=9000, runtime="docker", which=_which("docker"))

    assert plan.argv[:8] == (
        "docker",
        "run",
        "--rm",
        "--init",
        "--publish",
        "127.0.0.1:9000:9000",
        "--volume",
        f"{bundle.resolve()}:{CONTAINER_BUNDLE_PATH}:ro",
    )
    # Inside the container the runtime must bind every interface, or the publish is useless.
    assert plan.argv[-6:] == ("--host", "0.0.0.0", "--port", "9000", "--base-path", "version")


def test_docker_plan_honours_a_custom_image(bundle: Path) -> None:
    plan = build_run_plan(
        bundle,
        host="127.0.0.1",
        port=8775,
        runtime="docker",
        image="registry.internal/apiome-mock:pinned",
        which=_which("docker"),
    )

    assert plan.image == "registry.internal/apiome-mock:pinned"
    assert "registry.internal/apiome-mock:pinned" in plan.argv


def test_runtime_flags_are_forwarded_identically_to_both_runtimes(bundle: Path) -> None:
    """Identical flags are what make the two runtimes answer the same conformance corpus."""
    common = {
        "host": "127.0.0.1",
        "port": 8775,
        "base_path": "root",
        "require_signature": True,
        "log_level": "DEBUG",
    }
    local = build_run_plan(bundle, **common, runtime="local", which=_which("apiome-mock"))
    docker = build_run_plan(bundle, **common, runtime="docker", which=_which("docker"))

    tail = ("--base-path", "root", "--require-signature", "--log-level", "DEBUG")
    assert local.argv[-5:] == tail
    assert docker.argv[-5:] == tail


def test_the_secret_is_forwarded_by_name_never_by_value(bundle: Path) -> None:
    """A secret in argv is readable by every user on the machine through ps."""
    plan = build_run_plan(
        bundle,
        host="127.0.0.1",
        port=8775,
        runtime="docker",
        secret_present=True,
        which=_which("docker"),
    )

    assert ("--env", SECRET_ENV_VAR) == plan.argv[8:10]
    assert plan.forwards_secret is True


def test_the_local_plan_inherits_the_secret_from_the_environment(bundle: Path) -> None:
    plan = build_run_plan(
        bundle,
        host="127.0.0.1",
        port=8775,
        runtime="local",
        secret_present=True,
        which=_which("apiome-mock"),
    )

    assert SECRET_ENV_VAR not in plan.argv
    assert plan.forwards_secret is True


# ---------------------------------------------------------------------------
# Bundle coordinates
# ---------------------------------------------------------------------------


def test_the_reported_url_includes_the_bundles_mount(bundle: Path) -> None:
    assert read_bundle_mount(bundle) == "/acme-corp/petstore/1.0.0"


@pytest.mark.parametrize("content", ["not json", "{}", '{"manifest": {"api": {"tenant": ""}}}'])
def test_unreadable_coordinates_do_not_pre_empt_the_runtimes_diagnostics(tmp_path: Path, content: str) -> None:
    """Verification is the runtime's job; this read is only for the URL shown to the user."""
    path = tmp_path / "bundle.json"
    path.write_text(content, encoding="utf-8")

    assert read_bundle_mount(path) == ""


def test_a_missing_file_yields_no_mount(tmp_path: Path) -> None:
    assert read_bundle_mount(tmp_path / "absent.json") == ""


# ---------------------------------------------------------------------------
# Command surface
# ---------------------------------------------------------------------------


def test_dry_run_prints_the_command_without_launching_anything(bundle: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", _which("apiome-mock"))
    monkeypatch.setattr(
        "subprocess.call",
        lambda *_args, **_kwargs: pytest.fail("--dry-run must not launch a process"),
    )

    result = runner.invoke(app, ["mock", "run", "--dry-run", str(bundle)])

    assert result.exit_code == EXIT_SUCCESS
    assert result.stdout.strip().startswith("apiome-mock run --bundle ")


def test_dry_run_json_describes_the_plan(bundle: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", _which("docker"))

    result = runner.invoke(app, ["--json", "mock", "run", "--dry-run", "--port", "9100", str(bundle)])

    payload = json.loads(result.stdout)
    assert payload["runtime"] == "docker"
    assert payload["baseUrl"] == "http://127.0.0.1:9100"
    assert payload["mount"] == "/acme-corp/petstore/1.0.0"
    assert payload["command"][0] == "docker"


def test_root_base_path_reports_no_mount(bundle: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", _which("apiome-mock"))

    result = runner.invoke(
        app,
        ["--json", "mock", "run", "--dry-run", "--base-path", "root", str(bundle)],
    )

    assert json.loads(result.stdout)["mount"] == ""


def test_the_runtime_exit_code_is_propagated(bundle: Path, monkeypatch) -> None:
    """A CI job branches on the runtime's exit code, so it must survive the launcher."""
    monkeypatch.setattr("shutil.which", _which("apiome-mock"))
    monkeypatch.setattr("subprocess.call", lambda *_args, **_kwargs: 3)

    result = runner.invoke(app, ["mock", "run", str(bundle)])

    assert result.exit_code == 3


def test_a_clean_runtime_exit_is_success(bundle: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", _which("apiome-mock"))
    monkeypatch.setattr("subprocess.call", lambda *_args, **_kwargs: 0)

    result = runner.invoke(app, ["mock", "run", str(bundle)])

    assert result.exit_code == EXIT_SUCCESS
    assert "readiness  http://127.0.0.1:8775/ready" in result.stdout


def test_interrupting_the_runtime_is_not_an_error(bundle: Path, monkeypatch) -> None:
    """Ctrl-C is how a developer stops a foreground mock; it is not a failure."""

    def interrupted(*_args: object, **_kwargs: object) -> int:
        raise KeyboardInterrupt

    monkeypatch.setattr("shutil.which", _which("apiome-mock"))
    monkeypatch.setattr("subprocess.call", interrupted)

    assert runner.invoke(app, ["mock", "run", str(bundle)]).exit_code == EXIT_SUCCESS


def test_a_missing_bundle_is_a_usage_error(tmp_path: Path) -> None:
    result = runner.invoke(app, ["mock", "run", str(tmp_path / "absent.json")])

    assert result.exit_code == EXIT_USAGE
    assert "Bundle not found" in result.output


@pytest.mark.parametrize(
    ("flag", "value"),
    [("--runtime", "kubernetes"), ("--base-path", "sideways")],
)
def test_unknown_option_values_are_rejected(bundle: Path, flag: str, value: str) -> None:
    result = runner.invoke(app, ["mock", "run", flag, value, str(bundle)])

    assert result.exit_code == EXIT_USAGE
    assert value in result.output


def test_no_available_runtime_is_a_usage_error(bundle: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", _which())

    result = runner.invoke(app, ["mock", "run", str(bundle)])

    assert result.exit_code == EXIT_USAGE
    assert "Neither" in result.output
