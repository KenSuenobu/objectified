"""Convert a catalog item to OpenAPI from the CLI (MFI-22.6).

Thin client over ``POST /v1/catalog/{tenant_slug}/{artifact}/convert`` (the same verb the UI preview
and the API use). ``apiome convert <artifact> --to openapi`` commits the conversion into a new
publishable Project/version; ``--dry-run`` returns only the fidelity report (and, with ``--out``, the
would-be OpenAPI document) with no side effects. The command prints the server-computed fidelity
summary + the mandatory warning, and — mirroring how ``lint --min-grade`` gates CI — exits non-zero
on a *low* fidelity tier unless ``--force`` is given, so a scripted convert surfaces an incomplete
result instead of silently accepting it.

``--to openapi`` is the only target today, but the verb is target-generic for future emitters. Optional
``--title`` / ``--api-version`` / ``--server`` supply defaults the conversion applies only where the
source left a gap (info title/version, servers), so a converted spec starts less incomplete.

``--projection-out`` writes the **machine-readable projection manifest** (CPDO-1.3): the deterministic
graph of which source construct became which OpenAPI JSON Pointer, with a status, reason code,
evidence references and remediation on every edge. It is paged out of the read-only
``POST .../projection`` endpoint under the *same* defaults the conversion uses — those defaults are
folded into the snapshot hash, so a manifest fetched with different ones would describe a different
conversion.
"""

from __future__ import annotations

import json
from typing import Any

import typer

from apiome_cli.cli_context import (
    import_timeout_from_context,
    insecure_from_context,
    settings_from_context,
)
from apiome_cli.client import api_paths
from apiome_cli.client.conversion_output import (
    PROJECTION_PAGE_SIZE,
    assemble_projection_manifest,
    format_conversion_summary,
    is_low_tier,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.tenant_scope import require_tenant_slug
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.output import emit_json, json_mode_from_context
from apiome_cli.spec_output import write_document_bytes

# Only emit target today; the verb is target-generic for future emitters (MFI-22.6).
_SUPPORTED_TARGETS = frozenset({"openapi"})


def _build_defaults(
    title: str | None, api_version: str | None, servers: list[str]
) -> dict[str, Any] | None:
    """Build the request ``defaults`` bag from the gap-filling flags, or None when none were given."""
    cleaned_servers = [s.strip() for s in servers if s and s.strip()]
    defaults: dict[str, Any] = {}
    if title and title.strip():
        defaults["title"] = title.strip()
    if api_version and api_version.strip():
        defaults["version"] = api_version.strip()
    if cleaned_servers:
        defaults["servers"] = cleaned_servers
    return defaults or None


def _fetch_projection_manifest(
    client: RestClient,
    tenant_slug: str,
    artifact: str,
    defaults: dict[str, Any] | None,
) -> dict[str, Any]:
    """Page the full projection manifest for ``artifact`` out of the read-only projection endpoint.

    Passes the *same* ``defaults`` the conversion request carries, because they are folded into the
    manifest's snapshot hash: fetching without them would return a manifest describing a different
    conversion from the one the user just ran.

    Args:
        client: The authenticated REST client.
        tenant_slug: Resolved tenant slug.
        artifact: The catalog item id being converted.
        defaults: The gap-filling defaults, or ``None`` when none were supplied.

    Returns:
        ``{"summary": {...}, "nodes": [...], "edges": [...], "pagesTruncated": bool}``.
    """
    path = api_paths.catalog_projection(tenant_slug, artifact)

    def _fetch(cursor: str | None) -> dict[str, Any]:
        page_body: dict[str, Any] = {"target": "openapi", "limit": PROJECTION_PAGE_SIZE}
        if defaults is not None:
            page_body["defaults"] = defaults
        if cursor is not None:
            page_body["cursor"] = cursor
        return client.post(path, json=page_body).json()

    return assemble_projection_manifest(_fetch)


def convert(
    ctx: typer.Context,
    artifact: str = typer.Argument(..., help="Catalog item id (the non-OpenAPI import) to convert."),
    to: str = typer.Option(
        "openapi", "--to", help="Conversion target (only 'openapi' today; the verb is target-generic)."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Preview only: return the fidelity report with no project created."
    ),
    out: str | None = typer.Option(
        None,
        "--out",
        help="Write the would-be OpenAPI document here (dry-run only; '-' for stdout).",
    ),
    projection_out: str | None = typer.Option(
        None,
        "--projection-out",
        help="Write the machine-readable projection manifest here ('-' for stdout): which source "
        "construct became which OpenAPI pointer, and why anything did not.",
    ),
    force: bool = typer.Option(
        False, "--force", help="Do not exit non-zero on a low-fidelity result."
    ),
    title: str | None = typer.Option(
        None, "--title", help="Fallback API title, applied only if the source declares none."
    ),
    api_version: str | None = typer.Option(
        None, "--api-version", help="Fallback API version, applied only if the source declares none."
    ),
    server: list[str] = typer.Option(
        None, "--server", help="Fallback server URL (repeatable), applied only if the source has none."
    ),
) -> None:
    """Convert a catalog item to OpenAPI (``POST .../convert``); print the fidelity summary + warning.

    A commit (the default) creates a publishable Project/version from the converted OpenAPI document;
    ``--dry-run`` returns the fidelity report only. ``--projection-out`` additionally writes the
    machine-readable projection manifest (CPDO-1.3). Exits non-zero on a low-fidelity tier unless
    ``--force`` — a hint that the converted spec is substantially incomplete.
    """
    target = to.strip().lower()
    if target not in _SUPPORTED_TARGETS:
        raise typer.BadParameter(
            f"only 'openapi' is supported today (got {to!r})",
            param_hint="--to",
        )
    if out is not None and not dry_run:
        raise typer.BadParameter(
            "--out writes the previewed document; use it with --dry-run",
            param_hint="--out",
        )

    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = RestClient(
        settings,
        timeout=import_timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    tenant_slug = require_tenant_slug(settings, client)

    body: dict[str, Any] = {"target": "openapi", "dryRun": dry_run}
    defaults = _build_defaults(title, api_version, server or [])
    if defaults is not None:
        body["defaults"] = defaults

    path = api_paths.catalog_convert(tenant_slug, artifact, dry_run=dry_run)
    response = client.post(path, json=body).json()

    if out is not None:
        document = response.get("openapi")
        payload = json.dumps(document, indent=2).encode("utf-8")
        write_document_bytes(payload, out)

    if projection_out is not None:
        manifest = _fetch_projection_manifest(client, tenant_slug, artifact, defaults)
        write_document_bytes(json.dumps(manifest, indent=2).encode("utf-8"), projection_out)

    if json_mode_from_context(ctx):
        emit_json(response)
    else:
        for line in format_conversion_summary(response, committed=not dry_run):
            typer.echo(line)

    report = response.get("report")
    if isinstance(report, dict) and is_low_tier(report) and not force:
        raise typer.Exit(EXIT_ERROR)
