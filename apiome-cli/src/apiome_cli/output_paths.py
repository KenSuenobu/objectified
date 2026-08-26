"""Human-readable formatters for path, operation, and workflow CLI commands."""

from __future__ import annotations

from typing import Any

import typer
from rich.table import Table

from apiome_cli.output import ListColumn, emit_json, emit_list_table, emit_record_table
from apiome_cli.terminal import make_console


def _schema_kind(row: dict[str, Any]) -> str:
    """Return ``$ref``, ``inline``, or empty for a parameter/content row."""
    if row.get("class_id"):
        return "$ref"
    if row.get("inline_schema") is not None:
        return "inline"
    return ""


def _format_tags(tags: object) -> str:
    if isinstance(tags, list):
        return ", ".join(str(tag) for tag in tags)
    return ""


def _media_types_from_contents(contents: object) -> str:
    if not isinstance(contents, list):
        return ""
    media_types = [
        str(item.get("media_type"))
        for item in contents
        if isinstance(item, dict) and item.get("media_type")
    ]
    return ", ".join(media_types)


def emit_paths_inventory_table(
    rows: list[dict[str, Any]],
    *,
    total: int | None = None,
) -> None:
    """Render flattened path/operation inventory rows."""
    columns: tuple[ListColumn, ...] = (
        ("Path", "pathname", None),
        ("Method", "method", None),
        ("Operation ID", "operationId", None),
        ("Tags", "tags", _format_tags),
        ("Summary", "summary", None),
    )
    emit_list_table(rows, columns, total=total, empty_message="No paths or operations.")


def emit_path_show(
    path_record: dict[str, Any],
    operations: list[dict[str, Any]],
) -> None:
    """Render one path template and its operations."""
    typer.echo(f"Path: {path_record.get('pathname', '')}")
    typer.echo(f"  ID: {path_record.get('id', '')}")
    if not operations:
        typer.echo("  Operations: (none)")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("Method")
    table.add_column("Operation ID")
    table.add_column("Tags")
    table.add_column("Summary")
    table.add_column("Deprecated")

    for operation_row in operations:
        description = operation_row.get("description")
        op_id = ""
        tags = ""
        summary = ""
        if isinstance(description, dict):
            if isinstance(description.get("operation_id"), str):
                op_id = description["operation_id"]
            tags = _format_tags(description.get("tags"))
            if isinstance(description.get("summary"), str):
                summary = description["summary"]
        deprecated = operation_row.get("deprecated")
        table.add_row(
            str(operation_row.get("operation", "")),
            op_id,
            tags,
            summary,
            "" if deprecated is None else str(deprecated),
        )

    make_console().print(table)


def emit_operation_show(
    path_record: dict[str, Any],
    operation_record: dict[str, Any],
    *,
    parameters: list[dict[str, Any]],
    request_body: dict[str, Any] | None,
    responses: list[dict[str, Any]],
) -> None:
    """Render detailed operation inspection output."""
    typer.echo(f"Path: {path_record.get('pathname', '')}")
    typer.echo(f"Method: {operation_record.get('operation', '')}")
    description = operation_record.get("description")
    if isinstance(description, dict):
        if description.get("operation_id"):
            typer.echo(f"Operation ID: {description['operation_id']}")
        if description.get("summary"):
            typer.echo(f"Summary: {description['summary']}")
        if description.get("description"):
            typer.echo(f"Description: {description['description']}")
        tags = _format_tags(description.get("tags"))
        if tags:
            typer.echo(f"Tags: {tags}")

    typer.echo(f"Parameters: {len(parameters)}")
    if parameters:
        param_table = Table(show_header=True, header_style="bold")
        param_table.add_column("Name")
        param_table.add_column("In")
        param_table.add_column("Schema")
        for parameter in parameters:
            param_table.add_row(
                str(parameter.get("name", "")),
                str(parameter.get("in_location", parameter.get("in", ""))),
                _schema_kind(parameter),
            )
        make_console().print(param_table)

    if request_body is None:
        typer.echo("Request body: (none)")
    else:
        body = request_body.get("body")
        contents = request_body.get("contents")
        typer.echo("Request body:")
        if isinstance(body, dict):
            typer.echo(f"  Required: {body.get('required', False)}")
        typer.echo(f"  Media types: {_media_types_from_contents(contents)}")
        if isinstance(contents, list):
            for content in contents:
                if isinstance(content, dict):
                    typer.echo(
                        f"    {content.get('media_type', '')}: {_schema_kind(content)}",
                    )

    typer.echo(f"Responses: {len(responses)}")
    if responses:
        response_table = Table(show_header=True, header_style="bold")
        response_table.add_column("Name")
        response_table.add_column("Status")
        response_table.add_column("Media types")
        response_table.add_column("Schema kinds")
        for entry in responses:
            response_row = entry.get("response")
            contents = entry.get("contents")
            if not isinstance(response_row, dict):
                continue
            kinds = []
            if isinstance(contents, list):
                kinds = [_schema_kind(content) for content in contents if isinstance(content, dict)]
            response_table.add_row(
                str(response_row.get("name", "")),
                str(response_row.get("status_code", response_row.get("status", ""))),
                _media_types_from_contents(contents),
                ", ".join(kind for kind in kinds if kind),
            )
        make_console().print(response_table)


def emit_workflows_list_table(
    items: list[dict[str, Any]],
    *,
    total: int | None = None,
) -> None:
    """Render workflow list rows."""
    columns: tuple[ListColumn, ...] = (
        ("Workflow ID", "workflow_id", None),
        ("Summary", "summary", lambda value: "" if value is None else str(value)),
        ("Description", "description", lambda value: "" if value is None else str(value)),
        ("Row ID", "id", None),
    )
    emit_list_table(items, columns, total=total, empty_message="No workflows.")


def emit_workflow_show(
    workflow_record: dict[str, Any],
    steps: list[dict[str, Any]],
) -> None:
    """Render one workflow and its ordered steps."""
    emit_record_table(
        workflow_record,
        (
            ("Row ID", "id", None),
            ("Workflow ID", "workflow_id", None),
            ("Summary", "summary", lambda value: "" if value is None else str(value)),
            ("Description", "description", lambda value: "" if value is None else str(value)),
        ),
    )
    typer.echo("")
    if not steps:
        typer.echo("Steps: (none)")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("#")
    table.add_column("Step ID")
    table.add_column("Operation ID")
    table.add_column("Operation path")
    table.add_column("Linked operation")
    table.add_column("Unresolved")

    for step in steps:
        linked = step.get("path_operation_id")
        operation_id = step.get("operation_id")
        unresolved = (
            isinstance(operation_id, str)
            and operation_id
            and not linked
        )
        table.add_row(
            str(step.get("position", "")),
            str(step.get("step_id", "")),
            "" if operation_id is None else str(operation_id),
            "" if step.get("operation_path") is None else str(step["operation_path"]),
            "" if linked is None else str(linked),
            "yes" if unresolved else "",
        )

    make_console().print(table)


def emit_paths_list_json(payload: dict[str, Any]) -> None:
    """Emit the REST list envelope for ``paths list --json``."""
    emit_json(payload)


def emit_workflow_show_json(
    workflow_record: dict[str, Any],
    steps: list[dict[str, Any]],
) -> None:
    """Emit workflow detail and steps for ``workflows show --json``."""
    emit_json(
        {
            "workflow": workflow_record,
            "steps": {"total": len(steps), "items": steps},
        },
    )


def emit_operation_show_json(
    path_record: dict[str, Any],
    operation_record: dict[str, Any],
    *,
    parameters: list[dict[str, Any]],
    request_body: dict[str, Any] | None,
    responses: list[dict[str, Any]],
) -> None:
    """Emit enriched operation detail for ``operations show --json``."""
    emit_json(
        {
            "path": path_record,
            "operation": operation_record,
            "parameters": parameters,
            "request_body": request_body,
            "responses": responses,
        },
    )


def emit_path_show_json(
    path_record: dict[str, Any],
    operations: list[dict[str, Any]],
) -> None:
    """Emit path detail and operations for ``paths show --json``."""
    emit_json(
        {
            "path": path_record,
            "operations": {"total": len(operations), "items": operations},
        },
    )
