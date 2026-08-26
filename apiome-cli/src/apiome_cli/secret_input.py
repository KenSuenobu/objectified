"""Read credentials from files or stdin instead of the command line (clig.dev).

``clig.dev`` is unambiguous about this: *"Never accept secrets via flags."* A secret in
``argv`` is visible to every other process on the box through ``ps``, and it lands in
shell history, in CI job logs, and in any crash reporter that captures the command line.
The same guide rules out environment variables for the same reason — they leak through
``/proc``, container inspection, and child processes.

``--api-key`` and ``--session-token`` predate this module and stay for compatibility, but
every command now also accepts ``--api-key-file`` / ``--session-token-file``, which read
the value from a file or, with ``-``, from stdin. Those are the documented path.
"""

from __future__ import annotations

import sys
from pathlib import Path

import typer

from apiome_cli.exit_codes import EXIT_USAGE

__all__ = ["STDIN_SENTINEL", "read_secret_file"]

STDIN_SENTINEL = "-"
"""Conventional filename meaning "read stdin" (clig.dev: support ``-`` for piping)."""

_MAX_SECRET_BYTES = 64 * 1024
"""Refuse absurd inputs early rather than loading an arbitrary file into memory."""


def read_secret_file(path: str | None, *, label: str) -> str | None:
    """Return the secret held in ``path``, or ``None`` when no path was given.

    A single trailing newline is stripped, because ``echo secret > key.txt`` is how these
    files are made and requiring ``printf`` would be a papercut. Interior whitespace is
    preserved: it might be part of the value.

    Args:
        path: File to read, ``-`` for stdin, or ``None``.
        label: Flag name used in error messages, e.g. ``--api-key-file``.

    Returns:
        The secret, or ``None`` when ``path`` is ``None``.

    Raises:
        typer.Exit: ``EXIT_USAGE`` when the file is missing, unreadable, or empty.
    """
    if path is None:
        return None

    if path == STDIN_SENTINEL:
        raw = sys.stdin.read(_MAX_SECRET_BYTES + 1)
        source = "stdin"
    else:
        resolved = Path(path).expanduser()
        try:
            raw = resolved.read_text(encoding="utf-8")[: _MAX_SECRET_BYTES + 1]
        except FileNotFoundError:
            typer.echo(f"{label}: no such file: {resolved}", err=True)
            raise typer.Exit(EXIT_USAGE) from None
        except IsADirectoryError:
            typer.echo(f"{label}: not a file: {resolved}", err=True)
            raise typer.Exit(EXIT_USAGE) from None
        except OSError as exc:
            typer.echo(f"{label}: cannot read {resolved}: {exc.strerror}", err=True)
            raise typer.Exit(EXIT_USAGE) from exc
        source = str(resolved)

    if len(raw) > _MAX_SECRET_BYTES:
        typer.echo(f"{label}: {source} is too large to be a credential.", err=True)
        raise typer.Exit(EXIT_USAGE)

    secret = raw.removesuffix("\n")
    secret = secret.rstrip("\r")
    if not secret.strip():
        typer.echo(f"{label}: {source} is empty.", err=True)
        raise typer.Exit(EXIT_USAGE)
    return secret
