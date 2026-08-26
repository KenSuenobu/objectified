"""stderr progress feedback for long-running CLI operations."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from contextlib import contextmanager

from rich.status import Status

from apiome_cli.terminal import make_console, quiet_enabled


def progress_allowed(enabled: bool) -> bool:
    """Whether an animated spinner should run at all.

    ``clig.dev`` asks for animations to be suppressed off a terminal — a spinner
    redrawing into a CI log leaves thousands of frames behind — and ``--quiet`` means
    the user asked for silence on the non-essential channel, which is what this is.
    The caller's own ``--no-progress`` still wins over everything.
    """
    if not enabled or quiet_enabled():
        return False
    try:
        return bool(sys.stderr.isatty())
    except (AttributeError, ValueError):
        return False


@contextmanager
def import_progress(
    *,
    enabled: bool = True,
    initial_message: str = "Importing…",
) -> Iterator[Status | None]:
    """Show a Rich spinner on stderr while an import job is polled.

    Args:
        enabled: When False, yield None and do not write to stderr.
        initial_message: First status line shown when progress is enabled.

    Yields:
        A Rich ``Status`` instance to update, or None when progress is disabled —
        which is also what happens under ``--quiet`` or when stderr is not a terminal.
    """
    if not progress_allowed(enabled):
        yield None
        return

    console = make_console(stderr=True)
    with console.status(initial_message, spinner="dots") as status:
        yield status
