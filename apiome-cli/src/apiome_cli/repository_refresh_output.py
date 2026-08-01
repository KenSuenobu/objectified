"""Pure helpers and rendering for ``apiome repository refresh`` (RAR-5.6).

No HTTP lives here: this module normalizes the two REST reads the command joins
(the REPO-6.4 spec catalog row and the RAR-1.5 stored-spec read), decides when a
triggered refresh has settled, and renders the human tables. Keeping it free of
``RestClient`` makes every rule unit-testable without a mock server.

Refresh states are the RAR-2.3 wire codes (``up-to-date`` / ``stale`` /
``refreshing`` / ``failed`` / ``diverged``); ``unknown`` is this module's own
placeholder for a lineage whose stored spec could not be read.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import typer

from apiome_cli.output import ListColumn, emit_json, emit_list_table

#: RAR-2.3 status meaning "the source moved on; a refresh would re-import".
STATUS_STALE = "stale"
#: RAR-2.3 status meaning "a refresh is in flight for this lineage".
STATUS_REFRESHING = "refreshing"
#: RAR-2.3 status meaning "the last refresh attempt errored".
STATUS_FAILED = "failed"
#: RAR-2.3 status meaning "the imported version was hand-edited; held for review".
STATUS_DIVERGED = "diverged"
#: RAR-2.3 status meaning "the import reflects the current source commit".
STATUS_UP_TO_DATE = "up-to-date"
#: Local placeholder for a lineage whose stored spec could not be read.
STATUS_UNKNOWN = "unknown"

#: Statuses that mean a refresh for this lineage is still outstanding.
_PENDING_STATUSES = frozenset({STATUS_STALE, STATUS_REFRESHING})

#: Terminal refresh-cycle outcomes (RAR-5.3) that make the command exit non-zero.
_FAILURE_OUTCOMES = frozenset({"failed"})

#: A lineage key is the ``(branch, path)`` pair that identifies one imported file.
LineageKey = tuple[str, str]


def lineage_key(row: Mapping[str, Any]) -> LineageKey:
    """Return the ``(branch, path)`` identity of a catalog, status, or history row.

    Args:
        row: Any mapping carrying ``branch`` / ``path`` keys.

    Returns:
        The lineage key with both parts coerced to (possibly empty) strings.
    """
    branch = row.get("branch")
    path = row.get("path")
    return (
        str(branch).strip() if isinstance(branch, str) else "",
        str(path).strip() if isinstance(path, str) else "",
    )


def is_imported_catalog_row(row: Mapping[str, Any]) -> bool:
    """Report whether a spec-catalog row has an import lineage (so it can refresh).

    Only files that were actually imported have a stored import spec (RAR-1.2), and
    only those can be refreshed. The catalog's derived ``status`` is not used for
    this test because ``needs_attention`` outranks ``imported`` in its precedence
    order and would hide imported-but-flagged files.

    Args:
        row: One REPO-6.4 spec-catalog row.

    Returns:
        True when the row records a completed import (a version or an import time).
    """
    for key in ("version_id", "last_imported_at"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


def normalize_status_row(
    catalog_row: Mapping[str, Any],
    spec: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Join a catalog row and its stored import spec into one status row.

    Args:
        catalog_row: One REPO-6.4 spec-catalog row (repository, branch, path,
            project and version context).
        spec: The RAR-1.5 ``GET …/repository-imports/{id}/spec`` body for the same
            lineage, or ``None`` when no spec could be read (a file imported before
            spec capture whose row has since gone, or a cross-tenant 404).

    Returns:
        A flat, JSON-serializable status row combining both reads.
    """
    branch, path = lineage_key(catalog_row)
    spec_body = spec if isinstance(spec, Mapping) else {}
    status = spec_body.get("refresh_status")
    return {
        "path": path,
        "branch": branch,
        "refresh_status": (
            str(status) if isinstance(status, str) and status.strip() else STATUS_UNKNOWN
        ),
        "source_kind": _optional_str(spec_body.get("source_kind")),
        "format": _optional_str(catalog_row.get("format")),
        "project_slug": _optional_str(catalog_row.get("project_slug")),
        "project_name": _optional_str(catalog_row.get("project_name")),
        "version_id": _optional_str(catalog_row.get("version_id")),
        "last_imported_at": _optional_str(catalog_row.get("last_imported_at")),
        "last_imported_commit_sha": _optional_str(
            spec_body.get("last_imported_commit_sha")
        ),
        "backfilled": bool(spec_body.get("backfilled", False)),
        "file_id": _optional_str(catalog_row.get("id")),
    }


def _optional_str(value: Any) -> str | None:
    """Return a trimmed string, or ``None`` for missing/blank/non-string values."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def summarize_statuses(rows: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Count status rows per refresh state.

    Args:
        rows: Normalized status rows.

    Returns:
        A ``{status: count}`` mapping ordered by descending count, then status.
    """
    counts: dict[str, int] = {}
    for row in rows:
        status = str(row.get("refresh_status") or STATUS_UNKNOWN)
        counts[status] = counts.get(status, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def pending_lineage_keys(rows: Sequence[Mapping[str, Any]]) -> list[LineageKey]:
    """Return the lineages a refresh would still have work to do on.

    A lineage is pending when it is ``stale`` (the source moved on and the freshness
    gate would re-import it) or already ``refreshing``.

    Args:
        rows: Normalized status rows.

    Returns:
        The pending lineage keys, in row order.
    """
    return [
        lineage_key(row)
        for row in rows
        if str(row.get("refresh_status") or "") in _PENDING_STATUSES
    ]


def unsettled_lineage_keys(
    rows: Sequence[Mapping[str, Any]],
    targets: Iterable[LineageKey],
    *,
    completed: Iterable[LineageKey] = (),
) -> list[LineageKey]:
    """Return the target lineages that have not finished refreshing yet.

    A target is settled when its status has left the pending set — the anchors moved
    forward (``up-to-date``), the guard held it (``diverged``), or the attempt errored
    (``failed``) — or when a refresh-cycle audit row for it landed during the wait
    (``completed``), which is the authoritative RAR-5.3 signal when the dispatcher
    records cycles.

    Args:
        rows: The current normalized status rows.
        targets: Lineage keys the refresh was expected to act on.
        completed: Lineage keys that already have a new refresh-cycle audit row.

    Returns:
        The still-unsettled target keys, in target order.
    """
    completed_keys = set(completed)
    by_key = {lineage_key(row): row for row in rows}
    unsettled: list[LineageKey] = []
    for key in targets:
        if key in completed_keys:
            continue
        row = by_key.get(key)
        if row is None:
            # The lineage vanished from the catalog page mid-wait; nothing to wait on.
            continue
        if str(row.get("refresh_status") or "") in _PENDING_STATUSES:
            unsettled.append(key)
    return unsettled


def history_lineage_keys(entries: Iterable[Mapping[str, Any]]) -> set[LineageKey]:
    """Return the lineage keys covered by refresh-history entries (RAR-5.3)."""
    return {lineage_key(entry) for entry in entries}


def new_history_entries(
    entries: Sequence[Mapping[str, Any]],
    seen_ids: Iterable[str],
) -> list[Mapping[str, Any]]:
    """Return history entries whose ids were not present before the refresh.

    Comparing ids rather than timestamps keeps the wait immune to clock skew between
    the CLI host and the server.

    Args:
        entries: Refresh-history entries as returned by the API (newest first).
        seen_ids: Entry ids observed before the refresh was triggered.

    Returns:
        The entries that appeared since, in the order given.
    """
    baseline = set(seen_ids)
    fresh: list[Mapping[str, Any]] = []
    for entry in entries:
        entry_id = entry.get("id")
        if isinstance(entry_id, str) and entry_id.strip() and entry_id not in baseline:
            fresh.append(entry)
    return fresh


def failure_outcomes(entries: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return the refresh-cycle entries whose outcome is a failure (RAR-5.3)."""
    return [
        entry
        for entry in entries
        if str(entry.get("outcome") or "").strip() in _FAILURE_OUTCOMES
    ]


def has_failure(
    rows: Sequence[Mapping[str, Any]],
    entries: Sequence[Mapping[str, Any]] = (),
) -> bool:
    """Report whether any status row or refresh cycle represents a failed refresh.

    A held divergence is deliberately *not* a failure: the guard did its job and the
    file is waiting for a human, which the caller is told about separately.

    Args:
        rows: Normalized status rows.
        entries: Refresh-cycle audit entries recorded during the wait.

    Returns:
        True when at least one lineage or cycle failed.
    """
    if any(str(row.get("refresh_status") or "") == STATUS_FAILED for row in rows):
        return True
    return bool(failure_outcomes(entries))


def diverged_rows(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return status rows held for review by the RAR-4.4 divergence guard."""
    return [row for row in rows if str(row.get("refresh_status") or "") == STATUS_DIVERGED]


def format_refresh_progress(*, pending: int, total: int, elapsed_seconds: float) -> str:
    """Build the one-line stderr progress message for the refresh wait loop.

    Args:
        pending: Lineages still refreshing.
        total: Lineages the refresh targeted.
        elapsed_seconds: Seconds spent waiting so far.

    Returns:
        A short status line such as ``Refreshing 2 of 3 files… (12s)``.
    """
    elapsed = max(0, int(elapsed_seconds))
    return f"Refreshing {pending} of {total} files… ({elapsed}s)"


def _short_sha(value: Any) -> str:
    """Abbreviate a commit SHA to its first seven characters for table display."""
    if isinstance(value, str) and value.strip():
        return value.strip()[:7]
    return ""


def _plain(value: Any) -> str:
    """Render an optional table cell value as a string ("" when absent)."""
    return "" if value is None else str(value)


_STATUS_COLUMNS: tuple[ListColumn, ...] = (
    ("Path", "path", None),
    ("Branch", "branch", None),
    ("Status", "refresh_status", None),
    ("Last imported", "last_imported_at", _plain),
    ("Commit", "last_imported_commit_sha", _short_sha),
    ("Project", "project_slug", _plain),
    ("Kind", "source_kind", _plain),
)


def emit_refresh_status(
    rows: Sequence[dict[str, Any]],
    *,
    json_mode: bool,
    repository: Mapping[str, Any] | None = None,
) -> None:
    """Print per-file refresh state for a repository (``refresh status``).

    Args:
        rows: Normalized status rows.
        json_mode: When True emit machine-readable JSON on stdout instead of a table.
        repository: The resolved repository record, echoed in the JSON envelope.
    """
    if json_mode:
        emit_json(
            {
                "repository": {
                    "id": (repository or {}).get("id"),
                    "full_name": (repository or {}).get("full_name")
                    or (repository or {}).get("name"),
                },
                "total": len(rows),
                "summary": summarize_statuses(rows),
                "items": list(rows),
            }
        )
        return

    emit_list_table(
        rows,
        _STATUS_COLUMNS,
        total=len(rows),
        empty_message="No imported files with a stored import spec.",
        min_width=130,
    )
    if not rows:
        return
    summary = ", ".join(f"{status}: {count}" for status, count in summarize_statuses(rows).items())
    typer.echo(f"Refresh state: {summary}")
    held = diverged_rows(rows)
    if held:
        typer.echo(
            f"{len(held)} file(s) held for review after a manual edit (divergence guard).",
            err=True,
        )


def emit_trigger_result(payload: Mapping[str, Any], *, json_mode: bool) -> None:
    """Print the outcome of ``POST …/repositories/{id}/refresh``.

    Args:
        payload: The RAR-5.2 response body (``enqueued`` / ``skipped`` / ``branches``).
        json_mode: When True emit the raw API JSON instead of a human summary.
    """
    if json_mode:
        emit_json(dict(payload))
        return

    enqueued = payload.get("enqueued", 0)
    skipped = payload.get("skipped", 0)
    branches = payload.get("branches")
    typer.echo("Refresh requested.")
    typer.echo(f"  Enqueued: {enqueued}")
    typer.echo(f"  Skipped: {skipped}")
    if isinstance(branches, list) and branches:
        typer.echo(f"  Branches: {', '.join(str(branch) for branch in branches)}")
    if not enqueued:
        typer.echo(
            "  Note: nothing to refresh — every selected file is already up to date "
            "(freshness gate)."
        )


def emit_history_outcomes(entries: Sequence[Mapping[str, Any]], *, json_mode: bool) -> None:
    """Print the refresh-cycle outcomes recorded while waiting (RAR-5.3).

    Args:
        entries: New refresh-history entries, newest first.
        json_mode: When True nothing is printed — the JSON envelope already carries
            the entries.
    """
    if json_mode or not entries:
        return
    typer.echo("Refresh cycles:")
    for entry in entries:
        path = entry.get("path") or "(repository)"
        outcome = entry.get("outcome") or "unknown"
        line = f"  {path}: {outcome}"
        change_report = entry.get("changeReportId") or entry.get("change_report_id")
        if isinstance(change_report, str) and change_report.strip():
            line = f"{line} (change report {change_report.strip()})"
        typer.echo(line)
