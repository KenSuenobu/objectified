"""Tests for the pure refresh helpers behind ``apiome repository refresh`` (RAR-5.6)."""

from __future__ import annotations

import json

import pytest

from apiome_cli.repository_refresh_output import (
    STATUS_UNKNOWN,
    diverged_rows,
    emit_history_outcomes,
    emit_refresh_status,
    emit_trigger_result,
    failure_outcomes,
    format_refresh_progress,
    has_failure,
    history_lineage_keys,
    is_imported_catalog_row,
    lineage_key,
    new_history_entries,
    normalize_status_row,
    pending_lineage_keys,
    summarize_statuses,
    unsettled_lineage_keys,
)

from helpers import strip_ansi

_CATALOG_ROW = {
    "id": "11111111-1111-4111-8111-111111111111",
    "repository_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "branch": "main",
    "path": "openapi.yaml",
    "format": "openapi",
    "project_slug": "pet-store",
    "project_name": "Pet Store",
    "version_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "last_imported_at": "2026-07-30T10:00:00Z",
}

_SPEC = {
    "spec_schema_version": 1,
    "source_kind": "openapi-3",
    "options": {},
    "last_imported_commit_sha": "abcdef1234567890",
    "refresh_status": "stale",
    "backfilled": False,
}


def _row(path: str, branch: str, status: str) -> dict[str, object]:
    """Build a minimal normalized status row for the settle-rule tests."""
    return {"path": path, "branch": branch, "refresh_status": status}


def test_lineage_key_reads_branch_and_path() -> None:
    assert lineage_key(_CATALOG_ROW) == ("main", "openapi.yaml")


def test_lineage_key_defaults_missing_parts_to_empty_strings() -> None:
    assert lineage_key({}) == ("", "")


def test_is_imported_catalog_row_accepts_version_or_import_time() -> None:
    assert is_imported_catalog_row(_CATALOG_ROW) is True
    assert is_imported_catalog_row({"last_imported_at": "2026-07-30T10:00:00Z"}) is True
    assert is_imported_catalog_row({"version_id": "  "}) is False
    assert is_imported_catalog_row({"status": "discovered"}) is False


def test_normalize_status_row_joins_catalog_and_spec() -> None:
    row = normalize_status_row(_CATALOG_ROW, _SPEC)
    assert row["path"] == "openapi.yaml"
    assert row["branch"] == "main"
    assert row["refresh_status"] == "stale"
    assert row["source_kind"] == "openapi-3"
    assert row["project_slug"] == "pet-store"
    assert row["last_imported_commit_sha"] == "abcdef1234567890"
    assert row["backfilled"] is False


def test_normalize_status_row_without_spec_is_unknown() -> None:
    row = normalize_status_row(_CATALOG_ROW, None)
    assert row["refresh_status"] == STATUS_UNKNOWN
    assert row["source_kind"] is None
    assert row["last_imported_at"] == "2026-07-30T10:00:00Z"


def test_summarize_statuses_orders_by_count_then_name() -> None:
    rows = [
        _row("a", "main", "stale"),
        _row("b", "main", "up-to-date"),
        _row("c", "main", "stale"),
        _row("d", "main", "diverged"),
    ]
    assert summarize_statuses(rows) == {"stale": 2, "diverged": 1, "up-to-date": 1}


def test_pending_lineage_keys_selects_stale_and_refreshing() -> None:
    rows = [
        _row("a", "main", "stale"),
        _row("b", "main", "refreshing"),
        _row("c", "main", "up-to-date"),
        _row("d", "main", "diverged"),
    ]
    assert pending_lineage_keys(rows) == [("main", "a"), ("main", "b")]


def test_unsettled_lineage_keys_clears_when_status_leaves_pending() -> None:
    targets = [("main", "a"), ("main", "b")]
    rows = [_row("a", "main", "up-to-date"), _row("b", "main", "stale")]
    assert unsettled_lineage_keys(rows, targets) == [("main", "b")]


def test_unsettled_lineage_keys_treats_diverged_and_failed_as_settled() -> None:
    targets = [("main", "a"), ("main", "b")]
    rows = [_row("a", "main", "diverged"), _row("b", "main", "failed")]
    assert unsettled_lineage_keys(rows, targets) == []


def test_unsettled_lineage_keys_clears_on_recorded_refresh_cycle() -> None:
    targets = [("main", "a")]
    rows = [_row("a", "main", "stale")]
    completed = history_lineage_keys([{"branch": "main", "path": "a"}])
    assert unsettled_lineage_keys(rows, targets, completed=completed) == []


def test_unsettled_lineage_keys_ignores_targets_missing_from_the_page() -> None:
    assert unsettled_lineage_keys([], [("main", "gone.yaml")]) == []


def test_new_history_entries_filters_by_baseline_ids() -> None:
    entries = [{"id": "new"}, {"id": "old"}, {"missing": True}]
    assert new_history_entries(entries, {"old"}) == [{"id": "new"}]


def test_failure_outcomes_and_has_failure() -> None:
    cycles = [{"id": "1", "outcome": "failed"}, {"id": "2", "outcome": "new-version"}]
    assert failure_outcomes(cycles) == [{"id": "1", "outcome": "failed"}]
    assert has_failure([], cycles) is True
    assert has_failure([_row("a", "main", "failed")]) is True
    assert has_failure([_row("a", "main", "diverged")], [{"outcome": "diverged"}]) is False


def test_diverged_rows_selects_held_files() -> None:
    rows = [_row("a", "main", "diverged"), _row("b", "main", "up-to-date")]
    assert diverged_rows(rows) == [rows[0]]


def test_format_refresh_progress_message() -> None:
    message = format_refresh_progress(pending=2, total=3, elapsed_seconds=12.7)
    assert message == "Refreshing 2 of 3 files… (12s)"


def test_emit_refresh_status_human_table(capsys: pytest.CaptureFixture[str]) -> None:
    rows = [normalize_status_row(_CATALOG_ROW, _SPEC)]
    emit_refresh_status(rows, json_mode=False, repository={"id": "r", "full_name": "acme/api"})
    output = strip_ansi(capsys.readouterr().out)
    assert "openapi.yaml" in output
    assert "stale" in output
    assert "abcdef1" in output
    assert "Refresh state: stale: 1" in output


def test_emit_refresh_status_warns_about_diverged(capsys: pytest.CaptureFixture[str]) -> None:
    rows = [_row("openapi.yaml", "main", "diverged")]
    emit_refresh_status(rows, json_mode=False)
    captured = capsys.readouterr()
    assert "held for review" in strip_ansi(captured.err)


def test_emit_refresh_status_empty_message(capsys: pytest.CaptureFixture[str]) -> None:
    emit_refresh_status([], json_mode=False)
    output = strip_ansi(capsys.readouterr().out)
    assert "No imported files with a stored import spec." in output


def test_emit_refresh_status_json(capsys: pytest.CaptureFixture[str]) -> None:
    rows = [normalize_status_row(_CATALOG_ROW, _SPEC)]
    emit_refresh_status(
        rows,
        json_mode=True,
        repository={"id": "r-1", "full_name": "acme/api"},
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["repository"] == {"id": "r-1", "full_name": "acme/api"}
    assert payload["total"] == 1
    assert payload["summary"] == {"stale": 1}
    assert payload["items"][0]["path"] == "openapi.yaml"


def test_emit_trigger_result_human(capsys: pytest.CaptureFixture[str]) -> None:
    emit_trigger_result(
        {"success": True, "enqueued": 2, "skipped": 1, "branches": ["main", "dev"]},
        json_mode=False,
    )
    output = strip_ansi(capsys.readouterr().out)
    assert "Refresh requested." in output
    assert "Enqueued: 2" in output
    assert "Skipped: 1" in output
    assert "main, dev" in output
    assert "nothing to refresh" not in output


def test_emit_trigger_result_notes_freshness_no_op(capsys: pytest.CaptureFixture[str]) -> None:
    emit_trigger_result({"enqueued": 0, "skipped": 3, "branches": ["main"]}, json_mode=False)
    output = strip_ansi(capsys.readouterr().out)
    assert "nothing to refresh" in output


def test_emit_trigger_result_json(capsys: pytest.CaptureFixture[str]) -> None:
    emit_trigger_result({"enqueued": 1, "skipped": 0, "branches": []}, json_mode=True)
    assert json.loads(capsys.readouterr().out)["enqueued"] == 1


def test_emit_history_outcomes_lists_cycles(capsys: pytest.CaptureFixture[str]) -> None:
    emit_history_outcomes(
        [
            {"path": "openapi.yaml", "outcome": "new-version", "changeReportId": "cr-1"},
            {"path": "other.yaml", "outcome": "unchanged"},
        ],
        json_mode=False,
    )
    output = strip_ansi(capsys.readouterr().out)
    assert "openapi.yaml: new-version (change report cr-1)" in output
    assert "other.yaml: unchanged" in output


def test_emit_history_outcomes_silent_in_json_mode(capsys: pytest.CaptureFixture[str]) -> None:
    emit_history_outcomes([{"path": "a", "outcome": "failed"}], json_mode=True)
    assert capsys.readouterr().out == ""
