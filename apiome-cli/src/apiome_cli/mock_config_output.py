"""Human and machine output for the mock configuration commands (#5530, MSC-1.4).

Rendering lives apart from the client so that ``pull``, ``push``, ``diff`` and ``preview`` present
the same things the same way, and so that the shapes ``--json`` emits are defined in one place. The
JSON shapes are the contract a CI job scripts against, so they are stable objects rather than
whatever a dataclass happened to serialize to.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Mapping, Sequence

import typer

from apiome_cli.mock_config import ConfigDiff, ConfigError, format_errors, serialize_document
from apiome_cli.output import emit_json

if TYPE_CHECKING:  # pragma: no cover - import only for typing; the client imports this module's peers
    from apiome_cli.client.mock_settings import PushOutcome

__all__ = [
    "emit_config_diff",
    "emit_config_document",
    "emit_config_errors",
    "emit_preview_result",
    "emit_push_outcome",
]

#: Marks each change in the human diff summary. Reads at a glance and survives a mono font.
_CHANGE_MARK = {"added": "+", "removed": "-", "modified": "~"}


def emit_config_document(document: Mapping[str, Any], *, json_mode: bool) -> None:
    """Print a configuration document to stdout.

    The text is identical either way — a configuration document *is* JSON — so ``--json`` changes
    nothing here and is accepted only so that scripts need not special-case this one command.

    Args:
        document: The document to print.
        json_mode: Whether the caller asked for machine output.
    """
    if json_mode:
        emit_json(document)
        return
    typer.echo(serialize_document(document), nl=False)


def emit_config_errors(errors: Sequence[ConfigError], *, source: str) -> None:
    """Print server validation errors against the document that caused them, on stderr.

    Args:
        errors: The located errors.
        source: What was rejected — a file path, or a description of the request.
    """
    headline, *body = format_errors(errors, source=source)
    typer.secho(headline, err=True, fg="red")
    for line in body:
        typer.echo(line, err=True)


def _diff_summary_lines(diff: ConfigDiff) -> list[str]:
    """Render the change list as one marked line per change."""
    return [f"  {_CHANGE_MARK.get(change.change, '?')} {change.path}" for change in diff.changes]


def emit_config_diff(
    diff: ConfigDiff,
    *,
    subject: str,
    json_mode: bool,
    show_unified: bool = True,
) -> None:
    """Print what a push would change.

    Args:
        diff: The comparison.
        subject: What is being compared, e.g. ``"mock-config.json against payments-api 1.0.0"``.
        json_mode: Whether the caller asked for machine output.
        show_unified: Whether to print the unified diff after the summary.
    """
    if json_mode:
        emit_json(diff.as_dict())
        return

    if not diff.changed:
        typer.echo(f"No changes: {subject}.")
        return

    count = len(diff.changes)
    typer.echo(f"{count} change{'' if count == 1 else 's'}: {subject}.")
    for line in _diff_summary_lines(diff):
        typer.echo(line)
    if show_unified and diff.unified:
        typer.echo("")
        typer.echo(diff.unified, nl=False)


def emit_push_outcome(
    outcome: "PushOutcome",
    diff: ConfigDiff,
    *,
    source: str,
    subject: str,
    json_mode: bool,
) -> None:
    """Print the result of a successful push or dry run.

    Rejections are printed by :func:`emit_config_errors` instead — this reports what *did* happen.

    Args:
        outcome: What the push validated and whether it wrote.
        diff: What the push would change (computed before it was applied).
        source: The document that was pushed.
        subject: What it was pushed to, e.g. ``"payments-api 1.0.0"``.
        json_mode: Whether the caller asked for machine output.
    """
    if json_mode:
        emit_json({**outcome.as_dict(), "diff": diff.as_dict()})
        return

    if outcome.applied:
        headline = f"Applied {source} to {subject}."
    else:
        headline = f"{source} is valid for {subject}. Nothing was written (--dry-run)."
    typer.echo(headline)

    if not diff.changed:
        typer.echo("  (no changes)")
        return
    for line in _diff_summary_lines(diff):
        typer.echo(line)


def _trace_lines(trace: Mapping[str, Any]) -> list[tuple[str, str]]:
    """Build the label/value rows describing why a previewed response looks the way it does."""
    rows: list[tuple[str, str]] = [("layer", str(trace.get("layer") or "unknown"))]
    if trace.get("detail"):
        rows.append(("detail", str(trace["detail"])))
    if trace.get("scenario"):
        scenario = str(trace["scenario"])
        if trace.get("scenarioSource"):
            scenario = f"{scenario} (from {trace['scenarioSource']})"
        if trace.get("ruleIndex") is not None:
            scenario = f"{scenario} (rule {trace['ruleIndex']})"
        rows.append(("scenario", scenario))
    if trace.get("bodySource"):
        source = str(trace["bodySource"])
        if trace.get("exampleName"):
            source = f"{source} '{trace['exampleName']}'"
        rows.append(("body source", source))
    if trace.get("correlationMode"):
        applied = ", ".join(str(item) for item in trace.get("correlationApplied") or []) or "nothing bound"
        rows.append(("correlation", f"{trace['correlationMode']} — {applied}"))
        pointers = trace.get("correlationPointers") or []
        if pointers:
            rows.append(("pointers", ", ".join(str(pointer) for pointer in pointers)))
    if trace.get("seed") is not None:
        rows.append(("seed", f"{trace['seed']} ({trace.get('seedSource') or 'default'})"))
    if trace.get("schemaValid") is not None:
        rows.append(("schema", "valid" if trace["schemaValid"] else "DOES NOT MATCH the response schema"))
    return rows


def _body_text(body: Any, encoding: str) -> str | None:
    """Render a previewed response body for display, or ``None`` when there is no body."""
    if encoding == "empty":
        return None
    if encoding == "json":
        return json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False)
    return str(body)


def emit_preview_result(
    result: Mapping[str, Any],
    *,
    method: str,
    path: str,
    json_mode: bool,
) -> None:
    """Print what the mock would serve for one synthetic request.

    The same rendering serves the hosted preview and the offline ``--bundle`` one, because the two
    return the same object — which is the point of rendering both through the portable runtime.

    Args:
        result: The preview result.
        method: The request method, for the headline.
        path: The request path, for the headline.
        json_mode: Whether the caller asked for machine output.
    """
    if json_mode:
        emit_json(dict(result))
        return

    operation = result.get("operation") or "no operation matched"
    typer.echo(
        f"{method.upper()} {path} → {result.get('status')} "
        f"{result.get('mediaType') or ''}".rstrip()
    )
    typer.echo(f"  operation    {operation}")
    for label, value in _trace_lines(result.get("trace") or {}):
        typer.echo(f"  {label:<12} {value}")

    chaos = result.get("chaos") or {}
    if chaos.get("suppressed"):
        typer.echo(
            f"  {'chaos':<12} reported, not applied: delay {chaos.get('delayMs', 0)}ms "
            f"±{chaos.get('jitterMs', 0)}ms, errors {chaos.get('errorRate', 0)}%"
        )
    if result.get("draft"):
        typer.echo(f"  {'settings':<12} unsaved draft (nothing was written)")

    headers = result.get("headers") or {}
    if headers:
        typer.echo("")
        typer.echo("Headers")
        for name in sorted(headers):
            typer.echo(f"  {name}: {headers[name]}")

    body = _body_text(result.get("body"), str(result.get("bodyEncoding") or "empty"))
    if body is not None:
        typer.echo("")
        typer.echo("Body")
        typer.echo(body)
