"""Generic ``apiome export <format> <artifact>`` job runner (MFX-8.1).

Resolves the emitter against the registry, submits an async export job, polls to completion,
downloads the artifact, and writes a single file or unpacks a zip bundle to ``--out``.
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Mapping, Sequence
from io import BytesIO
from pathlib import Path
from typing import Any

import typer

from apiome_cli.cli_context import (
    import_timeout_from_context,
    insecure_from_context,
    json_mode_from_context,
    no_progress_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client.browse_scope import resolve_tenant_slug
from apiome_cli.client.export_jobs import (
    download_export_job_artifact,
    filename_from_disposition,
    start_export_job,
    wait_for_export_job,
)
from apiome_cli.client.export_registry import (
    fetch_export_preview,
    fetch_export_targets,
    preview_fidelity,
    projection_snapshot_hash,
    resolve_export_target,
    unknown_export_target_message,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.project_version_resolve import resolve_project_uuid
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE
from apiome_cli.export_output import (
    enforce_export_fidelity_gate,
    format_export_fidelity_summary,
)
from apiome_cli.preflight_runner import gate_export_before_job
from apiome_cli.spec_output import SpecExportMetadata, emit_download_metadata, write_document_bytes


def parse_export_options(option_values: Sequence[str]) -> dict[str, Any]:
    """Parse repeatable ``--option key=value`` flags into an options bag."""
    options: dict[str, Any] = {}
    for raw in option_values:
        entry = raw.strip()
        if not entry or "=" not in entry:
            typer.echo(
                f"Invalid --option {raw!r}; expected key=value (e.g. --option openapi_version=3.1).",
                err=True,
            )
            raise typer.Exit(EXIT_USAGE)
        key, _, value = entry.partition("=")
        key = key.strip()
        if not key:
            typer.echo(f"Invalid --option {raw!r}; key cannot be empty.", err=True)
            raise typer.Exit(EXIT_USAGE)
        value = value.strip()
        try:
            options[key] = json.loads(value)
        except json.JSONDecodeError:
            options[key] = value
    return options


def is_zip_bundle(*, content_type: str | None, body: bytes) -> bool:
    """Return True when the download body is a zip bundle."""
    if content_type and "zip" in content_type.lower():
        return True
    return len(body) >= 2 and body[:2] == b"PK"


def _basename_from_files(files: Sequence[Mapping[str, Any]] | None) -> str | None:
    if not files:
        return None
    first = files[0]
    if not isinstance(first, Mapping):
        return None
    path = first.get("path")
    if isinstance(path, str) and path.strip():
        return Path(path).name
    return None


def _out_is_directory(out: str) -> bool:
    if out == "-":
        return False
    if out.endswith("/"):
        return True
    path = Path(out)
    if path.exists():
        return path.is_dir()
    # A path that does not exist yet without a file extension is treated as a directory intent.
    return path.suffix == ""


def write_export_artifact(
    body: bytes,
    *,
    out: str,
    content_type: str | None,
    files: Sequence[Mapping[str, Any]] | None,
    disposition_filename: str | None,
) -> tuple[int, str]:
    """Write export bytes to ``--out`` (file, directory, stdout, or ``.zip``).

    Returns ``(bytes_written, effective_output_path)``.
    """
    if is_zip_bundle(content_type=content_type, body=body):
        out_path = Path(out)
        if out_path.suffix.lower() == ".zip" and not _out_is_directory(out):
            write_document_bytes(body, out)
            return len(body), out
        if not _out_is_directory(out):
            typer.echo(
                "This export is a multi-file bundle. Use --out with a directory (or a .zip path).",
                err=True,
            )
            raise typer.Exit(EXIT_USAGE)
        out_path.mkdir(parents=True, exist_ok=True)
        total = 0
        with zipfile.ZipFile(BytesIO(body)) as archive:
            for member in archive.namelist():
                if member.endswith("/"):
                    (out_path / member).mkdir(parents=True, exist_ok=True)
                    continue
                target = out_path / member
                target.parent.mkdir(parents=True, exist_ok=True)
                data = archive.read(member)
                target.write_bytes(data)
                total += len(data)
        return total, str(out_path)

    if _out_is_directory(out):
        filename = disposition_filename or _basename_from_files(files) or "export"
        destination = str(Path(out) / filename)
        write_document_bytes(body, destination)
        return len(body), destination

    write_document_bytes(body, out)
    return len(body), out


def _fidelity_metadata(fidelity: dict[str, object] | None) -> dict[str, object] | None:
    if not isinstance(fidelity, dict):
        return None
    summary = fidelity.get("summary")
    if not isinstance(summary, dict):
        return None
    payload: dict[str, object] = {"status": summary.get("tier")}
    for key in ("preserved_percent", "dropped", "approximated", "synthesized"):
        if key in summary:
            payload[key] = summary[key]
    return payload


def run_generic_export(
    ctx: typer.Context,
    *,
    target_format: str,
    artifact: str,
    version: str | None,
    out: str | None,
    option_values: Sequence[str],
    force: bool,
    confirm: bool,
    poll_interval: float,
    export_timeout_override: float | None,
    min_grade: str | None = None,
    fail_on: str | None = None,
) -> None:
    """Resolve ``target_format``, run the async export job, and write the artifact.

    When ``--min-grade`` / ``--fail-on`` are supplied the export is pre-flighted first
    (IXH-2.6) and a blocking verdict stops the run **before** the job is submitted, so a
    gated pipeline never leaves a half-finished export job behind.
    """
    settings = settings_from_context(ctx)
    require_api_key(settings)

    if out is None or not out.strip():
        typer.echo("--out is required (file path, directory, '-' for stdout, or .zip).", err=True)
        raise typer.Exit(EXIT_USAGE)
    out = out.strip()

    client = RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=None)

    project_id = resolve_project_uuid(client, tenant_slug, artifact)
    targets_response = fetch_export_targets(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
    )
    targets = targets_response.get("targets")
    if not isinstance(targets, list):
        typer.echo("Export targets response was missing a targets list.", err=True)
        raise typer.Exit(EXIT_ERROR)

    try:
        target_key = resolve_export_target(target_format, targets)
    except ValueError:
        typer.echo(unknown_export_target_message(target_format, targets), err=True)
        raise typer.Exit(EXIT_USAGE) from None

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[target_key],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    options = parse_export_options(option_values)
    export_timeout = (
        export_timeout_override
        if export_timeout_override is not None
        else import_timeout_from_context(ctx)
    )

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=target_key,
        options=options or None,
    )
    acknowledged_snapshot = projection_snapshot_hash(preview)

    accepted = start_export_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=target_key,
        options=options or None,
        confirm=confirm,
        acknowledged_snapshot=acknowledged_snapshot,
    )
    job_id = accepted.get("job_id")
    if not isinstance(job_id, str) or not job_id:
        typer.echo("Export job acceptance response missing job_id.", err=True)
        raise typer.Exit(EXIT_ERROR)

    status = wait_for_export_job(
        client,
        tenant_slug,
        job_id,
        poll_interval=poll_interval,
        timeout=export_timeout,
        no_progress=no_progress_from_context(ctx),
    )
    result = status.get("result")
    if not isinstance(result, dict):
        typer.echo("Completed export job missing result payload.", err=True)
        raise typer.Exit(EXIT_ERROR)

    fidelity = preview_fidelity({"fidelity": result.get("fidelity")})
    download_path = result.get("download_path")
    if not isinstance(download_path, str) or not download_path:
        typer.echo("Completed export job missing download_path.", err=True)
        raise typer.Exit(EXIT_ERROR)

    body, content_type, disposition = download_export_job_artifact(
        client,
        download_path=download_path,
        tenant_slug=tenant_slug,
        job_id=job_id,
    )
    files = result.get("files")
    file_rows = files if isinstance(files, list) else None
    disposition_name = filename_from_disposition(disposition)

    bytes_written, effective_out = write_export_artifact(
        body,
        out=out,
        content_type=content_type,
        files=file_rows,
        disposition_filename=disposition_name,
    )

    json_mode = json_mode_from_context(ctx)
    result_snapshot = result.get("snapshot_hash")
    metadata = SpecExportMetadata(
        output=effective_out,
        bytes_written=bytes_written,
        content_type=content_type,
        format=target_format,
        fidelity_target=target_key,
        fidelity=_fidelity_metadata(fidelity if isinstance(fidelity, dict) else None),
        filename=disposition_name,
        snapshot_hash=result_snapshot if isinstance(result_snapshot, str) else None,
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=target_key):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(
        fidelity if isinstance(fidelity, dict) else None,
        force=force,
    )
