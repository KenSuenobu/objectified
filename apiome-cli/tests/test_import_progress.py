"""Tests for import job polling and stderr progress feedback."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import typer
from typer.testing import CliRunner

from apiome_cli.cli_context import (
    DEFAULT_IMPORT_TIMEOUT,
    import_timeout_from_context,
    no_progress_from_context,
    timeout_from_context,
)
from apiome_cli.client.http import DEFAULT_TIMEOUT, RestClient
from apiome_cli.config import CliSettings
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.import_.jobs import (
    DEFAULT_POLL_INTERVAL,
    _failure_detail,
    format_import_progress,
    wait_for_import_job,
)
from apiome_cli.main import app
from apiome_cli.progress import import_progress, progress_allowed
from helpers import strip_ansi

runner = CliRunner()
_context_app = typer.Typer()


@_context_app.callback()
def _context_callback(
    ctx: typer.Context,
    timeout: float | None = typer.Option(None, "--timeout"),
    no_progress: bool = typer.Option(False, "--no-progress"),
) -> None:
    ctx.ensure_object(dict)
    ctx.obj["timeout"] = timeout
    ctx.obj["no_progress"] = no_progress


@_context_app.command("timeout-probe")
def _timeout_probe(ctx: typer.Context) -> None:
    typer.echo(str(timeout_from_context(ctx)))


@_context_app.command("import-timeout-probe")
def _import_timeout_probe(ctx: typer.Context) -> None:
    typer.echo(str(import_timeout_from_context(ctx)))


@_context_app.command("no-progress-probe")
def _no_progress_probe(ctx: typer.Context) -> None:
    typer.echo(str(no_progress_from_context(ctx)))


def test_format_import_progress_message() -> None:
    """Progress lines include status and elapsed seconds."""
    assert format_import_progress("running", elapsed_seconds=12.7) == "Import running… (12s)"


def test_import_progress_disabled_yields_none() -> None:
    """Disabled progress does not attach a Rich status object."""
    with import_progress(enabled=False) as status:
        assert status is None


def test_import_progress_enabled_yields_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enabled progress exposes an updatable Rich status when stderr is a terminal."""
    monkeypatch.setattr("apiome_cli.progress.sys.stderr.isatty", lambda: True)
    with import_progress(enabled=True, initial_message="Waiting…") as status:
        assert status is not None
        status.update("Import running… (1s)")


def test_import_progress_suppressed_off_a_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """clig.dev: no animations into a pipe — a spinner leaves frames in CI logs."""
    monkeypatch.setattr("apiome_cli.progress.sys.stderr.isatty", lambda: False)
    with import_progress(enabled=True) as status:
        assert status is None


def test_import_progress_suppressed_by_quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    """--quiet silences the non-essential channel, and a spinner is exactly that."""
    monkeypatch.setattr("apiome_cli.progress.sys.stderr.isatty", lambda: True)
    monkeypatch.setattr("apiome_cli.progress.quiet_enabled", lambda: True)
    with import_progress(enabled=True) as status:
        assert status is None


def test_progress_allowed_honours_no_progress_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The caller's own --no-progress wins even on a terminal."""
    monkeypatch.setattr("apiome_cli.progress.sys.stderr.isatty", lambda: True)
    assert progress_allowed(enabled=False) is False
    assert progress_allowed(enabled=True) is True


def test_wait_for_import_job_returns_completed_payload(httpx_mock: object) -> None:
    """Poll loop stops on completed state and returns the final JSON body."""
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-1",
        json={"state": "running", "job_id": "job-1"},
    )
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-1",
        json={"state": "completed", "job_id": "job-1", "project_id": "p1"},
    )
    client = RestClient(CliSettings(), timeout=30.0)
    result = wait_for_import_job(
        client,
        "acme-corp",
        "job-1",
        poll_interval=0.01,
        timeout=5.0,
        no_progress=True,
        sleep=lambda _seconds: None,
    )
    assert result["state"] == "completed"
    assert result["project_id"] == "p1"


def test_wait_for_import_job_failed_exits_error(httpx_mock: object) -> None:
    """Failed terminal state prints to stderr and exits 1."""
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-2",
        json={"state": "failed", "summary": {"message": "parse error"}},
    )
    client = RestClient(CliSettings(), timeout=30.0)
    with pytest.raises(typer.Exit) as exc_info:
        wait_for_import_job(
            client,
            "acme-corp",
            "job-2",
            no_progress=True,
            sleep=lambda _seconds: None,
        )
    assert exc_info.value.exit_code == EXIT_ERROR


def test_failure_detail_prefers_summary_then_falls_back_to_events() -> None:
    """summary.message wins; otherwise error-level events are surfaced with their code."""
    assert (
        _failure_detail({"summary": {"message": "parse error"}, "events": []})
        == "parse error"
    )
    # The REST engine records worker/import failures in events with no summary.
    assert (
        _failure_detail(
            {
                "events": [
                    {"level": "info", "message": "started"},
                    {"level": "error", "code": "WORKER_FAILED", "message": "boom"},
                ]
            }
        )
        == "[WORKER_FAILED] boom"
    )
    # An error event without a code is surfaced verbatim.
    assert (
        _failure_detail({"events": [{"level": "error", "message": "no code here"}]})
        == "no code here"
    )
    # Nothing usable -> None (caller prints a bare "Import failed.").
    assert _failure_detail({"state": "failed"}) is None
    assert _failure_detail({"events": [{"level": "info", "message": "fyi"}]}) is None


def test_failure_detail_prefers_taxonomy_error() -> None:
    """IXH-6.4: structured error beats summary and events."""
    detail = _failure_detail(
        {
            "summary": {"message": "ignored summary"},
            "events": [{"level": "error", "code": "PARSE_ERROR", "message": "legacy"}],
            "error": {
                "code": "INPUT_MALFORMED",
                "category": "input",
                "message": "not valid SDL",
                "remediation": "Fix the syntax and re-import.",
                "retriable": False,
            },
        }
    )
    assert detail == (
        "[INPUT_MALFORMED] not valid SDL — Fix the syntax and re-import."
    )


def test_wait_for_import_job_failed_uses_taxonomy_exit(
    httpx_mock: object, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failed job with category=input exits EXIT_USAGE (2), not EXIT_ERROR."""
    from apiome_cli.exit_codes import EXIT_USAGE

    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-tax",
        json={
            "state": "failed",
            "error": {
                "code": "INPUT_MALFORMED",
                "category": "input",
                "message": "not valid",
                "remediation": "Fix it.",
                "retriable": False,
            },
        },
    )
    client = RestClient(CliSettings(), timeout=30.0)
    with pytest.raises(typer.Exit) as exc_info:
        wait_for_import_job(
            client,
            "acme-corp",
            "job-tax",
            no_progress=True,
            sleep=lambda _seconds: None,
        )
    assert exc_info.value.exit_code == EXIT_USAGE
    err = capsys.readouterr().err
    assert "[INPUT_MALFORMED]" in err
    assert "Fix it." in err


def test_wait_for_import_job_failed_surfaces_event_error(
    httpx_mock: object, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failure carried only in events (no summary) still reaches the user on stderr."""
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-3",
        json={
            "state": "failed",
            "events": [
                {
                    "level": "error",
                    "code": "WORKER_FAILED",
                    "message": "No importer registered for openapi",
                }
            ],
        },
    )
    client = RestClient(CliSettings(), timeout=30.0)
    with pytest.raises(typer.Exit) as exc_info:
        wait_for_import_job(
            client,
            "acme-corp",
            "job-3",
            no_progress=True,
            sleep=lambda _seconds: None,
        )
    assert exc_info.value.exit_code == EXIT_ERROR
    err = capsys.readouterr().err
    assert "WORKER_FAILED" in err
    assert "No importer registered for openapi" in err


def test_wait_for_import_job_failure_message_not_glued_to_progress_spinner(
    httpx_mock: object, capsys: pytest.CaptureFixture[str]
) -> None:
    """With progress enabled, the failure message is emitted after the spinner clears, on its own line.

    Regression for the message rendering on top of the spinner line (e.g.
    "Import running… (0s)Import failed: …").
    """
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-4",
        json={"state": "failed", "summary": {"message": "A project with this slug already exists"}},
    )
    client = RestClient(CliSettings(), timeout=30.0)
    with pytest.raises(typer.Exit):
        wait_for_import_job(
            client,
            "acme-corp",
            "job-4",
            no_progress=False,
            sleep=lambda _seconds: None,
        )
    err = capsys.readouterr().err
    # The message is present and starts a line — never appended after spinner/progress text.
    assert any(
        line.strip() == "Import failed: A project with this slug already exists"
        for line in err.splitlines()
    ), err
    assert "running…Import failed" not in err.replace(" ", "")


def test_wait_for_import_job_timeout_exits_error() -> None:
    """Wall-clock timeout exits before the deadline is exceeded."""
    clock = {"now": 0.0}

    def monotonic() -> float:
        return clock["now"]

    def advance_sleep(_seconds: float) -> None:
        clock["now"] += 2.0

    client = MagicMock(spec=RestClient)
    client.get.return_value.json.return_value = {"status": "running"}

    with pytest.raises(typer.Exit) as exc_info:
        wait_for_import_job(
            client,
            "acme-corp",
            "job-3",
            timeout=1.0,
            poll_interval=0.5,
            no_progress=True,
            sleep=advance_sleep,
            monotonic=monotonic,
        )
    assert exc_info.value.exit_code == EXIT_ERROR
    client.get.assert_called()


def test_wait_for_import_job_enables_progress_unless_disabled(
    httpx_mock: object,
) -> None:
    """Poll loop enables the stderr spinner unless --no-progress is set."""
    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-4",
        json={"state": "completed"},
    )
    client = RestClient(CliSettings(), timeout=30.0)
    with patch("apiome_cli.import_.jobs.import_progress") as mock_progress:
        mock_progress.return_value.__enter__.return_value = None
        mock_progress.return_value.__exit__.return_value = None
        wait_for_import_job(
            client,
            "acme-corp",
            "job-4",
            no_progress=False,
            sleep=lambda _seconds: None,
        )
        mock_progress.assert_called_once_with(enabled=True)

    httpx_mock.add_response(
        url="http://localhost:8000/v1/tenants/acme-corp/imports/job-5",
        json={"state": "completed"},
    )
    with patch("apiome_cli.import_.jobs.import_progress") as mock_progress:
        mock_progress.return_value.__enter__.return_value = None
        mock_progress.return_value.__exit__.return_value = None
        wait_for_import_job(
            client,
            "acme-corp",
            "job-5",
            no_progress=True,
            sleep=lambda _seconds: None,
        )
        mock_progress.assert_called_once_with(enabled=False)


def test_root_help_lists_timeout_and_no_progress() -> None:
    """Global UX flags appear on root --help."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    help_text = strip_ansi(result.stdout)
    assert "--timeout" in help_text
    assert "--no-progress" in help_text


def test_timeout_from_context_defaults() -> None:
    """Commands use 30s unless --timeout is provided."""
    probe = runner.invoke(_context_app, ["timeout-probe"])
    assert probe.exit_code == 0
    assert probe.stdout.strip() == str(DEFAULT_TIMEOUT)

    probe = runner.invoke(_context_app, ["--timeout", "45", "timeout-probe"])
    assert probe.exit_code == 0
    assert probe.stdout.strip() == "45.0"


def test_import_timeout_from_context_default() -> None:
    """Import wait uses 120s when --timeout is omitted."""
    probe = runner.invoke(_context_app, ["import-timeout-probe"])
    assert probe.stdout.strip() == str(DEFAULT_IMPORT_TIMEOUT)

    probe = runner.invoke(_context_app, ["--timeout", "90", "import-timeout-probe"])
    assert probe.stdout.strip() == "90.0"


def test_no_progress_from_context() -> None:
    """--no-progress is visible to nested commands via context."""
    probe = runner.invoke(_context_app, ["no-progress-probe"])
    assert probe.stdout.strip() == "False"

    probe = runner.invoke(_context_app, ["--no-progress", "no-progress-probe"])
    assert probe.stdout.strip() == "True"


def test_import_subcommand_help_exits_zero() -> None:
    """import group is registered and documents itself."""
    result = runner.invoke(app, ["import", "--help"])
    assert result.exit_code == 0
    assert "Import OpenAPI" in result.stdout
    assert "Arazzo" in result.stdout


def test_default_poll_interval_is_one_second() -> None:
    """Poll interval default matches roadmap."""
    assert DEFAULT_POLL_INTERVAL == 1.0
