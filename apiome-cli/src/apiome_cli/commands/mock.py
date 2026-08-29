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
* **Configuration as a file** — ``config pull`` / ``config push`` / ``config diff`` and
  ``preview`` (MSC-1.4, #5530). The settings that decide what a mock *returns* become one
  reviewable document that can be committed, diffed in a pull request, checked for drift in CI,
  and promoted from one version to another. ``preview`` renders a single request through the
  MSC-1.2 dry-run endpoint — or, with ``--bundle``, through the portable runtime with no control
  plane at all.
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
from apiome_cli.client.mock_preview_local import (
    OfflinePreviewError,
    build_preview_plan,
    run_preview_plan,
)
from apiome_cli.client.mock_settings import (
    emit_mock_status,
    emit_mock_toggle_result,
    fetch_mock_config,
    fetch_mock_usage,
    fetch_project_slug,
    fetch_version_record,
    push_mock_config,
    request_hosted_preview,
    set_version_mock,
)
from apiome_cli.client.version_scope import resolve_version_scope
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.mock_config import (
    MockConfigError,
    diff_documents,
    document_sections,
    read_document,
    serialize_document,
)
from apiome_cli.mock_config_output import (
    emit_config_diff,
    emit_config_document,
    emit_config_errors,
    emit_preview_result,
    emit_push_outcome,
)
from apiome_cli.mock_preview_request import PreviewRequestError, build_preview_request
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


config_app = typer.Typer(
    name="config",
    help="Read, write and diff a version's mock configuration as one reviewable document.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)
app.add_typer(config_app, name="config")

_CONFIG_FILE_OPTION = typer.Option(
    ...,
    "--file",
    "-f",
    metavar="FILE",
    help="Mock configuration document (write one with 'apiome mock config pull').",
)


@config_app.callback(invoke_without_command=True)
def mock_config_group(ctx: typer.Context) -> None:
    """Mock configuration command group."""
    group_callback_without_subcommand(ctx)


def _read_config_file(path: Path) -> dict[str, object]:
    """Read a configuration document, turning a bad one into a caller-fault exit."""
    try:
        return read_document(path)
    except MockConfigError as exc:
        typer.secho(str(exc), err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc


@config_app.command("pull")
def mock_config_pull(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
    out: Path | None = typer.Option(
        None,
        "--out",
        "-o",
        metavar="FILE",
        help="Write the document here instead of to stdout.",
    ),
) -> None:
    """Write a version's whole mock configuration as one canonical document (MSC-1.4).

    Correlation, scenarios, chaos and fixture packs, exactly as the control plane stores them,
    with keys sorted at every depth. The output depends only on the settings, so committing the
    file and pulling it again produces no diff — which is what lets 'apiome mock config diff'
    serve as a CI drift check.

    The document carries no tenant, project or version, so the same file can be pushed to a
    staging version and then to a production one.
    """
    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    document = fetch_mock_config(client, tenant_slug, project_id, version_id)
    json_mode = json_mode_from_context(ctx)

    if out is None:
        emit_config_document(document, json_mode=json_mode)
        return

    try:
        out.write_text(serialize_document(document), encoding="utf-8")
    except OSError as exc:
        typer.secho(f"Cannot write {out}: {exc}", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc
    if json_mode:
        emit_json({"path": str(out), "document": document})
    else:
        typer.echo(f"Wrote {out}")


@config_app.command("push")
def mock_config_push(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
    file: Path = _CONFIG_FILE_OPTION,
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Validate the document and report what would change, without writing anything.",
    ),
) -> None:
    """Validate and apply a mock configuration document to a version (MSC-1.4).

    The document replaces every section it carries — a section it omits is cleared, not left
    alone — so a committed file is the whole truth about what the mock returns.

    Validation is the server's: the document is checked through the very routes that would store
    it, all of them, before any of them writes. A rejected document therefore leaves the version
    untouched and reports every problem at once, each against the path in the file that caused it.
    Exits 2 when the document is rejected.
    """
    document = _read_config_file(file)
    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    subject = f"{project} {version}"
    json_mode = json_mode_from_context(ctx)

    remote = fetch_mock_config(client, tenant_slug, project_id, version_id)
    changes = diff_documents(remote, document, remote_label=subject, local_label=str(file))
    outcome = push_mock_config(
        client,
        tenant_slug,
        project_id,
        version_id,
        document=document,
        dry_run=dry_run,
    )

    if not outcome.valid:
        if json_mode:
            emit_json({**outcome.as_dict(), "diff": changes.as_dict()})
        else:
            emit_config_errors(outcome.errors, source=str(file))
        raise typer.Exit(EXIT_USAGE)

    emit_push_outcome(outcome, changes, source=str(file), subject=subject, json_mode=json_mode)


@config_app.command("diff")
def mock_config_diff(
    ctx: typer.Context,
    project: str = _PROJECT_ARGUMENT,
    version: str = _VERSION_ARGUMENT,
    file: Path = _CONFIG_FILE_OPTION,
) -> None:
    """Show what pushing a mock configuration document would change (MSC-1.4).

    Built for CI: exit 0 means the committed file and the version agree, exit 1 means they have
    drifted, and exit 2 means the check could not run at all (bad file, auth, network). That is
    the same split 'apiome diff' uses, for the same reason — a drift check that cannot tell "they
    differ" from "the server was down" is not a check.
    """
    document = _read_config_file(file)
    subject = f"{project} {version}"

    # Remap setup/HTTP EXIT_ERROR → 2 so drift (1) stays distinguishable.
    try:
        client, tenant_slug, project_id, version_id = resolve_version_scope(
            ctx,
            project=project,
            version=version,
        )
        remote = fetch_mock_config(client, tenant_slug, project_id, version_id)
    except typer.Exit as exc:
        if exc.exit_code == EXIT_ERROR:
            raise typer.Exit(EXIT_USAGE) from exc
        raise

    changes = diff_documents(remote, document, remote_label=subject, local_label=str(file))
    emit_config_diff(
        changes,
        subject=f"{file} against {subject}",
        json_mode=json_mode_from_context(ctx),
    )
    raise typer.Exit(EXIT_ERROR if changes.changed else EXIT_SUCCESS)


@app.command("preview")
def mock_preview(
    ctx: typer.Context,
    project: str | None = typer.Argument(
        None,
        metavar="[PROJECT]",
        help="Project UUID or slug (omit with --bundle).",
    ),
    version: str | None = typer.Argument(
        None,
        metavar="[VERSION]",
        help="Version UUID, slug, or label (omit with --bundle).",
    ),
    method: str = typer.Option("GET", "--method", "-X", help="HTTP method."),
    path: str = typer.Option(
        "/",
        "--path",
        help="Path relative to the version root (/pets/42); a ?query suffix is accepted.",
    ),
    header: list[str] = typer.Option(
        [],
        "--header",
        "-H",
        metavar="'NAME: VALUE'",
        help="Request header; repeatable.",
    ),
    query: list[str] = typer.Option(
        [],
        "--query",
        "-q",
        metavar="NAME=VALUE",
        help="Query parameter; repeat a name for a multi-valued parameter.",
    ),
    body: str | None = typer.Option(
        None,
        "--body",
        help="Request body: a literal value, @FILE, or @- for stdin. Parsed as JSON when it is JSON.",
    ),
    scenario: str | None = typer.Option(
        None,
        "--scenario",
        help="Scenario to select (shorthand for the X-Mock-Scenario header).",
    ),
    seed: int | None = typer.Option(
        None,
        "--seed",
        help="Pin schema synthesis to this seed (shorthand for ?__seed=).",
    ),
    file: Path | None = typer.Option(
        None,
        "--file",
        "-f",
        metavar="FILE",
        help="Render against this local configuration document instead of the stored settings.",
    ),
    bundle: Path | None = typer.Option(
        None,
        "--bundle",
        metavar="BUNDLE",
        help="Render offline against a mock bundle, with no control-plane connection.",
    ),
    runtime: str = typer.Option(
        "auto",
        "--runtime",
        help="With --bundle: auto (prefer a local apiome-mock), local, or docker.",
    ),
    image: str | None = typer.Option(
        None,
        "--image",
        help="With --bundle --runtime docker: the container image (default: the official image).",
    ),
    require_signature: bool = typer.Option(
        False,
        "--require-signature",
        help="With --bundle: refuse an unsigned bundle.",
    ),
) -> None:
    """Render one request against a mock and print what it would return, and why (MSC-1.4).

    Nothing is sent and nothing is written. The response carries the status, headers, media type
    and body the mock would serve, plus the decision trace naming which layer produced the body —
    a scenario and which rule, session-scoped CRUD, correlation and which pointers, or a declared
    example versus schema synthesis.

    Two ways to reach the renderer, one answer either way, because both render through the
    portable runtime:

    * PROJECT VERSION previews the hosted version through the MSC-1.2 dry-run endpoint. With
      --file the render uses a local configuration document instead of the stored settings, so an
      author can iterate before pushing.
    * --bundle renders a portable mock bundle offline, launching the runtime the way 'mock run'
      does. No API key, no tenant scope, no network.

    Chaos is reported rather than applied: a preview that slept for a configured latency, or that
    randomly answered 500, would be answering a different question. The exit code reports whether
    the preview ran, not what the mock would answer — a previewed 404 exits 0.
    """
    json_mode = json_mode_from_context(ctx)

    if bundle is not None and (project or version):
        typer.secho(
            "Pass either PROJECT VERSION (hosted preview) or --bundle (offline preview), not both.",
            err=True,
            fg="red",
        )
        raise typer.Exit(EXIT_USAGE)
    if bundle is None and not (project and version):
        typer.secho(
            "Preview needs a target: PROJECT VERSION for the hosted mock, or --bundle for a "
            "portable bundle.",
            err=True,
            fg="red",
        )
        raise typer.Exit(EXIT_USAGE)
    if bundle is not None and file is not None:
        typer.secho(
            "--file overrides stored settings and has no meaning with --bundle: a bundle already "
            "carries its own configuration.",
            err=True,
            fg="red",
        )
        raise typer.Exit(EXIT_USAGE)

    try:
        request = build_preview_request(
            method=method,
            path=path,
            headers=header,
            query=query,
            body=body,
            scenario=scenario,
            seed=seed,
        )
    except PreviewRequestError as exc:
        typer.secho(str(exc), err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc

    if bundle is not None:
        result = _preview_against_bundle(
            bundle,
            request,
            runtime=runtime,
            image=image,
            require_signature=require_signature,
        )
    else:
        result = _preview_against_version(
            ctx,
            project=str(project),
            version=str(version),
            request=request,
            file=file,
        )

    emit_preview_result(result, method=method, path=path, json_mode=json_mode)


def _preview_against_bundle(
    bundle: Path,
    request: dict[str, object],
    *,
    runtime: str,
    image: str | None,
    require_signature: bool,
) -> dict[str, object]:
    """Render a preview offline, through the portable runtime.

    Args:
        bundle: The bundle to render against.
        request: The synthetic request document.
        runtime: ``auto``, ``local``, or ``docker``.
        image: Container image for the Docker plan.
        require_signature: Refuse an unsigned bundle.

    Returns:
        The preview result, in the same shape the hosted endpoint returns (``draft`` is always
        false: a bundle is a stored configuration, not a draft laid over one).
    """
    if runtime not in {"auto", "local", "docker"}:
        typer.secho(f"Unknown --runtime '{runtime}' (expected auto, local, or docker).", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE)
    if not bundle.is_file():
        typer.secho(f"Bundle not found: {bundle}", err=True, fg="red")
        raise typer.Exit(EXIT_USAGE)

    try:
        plan = build_preview_plan(
            bundle,
            runtime=runtime,  # type: ignore[arg-type]
            image=image,
            require_signature=require_signature,
            secret_present=bool(os.environ.get(SECRET_ENV_VAR)),
        )
        result = run_preview_plan(plan, request)
    except MockRuntimeUnavailableError as exc:
        typer.secho(str(exc), err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc
    except OfflinePreviewError as exc:
        typer.secho(str(exc), err=True, fg="red")
        raise typer.Exit(EXIT_USAGE) from exc
    return {"draft": False, **result}


def _preview_against_version(
    ctx: typer.Context,
    *,
    project: str,
    version: str,
    request: dict[str, object],
    file: Path | None,
) -> dict[str, object]:
    """Render a preview against a hosted version, optionally with a local configuration document.

    Args:
        ctx: The Typer context (tenant scope, credentials, --json).
        project: Project UUID or slug.
        version: Version UUID, slug, or label.
        request: The synthetic request document.
        file: A configuration document to render against instead of the stored settings.

    Returns:
        The preview result.
    """
    settings = None
    if file is not None:
        settings = document_sections(_read_config_file(file))

    client, tenant_slug, project_id, version_id = resolve_version_scope(
        ctx,
        project=project,
        version=version,
    )
    result, errors = request_hosted_preview(
        client,
        tenant_slug,
        project_id,
        version_id,
        request=request,
        settings=settings,
    )
    if result is None:
        emit_config_errors(errors, source=str(file) if file is not None else "The preview request")
        raise typer.Exit(EXIT_USAGE)
    return result
