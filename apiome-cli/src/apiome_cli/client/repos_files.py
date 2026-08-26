"""Helpers for ``apiome repos files`` list filters and output."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import typer
from rich.table import Table

from apiome_cli.terminal import make_console

_REPOSITORY_FILE_PRESETS = frozenset(
    {
        "all_importable",
        "openapi",
        "arazzo",
        "asyncapi",
        "json_schema",
        "graphql",
        "protobuf",
        "avro",
        "postman",
        "sql_ddl",
    },
)


def normalize_preset_filter(value: str | None) -> str | None:
    """Validate and return the REST ``preset`` query value."""
    if value is None:
        return None
    normalized = value.strip().lower().replace("-", "_")
    if normalized in _REPOSITORY_FILE_PRESETS:
        return normalized
    allowed = ", ".join(sorted(_REPOSITORY_FILE_PRESETS))
    msg = f"--preset must be one of: {allowed}."
    raise typer.BadParameter(msg)


def validate_file_list_filters(
    *,
    glob: str | None,
    regex: str | None,
) -> None:
    """Reject mutually exclusive glob and regex filters."""
    glob_set = glob is not None and glob.strip()
    regex_set = regex is not None and regex.strip()
    if glob_set and regex_set:
        msg = "--glob and --regex are mutually exclusive."
        raise typer.BadParameter(msg)


def build_file_list_query_params(
    *,
    glob: str | None,
    regex: str | None,
    preset: str | None,
    detected_kind: str | None,
    importable: bool | None,
) -> list[tuple[str, str]]:
    """Build REST query parameters for repository file list filters."""
    validate_file_list_filters(glob=glob, regex=regex)
    params: list[tuple[str, str]] = []

    if glob is not None and glob.strip():
        params.append(("glob", glob.strip()))
    if regex is not None and regex.strip():
        params.append(("regex", regex.strip()))

    preset_filter = normalize_preset_filter(preset)
    if preset_filter is not None:
        params.append(("preset", preset_filter))

    if detected_kind is not None and detected_kind.strip():
        params.append(("detected_kind", detected_kind.strip()))

    if importable is not None:
        params.append(("importable", "true" if importable else "false"))

    return params


def format_detected_kind(value: object) -> str:
    """Format ``detected_kind`` for human-readable tables."""
    if value is None:
        return "—"
    text = str(value).strip()
    return text if text else "—"


def format_importable_verdict(
    importable: object,
    *,
    blocked_reason: object = None,
) -> str:
    """Format the importable verdict for human-readable tables."""
    if importable is None:
        return "pending"
    if importable is True:
        return "yes"
    if importable is False:
        if isinstance(blocked_reason, str) and blocked_reason.strip():
            return f"no ({blocked_reason.strip()})"
        return "no"
    return str(importable)


def format_file_size_bytes(value: object) -> str:
    """Format ``size_bytes`` for human-readable tables."""
    if value is None:
        return ""
    try:
        size = int(value)
    except (TypeError, ValueError):
        return str(value)
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size / (1024 * 1024):.1f} MiB"


def format_importable_verdict_for_row(row: dict[str, object]) -> str:
    """Format one file row's importable verdict."""
    return format_importable_verdict(
        row.get("importable"),
        blocked_reason=row.get("import_blocked_reason"),
    )


def emit_repository_files_table(
    items: Sequence[dict[str, Any]],
    *,
    total: int,
    show_closure: bool = False,
) -> None:
    """Render repository file rows with detected kind and importable verdict."""
    if not items:
        typer.echo("No items.")
        typer.echo(f"Total: {total}")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("Path")
    table.add_column("Size")
    table.add_column("Kind")
    table.add_column("Importable")
    if show_closure:
        table.add_column("Closure")

    for item in items:
        row = [
            str(item.get("path") or ""),
            format_file_size_bytes(item.get("size_bytes")),
            format_detected_kind(item.get("detected_kind")),
            format_importable_verdict_for_row(item),
        ]
        if show_closure:
            row.append(str(item.get("closure_indicator") or "—"))
        table.add_row(*row)

    make_console().print(table)
    typer.echo(f"Showing {len(items)} of {total}")


def preset_choices() -> Sequence[str]:
    """Return sorted preset values for help text and tests."""
    return tuple(sorted(_REPOSITORY_FILE_PRESETS))
