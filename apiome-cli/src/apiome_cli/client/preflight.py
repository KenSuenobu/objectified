"""Pre-flight HTTP client: import candidate scoring and export target ranking (IXH-2.6).

Thin helpers over the two pre-flight endpoints apiome-rest exposes:

* ``POST /v1/tenants/{tenant}/import/preflight`` (IXH-2.1) — score a candidate document
  through the real import pipeline with dry-run semantics; nothing is persisted.
* ``POST /v1/tenants/{tenant}/export/preflight`` (IXH-2.4) — lint one source revision and
  rank every export target by readiness; nothing is emitted.

Both return a 200 with a full report even when the answer is "do not do this" — a broken
candidate is a *successful* pre-flight — so these helpers never translate a verdict into an
error. Verdict handling lives in :mod:`apiome_cli.preflight`; presentation lives there too.
These functions only build the request body and hand back the parsed report.
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from typing import Any

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient


def build_import_preflight_body(
    document_bytes: bytes,
    *,
    source_kind: str | None = None,
    filename: str | None = None,
    content_type: str | None = None,
    url: str | None = None,
    input_kind: str | None = None,
    import_target: str | None = None,
    archive_root: str | None = None,
) -> dict[str, Any]:
    """Build the ``ImportPreflightRequest`` body for a candidate document.

    The request model forbids extra fields, so every optional hint is omitted rather than
    sent as ``null`` when the caller has none.

    Args:
        document_bytes: Raw candidate bytes, sent verbatim as standard base64 so non-text
            formats (protobuf descriptors, archives) survive the round trip.
        source_kind: Explicit adapter/registry key to score against; ``None`` auto-detects.
        filename: Original filename, used as a sniffing hint when bytes are ambiguous.
        content_type: MIME hint (``application/yaml``…), when known.
        url: Source URL the document was fetched from, when the intake kind is ``url``.
        input_kind: How the document reached the CLI (``file`` / ``url`` / ``paste`` /
            ``discovery`` / ``fileset``).
        import_target: Destination a commit would request (``catalog`` / ``types`` /
            ``project``); consulted only for JSON Schema, exactly as on the import job.
        archive_root: Module-relative root document inside an uploaded archive.

    Returns:
        A JSON body for ``POST /v1/tenants/{tenant_slug}/import/preflight``.
    """
    body: dict[str, Any] = {
        "document_base64": base64.b64encode(document_bytes).decode("ascii"),
    }
    optional = {
        "source_kind": source_kind,
        "filename": filename,
        "content_type": content_type,
        "url": url,
        "input_kind": input_kind,
        "import_target": import_target,
        "archive_root": archive_root,
    }
    for key, value in optional.items():
        if value is not None and str(value).strip():
            body[key] = value
    return body


def fetch_import_preflight(
    client: RestClient,
    tenant_slug: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """POST a candidate document and return the parsed ``ImportPreflightReport``.

    Args:
        client: Authenticated REST client (API key + tenant scope).
        tenant_slug: The tenant URL slug.
        body: A body from :func:`build_import_preflight_body`.

    Returns:
        The parsed report. ``ok`` is ``False`` (not an HTTP error) when the candidate
        cannot be imported; ``error`` then carries the intake-taxonomy code.
    """
    return client.post(api_paths.import_preflight(tenant_slug), json=body).json()


def fetch_export_preflight(
    client: RestClient,
    tenant_slug: str,
    *,
    artifact: str,
    version: str | None = None,
    targets: Sequence[str] | None = None,
    include_findings: bool = True,
) -> dict[str, Any]:
    """POST source coordinates and return the parsed ``ExportPreflightReport``.

    Args:
        client: Authenticated REST client (API key + tenant scope).
        tenant_slug: The tenant URL slug.
        artifact: The artifact (project) id to rank targets for.
        version: Revision UUID / version label, or ``None`` for the latest revision.
        targets: Restrict the ranking to these target keys or format keys; ``None`` ranks
            every registered target. Unknown entries are ignored server-side.
        include_findings: When ``False``, the source lint verdict comes back without its
            ranked finding list (score, grade, and tallies are always present).

    Returns:
        The parsed report: the source lint verdict plus every ranked target.
    """
    body: dict[str, Any] = {"artifact": artifact}
    if version is not None and version.strip():
        body["version"] = version
    if targets:
        body["targets"] = list(targets)
    if not include_findings:
        body["include_findings"] = False
    return client.post(api_paths.export_preflight(tenant_slug), json=body).json()
