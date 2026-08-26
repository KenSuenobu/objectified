"""Terminal capability detection and human-output policy (clig.dev).

Three questions get asked all over the CLI, and before this module each caller answered
them differently or not at all:

* **May I use colour?** — ``clig.dev`` requires colour to be off when the stream is not a
  TTY, when ``NO_COLOR`` is set, when ``TERM=dumb``, or when the user asked for
  ``--no-color``. Bare ``rich.Console()`` handles some of that and ``typer.secho`` handles
  less; neither honours ``NO_COLOR`` on its own.
* **May I prompt?** — only when stdin is a TTY and the user did not pass ``--no-input``.
  A prompt in a CI job is a hang, and an abort with no explanation is barely better.
* **Should I stay quiet?** — ``--quiet`` suppresses non-essential human output while
  leaving errors on stderr and machine output on stdout untouched.

Every answer is resolved once, here, from the root callback's flags plus the environment,
so the whole CLI agrees. Policy is read through :func:`click.get_current_context` the same
way :func:`apiome_cli.client.errors.is_verbose` does, which keeps deep call sites free of
context plumbing.
"""

from __future__ import annotations

import os
import sys
from typing import IO, Any

import click
import typer
from rich.console import Console

from apiome_cli.exit_codes import EXIT_USAGE

__all__ = [
    "APP_NO_COLOR_ENV",
    "FORCE_COLOR_ENV",
    "NO_COLOR_ENV",
    "color_enabled",
    "confirm_action",
    "echo_notice",
    "interactive_enabled",
    "make_console",
    "quiet_enabled",
    "stdin_is_tty",
]

NO_COLOR_ENV = "NO_COLOR"
"""Cross-tool opt-out (https://no-color.org): honoured when set to a non-empty value."""

FORCE_COLOR_ENV = "FORCE_COLOR"
"""Opt back in when the stream is not a TTY (CI systems that render ANSI)."""

APP_NO_COLOR_ENV = "APIOME_NO_COLOR"
"""Apiome-specific colour opt-out, for users who want it off for this tool only."""


def _root_option(name: str) -> Any:
    """Read one root-callback option off the active Click context, if there is one."""
    ctx = click.get_current_context(silent=True)
    while ctx is not None:
        if isinstance(ctx.obj, dict) and name in ctx.obj:
            return ctx.obj[name]
        ctx = ctx.parent
    return None


def _env_flag(name: str) -> bool:
    """Whether an environment variable is present and not empty."""
    return bool(os.environ.get(name, "").strip())


def stdin_is_tty() -> bool:
    """Whether stdin is an interactive terminal.

    Wrapped rather than called inline so tests can monkeypatch one seam, and so a
    detached stdin (``isatty`` raising on a closed handle) degrades to "not a TTY"
    rather than crashing the command.
    """
    try:
        return bool(sys.stdin.isatty())
    except (AttributeError, ValueError):
        return False


def color_enabled(stream: IO[str] | None = None) -> bool:
    """Whether ANSI colour may be written to ``stream`` (default stdout).

    Precedence, highest first — the disables all beat ``FORCE_COLOR`` so an explicit
    opt-out is never overridden by an opt-in:

    1. ``--no-color`` on the root command
    2. ``NO_COLOR`` in the environment
    3. ``APIOME_NO_COLOR`` in the environment
    4. ``TERM=dumb``
    5. ``FORCE_COLOR`` in the environment
    6. whether the stream is a TTY
    """
    if bool(_root_option("no_color")):
        return False
    if _env_flag(NO_COLOR_ENV) or _env_flag(APP_NO_COLOR_ENV):
        return False
    if os.environ.get("TERM", "").strip().lower() == "dumb":
        return False
    if _env_flag(FORCE_COLOR_ENV):
        return True
    target = stream if stream is not None else sys.stdout
    try:
        return bool(target.isatty())
    except (AttributeError, ValueError):
        return False


def quiet_enabled() -> bool:
    """Whether ``--quiet`` was passed on the root command."""
    return bool(_root_option("quiet"))


def interactive_enabled() -> bool:
    """Whether the CLI may prompt: stdin is a TTY and ``--no-input`` was not passed."""
    if bool(_root_option("no_input")):
        return False
    return stdin_is_tty()


def make_console(*, stderr: bool = False, **kwargs: Any) -> Console:
    """Build a ``rich`` console that honours the resolved colour policy.

    Use this instead of ``Console()`` everywhere. ``no_color`` is passed explicitly
    because rich's own detection does not know about ``--no-color`` or
    ``APIOME_NO_COLOR``, and ``force_terminal`` is set only when colour is wanted on a
    non-TTY stream so ``FORCE_COLOR`` actually reaches the output.
    """
    target = sys.stderr if stderr else sys.stdout
    enabled = color_enabled(target)
    force_terminal: bool | None = True if enabled and not _is_tty(target) else None
    return Console(
        stderr=stderr,
        no_color=not enabled,
        force_terminal=force_terminal,
        **kwargs,
    )


def _is_tty(stream: IO[str]) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):
        return False


def echo_notice(message: str, *, err: bool = True) -> None:
    """Emit a non-essential human message, unless ``--quiet`` silenced it.

    Notices go to stderr by default so they never contaminate piped stdout — the
    ``clig.dev`` split between primary output and messaging.
    """
    if quiet_enabled():
        return
    typer.echo(message, err=err)


def confirm_action(
    prompt: str,
    *,
    skip: bool = False,
    escape_flag: str = "--yes",
    default: bool = False,
) -> None:
    """Confirm a consequential action, or exit.

    Args:
        prompt: The question to ask, phrased so that "no" is the safe answer.
        skip: True when the caller already passed the escape flag; confirms silently.
        escape_flag: The flag named in the non-interactive error, so a script author is
            told exactly how to proceed rather than being told only that they cannot.
        default: The default answer when the user just presses enter.

    Raises:
        typer.Exit: ``EXIT_SUCCESS`` when the user declines (declining is not an error),
            ``EXIT_USAGE`` when confirmation is impossible and the escape flag was not
            passed.
    """
    if skip:
        return
    if not interactive_enabled():
        typer.echo(
            f"{prompt}\nRefusing to continue without confirmation: "
            f"no interactive terminal. Pass {escape_flag} to proceed non-interactively.",
            err=True,
        )
        raise typer.Exit(EXIT_USAGE)
    if not typer.confirm(prompt, default=default):
        raise typer.Exit(0)
