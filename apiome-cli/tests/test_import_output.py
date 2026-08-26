"""Unit tests for import result and job-accept output formatters."""

from __future__ import annotations

import json
from io import StringIO
from unittest.mock import patch

import pytest
from rich.console import Console

from apiome_cli.output import (
    _format_elapsed,
    emit_import_job_accepted,
    emit_import_result,
    emit_json,
    emit_json_schema_type_import_result,
    merge_import_warnings,
)


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0, "0s"),
        (0.4, "0s"),
        (16, "16s"),
        (59.9, "59s"),
        (60, "1m"),
        (76, "1m 16s"),
        (3600, "1h"),
        (3661, "1h 1m 1s"),
        (-5, "0s"),
    ],
)
def test_format_elapsed_is_human_readable(seconds: float, expected: str) -> None:
    """Durations render compactly with units, never as ``elapsed=(N)s``."""
    assert _format_elapsed(seconds) == expected

_SAMPLE_RESULT = {
    "project_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "version_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "project": {"name": "Pet Store", "slug": "pet-store"},
    "version": {"version": "1.0.0", "slug": "1.0.0"},
    "created": {
        "schemas": 2,
        "properties": 1,
        "project_properties": 0,
        "version_schemas": 3,
    },
    "warnings": [{"code": "W1", "message": "minor"}],
    "errors": [],
}

_JOB_ACCEPTED = {
    "job_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "status": "pending",
}

_TYPE_IMPORT_RESULT = {
    "status": "completed",
    "dry_run": False,
    "created": 2,
    "updated": 1,
    "skipped": 0,
    "entries": [
        {
            "name": "Email",
            "slug": "email",
            "ref_path": "#/$defs/Email",
            "action": "created",
        },
        {
            "name": "MonetaryAmount",
            "slug": "monetary-amount",
            "ref_path": "#/$defs/MonetaryAmount",
            "action": "updated",
        },
    ],
}


def _capture_echo(func, *args, **kwargs) -> str:
    buffer = StringIO()

    def _echo_wrapper(message="", nl=True, **kw):  # kw absorbs err=, color=, etc.
        buffer.write(str(message))
        if nl:
            buffer.write("\n")

    with patch("apiome_cli.output.typer.echo", new=_echo_wrapper):
        func(*args, **kwargs)
    return buffer.getvalue()


def _capture_human_output(func, *args, **kwargs) -> str:
    """Capture typer.echo lines and Rich tables written during human-mode output."""
    buffer = StringIO()
    console = Console(file=buffer, width=120, force_terminal=True)

    def _echo_wrapper(message="", nl=True, **kw):  # kw absorbs err=, color=, etc.
        buffer.write(str(message))
        if nl:
            buffer.write("\n")

    with (
        patch("apiome_cli.output.typer.echo", new=_echo_wrapper),
        patch("apiome_cli.output.make_console", return_value=console),
    ):
        func(*args, **kwargs)
    return buffer.getvalue()


def test_emit_import_result_json_mode_emits_raw_payload(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``--json`` prints compact serialized ImportResult without transformation."""
    emit_import_result(_SAMPLE_RESULT, json_mode=True)
    out = capsys.readouterr().out.strip()
    assert out == json.dumps(_SAMPLE_RESULT, separators=(",", ":"))


def test_emit_import_result_human_shows_ids_and_counts() -> None:
    """Human mode includes project/version ids and created entity counts."""
    output = _capture_human_output(emit_import_result, _SAMPLE_RESULT, json_mode=False)

    assert "Import completed." in output
    assert "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" in output
    assert "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" in output
    assert "Pet Store" in output
    assert "pet-store" in output
    assert "1.0.0" in output
    assert "Created entities" in output
    assert "Schemas" in output
    assert "Properties" in output
    assert "Version schema links" in output
    assert "Warnings (1):" in output
    assert "[W1] minor" in output
    assert "Errors:" not in output


def test_emit_import_result_human_shows_elapsed_seconds() -> None:
    """Human mode includes elapsed seconds on the completion line when provided."""
    output = _capture_human_output(
        emit_import_result,
        _SAMPLE_RESULT,
        json_mode=False,
        elapsed_seconds=12.7,
    )

    assert "Import completed: 12s" in output


def test_emit_import_result_human_shows_flat_spec_import_result() -> None:
    """The async spec-import result has flat keys (no nested project/version objects).

    Regression: the project slug and version id must still render instead of blank ``()``.
    """
    flat = {
        "project_id": "51600bcd-a740-450b-a339-9ee8a493f10b",
        "project_slug": "networkmanagementclient",
        "version_id": "2018-12-01",
        "version_record_id": "54aa1111-2222-4333-8444-555566667777",
    }
    output = _capture_human_output(emit_import_result, flat, json_mode=False)

    assert "Import completed." in output
    # Project line shows the slug and the project id.
    assert "Project: (networkmanagementclient) — 51600bcd-a740-450b-a339-9ee8a493f10b" in output
    # Version line shows the version id and the version record id.
    assert "Version: 2018-12-01 — 54aa1111-2222-4333-8444-555566667777" in output
    # Never the empty-slug placeholder.
    assert "(  )" not in output
    assert " () " not in output


def test_emit_import_result_human_shows_provenance_filename() -> None:
    """Human mode includes the imported source filename when provenance is present."""
    payload = {
        **_SAMPLE_RESULT,
        "provenance": {
            "sha256": "a" * 64,
            "filename": "petstore.json",
            "importer_version": "0.1.0",
            "imported_on": "2026-06-01T00:00:00Z",
            "duration_ms": 42,
        },
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)

    assert "Source file: petstore.json" in output


def test_emit_import_result_human_shows_path_entity_counts() -> None:
    """Human mode includes OpenAPI path-table counters when present."""
    payload = {
        **_SAMPLE_RESULT,
        "created": {
            **_SAMPLE_RESULT["created"],
            "paths_created": 2,
            "operations_created": 5,
            "shared_params_created": 1,
            "shared_request_bodies_created": 3,
            "shared_responses_created": 4,
        },
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)

    assert "Path templates" in output
    assert "Operations" in output
    assert "Shared parameters" in output
    assert "Shared request bodies" in output
    assert "Shared responses" in output


def test_emit_import_result_human_shows_arazzo_entity_counts() -> None:
    """Human mode includes Arazzo workflow counters when present."""
    payload = {
        **_SAMPLE_RESULT,
        "created": {
            **_SAMPLE_RESULT["created"],
            "workflows_created": 2,
            "steps_created": 5,
        },
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)

    assert "Workflows" in output
    assert "Workflow steps" in output


def test_emit_import_result_human_shows_unresolved_operation_ref_count() -> None:
    """Human mode summarizes non-empty top-level unresolved refs."""
    payload = {
        **_SAMPLE_RESULT,
        "unresolved_operation_refs": [
            "createCart",
            "$sourceDescriptions.openapi#/paths/~1checkout/post",
        ],
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)

    assert "Unresolved operation refs: 2" in output


def test_emit_import_result_human_shows_error_count() -> None:
    """Non-empty errors list is summarized in human output."""
    payload = {
        **_SAMPLE_RESULT,
        "errors": [{"code": "E1", "message": "failed"}],
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)
    assert "Errors: 1" in output


def test_emit_import_result_human_lists_warning_path() -> None:
    """Human output includes JSON Pointer paths when warnings provide them."""
    payload = {
        **_SAMPLE_RESULT,
        "warnings": [
            {
                "code": "schema_default_type_coercion",
                "message": "Schema default '100' was coerced to integer value 100.",
                "path": "/components/parameters/filterLimit/schema/default",
            }
        ],
    }
    output = _capture_human_output(emit_import_result, payload, json_mode=False)

    assert "Warnings (1):" in output
    assert "[schema_default_type_coercion]" in output
    assert "Schema default '100' was coerced" in output
    assert "at /components/parameters/filterLimit/schema/default" in output


def test_merge_import_warnings_appends_local_preparation_findings() -> None:
    """Local preparation warnings are merged into the displayed import result."""
    from apiome_cli.import_.schema_type_coercion import SchemaTypeCoercionWarning

    payload = merge_import_warnings(
        {k: v for k, v in _SAMPLE_RESULT.items() if k != "warnings"},
        [
            SchemaTypeCoercionWarning(
                code="schema_default_type_coercion",
                message="Schema default '100' was coerced to integer value 100.",
                path="/components/parameters/filterLimit/schema/default",
            )
        ],
    )

    warnings = payload["warnings"]
    assert len(warnings) == 1
    assert warnings[0]["code"] == "schema_default_type_coercion"


def test_emit_import_result_dry_run_uses_planned_counts_label() -> None:
    """Dry-run human output labels entity counts as planned, not created."""
    output = _capture_human_output(
        emit_import_result,
        _SAMPLE_RESULT,
        json_mode=False,
        dry_run=True,
    )

    assert "Dry run completed (no changes written)." in output
    assert "Planned entities" in output
    assert "Schemas" in output
    assert "Created entities" not in output
    assert "Import completed." not in output


def test_emit_import_result_omits_counts_when_created_missing() -> None:
    """Human output skips the counts line when ``created`` is absent."""
    payload = {k: v for k, v in _SAMPLE_RESULT.items() if k != "created"}
    output = _capture_human_output(emit_import_result, payload, json_mode=False)
    assert "Created entities" not in output
    assert "Planned entities" not in output


def test_emit_import_job_accepted_json_mode(capsys: pytest.CaptureFixture[str]) -> None:
    """Async accept body is emitted as raw JSON when json_mode is set."""
    emit_import_job_accepted(_JOB_ACCEPTED, json_mode=True)
    out = capsys.readouterr().out.strip()
    assert out == json.dumps(_JOB_ACCEPTED, separators=(",", ":"))


def test_emit_import_job_accepted_human_mode() -> None:
    """Async accept body prints job id and status for humans."""
    output = _capture_echo(
        emit_import_job_accepted,
        _JOB_ACCEPTED,
        json_mode=False,
    )
    assert "Import accepted." in output
    assert "cccccccc-cccc-4ccc-8ccc-cccccccccccc" in output
    assert "Status: pending" in output


def test_emit_json_matches_import_result_json_branch(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``emit_json`` is the same primitive used by import result JSON mode."""
    emit_json(_SAMPLE_RESULT)
    out = capsys.readouterr().out.strip()
    assert json.loads(out) == _SAMPLE_RESULT


def test_emit_json_schema_type_import_result_json_mode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Type import JSON mode emits compact serialized payload."""
    emit_json_schema_type_import_result(_TYPE_IMPORT_RESULT, json_mode=True)
    out = capsys.readouterr().out.strip()
    assert out == json.dumps(_TYPE_IMPORT_RESULT, separators=(",", ":"))


def test_emit_json_schema_type_import_result_human_shows_table_and_counts(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Human mode prints imported types table and summary counts."""
    emit_json_schema_type_import_result(_TYPE_IMPORT_RESULT, json_mode=False)
    captured = capsys.readouterr()
    output = captured.out

    assert "Import completed." in output
    assert "Imported types (2)" in output
    assert "Email" in output
    assert "monetary-amount" in output
    assert "#/$defs/Email" in output
    assert "Created" in output
    assert "Updated" in output
    assert "Skipped" in output


def test_emit_json_schema_type_import_result_dry_run_label() -> None:
    """Dry-run human output uses the dry-run completion message."""
    output = _capture_echo(
        emit_json_schema_type_import_result,
        _TYPE_IMPORT_RESULT,
        json_mode=False,
        dry_run=True,
    )

    assert "Dry run completed (no changes written)." in output
    assert "Import completed." not in output
