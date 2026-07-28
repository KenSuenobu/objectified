"""Contract-suite compilation from the command line — ECA-1.1 (#4729).

``apiome contract suite --project petstore --version 1.0.0`` compiles a published version into
an executable contract suite and prints — or writes — the manifest.

Two things make this worth having in CI rather than only in the API:

* ``--out`` writes the **canonical bytes** of the manifest: sorted keys, tight separators, one
  trailing newline. Those are the exact bytes the server's digest is taken over, so a suite can
  be committed to a repository and a later run can prove, with ``git diff``, that the contract
  did not move.
* The digest is **re-derived locally** from those bytes and compared with the one the server
  reported. A mismatch means the manifest was altered in transit or the two sides disagree about
  what the suite is, and the command fails rather than writing a file that only looks canonical.

The CLI implements no compilation logic: it calls
``POST /v1/tenants/{tenant}/contracts/{ref}/suite`` and formats the answer.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.version_scope import tenant_scoped_client
from apiome_cli.exit_codes import EXIT_ERROR
from apiome_cli.help_util import group_callback_without_subcommand
from apiome_cli.output import emit_json, json_mode_from_context

app = typer.Typer(
    name="contract",
    help="Compile and inspect executable contract suites for a version.",
    context_settings={"help_option_names": ["-h", "--help"]},
    add_completion=False,
)

#: Reference kinds the suite endpoint addresses, mirroring the REST reference grammar.
_KINDS = ("project", "catalog")

#: Algorithm prefix the server reports its digest under.
_DIGEST_PREFIX = "sha256:"


@app.callback(invoke_without_command=True)
def contract_group(ctx: typer.Context) -> None:
    """Contract-assurance command group."""
    group_callback_without_subcommand(ctx)


def canonical_manifest_text(manifest: dict[str, Any]) -> str:
    """Render a manifest as the canonical text its digest is taken over.

    Mirrors ``app.contract_suite.canonical_manifest_bytes`` exactly — sorted keys, no spaces
    after separators, non-ASCII left as-is, one trailing newline — so a file written here and a
    digest computed on the server describe the same bytes.

    :param manifest: The manifest as received from the API.
    :returns: The canonical JSON text, newline-terminated.
    """
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def recompute_digest(manifest: dict[str, Any]) -> str:
    """Recompute a manifest's digest from its own canonical bytes.

    The server hashes the manifest with ``digest`` blanked, so the same blanking is applied here
    before hashing. Any difference in either side's serialization shows up as a mismatch, which
    is the point.

    :param manifest: The manifest as received from the API.
    :returns: The digest, prefixed with its algorithm (``sha256:…``).
    """
    blanked = dict(manifest)
    blanked["digest"] = ""
    payload = canonical_manifest_text(blanked).encode("utf-8")
    return _DIGEST_PREFIX + hashlib.sha256(payload).hexdigest()


@app.command("suite")
def compile_suite(
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
    kind: str = typer.Option(
        "project",
        "--kind",
        help="Which surface the artifact lives on: project (default) or catalog.",
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
    out: Optional[Path] = typer.Option(
        None,
        "--out",
        help="Write the manifest's canonical bytes to this file (the bytes the digest covers).",
    ),
) -> None:
    """Compile a contract suite (POST /v1/tenants/{tenant}/contracts/{ref}/suite).

    Prints a summary, or the whole manifest with the global ``--json`` flag. Exits non-zero when
    the version yields no suite, or when the digest does not match the manifest's own bytes.
    """
    reference_kind = (kind or "project").strip().lower()
    if reference_kind not in _KINDS:
        raise typer.BadParameter("must be one of project, catalog", param_hint="--kind")

    options: dict[str, Any] = {
        "seed": seed,
        "include_declared_examples": examples,
        "include_generated": generated,
        "include_negative": negative,
    }
    if operation:
        options["operations"] = list(operation)
    if max_operations is not None:
        options["max_operations"] = max_operations

    client, tenant_slug = tenant_scoped_client(ctx)
    reference = f"{reference_kind}/{project}/{version}"
    payload = client.post(
        api_paths.contract_suite(tenant_slug, reference),
        json={"options": options},
        headers={"Accept": "application/json"},
    ).json()

    json_mode = json_mode_from_context(ctx)
    if not payload.get("ok"):
        error = payload.get("error") or {}
        if json_mode:
            emit_json(payload)
        else:
            code = error.get("code") or "ERROR"
            typer.echo(f"No contract suite could be compiled for {reference}.")
            typer.echo(f"  [{code}] {error.get('message') or ''}")
            if error.get("remediation"):
                typer.echo(f"  remediation: {error['remediation']}")
        raise typer.Exit(EXIT_ERROR)

    manifest = payload.get("manifest") or {}
    reported = str(manifest.get("digest") or "")
    recomputed = recompute_digest(manifest)

    # Checked before anything is written: a file that does not hash to its own digest is worse
    # than no file, because the next run would compare against it.
    if reported != recomputed:
        typer.echo(
            f"Digest mismatch: the server reported {reported or '(none)'} but these manifest "
            f"bytes hash to {recomputed}. The suite was altered in transit or the two sides "
            "disagree about its content.",
            err=True,
        )
        raise typer.Exit(EXIT_ERROR)

    if out is not None:
        out.write_text(canonical_manifest_text(manifest), encoding="utf-8")

    if json_mode:
        emit_json(payload)
    else:
        _emit_summary(manifest, reference=reference, out=out)


def _emit_summary(manifest: dict[str, Any], *, reference: str, out: Optional[Path]) -> None:
    """Print the human-readable summary of one compiled suite.

    :param manifest: The manifest as received from the API.
    :param reference: The reference that was compiled, for the heading.
    :param out: The file the canonical bytes were written to, when one was given.
    """
    counts = manifest.get("counts") or {}
    source = manifest.get("source") or {}
    api = manifest.get("api") or {}

    published = source.get("published")
    published_text = "published" if published else ("unpublished" if published is False else "publication state unknown")
    typer.echo(f"Contract suite for {reference} ({api.get('title') or api.get('name') or '?'}) — {published_text}")
    typer.echo(f"  digest: {manifest.get('digest')}")
    typer.echo(
        "  operations: {compiled} compiled, {skipped} not compiled".format(
            compiled=counts.get("operations_compiled", 0),
            skipped=counts.get("operations_skipped", 0),
        )
    )
    typer.echo(
        "  cases: {total} ({examples} declared, {negative} negative)".format(
            total=counts.get("cases", 0),
            examples=counts.get("declared_example", 0),
            negative=counts.get("negative_cases", 0),
        )
    )

    findings = list(manifest.get("findings") or [])
    if findings:
        typer.echo(f"  findings ({len(findings)}):")
        for finding in findings:
            scope = finding.get("operation_key") or "-"
            typer.echo(
                f"    [{finding.get('level')}] {finding.get('code')} {scope}: {finding.get('message')}"
            )

    if out is not None:
        typer.echo(f"  wrote {out}")
