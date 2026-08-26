"""Helpers for ``apiome repos imports`` list filters and output."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

import typer
from rich.table import Table

from apiome_cli.terminal import make_console


def build_import_list_query_params(
    *,
    project_id: UUID | None,
    version_id: UUID | None,
    actor_id: UUID | None,
    since: str | None,
    until: str | None,
) -> list[tuple[str, str]]:
    """Build REST query parameters for repository import provenance filters."""
    params: list[tuple[str, str]] = []

    if project_id is not None:
        params.append(("project_id", str(project_id)))
    if version_id is not None:
        params.append(("version_id", str(version_id)))
    if actor_id is not None:
        params.append(("actor_id", str(actor_id)))

    since_value = _normalize_timestamp_filter(since, flag_name="--since")
    if since_value is not None:
        params.append(("since", since_value))

    until_value = _normalize_timestamp_filter(until, flag_name="--until")
    if until_value is not None:
        params.append(("until", until_value))

    if since_value is not None and until_value is not None and since_value > until_value:
        msg = "--since must be on or before --until."
        raise typer.BadParameter(msg)

    return params


def _normalize_timestamp_filter(value: str | None, *, flag_name: str) -> str | None:
    """Validate and return an ISO-8601 timestamp for REST ``since``/``until`` filters."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        msg = f"{flag_name} must be an ISO-8601 timestamp (for example 2026-06-07T12:00:00Z)."
        raise typer.BadParameter(msg) from exc
    return text


def format_blob_sha(value: object) -> str:
    """Truncate a Git blob SHA for compact table display."""
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    return text[:7]


def format_imported_at(value: object) -> str:
    """Format ``imported_at`` for human-readable tables."""
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return text
    return parsed.strftime("%Y-%m-%d %H:%M UTC")


def format_imported_by(value: object) -> str:
    """Format ``imported_by_user_id`` for human-readable tables."""
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if len(text) > 12:
        return f"{text[:8]}…"
    return text


def emit_repository_imports_table(
    items: Sequence[dict[str, Any]],
    *,
    total: int,
) -> None:
    """Render repository import provenance rows."""
    if not items:
        typer.echo("No items.")
        typer.echo(f"Total: {total}")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("File")
    table.add_column("Project")
    table.add_column("Version")
    table.add_column("Imported by")
    table.add_column("Imported at")
    table.add_column("Blob SHA")

    for item in items:
        table.add_row(
            str(item.get("file_path") or ""),
            str(item.get("project_name") or ""),
            str(item.get("version_name") or ""),
            format_imported_by(item.get("imported_by_user_id")),
            format_imported_at(item.get("imported_at")),
            format_blob_sha(item.get("blob_sha")),
        )

    make_console().print(table)
    typer.echo(f"Showing {len(items)} of {total}")
