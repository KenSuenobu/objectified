"""Import-source registry client and generic adapter-import helpers (MFI-1.4).

The CLI's per-format verbs (``import openapi``/``arazzo``/``json-schema``…) are
hard-coded. MFI-1.4 adds a registry-driven seam so a format registered server-side
(MFI-1.1's ``ImportSource`` registry, exposed at ``GET /v1/import/sources``) is
invokable from the CLI with **no new command code**:

* ``apiome import --list`` enumerates the registered adapters.
* ``apiome import <format> <input>`` resolves ``<format>`` against the registry
  and submits the document through the existing async spec-import job, reusing the
  same poll loop and result/summary output as the dedicated verbs.

This module owns the registry fetch, the format lookup, the generic request body,
and the preview-summary formatter. The Typer wiring lives in
``commands/import_.py``.
"""

from __future__ import annotations

import base64
from typing import Any

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient
from apiome_cli.extract.slug import slugify_project_name
from apiome_cli.output import ListColumn, emit_json, emit_list_table, join_list


def fetch_import_source_descriptors(client: RestClient) -> list[dict[str, Any]]:
    """Return the registered import-source descriptors (``GET /v1/import/sources``).

    Each descriptor is the registry's public view of an adapter — ``key``,
    ``label``, ``description``, ``icon``, ``paradigm``, ``input_kinds``,
    ``supports_live_discovery``, and emitted ``formats``. The list is sorted by
    key server-side. Returns an empty list when the response shape is unexpected.
    """
    payload = client.get(api_paths.import_sources()).json()
    if not isinstance(payload, dict):
        return []
    sources = payload.get("sources")
    if not isinstance(sources, list):
        return []
    return [item for item in sources if isinstance(item, dict)]


def source_keys(descriptors: list[dict[str, Any]]) -> list[str]:
    """Return the registry keys from *descriptors*, preserving order."""
    keys: list[str] = []
    for item in descriptors:
        key = item.get("key")
        if isinstance(key, str) and key:
            keys.append(key)
    return keys


def find_source(
    descriptors: list[dict[str, Any]],
    key: str,
) -> dict[str, Any] | None:
    """Return the descriptor whose ``key`` matches *key* (exact), or ``None``."""
    for item in descriptors:
        if item.get("key") == key:
            return item
    return None


def unknown_format_message(requested: str, descriptors: list[dict[str, Any]]) -> str:
    """Build an actionable error when ``<format>`` is not a registered source."""
    keys = source_keys(descriptors)
    available = ", ".join(sorted(keys)) if keys else "(none registered)"
    return (
        f"Unknown import format {requested!r}. "
        f"Available formats: {available}. "
        "Run `apiome import --list` to see every registered source."
    )


def build_adapter_import_body(
    document_bytes: bytes,
    *,
    source_format: str,
    source_label: str | None,
    dry_run: bool,
    content_type: str | None = None,
    archive_root: str | None = None,
    input_kind: str | None = None,
    git_source: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the ``SpecImportStartJsonRequest`` body for a generic adapter import.

    The registry-driven path carries no format-specific identity flags (those stay
    on the dedicated verbs), so the project/version targets the request model
    requires are derived from the source filename and a default version. The
    in-process adapter pipeline is preview-only and keys identity off the
    normalized model rather than this metadata, so these are sensible placeholders
    that keep the request valid without inventing format-specific behaviour.

    Args:
        document_bytes: Raw source bytes, sent verbatim (base64) so non-JSON/YAML
            formats — GraphQL SDL, protobuf, Avro — survive the round trip.
        source_format: The registry key resolved from ``<format>`` (``source_kind``).
        source_label: Filename hint for the project name and sniffing (``None`` for stdin).
        dry_run: Validate/preview without persisting.
        content_type: Optional MIME hint forwarded to the importer.
        archive_root: Root document inside an archive payload (MFI-29.1).
        input_kind: How the source reached the importer (``file`` / ``url`` /
            ``paste`` / ``fileset``); recorded on the created revision.
        git_source: Repository provenance for a git-sourced import (MFI-29.3),
            echoed verbatim from the git fileset response.

    Returns:
        A JSON body for ``POST /v1/tenants/{tenant_slug}/imports``.
    """
    name = _project_name_from_label(source_label, source_format)
    options: dict[str, Any] = {"dry_run": dry_run}
    if archive_root:
        options["archive_root"] = archive_root
    if input_kind:
        options["input_kind"] = input_kind
    if git_source:
        options["git_source"] = git_source
    body: dict[str, Any] = {
        "metadata": {
            "source_kind": source_format,
            "project": {"name": name, "slug": slugify_project_name(name)},
            "version": {"version_id": "0.0.0"},
            "options": options,
        },
        "document_base64": base64.b64encode(document_bytes).decode("ascii"),
    }
    if source_label:
        body["filename"] = source_label
    if content_type:
        body["content_type"] = content_type
    return body


def _project_name_from_label(source_label: str | None, source_format: str) -> str:
    """Derive a project name from the source filename, falling back to the format."""
    if source_label:
        stem = source_label.rsplit("/", 1)[-1]
        stem = stem.rsplit(".", 1)[0] if "." in stem else stem
        stem = stem.strip()
        if stem:
            return stem
    return f"{source_format}-import"


_SOURCE_LIST_COLUMNS: tuple[ListColumn, ...] = (
    ("Format", "key", None),
    ("Label", "label", None),
    ("Paradigm", "paradigm", None),
    ("Inputs", "input_kinds", join_list),
    ("Live", "supports_live_discovery", lambda value: "yes" if value else ""),
    ("Description", "description", None),
)


def emit_import_sources(
    descriptors: list[dict[str, Any]],
    *,
    json_mode: bool,
) -> None:
    """Print the registered import sources as a table (or raw JSON)."""
    if json_mode:
        emit_json({"sources": descriptors})
        return
    emit_list_table(
        descriptors,
        _SOURCE_LIST_COLUMNS,
        empty_message="No import sources are registered.",
    )


def emit_adapter_import_summary(
    payload: dict[str, Any],
    *,
    json_mode: bool,
    dry_run: bool,
    elapsed_seconds: float | None = None,
) -> None:
    """Print the preview summary returned by a generic adapter import.

    The in-process adapter pipeline returns a preview summary (source/paradigm/
    format, revision fingerprint, canonical entity counts, and the rolled-up lint
    score) rather than a persisted ``ImportResult``, so it gets its own formatter
    instead of the OpenAPI-shaped :func:`output.emit_import_result`.
    """
    if json_mode:
        emit_json(payload)
        return

    if dry_run:
        typer.echo("Dry run completed (no changes written).")
    else:
        typer.echo("Import preview completed.")

    source = payload.get("source")
    paradigm = payload.get("paradigm")
    fmt = payload.get("format")
    if isinstance(source, str) and source:
        descriptor = f"{source}"
        if isinstance(fmt, str) and fmt:
            descriptor += f" ({fmt})"
        typer.echo(f"  Source: {descriptor}")
    if isinstance(paradigm, str) and paradigm:
        typer.echo(f"  Paradigm: {paradigm}")

    fingerprint = payload.get("fingerprint")
    if isinstance(fingerprint, str) and fingerprint:
        typer.echo(f"  Fingerprint: {fingerprint}")

    counts = payload.get("counts")
    if isinstance(counts, dict) and counts:
        rendered = ", ".join(
            f"{label}: {counts[key]}"
            for label, key in (
                ("services", "services"),
                ("operations", "operations"),
                ("types", "types"),
                ("channels", "channels"),
            )
            if isinstance(counts.get(key), int)
        )
        if rendered:
            typer.echo(f"  Entities — {rendered}")

    lint = payload.get("lint")
    if isinstance(lint, dict):
        score = lint.get("score")
        grade = lint.get("grade")
        findings = lint.get("findings")
        if score is not None or grade is not None:
            grade_label = f" ({grade})" if isinstance(grade, str) and grade else ""
            typer.echo(f"  Lint score: {score}{grade_label}")
        if isinstance(findings, int):
            typer.echo(f"  Lint findings: {findings}")

    if payload.get("persisted") is False:
        typer.echo("  Note: preview only — no catalog version was written.")

    if elapsed_seconds is not None:
        typer.echo(f"  Elapsed: {elapsed_seconds:.1f}s")
