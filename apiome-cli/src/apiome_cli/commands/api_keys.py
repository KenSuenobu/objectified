"""Workspace API key lifecycle commands (Tier 2 API key auth)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import typer

from apiome_cli.cli_context import (
    insecure_from_context,
    json_mode_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.pagination import DEFAULT_PAGE_LIMIT, paginate_page_list
from apiome_cli.config import require_api_key
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import (
    ListColumn,
    emit_json,
    emit_list_table,
)
from apiome_cli.terminal import confirm_action, make_console

app = typer.Typer(
    name="api-keys",
    help="List, create, inspect, rotate, revoke, and configure workspace API keys.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)

policy_app = typer.Typer(
    name="policy",
    help="Inspect and update workspace API key rotation policy.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)
app.add_typer(policy_app, name="policy")

_BROWSER_SCOPE_KEYS = frozenset({"read", "write", "admin"})
_BROWSER_ENVS = frozenset({"live", "test"})
_MCP_TRANSPORTS = frozenset({"streamable_http", "sse", "stdio"})


@app.callback(invoke_without_command=True)
def api_keys_group(ctx: typer.Context) -> None:
    """API keys command group."""
    group_callback_without_subcommand(ctx)


@policy_app.callback(invoke_without_command=True)
def policy_group(ctx: typer.Context) -> None:
    """API key policy command group."""
    group_callback_without_subcommand(ctx)


def _api_client(ctx: typer.Context) -> RestClient:
    """Build a REST client authenticated with the workspace API key."""
    settings = settings_from_context(ctx)
    require_api_key(settings)
    return RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )


def _json_output(ctx: typer.Context, output: str | None) -> bool:
    """Return True when global ``--json`` or ``--output json`` was requested."""
    if output == "json":
        return True
    if output is not None and output != "table":
        msg = "--output must be 'table' or 'json'."
        raise typer.BadParameter(msg)
    return json_mode_from_context(ctx)


def _strip_secret(payload: Any) -> Any:
    """Remove one-time ``secret`` fields from JSON output payloads."""
    if isinstance(payload, dict):
        return {
            key: _strip_secret(value)
            for key, value in payload.items()
            if key != "secret"
        }
    if isinstance(payload, list):
        return [_strip_secret(item) for item in payload]
    return payload


def _normalize_create_key_type(value: str) -> str:
    """Map CLI ``--type`` values to REST ``key_type`` body values."""
    normalized = value.strip().lower()
    if normalized == "browser":
        return "browser"
    if normalized == "mcp":
        return "mcp_server"
    msg = "--type must be 'browser' or 'mcp'."
    raise typer.BadParameter(msg)


def _parse_browser_scope(scope: str | None) -> dict[str, bool]:
    """Parse ``--scope`` into REST ``scope_flags`` (at least one scope enabled)."""
    if scope is None or not scope.strip():
        msg = "Browser keys require --scope (e.g. read,write or read,write,admin)."
        raise typer.BadParameter(msg)
    names = {part.strip().lower() for part in scope.split(",") if part.strip()}
    unknown = names - _BROWSER_SCOPE_KEYS
    if unknown:
        msg = f"Unknown scope(s): {', '.join(sorted(unknown))}. Use read, write, and/or admin."
        raise typer.BadParameter(msg)
    flags = {key: key in names for key in sorted(_BROWSER_SCOPE_KEYS)}
    if not any(flags.values()):
        msg = "At least one scope must be enabled."
        raise typer.BadParameter(msg)
    return flags


def _parse_browser_env(env: str) -> str:
    normalized = env.strip().lower()
    if normalized in _BROWSER_ENVS:
        return normalized
    msg = "--env must be 'live' or 'test'."
    raise typer.BadParameter(msg)


def _parse_mcp_transport(transport: str) -> str:
    normalized = transport.strip().lower()
    if normalized in _MCP_TRANSPORTS:
        return normalized
    msg = "--transport must be streamable_http, sse, or stdio."
    raise typer.BadParameter(msg)


def _expires_at_from_days(days: int) -> str:
    """Return ISO-8601 end-of-day UTC for ``expires_in_days``."""
    if days < 1:
        msg = "--expires-in-days must be at least 1."
        raise typer.BadParameter(msg)
    future = datetime.now(UTC) + timedelta(days=days)
    end_of_day = future.replace(hour=23, minute=59, second=59, microsecond=0)
    return end_of_day.isoformat().replace("+00:00", "Z")


def _fetch_mcp_tool_ids(client: RestClient) -> list[str]:
    """Load MCP tool ids from ``GET /api-keys/mcp-tools``."""
    response = client.get("/api-keys/mcp-tools")
    payload = response.json()
    if not isinstance(payload, dict):
        msg = "Unexpected response from GET /api-keys/mcp-tools."
        raise typer.BadParameter(msg)
    tools = payload.get("tools")
    if not isinstance(tools, list):
        msg = "Unexpected response from GET /api-keys/mcp-tools."
        raise typer.BadParameter(msg)
    ids: list[str] = []
    for tool in tools:
        if isinstance(tool, dict) and isinstance(tool.get("id"), str):
            ids.append(tool["id"])
    if not ids:
        msg = "No MCP tools returned from GET /api-keys/mcp-tools."
        raise typer.BadParameter(msg)
    return ids


def _build_mcp_scope_flags(
    *,
    client: RestClient,
    tools: list[str],
    all_tools: bool,
) -> dict[str, bool]:
    """Resolve MCP ``scope_flags`` from ``--tools`` and/or ``--all-tools``."""
    if all_tools and tools:
        msg = "Use either --tools or --all-tools, not both."
        raise typer.BadParameter(msg)
    if all_tools:
        tool_ids = _fetch_mcp_tool_ids(client)
        return dict.fromkeys(tool_ids, True)
    if not tools:
        msg = "MCP keys require --tools <tool-id> (repeatable) or --all-tools."
        raise typer.BadParameter(msg)
    return dict.fromkeys(tools, True)


def _confirm_create(
    *,
    key_type: str,
    label: str,
    skip: bool,
) -> None:
    """Prompt before issuing a key unless ``--yes`` was passed.

    Routed through :func:`confirm_action` so a non-interactive caller is told to pass
    ``--yes`` instead of being aborted with no explanation (clig.dev: never prompt when
    stdin is not a TTY, and always offer a flag that does the same thing).
    """
    type_label = "Browser" if key_type == "browser" else "MCP Server"
    confirm_action(
        f"Issue a new {type_label} API key labeled '{label}'?",
        skip=skip,
        escape_flag="--yes",
    )


def _emit_create_secret(secret: str) -> None:
    """Print the one-time secret with a warning banner (human output)."""
    from rich.panel import Panel

    console = make_console()
    console.print(
        Panel(
            secret,
            title="[bold yellow]API key secret[/bold yellow]",
            subtitle="Save now — this value will not be shown again",
            border_style="yellow",
        )
    )


def _normalize_key_type_filter(value: str | None) -> str | None:
    """Map CLI ``--type`` values to REST ``key_type`` query values."""
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized == "browser":
        return "browser"
    if normalized == "mcp":
        return "mcp_server"
    msg = "--type must be 'browser' or 'mcp'."
    raise typer.BadParameter(msg)


def _format_key_type(value: object) -> str:
    if value == "mcp_server":
        return "mcp"
    return "" if value is None else str(value)


def _format_scope_flags(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    enabled = [key for key, flag in value.items() if flag]
    return ", ".join(enabled)


def _format_scopes(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    if isinstance(value, dict):
        return _format_scope_flags(value)
    return ""


_API_KEY_LIST_COLUMNS: tuple[ListColumn, ...] = (
    ("Label", "label", None),
    ("Type", "key_type", _format_key_type),
    ("Env", "env", None),
    ("Scopes", "scope_flags", _format_scope_flags),
    ("Last Used", "last_used_at", None),
    ("Expires", "expires_at", None),
    ("Status", "rotation_status", None),
)

_POLICY_DISPLAY_ROWS: tuple[tuple[str, str, str], ...] = (
    (
        "Max key age (days)",
        "max_age_days",
        "Default lifetime for newly issued keys before rotation is required.",
    ),
    (
        "Warn N days before expiry",
        "warn_days_before",
        "Keys within this window appear in the expiring-soon KPI and rotation alerts.",
    ),
    (
        "Successor overlap (days)",
        "overlap_days",
        "During overlap, both predecessor and successor keys are accepted.",
    ),
    (
        "MCP keys never expire by default",
        "mcp_default_never_expire",
        "When enabled, new MCP Server keys skip expiry unless an explicit date is set.",
    ),
)

_API_KEY_SHOW_FIELDS: tuple[tuple[str, str], ...] = (
    ("ID", "id"),
    ("Label", "label"),
    ("Type", "key_type"),
    ("Prefix", "prefix"),
    ("Environment", "env"),
    ("Key", "api_key"),
    ("Scope flags", "scope_flags"),
    ("Scopes", "scopes"),
    ("Transport", "transport"),
    ("Rotation status", "rotation_status"),
    ("Status", "status"),
    ("Expires", "expires_at"),
    ("Days remaining", "expiry_days_remaining"),
    ("Last used", "last_used_at"),
    ("Revoked", "revoked_on"),
    ("Successor", "successor_key_id"),
    ("Rotated from", "rotated_from_key_id"),
    ("Impacted services", "impacted_services_count"),
    ("Enabled", "enabled"),
    ("Created", "created_on"),
)

def _resolve_key_label(record: dict[str, Any]) -> str:
    """Return the human-readable label from Epic 14 or legacy GET fields."""
    raw = record.get("label", record.get("name"))
    return "" if raw is None else str(raw)


def _resolve_key_expiry(record: dict[str, Any]) -> str | None:
    """Return ISO expiry from Epic 14 ``expires_at`` or legacy ``expires_on``."""
    raw = record.get("expires_at", record.get("expires_on"))
    return None if raw is None else str(raw)


def _fetch_api_key(client: RestClient, key_id: UUID) -> dict[str, Any]:
    """Load one API key record before rotate or revoke side effects."""
    response = client.get(f"/api-keys/{key_id}")
    payload = response.json()
    if not isinstance(payload, dict):
        msg = f"Unexpected response from GET /api-keys/{key_id}."
        raise typer.BadParameter(msg)
    return payload


def _confirm_revoke(*, label: str, key_id: UUID, skip: bool) -> None:
    """Prompt before revoking a key unless ``--yes`` was passed."""
    prompt_label = label or str(key_id)
    confirm_action(
        f"Revoke API key '{prompt_label}'?",
        skip=skip,
        escape_flag="--yes",
    )


def _show_field_value(record: dict[str, Any], key: str) -> str | None:
    """Resolve one show-row value, preferring Epic 14 list fields over legacy GET fields."""
    if key == "label":
        raw = record.get("label", record.get("name"))
    elif key == "env":
        raw = record.get("env", record.get("environment"))
    elif key == "expires_at":
        raw = record.get("expires_at", record.get("expires_on"))
    elif key == "last_used_at":
        raw = record.get("last_used_at", record.get("last_used_on"))
    elif key == "rotation_status":
        raw = record.get("rotation_status")
        if raw is None:
            raw = record.get("status")
    else:
        raw = record.get(key)

    if raw is None:
        return None
    if key == "key_type":
        return _format_key_type(raw)
    if key in {"scope_flags", "scopes"}:
        return _format_scopes(raw)
    if key == "enabled":
        return str(raw)
    if key == "expiry_days_remaining":
        return str(raw)
    return str(raw)


def _should_show_field(record: dict[str, Any], key: str) -> bool:
    """Return whether a show row should be rendered for the given record."""
    value = _show_field_value(record, key)
    if value not in (None, ""):
        return True
    if key in record:
        return True
    legacy_keys = {
        "label": "name",
        "env": "environment",
        "expires_at": "expires_on",
        "last_used_at": "last_used_on",
    }
    legacy_key = legacy_keys.get(key)
    return legacy_key is not None and legacy_key in record


def _format_policy_value(key: str, value: object) -> str:
    """Render one rotation policy field for human-readable output."""
    if key == "mcp_default_never_expire":
        if value is True:
            return "true"
        if value is False:
            return "false"
        return "" if value is None else str(value)
    if value is None:
        return ""
    return str(value)


def _fetch_rotation_policy(client: RestClient) -> dict[str, Any]:
    """Load workspace rotation policy from ``GET /api-keys/policy``."""
    response = client.get("/api-keys/policy")
    payload = response.json()
    if not isinstance(payload, dict):
        msg = "Unexpected response from GET /api-keys/policy."
        raise typer.BadParameter(msg)
    return payload


def _emit_rotation_policy_table(policy: dict[str, Any]) -> None:
    """Render rotation policy settings as a Rich table."""
    from rich.table import Table

    table = Table(show_header=True, header_style="bold")
    table.add_column("Setting")
    table.add_column("Value")
    table.add_column("Description")

    for label, key, description in _POLICY_DISPLAY_ROWS:
        table.add_row(label, _format_policy_value(key, policy.get(key)), description)

    console = make_console()
    console.print(table)


def _format_rotation_policy_summary(policy: dict[str, Any]) -> str:
    """Return a one-line summary of saved rotation policy values."""
    mcp_value = policy.get("mcp_default_never_expire")
    if mcp_value is True:
        mcp_label = "Never expires"
    elif mcp_value is False:
        mcp_label = "Policy default"
    else:
        mcp_label = "Unknown"
    return (
        f"Max {policy.get('max_age_days')}d / "
        f"Warn {policy.get('warn_days_before')}d / "
        f"Overlap {policy.get('overlap_days')}d / "
        f"MCP: {mcp_label}"
    )


def _parse_optional_bool_flag(value: str | None, *, option_name: str) -> bool | None:
    """Parse ``true``/``false`` CLI flag values when the option was provided."""
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    msg = f"{option_name} must be 'true' or 'false'."
    raise typer.BadParameter(msg)


def _merge_rotation_policy_body(
    current: dict[str, Any],
    *,
    max_age_days: int | None,
    warn_days_before: int | None,
    overlap_days: int | None,
    mcp_default_never_expire: bool | None,
) -> dict[str, Any]:
    """Merge CLI overrides onto the current workspace rotation policy."""
    body = {
        "max_age_days": current.get("max_age_days"),
        "warn_days_before": current.get("warn_days_before"),
        "overlap_days": current.get("overlap_days"),
        "mcp_default_never_expire": current.get("mcp_default_never_expire"),
    }
    if max_age_days is not None:
        body["max_age_days"] = max_age_days
    if warn_days_before is not None:
        body["warn_days_before"] = warn_days_before
    if overlap_days is not None:
        body["overlap_days"] = overlap_days
    if mcp_default_never_expire is not None:
        body["mcp_default_never_expire"] = mcp_default_never_expire
    return body


def _emit_api_key_show(record: dict[str, Any]) -> None:
    """Render one API key as a field/value table with Epic 14 and legacy field support."""
    from rich.table import Table

    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Value")

    for label, key in _API_KEY_SHOW_FIELDS:
        if not _should_show_field(record, key):
            continue
        value = _show_field_value(record, key)
        table.add_row(label, "" if value is None else value)

    console = make_console()
    console.print(table)


@policy_app.command("get")
def get_rotation_policy(
    ctx: typer.Context,
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Show workspace API key rotation policy (GET /api-keys/policy)."""
    policy = _fetch_rotation_policy(_api_client(ctx))
    if _json_output(ctx, output):
        emit_json(policy)
        return
    _emit_rotation_policy_table(policy)


@policy_app.command("set")
def set_rotation_policy(
    ctx: typer.Context,
    max_age_days: int | None = typer.Option(
        None,
        "--max-age",
        min=1,
        help="Maximum key age in days before rotation is required.",
    ),
    warn_days_before: int | None = typer.Option(
        None,
        "--warn",
        min=1,
        help="Days before expiry to warn operators and surface expiring-soon KPIs.",
    ),
    overlap_days: int | None = typer.Option(
        None,
        "--overlap",
        min=1,
        help="Days both predecessor and successor keys remain valid after rotation.",
    ),
    mcp_never_expire: str | None = typer.Option(
        None,
        "--mcp-never-expire",
        help="Default MCP never-expire flag: true or false.",
    ),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Update workspace API key rotation policy (PUT /api-keys/policy)."""
    mcp_default_never_expire = _parse_optional_bool_flag(
        mcp_never_expire,
        option_name="--mcp-never-expire",
    )
    if (
        max_age_days is None
        and warn_days_before is None
        and overlap_days is None
        and mcp_default_never_expire is None
    ):
        msg = "Provide at least one of --max-age, --warn, --overlap, or --mcp-never-expire."
        raise typer.BadParameter(msg)

    client = _api_client(ctx)
    current = _fetch_rotation_policy(client)
    body = _merge_rotation_policy_body(
        current,
        max_age_days=max_age_days,
        warn_days_before=warn_days_before,
        overlap_days=overlap_days,
        mcp_default_never_expire=mcp_default_never_expire,
    )

    response = client.put("/api-keys/policy", json=body)
    payload = response.json()
    if not isinstance(payload, dict):
        emit_json(payload)
        return

    if _json_output(ctx, output):
        emit_json(payload)
        return

    typer.echo(f"Workspace rotation policy updated: {_format_rotation_policy_summary(payload)}")


@app.command("create")
def create_api_key(
    ctx: typer.Context,
    key_type: str = typer.Option(
        ...,
        "--type",
        help="Key type: browser or mcp.",
    ),
    label: str = typer.Option(
        ...,
        "--label",
        help="Human-readable label for the new key.",
    ),
    env: str = typer.Option(
        "live",
        "--env",
        help="Browser environment: live or test.",
    ),
    scope: str | None = typer.Option(
        None,
        "--scope",
        help="Browser scopes as comma-separated list (read, write, admin).",
    ),
    ip_allow: list[str] = typer.Option(
        [],
        "--ip-allow",
        help="Browser CIDR allowlist entry (repeatable).",
    ),
    expires_in_days: int | None = typer.Option(
        None,
        "--expires-in-days",
        min=1,
        help="Browser key expiry in days from today (end of day UTC).",
    ),
    transport: str | None = typer.Option(
        None,
        "--transport",
        help="MCP transport: streamable_http, sse, or stdio.",
    ),
    tools: list[str] = typer.Option(
        [],
        "--tools",
        help="MCP tool id to enable (repeatable).",
    ),
    all_tools: bool = typer.Option(
        False,
        "--all-tools",
        help="Enable every MCP tool from the server manifest.",
    ),
    rate_limit: int | None = typer.Option(
        None,
        "--rate-limit",
        min=1,
        help="MCP requests-per-minute cap.",
    ),
    never_expire: bool = typer.Option(
        False,
        "--never-expire",
        help="MCP key ignores workspace rotation expiry.",
    ),
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        help="Skip confirmation prompt before issuing the key.",
    ),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Create a Browser or MCP API key (POST /api-keys); secret shown once."""
    rest_key_type = _normalize_create_key_type(key_type)
    trimmed_label = label.strip()
    if not trimmed_label:
        msg = "--label must not be empty."
        raise typer.BadParameter(msg)

    client = _api_client(ctx)
    body: dict[str, Any]

    if rest_key_type == "browser":
        if transport is not None:
            msg = "--transport applies only to MCP keys."
            raise typer.BadParameter(msg)
        if tools or all_tools:
            msg = "--tools and --all-tools apply only to MCP keys."
            raise typer.BadParameter(msg)
        if rate_limit is not None:
            msg = "--rate-limit applies only to MCP keys."
            raise typer.BadParameter(msg)
        if never_expire:
            msg = "--never-expire applies only to MCP keys."
            raise typer.BadParameter(msg)
        body = {
            "key_type": "browser",
            "label": trimmed_label,
            "env": _parse_browser_env(env),
            "scope_flags": _parse_browser_scope(scope),
        }
        if ip_allow:
            body["ip_allowlist"] = ip_allow
        if expires_in_days is not None:
            body["expires_at"] = _expires_at_from_days(expires_in_days)
    else:
        if scope is not None:
            msg = "--scope applies only to Browser keys."
            raise typer.BadParameter(msg)
        if env != "live":
            msg = "--env applies only to Browser keys."
            raise typer.BadParameter(msg)
        if ip_allow:
            msg = "--ip-allow applies only to Browser keys."
            raise typer.BadParameter(msg)
        if expires_in_days is not None:
            msg = "--expires-in-days applies only to Browser keys."
            raise typer.BadParameter(msg)
        if transport is None:
            msg = "MCP keys require --transport (streamable_http, sse, or stdio)."
            raise typer.BadParameter(msg)
        mcp_body: dict[str, Any] = {
            "key_type": "mcp_server",
            "label": trimmed_label,
            "scope_flags": _build_mcp_scope_flags(
                client=client,
                tools=tools,
                all_tools=all_tools,
            ),
            "transport": _parse_mcp_transport(transport),
        }
        if rate_limit is not None:
            mcp_body["rate_limit_rpm"] = rate_limit
        if never_expire:
            mcp_body["never_expire"] = True
        body = mcp_body

    _confirm_create(key_type=rest_key_type, label=trimmed_label, skip=yes)

    response = client.post("/api-keys", json=body)
    payload = response.json()
    if not isinstance(payload, dict):
        emit_json(payload)
        return

    if _json_output(ctx, output):
        emit_json(payload)
        return

    secret = payload.get("secret")
    display = {key: value for key, value in payload.items() if key != "secret"}
    _emit_api_key_show(display)
    if isinstance(secret, str) and secret:
        typer.echo("")
        _emit_create_secret(secret)


@app.command("list")
def list_api_keys(
    ctx: typer.Context,
    key_type: str | None = typer.Option(
        None,
        "--type",
        help="Filter by key type: browser or mcp.",
    ),
    limit: int = typer.Option(
        DEFAULT_PAGE_LIMIT,
        "--limit",
        min=1,
        help="Maximum rows to request from the API per page (server enforces its own max).",
    ),
    all_pages: bool = typer.Option(
        False,
        "--all",
        help="Fetch all pages automatically, ignoring the --limit cap.",
    ),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """List workspace API keys (GET /api-keys)."""
    client = _api_client(ctx)
    query_key_type = _normalize_key_type_filter(key_type)
    params = {"key_type": query_key_type} if query_key_type else None
    items, total = paginate_page_list(
        client,
        "/api-keys",
        limit=limit,
        fetch_all=all_pages,
        params=params,
    )
    if _json_output(ctx, output):
        emit_json(_strip_secret({"total": total, "items": items}))
    else:
        emit_list_table(items, _API_KEY_LIST_COLUMNS, total=total)


@app.command("show")
def show_api_key(
    ctx: typer.Context,
    key_id: UUID = typer.Argument(..., help="API key UUID."),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Inspect one API key including scope flags and rotation status (GET /api-keys/{id})."""
    response = _api_client(ctx).get(f"/api-keys/{key_id}")
    payload = response.json()
    if not isinstance(payload, dict):
        emit_json(_strip_secret(payload))
        return
    if _json_output(ctx, output):
        emit_json(_strip_secret(payload))
        return
    _emit_api_key_show(payload)


@app.command("rotate")
def rotate_api_key(
    ctx: typer.Context,
    key_id: UUID = typer.Argument(..., help="API key UUID to rotate."),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Rotate an API key; successor secret is shown only in this output (POST /api-keys/{id}/rotate)."""
    client = _api_client(ctx)
    predecessor = _fetch_api_key(client, key_id)
    previous_expires_at = _resolve_key_expiry(predecessor)

    response = client.post(f"/api-keys/{key_id}/rotate")
    payload = response.json()
    if not isinstance(payload, dict):
        emit_json(payload)
        return

    if _json_output(ctx, output):
        json_payload = dict(payload)
        if previous_expires_at is not None:
            json_payload["previous_expires_at"] = previous_expires_at
        emit_json(json_payload)
        return

    if previous_expires_at:
        typer.echo(f"Previous key expires: {previous_expires_at}")
        typer.echo("")

    label = payload.get("label")
    prefix = payload.get("prefix")
    secret = payload.get("secret")

    if isinstance(label, str) and label:
        typer.echo(f"Label: {label}")
    if isinstance(prefix, str) and prefix:
        typer.echo(f"Prefix: {prefix}")

    if isinstance(secret, str) and secret:
        typer.echo("")
        _emit_create_secret(secret)


@app.command("revoke")
def revoke_api_key(
    ctx: typer.Context,
    key_id: UUID = typer.Argument(..., help="API key UUID to revoke."),
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        help="Skip confirmation prompt before revoking the key.",
    ),
    output: str | None = typer.Option(
        None,
        "--output",
        help="Output format: table (default) or json.",
    ),
) -> None:
    """Revoke an API key (DELETE /api-keys/{id})."""
    client = _api_client(ctx)
    existing = _fetch_api_key(client, key_id)
    label = _resolve_key_label(existing)

    _confirm_revoke(label=label, key_id=key_id, skip=yes)

    client.delete(f"/api-keys/{key_id}")

    json_payload = {
        "id": str(key_id),
        "label": label,
        "revoked": True,
    }

    if _json_output(ctx, output):
        emit_json(json_payload)
        return

    display_label = label or str(key_id)
    typer.echo(f"Key {display_label} has been revoked")
