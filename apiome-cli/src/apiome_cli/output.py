"""Human-readable and JSON output formatters for list/get commands."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from copy import deepcopy
from typing import Any

import typer
from rich.table import Table

from apiome_cli.cli_context import json_mode_from_context
from apiome_cli.terminal import make_console

__all__ = [
    "ListColumn",
    "RecordField",
    "merge_import_warnings",
    "emit_import_job_accepted",
    "emit_import_result",
    "emit_json",
    "emit_json_schema_type_import_result",
    "emit_list_response",
    "emit_list_table",
    "emit_record_response",
    "emit_record_table",
    "join_list",
    "emit_type_detail",
    "emit_types_list_response",
    "json_mode_from_context",
]

# Column: header label, field key on each item dict, optional cell formatter.
ListColumn = tuple[str, str, Callable[[Any], str] | None]

# Field row for single-record tables: label, field key, optional formatter.
RecordField = tuple[str, str, Callable[[Any], str] | None]


def emit_json(payload: Any) -> None:
    """Write raw API JSON to stdout (compact, no transformation)."""
    typer.echo(json.dumps(payload, separators=(",", ":")))


def _import_message_dict(item: Any) -> dict[str, str] | None:
    """Normalize one REST ``ImportMessage`` or coercion warning for display."""
    if isinstance(item, dict):
        message = item.get("message")
        if not isinstance(message, str):
            return None
        normalized: dict[str, str] = {"message": message}
        code = item.get("code")
        if isinstance(code, str) and code:
            normalized["code"] = code
        path = item.get("path")
        if isinstance(path, str) and path:
            normalized["path"] = path
        return normalized
    code = getattr(item, "code", None)
    message = getattr(item, "message", None)
    path = getattr(item, "path", None)
    if not isinstance(message, str):
        return None
    normalized = {"message": message}
    if isinstance(code, str) and code:
        normalized["code"] = code
    if isinstance(path, str) and path:
        normalized["path"] = path
    return normalized


def merge_import_warnings(
    payload: dict[str, Any],
    extra_warnings: Sequence[Any],
) -> dict[str, Any]:
    """Return *payload* with *extra_warnings* appended to ``warnings``."""
    normalized = [
        message
        for item in extra_warnings
        if (message := _import_message_dict(item)) is not None
    ]
    if not normalized:
        return payload

    merged = deepcopy(payload)
    existing = merged.get("warnings")
    combined: list[dict[str, str]] = []
    if isinstance(existing, list):
        for item in existing:
            message = _import_message_dict(item)
            if message is not None:
                combined.append(message)
    for message in normalized:
        if message not in combined:
            combined.append(message)
    merged["warnings"] = combined
    return merged


def _format_import_message(item: dict[str, str]) -> str:
    """Format one import warning or error for human-readable output."""
    message = item["message"]
    code = item.get("code")
    path = item.get("path")
    prefix = f"[{code}] " if code else ""
    suffix = f" at {path}" if path else ""
    return f"{prefix}{message}{suffix}"


_CREATED_COUNT_FIELDS: tuple[tuple[str, str], ...] = (
    ("schemas", "Schemas"),
    ("properties", "Properties"),
    ("project_properties", "Project properties"),
    ("version_schemas", "Version schema links"),
    ("paths_created", "Path templates"),
    ("operations_created", "Operations"),
    ("shared_params_created", "Shared parameters"),
    ("shared_request_bodies_created", "Shared request bodies"),
    ("shared_responses_created", "Shared responses"),
    ("workflows_created", "Workflows"),
    ("steps_created", "Workflow steps"),
)


def _created_count_rows(created: object) -> list[tuple[str, str]]:
    """Return human-readable entity/count rows for non-zero import statistics."""
    if not isinstance(created, dict):
        return []
    rows: list[tuple[str, str]] = []
    for key, label in _CREATED_COUNT_FIELDS:
        value = created.get(key)
        if isinstance(value, int) and value > 0:
            rows.append((label, str(value)))
    return rows


def _emit_created_counts_table(created: object, *, heading: str) -> None:
    """Render import entity statistics as a Rich table on stdout."""
    rows = _created_count_rows(created)
    if not rows:
        return

    typer.echo("")
    typer.echo(f"  {heading}")
    table = Table(show_header=True, header_style="bold", padding=(0, 1))
    table.add_column("Entity", style="cyan", no_wrap=True)
    table.add_column("Count", justify="right", style="bold")
    for label, count in rows:
        table.add_row(label, count)

    console = make_console()
    console.print(table, justify="left")


def _format_elapsed(seconds: float) -> str:
    """Render a duration as a compact human-readable string (e.g. ``16s``, ``1m 16s``, ``1h 2m 3s``)."""
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    # Always show seconds so a sub-minute (or zero) duration still reads as e.g. "0s".
    if secs or not parts:
        parts.append(f"{secs}s")
    return " ".join(parts)


def _format_import_completed_line(*, elapsed_seconds: float | None = None) -> str:
    """Build the human-mode import success headline."""
    if elapsed_seconds is None:
        return "Import completed."
    return f"Import completed: {_format_elapsed(elapsed_seconds)}"


def emit_import_job_accepted(payload: dict[str, Any], *, json_mode: bool) -> None:
    """Print an async import accept body (``202``) when not waiting for completion."""
    if json_mode:
        emit_json(payload)
        return

    job_id = payload.get("job_id", "")
    status = payload.get("status", "")
    typer.echo("Import accepted.")
    typer.echo(f"  Job: {job_id}")
    if isinstance(status, str) and status:
        typer.echo(f"  Status: {status}")


def emit_import_result(
    payload: dict[str, Any],
    *,
    json_mode: bool,
    dry_run: bool = False,
    elapsed_seconds: float | None = None,
) -> None:
    """Print an ``ImportResult`` to stdout (human summary or raw JSON)."""
    if json_mode:
        emit_json(payload)
        return

    project = payload.get("project")
    version = payload.get("version")
    project_name = ""
    project_slug = ""
    version_label = ""
    version_slug = ""
    if isinstance(project, dict):
        if isinstance(project.get("name"), str):
            project_name = project["name"]
        if isinstance(project.get("slug"), str):
            project_slug = project["slug"]
    if isinstance(version, dict):
        if isinstance(version.get("version"), str):
            version_label = version["version"]
        if isinstance(version.get("slug"), str):
            version_slug = version["slug"]

    # The async spec-import result carries flat keys (project_slug, version_id, version_record_id)
    # rather than nested project/version objects, so fall back to them — otherwise the project slug
    # and version id render blank.
    if not project_slug and isinstance(payload.get("project_slug"), str):
        project_slug = payload["project_slug"]
    if not version_label and isinstance(payload.get("version_id"), str):
        version_label = payload["version_id"]

    project_id = payload.get("project_id", "")
    # Prefer the version's unique record id; fall back to the (possibly semantic) version id.
    version_ref = payload.get("version_record_id") or payload.get("version_id", "")

    if dry_run:
        typer.echo("Dry run completed (no changes written).")
    else:
        typer.echo(_format_import_completed_line(elapsed_seconds=elapsed_seconds))

    provenance = payload.get("provenance")
    if isinstance(provenance, dict):
        filename = provenance.get("filename")
        if isinstance(filename, str) and filename.strip():
            typer.echo(f"  Source file: {filename.strip()}")

    project_label = f"{project_name} ({project_slug})".strip() if project_slug else project_name
    version_full = (
        f"{version_label} ({version_slug})".strip()
        if version_slug and version_slug != version_label
        else version_label
    )
    typer.echo(f"  Project: {project_label} — {project_id}")
    typer.echo(f"  Version: {version_full} — {version_ref}")

    counts_heading = "Planned entities" if dry_run else "Created entities"
    _emit_created_counts_table(payload.get("created"), heading=counts_heading)

    unresolved_refs = payload.get("unresolved_operation_refs")
    if isinstance(unresolved_refs, list) and unresolved_refs:
        typer.echo(f"  Unresolved operation refs: {len(unresolved_refs)}")

    warnings = payload.get("warnings")
    if isinstance(warnings, list) and warnings:
        listed = [
            message
            for item in warnings
            if (message := _import_message_dict(item)) is not None
        ]
        if listed:
            typer.echo(f"  Warnings ({len(listed)}):")
            for message in listed:
                typer.echo(f"    {_format_import_message(message)}")
        else:
            typer.echo(f"  Warnings: {len(warnings)}")

    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        typer.echo(f"  Errors: {len(errors)}")


def emit_json_schema_type_import_result(
    payload: dict[str, Any],
    *,
    json_mode: bool,
    dry_run: bool = False,
    elapsed_seconds: float | None = None,
) -> None:
    """Print an ``ImportJsonSchemaTypeResult`` to stdout (human table or raw JSON)."""
    if json_mode:
        emit_json(payload)
        return

    if dry_run:
        typer.echo("Dry run completed (no changes written).")
    else:
        typer.echo(_format_import_completed_line(elapsed_seconds=elapsed_seconds))

    entries = payload.get("entries")
    if isinstance(entries, list) and entries:
        typer.echo(f"\nImported types ({len(entries)}):")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Name")
        table.add_column("Slug")
        table.add_column("Ref Path")
        table.add_column("Action")

        for entry in entries:
            if not isinstance(entry, dict):
                continue
            ref_path = entry.get("ref_path")
            table.add_row(
                _cell_value(entry, "name", None),
                _cell_value(entry, "slug", None),
                "" if ref_path is None else str(ref_path),
                _cell_value(entry, "action", None),
            )

        console = make_console()
        console.print(table)

    created = payload.get("created")
    updated = payload.get("updated")
    skipped = payload.get("skipped")
    if all(isinstance(value, int) for value in (created, updated, skipped)):
        typer.echo("")
        summary = Table(show_header=True, header_style="bold", padding=(0, 1))
        summary.add_column("Outcome", style="cyan")
        summary.add_column("Count", justify="right", style="bold")
        summary.add_row("Created", str(created))
        summary.add_row("Updated", str(updated))
        summary.add_row("Skipped", str(skipped))
        console = make_console()
        console.print(summary, justify="left")


def join_list(value: Any) -> str:
    """Render a list-valued cell as comma-separated text.

    The shared column formatter for the several tables whose cells are lists — input kinds,
    version coverage, file extensions, format keys. Non-list values pass through as their string
    form, and ``None`` renders as an empty cell, so a column can be pointed at a field that is
    sometimes scalar without a second formatter.

    Args:
        value: The raw cell value.

    Returns:
        The rendered cell text.
    """
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return "" if value is None else str(value)


def _cell_value(
    row: dict[str, Any],
    key: str,
    formatter: Callable[[Any], str] | None,
) -> str:
    raw = row.get(key)
    if formatter is not None:
        return formatter(raw)
    if raw is None:
        return ""
    return str(raw)


def emit_list_table(
    items: Sequence[dict[str, Any]],
    columns: Sequence[ListColumn],
    *,
    total: int | None = None,
    empty_message: str = "No items.",
    min_width: int | None = None,
) -> None:
    """Render a list of API objects as a Rich table on stdout.

    ``min_width`` widens the render target for wide tables when output is not a
    terminal (piped output / CI), so columns are not squeezed to the default
    80-column fallback. Interactive terminals always use their real width.
    """
    if not items:
        typer.echo(empty_message)
        if total is not None:
            typer.echo(f"Total: {total}")
        return

    table = Table(show_header=True, header_style="bold")
    for header, _key, _fmt in columns:
        table.add_column(header)

    for item in items:
        table.add_row(
            *(
                _cell_value(item, key, fmt)
                for _header, key, fmt in columns
            ),
        )

    console = make_console()
    if (
        min_width is not None
        and not console.is_terminal
        and console.width < min_width
    ):
        console = make_console(width=min_width)
    console.print(table)
    if total is not None:
        typer.echo(f"Showing {len(items)} of {total}")


def emit_record_table(
    record: dict[str, Any],
    fields: Sequence[RecordField],
) -> None:
    """Render one API object as a two-column field/value table."""
    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Value")

    for label, key, fmt in fields:
        table.add_row(label, _cell_value(record, key, fmt))

    console = make_console()
    console.print(table)


def emit_list_response(
    payload: dict[str, Any],
    columns: Sequence[ListColumn],
    *,
    json_mode: bool,
) -> None:
    """Format a paginated list API body (``items``, ``total``, …)."""
    if json_mode:
        emit_json(payload)
        return
    items = payload.get("items")
    if not isinstance(items, list):
        emit_json(payload)
        return
    total = payload.get("total")
    total_int = int(total) if isinstance(total, int) else None
    emit_list_table(items, columns, total=total_int)


def emit_record_response(
    payload: dict[str, Any],
    fields: Sequence[RecordField],
    *,
    json_mode: bool,
) -> None:
    """Format a single-resource GET response."""
    if json_mode:
        emit_json(payload)
        return
    emit_record_table(payload, fields)


_TYPES_NAME_WIDTH = 14
_TYPES_SLUG_WIDTH = 18
_TYPES_DESC_WIDTH = 37


def _types_page_count(total: int, limit: int) -> int:
    """Return the total number of pages for a paginated type list."""
    if total <= 0:
        return 1
    return (total + limit - 1) // limit


def _truncate_field(text: str, width: int) -> str:
    """Truncate or pad ``text`` to a fixed column width."""
    if len(text) <= width:
        return text.ljust(width)
    if width <= 3:
        return text[:width]
    return text[: width - 3] + "..."


def _format_type_created_on(value: object) -> str:
    """Format an ISO-8601 timestamp as ``YYYY-MM-DD HH:MM:SS UTC``."""
    if not isinstance(value, str) or not value:
        return ""
    normalized = value.replace("Z", "+00:00")
    try:
        from datetime import datetime

        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return value
    return parsed.strftime("%Y-%m-%d %H:%M:%S UTC")


def emit_types_list_response(
    payload: dict[str, Any],
    *,
    json_mode: bool,
    search_query: str | None = None,
) -> None:
    """Format a paginated GET ``/types`` body as a table or JSON item array."""
    items = payload.get("items")
    if not isinstance(items, list):
        emit_json(payload)
        return

    if json_mode:
        emit_json(items)
        return

    total = payload.get("total")
    page = payload.get("page")
    limit = payload.get("limit")
    total_int = int(total) if isinstance(total, int) else len(items)
    page_int = int(page) if isinstance(page, int) else 1
    limit_int = int(limit) if isinstance(limit, int) else max(len(items), 1)
    total_pages = _types_page_count(total_int, limit_int)

    if search_query:
        header = f"Search results (page {page_int} of {total_pages}, {total_int} total)"
    else:
        header = f"Platform Types (page {page_int} of {total_pages}, {total_int} total)"

    typer.echo(header)
    typer.echo("")
    typer.echo(
        f"  {'Name'.ljust(_TYPES_NAME_WIDTH)} "
        f"{'Slug'.ljust(_TYPES_SLUG_WIDTH)} "
        "Description",
    )
    typer.echo(
        f"  {'─' * _TYPES_NAME_WIDTH} "
        f"{'─' * _TYPES_SLUG_WIDTH} "
        f"{'─' * _TYPES_DESC_WIDTH}",
    )

    for item in items:
        if not isinstance(item, dict):
            continue
        name = _truncate_field(str(item.get("name", "")), _TYPES_NAME_WIDTH)
        slug = _truncate_field(str(item.get("slug", "")), _TYPES_SLUG_WIDTH)
        description = item.get("description")
        description_text = "" if description is None else str(description)
        description_cell = _truncate_field(description_text, _TYPES_DESC_WIDTH)
        typer.echo(f"  {name} {slug} {description_cell}")


def emit_type_detail(payload: dict[str, Any], *, json_mode: bool) -> None:
    """Format a GET ``/types/{id}`` or ``/types/by-slug/{slug}`` response."""
    if json_mode:
        emit_json(payload)
        return

    name = payload.get("name", "")
    slug = payload.get("slug", "")
    description = payload.get("description")
    ref_path = payload.get("ref_path")
    created_on = _format_type_created_on(payload.get("created_on"))
    body = payload.get("body")

    typer.echo(f"Name:        {name}")
    typer.echo(f"Slug:        {slug}")
    typer.echo(f"Description: {'' if description is None else description}")
    typer.echo(f"Ref Path:    {'' if ref_path is None else ref_path}")
    typer.echo(f"Created:     {created_on}")
    typer.echo("")
    typer.echo("Schema:")
    if isinstance(body, dict):
        typer.echo(json.dumps(body, indent=2))
    elif body is None:
        typer.echo("{}")
    else:
        typer.echo(json.dumps(body, indent=2))
