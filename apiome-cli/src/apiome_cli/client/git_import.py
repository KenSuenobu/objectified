"""Git-repository intake HTTP client (MFI-29.3).

One helper over ``POST /v1/tenants/{tenant}/import/git/fileset``: hand it a repository
selection (URL + ref + path/glob) and it returns the selected files packed as an
archive, the resolved root document, the detected format, and the commit provenance.

The returned bytes are the *same* payload an archive upload produces, so the caller
runs the unchanged import path afterwards — pre-flight, quality gate, then
``POST …/imports`` — with ``options.git_source`` echoing the provenance back.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

from apiome_cli.client import api_paths
from apiome_cli.client.http import RestClient


def build_git_fileset_body(
    repo_url: str,
    *,
    ref: str | None = None,
    path: str | None = None,
    root: str | None = None,
    repository_id: str | None = None,
    linked_account_id: str | None = None,
    include_document: bool = True,
) -> dict[str, Any]:
    """Build the ``GitFilesetRequest`` body for a repository selection.

    The request model forbids extra fields, so unset options are omitted rather than
    sent as ``null``.

    Args:
        repo_url: Repository URL (``https://github.com/owner/repo``).
        ref: Branch, tag, or commit sha; ``None`` uses the default branch.
        path: Directory, exact file, or glob selecting what to import.
        root: Explicit root document inside the selection, when detection is ambiguous.
        repository_id: Registered tenant repository whose stored credential authorizes
            a private read.
        linked_account_id: The caller's own linked account, for a private read.
        include_document: Ask for the packed archive bytes (``False`` previews only).

    Returns:
        A JSON body for ``POST /v1/tenants/{tenant_slug}/import/git/fileset``.
    """
    body: dict[str, Any] = {"repo_url": repo_url}
    optional = {
        "ref": ref,
        "path": path,
        "root": root,
        "repository_id": repository_id,
        "linked_account_id": linked_account_id,
    }
    for key, value in optional.items():
        if value is not None and str(value).strip():
            body[key] = value
    if not include_document:
        body["include_document"] = False
    return body


def fetch_git_fileset(
    client: RestClient,
    tenant_slug: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """POST a repository selection and return the parsed ``GitFilesetResponse``.

    Args:
        client: Authenticated REST client (API key + tenant scope).
        tenant_slug: The tenant URL slug.
        body: A body from :func:`build_git_fileset_body`.

    Returns:
        The parsed response: ``git_source``, ``document_base64``, ``archive_root``,
        ``members``, ``skipped``, ``source_kind``, and the detection verdict.
    """
    return client.post(api_paths.import_git_fileset(tenant_slug), json=body).json()


def decode_git_document(response: dict[str, Any]) -> bytes:
    """Decode the packed archive bytes out of a git fileset response.

    Args:
        response: A parsed ``GitFilesetResponse``.

    Returns:
        The archive bytes to import.

    Raises:
        ValueError: When the response carries no document (a preview-only request) or
            its base64 is malformed.
    """
    document = response.get("document_base64")
    if not isinstance(document, str) or not document:
        raise ValueError("The git fileset response carried no document to import.")
    try:
        return base64.b64decode(document, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"The git fileset response was not valid base64: {exc}") from exc
