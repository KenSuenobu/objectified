"""Terminal policy, prompt discipline, and file-sourced secrets (clig.dev conformance).

These cover the guarantees the guidelines make about a CLI's *behaviour in context*: that
colour disappears off a terminal and under ``NO_COLOR``, that a prompt never fires where
nobody can answer it, and that a credential never has to appear in ``argv``.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from apiome_cli.cli_context import settings_from_context
from apiome_cli.exit_codes import EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app
from apiome_cli.secret_input import read_secret_file
from apiome_cli.terminal import (
    color_enabled,
    confirm_action,
    echo_notice,
    interactive_enabled,
    make_console,
    quiet_enabled,
)

runner = CliRunner()


class _Stream(io.StringIO):
    """A StringIO that can claim to be a terminal."""

    def __init__(self, tty: bool) -> None:
        super().__init__()
        self._tty = tty

    def isatty(self) -> bool:
        # Match a real stream: isatty() on a closed file raises rather than answering.
        if self.closed:
            raise ValueError("I/O operation on closed file")
        return self._tty


@pytest.fixture(autouse=True)
def _clear_colour_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Colour env vars leak in from the developer's shell and from CI; clear them."""
    for name in ("NO_COLOR", "APIOME_NO_COLOR", "FORCE_COLOR", "TERM"):
        monkeypatch.delenv(name, raising=False)


# ---------------------------------------------------------------------------
# Colour policy
# ---------------------------------------------------------------------------


def test_color_enabled_on_a_terminal() -> None:
    assert color_enabled(_Stream(tty=True)) is True


def test_color_disabled_when_not_a_terminal() -> None:
    """The pipe case: `apiome ... | grep` must not receive ANSI escapes."""
    assert color_enabled(_Stream(tty=False)) is False


@pytest.mark.parametrize("var", ["NO_COLOR", "APIOME_NO_COLOR"])
def test_color_disabled_by_opt_out_env(monkeypatch: pytest.MonkeyPatch, var: str) -> None:
    monkeypatch.setenv(var, "1")
    assert color_enabled(_Stream(tty=True)) is False


@pytest.mark.parametrize("var", ["NO_COLOR", "APIOME_NO_COLOR"])
def test_empty_opt_out_env_is_not_an_opt_out(
    monkeypatch: pytest.MonkeyPatch, var: str
) -> None:
    """no-color.org: the variable counts only when present *and non-empty*."""
    monkeypatch.setenv(var, "")
    assert color_enabled(_Stream(tty=True)) is True


def test_color_disabled_by_dumb_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM", "dumb")
    assert color_enabled(_Stream(tty=True)) is False


def test_force_color_enables_colour_off_a_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CI systems that render ANSI can opt back in."""
    monkeypatch.setenv("FORCE_COLOR", "1")
    assert color_enabled(_Stream(tty=False)) is True


def test_no_color_beats_force_color(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit opt-out is never overridden by an opt-in."""
    monkeypatch.setenv("FORCE_COLOR", "1")
    monkeypatch.setenv("NO_COLOR", "1")
    assert color_enabled(_Stream(tty=True)) is False


def test_make_console_reports_no_colour_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_COLOR", "1")
    assert make_console().no_color is True


def test_closed_stream_degrades_rather_than_raising() -> None:
    """A detached stdout must not turn a working command into a crash."""
    stream = _Stream(tty=True)
    stream.close()
    assert color_enabled(stream) is False


# ---------------------------------------------------------------------------
# Root flags reach the policy
# ---------------------------------------------------------------------------


def test_root_flags_are_advertised_in_help() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == EXIT_SUCCESS
    for flag in ("--no-color", "--quiet", "--no-input", "--api-key-file"):
        assert flag in result.output


def test_debug_is_an_alias_for_verbose() -> None:
    """clig.dev discourages overloading -v; -d/--debug is the documented spelling."""
    result = runner.invoke(app, ["--help"])
    assert "--debug" in result.output


def test_no_color_flag_disables_colour_via_context() -> None:
    """The flag has to reach deep call sites, which read it off the Click context."""
    captured: dict[str, bool] = {}

    @app.command("colour-probe", hidden=True)
    def _probe() -> None:
        captured["enabled"] = color_enabled(_Stream(tty=True))
        captured["quiet"] = quiet_enabled()

    assert runner.invoke(app, ["--no-color", "colour-probe"]).exit_code == EXIT_SUCCESS
    assert captured["enabled"] is False

    captured.clear()
    assert runner.invoke(app, ["colour-probe"]).exit_code == EXIT_SUCCESS
    assert captured["enabled"] is True
    assert captured["quiet"] is False


def test_quiet_flag_silences_notices() -> None:
    seen: dict[str, str] = {}

    @app.command("notice-probe", hidden=True)
    def _probe() -> None:
        echo_notice("a non-essential message")
        seen["quiet"] = str(quiet_enabled())

    loud = runner.invoke(app, ["notice-probe"])
    assert "a non-essential message" in loud.output

    quiet = runner.invoke(app, ["--quiet", "notice-probe"])
    assert "a non-essential message" not in quiet.output


# ---------------------------------------------------------------------------
# Prompt discipline
# ---------------------------------------------------------------------------


def test_confirm_action_returns_immediately_when_skipped() -> None:
    confirm_action("Delete everything?", skip=True)


def test_confirm_action_refuses_without_a_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A prompt in CI is a hang; failing with the escape flag named is the fix."""
    monkeypatch.setattr("apiome_cli.terminal.stdin_is_tty", lambda: False)
    with pytest.raises(typer.Exit) as exc:
        confirm_action("Revoke key?", skip=False, escape_flag="--yes")
    assert exc.value.exit_code == EXIT_USAGE


def test_confirm_action_names_the_escape_flag(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("apiome_cli.terminal.stdin_is_tty", lambda: False)
    with pytest.raises(typer.Exit):
        confirm_action("Revoke key?", skip=False, escape_flag="--yes")
    assert "--yes" in capsys.readouterr().err


def test_declining_a_prompt_is_not_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Saying "no" is a successful outcome, not a failed command."""
    monkeypatch.setattr("apiome_cli.terminal.stdin_is_tty", lambda: True)
    monkeypatch.setattr("typer.confirm", lambda *a, **k: False)
    with pytest.raises(typer.Exit) as exc:
        confirm_action("Revoke key?", skip=False)
    assert exc.value.exit_code == EXIT_SUCCESS


def test_no_input_suppresses_interactivity() -> None:
    captured: dict[str, bool] = {}

    @app.command("interactive-probe", hidden=True)
    def _probe() -> None:
        captured["interactive"] = interactive_enabled()

    assert runner.invoke(app, ["--no-input", "interactive-probe"]).exit_code == 0
    assert captured["interactive"] is False


# ---------------------------------------------------------------------------
# Secrets from files, not argv
# ---------------------------------------------------------------------------


def test_read_secret_file_returns_none_without_a_path() -> None:
    assert read_secret_file(None, label="--api-key-file") is None


def test_read_secret_file_strips_one_trailing_newline(tmp_path: Path) -> None:
    """`echo secret > key.txt` is how these files get made."""
    path = tmp_path / "key.txt"
    path.write_text("sk-abc123\n", encoding="utf-8")
    assert read_secret_file(str(path), label="--api-key-file") == "sk-abc123"


def test_read_secret_file_preserves_interior_whitespace(tmp_path: Path) -> None:
    path = tmp_path / "key.txt"
    path.write_text("two words\n", encoding="utf-8")
    assert read_secret_file(str(path), label="--api-key-file") == "two words"


def test_read_secret_file_reads_stdin_with_dash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("piped-secret\n"))
    assert read_secret_file("-", label="--api-key-file") == "piped-secret"


def test_read_secret_file_rejects_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(typer.Exit) as exc:
        read_secret_file(str(tmp_path / "absent"), label="--api-key-file")
    assert exc.value.exit_code == EXIT_USAGE


def test_read_secret_file_rejects_an_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "key.txt"
    path.write_text("\n", encoding="utf-8")
    with pytest.raises(typer.Exit) as exc:
        read_secret_file(str(path), label="--api-key-file")
    assert exc.value.exit_code == EXIT_USAGE


def test_read_secret_file_error_names_the_flag(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(typer.Exit):
        read_secret_file(str(tmp_path / "absent"), label="--api-key-file")
    assert "--api-key-file" in capsys.readouterr().err


def test_api_key_file_reaches_resolved_settings(tmp_path: Path) -> None:
    """End to end: the flag has to land where the HTTP client reads it."""
    path = tmp_path / "key.txt"
    path.write_text("sk-from-file\n", encoding="utf-8")
    captured: dict[str, str | None] = {}

    @app.command("settings-probe", hidden=True)
    def _probe(ctx: typer.Context) -> None:
        captured["api_key"] = settings_from_context(ctx).api_key_value()

    result = runner.invoke(app, ["--api-key-file", str(path), "settings-probe"])
    assert result.exit_code == EXIT_SUCCESS
    assert captured["api_key"] == "sk-from-file"


def test_api_key_file_wins_over_the_inline_flag(tmp_path: Path) -> None:
    """A caller supplying both has moved to the safe form; honour that."""
    path = tmp_path / "key.txt"
    path.write_text("sk-from-file\n", encoding="utf-8")
    captured: dict[str, str | None] = {}

    @app.command("settings-probe-2", hidden=True)
    def _probe(ctx: typer.Context) -> None:
        captured["api_key"] = settings_from_context(ctx).api_key_value()

    result = runner.invoke(
        app,
        ["--api-key", "sk-inline", "--api-key-file", str(path), "settings-probe-2"],
    )
    assert result.exit_code == EXIT_SUCCESS
    assert captured["api_key"] == "sk-from-file"
