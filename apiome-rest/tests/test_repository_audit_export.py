"""The audit-export core (REPO-7.5, #2803).

These tests pin the properties a compliance artifact lives or dies by: the ledger is
walked in bounded batches (the >10k-row criterion), the CSV and JSON documents are
well-formed and complete, and every export attempt — finished or aborted — leaves its
own ``repository.audit_exported`` row behind.
"""

import csv
import io
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from app.repository_audit_export import (
    AUDIT_EXPORTED_ACTION,
    EXPORT_BATCH_SIZE,
    EXPORT_COLUMNS,
    EXPORT_FORMAT_CSV,
    EXPORT_FORMAT_JSON,
    REPOSITORY_ACTION_PREFIX,
    export_entry,
    export_filename,
    export_media_type,
    generate_export,
    iter_repository_audit_rows,
    json_export_chunks,
    normalize_export_format,
    parse_export_bound,
    validate_export_range,
)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_ACTOR_ID = "660e8400-e29b-41d4-a716-446655440001"
_BASE_TS = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def _row(index: int, **overrides: Any) -> Dict[str, Any]:
    """A workflow_audit row as the DAO returns it (snake_case, real datetimes)."""
    row: Dict[str, Any] = {
        "id": f"00000000-0000-0000-0000-{index:012d}",
        "tenant_id": _TENANT_ID,
        "project_id": None,
        "version_id": None,
        "action": "repository.refresh.cycle",
        "outcome": "success",
        "actor_id": None,
        "detail": {"trigger": "scheduled", "index": index},
        "created_at": _BASE_TS + timedelta(seconds=index),
    }
    row.update(overrides)
    return row


class _FakeLedger:
    """A db double whose export query pages over a fixed row list with a keyset."""

    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows
        self.batch_calls: List[Dict[str, Any]] = []
        self.audit_rows: List[Dict[str, Any]] = []

    def list_workflow_audit_for_export(
        self,
        tenant_id: str,
        *,
        action_prefix: str,
        since=None,
        until=None,
        batch_size: int = 1000,
        cursor_created_at=None,
        cursor_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        self.batch_calls.append(
            {
                "tenant_id": tenant_id,
                "action_prefix": action_prefix,
                "since": since,
                "until": until,
                "batch_size": batch_size,
                "cursor_created_at": cursor_created_at,
                "cursor_id": cursor_id,
            }
        )
        remaining = self.rows
        if cursor_created_at is not None and cursor_id is not None:
            remaining = [
                r
                for r in self.rows
                if (r["created_at"], str(r["id"])) > (cursor_created_at, cursor_id)
            ]
        return remaining[:batch_size]

    def insert_workflow_audit(self, *args: Any) -> None:
        (tenant_id, project_id, version_id, action, outcome, actor_id, detail) = args
        self.audit_rows.append(
            {
                "tenant_id": tenant_id,
                "project_id": project_id,
                "version_id": version_id,
                "action": action,
                "outcome": outcome,
                "actor_id": actor_id,
                "detail": detail,
            }
        )


def _export_text(db: _FakeLedger, export_format: str, **kwargs: Any) -> str:
    """Run generate_export to completion and return the concatenated document."""
    kwargs.setdefault("since", None)
    kwargs.setdefault("until", None)
    kwargs.setdefault("actor_id", _ACTOR_ID)
    kwargs.setdefault("generated_at", _BASE_TS)
    return "".join(
        generate_export(db, _TENANT_ID, export_format=export_format, **kwargs)
    )


# --- parameter parsing ---------------------------------------------------------------


def test_format_defaults_to_json_and_normalizes_case() -> None:
    assert normalize_export_format(None) == EXPORT_FORMAT_JSON
    assert normalize_export_format("  ") == EXPORT_FORMAT_JSON
    assert normalize_export_format("CSV") == EXPORT_FORMAT_CSV
    assert normalize_export_format(" json ") == EXPORT_FORMAT_JSON


def test_an_unknown_format_is_rejected() -> None:
    """xlsx silently served as JSON would hand an auditor a mislabeled artifact."""
    with pytest.raises(ValueError, match="format"):
        normalize_export_format("xlsx")


def test_bounds_parse_iso_8601_including_zulu_and_naive_as_utc() -> None:
    assert parse_export_bound("from", "2026-07-01T00:00:00Z") == datetime(
        2026, 7, 1, tzinfo=timezone.utc
    )
    assert parse_export_bound("from", "2026-07-01T00:00:00") == datetime(
        2026, 7, 1, tzinfo=timezone.utc
    )
    assert parse_export_bound("to", None) is None
    assert parse_export_bound("to", "") is None


def test_a_malformed_bound_is_rejected_with_its_parameter_name() -> None:
    with pytest.raises(ValueError, match="from"):
        parse_export_bound("from", "last tuesday")


def test_an_inverted_range_is_rejected_not_silently_empty() -> None:
    """from > to exporting zero rows would read as "nothing happened", which is a
    materially different claim than "you asked for an impossible range"."""
    with pytest.raises(ValueError, match="range"):
        validate_export_range(
            _BASE_TS, _BASE_TS - timedelta(days=1)
        )
    validate_export_range(None, None)
    validate_export_range(_BASE_TS, _BASE_TS)


# --- the batched walk ----------------------------------------------------------------


def test_rows_are_fetched_in_keyset_batches_not_all_at_once() -> None:
    """The >10k-row criterion: memory is bounded by the batch, so the walk must
    re-query with the last row's keyset instead of asking for everything."""
    db = _FakeLedger([_row(i) for i in range(25)])
    out = list(
        iter_repository_audit_rows(db, _TENANT_ID, batch_size=10)
    )
    assert len(out) == 25
    assert len(db.batch_calls) == 3
    second = db.batch_calls[1]
    assert second["cursor_id"] == str(db.rows[9]["id"])
    assert second["cursor_created_at"] == db.rows[9]["created_at"]


def test_an_exact_batch_multiple_terminates_with_one_extra_empty_query() -> None:
    db = _FakeLedger([_row(i) for i in range(20)])
    out = list(iter_repository_audit_rows(db, _TENANT_ID, batch_size=10))
    assert len(out) == 20
    assert len(db.batch_calls) == 3  # 10 + 10 + 0


def test_the_walk_is_scoped_to_the_repository_prefix_and_the_range() -> None:
    db = _FakeLedger([])
    since = _BASE_TS
    until = _BASE_TS + timedelta(days=30)
    list(
        iter_repository_audit_rows(
            db, _TENANT_ID, since=since, until=until, batch_size=10
        )
    )
    call = db.batch_calls[0]
    assert call["action_prefix"] == REPOSITORY_ACTION_PREFIX
    assert call["since"] == since
    assert call["until"] == until
    assert call["tenant_id"] == _TENANT_ID


def test_a_nonpositive_batch_size_is_a_programming_error_not_an_infinite_loop() -> None:
    with pytest.raises(ValueError, match="batch_size"):
        next(iter_repository_audit_rows(_FakeLedger([]), _TENANT_ID, batch_size=0))


# --- the entry shape -----------------------------------------------------------------


def test_entries_are_camel_case_with_every_column_present() -> None:
    entry = export_entry(_row(1, actor_id=_ACTOR_ID))
    assert tuple(entry.keys()) == EXPORT_COLUMNS
    assert entry["actorId"] == _ACTOR_ID
    assert entry["createdAt"] == (_BASE_TS + timedelta(seconds=1)).isoformat()
    assert entry["detail"] == {"trigger": "scheduled", "index": 1}


def test_a_non_dict_detail_is_dropped_not_crashed_on() -> None:
    entry = export_entry(_row(1, detail="not-a-dict"))
    assert entry["detail"] is None


# --- the CSV document ----------------------------------------------------------------


def test_csv_starts_with_the_header_and_has_one_line_per_row() -> None:
    db = _FakeLedger([_row(i) for i in range(3)])
    text = _export_text(db, EXPORT_FORMAT_CSV)
    parsed = list(csv.reader(io.StringIO(text)))
    assert parsed[0] == list(EXPORT_COLUMNS)
    assert len(parsed) == 4


def test_csv_survives_quotes_commas_newlines_and_unicode_in_detail() -> None:
    """The detail cell is attacker-adjacent text (error messages, branch names);
    a row that breaks the table breaks the whole artifact."""
    nasty = {"error": 'she said "no,\nreally" — Ω'}
    db = _FakeLedger([_row(0, detail=nasty)])
    text = _export_text(db, EXPORT_FORMAT_CSV)
    parsed = list(csv.reader(io.StringIO(text)))
    assert len(parsed) == 2
    detail_cell = parsed[1][list(EXPORT_COLUMNS).index("detail")]
    assert json.loads(detail_cell) == nasty


def test_csv_renders_absent_ids_as_empty_cells() -> None:
    db = _FakeLedger([_row(0, project_id=None, version_id=None, actor_id=None)])
    parsed = list(csv.reader(io.StringIO(_export_text(db, EXPORT_FORMAT_CSV))))
    columns = list(EXPORT_COLUMNS)
    assert parsed[1][columns.index("projectId")] == ""
    assert parsed[1][columns.index("actorId")] == ""


def test_an_empty_csv_export_is_just_the_header() -> None:
    text = _export_text(_FakeLedger([]), EXPORT_FORMAT_CSV)
    parsed = list(csv.reader(io.StringIO(text)))
    assert parsed == [list(EXPORT_COLUMNS)]


# --- the JSON document ---------------------------------------------------------------


def test_json_is_one_valid_document_with_envelope_entries_and_count() -> None:
    db = _FakeLedger([_row(i) for i in range(5)])
    since = _BASE_TS - timedelta(days=1)
    body = json.loads(_export_text(db, EXPORT_FORMAT_JSON, since=since))
    assert body["export"]["tenantId"] == _TENANT_ID
    assert body["export"]["format"] == EXPORT_FORMAT_JSON
    assert body["export"]["from"] == since.isoformat()
    assert body["export"]["to"] is None
    assert body["export"]["actionPrefix"] == REPOSITORY_ACTION_PREFIX
    assert [e["id"] for e in body["entries"]] == [str(r["id"]) for r in db.rows]
    assert body["rowCount"] == 5


def test_an_empty_json_export_is_valid_with_row_count_zero() -> None:
    body = json.loads(_export_text(_FakeLedger([]), EXPORT_FORMAT_JSON))
    assert body["entries"] == []
    assert body["rowCount"] == 0


def test_json_is_streamed_not_materialized() -> None:
    """One chunk per entry (plus envelope and closer) is the shape that keeps a
    100k-row export out of memory; a single giant chunk would defeat streaming."""
    entries = iter([{"id": "a"}, {"id": "b"}])
    chunks = list(
        json_export_chunks(entries, meta={"x": 1}, row_count=lambda: 2)
    )
    assert len(chunks) == 4  # envelope, entry, entry, closer
    assert json.loads("".join(chunks))["rowCount"] == 2


def test_a_truncated_json_stream_is_not_valid_json() -> None:
    """A download cut off mid-stream must be detectably incomplete — an auditor
    should never mistake half an export for a whole one."""
    db = _FakeLedger([_row(i) for i in range(3)])
    chunks = list(generate_export(
        db, _TENANT_ID,
        export_format=EXPORT_FORMAT_JSON,
        since=None, until=None, actor_id=_ACTOR_ID, generated_at=_BASE_TS,
    ))
    truncated = "".join(chunks[:-1])
    with pytest.raises(json.JSONDecodeError):
        json.loads(truncated)


# --- the export is itself evidence ----------------------------------------------------


def test_a_completed_export_is_audited_with_the_exact_row_count() -> None:
    db = _FakeLedger([_row(i) for i in range(7)])
    since = _BASE_TS - timedelta(days=7)
    until = _BASE_TS + timedelta(days=1)
    _export_text(db, EXPORT_FORMAT_CSV, since=since, until=until)
    assert len(db.audit_rows) == 1
    audit = db.audit_rows[0]
    assert audit["action"] == AUDIT_EXPORTED_ACTION
    assert audit["outcome"] == "success"
    assert audit["tenant_id"] == _TENANT_ID
    assert audit["actor_id"] == _ACTOR_ID
    assert audit["detail"]["rowCount"] == 7
    assert audit["detail"]["format"] == EXPORT_FORMAT_CSV
    assert audit["detail"]["from"] == since.isoformat()
    assert audit["detail"]["to"] == until.isoformat()
    assert audit["detail"]["completed"] is True


def test_the_export_action_itself_carries_the_repository_prefix() -> None:
    """It must land inside the very slice the endpoint exports, so the next export
    shows this one."""
    assert AUDIT_EXPORTED_ACTION.startswith(REPOSITORY_ACTION_PREFIX)


def test_a_stream_that_errors_mid_way_is_audited_as_a_failure() -> None:
    db = _FakeLedger([_row(i) for i in range(4)])
    original = db.list_workflow_audit_for_export
    calls = {"n": 0}

    def flaky(*args: Any, **kwargs: Any) -> List[Dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("connection reset")
        return original(*args, **kwargs)

    db.list_workflow_audit_for_export = flaky  # type: ignore[method-assign]
    stream = generate_export(
        db, _TENANT_ID,
        export_format=EXPORT_FORMAT_CSV,
        since=None, until=None, actor_id=_ACTOR_ID, generated_at=_BASE_TS,
        batch_size=2,
    )
    with pytest.raises(RuntimeError):
        list(stream)
    assert len(db.audit_rows) == 1
    audit = db.audit_rows[0]
    assert audit["outcome"] == "failure"
    assert audit["detail"]["completed"] is False
    assert audit["detail"]["rowCount"] == 2
    assert "connection reset" in audit["detail"]["error"]


def test_a_client_disconnect_is_audited_as_a_failure_with_partial_count() -> None:
    """GeneratorExit is how a hung-up download reaches us; the attempt still
    happened, so it still has to be on the ledger."""
    db = _FakeLedger([_row(i) for i in range(10)])
    stream = generate_export(
        db, _TENANT_ID,
        export_format=EXPORT_FORMAT_CSV,
        since=None, until=None, actor_id=_ACTOR_ID, generated_at=_BASE_TS,
    )
    next(stream)  # header
    next(stream)  # first row
    stream.close()  # client hangs up
    assert len(db.audit_rows) == 1
    audit = db.audit_rows[0]
    assert audit["outcome"] == "failure"
    assert audit["detail"]["rowCount"] == 1
    assert audit["detail"]["error"] == "GeneratorExit"


def test_the_audit_write_uses_the_best_effort_ledger_insert() -> None:
    """insert_workflow_audit is the swallow-on-error path; wiring the export to a
    raising writer would let bookkeeping break the download."""
    db = MagicMock()
    db.list_workflow_audit_for_export.return_value = []
    _export_text(db, EXPORT_FORMAT_CSV)
    assert db.insert_workflow_audit.called


# --- presentation helpers --------------------------------------------------------------


def test_media_types_match_the_format() -> None:
    assert export_media_type(EXPORT_FORMAT_CSV).startswith("text/csv")
    assert export_media_type(EXPORT_FORMAT_JSON) == "application/json"


def test_filenames_are_dateable() -> None:
    since = datetime(2026, 1, 1, tzinfo=timezone.utc)
    until = datetime(2026, 7, 31, tzinfo=timezone.utc)
    assert (
        export_filename(EXPORT_FORMAT_CSV, since, until)
        == "repository-audit-export_20260101-20260731.csv"
    )
    assert (
        export_filename(EXPORT_FORMAT_JSON, since, None)
        == "repository-audit-export_20260101-now.json"
    )
    assert (
        export_filename(EXPORT_FORMAT_JSON, None, until)
        == "repository-audit-export_start-20260731.json"
    )
    assert export_filename(EXPORT_FORMAT_JSON) == "repository-audit-export.json"


def test_the_default_batch_size_clears_the_ten_k_criterion_comfortably() -> None:
    assert 100 <= EXPORT_BATCH_SIZE <= 10_000
