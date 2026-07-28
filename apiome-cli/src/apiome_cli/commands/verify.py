"""Contract verification from the command line — ECA-2.2 (#4733).

``apiome verify contract --project … --version … --target … --format junit`` submits
execution to the ECA-2.1 runner, streams an actionable summary (evidence id + per-case
failures), writes standard CI artifacts via the ECA-1.3 export endpoint, and exits
non-zero when the stored outcome is not ``passed``.

Target credentials are never accepted on the CLI: the server materialises ``env`` or
``stored`` references only. CLI auth is the usual ``APIOME_API_KEY`` / config path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import typer

from apiome_cli.cli_context import (
    import_timeout_from_context,
    insecure_from_context,
    settings_from_context,
)
from apiome_cli.client import api_paths
from apiome_cli.client.contract_verify import (
    EXPORT_FORMATS,
    REFERENCE_KINDS,
    build_run_request,
    build_suite_options,
    exit_code_for_run,
    format_operation_failure,
    format_run_error,
    non_passing_operations,
    parse_context_pairs,
)
from apiome_cli.client.http import RestClient
from apiome_cli.client.tenant_scope import require_tenant_slug
from apiome_cli.config import require_api_key
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import emit_json, json_mode_from_context

app = typer.Typer(
    name="verify",
    help="Run executable contract verification and emit CI artifacts.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)


@app.callback(invoke_without_command=True)
def verify_group(ctx: typer.Context) -> None:
    """Verification command group."""
    group_callback_without_subcommand(ctx)


def _verify_client(ctx: typer.Context) -> tuple[RestClient, str]:
    """Authenticated client with a long default timeout for synchronous suite runs."""
    settings = settings_from_context(ctx)
    require_api_key(settings)
    client = RestClient(
        settings,
        timeout=import_timeout_from_context(ctx),
        verify=not insecure_from_context(ctx),
    )
    tenant_slug = require_tenant_slug(settings, client)
    return client, tenant_slug


@app.command("contract")
def verify_contract(
    ctx: typer.Context,
    project: str = typer.Option(
        ...,
        "--project",
        help="Project slug or UUID (or Catalog item slug/UUID with --kind catalog).",
    ),
    version: str = typer.Option(
        ...,
        "--version",
        help="Version label, revision UUID, or 'latest'.",
    ),
    target: str = typer.Option(
        ...,
        "--target",
        help=(
            "Verification target slug or id. Credentials come from the target's "
            "env/stored reference on the server — never from this flag."
        ),
    ),
    kind: str = typer.Option(
        "project",
        "--kind",
        help="Which surface the artifact lives on: project (default) or catalog.",
    ),
    output_format: str = typer.Option(
        "json",
        "--format",
        help="CI artifact format: json (default) or junit.",
    ),
    out: Optional[Path] = typer.Option(
        None,
        "--out",
        help="Write the export artifact to this file (JSON or JUnit XML).",
    ),
    seed: int = typer.Option(
        0,
        "--seed",
        min=0,
        help="Seed for generated values. The same version and seed give the same suite.",
    ),
    examples: bool = typer.Option(
        True,
        "--examples/--no-examples",
        help="Compile the examples declared in the source document (on by default).",
    ),
    generated: bool = typer.Option(
        True,
        "--generated/--no-generated",
        help="Compile schema-valid generated bodies (on by default).",
    ),
    negative: bool = typer.Option(
        True,
        "--negative/--no-negative",
        help="Compile the negative cases a contract needs to be worth running (on by default).",
    ),
    operation: Optional[list[str]] = typer.Option(
        None,
        "--operation",
        help="Restrict to this operation key (repeatable), e.g. 'GET /pets/{petId}'.",
    ),
    max_operations: Optional[int] = typer.Option(
        None,
        "--max-operations",
        min=1,
        help="Cap on compiled operations. Truncation is reported as a finding.",
    ),
    idempotency_key: Optional[str] = typer.Option(
        None,
        "--idempotency-key",
        help="Evidence upload retry key; a repeated key returns the original run.",
    ),
    context_pair: Optional[list[str]] = typer.Option(
        None,
        "--context",
        help="Non-secret CI context as KEY=VALUE (repeatable), e.g. commit=abc123.",
    ),
) -> None:
    """Execute a contract suite against a target (POST …/contracts/{ref}/run).

    Prints a summary with the evidence run id and per-case failures. Writes JSON or
    JUnit via the export endpoint when ``--out`` / ``--format`` ask for an artifact.
    Exits non-zero when the stored outcome is not ``passed``, or when the suite
    cannot run (``ok: false``).
    """
    reference_kind = (kind or "project").strip().lower()
    if reference_kind not in REFERENCE_KINDS:
        raise typer.BadParameter("must be one of project, catalog", param_hint="--kind")

    fmt = (output_format or "json").strip().lower()
    if fmt not in EXPORT_FORMATS:
        raise typer.BadParameter("must be one of json, junit", param_hint="--format")

    try:
        context = parse_context_pairs(context_pair)
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="--context") from exc

    options = build_suite_options(
        seed=seed,
        examples=examples,
        generated=generated,
        negative=negative,
        operation=operation,
        max_operations=max_operations,
    )
    body = build_run_request(
        target_ref=target,
        options=options,
        idempotency_key=idempotency_key,
        context=context or None,
    )

    client, tenant_slug = _verify_client(ctx)
    reference = f"{reference_kind}/{project}/{version}"
    payload = client.post(
        api_paths.contract_run(tenant_slug, reference),
        json=body,
        headers={"Accept": "application/json"},
    ).json()

    json_mode = json_mode_from_context(ctx)

    if not payload.get("ok"):
        error = payload.get("error") or {}
        if json_mode:
            emit_json(payload)
        else:
            typer.echo(
                f"Contract verification could not run for {reference} against {target}.",
                err=True,
            )
            for line in format_run_error(error if isinstance(error, dict) else {}):
                typer.echo(line, err=True)
        raise typer.Exit(EXIT_ERROR)

    run = payload.get("run") or {}
    if not isinstance(run, dict) or not run.get("id"):
        typer.echo(
            "Contract verification returned ok but no evidence run id — refusing a silent pass.",
            err=True,
        )
        raise typer.Exit(EXIT_ERROR)

    run_id = str(run["id"])
    export_path = (
        f"{api_paths.verification_run_export(tenant_slug, run_id)}?format={fmt}"
    )
    artifact_text = client.get(export_path).text

    if out is not None:
        out.write_text(artifact_text, encoding="utf-8")

    if json_mode:
        emit_json(payload)
    elif out is not None:
        _emit_summary(payload, reference=reference, target=target, out=out, fmt=fmt)
    elif fmt == "junit":
        typer.echo(artifact_text)
    else:
        # Human mode, format=json, no --out: actionable summary (artifact available via --out).
        _emit_summary(payload, reference=reference, target=target, out=None, fmt=fmt)

    raise typer.Exit(exit_code_for_run(payload))


def _emit_summary(
    payload: dict[str, Any],
    *,
    reference: str,
    target: str,
    out: Optional[Path],
    fmt: str,
) -> None:
    """Print the human-readable summary of one verification run."""
    run = payload.get("run") or {}
    counts = run.get("counts") or {}
    outcome = run.get("outcome") or "?"
    typer.echo(f"Contract verification for {reference} → target {target} — {outcome}")
    typer.echo(f"  evidence: {run.get('id')}")
    typer.echo(f"  suite digest: {payload.get('suite_digest') or run.get('suite_digest')}")
    typer.echo(
        f"  target: {run.get('target_slug')} ({run.get('target_environment')}) "
        f"{run.get('target_base_url')}"
    )
    typer.echo(
        "  counts: {total} total, {passed} passed, {failed} failed, "
        "{errored} errored, {skipped} skipped".format(
            total=counts.get("total", 0),
            passed=counts.get("passed", 0),
            failed=counts.get("failed", 0),
            errored=counts.get("errored", 0),
            skipped=counts.get("skipped", 0),
        )
    )
    failures = non_passing_operations(run)
    if failures:
        typer.echo(f"  failures ({len(failures)}):")
        for op in failures:
            typer.echo(format_operation_failure(op))
    if out is not None:
        typer.echo(f"  wrote {fmt} artifact to {out}")
