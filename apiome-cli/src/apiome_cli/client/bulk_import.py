"""Bulk-import HTTP client (MFI-29.5, BLK-1.3).

Three thin helpers over the bulk endpoints — plan, submit, status — plus the request
bodies they take. The batch is stateless server-side, so the caller holds the
``(key, job_id)`` pairs the submit returned and polls them with :func:`fetch_bulk_status`.

The submit body carries the apply half of verify-then-apply (BLK-1.3): the per-item
``overrides`` a reviewer disagreed with the plan on, and the ``plan_fingerprint`` that makes
the server refuse a plan which drifted since it was read. That refusal is the one HTTP error
this module does not let the generic handler swallow — it carries a per-item drift list the
user needs to see, so it surfaces as :class:`BulkPlanStale`.
"""

from __future__ import annotations

import base64
from typing import Any

from apiome_cli.client import api_paths
from apiome_cli.client.errors import exit_on_api_error
from apiome_cli.client.http import RestClient

#: Taxonomy code the server refuses a stale plan with.
TARGET_PLAN_STALE = "TARGET_PLAN_STALE"


class BulkPlanStale(Exception):
    """The plan this batch was applied from no longer describes what it would do.

    Attributes:
        message: The server's summary of the refusal.
        drift: One row per item that moved — ``key``, ``change``, ``reviewed``, ``current``
            and a ``detail`` sentence.
    """

    def __init__(self, message: str, drift: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.message = message
        self.drift = drift


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


def build_bulk_apply_body(
    source: dict[str, Any],
    *,
    keys: list[str] | None = None,
    overrides: list[dict[str, Any]] | None = None,
    plan_fingerprint: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Build the submit body: what to import, where each item goes, and against which plan.

    Unset options are omitted rather than sent as ``null``, because the request model forbids
    extra fields and treats an absent override as "apply what the plan resolved".

    Args:
        source: A body from :func:`build_bulk_source_body`.
        keys: Item keys to import; omitted imports every planned item.
        overrides: Per-item decisions (BLK-1.3), each ``{"key": …}`` plus any of ``mode`` /
            ``project_id`` / ``version_id``.
        plan_fingerprint: The reviewed plan's fingerprint, so the server refuses to apply a
            plan that has drifted since.
        dry_run: Verify instead of apply.

    Returns:
        The ``BulkImportStartRequest`` body.
    """
    body: dict[str, Any] = {**source, "dry_run": dry_run}
    if keys:
        body["keys"] = list(keys)
    if overrides:
        body["overrides"] = list(overrides)
    if plan_fingerprint:
        body["plan_fingerprint"] = plan_fingerprint
    return body


def start_bulk_import(
    client: RestClient, tenant_slug: str, body: dict[str, Any]
) -> dict[str, Any]:
    """POST a payload and start one import job per selected item.

    Args:
        client: Authenticated REST client.
        tenant_slug: The tenant URL slug.
        body: A body from :func:`build_bulk_apply_body`.

    Returns:
        The parsed ``BulkImportStartResponse`` — per-item ``accepted`` / ``failed`` rows.

    Raises:
        BulkPlanStale: The plan drifted since it was reviewed and nothing was imported. Every
            other HTTP failure exits through the shared handler, unchanged.
    """
    response = client.post_raw(api_paths.import_bulk(tenant_slug), json=body)
    if response.status_code == 409:
        stale = _stale_plan(response)
        if stale is not None:
            raise stale
    exit_on_api_error(response)
    return response.json()


def _stale_plan(response: Any) -> BulkPlanStale | None:
    """Read a 409 as a stale-plan refusal, or ``None`` when it is some other conflict."""
    try:
        detail = (response.json() or {}).get("detail")
    except ValueError:
        return None
    if not isinstance(detail, dict) or detail.get("code") != TARGET_PLAN_STALE:
        return None
    drift = detail.get("drift")
    return BulkPlanStale(
        str(detail.get("message") or "The plan you reviewed is stale."),
        [row for row in drift or [] if isinstance(row, dict)],
    )


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
