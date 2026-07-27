"""Bulk-import HTTP client (MFI-29.5).

Three thin helpers over the bulk endpoints — plan, submit, status — plus the request
bodies they take. The batch is stateless server-side, so the caller holds the
``(key, job_id)`` pairs the submit returned and polls them with :func:`fetch_bulk_status`.
"""

from __future__ import annotations

import base64
from typing import Any

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient


def build_bulk_source_body(
    *,
    document_bytes: bytes | None = None,
    filename: str | None = None,
    repo_url: str | None = None,
    ref: str | None = None,
    path: str | None = None,
    repository_id: str | None = None,
    linked_account_id: str | None = None,
) -> dict[str, Any]:
    """Build the source half of a bulk request: an archive **or** a repository selection.

    The request models forbid extra fields and require exactly one source, so unset
    options are omitted rather than sent as ``null``.

    Args:
        document_bytes: Archive bytes (``.zip`` / ``.tar.gz``), when importing an upload.
        filename: Archive filename, used as the payload's label in messages.
        repo_url: Repository URL, when importing a repository selection.
        ref: Branch, tag, or commit sha for the selection.
        path: Path or glob narrowing the selection.
        repository_id: Registered tenant repository authorizing a private read.
        linked_account_id: The caller's linked account authorizing a private read.

    Returns:
        The source fields of a ``BulkImportPlanRequest`` / ``BulkImportStartRequest``.

    Raises:
        ValueError: When neither or both sources are supplied.
    """
    if bool(document_bytes) == bool(repo_url):
        raise ValueError("Bulk import needs exactly one of an archive or a repository URL.")

    if document_bytes:
        body: dict[str, Any] = {
            "document_base64": base64.b64encode(document_bytes).decode("ascii")
        }
        if filename:
            body["filename"] = filename
        return body

    git: dict[str, Any] = {"repo_url": repo_url}
    for key, value in (
        ("ref", ref),
        ("path", path),
        ("repository_id", repository_id),
        ("linked_account_id", linked_account_id),
    ):
        if value is not None and str(value).strip():
            git[key] = value
    return {"git": git}


def fetch_bulk_plan(
    client: RestClient, tenant_slug: str, body: dict[str, Any]
) -> dict[str, Any]:
    """POST a payload and return its plan — one row per independent spec.

    Args:
        client: Authenticated REST client (API key + tenant scope).
        tenant_slug: The tenant URL slug.
        body: A body from :func:`build_bulk_source_body`.

    Returns:
        The parsed ``BulkImportPlanResponse``.
    """
    return client.post(api_paths.import_bulk_plan(tenant_slug), json=body).json()


def start_bulk_import(
    client: RestClient, tenant_slug: str, body: dict[str, Any]
) -> dict[str, Any]:
    """POST a payload and start one import job per selected item.

    Args:
        client: Authenticated REST client.
        tenant_slug: The tenant URL slug.
        body: A source body plus optional ``keys`` and ``dry_run``.

    Returns:
        The parsed ``BulkImportStartResponse`` — per-item ``accepted`` / ``failed`` rows.
    """
    return client.post(api_paths.import_bulk(tenant_slug), json=body).json()


def fetch_bulk_status(
    client: RestClient, tenant_slug: str, items: list[dict[str, str]]
) -> dict[str, Any]:
    """Roll up a batch's jobs into a per-item result list.

    Args:
        client: Authenticated REST client.
        tenant_slug: The tenant URL slug.
        items: ``[{"key": …, "job_id": …}]`` from the submit response.

    Returns:
        The parsed ``BulkImportStatusResponse``.
    """
    return client.post(
        api_paths.import_bulk_status(tenant_slug), json={"items": items}
    ).json()
