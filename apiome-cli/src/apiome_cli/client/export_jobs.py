"""Async export job client — submit, poll, and download (MFX-3.1 / MFX-8.1).

Thin HTTP helpers over the export job surface apiome-rest exposes:

* ``POST /v1/export/{tenant}/jobs`` — accept an export job (202 + poll path);
* ``GET /v1/export/{tenant}/jobs/{job_id}`` — poll until terminal;
* ``GET /v1/export/{tenant}/jobs/{job_id}/download`` — fetch the emitted artifact bytes.

Presentation and filesystem writes live in :mod:`apiome_cli.export_dispatch`.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.progress import import_progress
from apiome_cli.taxonomy_exit import (
    format_taxonomy_error,
    taxonomy_failure_from_payload,
)

DEFAULT_EXPORT_POLL_INTERVAL = 1.0

_TERMINAL_STATES = frozenset({"completed", "failed", "canceled"})


def format_export_progress(state: str, *, elapsed_seconds: float) -> str:
    """Build a single-line stderr status message for the export poll loop."""
    elapsed = max(0, int(elapsed_seconds))
    return f"Export {state}… ({elapsed}s)"


def _failure_detail(payload: Mapping[str, Any]) -> str | None:
    """Best-effort human-readable reason for a non-completed terminal export.

    Prefers the structured delivery-taxonomy ``error`` (IXH-6.4). ``STALE_PREVIEW``
    still appends abbreviated snapshot hashes from ``context`` when present.
    """
    error = payload.get("error")
    if isinstance(error, Mapping):
        code = error.get("code")
        if isinstance(code, str) and code.strip() == "STALE_PREVIEW":
            context = error.get("context")
            message = error.get("message")
            remediation = error.get("remediation")
            if isinstance(context, Mapping):
                ack = context.get("acknowledged_snapshot")
                current = context.get("current_snapshot")
                if isinstance(ack, str) and isinstance(current, str):
                    rem = (
                        remediation.strip()
                        if isinstance(remediation, str) and remediation.strip()
                        else "Re-run export preview and acknowledge the current snapshot."
                    )
                    msg = (
                        message.strip()
                        if isinstance(message, str) and message.strip()
                        else "Preview snapshot is stale."
                    )
                    return (
                        f"[STALE_PREVIEW] {msg} "
                        f"(acknowledged {ack[:12]}…, current {current[:12]}…). "
                        f"{rem}"
                    )
            return format_taxonomy_error(error)

        taxonomy = format_taxonomy_error(error)
        if taxonomy:
            return taxonomy

    events = payload.get("events")
    if isinstance(events, list):
        messages: list[str] = []
        for event in events:
            if not isinstance(event, Mapping):
                continue
            if str(event.get("level") or "").lower() != "error":
                continue
            message = event.get("message")
            if not isinstance(message, str) or not message.strip():
                continue
            ev_code = event.get("code")
            if isinstance(ev_code, str) and ev_code.strip():
                messages.append(f"[{ev_code.strip()}] {message.strip()}")
            else:
                messages.append(message.strip())
        if messages:
            return "; ".join(messages)

    return None


def _exit_code_for_failure(payload: Mapping[str, Any]) -> int:
    """Derive the process exit code from the delivery taxonomy category when present."""
    _, exit_code = taxonomy_failure_from_payload(payload)
    error = payload.get("error")
    if isinstance(error, Mapping) and (
        (isinstance(error.get("code"), str) and str(error["code"]).strip())
        or (isinstance(error.get("category"), str) and str(error["category"]).strip())
    ):
        return exit_code
    return EXIT_ERROR


def start_export_job(
    client: RestClient,
    tenant_slug: str,
    *,
    artifact: str,
    version: str | None,
    target: str,
    options: Mapping[str, Any] | None = None,
    confirm: bool = False,
    acknowledged_snapshot: str | None = None,
) -> dict[str, Any]:
    """Submit ``POST /v1/export/{tenant}/jobs`` and return the 202 acceptance payload."""
    body: dict[str, Any] = {"artifact": artifact, "target": target, "confirm": confirm}
    if version is not None:
        body["version"] = version
    if options:
        body["options"] = dict(options)
    if acknowledged_snapshot:
        body["acknowledged_snapshot"] = acknowledged_snapshot
    response = client.post(api_paths.export_jobs(tenant_slug), json=body)
    payload = response.json()
    if not isinstance(payload, dict):
        typer.echo("Export job acceptance response was not a JSON object.", err=True)
        raise typer.Exit(EXIT_ERROR)
    return payload


def wait_for_export_job(
    client: RestClient,
    tenant_slug: str,
    job_id: str,
    *,
    poll_interval: float = DEFAULT_EXPORT_POLL_INTERVAL,
    timeout: float,
    no_progress: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Poll ``GET /v1/export/{tenant}/jobs/{job_id}`` until a terminal state."""
    deadline = monotonic() + timeout
    path = api_paths.export_job(tenant_slug, job_id)

    error_message: str | None = None
    failure_exit: int = EXIT_ERROR
    with import_progress(enabled=not no_progress, initial_message="Exporting…") as status:
        while True:
            if monotonic() >= deadline:
                timeout_seconds = int(timeout)
                unit = "second" if timeout_seconds == 1 else "seconds"
                error_message = f"Export timed out after {timeout_seconds} {unit}."
                failure_exit = EXIT_ERROR
                break

            response = client.get(path)
            payload = response.json()
            if not isinstance(payload, dict):
                error_message = "Export status response was not a JSON object."
                failure_exit = EXIT_ERROR
                break

            job_state = payload.get("state")
            if not isinstance(job_state, str) or not job_state:
                error_message = "Export status response missing state field."
                failure_exit = EXIT_ERROR
                break

            elapsed = timeout - (deadline - monotonic())
            if status is not None:
                status.update(format_export_progress(job_state, elapsed_seconds=elapsed))

            if job_state in _TERMINAL_STATES:
                if job_state == "completed":
                    return payload
                detail = _failure_detail(payload)
                error_message = f"Export {job_state}: {detail}" if detail else f"Export {job_state}."
                failure_exit = _exit_code_for_failure(payload)
                break

            remaining = deadline - monotonic()
            if remaining <= 0:
                continue
            sleep(min(poll_interval, remaining))

    typer.echo(error_message, err=True)
    raise typer.Exit(failure_exit)


def download_export_job_artifact(
    client: RestClient,
    *,
    download_path: str | None,
    tenant_slug: str,
    job_id: str,
) -> tuple[bytes, str | None, str | None]:
    """Fetch the emitted artifact bytes for a completed export job.

    Returns
    -------
    tuple[bytes, str | None, str | None]
        Body bytes, ``Content-Type``, and ``Content-Disposition`` (if any).
    """
    path = download_path or api_paths.export_job_download(tenant_slug, job_id)
    response = client.get_raw(path)
    return (
        response.content,
        response.headers.get("Content-Type"),
        response.headers.get("Content-Disposition"),
    )


def filename_from_disposition(disposition: str | None) -> str | None:
    """Extract the ``filename="…"`` hint from a ``Content-Disposition`` header."""
    if not disposition:
        return None
    marker = 'filename="'
    start = disposition.find(marker)
    if start == -1:
        return None
    start += len(marker)
    end = disposition.find('"', start)
    if end == -1:
        return None
    return disposition[start:end] or None
