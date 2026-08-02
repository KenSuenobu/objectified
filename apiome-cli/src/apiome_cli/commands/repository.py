"""Repository auto-refresh commands: ``apiome repository refresh`` (RAR-5.6).

CI and power users need to trigger and inspect a repository refresh without the
dashboard. Two verbs cover that:

* ``apiome repository refresh REPO [--path PATH]`` — run the RAR-5.2 spec-faithful
  manual refresh and (by default) poll until the refreshed files settle.
* ``apiome repository refresh status REPO`` — list the per-file refresh state.

Both honour exactly the gates the UI path honours, because both are the same server
call: the freshness comparator (RAR-2.2) decides what is enqueued, and the
divergence guard (RAR-4.4) decides whether a refresh may overwrite a hand-edited
version. The CLI adds no gate of its own — it reports what the server decided.

``refresh REPO`` is dispatched by :class:`RefreshGroup`: any name that is not the
``status`` subcommand is treated as the repository reference, which is what makes
``refresh acme/api`` and ``refresh status acme/api`` coexist in one verb.
"""

from __future__ import annotations

from typing import Any

import click
import typer
from typer.core import TyperGroup

from apiome_cli.cli_context import (
    import_timeout_from_context,
    insecure_from_context,
    json_mode_from_context,
    no_progress_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.repository_refresh import (
    DEFAULT_STATUS_LIMIT,
    MAX_STATUS_LIMIT,
    fetch_refresh_history,
    fetch_status_rows,
    history_entry_ids,
    resolve_repository,
    trigger_refresh,
    wait_for_refresh,
)
from apiome_cli.client.tenant_scope import require_tenant_slug
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.import_.jobs import DEFAULT_POLL_INTERVAL
from apiome_cli.output import emit_json
from apiome_cli.repository_refresh_output import (
    LineageKey,
    emit_history_outcomes,
    emit_refresh_status,
    emit_trigger_result,
    has_failure,
    lineage_key,
    pending_lineage_keys,
    summarize_statuses,
)

_REPO_ARGUMENT_HELP = (
    "Repository UUID or name (for example ``acme/api``, matched against the "
    "repository's full name and then its display name)."
)


class RefreshGroup(TyperGroup):
    """Typer group where an unknown name is the repository to refresh.

    ``refresh status`` resolves to the declared subcommand; every other token is a
    repository reference and is routed to the trigger command, so the ticket's two
    forms — ``repository refresh REPO`` and ``repository refresh status REPO`` —
    live under one verb. A repository literally named ``status`` is still
    refreshable by passing its UUID.
    """

    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
        existing = super().get_command(ctx, name)
        if existing is not None:
            return existing
        return _build_refresh_trigger_command(name)


app = typer.Typer(
    name="repository",
    help="Repository auto-refresh: trigger a refresh and inspect per-file state.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)

refresh_app = typer.Typer(
    name="refresh",
    cls=RefreshGroup,
    help=(
        "Trigger a spec-faithful repository refresh (``refresh REPO``) or list "
        "per-file refresh state (``refresh status REPO``)."
    ),
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)
app.add_typer(refresh_app, name="refresh")


def _scoped_client(ctx: typer.Context) -> tuple[RestClient, str]:
    """Build an API-key REST client and resolve the configured tenant slug."""
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    tenant_slug = require_tenant_slug(settings, client)
    return client, tenant_slug


def _json_output(ctx: typer.Context, output_format: str | None) -> bool:
    """Resolve ``--format`` plus the global ``--json`` flag to a JSON-output boolean."""
    if output_format == "json":
        return True
    if output_format is not None and output_format != "table":
        msg = "--format must be 'table' or 'json'."
        raise typer.BadParameter(msg)
    return json_mode_from_context(ctx)


def _validate_limit(limit: int) -> int:
    """Clamp-check ``--limit`` against the catalog page bounds."""
    if limit < 1 or limit > MAX_STATUS_LIMIT:
        msg = f"--limit must be between 1 and {MAX_STATUS_LIMIT}."
        raise typer.BadParameter(msg)
    return limit


@refresh_app.command("status")
def refresh_status(
    ctx: typer.Context,
    repository: str = typer.Argument(..., metavar="REPO", help=_REPO_ARGUMENT_HELP),
    path: str | None = typer.Option(
        None,
        "--path",
        help="Restrict the listing to one repository-relative file path.",
    ),
    branch: str | None = typer.Option(
        None,
        "--branch",
        help="Restrict the listing to one branch (implies --all-branches).",
    ),
    all_branches: bool = typer.Option(
        False,
        "--all-branches",
        help="List lineages on every tracked branch, not just the default branch.",
    ),
    limit: int = typer.Option(
        DEFAULT_STATUS_LIMIT,
        "--limit",
        help=f"Maximum file lineages to read (1..{MAX_STATUS_LIMIT}).",
    ),
    output_format: str | None = typer.Option(
        None,
        "--format",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """List per-file refresh state for a repository (RAR-1.5 / RAR-2.3)."""
    json_mode = _json_output(ctx, output_format)
    page_limit = _validate_limit(limit)
    client, tenant_slug = _scoped_client(ctx)
    record = resolve_repository(client, tenant_slug, repository)

    rows, match_count = fetch_status_rows(
        client,
        tenant_slug,
        str(record["id"]),
        path=path,
        branch=branch,
        all_branches=all_branches,
        limit=page_limit,
    )
    emit_refresh_status(rows, json_mode=json_mode, repository=record)
    if not json_mode and match_count > page_limit:
        typer.echo(
            f"Showing the first {page_limit} of {match_count} catalog rows; "
            "raise --limit to see more.",
            err=True,
        )


def _build_refresh_trigger_command(repo_ref: str) -> click.Command:
    """Build the ``refresh REPO`` command for a repository reference.

    Returned on demand by :class:`RefreshGroup` for any token that is not a declared
    subcommand, so the repository reference Click already consumed as the command
    name is carried into the command body.

    Args:
        repo_ref: The repository UUID or name typed after ``refresh``.

    Returns:
        A Click command that triggers the refresh and optionally waits for it.
    """

    @click.command(
        name=repo_ref,
        context_settings={"help_option_names": ["-h", "--help"]},
        help=(
            "Trigger a spec-faithful refresh of a repository (RAR-5.2). Uses each "
            "file's stored import spec, honours the freshness gate and the "
            "divergence guard, and runs even when scheduled auto-refresh is off."
        ),
    )
    @click.option(
        "--path",
        "path",
        default=None,
        metavar="PATH",
        help="Refresh a single repository-relative file path instead of the whole repo.",
    )
    @click.option(
        "--branch",
        "branch",
        default=None,
        metavar="BRANCH",
        help="Scope the refresh to one branch (default: every branch with a stored spec).",
    )
    @click.option(
        "--wait/--no-wait",
        "wait",
        default=True,
        help="Poll until the refreshed files settle (default: wait).",
    )
    @click.option(
        "--poll-interval",
        "poll_interval",
        type=click.FloatRange(min=0.1),
        default=DEFAULT_POLL_INTERVAL,
        help="Seconds between refresh-status polls when waiting.",
    )
    @click.option(
        "--refresh-timeout",
        "refresh_timeout",
        type=click.FloatRange(min=1.0),
        default=None,
        help="Maximum seconds to wait for the refresh (default 120, or --timeout).",
    )
    @click.option(
        "--limit",
        "limit",
        type=click.IntRange(min=1, max=MAX_STATUS_LIMIT),
        default=DEFAULT_STATUS_LIMIT,
        help=f"Maximum file lineages tracked while waiting (1..{MAX_STATUS_LIMIT}).",
    )
    @click.option(
        "--format",
        "output_format",
        default=None,
        help="Output format: table (default) or json.",
    )
    def _refresh(
        path: str | None,
        branch: str | None,
        wait: bool,
        poll_interval: float,
        refresh_timeout: float | None,
        limit: int,
        output_format: str | None,
    ) -> None:
        _run_refresh(
            click.get_current_context(),
            repo_ref=repo_ref,
            path=path,
            branch=branch,
            wait=wait,
            poll_interval=poll_interval,
            refresh_timeout=refresh_timeout,
            limit=limit,
            output_format=output_format,
        )

    return _refresh


def _run_refresh(
    ctx: typer.Context,
    *,
    repo_ref: str,
    path: str | None,
    branch: str | None,
    wait: bool,
    poll_interval: float,
    refresh_timeout: float | None,
    limit: int,
    output_format: str | None,
) -> None:
    """Trigger a manual refresh and, when waiting, report how it settled.

    Args:
        ctx: Click/Typer context carrying the global flags.
        repo_ref: Repository UUID or name.
        path: Optional single file to refresh.
        branch: Optional branch scope.
        wait: Whether to poll until the refreshed lineages settle.
        poll_interval: Seconds between polls.
        refresh_timeout: Wait budget in seconds (defaults to the import timeout).
        limit: Maximum lineages tracked while waiting.
        output_format: ``table`` or ``json`` (overrides the global ``--json``).

    Raises:
        typer.Exit: ``EXIT_ERROR`` when a refreshed file ends in the failed state or
            a recorded refresh cycle failed.
    """
    json_mode = _json_output(ctx, output_format)
    client, tenant_slug = _scoped_client(ctx)
    record = resolve_repository(client, tenant_slug, repo_ref)
    repository_id = str(record["id"])

    targets: list[LineageKey] = []
    baseline_ids: set[str] = set()
    if wait:
        before, _match_count = fetch_status_rows(
            client,
            tenant_slug,
            repository_id,
            path=path,
            branch=branch,
            # A refresh spans every branch with a stored spec unless --branch scopes
            # it, so the tracked lineages must not be limited to the default branch.
            all_branches=True,
            limit=limit,
        )
        targets = pending_lineage_keys(before)
        baseline_ids = history_entry_ids(
            fetch_refresh_history(client, tenant_slug, repository_id, path=path)
        )

    payload = trigger_refresh(
        client,
        tenant_slug,
        repository_id,
        path=path,
        branch=branch,
    )

    enqueued = payload.get("enqueued") or 0
    if not wait or not enqueued or not targets:
        emit_trigger_result(payload, json_mode=json_mode)
        if wait and enqueued and not targets:
            # The server enqueued work for lineages this page did not cover (raise
            # --limit); say so rather than implying the refresh finished.
            typer.echo(
                f"{enqueued} refresh job(s) enqueued for files outside the tracked "
                "listing; not waiting. Re-run 'repository refresh status' to check them.",
                err=True,
            )
        return

    rows, cycles = wait_for_refresh(
        client,
        tenant_slug,
        repository_id,
        targets=targets,
        baseline_history_ids=baseline_ids,
        path=path,
        branch=branch,
        all_branches=True,
        limit=limit,
        poll_interval=poll_interval,
        timeout=(
            refresh_timeout
            if refresh_timeout is not None
            else import_timeout_from_context(ctx)
        ),
        no_progress=no_progress_from_context(ctx),
    )

    target_keys = set(targets)
    refreshed = [row for row in rows if lineage_key(row) in target_keys]
    _emit_refresh_outcome(
        payload,
        refreshed,
        cycles,
        json_mode=json_mode,
        record=record,
    )
    if has_failure(refreshed, cycles):
        raise typer.Exit(EXIT_ERROR)


def _emit_refresh_outcome(
    payload: dict[str, Any],
    rows: list[dict[str, Any]],
    cycles: list[dict[str, Any]],
    *,
    json_mode: bool,
    record: dict[str, Any],
) -> None:
    """Print the settled refresh: trigger counts, per-file state, and cycle outcomes."""
    if json_mode:
        emit_json(
            {
                "repository": {
                    "id": record.get("id"),
                    "full_name": record.get("full_name") or record.get("name"),
                },
                "refresh": dict(payload),
                "summary": summarize_statuses(rows),
                "items": rows,
                "cycles": cycles,
            }
        )
        return

    emit_trigger_result(payload, json_mode=False)
    emit_refresh_status(rows, json_mode=False, repository=record)
    emit_history_outcomes(cycles, json_mode=False)


@app.callback(invoke_without_command=True)
def repository_group(ctx: typer.Context) -> None:
    """Repository command group."""
    group_callback_without_subcommand(ctx)


@refresh_app.callback(invoke_without_command=True)
def refresh_group(ctx: typer.Context) -> None:
    """Refresh command group."""
    group_callback_without_subcommand(ctx)
