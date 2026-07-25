"""Emitter-registry export commands (MFX-9.4 / MFX-8.1).

``apiome export`` is the client for the multi-format emitter registry — the inverse of ``import``.
Dedicated per-format verbs (``export openapi``, ``export asyncapi``, …) write synchronously via the
browse reconstruction or ``POST /export/document``. Any other registered target — and any format
invoked as ``apiome export <format> <artifact>`` when the name is not a dedicated verb — runs
through the async export job pipeline (``POST /export/jobs`` → poll → download), writing a single
file or unpacking a zip bundle to ``--out``.

``export targets`` enumerates the registered emitters and their per-source fidelity for a version
(``GET /v1/export/{tenant}/targets``).
"""

from __future__ import annotations

import click
import typer
from typer.core import TyperGroup

from apiome_cli.cli_context import (
    insecure_from_context,
    json_mode_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client.browse_scope import (
    resolve_browse_export_scope,
    resolve_tenant_slug,
)
from apiome_cli.client.export_document import fetch_export_document
from apiome_cli.client.export_registry import (
    fetch_export_preview,
    fetch_export_targets,
    fetch_projection_evidence,
    preview_fidelity,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.project_version_resolve import resolve_project_uuid
from apiome_cli.client.spec_download import SpecSerialization, fetch_browse_spec
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_USAGE
from apiome_cli.export_dispatch import parse_export_options, run_generic_export
from apiome_cli.export_output import (
    EXPORT_EVIDENCE_COLUMNS,
    EXPORT_TARGET_COLUMNS,
    enforce_export_fidelity_gate,
    evidence_rows,
    format_export_fidelity_summary,
    format_projection_snapshot_lines,
    target_rows,
)
from apiome_cli.client.preflight import fetch_export_preflight
from apiome_cli.import_.jobs import DEFAULT_POLL_INTERVAL
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import emit_json, emit_list_table
from apiome_cli.preflight import (
    FAIL_ON_HELP,
    GATE_EXIT_CODE_HELP,
    MIN_GRADE_HELP,
    evaluate_export_gate,
)
from apiome_cli.preflight_runner import (
    coerce_gate_flags,
    emit_export_preflight,
    enforce_gate,
    gate_export_before_job,
)
from apiome_cli.spec_output import (
    SpecExportMetadata,
    build_spec_export_metadata,
    emit_download_metadata,
    write_document_bytes,
)

# The registry key + format for the reference OpenAPI 3.1 emitter (apiome-rest OpenApiEmitter).
_OPENAPI_TARGET = "openapi"

# The registry key for the AsyncAPI 3.1 emitter (apiome-rest AsyncApiEmitter, MFX-11.5).
_ASYNCAPI_TARGET = "asyncapi"

# The registry key for the proto3 emitter (apiome-rest ProtoEmitter, MFX-12.5). The CLI verb is
# ``grpc`` — the user-facing name — while the REST target is the emitter's stable ``protobuf`` key.
_PROTOBUF_TARGET = "protobuf"

# The registry key for the GraphQL SDL emitter (apiome-rest GraphQlEmitter, MFX-13.5).
_GRAPHQL_TARGET = "graphql"

# The registry key for the Apache Avro emitter (apiome-rest AvroEmitter, MFX-19.5).
_AVRO_TARGET = "avro"

_JSON_STDOUT_NOTE = (
    "With --output -, document bytes are written to stdout; the fidelity summary and --json "
    "metadata are written to stderr so stdout stays byte-safe for pipelines."
)

_EXPORT_TIMEOUT_HELP = (
    "Seconds to wait for the export job to finish (default: import timeout, usually 120)."
)


def _build_generic_export_command(target_format: str) -> click.Command:
    """Build a Click command that exports ``target_format`` via the async job seam (MFX-8.1)."""

    @click.command(
        name=target_format,
        context_settings={"help_option_names": ["-h", "--help"]},
        help=(
            f"Export an artifact to {target_format!r} via the async export job pipeline. "
            "Resolves the target from the emitter registry, polls the job, and writes the "
            "artifact to --out (file, directory, or .zip)."
        ),
    )
    @click.argument("artifact", metavar="ARTIFACT")
    @click.option("--version", default=None, help="Version UUID, slug, or label (default: latest).")
    @click.option(
        "--out",
        "out",
        default=None,
        metavar="PATH",
        help="Destination file, directory (for bundles), '-' for stdout, or .zip path.",
    )
    @click.option(
        "--option",
        "option_values",
        multiple=True,
        metavar="KEY=VALUE",
        help="Per-target emit option (repeatable; value parsed as JSON when valid).",
    )
    @click.option(
        "--force",
        is_flag=True,
        default=False,
        help="Exit 0 even when the export loses fidelity (lossy/types-only).",
    )
    @click.option(
        "--confirm",
        is_flag=True,
        default=False,
        help="Proceed with a severe conversion the transcoding guard would otherwise block.",
    )
    @click.option(
        "--export-timeout",
        "export_timeout",
        type=click.FloatRange(min=1.0),
        default=None,
        help=_EXPORT_TIMEOUT_HELP,
    )
    @click.option(
        "--poll-interval",
        "poll_interval",
        type=click.FloatRange(min=0.1),
        default=DEFAULT_POLL_INTERVAL,
        help="Seconds between export job-status polls.",
    )
    @click.option("--min-grade", "min_grade", default=None, help=MIN_GRADE_HELP)
    @click.option("--fail-on", "fail_on", default=None, help=FAIL_ON_HELP)
    def _generic(
        artifact: str,
        version: str | None,
        out: str | None,
        option_values: tuple[str, ...],
        force: bool,
        confirm: bool,
        export_timeout: float | None,
        poll_interval: float,
        min_grade: str | None,
        fail_on: str | None,
    ) -> None:
        run_generic_export(
            click.get_current_context(),
            target_format=target_format,
            artifact=artifact,
            version=version,
            out=out,
            option_values=option_values,
            force=force,
            confirm=confirm,
            poll_interval=poll_interval,
            export_timeout_override=export_timeout,
            min_grade=min_grade,
            fail_on=fail_on,
        )

    return _generic


class DispatchExportGroup(TyperGroup):
    """Typer group that dispatches unknown ``<format>`` names to the job export seam (MFX-8.1)."""

    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
        existing = super().get_command(ctx, name)
        if existing is not None:
            return existing
        return _build_generic_export_command(name)


app = typer.Typer(
    name="export",
    cls=DispatchExportGroup,
    help=(
        "Export a version to a target format via the emitter registry. "
        "Registered targets are also invokable as ``export <format> <artifact>`` (async job + poll). "
        "``export evidence --json`` returns the machine-readable projection evidence (snapshot hash, "
        "status/reason counts, per-construct rows). A lossy/types-only export exits non-zero without "
        "--force, and a job whose acknowledged preview snapshot no longer matches fails with "
        "STALE_PREVIEW — re-preview and acknowledge the current snapshot."
    ),
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)


@app.callback(invoke_without_command=True)
def export_group(ctx: typer.Context) -> None:
    """Emitter-registry export commands."""
    group_callback_without_subcommand(ctx)


def _export_client(ctx: typer.Context) -> RestClient:
    """Authenticated REST client for the tenant-scoped export surface."""
    settings = settings_from_context(ctx)
    return RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )


def _parse_serialization(*, yaml_flag: bool, accept: str | None) -> SpecSerialization:
    """Resolve the wire serialization from ``--yaml`` / ``--accept`` (mirrors ``spec export``)."""
    if yaml_flag and accept is not None:
        typer.echo("Use only one of --yaml or --accept for serialization.", err=True)
        raise typer.Exit(EXIT_USAGE)
    if yaml_flag:
        return "yaml"
    if accept is None:
        return "json"
    normalized = accept.strip().lower()
    if normalized in ("json", "application/json"):
        return "json"
    if normalized in ("yaml", "yml", "application/yaml", "text/yaml"):
        return "yaml"
    typer.echo("--accept must be json or yaml.", err=True)
    raise typer.Exit(EXIT_USAGE)


@app.command("openapi", help=f"Export a version as OpenAPI + a fidelity report. {_JSON_STDOUT_NOTE}")
def export_openapi(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str = typer.Option(..., "--version", help="Version UUID, slug, or label."),
    output: str = typer.Option(
        ...,
        "--output",
        "-o",
        help="Destination file path, or - for stdout (document bytes only).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    yaml_serialization: bool = typer.Option(
        False,
        "--yaml",
        help="Request YAML serialization (default JSON). Alias for --accept yaml.",
    ),
    accept: str | None = typer.Option(
        None,
        "--accept",
        help="Response serialization: json or yaml (default json).",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Write and exit 0 even when the export loses fidelity (lossy/types-only).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Export a version as OpenAPI and surface the emitter registry's fidelity report."""
    output = output.strip()
    if not output:
        typer.echo("--output cannot be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    serialization = _parse_serialization(yaml_flag=yaml_serialization, accept=accept)
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    # The artifact (project) id the fidelity preview keys on; also drives browse-scope resolution.
    project_id = resolve_project_uuid(client, tenant_slug, project)

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[_OPENAPI_TARGET],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    scope = resolve_browse_export_scope(
        client,
        settings,
        project_ref=str(project_id),
        version_ref=version,
        tenant_override=tenant,
    )

    download = fetch_browse_spec(
        client,
        scope,
        spec_format="openapi",
        serialization=serialization,
    )
    write_document_bytes(download.body, output)

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_OPENAPI_TARGET,
    )
    fidelity = preview_fidelity(preview)

    json_mode = json_mode_from_context(ctx)
    metadata = build_spec_export_metadata(
        download=download,
        scope_source_openapi_version=None,
        scope_fidelity_target=_OPENAPI_TARGET,
        fidelity=_fidelity_metadata(fidelity),
        output=output,
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    # Human fidelity summary is a diagnostic → stderr (keeps stdout byte-safe under --output -).
    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=_OPENAPI_TARGET):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(fidelity, force=force)


@app.command(
    "asyncapi",
    help=f"Export a version as AsyncAPI 3 + a fidelity report. {_JSON_STDOUT_NOTE}",
)
def export_asyncapi(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str = typer.Option(..., "--version", help="Version UUID, slug, or label."),
    output: str = typer.Option(
        ...,
        "--output",
        "-o",
        help="Destination file path, or - for stdout (document bytes only).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    yaml_serialization: bool = typer.Option(
        False,
        "--yaml",
        help="Request YAML serialization (default JSON). Alias for --accept yaml.",
    ),
    accept: str | None = typer.Option(
        None,
        "--accept",
        help="Response serialization: json or yaml (default json).",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Write and exit 0 even when the export loses fidelity (lossy/types-only).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Export a version as AsyncAPI 3 and surface the emitter registry's fidelity report.

    Unlike ``export openapi`` — whose bytes come from the OpenAPI browse reconstruction — AsyncAPI
    is produced through the Emitter SPI (``POST /export/{tenant}/document``); the honest fidelity
    report still comes from the dry-run preview (``POST /export/{tenant}/preview``). A REST/RPC
    source reframes onto channels and therefore exports *lossy* — a non-zero exit unless ``--force``
    — while a native event source round-trips lossless.
    """
    output = output.strip()
    if not output:
        typer.echo("--output cannot be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    serialization = _parse_serialization(yaml_flag=yaml_serialization, accept=accept)
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    # The artifact (project) id both the emit and the fidelity preview key on.
    project_id = resolve_project_uuid(client, tenant_slug, project)

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[_ASYNCAPI_TARGET],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    document = fetch_export_document(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_ASYNCAPI_TARGET,
        serialization=serialization,
    )
    write_document_bytes(document.body, output)

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_ASYNCAPI_TARGET,
    )
    fidelity = preview_fidelity(preview)

    json_mode = json_mode_from_context(ctx)
    metadata = SpecExportMetadata(
        output=output,
        bytes_written=len(document.body),
        content_type=document.content_type,
        format=_ASYNCAPI_TARGET,
        serialization=serialization,
        filename=document.filename,
        fidelity_target=_ASYNCAPI_TARGET,
        fidelity=_fidelity_metadata(fidelity),
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    # Human fidelity summary is a diagnostic → stderr (keeps stdout byte-safe under --output -).
    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=_ASYNCAPI_TARGET):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(fidelity, force=force)


@app.command(
    "grpc",
    help=(
        "Export a version as proto3 (.proto) + a fidelity report. "
        "With --output -, document bytes go to stdout; fidelity summary and --json metadata go to stderr."
    ),
)
def export_grpc(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str = typer.Option(..., "--version", help="Version UUID, slug, or label."),
    output: str = typer.Option(
        ...,
        "--output",
        "-o",
        help="Destination file path, or - for stdout (document bytes only).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Write and exit 0 even when the export loses fidelity (lossy/types-only).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Export a version as proto3 and surface the emitter registry's fidelity report.

    The ``.proto`` bytes come from the Emitter SPI (``POST /v1/export/{tenant}/document``, target
    ``protobuf``); the honest fidelity report comes from the dry-run preview
    (``POST /v1/export/{tenant}/preview``). A native gRPC/protobuf source round-trips **lossless**
    (exit 0); a REST/OpenAPI source loses unions, constraints, and HTTP semantics (non-zero exit
    unless ``--force``).
    """
    output = output.strip()
    if not output:
        typer.echo("--output cannot be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    project_id = resolve_project_uuid(client, tenant_slug, project)

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[_PROTOBUF_TARGET],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    document = fetch_export_document(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_PROTOBUF_TARGET,
        serialization=None,
    )
    write_document_bytes(document.body, output)

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_PROTOBUF_TARGET,
    )
    fidelity = preview_fidelity(preview)

    json_mode = json_mode_from_context(ctx)
    metadata = SpecExportMetadata(
        output=output,
        bytes_written=len(document.body),
        content_type=document.content_type,
        format="grpc",
        fidelity_target=_PROTOBUF_TARGET,
        fidelity=_fidelity_metadata(fidelity),
        filename=document.filename,
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=_PROTOBUF_TARGET):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(fidelity, force=force)


@app.command(
    "graphql",
    help=(
        "Export a version as GraphQL SDL + a fidelity report. "
        "With --output -, document bytes go to stdout; fidelity summary and --json metadata go to stderr."
    ),
)
def export_graphql(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str = typer.Option(..., "--version", help="Version UUID, slug, or label."),
    output: str = typer.Option(
        ...,
        "--output",
        "-o",
        help="Destination file path, or - for stdout (document bytes only).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Write and exit 0 even when the export loses fidelity (lossy/types-only).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Export a version as GraphQL SDL and surface the emitter registry's fidelity report.

    The SDL bytes come from the Emitter SPI (``POST /v1/export/{tenant}/document``, target
    ``graphql``); the honest fidelity report comes from the dry-run preview
    (``POST /v1/export/{tenant}/preview``). A native GraphQL source round-trips **lossless**
    (exit 0); a REST/OpenAPI source loses HTTP semantics and validation constraints (non-zero
    exit unless ``--force``).
    """
    output = output.strip()
    if not output:
        typer.echo("--output cannot be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    project_id = resolve_project_uuid(client, tenant_slug, project)

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[_GRAPHQL_TARGET],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    document = fetch_export_document(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_GRAPHQL_TARGET,
        serialization=None,
    )
    write_document_bytes(document.body, output)

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_GRAPHQL_TARGET,
    )
    fidelity = preview_fidelity(preview)

    json_mode = json_mode_from_context(ctx)
    metadata = SpecExportMetadata(
        output=output,
        bytes_written=len(document.body),
        content_type=document.content_type,
        format="graphql",
        fidelity_target=_GRAPHQL_TARGET,
        fidelity=_fidelity_metadata(fidelity),
        filename=document.filename,
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=_GRAPHQL_TARGET):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(fidelity, force=force)


@app.command(
    "avro",
    help=(
        "Export a version as Avro .avsc + a fidelity report. "
        "With --output -, document bytes go to stdout; fidelity summary and --json metadata go to stderr."
    ),
)
def export_avro(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str = typer.Option(..., "--version", help="Version UUID, slug, or label."),
    output: str = typer.Option(
        ...,
        "--output",
        "-o",
        help="Destination file path, or - for stdout (document bytes only).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Write and exit 0 even when the export loses fidelity (lossy/types-only).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Export a version as Avro .avsc and surface the emitter registry's fidelity report.

    The ``.avsc`` bytes come from the Emitter SPI (``POST /v1/export/{tenant}/document``, target
    ``avro``); the honest fidelity report comes from the dry-run preview
    (``POST /v1/export/{tenant}/preview``). A native Avro/data-schema source round-trips
    **lossless** (exit 0); a REST/OpenAPI source exports **types-only** — operations and channels
    are omitted and validation constraints may be dropped (non-zero exit unless ``--force``).
    """
    output = output.strip()
    if not output:
        typer.echo("--output cannot be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    project_id = resolve_project_uuid(client, tenant_slug, project)

    gate_export_before_job(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=[_AVRO_TARGET],
        min_grade=min_grade,
        fail_on=fail_on,
    )

    document = fetch_export_document(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_AVRO_TARGET,
        serialization=None,
    )
    write_document_bytes(document.body, output)

    preview = fetch_export_preview(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=_AVRO_TARGET,
    )
    fidelity = preview_fidelity(preview)

    json_mode = json_mode_from_context(ctx)
    metadata = SpecExportMetadata(
        output=output,
        bytes_written=len(document.body),
        content_type=document.content_type,
        format="avro",
        fidelity_target=_AVRO_TARGET,
        fidelity=_fidelity_metadata(fidelity),
        filename=document.filename,
    )
    emit_download_metadata(metadata, json_mode=json_mode)

    if not json_mode:
        for line in format_export_fidelity_summary(fidelity, target=_AVRO_TARGET):
            typer.echo(line, err=True)

    enforce_export_fidelity_gate(fidelity, force=force)


def _fidelity_metadata(fidelity: dict[str, object] | None) -> dict[str, object] | None:
    """Fold the fidelity envelope's coarse badge into the export metadata payload.

    Keeps the ``fidelity`` metadata field compact (``status`` + preserved-% + per-kind counts) so
    ``--json`` metadata carries the tier without embedding the whole per-construct report.
    """
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


@app.command("targets", help="List the emitter registry targets + fidelity for a version.")
def export_targets(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Version UUID, slug, or label (default: latest revision).",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
) -> None:
    """List the registered emitters and their per-source fidelity for a version."""
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    project_id = resolve_project_uuid(client, tenant_slug, project)
    response = fetch_export_targets(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
    )

    if json_mode_from_context(ctx):
        emit_json(response)
        return

    targets = response.get("targets")
    rows = target_rows(targets) if isinstance(targets, list) else []
    emit_list_table(
        rows,
        list(EXPORT_TARGET_COLUMNS),
        empty_message="No export targets available for this version.",
        min_width=100,
    )



@app.command(
    "preflight",
    help=(
        "Rank every export target for one revision — source lint, projected fidelity, "
        "capability fit, and the tenant quality-policy verdict. Nothing is emitted and no "
        f"export job is created. {GATE_EXIT_CODE_HELP}"
    ),
)
def export_preflight(
    ctx: typer.Context,
    project: str = typer.Option(
        ...,
        "--project",
        help="Project (artifact) UUID or slug to rank targets for.",
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Revision UUID, slug, or version label (default: latest revision).",
    ),
    to: list[str] = typer.Option(
        [],
        "--to",
        help=(
            "Restrict the ranking to this target key (`openapi`) or format key "
            "(`openapi-3.1`). Repeatable; omit to rank every registered target."
        ),
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Pre-flight an export (``POST …/export/preflight``).

    Lints the *source* revision under the tenant's resolved style guide and ranks every
    export target by readiness — best first, with blocked and unavailable targets ranked
    last and never hidden. ``--json`` (global flag) emits the API's report verbatim; without
    it the report is a readable summary plus the ranked-target table.

    The export is treated as refused only when **no** ranked target is selectable, so
    narrowing with ``--to openapi`` turns the command into a gate on exactly that delivery
    while an unfiltered run still passes as long as somewhere remains to export to.
    """
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    project_id = resolve_project_uuid(client, tenant_slug, project)
    report = fetch_export_preflight(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        targets=list(to) or None,
    )

    emit_export_preflight(report, json_mode=json_mode_from_context(ctx))
    enforce_gate(evaluate_export_gate(report, min_grade=min_grade, fail_on=fail_on))


@app.command(
    "evidence",
    help="Page through source→target projection evidence for one configured export.",
)
def export_evidence(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project UUID or slug."),
    target: str = typer.Option(
        ...,
        "--target",
        help="Target emitter key (e.g. `openapi`) or format key (e.g. `openapi-3.1`).",
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Version UUID, slug, or label (default: latest revision).",
    ),
    option: list[str] = typer.Option(
        [],
        "--option",
        help="Per-target emit option as key=value (repeatable). Folded into the snapshot "
        "hash — different options are a different snapshot.",
    ),
    cursor: str | None = typer.Option(
        None,
        "--cursor",
        help="Opaque cursor from a previous page (default: first page).",
    ),
    limit: int | None = typer.Option(
        None,
        "--limit",
        min=1,
        help="Maximum evidence rows per page (server clamps to its hard cap).",
    ),
    redact_source: bool = typer.Option(
        False,
        "--redact-source",
        help="Deprecated no-op (EFP-3.2): REST always redacts source-native evidence.",
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help="Tenant UUID or slug (overrides APIOME_TENANT_ID).",
    ),
) -> None:
    """Fetch one bounded page of projection evidence for a configured export (EFP-2.1).

    The machine-readable twin of the preview's projection summary: each row is one
    source construct's outcome (status + reason + reviewed explanation) in the chosen
    destination, for exactly the snapshot hash a preview/verify of the same source,
    target, and options references. ``--json`` emits the raw response (summary + page
    with ``next_cursor``); the human view prints the snapshot line and an evidence table.
    """
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = _export_client(ctx)
    tenant_slug = resolve_tenant_slug(settings, client, tenant_override=tenant)

    options = parse_export_options(option) if option else None
    project_id = resolve_project_uuid(client, tenant_slug, project)
    response = fetch_projection_evidence(
        client,
        tenant_slug,
        artifact=str(project_id),
        version=version,
        target=target,
        options=options,
        cursor=cursor,
        limit=limit,
        redact_source=redact_source,
    )

    if json_mode_from_context(ctx):
        emit_json(response)
        return

    summary = response.get("summary")
    for line in format_projection_snapshot_lines({"projection": summary}):
        typer.echo(line)
    page = response.get("page")
    emit_list_table(
        evidence_rows(page),
        list(EXPORT_EVIDENCE_COLUMNS),
        empty_message="No projection evidence rows for this export.",
        min_width=100,
    )
    if isinstance(page, dict) and page.get("next_cursor"):
        typer.echo(f"More rows available — continue with --cursor {page['next_cursor']}")
