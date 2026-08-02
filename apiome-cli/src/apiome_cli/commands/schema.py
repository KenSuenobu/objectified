"""``apiome schema test`` — CI schema testing over the IXH-5.1/5.2 services (#5117).

The command runs the same server-side validation the Schema Test Bench uses, against the
same path-shaped schema reference, and turns the verdicts into CI evidence: a stable
``--json`` report, JUnit XML via ``--junit``, and exit codes that keep "the tests failed"
(6) apart from "the network was down" (1) and "the credentials or the reference were
rejected" (2).

Three case sources, combinable in one run:

* ``--payload FILE`` (repeatable) — validate a concrete payload, expected valid;
* ``--generate`` — the IXH-5.2 generated set (valid instances + single-constraint
  mutants), each verified server-side through the IXH-5.1 validator;
* ``--suite PATH`` — the saved payload sets the Test Bench exports (IXH-5.3): a directory
  of payload files, or an IXH-1.1 corpus manifest whose ``instance-payload`` entries are
  run. Suite mode also runs the generated set unless ``--no-generate``.

All judging, rendering, and exit-code logic lives in :mod:`apiome_cli.schema_test`;
this module owns only the flags and the HTTP calls.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.version_scope import tenant_scoped_client
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import emit_json, json_mode_from_context
from apiome_cli.schema_test import (
    SOURCE_PAYLOAD,
    SOURCE_SUITE,
    SchemaTestCase,
    SuiteLoadError,
    SuitePayload,
    build_report,
    case_from_validation,
    cases_from_synthesis,
    exit_code_for_cases,
    load_payload_file,
    load_suite,
    render_human,
    render_junit,
)

app = typer.Typer(
    name="schema",
    help="Test payloads against cataloged schemas (CI evidence).",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)


@app.callback(invoke_without_command=True)
def schema_group(ctx: typer.Context) -> None:
    """Schema testing command group."""
    group_callback_without_subcommand(ctx)


@app.command("test")
def schema_test(
    ctx: typer.Context,
    schema_ref: str = typer.Option(
        ...,
        "--schema",
        help=(
            "Path-shaped schema reference: project/{slug}/{version}/{type}, "
            "catalog/{item}/{version}/{type}, or registry/{namespace}/{name}; the "
            "trailing /{type} segment is optional. {version} is a version label, a "
            "revision id, or 'latest'."
        ),
    ),
    payload: Optional[list[Path]] = typer.Option(
        None,
        "--payload",
        help="Payload file to validate (repeatable). JSON by default; *.xml is sent as XML.",
    ),
    generate: Optional[bool] = typer.Option(
        None,
        "--generate/--no-generate",
        help=(
            "Run the generated set: valid instances plus single-constraint mutants, each "
            "verified server-side. Default: off, except in --suite mode where it is on."
        ),
    ),
    suite: Optional[Path] = typer.Option(
        None,
        "--suite",
        help=(
            "Suite mode: a directory of saved payload files (all expected valid), or an "
            "IXH-1.1 corpus manifest whose 'instance-payload' entries are run with "
            "expectations from validity_class. Also runs the generated set unless "
            "--no-generate."
        ),
    ),
    seed: int = typer.Option(
        0,
        "--seed",
        min=0,
        help="Synthesis seed: the same schema and seed generate byte-identical payloads.",
    ),
    junit: Optional[Path] = typer.Option(
        None,
        "--junit",
        help="Write the run as JUnit XML to this file ('-' for stdout).",
    ),
) -> None:
    """Run schema tests server-side and gate on the verdicts.

    Exit codes: 0 every case passed; 6 at least one case failed (a payload's verdict did
    not match its expectation, or a mutant did not violate its intended constraint); 1 a
    case could not be checked at all, a transport/server fault, or an empty run; 2 bad
    usage, rejected credentials, or a schema reference the server refused (any 4xx).
    """
    run_generated = generate if generate is not None else suite is not None
    if not payload and not run_generated and suite is None:
        raise typer.BadParameter(
            "nothing to test: provide --payload, --generate, and/or --suite",
            param_hint="--payload",
        )
    if junit is not None and str(junit) == "-" and json_mode_from_context(ctx):
        raise typer.BadParameter(
            "cannot write JUnit to stdout together with --json; give --junit a file path",
            param_hint="--junit",
        )

    try:
        payload_files = [load_payload_file(p) for p in payload or []]
        suite_payloads = load_suite(suite) if suite is not None else []
    except SuiteLoadError as exc:
        raise typer.BadParameter(str(exc)) from exc

    client, tenant_slug = tenant_scoped_client(ctx)

    cases: list[SchemaTestCase] = []
    source_echo: Optional[dict[str, Any]] = None
    diagnostics: list[dict[str, Any]] = []
    rejected_mutants = 0

    def _validate(entry: SuitePayload, source: str) -> None:
        """Validate one payload file and record its judged case."""
        nonlocal source_echo
        response = client.post(
            api_paths.schema_validate(tenant_slug, schema_ref),
            json={"instance_text": entry.payload_text, "media_type": entry.media_type},
        ).json()
        source_echo = source_echo or response.get("source")
        _collect_diagnostics(diagnostics, response)
        cases.append(case_from_validation(entry, response, source=source))

    for entry in payload_files:
        _validate(entry, SOURCE_PAYLOAD)
    for entry in suite_payloads:
        _validate(entry, SOURCE_SUITE)

    if run_generated:
        response = client.post(
            api_paths.schema_synthesize(tenant_slug, schema_ref),
            json={"seed": seed, "verify": True},
        ).json()
        source_echo = source_echo or response.get("source")
        _collect_diagnostics(diagnostics, response)
        rejected = response.get("rejected_mutants")
        rejected_mutants = int(rejected) if isinstance(rejected, int) else 0
        cases.extend(cases_from_synthesis(response))

    report = build_report(
        schema_ref=schema_ref,
        seed=seed,
        cases=cases,
        source=source_echo,
        rejected_mutants=rejected_mutants,
        diagnostics=diagnostics,
    )

    if junit is not None:
        junit_text = render_junit(report)
        if str(junit) == "-":
            typer.echo(junit_text, nl=False)
        else:
            junit.write_text(junit_text, encoding="utf-8")

    if json_mode_from_context(ctx):
        emit_json(report)
    elif junit is None or str(junit) != "-":
        for line in render_human(report):
            typer.echo(line)
        if junit is not None:
            typer.echo(f"  wrote junit artifact to {junit}")

    raise typer.Exit(exit_code_for_cases(cases))


def _collect_diagnostics(collected: list[dict[str, Any]], response: dict[str, Any]) -> None:
    """Aggregate a response's top-level diagnostics, deduplicated by code + message."""
    for diagnostic in response.get("diagnostics") or []:
        if not isinstance(diagnostic, dict):
            continue
        if any(
            d.get("code") == diagnostic.get("code")
            and d.get("message") == diagnostic.get("message")
            for d in collected
        ):
            continue
        collected.append(diagnostic)
