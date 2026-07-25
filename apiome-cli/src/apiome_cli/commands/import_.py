"""Import subcommands (OpenAPI, Arazzo, and JSON Schema uploads)."""

from __future__ import annotations

import copy
import time
from typing import Any
from uuid import UUID

import click
import typer
from typer.core import TyperGroup

from apiome_cli.cli_context import (
    DEFAULT_IMPORT_TIMEOUT,
    import_timeout_from_context,
    insecure_from_context,
    no_progress_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client import api_paths
from apiome_cli.client.errors import exit_on_api_error
from apiome_cli.client.http import RestClient
from apiome_cli.client.tenant_scope import require_tenant_slug
from apiome_cli.import_.spec_import import (
    build_spec_import_json_body,
    build_spec_import_metadata,
    document_bytes_from_spec,
    infer_source_kind,
    post_spec_import_json,
    post_spec_import_multipart,
    source_basename as spec_source_basename,
)
from apiome_cli.config import require_api_key
from apiome_cli.extract.openapi_info import extract_info_metadata
from apiome_cli.extract.slug import slugify_project_name, slugify_version
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE
from apiome_cli.import_.detect import (
    DocumentKind,
    describe_document_format,
    detect_document_kind,
    looks_like_json_schema_type,
    resolve_auto_import_command,
    unrecognized_auto_import_message,
    wrong_importer_message,
)
from apiome_cli.import_.source import (
    format_document_import_progress,
    load_document_bytes,
    load_import_document,
    source_basename,
)
from apiome_cli.import_.sources import (
    build_adapter_import_body,
    emit_adapter_import_summary,
    emit_import_sources,
    fetch_import_source_descriptors,
    find_source,
    unknown_format_message,
)
from apiome_cli.import_.json_schema import (
    JsonSchemaTarget,
)
from apiome_cli.import_.openapi import (
    OpenApiStructureError,
    load_openapi_file,
    validate_openapi_structure,
)
from apiome_cli.import_.schema_type_coercion import SchemaTypeCoercionWarning
from apiome_cli.import_.jobs import DEFAULT_POLL_INTERVAL
from apiome_cli.import_.publish import (
    PUBLISH_FLAG_HELP,
    TYPE_PUBLISH_FLAG_HELP,
    VISIBILITY_FLAG_HELP,
    resolve_publish_visibility,
    resolve_type_publish_system,
)
from apiome_cli.import_.source import is_local_file_source
from apiome_cli.import_.upload import (
    apply_info_overrides,
    import_result_has_errors,
    resolve_import_result,
)
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import (
    emit_import_job_accepted,
    emit_import_result,
    json_mode_from_context,
    merge_import_warnings,
)
from apiome_cli.preflight import (
    FAIL_ON_HELP,
    GATE_EXIT_CODE_HELP,
    MIN_GRADE_HELP,
    evaluate_import_gate,
)
from apiome_cli.client.preflight import build_import_preflight_body, fetch_import_preflight
from apiome_cli.preflight_runner import (
    coerce_gate_flags,
    emit_import_preflight,
    enforce_gate,
    gate_import_before_job,
)

_REST_IMPORT_NOT_SUPPORTED = (
    "This import command is not supported via the /v1 REST API yet."
)

# The import-source *registry* key both OpenAPI and Swagger documents pre-flight against.
# The spec-import job takes the legacy discriminators (``openapi-3`` / ``swagger-2``), which the
# registry does not know; the pre-flight resolves ``source_kind`` through the adapter registry, so
# forwarding a legacy value there would report FORMAT_UNRECOGNIZED for a perfectly good document.
_OPENAPI_REGISTRY_KEY = "openapi"

# Source-selection help shared by the registry-dispatch import (``import <format> <input>``)
# and the pre-flight command, so both describe the same INPUT/--file/--url contract.
_GENERIC_DRY_RUN_HELP = "Validate and preview the import without persisting changes."
_GENERIC_FILE_HELP = "Local document path to import (alternative to the INPUT argument)."
_GENERIC_URL_HELP = "http/https document URL to import (alternative to the INPUT argument)."

PROJECT_NAME_FIELD_HELP = (
    "Dot path or JSON Pointer for the field used as the project name "
    "(for example ``info.summary`` or ``#/info/summary``). Stored as "
    "``info.x-apiome-project-name-field`` when omitted from the document."
)


class DispatchImportGroup(TyperGroup):
    """Typer group that dispatches an unknown ``<format>`` to the registry (MFI-1.4).

    The dedicated per-format verbs (``openapi``/``arazzo``/``json-schema``…) are
    resolved first. Any other name is treated as a registry source key and routed
    to the generic adapter import (``apiome import <format> <input>``), so a
    format registered server-side is invokable with no new CLI command code. The
    requested key is validated against the live registry at run time, which yields
    an actionable "unknown format" error rather than Click's bare usage message.
    """

    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
        existing = super().get_command(ctx, name)
        if existing is not None:
            return existing
        return _build_generic_import_command(name)


app = typer.Typer(
    name="import",
    cls=DispatchImportGroup,
    help=(
        "Import OpenAPI, Swagger, Arazzo, JSON Schema, and JSON Schema type "
        "documents into Apiome. Any other registered format (see "
        "``import --list``) is importable as ``import <format> <input>``."
    ),
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)


def _coerce_publish_visibility(
    *,
    publish: str | None,
    visibility: str | None,
) -> str | None:
    """Resolve ``--publish`` / ``--visibility`` to a REST API visibility value."""
    try:
        return resolve_publish_visibility(publish=publish, visibility=visibility)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc


def _coerce_type_publish_system(
    *,
    publish: str | None,
    visibility: str | None,
) -> bool | None:
    """Resolve ``--publish`` / ``--visibility`` to a REST ``system`` flag."""
    try:
        return resolve_type_publish_system(publish=publish, visibility=visibility)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc


def _import_result_id(
    payload: dict[str, Any],
    *,
    top_key: str,
    nested_key: str,
) -> str | None:
    """Extract a UUID string from an import result payload (top-level or nested)."""
    value = payload.get(top_key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    nested = payload.get(nested_key)
    if isinstance(nested, dict):
        nested_id = nested.get("id")
        if isinstance(nested_id, str) and nested_id.strip():
            return nested_id.strip()
    return None


# Commit policy default (apiome-rest version_notes.py: max_short_message_chars).
_MAX_REVISION_NOTE_CHARS = 2000


def _first_nonempty_line(text: str) -> str:
    """Return the first non-blank line of *text*, stripped (empty string if none)."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _payload_str(payload: dict[str, Any], top_key: str, nested_key: str, nested_field: str) -> str:
    """Read a string field from the import result (top-level or nested)."""
    value = payload.get(top_key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    nested = payload.get(nested_key)
    if isinstance(nested, dict):
        nested_value = nested.get(nested_field)
        if isinstance(nested_value, str) and nested_value.strip():
            return nested_value.strip()
    return ""


def _derive_revision_note(spec: dict[str, Any]) -> str | None:
    """Best-effort revision note from a spec's ``info`` block: description, then title.

    The slug + version fallback is applied by the caller from the persisted import
    result, so this returns None when info carries neither a description nor a title.
    """
    info = spec.get("info") if isinstance(spec, dict) else None
    if not isinstance(info, dict):
        return None
    description = info.get("description")
    if isinstance(description, str):
        note = _first_nonempty_line(description)
        if note:
            return note[:_MAX_REVISION_NOTE_CHARS]
    title = info.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()[:_MAX_REVISION_NOTE_CHARS]
    return None


# Publish gates that ``--force`` (skipPublishChecks) is allowed to bypass:
# 422 documentation/build gaps (e.g. missing class descriptions) and 409 breaking changes.
_PUBLISH_GATE_STATUSES = frozenset({409, 422})

_FORCE_FLAG_HELP = (
    "With --publish, bypass publish gates (e.g. classes missing required "
    "descriptions, breaking changes) so the version still publishes."
)

_IMPORT_TIMEOUT_HELP = (
    "Max seconds to wait for an async import job to finish, and the per-request "
    f"HTTP timeout used while waiting (default {int(DEFAULT_IMPORT_TIMEOUT)}). "
    "Increase for large specs that take longer than the default to import. "
    "Overrides the global --timeout for this import."
)


def _gate_warning_text(response: Any) -> str:
    """Extract the human-readable gate message from a blocked publish response."""
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip()
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"].strip():
            return error["message"].strip()
        for key in ("detail", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict) and isinstance(value.get("message"), str) and value["message"].strip():
                return value["message"].strip()
    return response.text.strip()


def _report_publish_warnings(response: Any) -> None:
    """Print the publish gate warning(s) that ``--force`` is bypassing, to stderr."""
    warning = _gate_warning_text(response)
    typer.echo("Publish warnings (bypassed with --force):", err=True)
    typer.echo(f"  - {warning}" if warning else "  - (no detail provided)", err=True)


def _publish_imported_version(
    client: RestClient,
    tenant_slug: str,
    *,
    payload: dict[str, Any],
    visibility: str,
    no_progress: bool,
    short_message: str | None = None,
    force: bool = False,
) -> None:
    """Publish the version created by a completed import via the publish endpoint.

    The ``/v1`` spec-import surface carries no visibility field, so ``--publish``
    is realized as a follow-up ``POST .../{version_record_id}/publish`` once the
    import has produced a concrete project and version record.

    Commit policy may require a revision note (shortMessage). The import never
    collects one interactively, so when none is supplied we derive it from the
    spec description/title (``short_message``), falling back to the persisted
    ``slug + version`` — otherwise publish fails with POLICY_VIOLATION.

    Publish also enforces documentation/compatibility gates (e.g. classes missing
    required descriptions -> 422). When ``force`` is set, a blocked publish is
    retried with the gates bypassed and the success message notes the warnings.
    """
    project_id = _import_result_id(payload, top_key="project_id", nested_key="project")
    # Publish addresses the version by its record UUID (versions.id). The import result's
    # top-level ``version_id`` is the semver label (e.g. '0.0.1'); the UUID lives in
    # ``version_record_id`` (and in nested ``version.id``). Using the label here produced
    # ``.../0.0.1/publish`` and a 500 from the REST layer.
    version_record_id = _import_result_id(
        payload, top_key="version_record_id", nested_key="version"
    )
    if project_id is None or version_record_id is None:
        typer.echo(
            "Imported successfully but could not publish: the import result is "
            "missing the project or version id.",
            err=True,
        )
        raise typer.Exit(EXIT_ERROR)

    note = (short_message or "").strip()
    if not note:
        slug = _payload_str(payload, "project_slug", "project", "slug")
        semver = _payload_str(payload, "version_id", "version", "version")
        note = " ".join(part for part in (slug, semver) if part)
    body: dict[str, Any] = {"visibility": visibility}
    if note:
        body["shortMessage"] = note[:_MAX_REVISION_NOTE_CHARS]

    path = api_paths.version_publish(tenant_slug, project_id, version_record_id)
    forced_past_warnings = False
    if not force:
        # No --force: publish normally; any HTTP error (including a publish gate) exits.
        client.post(path, json=body)
    else:
        # --force: attempt normally, then bypass publish gates only if one blocks us, so
        # the "with warnings" note is shown only when a warning was actually overridden.
        response = client.post_raw(path, json=body)
        if response.is_success:
            pass
        elif response.status_code in _PUBLISH_GATE_STATUSES:
            # Report what we are overriding before bypassing the gate, so the warnings
            # behind "…with warnings." are visible rather than silently swallowed.
            _report_publish_warnings(response)
            client.post(
                path,
                json={
                    **body,
                    "skipPublishChecks": True,
                    "allowBreaking": True,
                    "forcePublishReason": "CLI --force bypass",
                },
            )
            forced_past_warnings = True
        else:
            exit_on_api_error(response)

    if not no_progress:
        label = "public" if visibility == "public" else "private"
        if forced_past_warnings:
            typer.echo(f"Published import as {label} with warnings.", err=True)
        else:
            typer.echo(f"Published imported version as {label}.", err=True)


def _format_openapi_import_target(
    spec: dict[str, Any],
    *,
    project_name: str | None,
    project_name_field: str | None,
    version: str | None,
    project_slug: str | None,
    version_slug: str | None,
) -> str:
    """Return a human-readable import target label from OpenAPI ``info`` metadata."""
    target = extract_info_metadata(
        spec,
        project_name=project_name,
        project_name_field=project_name_field,
        version=version,
    )
    resolved_project_slug = (
        slugify_project_name(project_slug) if project_slug is not None else target.project_slug
    )
    resolved_version_slug = (
        slugify_version(version_slug) if version_slug is not None else target.version_slug
    )
    return (
        f"{target.name} @ {target.version} "
        f"({resolved_project_slug}/{resolved_version_slug})"
    )


def _document_has_multi_type_defs(document: dict[str, Any]) -> bool:
    """Return True when the document is a ``$defs`` type library without a concrete top-level type."""
    return looks_like_json_schema_type(document)


def _apply_type_description_override(
    document: dict[str, Any],
    *,
    description: str | None,
) -> dict[str, Any]:
    """Return *document* with an optional top-level ``description`` override."""
    if description is None:
        return document
    updated = copy.deepcopy(document)
    updated["description"] = description
    return updated


@app.callback(invoke_without_command=True)
def import_group(
    ctx: typer.Context,
    list_sources: bool = typer.Option(
        False,
        "--list",
        help="List the registered import sources (formats) and exit.",
    ),
) -> None:
    """Import command group."""
    if list_sources:
        _list_import_sources(ctx)
        raise typer.Exit()
    group_callback_without_subcommand(ctx)


def _list_import_sources(ctx: typer.Context) -> None:
    """Print the registry of import sources (``GET /v1/import/sources``)."""
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    descriptors = fetch_import_source_descriptors(client)
    emit_import_sources(descriptors, json_mode=json_mode_from_context(ctx))


def _resolve_import_timeout(
    ctx: typer.Context,
    override: float | None,
) -> float:
    """Prefer an explicit ``--import-timeout`` over the context (``--timeout``/default)."""
    if override is not None and override > 0:
        return float(override)
    return import_timeout_from_context(ctx)


@app.command(
    "preflight",
    help=(
        "Score a candidate document before importing it — lint grade, ranked findings, and "
        "the tenant quality-policy verdict. Nothing is persisted and no import job is "
        f"created. {GATE_EXIT_CODE_HELP}"
    ),
)
def import_preflight(
    ctx: typer.Context,
    source: str | None = typer.Argument(
        None,
        metavar="INPUT",
        help="Document path, http/https URL, or '-' for stdin.",
    ),
    file_path: str | None = typer.Option(
        None,
        "--file",
        metavar="PATH",
        help=_GENERIC_FILE_HELP,
    ),
    url: str | None = typer.Option(
        None,
        "--url",
        metavar="URL",
        help=_GENERIC_URL_HELP,
    ),
    source_format: str | None = typer.Option(
        None,
        "--format",
        metavar="KEY",
        help=(
            "Registry key of the adapter to score against (``source_kind``). "
            "Omit to auto-detect; the detection verdict is reported either way."
        ),
    ),
    archive_root: str | None = typer.Option(
        None,
        "--root",
        metavar="PATH",
        help="Root document path inside a .zip/.tar.gz archive (MFI-29.1).",
    ),
    import_target: str | None = typer.Option(
        None,
        "--target",
        help=(
            "Destination a commit would request: catalog, types, or project. "
            "Consulted only for JSON Schema, exactly as on the import job."
        ),
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Pre-flight one candidate document (``POST …/import/preflight``).

    Runs the same detect → parse → normalize → fingerprint → lint pipeline a real import
    runs, with dry-run semantics, and reports the verdict. ``--json`` (global flag) emits the
    API's report verbatim so CI can consume it; without it the report is a readable summary
    plus the ranked findings table.

    A candidate that cannot be imported is not an error from the API's point of view — it is
    a successful pre-flight whose answer is "do not import this" — so the command reports the
    intake-taxonomy error code and exits ``EXIT_PREFLIGHT_UNUSABLE``.
    """
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)
    if import_target is not None and import_target.strip().lower() not in {
        "catalog",
        "types",
        "project",
    }:
        raise typer.BadParameter(
            "must be one of catalog, types, project", param_hint="--target"
        )

    settings = settings_from_context(ctx)
    require_api_key(settings)
    resolved_source = _resolve_generic_source(source, file_path, url)
    timeout = _resolve_import_timeout(ctx, None)
    verify = not insecure_from_context(ctx)

    client = RestClient(settings, timeout=timeout, verify=verify)

    try:
        raw_bytes, filename = load_document_bytes(
            resolved_source,
            timeout=timeout,
            verify=verify,
        )
    except OSError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    is_url = not is_local_file_source(resolved_source) and resolved_source != "-"
    body = build_import_preflight_body(
        raw_bytes,
        source_kind=source_format,
        filename=filename or source_basename(resolved_source) or None,
        url=resolved_source if is_url else None,
        input_kind="url" if is_url else ("paste" if resolved_source == "-" else "file"),
        import_target=import_target.strip().lower() if import_target else None,
        archive_root=archive_root,
    )

    tenant_slug = require_tenant_slug(settings, client)
    report = fetch_import_preflight(client, tenant_slug, body)

    emit_import_preflight(report, json_mode=json_mode_from_context(ctx))
    enforce_gate(evaluate_import_gate(report, min_grade=min_grade, fail_on=fail_on))


def _run_openapi_import(
    ctx: typer.Context,
    *,
    path: str,
    dry_run: bool,
    project_name: str | None,
    project_name_field: str | None,
    version: str | None,
    project_id: UUID | None,
    project_slug: str | None,
    version_slug: str | None,
    publish: str | None,
    visibility: str | None,
    force: bool,
    wait: bool,
    poll_interval: float,
    progress_label: str,
    attempted: str = "openapi",
    import_timeout_override: float | None = None,
    min_grade: str | None = None,
    fail_on: str | None = None,
) -> None:
    settings = settings_from_context(ctx)
    require_api_key(settings)

    # Resolve before uploading so invalid --publish/--visibility input fails fast.
    publish_visibility = _coerce_publish_visibility(publish=publish, visibility=visibility)
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)

    import_timeout = _resolve_import_timeout(ctx, import_timeout_override)
    no_progress = no_progress_from_context(ctx)

    try:
        spec = load_openapi_file(
            path,
            timeout=import_timeout,
            verify=not insecure_from_context(ctx),
        )
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc
    except OSError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    detected = detect_document_kind(spec)
    if detected in (DocumentKind.json_schema, DocumentKind.arazzo):
        typer.echo(
            wrong_importer_message(detected, attempted=attempted),
            err=True,
        )
        raise typer.Exit(EXIT_USAGE)

    try:
        preparation_warnings: list[SchemaTypeCoercionWarning] = []
        validate_openapi_structure(
            spec,
            source=path,
            preparation_warnings=preparation_warnings,
        )
    except OpenApiStructureError as exc:
        typer.echo(exc.message, err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    try:
        spec = apply_info_overrides(
            spec,
            project_name=project_name,
            version=version,
            project_slug=project_slug,
            version_slug=version_slug,
            project_name_field=project_name_field,
        )
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    client = RestClient(
        settings,
        timeout=import_timeout,
        verify=not insecure_from_context(ctx),
    )

    tenant_slug = require_tenant_slug(settings, client)
    use_multipart = is_local_file_source(path)
    upload_name = spec_source_basename(path) or "import.json"
    source_kind = infer_source_kind(spec, filename=upload_name)
    metadata = build_spec_import_metadata(
        spec,
        source_kind=source_kind,
        project_name=project_name,
        project_slug=project_slug,
        version=version,
        existing_project_id=str(project_id) if project_id is not None else None,
        dry_run=dry_run,
    )

    # The exact bytes the import submits, so the pre-flight grades the document that would
    # actually be imported (after --project-name/--version overrides, not before).
    file_bytes = document_bytes_from_spec(spec, filename=upload_name)
    gate_import_before_job(
        client,
        tenant_slug,
        document_bytes=file_bytes,
        min_grade=min_grade,
        fail_on=fail_on,
        source_kind=_OPENAPI_REGISTRY_KEY,
        filename=upload_name,
        content_type="application/json",
        url=path if not is_local_file_source(path) and path != "-" else None,
        input_kind="file" if is_local_file_source(path) else None,
    )

    if not no_progress:
        target_label = _format_openapi_import_target(
            spec,
            project_name=project_name,
            project_name_field=project_name_field,
            version=version,
            project_slug=project_slug,
            version_slug=version_slug,
        )
        typer.echo(
            format_document_import_progress(
                document_label=progress_label,
                source=path,
                dry_run=dry_run,
                target_label=target_label,
            ),
            err=True,
        )

    import_started_at = time.monotonic()
    if use_multipart:
        response = post_spec_import_multipart(
            client,
            tenant_slug,
            metadata=metadata,
            file_bytes=file_bytes,
            filename=upload_name,
        )
    else:
        body = build_spec_import_json_body(
            file_bytes,
            metadata,
            filename=upload_name,
            content_type="application/json",
        )
        response = post_spec_import_json(client, tenant_slug, body)
    json_mode = json_mode_from_context(ctx)
    resolution = resolve_import_result(
        response,
        client,
        tenant_slug,
        wait=wait,
        poll_interval=poll_interval,
        timeout=import_timeout,
        no_progress=no_progress,
    )
    # Measure after resolution: for async imports the POST returns a quick 202 and the
    # real work happens while resolve_import_result polls the job to completion.
    import_elapsed_seconds = time.monotonic() - import_started_at

    if resolution.kind == "completed":
        result_payload = merge_import_warnings(
            resolution.payload,
            preparation_warnings,
        )
        emit_import_result(
            result_payload,
            json_mode=json_mode,
            dry_run=dry_run,
            elapsed_seconds=import_elapsed_seconds,
        )
        if import_result_has_errors(resolution.payload):
            raise typer.Exit(EXIT_ERROR)
        if publish_visibility is not None:
            if dry_run:
                typer.echo(
                    "Skipping --publish: dry run did not persist a version.",
                    err=True,
                )
            else:
                _publish_imported_version(
                    client,
                    tenant_slug,
                    payload=resolution.payload,
                    visibility=publish_visibility,
                    no_progress=no_progress,
                    short_message=_derive_revision_note(spec),
                    force=force,
                )
        return

    if publish_visibility is not None:
        typer.echo(
            "Skipping --publish: import has not completed "
            "(remove --no-wait to publish).",
            err=True,
        )
    emit_import_job_accepted(resolution.payload, json_mode=json_mode)


@app.command("openapi")
def import_openapi(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "OpenAPI document path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
    project_name: str | None = typer.Option(
        None,
        "--project-name",
        help="Override project name derived from the configured project-name field.",
    ),
    project_name_field: str | None = typer.Option(
        None,
        "--project-name-field",
        help=PROJECT_NAME_FIELD_HELP,
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Override version string derived from ``info.version``.",
    ),
    project_id: UUID | None = typer.Option(
        None,
        "--project-id",
        help="Update an existing project instead of creating from ``info``.",
    ),
    project_slug: str | None = typer.Option(
        None,
        "--project-slug",
        help="Override project slug derived from ``info.title`` (DB slug rules).",
    ),
    version_slug: str | None = typer.Option(
        None,
        "--version-slug",
        help="Override version slug derived from ``info.version`` (DB slug rules).",
    ),
    publish: str | None = typer.Option(
        None,
        "--publish",
        help=PUBLISH_FLAG_HELP,
    ),
    visibility: str | None = typer.Option(
        None,
        "--visibility",
        help=VISIBILITY_FLAG_HELP,
    ),
    wait: bool = typer.Option(
        True,
        "--wait/--no-wait",
        help="Poll async imports until complete (default: wait).",
    ),
    poll_interval: float = typer.Option(
        DEFAULT_POLL_INTERVAL,
        "--poll-interval",
        min=0.1,
        help="Seconds between ``GET /imports/{job_id}`` polls when waiting.",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help=_FORCE_FLAG_HELP,
    ),
    import_timeout: float | None = typer.Option(
        None,
        "--import-timeout",
        min=1.0,
        help=_IMPORT_TIMEOUT_HELP,
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Import an OpenAPI document from a file, URL, or stdin."""
    _run_openapi_import(
        ctx,
        path=path,
        dry_run=dry_run,
        project_name=project_name,
        project_name_field=project_name_field,
        version=version,
        project_id=project_id,
        project_slug=project_slug,
        version_slug=version_slug,
        publish=publish,
        visibility=visibility,
        force=force,
        wait=wait,
        poll_interval=poll_interval,
        progress_label="OpenAPI",
        attempted="openapi",
        import_timeout_override=import_timeout,
        min_grade=min_grade,
        fail_on=fail_on,
    )


@app.command("swagger")
def import_swagger(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "Swagger 2.0 document path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
    project_name: str | None = typer.Option(
        None,
        "--project-name",
        help="Override project name derived from the configured project-name field.",
    ),
    project_name_field: str | None = typer.Option(
        None,
        "--project-name-field",
        help=PROJECT_NAME_FIELD_HELP,
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Override version string derived from ``info.version``.",
    ),
    project_id: UUID | None = typer.Option(
        None,
        "--project-id",
        help="Update an existing project instead of creating from ``info``.",
    ),
    project_slug: str | None = typer.Option(
        None,
        "--project-slug",
        help="Override project slug derived from ``info.title`` (DB slug rules).",
    ),
    version_slug: str | None = typer.Option(
        None,
        "--version-slug",
        help="Override version slug derived from ``info.version`` (DB slug rules).",
    ),
    publish: str | None = typer.Option(
        None,
        "--publish",
        help=PUBLISH_FLAG_HELP,
    ),
    visibility: str | None = typer.Option(
        None,
        "--visibility",
        help=VISIBILITY_FLAG_HELP,
    ),
    wait: bool = typer.Option(
        True,
        "--wait/--no-wait",
        help="Poll async imports until complete (default: wait).",
    ),
    poll_interval: float = typer.Option(
        DEFAULT_POLL_INTERVAL,
        "--poll-interval",
        min=0.1,
        help="Seconds between ``GET /imports/{job_id}`` polls when waiting.",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help=_FORCE_FLAG_HELP,
    ),
    import_timeout: float | None = typer.Option(
        None,
        "--import-timeout",
        min=1.0,
        help=_IMPORT_TIMEOUT_HELP,
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Import a Swagger 2.0 document from a file, URL, or stdin."""
    _run_openapi_import(
        ctx,
        path=path,
        dry_run=dry_run,
        project_name=project_name,
        project_name_field=project_name_field,
        version=version,
        project_id=project_id,
        project_slug=project_slug,
        version_slug=version_slug,
        publish=publish,
        visibility=visibility,
        force=force,
        wait=wait,
        poll_interval=poll_interval,
        progress_label="Swagger",
        attempted="swagger",
        import_timeout_override=import_timeout,
        min_grade=min_grade,
        fail_on=fail_on,
    )


@app.command("arazzo")
def import_arazzo(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "Arazzo document path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
    project_name: str | None = typer.Option(
        None,
        "--project-name",
        help="Override project name derived from the configured project-name field.",
    ),
    project_name_field: str | None = typer.Option(
        None,
        "--project-name-field",
        help=PROJECT_NAME_FIELD_HELP,
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Override version string derived from ``info.version``.",
    ),
    project_id: UUID | None = typer.Option(
        None,
        "--project-id",
        help="Update an existing project instead of creating from ``info``.",
    ),
    project_slug: str | None = typer.Option(
        None,
        "--project-slug",
        help="Override project slug derived from ``info.title`` (DB slug rules).",
    ),
    version_id: UUID | None = typer.Option(
        None,
        "--version-id",
        help="Attach workflows to this existing project version.",
    ),
    version_slug: str | None = typer.Option(
        None,
        "--version-slug",
        help="Override version slug derived from ``info.version`` (DB slug rules).",
    ),
    publish: str | None = typer.Option(
        None,
        "--publish",
        help=PUBLISH_FLAG_HELP,
    ),
    visibility: str | None = typer.Option(
        None,
        "--visibility",
        help=VISIBILITY_FLAG_HELP,
    ),
    wait: bool = typer.Option(
        True,
        "--wait/--no-wait",
        help="Poll async imports until complete (default: wait).",
    ),
    poll_interval: float = typer.Option(
        DEFAULT_POLL_INTERVAL,
        "--poll-interval",
        min=0.1,
        help="Seconds between ``GET /imports/{job_id}`` polls when waiting.",
    ),
) -> None:
    """Import an Arazzo 1.0 workflow document from a file, URL, or stdin."""
    _run_arazzo_import(
        ctx,
        path=path,
        dry_run=dry_run,
        project_name=project_name,
        project_name_field=project_name_field,
        version=version,
        project_id=project_id,
        project_slug=project_slug,
        version_id=version_id,
        version_slug=version_slug,
        publish=publish,
        visibility=visibility,
        wait=wait,
        poll_interval=poll_interval,
    )


def _run_arazzo_import(
    ctx: typer.Context,
    *,
    path: str,
    dry_run: bool,
    project_name: str | None,
    project_name_field: str | None,
    version: str | None,
    project_id: UUID | None,
    project_slug: str | None,
    version_id: UUID | None,
    version_slug: str | None,
    publish: str | None,
    visibility: str | None,
    wait: bool,
    poll_interval: float,
) -> None:
    del (
        ctx,
        path,
        dry_run,
        project_name,
        project_name_field,
        version,
        project_id,
        project_slug,
        version_id,
        version_slug,
        publish,
        visibility,
        wait,
        poll_interval,
    )
    typer.echo(_REST_IMPORT_NOT_SUPPORTED, err=True)
    raise typer.Exit(EXIT_USAGE)


@app.command("json-schema")
def import_json_schema(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "JSON Schema path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    as_target: JsonSchemaTarget | None = typer.Option(
        None,
        "--as",
        help=(
            "Import as ``property``, ``properties`` (all ``$defs`` entries), "
            "or ``schema`` (default: auto-detect)."
        ),
        case_sensitive=False,
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Property or schema name when not inferred from the file.",
    ),
    description: str | None = typer.Option(
        None,
        "--description",
        help="Description stored on the property or schema.",
    ),
    project_id: UUID | None = typer.Option(
        None,
        "--project-id",
        help="Link the import to this project (``project_properties`` when requested).",
    ),
    version_id: UUID | None = typer.Option(
        None,
        "--version-id",
        help="Link a schema import to this project version.",
    ),
    link_project_property: bool = typer.Option(
        False,
        "--link-project-property",
        help="Create a ``project_properties`` row when ``--project-id`` is set.",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
) -> None:
    """Import a JSON Schema 2020-12 document from a file, URL, or stdin."""
    _run_json_schema_import(
        ctx,
        path=path,
        dry_run=dry_run,
        as_target=as_target,
        name=name,
        description=description,
        project_id=project_id,
        version_id=version_id,
        link_project_property=link_project_property,
    )


def _run_json_schema_import(
    ctx: typer.Context,
    *,
    path: str,
    dry_run: bool,
    as_target: JsonSchemaTarget | None,
    name: str | None,
    description: str | None,
    project_id: UUID | None,
    version_id: UUID | None,
    link_project_property: bool,
) -> None:
    del (
        ctx,
        path,
        dry_run,
        as_target,
        name,
        description,
        project_id,
        version_id,
        link_project_property,
    )
    typer.echo(_REST_IMPORT_NOT_SUPPORTED, err=True)
    raise typer.Exit(EXIT_USAGE)


@app.command("json-schema-type")
def import_json_schema_type(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "JSON Schema type library path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Override inferred type name (single-type imports only).",
    ),
    description: str | None = typer.Option(
        None,
        "--description",
        help="Override description stored on the type (single-type imports only).",
    ),
    publish: str | None = typer.Option(
        None,
        "--publish",
        help=TYPE_PUBLISH_FLAG_HELP,
    ),
    visibility: str | None = typer.Option(
        None,
        "--visibility",
        help=VISIBILITY_FLAG_HELP,
    ),
) -> None:
    """Import system-wide JSON Schema type definitions from a file, URL, or stdin."""
    _run_json_schema_type_import(
        ctx,
        path=path,
        dry_run=dry_run,
        name=name,
        description=description,
        publish=publish,
        visibility=visibility,
    )


def _run_json_schema_type_import(
    ctx: typer.Context,
    *,
    path: str,
    dry_run: bool,
    name: str | None,
    description: str | None,
    publish: str | None = None,
    visibility: str | None = None,
) -> None:
    del ctx, path, dry_run, name, description, publish, visibility
    typer.echo(_REST_IMPORT_NOT_SUPPORTED, err=True)
    raise typer.Exit(EXIT_USAGE)


@app.command("auto")
def import_auto(
    ctx: typer.Context,
    path: str = typer.Argument(
        ...,
        help=(
            "Document path (``.json``, ``.yaml``, ``.yml``), "
            "``http``/``https`` URL, or ``-`` for stdin."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate and plan the import without persisting changes.",
    ),
    project_name: str | None = typer.Option(
        None,
        "--project-name",
        help="Override project name derived from the configured project-name field (OpenAPI/Arazzo).",
    ),
    project_name_field: str | None = typer.Option(
        None,
        "--project-name-field",
        help=f"{PROJECT_NAME_FIELD_HELP} (OpenAPI/Arazzo).",
    ),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Override version string derived from ``info.version`` (OpenAPI/Arazzo).",
    ),
    project_id: UUID | None = typer.Option(
        None,
        "--project-id",
        help="Target or link project for the import.",
    ),
    project_slug: str | None = typer.Option(
        None,
        "--project-slug",
        help="Override project slug derived from ``info.title`` (OpenAPI/Arazzo).",
    ),
    version_slug: str | None = typer.Option(
        None,
        "--version-slug",
        help="Override version slug derived from ``info.version`` (OpenAPI/Arazzo).",
    ),
    version_id: UUID | None = typer.Option(
        None,
        "--version-id",
        help="Attach Arazzo workflows or JSON Schema to this project version.",
    ),
    publish: str | None = typer.Option(
        None,
        "--publish",
        help=f"{PUBLISH_FLAG_HELP} (OpenAPI/Arazzo).",
    ),
    visibility: str | None = typer.Option(
        None,
        "--visibility",
        help=f"{VISIBILITY_FLAG_HELP} (OpenAPI/Arazzo).",
    ),
    as_target: JsonSchemaTarget | None = typer.Option(
        None,
        "--as",
        help=(
            "JSON Schema import target: ``property``, ``properties``, or ``schema`` "
            "(default: auto-detect)."
        ),
        case_sensitive=False,
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Property, schema, or type name override.",
    ),
    description: str | None = typer.Option(
        None,
        "--description",
        help="Description stored on the imported JSON Schema artifact.",
    ),
    link_project_property: bool = typer.Option(
        False,
        "--link-project-property",
        help="Create a ``project_properties`` row when ``--project-id`` is set.",
    ),
    wait: bool = typer.Option(
        True,
        "--wait/--no-wait",
        help="Poll async OpenAPI/Arazzo imports until complete (default: wait).",
    ),
    poll_interval: float = typer.Option(
        DEFAULT_POLL_INTERVAL,
        "--poll-interval",
        min=0.1,
        help="Seconds between ``GET /imports/{job_id}`` polls when waiting.",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help=f"{_FORCE_FLAG_HELP} (OpenAPI/Arazzo).",
    ),
    import_timeout: float | None = typer.Option(
        None,
        "--import-timeout",
        min=1.0,
        help=_IMPORT_TIMEOUT_HELP,
    ),
    min_grade: str | None = typer.Option(None, "--min-grade", help=MIN_GRADE_HELP),
    fail_on: str | None = typer.Option(None, "--fail-on", help=FAIL_ON_HELP),
) -> None:
    """Detect document format from headers and run the matching import."""
    import_timeout_override = import_timeout
    import_timeout = _resolve_import_timeout(ctx, import_timeout_override)
    no_progress = no_progress_from_context(ctx)

    try:
        document = load_import_document(
            path,
            timeout=import_timeout,
            verify=not insecure_from_context(ctx),
        )
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc
    except OSError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    filename = source_basename(path)
    command = resolve_auto_import_command(document, filename=filename)
    if command is None:
        typer.echo(unrecognized_auto_import_message(document), err=True)
        raise typer.Exit(EXIT_USAGE)

    if not no_progress:
        typer.echo(
            f"Detected {describe_document_format(document, filename=filename)}; "
            f"running import {command}.",
            err=True,
        )

    if command in {"openapi", "swagger"}:
        _run_openapi_import(
            ctx,
            path=path,
            dry_run=dry_run,
            project_name=project_name,
            project_name_field=project_name_field,
            version=version,
            project_id=project_id,
            project_slug=project_slug,
            version_slug=version_slug,
            publish=publish,
            visibility=visibility,
            force=force,
            wait=wait,
            poll_interval=poll_interval,
            progress_label="Swagger" if command == "swagger" else "OpenAPI",
            attempted=command,
            import_timeout_override=import_timeout_override,
            min_grade=min_grade,
            fail_on=fail_on,
        )
        return

    if command == "arazzo":
        _run_arazzo_import(
            ctx,
            path=path,
            dry_run=dry_run,
            project_name=project_name,
            project_name_field=project_name_field,
            version=version,
            project_id=project_id,
            project_slug=project_slug,
            version_id=version_id,
            version_slug=version_slug,
            publish=publish,
            visibility=visibility,
            wait=wait,
            poll_interval=poll_interval,
        )
        return

    if command == "json-schema":
        _run_json_schema_import(
            ctx,
            path=path,
            dry_run=dry_run,
            as_target=as_target,
            name=name,
            description=description,
            project_id=project_id,
            version_id=version_id,
            link_project_property=link_project_property,
        )
        return

    _run_json_schema_type_import(
        ctx,
        path=path,
        dry_run=dry_run,
        name=name,
        description=description,
        publish=publish,
        visibility=visibility,
    )


# ---------------------------------------------------------------------------
# Generic registry dispatch: ``apiome import <format> <input>`` (MFI-1.4)
# ---------------------------------------------------------------------------

def _build_generic_import_command(source_format: str) -> click.Command:
    """Build a Click command that imports ``source_format`` via the registry seam.

    Returned on demand by :class:`DispatchImportGroup` for any name that is not a
    dedicated verb, so a server-side adapter is invokable as
    ``apiome import <format> <input>`` with no bespoke command code. The shared
    flags mirror the ticket: an ``INPUT`` argument plus ``--file``/``--url`` source
    selectors, ``--dry-run``, and ``--import-timeout`` (with ``--wait``/
    ``--poll-interval`` for poll parity with the dedicated verbs).
    """

    @click.command(
        name=source_format,
        context_settings={"help_option_names": ["-h", "--help"]},
        help=(
            f"Import a {source_format!r} document via its registered adapter. "
            "Resolves the format from the import-source registry (MFI-1.4)."
        ),
    )
    @click.argument("source", required=False, metavar="INPUT")
    @click.option("--file", "file_path", default=None, metavar="PATH", help=_GENERIC_FILE_HELP)
    @click.option("--url", "url", default=None, metavar="URL", help=_GENERIC_URL_HELP)
    @click.option(
        "--root",
        "archive_root",
        default=None,
        metavar="PATH",
        help="Root document path inside a .zip/.tar.gz archive (MFI-29.1).",
    )
    @click.option("--dry-run", "dry_run", is_flag=True, default=False, help=_GENERIC_DRY_RUN_HELP)
    @click.option(
        "--import-timeout",
        "import_timeout",
        type=click.FloatRange(min=1.0),
        default=None,
        help=_IMPORT_TIMEOUT_HELP,
    )
    @click.option(
        "--wait/--no-wait",
        "wait",
        default=True,
        help="Poll async imports until complete (default: wait).",
    )
    @click.option(
        "--poll-interval",
        "poll_interval",
        type=click.FloatRange(min=0.1),
        default=DEFAULT_POLL_INTERVAL,
        help="Seconds between import job-status polls when waiting.",
    )
    @click.option("--min-grade", "min_grade", default=None, help=MIN_GRADE_HELP)
    @click.option("--fail-on", "fail_on", default=None, help=FAIL_ON_HELP)
    def _generic(
        source: str | None,
        file_path: str | None,
        url: str | None,
        archive_root: str | None,
        dry_run: bool,
        import_timeout: float | None,
        wait: bool,
        poll_interval: float,
        min_grade: str | None,
        fail_on: str | None,
    ) -> None:
        _run_generic_adapter_import(
            click.get_current_context(),
            source_format=source_format,
            source=source,
            file_path=file_path,
            url=url,
            archive_root=archive_root,
            dry_run=dry_run,
            import_timeout_override=import_timeout,
            wait=wait,
            poll_interval=poll_interval,
            min_grade=min_grade,
            fail_on=fail_on,
        )

    return _generic


def _resolve_generic_source(
    source: str | None,
    file_path: str | None,
    url: str | None,
) -> str:
    """Resolve exactly one of {INPUT, ``--file``, ``--url``} to a source string.

    Errors (usage exit) when none or more than one is supplied, so the input is
    unambiguous. The INPUT argument may itself be a path, ``-`` for stdin, or a URL.
    """
    provided = [value for value in (source, file_path, url) if value]
    if not provided:
        typer.echo(
            "Provide an input document: an INPUT argument (path, URL, or '-'), "
            "or --file PATH, or --url URL.",
            err=True,
        )
        raise typer.Exit(EXIT_USAGE)
    if len(provided) > 1:
        typer.echo(
            "Provide only one input: the INPUT argument, --file, or --url "
            "(not more than one).",
            err=True,
        )
        raise typer.Exit(EXIT_USAGE)
    return provided[0]


def _run_generic_adapter_import(
    ctx: click.Context,
    *,
    source_format: str,
    source: str | None,
    file_path: str | None,
    url: str | None,
    archive_root: str | None,
    dry_run: bool,
    import_timeout_override: float | None,
    wait: bool,
    poll_interval: float,
    min_grade: str | None = None,
    fail_on: str | None = None,
) -> None:
    """Resolve ``source_format`` against the registry and run the adapter import.

    Reuses the existing async spec-import path — submit, poll, emit — so polling and
    output stay consistent with the dedicated import verbs. The document bytes are
    sent verbatim so any format the adapter accepts survives the upload.
    """
    settings = settings_from_context(ctx)
    require_api_key(settings)
    min_grade, fail_on = coerce_gate_flags(min_grade, fail_on)
    resolved_source = _resolve_generic_source(source, file_path, url)
    import_timeout = _resolve_import_timeout(ctx, import_timeout_override)
    no_progress = no_progress_from_context(ctx)
    verify = not insecure_from_context(ctx)

    client = RestClient(settings, timeout=import_timeout, verify=verify)

    # Validate the requested format against the live registry before reading or
    # uploading, so a typo fails fast with the list of available formats.
    descriptors = fetch_import_source_descriptors(client)
    if find_source(descriptors, source_format) is None:
        typer.echo(unknown_format_message(source_format, descriptors), err=True)
        raise typer.Exit(EXIT_USAGE)

    try:
        raw_bytes, filename = load_document_bytes(
            resolved_source,
            timeout=import_timeout,
            verify=verify,
        )
    except OSError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    source_label = filename or source_basename(resolved_source)
    body = build_adapter_import_body(
        raw_bytes,
        source_format=source_format,
        source_label=source_label,
        dry_run=dry_run,
        archive_root=archive_root,
    )

    tenant_slug = require_tenant_slug(settings, client)

    is_url = not is_local_file_source(resolved_source) and resolved_source != "-"
    gate_import_before_job(
        client,
        tenant_slug,
        document_bytes=raw_bytes,
        min_grade=min_grade,
        fail_on=fail_on,
        source_kind=source_format,
        filename=source_label,
        url=resolved_source if is_url else None,
        input_kind="url" if is_url else ("paste" if resolved_source == "-" else "file"),
        archive_root=archive_root,
    )

    if not no_progress:
        typer.echo(
            format_document_import_progress(
                document_label=source_format,
                source=resolved_source,
                dry_run=dry_run,
            ),
            err=True,
        )

    import_started_at = time.monotonic()
    response = post_spec_import_json(client, tenant_slug, body)
    json_mode = json_mode_from_context(ctx)
    resolution = resolve_import_result(
        response,
        client,
        tenant_slug,
        wait=wait,
        poll_interval=poll_interval,
        timeout=import_timeout,
        no_progress=no_progress,
    )
    import_elapsed_seconds = time.monotonic() - import_started_at

    if resolution.kind == "completed":
        emit_adapter_import_summary(
            resolution.payload,
            json_mode=json_mode,
            dry_run=dry_run,
            elapsed_seconds=import_elapsed_seconds,
        )
        if import_result_has_errors(resolution.payload):
            raise typer.Exit(EXIT_ERROR)
        return

    emit_import_job_accepted(resolution.payload, json_mode=json_mode)
