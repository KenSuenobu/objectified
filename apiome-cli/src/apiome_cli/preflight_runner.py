"""Fetch → render → gate orchestration for the pre-flight surface (IXH-2.6).

One module both entry points share, so the report the dedicated ``import preflight`` /
``export preflight`` commands print and the verdict the ``--min-grade`` / ``--fail-on``
flags enforce can never drift:

* :func:`emit_import_preflight` / :func:`emit_export_preflight` render a report — verbatim
  JSON under ``--json``, a readable table otherwise.
* :func:`enforce_gate` turns a :class:`~apiome_cli.preflight.GateOutcome` into the process
  exit code, printing every reason it tripped to stderr.
* :func:`gate_import_before_job` / :func:`gate_export_before_job` are the short-circuits the
  import and export commands call **before** they create a job or emit a byte.

Stream discipline: the pre-flight commands write their report to stdout (it is the command's
output). The gate flags write only diagnostics, always to stderr, so ``export openapi
--output -`` stays byte-safe and a gated ``--json`` import still emits exactly one JSON
document on stdout.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import click
import typer

from apiome_cli.cli_context import no_progress_from_context
from apiome_cli.client.http import RestClient
from apiome_cli.client.preflight import (
    build_import_preflight_body,
    fetch_export_preflight,
    fetch_import_preflight,
)
from apiome_cli.output import emit_json, emit_list_table
from apiome_cli.preflight import (
    EXPORT_PREFLIGHT_TARGET_COLUMNS,
    PREFLIGHT_FINDING_COLUMNS,
    GateOutcome,
    PreflightFlagError,
    evaluate_export_gate,
    evaluate_import_gate,
    export_target_rows,
    finding_overflow,
    finding_rows,
    format_blocked_target_lines,
    format_export_preflight_lines,
    format_import_preflight_lines,
    gating_requested,
    normalize_fail_on,
    normalize_min_grade,
)


def coerce_gate_flags(
    min_grade: str | None,
    fail_on: str | None,
) -> tuple[str | None, str | None]:
    """Validate the two gate flags, turning a bad value into a Click usage error.

    Args:
        min_grade: Raw ``--min-grade`` value, or ``None``.
        fail_on: Raw ``--fail-on`` value, or ``None``.

    Returns:
        The normalized ``(min_grade, fail_on)`` pair.

    Raises:
        typer.BadParameter: When either value is off its ladder (exits ``EXIT_USAGE``, so a
            typo never looks like a quality failure).
    """
    try:
        return normalize_min_grade(min_grade), normalize_fail_on(fail_on)
    except PreflightFlagError as exc:
        raise typer.BadParameter(exc.message, param_hint=exc.param_hint) from exc


def emit_import_preflight(report: Mapping[str, Any], *, json_mode: bool) -> None:
    """Print an import pre-flight report to stdout.

    Args:
        report: The parsed ``ImportPreflightReport``.
        json_mode: When true, emit the API's report verbatim (no reshaping, no filtering)
            so a CI job can consume exactly what the API returned.
    """
    if json_mode:
        emit_json(report)
        return

    for line in format_import_preflight_lines(report):
        typer.echo(line)

    lint = report.get("lint")
    rows = finding_rows(lint)
    if rows:
        typer.echo("")
        emit_list_table(rows, list(PREFLIGHT_FINDING_COLUMNS), min_width=110)
        overflow = finding_overflow(lint)
        if overflow:
            typer.echo(f"... and {overflow} more findings — use --json for the full report.")


def emit_export_preflight(report: Mapping[str, Any], *, json_mode: bool) -> None:
    """Print an export pre-flight report to stdout.

    Args:
        report: The parsed ``ExportPreflightReport``.
        json_mode: When true, emit the API's report verbatim.
    """
    if json_mode:
        emit_json(report)
        return

    for line in format_export_preflight_lines(report):
        typer.echo(line)

    rows = export_target_rows(report)
    typer.echo("")
    emit_list_table(
        rows,
        list(EXPORT_PREFLIGHT_TARGET_COLUMNS),
        empty_message="No export targets were ranked for this revision.",
        min_width=140,
    )

    blocked = format_blocked_target_lines(report)
    if blocked:
        typer.echo("")
        for line in blocked:
            typer.echo(line)

    lint_rows = finding_rows(report.get("lint"))
    if lint_rows:
        typer.echo("")
        typer.echo("Source lint findings (ranked):")
        emit_list_table(lint_rows, list(PREFLIGHT_FINDING_COLUMNS), min_width=110)
        overflow = finding_overflow(report.get("lint"))
        if overflow:
            typer.echo(f"... and {overflow} more findings — use --json for the full report.")


def enforce_gate(outcome: GateOutcome) -> None:
    """Exit the process when ``outcome`` failed, after printing its reasons to stderr.

    Returns normally on a passing gate so the caller can continue.

    Raises:
        typer.Exit: With the outcome's exit code when the gate failed.
    """
    if not outcome.failed:
        return
    for reason in outcome.reasons:
        typer.echo(reason, err=True)
    raise typer.Exit(outcome.exit_code)


def gate_import_before_job(
    client: RestClient,
    tenant_slug: str,
    *,
    document_bytes: bytes,
    min_grade: str | None,
    fail_on: str | None,
    source_kind: str | None = None,
    filename: str | None = None,
    content_type: str | None = None,
    url: str | None = None,
    input_kind: str | None = None,
    import_target: str | None = None,
    archive_root: str | None = None,
    quiet: bool | None = None,
) -> None:
    """Pre-flight a candidate and stop before the import job when the verdict blocks.

    A no-op unless the caller supplied ``--min-grade`` or ``--fail-on``: without a threshold
    there is nothing extra to enforce client-side (the server still gates the commit), and
    the command should not pay for a round trip it was not asked to make.

    Args:
        client: Authenticated REST client.
        tenant_slug: The tenant URL slug.
        document_bytes: The exact bytes the import would submit, so the graded document and
            the imported document are the same document.
        min_grade: Caller's minimum acceptable grade, or ``None``.
        fail_on: Caller's severity threshold, or ``None``.
        source_kind: Explicit adapter key, when the command knows it.
        filename: Upload filename hint.
        content_type: MIME hint.
        url: Source URL, when the document came from one.
        input_kind: How the document reached the CLI.
        import_target: Destination the commit would request.
        archive_root: Root document inside an uploaded archive.
        quiet: Suppress the passing-verdict summary; ``None`` follows the root
            ``--no-progress`` flag.

    Raises:
        typer.Exit: With a gate exit code when the pre-flight verdict blocks the import.
    """
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)
    if not gating_requested(min_grade=min_grade, fail_on=fail_on):
        return

    body = build_import_preflight_body(
        document_bytes,
        source_kind=source_kind,
        filename=filename,
        content_type=content_type,
        url=url,
        input_kind=input_kind,
        import_target=import_target,
        archive_root=archive_root,
    )
    report = fetch_import_preflight(client, tenant_slug, body)
    outcome = evaluate_import_gate(report, min_grade=min_grade, fail_on=fail_on)
    if outcome.failed:
        typer.echo("Import pre-flight gate failed; no import job was created.", err=True)
        _echo_gate_context(report, scope="import")
    elif not _resolve_quiet(quiet):
        _echo_gate_context(report, scope="import")
    enforce_gate(outcome)


def gate_export_before_job(
    client: RestClient,
    tenant_slug: str,
    *,
    artifact: str,
    version: str | None,
    targets: Sequence[str] | None,
    min_grade: str | None,
    fail_on: str | None,
    quiet: bool | None = None,
) -> None:
    """Pre-flight an export and stop before the job/emit when the verdict blocks.

    A no-op unless the caller supplied ``--min-grade`` or ``--fail-on``.

    Args:
        client: Authenticated REST client.
        tenant_slug: The tenant URL slug.
        artifact: The artifact (project) id being exported.
        version: Revision UUID / version label, or ``None`` for the latest revision.
        targets: The target(s) the command is about to export to, so the ranking is
            narrowed to exactly the delivery being gated; ``None`` ranks everything.
        min_grade: Caller's minimum acceptable source grade, or ``None``.
        fail_on: Caller's severity threshold on the source lint, or ``None``.
        quiet: Suppress the passing-verdict summary; ``None`` follows the root
            ``--no-progress`` flag.

    Raises:
        typer.Exit: With a gate exit code when the pre-flight verdict blocks the export.
    """
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)
    if not gating_requested(min_grade=min_grade, fail_on=fail_on):
        return

    report = fetch_export_preflight(
        client,
        tenant_slug,
        artifact=artifact,
        version=version,
        targets=targets,
        include_findings=False,
    )
    outcome = evaluate_export_gate(report, min_grade=min_grade, fail_on=fail_on)
    if outcome.failed:
        typer.echo("Export pre-flight gate failed; nothing was emitted.", err=True)
        _echo_gate_context(report, scope="export")
    elif not _resolve_quiet(quiet):
        _echo_gate_context(report, scope="export")
    enforce_gate(outcome)


def _resolve_quiet(quiet: bool | None) -> bool:
    """Resolve the passing-verdict summary switch, defaulting to root ``--no-progress``.

    Args:
        quiet: An explicit override, or ``None`` to follow the root flag.

    Returns:
        True when the passing verdict should not be printed. Falls back to ``False`` when
        there is no active Click context (a direct library call).
    """
    if quiet is not None:
        return quiet
    ctx = click.get_current_context(silent=True)
    return no_progress_from_context(ctx) if ctx is not None else False


def _echo_gate_context(report: Mapping[str, Any], *, scope: str) -> None:
    """Print the pre-flight headline to stderr as gate diagnostics.

    Always stderr: the gate runs inside commands whose stdout is the imported result or the
    exported document, and a diagnostic must never contaminate either.
    """
    lines = (
        format_import_preflight_lines(report)
        if scope == "import"
        else format_export_preflight_lines(report) + format_blocked_target_lines(report)
    )
    for line in lines:
        typer.echo(line, err=True)
