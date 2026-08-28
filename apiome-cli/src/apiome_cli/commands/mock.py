"""Mock commands.

Two surfaces live here:

* **Hosted mock management** — ``status``, ``enable``, ``disable`` (SIM-2.4, #4445). CLI parity
  with the SIM-2.1 REST control plane: the same eligibility rules and error surfaces as
  ``PUT /v1/versions/{tenant}/{project}/{version}/mock``, with output formatting consistent with
  the other version commands (human table + global ``--json``).
* **Portable mock runtime** — ``run`` (PMR-1.2, #4742). Launches a version-pinned mock bundle
  locally or in a container, with no control-plane connection at all.
* **Release-proof attestation** — ``verify-attestation`` (PMR-3.2, #4749). Verifies a mock
  attestation offline with the shared HMAC secret and prints what it attests, with no server round
  trip at all. It is the mirror of ``apiome lint verify-attestation``: the same envelope, the same
  secret, the same ~10 lines of stdlib verification.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import typer

from apiome_cli.attestation import attestation_statement, verify_attestation_envelope
from apiome_cli.client.mock_run import (
    SECRET_ENV_VAR,
    MockRunPlan,
    MockRuntimeUnavailableError,
    build_run_plan,
    read_bundle_mount,
)
from apiome_cli.client.mock_settings import (
    emit_mock_status,
    emit_mock_toggle_result,
    fetch_mock_usage,
    fetch_project_slug,
    fetch_version_record,
    set_version_mock,
)
from apiome_cli.client.version_scope import resolve_version_scope
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import emit_json, json_mode_from_context

app = typer.Typer(
    name="mock",
    help="Manage the hosted mock for published project versions.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)

_PROJECT_ARGUMENT = typer.Argument(..., metavar="PROJECT", help="Project UUID or slug.")
_VERSION_ARGUMENT = typer.Argument(
    ...,
    metavar="VERSION",
    help="Version UUID, slug, or label (e.g. 1.0.0).",
)


@app.callback(invoke_without_command=True)
def mock_group(ctx: typer.Context) -> None:
    """Mock command group."""
    group_callback_without_subcommand(ctx)


@app.command("status")
def mock_status(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
    days: int = typer.Option(
        30,
        "--days",
        min=1,
        help="Usage rollup window in days (only used when the mock is enabled).",
    ),
) -> None:
    """Show mock state, base URL, and usage (GET …/versions/…, GET /v1/mocks/{tenant}/usage).

    The usage summary is best-effort: when the usage endpoint is unavailable
    (mock server disabled or an older REST service) the status still prints
    without it.
    """
    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    record = fetch_version_record(client, tenant_slug, project_id, version_id)

    usage = None
    if record.get("mockEnabled"):
        project_slug = fetch_project_slug(client, tenant_slug, project_id)
        version_label = record.get("version_id")
        if project_slug and isinstance(version_label, str) and version_label:
            usage = fetch_mock_usage(
                client,
                tenant_slug,
                project_slug=project_slug,
                version_label=version_label,
                days=days,
            )

    emit_mock_status(
        record,
        usage,
        days=days,
        json_mode=json_mode_from_context(ctx),
    )


@app.command("enable")
def mock_enable(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
) -> None:
    """Enable the hosted mock (PUT …/mock; published versions only).

    Draft versions are rejected by REST with a readable error and a non-zero
    exit code — the REST service is the authority on eligibility.
    """
    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    record = set_version_mock(
        client,
        tenant_slug,
        project_id,
        version_id,
        enabled=True,
    )
    emit_mock_toggle_result(record, json_mode=json_mode_from_context(ctx))


@app.command("run")
def mock_run(
    ctx: typer.Context,
    bundle: Path = typer.Argument(
        ...,
        metavar="BUNDLE",
        help="Mock bundle to serve (export one with the version mock bundle endpoint).",
    ),
    host: str = typer.Option("127.0.0.1", "--host", help="Address to publish the mock on."),
    port: int = typer.Option(8775, "--port", min=1, max=65535, help="Port to publish the mock on."),
    runtime: str = typer.Option(
        "auto",
        "--runtime",
        help="Which runtime to launch: auto (prefer a local apiome-mock), local, or docker.",
    ),
    image: str | None = typer.Option(
        None,
        "--image",
        help="Container image for --runtime docker (default: the official image).",
    ),
    base_path: str = typer.Option(
        "version",
        "--base-path",
        help="Serve spec paths under /{tenant}/{project}/{version} (version) or at / (root).",
    ),
    require_signature: bool = typer.Option(
        False,
        "--require-signature",
        help="Refuse to start unless the bundle is signed.",
    ),
    log_level: str | None = typer.Option(
        None,
        "--log-level",
        help="Runtime log level (DEBUG, INFO, WARNING, ERROR, CRITICAL).",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Print the command that would run, and exit.",
    ),
) -> None:
    """Run a portable mock bundle locally or in a container (PMR-1.2).

    Talks to no control plane: the bundle is the whole configuration, so the same
    command works on a laptop, in CI, and inside an air-gapped network. The runtime
    launched here is the one the official image runs, so both answer the shared mock
    conformance corpus identically.

    Set APIOME_MOCK_BUNDLE_SECRET to verify a signed bundle; the secret reaches the
    runtime through the environment and never appears on a command line.
    """
    json_mode = json_mode_from_context(ctx)

    if runtime not in {"auto", "local", "docker"}:
        typer.secho(f"Unknown --runtime '{runtime}' (expected auto, local, or docker).", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE)
    if base_path not in {"version", "root"}:
        typer.secho(f"Unknown --base-path '{base_path}' (expected version or root).", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE)
    if not bundle.is_file():
        typer.secho(f"Bundle not found: {bundle}", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE)

    try:
        plan = build_run_plan(
            bundle,
            host=host,
            port=port,
            runtime=runtime,  # type: ignore[arg-type]
            image=image,
            base_path=base_path,
            require_signature=require_signature,
            log_level=log_level,
            # With --base-path root the spec is served at /, so there is no prefix to report.
            mount=read_bundle_mount(bundle) if base_path == "version" else "",
            secret_present=bool(os.environ.get(SECRET_ENV_VAR)),
        )
    except MockRuntimeUnavailableError as exc:
        typer.secho(str(exc), err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc

    if dry_run:
        _emit_run_plan(plan, json_mode=json_mode)
        return

    if json_mode:
        emit_json(plan.as_dict())
    else:
        typer.echo(f"Starting mock ({plan.runtime}) at {plan.base_url}{plan.mount}")
        typer.echo(f"  readiness  {plan.base_url}/ready")
        typer.echo(f"  command    {plan.command}")

    try:
        code = subprocess.call(list(plan.argv))
    except FileNotFoundError as exc:  # the executable vanished between planning and launching
        typer.secho(f"Failed to launch {plan.argv[0]}: {exc}", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc
    except KeyboardInterrupt:
        raise typer.Exit(0) from None
    if code != 0:
        raise typer.Exit(code)


def _emit_run_plan(plan: MockRunPlan, *, json_mode: bool) -> None:
    """Print a ``--dry-run`` plan in the caller's preferred format."""
    if json_mode:
        emit_json(plan.as_dict())
        return
    typer.echo(plan.command)


@app.command("disable")
def mock_disable(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
) -> None:
    """Disable the hosted mock (PUT …/mock with enabled=false)."""
    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    record = set_version_mock(
        client,
        tenant_slug,
        project_id,
        version_id,
        enabled=False,
    )
    emit_mock_toggle_result(record, json_mode=json_mode_from_context(ctx))


@app.command("verify-attestation")
def mock_verify_attestation(
    file: Path = typer.Option(
        ...,
        "--file",
        "-f",
        help="Attestation envelope JSON, as GET …/verification-runs/{id}/mock-attestation returns.",
    ),
    secret: str = typer.Option(
        ...,
        "--secret",
        "-s",
        envvar="APIOME_LINT_ATTESTATION_SECRET",
        help="Shared HMAC secret (server: APIOME_LINT_ATTESTATION_SIGNING_SECRET).",
    ),
) -> None:
    """Verify a release-proof mock attestation offline (PMR-3.2, no server round-trip).

    Recomputes the DSSE PAEv1 HMAC-SHA256 signature with the shared secret and compares it against
    the envelope's signatures, then prints the four identities the attestation carries: the bundle
    digest it was served from, the runtime that served it, the conformance corpus and result, and
    the fixture packs.

    Exits 0 only when the signature verifies **and** the attestation says the mock was verified —
    a signed statement that the mock failed, or was never verified, is a valid attestation and an
    unacceptable release proof, so the two are distinguished by the exit code rather than by prose.
    """
    try:
        envelope = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        typer.echo(f"Cannot read attestation file: {exc}", err=True)
        raise typer.Exit(EXIT_USAGE) from exc

    # The route wraps the envelope; accept either the wrapper or a bare envelope.
    if isinstance(envelope, dict) and isinstance(envelope.get("envelope"), dict):
        envelope = envelope["envelope"]

    if not verify_attestation_envelope(envelope, secret):
        typer.echo("Mock attestation verification FAILED.", err=True)
        raise typer.Exit(EXIT_ERROR)

    typer.echo("Mock attestation verified.")
    statement = attestation_statement(envelope) or {}
    predicate = statement.get("predicate") or {}
    bundle = predicate.get("bundle") or {}
    runtime = predicate.get("runtime") or {}
    conformance = predicate.get("conformance") or {}
    status = predicate.get("status")

    typer.echo(f"Status: {status}")
    if predicate.get("reasonCode"):
        typer.echo(f"Reason: {predicate['reasonCode']} — {predicate.get('reason') or ''}".rstrip())
    typer.echo(f"Bundle: {bundle.get('digest') or '(none)'}")
    typer.echo(f"Runtime: {runtime.get('name') or '(unknown)'} {runtime.get('version') or ''}".rstrip())
    if conformance:
        typer.echo(
            f"Corpus: {conformance.get('corpus_digest')} "
            f"({conformance.get('passed')}/{conformance.get('total')} passed)"
        )
    for pack in predicate.get("fixturePacks") or []:
        typer.echo(f"Fixture pack: {pack.get('name')} {pack.get('digest')}")

    if status != "verified":
        raise typer.Exit(EXIT_ERROR)
