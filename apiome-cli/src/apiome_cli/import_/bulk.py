"""Bulk import of independent specs — client-side payload and rendering (MFI-29.5).

``apiome import auto --bulk <archive|directory>`` imports a folder of unrelated specs
in one command. The server does the partitioning; this module does the two things that
must happen on the client:

* turn a **local directory** into the archive payload the endpoints accept — packed
  deterministically, with the files that cannot be imported reported rather than
  quietly dropped;
* render the plan and the per-item results, and decide the process exit code from
  them (a batch where one item failed is not a success).

Everything here is pure apart from reading the directory: no HTTP, so the shapes are
testable without a server.
"""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from typing import Any, NamedTuple

import typer

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS
from apiome_cli.output import ListColumn, emit_json, emit_list_table
from apiome_cli.taxonomy_exit import exit_code_for_category

#: Directory names never packed from a local tree (VCS, tooling, vendored code).
_SKIP_DIRECTORIES = frozenset(
    {".git", ".github", ".svn", ".hg", "node_modules", "vendor", "__pycache__", ".venv"}
)

#: Extensions never worth packing as spec text — the same family git intake skips.
_BINARY_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svgz",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".jar", ".war",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".so", ".dylib", ".dll", ".exe", ".class", ".pyc", ".wasm",
    ".mp3", ".mp4", ".mov", ".avi", ".webm",
)

#: Archive suffixes accepted as a ready-made bulk payload.
_ARCHIVE_SUFFIXES = (".zip", ".tar.gz", ".tgz", ".tar")

#: Client-side budget, mirroring the server's archive policy defaults so an oversized
#: directory fails here with a clear message instead of after a pointless upload.
_MAX_FILES = 500
_MAX_FILE_BYTES = 8 * 1024 * 1024
_MAX_TOTAL_BYTES = 32 * 1024 * 1024


class BulkPayload(NamedTuple):
    """A packed bulk payload and what packing it left out.

    Attributes:
        document: The archive bytes to send.
        filename: Label for the payload (the archive's or the directory's name).
        skipped: ``(relative_path, reason)`` for every file not packed.
    """

    document: bytes
    filename: str
    skipped: list[tuple[str, str]]


def is_archive_path(path: str) -> bool:
    """Return whether *path* names a supported archive file."""
    lower = path.lower()
    return any(lower.endswith(suffix) for suffix in _ARCHIVE_SUFFIXES)


def _skip_reason(relative: str, size: int) -> str | None:
    """Return why a file is not packed, or ``None`` when it is."""
    parts = Path(relative).parts
    if any(part.startswith(".") for part in parts):
        return "dotfile"
    if any(part in _SKIP_DIRECTORIES for part in parts):
        return "excluded-directory"
    if relative.lower().endswith(_BINARY_SUFFIXES):
        return "binary-file"
    if size > _MAX_FILE_BYTES:
        return "too-large"
    return None


def pack_directory(directory: str) -> BulkPayload:
    """Pack a local directory into the deterministic archive the endpoints accept.

    Members are written in sorted order with a pinned timestamp, so packing the same
    tree twice produces the same bytes — the plan a user sees and the plan the submit
    re-derives are then provably the same.

    Args:
        directory: Path to the directory to import.

    Returns:
        The :class:`BulkPayload` — archive bytes, label, and the skipped files.

    Raises:
        ValueError: When the directory holds no importable file, or blows the
            file-count / total-size budget.
        OSError: When the directory cannot be read.
    """
    root = Path(directory)
    members: dict[str, str] = {}
    skipped: list[tuple[str, str]] = []
    total = 0

    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name for name in dirnames if name not in _SKIP_DIRECTORIES and not name.startswith(".")
        )
        for name in sorted(filenames):
            absolute = Path(current) / name
            relative = absolute.relative_to(root).as_posix()
            try:
                size = absolute.stat().st_size
            except OSError:
                skipped.append((relative, "unreadable"))
                continue
            reason = _skip_reason(relative, size)
            if reason:
                skipped.append((relative, reason))
                continue
            try:
                text = absolute.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                skipped.append((relative, "not-utf8-text"))
                continue
            total += len(text.encode("utf-8"))
            if len(members) >= _MAX_FILES:
                raise ValueError(
                    f"{directory!r} holds more than {_MAX_FILES} importable files. "
                    "Import a narrower directory."
                )
            if total > _MAX_TOTAL_BYTES:
                raise ValueError(
                    f"{directory!r} exceeds the {_MAX_TOTAL_BYTES}-byte bulk intake budget. "
                    "Import a narrower directory."
                )
            members[relative] = text

    if not members:
        raise ValueError(f"{directory!r} holds no importable files.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for member in sorted(members):
            info = zipfile.ZipInfo(filename=member, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, members[member].encode("utf-8"))
    return BulkPayload(
        document=buffer.getvalue(),
        filename=f"{root.name or 'specs'}.zip",
        skipped=skipped,
    )


def load_bulk_payload(source: str) -> BulkPayload:
    """Read a bulk source — an archive file or a directory — as the payload to send.

    Args:
        source: Path to a ``.zip`` / ``.tar.gz`` archive, or to a directory.

    Returns:
        The :class:`BulkPayload`.

    Raises:
        ValueError: When *source* is neither an archive nor a directory, or a
            directory holds nothing importable.
        OSError: When the path cannot be read.
    """
    path = Path(source)
    if path.is_dir():
        return pack_directory(source)
    if path.is_file():
        if not is_archive_path(source):
            raise ValueError(
                f"{source!r} is a single document. Bulk import takes an archive "
                "(.zip / .tar.gz) or a directory of specs; import one document with "
                "'apiome import auto <path>'."
            )
        return BulkPayload(document=path.read_bytes(), filename=path.name, skipped=[])
    raise ValueError(f"{source!r} is not a file or directory.")


_PLAN_COLUMNS: tuple[ListColumn, ...] = (
    ("Item", "key", None),
    ("Format", "format", None),
    ("Adapter", "source_kind", None),
    ("Destination", "predicted_target", None),
    ("Files", "members", lambda value: str(len(value or []))),
    ("Name", "suggested_name", None),
)

_RESULT_COLUMNS: tuple[ListColumn, ...] = (
    ("Item", "key", None),
    ("State", "state", None),
    ("Destination", "target", None),
    ("Created", "project_slug", None),
    ("Detail", "detail", None),
)


def emit_bulk_plan(plan: dict[str, Any], *, json_mode: bool) -> None:
    """Print the plan: what would be imported, and what was left out.

    Args:
        plan: A parsed ``BulkImportPlanResponse``.
        json_mode: Emit the payload verbatim instead of a table.
    """
    if json_mode:
        emit_json(plan)
        return

    items = [item for item in plan.get("items") or [] if isinstance(item, dict)]
    emit_list_table(items, _PLAN_COLUMNS, empty_message="No importable specs found.")
    summary = plan.get("summary") or {}
    if isinstance(summary, dict) and summary:
        typer.echo(
            f"Found {summary.get('items', 0)} spec(s): "
            f"{summary.get('importable', 0)} importable, "
            f"{summary.get('unimportable', 0)} without an adapter, "
            f"{summary.get('skipped_files', 0)} file(s) not part of any spec."
        )
    if plan.get("truncated"):
        typer.echo(
            f"Only the first {len(items)} of {plan.get('total_items', len(items))} specs are "
            f"planned (limit {plan.get('max_items')}). Import the rest separately.",
            err=True,
        )


def emit_skipped_files(skipped: list[tuple[str, str]], *, json_mode: bool) -> None:
    """Report local files that were not packed, so nothing is dropped silently.

    Args:
        skipped: ``(path, reason)`` pairs from :func:`pack_directory`.
        json_mode: Suppress the human note (the JSON payload is the contract there).
    """
    if json_mode or not skipped:
        return
    typer.echo(f"Skipped {len(skipped)} local file(s):", err=True)
    for path, reason in skipped[:10]:
        typer.echo(f"  {path} ({reason})", err=True)
    if len(skipped) > 10:
        typer.echo(f"  … and {len(skipped) - 10} more", err=True)


def merge_bulk_results(
    started: dict[str, Any], status: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Join the start rows with their final job states into one result list.

    An item that never started has no job to poll, so its start error *is* its result;
    an item that started takes its state, destination, and error from its job.

    Args:
        started: A parsed ``BulkImportStartResponse``.
        status: A parsed ``BulkImportStatusResponse``, or ``None`` when not waiting.

    Returns:
        One row per item: ``key``, ``state``, ``target``, ``project_slug``, ``detail``,
        and the taxonomy ``error`` when there is one.
    """
    by_key: dict[str, dict[str, Any]] = {}
    for row in (status or {}).get("items") or []:
        if isinstance(row, dict) and isinstance(row.get("key"), str):
            by_key[row["key"]] = row

    results: list[dict[str, Any]] = []
    for item in started.get("items") or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", ""))
        if item.get("state") == "failed":
            error = item.get("error") if isinstance(item.get("error"), dict) else None
            results.append(
                {
                    "key": key,
                    "job_id": item.get("job_id"),
                    "state": "failed",
                    "target": item.get("predicted_target"),
                    "project_slug": None,
                    "detail": _error_detail(error) or "did not start",
                    "error": error,
                }
            )
            continue
        job = by_key.get(key)
        if job is None:
            results.append(
                {
                    "key": key,
                    "job_id": item.get("job_id"),
                    "state": "accepted",
                    "target": item.get("predicted_target"),
                    "project_slug": None,
                    "detail": "started",
                    "error": None,
                }
            )
            continue
        error = job.get("error") if isinstance(job.get("error"), dict) else None
        results.append(
            {
                "key": key,
                "job_id": job.get("job_id") or item.get("job_id"),
                "state": job.get("state"),
                "target": job.get("target") or item.get("predicted_target"),
                "project_slug": job.get("project_slug"),
                "detail": _error_detail(error) or "",
                "error": error,
            }
        )
    return results


def _error_detail(error: dict[str, Any] | None) -> str:
    """Render a taxonomy error as ``[CODE] message`` for the result table."""
    if not error:
        return ""
    code = str(error.get("code") or "").strip()
    message = str(error.get("message") or "").strip()
    if code and message:
        return f"[{code}] {message}"
    return message or (f"[{code}]" if code else "")


def emit_bulk_results(
    results: list[dict[str, Any]],
    *,
    json_mode: bool,
    dry_run: bool,
    skipped: list[dict[str, Any]] | None = None,
) -> None:
    """Print the per-item result list and the batch summary.

    Args:
        results: Rows from :func:`merge_bulk_results`.
        json_mode: Emit JSON instead of a table.
        dry_run: Whether the batch ran without persisting.
        skipped: Files the server reported as part of no item.
    """
    if json_mode:
        emit_json({"items": results, "skipped": skipped or []})
        return

    emit_list_table(
        results, _RESULT_COLUMNS, empty_message="No items were imported.", min_width=120
    )
    completed = sum(1 for row in results if row.get("state") == "completed")
    failures = [
        row for row in results if row.get("state") in {"failed", "canceled", "rolled-back"}
    ]
    failed = len(failures)
    pending = len(results) - completed - failed
    # Restate each failure in full: a table cell truncates the code and remediation the
    # user needs, and a batch's whole point is that failures are per-item.
    for row in failures:
        detail = row.get("detail") or "failed"
        typer.echo(f"  x {row.get('key')}: {detail}", err=True)
    verb = "validated" if dry_run else "imported"
    parts = [f"{completed} {verb}"]
    if failed:
        parts.append(f"{failed} failed")
    if pending:
        parts.append(f"{pending} still running")
    typer.echo(f"Bulk import: {', '.join(parts)} of {len(results)} spec(s).")


def bulk_exit_code(results: list[dict[str, Any]]) -> int:
    """Return the process exit code for a finished batch.

    A batch is only a success when every item is. When items failed, their taxonomy
    categories decide the code and the most specific one wins — a policy block (3) over
    a caller-fault code (2) over a transport/internal error (1) — so CI can tell "your
    specs are below policy" apart from "the server was down". An item still running when
    the wait gave up is :data:`EXIT_ERROR`, since its outcome is unknown.

    Args:
        results: Rows from :func:`merge_bulk_results`.

    Returns:
        ``0`` when every item completed, else the failing items' taxonomy exit code.
    """
    failing = [
        row
        for row in results
        if row.get("state") in {"failed", "canceled", "rolled-back", "not-found"}
    ]
    if not failing:
        pending = [row for row in results if row.get("state") != "completed"]
        return EXIT_ERROR if pending else EXIT_SUCCESS
    codes = {
        exit_code_for_category(
            (row.get("error") or {}).get("category") if isinstance(row.get("error"), dict) else None
        )
        for row in failing
    }
    return max(codes) if codes else EXIT_ERROR
