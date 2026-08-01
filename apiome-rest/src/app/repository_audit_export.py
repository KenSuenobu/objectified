"""SOC 2 / ISO 27001 audit export for the repository ledger (REPO-7.5, #2803).

Compliance reviews need a structured, dateable export of everything the repository
subsystem wrote to the shared ``apiome.workflow_audit`` ledger — refresh cycles
(RAR-5.3), webhook registrations / deliveries / secret rotations (REPO-4.x),
external-ref fetches (REPO-3.9), and so on. All of those rows share the
``repository.`` action prefix, so "the repository audit trail" is a prefix slice of
the ledger, bounded by an inclusive ``created_at`` range.

This module is the pure core behind
``GET /v1/tenants/{tenant_slug}/repository-audit-export``:

* **Batched, streaming reads.** :func:`iter_repository_audit_rows` walks the ledger
  oldest-first with a ``(created_at, id)`` keyset cursor in fixed-size batches, so a
  100k-row export holds one batch in memory, never the whole range. Keyset (not
  OFFSET) keeps every batch equally cheap and immune to rows being appended while
  the export runs.
* **Two wire formats.** :func:`csv_export_chunks` emits a header plus one RFC-4180
  line per row (``detail`` JSON-encoded in its cell); :func:`json_export_chunks`
  emits a single JSON document — an ``export`` metadata envelope, an ``entries``
  array streamed element by element, and a trailing ``rowCount`` — that is valid
  JSON when, and only when, the export ran to completion.
* **The export is itself evidence.** :func:`generate_export` records one
  :data:`AUDIT_EXPORTED_ACTION` row when the stream finishes — ``success`` with the
  exact row count on completion, ``failure`` (with the rows streamed so far) when
  the stream errors or the client disconnects mid-download. An auditor reading the
  ledger can therefore see every export, including the aborted ones. Recording is
  best-effort (``insert_workflow_audit`` swallows DB errors), so audit bookkeeping
  can never break the download it describes.

Ordering is oldest-first (``created_at ASC, id ASC``): an export is a ledger
excerpt, and ledgers read forward.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, Optional

# Workflow-audit action stamped on every export, so the export trail is itself part
# of the ledger it exports (acceptance: "Export action is itself audited").
AUDIT_EXPORTED_ACTION = "repository.audit_exported"

# Every repository-subsystem ledger action shares this prefix (refresh cycles,
# webhooks, external-ref fetches, ...) — the export is this slice of workflow_audit.
REPOSITORY_ACTION_PREFIX = "repository."

#: Supported wire formats.
EXPORT_FORMAT_CSV = "csv"
EXPORT_FORMAT_JSON = "json"
EXPORT_FORMATS = (EXPORT_FORMAT_CSV, EXPORT_FORMAT_JSON)

#: Rows fetched per ledger query while streaming. Small enough to bound memory,
#: large enough that a 100k-row export is ~100 queries, not 100k.
EXPORT_BATCH_SIZE = 1000

#: CSV column order; also the key order of every JSON entry.
EXPORT_COLUMNS = (
    "id",
    "createdAt",
    "action",
    "outcome",
    "actorId",
    "projectId",
    "versionId",
    "detail",
)


def normalize_export_format(raw: Any) -> str:
    """Return the canonical export format for a raw ``format`` query value.

    Args:
        raw: The caller-supplied format; case-insensitive, surrounding whitespace
            ignored. ``None`` / blank defaults to :data:`EXPORT_FORMAT_JSON`.

    Returns:
        One of :data:`EXPORT_FORMATS`.

    Raises:
        ValueError: When the value names neither supported format.
    """
    if raw is None or str(raw).strip() == "":
        return EXPORT_FORMAT_JSON
    fmt = str(raw).strip().lower()
    if fmt not in EXPORT_FORMATS:
        raise ValueError(
            f"Invalid format: expected one of {', '.join(EXPORT_FORMATS)}"
        )
    return fmt


def parse_export_bound(label: str, raw: Any) -> Optional[datetime]:
    """Parse an inclusive ``from`` / ``to`` range bound.

    Args:
        label: Parameter name for the error message (``from`` or ``to``).
        raw: ISO 8601 datetime string; ``Z`` suffix accepted; a naive value is
            taken as UTC. ``None`` / blank means "unbounded".

    Returns:
        A timezone-aware datetime, or ``None`` when the bound is absent.

    Raises:
        ValueError: When the value is not an ISO 8601 datetime.
    """
    if raw is None or str(raw).strip() == "":
        return None
    text = str(raw).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as e:
        raise ValueError(
            f"Invalid {label}: expected ISO 8601 datetime ({e})"
        ) from e
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def validate_export_range(
    since: Optional[datetime], until: Optional[datetime]
) -> None:
    """Reject an inverted range instead of silently exporting nothing.

    Args:
        since: Inclusive lower bound, or ``None``.
        until: Inclusive upper bound, or ``None``.

    Raises:
        ValueError: When both bounds are present and ``since`` is after ``until``.
    """
    if since is not None and until is not None and since > until:
        raise ValueError("Invalid range: from must not be after to")


def _iso(value: Any) -> Optional[str]:
    """ISO-8601 string for a datetime-ish value; ``None`` stays ``None``."""
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def export_entry(row: Dict[str, Any]) -> Dict[str, Any]:
    """Project one ``workflow_audit`` row onto the camelCase export shape.

    Args:
        row: A ledger row as returned by the DAO (dict with snake_case keys).

    Returns:
        A dict with exactly the :data:`EXPORT_COLUMNS` keys, JSON-serializable.
        ``detail`` stays a structured object (or ``None``); the CSV writer is the
        one place it gets flattened to a string.
    """
    detail = row.get("detail")
    if detail is not None and not isinstance(detail, dict):
        detail = None
    return {
        "id": str(row["id"]),
        "createdAt": _iso(row.get("created_at")),
        "action": str(row["action"]),
        "outcome": str(row["outcome"]),
        "actorId": str(row["actor_id"]) if row.get("actor_id") is not None else None,
        "projectId": (
            str(row["project_id"]) if row.get("project_id") is not None else None
        ),
        "versionId": (
            str(row["version_id"]) if row.get("version_id") is not None else None
        ),
        "detail": detail,
    }


def iter_repository_audit_rows(
    db: Any,
    tenant_id: str,
    *,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    batch_size: int = EXPORT_BATCH_SIZE,
) -> Iterator[Dict[str, Any]]:
    """Yield the tenant's ``repository.*`` ledger rows oldest-first, in batches.

    Walks ``apiome.workflow_audit`` with a ``(created_at, id)`` keyset cursor so
    memory is bounded by ``batch_size`` regardless of how many rows the range
    holds — the property the >10k-row acceptance criterion is about.

    Args:
        db: Database handle exposing ``list_workflow_audit_for_export``.
        tenant_id: Owning tenant (the export never crosses tenants).
        since: Inclusive lower ``created_at`` bound, or ``None`` for unbounded.
        until: Inclusive upper ``created_at`` bound, or ``None`` for unbounded.
        batch_size: Rows per ledger query; must be positive.

    Yields:
        Ledger rows (dicts) in ``created_at ASC, id ASC`` order.

    Raises:
        ValueError: When ``batch_size`` is not positive (a programming error that
            would otherwise loop forever).
    """
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    cursor_created_at: Optional[datetime] = None
    cursor_id: Optional[str] = None
    while True:
        rows = db.list_workflow_audit_for_export(
            tenant_id,
            action_prefix=REPOSITORY_ACTION_PREFIX,
            since=since,
            until=until,
            batch_size=batch_size,
            cursor_created_at=cursor_created_at,
            cursor_id=cursor_id,
        )
        for row in rows:
            yield row
        if len(rows) < batch_size:
            return
        last = rows[-1]
        cursor_created_at = last.get("created_at")
        cursor_id = str(last["id"])


def _csv_cell(value: Any) -> str:
    """Render one entry value as a CSV cell: ``None`` empty, ``detail`` as JSON."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def _csv_line(values: Any) -> str:
    """One RFC-4180 CSV record (quoting via the stdlib writer), CRLF-terminated."""
    buffer = io.StringIO()
    csv.writer(buffer).writerow(values)
    return buffer.getvalue()


def csv_export_chunks(entries: Iterator[Dict[str, Any]]) -> Iterator[str]:
    """Stream a CSV document: the :data:`EXPORT_COLUMNS` header, then one row each.

    Args:
        entries: Export entries as produced by :func:`export_entry`.

    Yields:
        Text chunks; concatenated they form the complete CSV document.
    """
    yield _csv_line(EXPORT_COLUMNS)
    for entry in entries:
        yield _csv_line([_csv_cell(entry[column]) for column in EXPORT_COLUMNS])


def json_export_chunks(
    entries: Iterator[Dict[str, Any]],
    *,
    meta: Dict[str, Any],
    row_count: Callable[[], int],
) -> Iterator[str]:
    """Stream one JSON document: metadata envelope, entries array, trailing count.

    The document is emitted incrementally (``entries`` is never materialized), and
    is only closed — ``],"rowCount":N}`` — after the last entry, so a download cut
    off mid-stream is visibly truncated (invalid JSON) rather than silently short:
    exactly the property a compliance artifact needs.

    Args:
        entries: Export entries as produced by :func:`export_entry`.
        meta: The ``export`` envelope (tenant, range, format, generation time).
        row_count: Called once after ``entries`` is exhausted; returns the final
            count for the trailing ``rowCount`` field.

    Yields:
        Text chunks; concatenated they form one valid JSON object.
    """
    yield '{"export":' + json.dumps(meta, ensure_ascii=False) + ',"entries":['
    first = True
    for entry in entries:
        prefix = "" if first else ","
        first = False
        yield prefix + json.dumps(entry, ensure_ascii=False)
    yield f'],"rowCount":{int(row_count())}}}'


def export_media_type(export_format: str) -> str:
    """The response ``Content-Type`` for a canonical export format."""
    if export_format == EXPORT_FORMAT_CSV:
        return "text/csv; charset=utf-8"
    return "application/json"


def export_filename(
    export_format: str,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
) -> str:
    """A dateable attachment filename, e.g. ``repository-audit-export_20260101-20260731.csv``.

    Args:
        export_format: One of :data:`EXPORT_FORMATS` (doubles as the extension).
        since: Inclusive lower bound; rendered ``YYYYMMDD``, or ``start`` when absent.
        until: Inclusive upper bound; rendered ``YYYYMMDD``, or ``now`` when absent.

    Returns:
        The filename; the range suffix is omitted entirely for an unbounded export.
    """
    if since is None and until is None:
        return f"repository-audit-export.{export_format}"
    lower = since.strftime("%Y%m%d") if since is not None else "start"
    upper = until.strftime("%Y%m%d") if until is not None else "now"
    return f"repository-audit-export_{lower}-{upper}.{export_format}"


def record_audit_export(
    db: Any,
    *,
    tenant_id: str,
    actor_id: Optional[str],
    export_format: str,
    since: Optional[datetime],
    until: Optional[datetime],
    row_count: int,
    completed: bool,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """Write the :data:`AUDIT_EXPORTED_ACTION` ledger row for one export attempt.

    Best-effort by construction: ``insert_workflow_audit`` logs and swallows DB
    errors, so recording can never fail the download it describes.

    Args:
        db: Database handle exposing ``insert_workflow_audit``.
        tenant_id: Tenant whose ledger was exported.
        actor_id: The administrator who requested the export.
        export_format: The wire format that was served.
        since: The requested inclusive lower bound, or ``None``.
        until: The requested inclusive upper bound, or ``None``.
        row_count: Rows actually streamed (the full count on success; the count
            reached when the stream stopped on failure).
        completed: ``True`` when the stream ran to the end.
        error: Short failure description for an aborted export.

    Returns:
        The ``detail`` dict that was recorded (handy for tests and logs).
    """
    detail: Dict[str, Any] = {
        "format": export_format,
        "from": _iso(since),
        "to": _iso(until),
        "rowCount": int(row_count),
        "completed": bool(completed),
    }
    if error:
        detail["error"] = str(error)
    db.insert_workflow_audit(
        tenant_id,
        None,
        None,
        AUDIT_EXPORTED_ACTION,
        "success" if completed else "failure",
        actor_id,
        detail,
    )
    return detail


def generate_export(
    db: Any,
    tenant_id: str,
    *,
    export_format: str,
    since: Optional[datetime],
    until: Optional[datetime],
    actor_id: Optional[str],
    generated_at: datetime,
    batch_size: int = EXPORT_BATCH_SIZE,
) -> Iterator[str]:
    """Stream one complete export and record it in the ledger when it ends.

    This is the generator handed to ``StreamingResponse``: it reads the ledger in
    batches (:func:`iter_repository_audit_rows`), renders each row in the requested
    format, and — once the stream finishes — appends the
    :data:`AUDIT_EXPORTED_ACTION` row: ``success`` with the exact row count on
    completion, ``failure`` with the partial count when the stream raises or the
    client disconnects (``GeneratorExit``).

    Args:
        db: Database handle (ledger reads and the audit write).
        tenant_id: Tenant whose ``repository.*`` rows are exported.
        export_format: A canonical format from :func:`normalize_export_format`.
        since: Inclusive lower ``created_at`` bound, or ``None``.
        until: Inclusive upper ``created_at`` bound, or ``None``.
        actor_id: The administrator to attribute the export to.
        generated_at: Stamp for the JSON envelope's ``generatedAt``.
        batch_size: Rows per ledger query (see :data:`EXPORT_BATCH_SIZE`).

    Yields:
        Text chunks of the CSV or JSON document.
    """
    counter = {"rows": 0}
    rows = iter_repository_audit_rows(
        db, tenant_id, since=since, until=until, batch_size=batch_size
    )

    def entries() -> Iterator[Dict[str, Any]]:
        for row in rows:
            counter["rows"] += 1
            yield export_entry(row)

    if export_format == EXPORT_FORMAT_CSV:
        chunks = csv_export_chunks(entries())
    else:
        meta = {
            "tenantId": str(tenant_id),
            "format": export_format,
            "actionPrefix": REPOSITORY_ACTION_PREFIX,
            "from": _iso(since),
            "to": _iso(until),
            "generatedAt": _iso(generated_at),
        }
        chunks = json_export_chunks(
            entries(), meta=meta, row_count=lambda: counter["rows"]
        )

    try:
        for chunk in chunks:
            yield chunk
    except BaseException as e:
        # A DB error mid-stream or the client hanging up (GeneratorExit): the
        # attempt still happened, so it is still evidence — recorded as a failure
        # with the rows that made it out.
        message = str(e).strip() or type(e).__name__
        record_audit_export(
            db,
            tenant_id=tenant_id,
            actor_id=actor_id,
            export_format=export_format,
            since=since,
            until=until,
            row_count=counter["rows"],
            completed=False,
            error=message,
        )
        raise
    record_audit_export(
        db,
        tenant_id=tenant_id,
        actor_id=actor_id,
        export_format=export_format,
        since=since,
        until=until,
        row_count=counter["rows"],
        completed=True,
    )
