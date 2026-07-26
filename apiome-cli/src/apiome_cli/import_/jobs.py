"""Poll specification import jobs until a terminal REST state is returned."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient
from apiome_cli.cli_context import DEFAULT_IMPORT_TIMEOUT
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.progress import import_progress
from apiome_cli.taxonomy_exit import taxonomy_failure_from_payload

DEFAULT_POLL_INTERVAL = 1.0

_TERMINAL_STATES = frozenset({"completed", "failed", "canceled", "rolled-back"})


def format_import_progress(state: str, *, elapsed_seconds: float) -> str:
    """Build a single-line stderr status message for the import poll loop."""
    elapsed = max(0, int(elapsed_seconds))
    return f"Import {state}… ({elapsed}s)"


def _failure_detail(payload: dict[str, Any]) -> str | None:
    """Best-effort human-readable reason for a non-completed terminal import.

    Prefers the structured taxonomy ``error`` object (IXH-6.4), then
    ``summary.message``, then error-level events. Returns ``None`` when the
    payload carries no usable detail.
    """
    taxonomy_detail, _ = taxonomy_failure_from_payload(payload)
    if taxonomy_detail:
        return taxonomy_detail

    summary = payload.get("summary")
    if isinstance(summary, dict):
        message = summary.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()

    events = payload.get("events")
    if isinstance(events, list):
        messages: list[str] = []
        for event in events:
            if not isinstance(event, dict):
                continue
            if str(event.get("level") or "").lower() != "error":
                continue
            message = event.get("message")
            if not isinstance(message, str) or not message.strip():
                continue
            code = event.get("code")
            if isinstance(code, str) and code.strip():
                messages.append(f"[{code.strip()}] {message.strip()}")
            else:
                messages.append(message.strip())
        if messages:
            return "; ".join(messages)

    return None


def _exit_code_for_failure(payload: dict[str, Any]) -> int:
    """Derive the process exit code from the taxonomy category when present."""
    _, exit_code = taxonomy_failure_from_payload(payload)
    error = payload.get("error")
    if isinstance(error, dict) and (
        (isinstance(error.get("code"), str) and error["code"].strip())
        or (isinstance(error.get("category"), str) and error["category"].strip())
    ):
        return exit_code
    return EXIT_ERROR


def wait_for_import_job(
    client: RestClient,
    tenant_slug: str,
    job_id: str,
    *,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
    timeout: float = DEFAULT_IMPORT_TIMEOUT,
    no_progress: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Poll ``GET /v1/tenants/{tenant_slug}/imports/{job_id}`` until terminal."""
    deadline = monotonic() + timeout
    path = api_paths.tenant_import(tenant_slug, job_id)

    # Error messaging is deferred until after the progress spinner's context exits: printing while the
    # Rich spinner is live renders the message on top of the spinner line (e.g.
    # "Import running… (0s)Import failed: …"). Inside the loop we only set `error_message` and break;
    # the message is echoed below, once the spinner has been cleared.
    error_message: str | None = None
    failure_exit: int = EXIT_ERROR
    with import_progress(enabled=not no_progress) as status:
        while True:
            if monotonic() >= deadline:
                timeout_seconds = int(timeout)
                unit = "second" if timeout_seconds == 1 else "seconds"
                error_message = f"Import timed out after {timeout_seconds} {unit}."
                failure_exit = EXIT_ERROR
                break

            response = client.get(path)
            payload = response.json()
            if not isinstance(payload, dict):
                error_message = "Import status response was not a JSON object."
                failure_exit = EXIT_ERROR
                break

            job_state = payload.get("state")
            if not isinstance(job_state, str) or not job_state:
                error_message = "Import status response missing state field."
                failure_exit = EXIT_ERROR
                break

            elapsed = timeout - (deadline - monotonic())
            if status is not None:
                status.update(
                    format_import_progress(job_state, elapsed_seconds=elapsed),
                )

            if job_state in _TERMINAL_STATES:
                if job_state == "completed":
                    return payload
                detail = _failure_detail(payload)
                error_message = f"Import {job_state}: {detail}" if detail else f"Import {job_state}."
                failure_exit = _exit_code_for_failure(payload)
                break

            remaining = deadline - monotonic()
            if remaining <= 0:
                continue
            sleep(min(poll_interval, remaining))

    typer.echo(error_message, err=True)
    raise typer.Exit(failure_exit)
