"""REST calls behind ``apiome repository refresh`` and ``refresh status`` (RAR-5.6).

The command joins three committed REST surfaces — it invents no routes:

* ``POST /v1/tenants/{slug}/repositories/{id}/refresh`` — the RAR-5.2 one-shot
  manual refresh (spec-faithful, freshness-gated, divergence-safe).
* ``GET /v1/tenants/{slug}/repository-files`` — the REPO-6.4 spec catalog, filtered
  to one repository, to enumerate the imported file lineages.
* ``GET /v1/tenants/{slug}/repository-imports/{id}/spec?path=`` — the RAR-1.5 stored
  spec read, which materializes each lineage's refresh status (RAR-2.3).

``GET …/repositories/{id}/refresh-history`` (RAR-5.3) is polled alongside the status
reads so a recorded refresh cycle ends the wait immediately and its outcome can be
reported.

Pure logic (normalization, settle rules, rendering) lives in
:mod:`apiome_cli.repository_refresh_output`.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

import typer

from apiome_cli.client import api_paths
from apiome_cli.client.errors import exit_on_api_error
from apiome_cli.client.http import RestClient
from apiome_cli.client.list_response import fetch_list
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE
from apiome_cli.import_.jobs import DEFAULT_POLL_INTERVAL
from apiome_cli.progress import import_progress
from apiome_cli.repository_refresh_output import (
    LineageKey,
    format_refresh_progress,
    history_lineage_keys,
    is_imported_catalog_row,
    lineage_key,
    new_history_entries,
    normalize_status_row,
    unsettled_lineage_keys,
)

#: Default number of file lineages ``refresh status`` reads (``--limit`` overrides).
DEFAULT_STATUS_LIMIT = 50
#: Server-side maximum page size of the spec catalog.
MAX_STATUS_LIMIT = 500
#: How many refresh-history entries are sampled per poll.
_HISTORY_PAGE_LIMIT = 50
#: Page size used when listing repositories to resolve a name reference.
_REPOSITORY_LOOKUP_LIMIT = 200


def resolve_repository(
    client: RestClient,
    tenant_slug: str,
    repo_ref: str,
) -> dict[str, Any]:
    """Resolve ``REPO`` — a UUID or a repository name — to its repository record.

    The dashboard identifies repositories by UUID, but the CLI contract in the
    ticket is ``apiome repository refresh acme/api``. A UUID is fetched directly;
    anything else is matched case-insensitively against ``full_name`` first and then
    ``name`` across the tenant's repositories.

    Args:
        client: Tenant-scoped REST client (API key auth).
        tenant_slug: Tenant slug for the ``/v1`` path segments.
        repo_ref: Repository UUID, ``owner/name`` full name, or display name.

    Returns:
        The repository record.

    Raises:
        typer.Exit: Usage exit when the reference is blank, matches nothing, or is
            ambiguous across several repositories.
    """
    ref = repo_ref.strip()
    if not ref:
        typer.echo("Repository reference must not be empty.", err=True)
        raise typer.Exit(EXIT_USAGE)

    try:
        UUID(ref)
    except ValueError:
        pass
    else:
        payload = client.get(api_paths.tenant_repository(tenant_slug, ref)).json()
        record = _repository_record(payload)
        if record is None:
            typer.echo(f"Repository not found: {ref}", err=True)
            raise typer.Exit(EXIT_USAGE)
        return record

    items, _total = fetch_list(
        client,
        api_paths.tenant_repositories(tenant_slug),
        params=[("limit", str(_REPOSITORY_LOOKUP_LIMIT))],
    )
    needle = ref.casefold()
    for field in ("full_name", "name"):
        matches = [
            item
            for item in items
            if isinstance(item.get(field), str) and item[field].strip().casefold() == needle
        ]
        if len(matches) == 1:
            record = matches[0]
            if not str(record.get("id") or "").strip():
                typer.echo(
                    f"Repository {ref!r} was listed without an id; pass the "
                    "repository UUID instead.",
                    err=True,
                )
                raise typer.Exit(EXIT_USAGE)
            return record
        if len(matches) > 1:
            ids = ", ".join(str(item.get("id")) for item in matches)
            typer.echo(
                f"Repository reference {ref!r} matches {len(matches)} repositories "
                f"({ids}); pass the repository UUID instead.",
                err=True,
            )
            raise typer.Exit(EXIT_USAGE)

    typer.echo(
        f"Repository not found: {ref}. Run 'apiome repos list' to see the "
        "repositories in this tenant.",
        err=True,
    )
    raise typer.Exit(EXIT_USAGE)


def _repository_record(payload: Any) -> dict[str, Any] | None:
    """Unwrap a repository record from a ``{repository: …}`` envelope or a bare body."""
    if not isinstance(payload, dict):
        return None
    nested = payload.get("repository")
    if isinstance(nested, dict):
        return nested
    if payload.get("id"):
        return payload
    return None


def fetch_status_rows(
    client: RestClient,
    tenant_slug: str,
    repository_id: str,
    *,
    path: str | None = None,
    branch: str | None = None,
    all_branches: bool = False,
    limit: int = DEFAULT_STATUS_LIMIT,
) -> tuple[list[dict[str, Any]], int]:
    """Read per-file refresh state for a repository.

    Enumerates the repository's imported file lineages from the spec catalog and
    reads each one's stored import spec, whose ``refresh_status`` is the RAR-2.3
    materialized state.

    Args:
        client: Tenant-scoped REST client.
        tenant_slug: Tenant slug for the ``/v1`` path segments.
        repository_id: Repository UUID.
        path: Optional exact repository-relative file path filter.
        branch: Optional branch filter (implies ``all_branches``).
        all_branches: Include lineages on non-default branches.
        limit: Maximum number of lineages to read (1..500).

    Returns:
        ``(rows, match_count)`` — the normalized status rows and the catalog's total
        match count, so the caller can report a truncated page.
    """
    page_limit = max(1, min(int(limit), MAX_STATUS_LIMIT))
    params: list[tuple[str, str]] = [
        ("repository_id", str(repository_id)),
        ("importable_only", "true"),
        ("sort", "path"),
        ("limit", str(page_limit)),
        ("offset", "0"),
    ]
    if all_branches or branch:
        params.append(("all_branches", "true"))

    catalog_path = f"{api_paths.tenant_repository_spec_catalog(tenant_slug)}?{urlencode(params)}"
    payload = client.get(catalog_path).json()
    specs = payload.get("specs") if isinstance(payload, dict) else None
    catalog_rows = [row for row in specs if isinstance(row, dict)] if isinstance(specs, list) else []
    match_count = (
        int(payload.get("match_count", len(catalog_rows)))
        if isinstance(payload, dict)
        else len(catalog_rows)
    )

    wanted_path = path.strip() if isinstance(path, str) and path.strip() else None
    wanted_branch = branch.strip() if isinstance(branch, str) and branch.strip() else None

    rows: list[dict[str, Any]] = []
    for catalog_row in catalog_rows:
        row_branch, row_path = lineage_key(catalog_row)
        if wanted_path is not None and row_path != wanted_path:
            continue
        if wanted_branch is not None and row_branch != wanted_branch:
            continue
        if not is_imported_catalog_row(catalog_row):
            continue
        spec = _read_import_spec(
            client,
            tenant_slug,
            repository_id,
            path=row_path,
            branch=row_branch or None,
        )
        rows.append(normalize_status_row(catalog_row, spec))
    return rows, match_count


def _read_import_spec(
    client: RestClient,
    tenant_slug: str,
    repository_id: str,
    *,
    path: str,
    branch: str | None,
) -> dict[str, Any] | None:
    """Read one lineage's stored import spec (RAR-1.5), or ``None`` when absent.

    A 404 is expected for a catalog row whose spec row was never written (an import
    that predates spec capture and was not backfilled), so it degrades to an
    ``unknown`` status rather than failing the whole listing.
    """
    query: list[tuple[str, str]] = [("path", path)]
    if branch:
        query.append(("branch", branch))
    spec_path = (
        f"{api_paths.tenant_repository_import_spec(tenant_slug, repository_id)}"
        f"?{urlencode(query)}"
    )
    response = client.get_raw(spec_path)
    if response.status_code == 404:
        return None
    exit_on_api_error(response)
    body = response.json()
    return body if isinstance(body, dict) else None


def trigger_refresh(
    client: RestClient,
    tenant_slug: str,
    repository_id: str,
    *,
    path: str | None = None,
    branch: str | None = None,
) -> dict[str, Any]:
    """Trigger the RAR-5.2 one-shot manual refresh.

    Args:
        client: Tenant-scoped REST client.
        tenant_slug: Tenant slug for the ``/v1`` path segments.
        repository_id: Repository UUID.
        path: Optional single file to refresh.
        branch: Optional branch scope.

    Returns:
        The response body (``enqueued`` / ``skipped`` / ``branches``).
    """
    body: dict[str, str] = {}
    if isinstance(path, str) and path.strip():
        body["path"] = path.strip()
    if isinstance(branch, str) and branch.strip():
        body["branch"] = branch.strip()

    response = client.post(
        api_paths.tenant_repository_refresh(tenant_slug, repository_id),
        json=body,
    )
    payload = response.json()
    if not isinstance(payload, dict):
        typer.echo("Refresh response was not a JSON object.", err=True)
        raise typer.Exit(EXIT_ERROR)
    return payload


def fetch_refresh_history(
    client: RestClient,
    tenant_slug: str,
    repository_id: str,
    *,
    path: str | None = None,
    limit: int = _HISTORY_PAGE_LIMIT,
) -> list[dict[str, Any]]:
    """Read the newest refresh-cycle audit entries for a repository (RAR-5.3).

    Args:
        client: Tenant-scoped REST client.
        tenant_slug: Tenant slug for the ``/v1`` path segments.
        repository_id: Repository UUID.
        path: Optional file path for per-file history.
        limit: Page size (newest first).

    Returns:
        The entries, newest first (empty when no cycles have been recorded).
    """
    params: list[tuple[str, str]] = [("limit", str(limit)), ("offset", "0")]
    if isinstance(path, str) and path.strip():
        params.append(("path", path.strip()))
    history_path = (
        f"{api_paths.tenant_repository_refresh_history(tenant_slug, repository_id)}"
        f"?{urlencode(params)}"
    )
    payload = client.get(history_path).json()
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def history_entry_ids(entries: Sequence[dict[str, Any]]) -> set[str]:
    """Return the ids of refresh-history entries, for a before/after comparison."""
    return {
        str(entry["id"])
        for entry in entries
        if isinstance(entry.get("id"), str) and entry["id"].strip()
    }


def wait_for_refresh(
    client: RestClient,
    tenant_slug: str,
    repository_id: str,
    *,
    targets: Sequence[LineageKey],
    baseline_history_ids: set[str],
    path: str | None = None,
    branch: str | None = None,
    all_branches: bool = False,
    limit: int = DEFAULT_STATUS_LIMIT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
    timeout: float = 120.0,
    no_progress: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Poll until every targeted lineage has finished refreshing.

    A target is done when its RAR-2.3 status leaves ``stale`` / ``refreshing`` — the
    import anchors moved forward, the divergence guard held it, or the attempt
    failed — or when a refresh cycle for it is recorded in the RAR-5.3 history.

    Args:
        client: Tenant-scoped REST client.
        tenant_slug: Tenant slug for the ``/v1`` path segments.
        repository_id: Repository UUID.
        targets: Lineage keys the refresh was expected to act on.
        baseline_history_ids: Refresh-history entry ids observed before triggering.
        path: Optional path filter used for the status reads.
        branch: Optional branch filter used for the status reads.
        all_branches: Whether non-default branches are in scope.
        limit: Maximum lineages read per poll.
        poll_interval: Seconds between polls.
        timeout: Maximum wall-clock seconds to wait.
        no_progress: When True, suppress the stderr spinner.
        sleep: Injectable sleep (tests).
        monotonic: Injectable monotonic clock (tests).

    Returns:
        ``(rows, new_history_entries)`` — the final status rows for the repository
        and the refresh cycles recorded during the wait.

    Raises:
        typer.Exit: ``EXIT_ERROR`` when the wait exceeds ``timeout``.
    """
    deadline = monotonic() + timeout
    target_keys = list(targets)

    with import_progress(enabled=not no_progress, initial_message="Refreshing…") as status:
        while True:
            rows, _match_count = fetch_status_rows(
                client,
                tenant_slug,
                repository_id,
                path=path,
                branch=branch,
                all_branches=all_branches,
                limit=limit,
            )
            entries = fetch_refresh_history(client, tenant_slug, repository_id, path=path)
            fresh = new_history_entries(entries, baseline_history_ids)
            unsettled = unsettled_lineage_keys(
                rows,
                target_keys,
                completed=history_lineage_keys(fresh),
            )
            if not unsettled:
                return rows, [dict(entry) for entry in fresh]

            remaining = deadline - monotonic()
            if remaining <= 0:
                seconds = int(timeout)
                unit = "second" if seconds == 1 else "seconds"
                typer.echo(
                    f"Refresh did not complete within {seconds} {unit} "
                    f"({len(unsettled)} of {len(target_keys)} file(s) still refreshing).",
                    err=True,
                )
                raise typer.Exit(EXIT_ERROR)

            if status is not None:
                status.update(
                    format_refresh_progress(
                        pending=len(unsettled),
                        total=len(target_keys),
                        elapsed_seconds=timeout - remaining,
                    )
                )
            sleep(min(poll_interval, remaining))
