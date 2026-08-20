"""Typer application entry point for the apiome CLI."""

from typing import Annotated

import click
import typer

from apiome_cli import __version__
from apiome_cli.client.errors import handle_cli_failure, is_verbose
from apiome_cli.commands import (
    auth,
    compat,
    config,
    contract,
    convert,
    diff,
    doctor,
    export,
    formats,
    health,
    lint,
    mcp,
    mock,
    operations,
    paths,
    projects,
    properties,
    repos,
    repository,
    schema,
    schemas,
    spec,
    types,
    verify,
)
from apiome_cli.commands import import_ as import_commands
from apiome_cli.commands import versions
from apiome_cli.config import EnvFileNotFoundError, resolve_env_file_path
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.help_util import build_command_directory, echo_concise_help, show_cli_help


class _ApiomeCLI(typer.core.TyperGroup):
    """Root Typer group that appends the full command directory to ``--help``."""

    def format_help(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        super().format_help(ctx, formatter)
        formatter.write("\n")
        formatter.write(build_command_directory(app))
        formatter.write("\n")


app = typer.Typer(
    name="apiome",
    help="Command-line client for the Apiome REST API.",
    no_args_is_help=False,
    add_completion=False,
    pretty_exceptions_enable=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    cls=_ApiomeCLI,
)

app.add_typer(auth.app, name="auth")
app.add_typer(config.app, name="config")
app.add_typer(doctor.app, name="doctor")
app.add_typer(health.app, name="health")
app.add_typer(projects.app, name="projects")
app.add_typer(properties.app, name="properties")
app.add_typer(repos.app, name="repos")
app.add_typer(repository.app, name="repository")
app.add_typer(schema.app, name="schema")
app.add_typer(schemas.app, name="schemas")
app.add_typer(types.app, name="types")
app.add_typer(versions.app, name="versions")
app.add_typer(paths.app, name="paths")
app.add_typer(lint.app, name="lint")
app.add_typer(compat.app, name="compat")
app.add_typer(contract.app, name="contract")
app.add_typer(verify.app, name="verify")
app.command("diff")(diff.diff)
app.add_typer(spec.app, name="spec")
app.add_typer(operations.app, name="operations")
app.add_typer(mcp.app, name="mcp")
app.add_typer(mock.app, name="mock")
app.add_typer(import_commands.app, name="import")
app.add_typer(export.app, name="export")
app.command("convert")(convert.convert)
app.command("formats")(formats.formats)


@app.command("help")
def help_command(
    command: Annotated[
        list[str] | None,
        typer.Argument(
            help="Subcommand path (e.g. projects list, import openapi).",
        ),
    ] = None,
) -> None:
    """Show concise usage, or ``--help`` for a subcommand."""
    raise typer.Exit(show_cli_help(command))


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show the CLI version and exit.",
    ),
    base_url: str | None = typer.Option(
        None,
        "--base-url",
        help=(
            "REST API base URL (overrides APIOME_BASE_URL, config file, and .env)."
        ),
    ),
    tenant: str | None = typer.Option(
        None,
        "--tenant",
        help=(
            "Tenant UUID (overrides APIOME_TENANT_ID, config file, and .env)."
        ),
    ),
    api_key: str | None = typer.Option(
        None,
        "--api-key",
        help=(
            "API key for Tier 2 endpoints "
            "(overrides APIOME_API_KEY, config file, and .env)."
        ),
    ),
    session_token: str | None = typer.Option(
        None,
        "--session-token",
        help=(
            "UI session bearer token for auth and PAT commands "
            "(overrides APIOME_SESSION_TOKEN, config file, and .env)."
        ),
    ),
    env_file: str | None = typer.Option(
        None,
        "--env-file",
        help=(
            "Load settings from this dotenv file instead of the default "
            "package and cwd .env files."
        ),
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="Emit raw API JSON on stdout (machine-readable).",
    ),
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="Show Python tracebacks on unexpected failures.",
    ),
    timeout: float | None = typer.Option(
        None,
        "--timeout",
        min=0.1,
        help=(
            "HTTP timeout in seconds (default 30; import wait uses 120 unless set). "
            "For imports, prefer the per-command --import-timeout."
        ),
    ),
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        help="Disable stderr progress spinner during long imports.",
    ),
    insecure: bool = typer.Option(
        False,
        "--insecure",
        help=(
            "Disable TLS certificate verification. "
            "For local development with self-signed certificates only."
        ),
    ),
) -> None:
    """Apiome REST client and import tool."""
    ctx.ensure_object(dict)
    resolved_env_file: str | None = None
    if env_file is not None:
        try:
            resolved_env_file = str(resolve_env_file_path(env_file))
        except EnvFileNotFoundError as exc:
            typer.echo(f"Env file not found: {exc.filename}", err=True)
            raise typer.Exit(EXIT_USAGE) from exc

    ctx.obj["base_url"] = base_url
    ctx.obj["tenant_id"] = tenant
    ctx.obj["api_key"] = api_key
    ctx.obj["session_token"] = session_token
    ctx.obj["env_file"] = resolved_env_file
    ctx.obj["json"] = json_output
    ctx.obj["verbose"] = verbose
    ctx.obj["timeout"] = timeout
    ctx.obj["no_progress"] = no_progress
    ctx.obj["insecure"] = insecure

    if version:
        typer.echo(f"apiome {__version__}")
        raise typer.Exit(EXIT_SUCCESS)

    if ctx.invoked_subcommand is None:
        echo_concise_help()
        raise typer.Exit(EXIT_SUCCESS)


def run() -> None:
    """Console script entry: delegate to Typer (Click handles exit codes).

    With standalone_mode=False, Click swallows typer.Exit internally and returns
    the integer exit code as the call's return value instead of re-raising the
    exception.  We must inspect that return value and forward it to the OS so
    that failure commands (which raise typer.Exit(EXIT_ERROR)) actually exit 1.
    """
    try:
        result = app(standalone_mode=False)
    except typer.Exit as exit_exc:
        # Defensive path: typer.Exit raised outside the app() call itself.
        raise SystemExit(exit_exc.exit_code) from exit_exc
    except Exception as exc:
        try:
            handle_cli_failure(exc, verbose=is_verbose())
        except typer.Exit as exit_exc:
            raise SystemExit(exit_exc.exit_code) from exit_exc
        raise SystemExit(EXIT_ERROR) from exc
    # Forward the exit code returned by Click when a command raised typer.Exit.
    if isinstance(result, int):
        raise SystemExit(result)


if __name__ == "__main__":
    run()
