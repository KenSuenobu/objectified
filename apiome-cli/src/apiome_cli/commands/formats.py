"""``apiome formats`` — the format support matrix on the command line (FMT-1.5, #5416).

Prints ``GET /v1/formats/matrix``: one row per format this deployment reads or writes, with the
direction, whether an import mints a publishable Project or a catalog item, the accepted input
kinds, the declared version coverage, the advisory file extensions, and whether the format's
toolchain is actually installed here.

It is a *listing* command, so it stays a thin renderer: the filters are query parameters, not a
client-side pass over the rows, and ``--json`` prints the response unchanged. That is the whole
point of the matrix — one authoritative answer, rendered rather than re-derived, so the CLI, the
generated documentation page and any partner integration cannot drift apart.
"""

from __future__ import annotations

from typing import Annotated

import typer

from apiome_cli.cli_context import (
    insecure_from_context,
    settings_from_context,
    timeout_from_context,
)
from apiome_cli.client.http import RestClient
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_USAGE
from apiome_cli.format_matrix import (
    DIRECTIONS,
    emit_format_matrix,
    fetch_format_matrix,
    unknown_direction_message,
)
from apiome_cli.output import json_mode_from_context


def formats(
    ctx: typer.Context,
    json_output: Annotated[
        bool,
        typer.Option(
            "--json",
            help="Emit the raw matrix JSON on stdout (machine-readable).",
        ),
    ] = False,
    paradigm: Annotated[
        str | None,
        typer.Option(
            "--paradigm",
            help=(
                "Show only formats in this paradigm: rest, rpc, event, graph, data_schema, agent."
            ),
        ),
    ] = None,
    direction: Annotated[
        str | None,
        typer.Option(
            "--direction",
            help=(
                "Show only formats with this capability: import (everything Apiome can read), "
                "export (everything it can write), or both (formats that round-trip)."
            ),
        ),
    ] = None,
) -> None:
    """List the formats this deployment supports, in which directions and at which versions.

    Args:
        ctx: The Typer context, carrying the root flags (``--json``, ``--timeout``, ``--insecure``)
            and the resolved settings.
        json_output: Print the endpoint's response verbatim. Accepted here as well as on the root
            command (``apiome --json formats``) so the flag works in the position users reach for.
        paradigm: Optional paradigm filter, validated and applied server-side.
        direction: Optional capability filter (``import`` / ``export`` / ``both``), validated here
            so a typo is a usage error rather than a 422 from the API.

    Raises:
        typer.Exit: With :data:`~apiome_cli.exit_codes.EXIT_USAGE` when ``--direction`` is not one
            of the three accepted values.
    """
    normalized_direction = direction.strip().lower() if direction else None
    if normalized_direction and normalized_direction not in DIRECTIONS:
        typer.echo(unknown_direction_message(direction or ""), err=True)
        raise typer.Exit(EXIT_USAGE)

    normalized_paradigm = paradigm.strip().lower() if paradigm else None

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = RestClient(
        settings,
        timeout=timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    payload = fetch_format_matrix(
        client,
        paradigm=normalized_paradigm,
        direction=normalized_direction,
    )
    emit_format_matrix(payload, json_mode=json_output or json_mode_from_context(ctx))
