"""End-to-end tests for ``apiome import auto --bulk`` (MFI-29.5, #4392).

The command makes three REST calls — plan, submit, status — against a mocked service.
What is asserted here is the batch contract from the caller's side: a directory is
packed deterministically, every independent spec becomes its own row, a failed item
does not stop the others, and the exit code tells CI which kind of failure happened.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_POLICY_BLOCKED, EXIT_USAGE
from apiome_cli.import_.bulk import (
    bulk_exit_code,
    destination_summary_line,
    emit_bulk_plan,
    emit_bulk_results,
    load_bulk_payload,
    merge_bulk_results,
    pack_directory,
    parse_override,
    parse_overrides,
    resolution_summary_line,
)
from apiome_cli.main import app

runner = CliRunner()

_BASE = "http://localhost:8000"
_PLAN_URL = f"{_BASE}/v1/tenants/acme-corp/import/bulk/plan"
_SUBMIT_URL = f"{_BASE}/v1/tenants/acme-corp/import/bulk"
_STATUS_URL = f"{_BASE}/v1/tenants/acme-corp/import/bulk/status"

_OPENAPI = "openapi: 3.0.3\ninfo:\n  title: Orders API\n  version: 1.0.0\npaths: {}\n"
_ASYNCAPI = "asyncapi: 2.6.0\ninfo:\n  title: Orders Events\n  version: 1.0.0\nchannels: {}\n"


@pytest.fixture(autouse=True)
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-import-key")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _specs_dir(tmp_path: Path) -> Path:
    root = tmp_path / "specs"
    (root / "openapi").mkdir(parents=True)
    (root / "events").mkdir(parents=True)
    (root / "openapi" / "orders.yaml").write_text(_OPENAPI, encoding="utf-8")
    (root / "events" / "orders.asyncapi.yaml").write_text(_ASYNCAPI, encoding="utf-8")
    (root / "README.md").write_text("# specs\n", encoding="utf-8")
    return root


def _plan_response(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "items": [
            {
                "key": "events/orders.asyncapi.yaml",
                "root_path": "events/orders.asyncapi.yaml",
                "members": ["events/orders.asyncapi.yaml"],
                "total_bytes": 96,
                "source_kind": "asyncapi",
                "format": "asyncapi-2",
                "confidence": 0.98,
                "importable": True,
                "predicted_target": "catalog",
                "input_kind": "file",
                "suggested_name": "Orders Events",
                "suggested_slug": "orders-events",
                "reason": "independent document",
                "resolution": "append-version",
                "matched_project": {
                    "project_id": "p-1",
                    "name": "Orders Events",
                    "slug": "orders-events",
                },
                "match_basis": "repository-provenance",
                "match_detail": "A previous import of this path created Orders Events.",
                "match_confidence": 1.0,
                "proposed_version": {
                    "version_id": "1.1.0",
                    "derived_from": "version-bump",
                    "previous_version_id": "1.0.0",
                },
                "document_base64": None,
            },
            {
                "key": "openapi/orders.yaml",
                "root_path": "openapi/orders.yaml",
                "members": ["openapi/orders.yaml"],
                "total_bytes": 88,
                "source_kind": "openapi",
                "format": "openapi-3.0",
                "confidence": 0.99,
                "importable": True,
                "predicted_target": "project",
                "input_kind": "file",
                "suggested_name": "Orders API",
                "suggested_slug": "orders-api",
                "reason": "independent document",
                "resolution": "create-project",
                "matched_project": None,
                "match_basis": None,
                "match_detail": None,
                "match_confidence": None,
                "proposed_version": {
                    "version_id": "1.0.0",
                    "derived_from": "default",
                    "previous_version_id": None,
                },
                "document_base64": None,
            },
        ],
        "skipped": [{"path": "README.md", "reason": "no-recognisable-format"}],
        "truncated": False,
        "total_items": 2,
        "max_items": 50,
        "source_label": "specs.zip",
        "git_source": None,
        "version_policy": "append-when-matched",
        "version_policy_source": "default",
        "plan_fingerprint": "bp1.reviewed-plan",
        "summary": {
            "items": 2,
            "importable": 2,
            "unimportable": 0,
            "skipped_files": 1,
            "by_target": {"catalog": 1, "project": 1},
            "by_format": {"asyncapi-2": 1, "openapi-3.0": 1},
            "by_resolution": {"append-version": 1, "create-project": 1},
            "matched": 1,
        },
    }
    body.update(overrides)
    return body


def _start_response(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "batch_id": "batch-1",
        "items": [
            {
                "key": "events/orders.asyncapi.yaml",
                "root_path": "events/orders.asyncapi.yaml",
                "source_kind": "asyncapi",
                "format": "asyncapi-2",
                "predicted_target": "catalog",
                "name": "Orders Events",
                "slug": "orders-events",
                "state": "accepted",
                "resolution": "append-version",
                "target_project_id": "p-1",
                "version_id": "1.1.0",
                "overridden": False,
                "resolution_detail": "Appends version 1.1.0 to Orders Events.",
                "job_id": "job-1",
                "status_path": "/v1/tenants/acme-corp/imports/job-1",
                "error": None,
            },
            {
                "key": "openapi/orders.yaml",
                "root_path": "openapi/orders.yaml",
                "source_kind": "openapi",
                "format": "openapi-3.0",
                "predicted_target": "project",
                "name": "Orders API",
                "slug": "orders-api",
                "state": "accepted",
                "resolution": "create-project",
                "target_project_id": None,
                "version_id": "1.0.0",
                "overridden": False,
                "resolution_detail": "Creates project 'orders-api' at version 1.0.0.",
                "job_id": "job-2",
                "status_path": "/v1/tenants/acme-corp/imports/job-2",
                "error": None,
            },
        ],
        "skipped": [{"path": "README.md", "reason": "no-recognisable-format"}],
        "dry_run": False,
        "summary": {"requested": 2, "accepted": 2, "failed": 0},
    }
    body.update(overrides)
    return body


def _status_response(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "items": [
            {
                "key": "events/orders.asyncapi.yaml",
                "job_id": "job-1",
                "state": "completed",
                "percent": 100,
                "target": "catalog",
                "project_slug": "orders-events",
                "project_id": "p-1",
                "version_id": "1.1.0",
                "outcome": "version-appended",
                "error": None,
            },
            {
                "key": "openapi/orders.yaml",
                "job_id": "job-2",
                "state": "completed",
                "percent": 100,
                "target": "project",
                "project_slug": "orders-api",
                "project_id": "p2",
                "version_id": "1.0.0",
                "outcome": "project-created",
                "error": None,
            },
        ],
        "summary": {
            "total": 2,
            "completed": 2,
            "failed": 0,
            "running": 0,
            "not_found": 0,
            "created": 1,
            "appended": 1,
        },
        "done": True,
    }
    body.update(overrides)
    return body


def _mock_batch(
    httpx_mock: Any,
    *,
    plan: dict[str, Any] | None = None,
    start: dict[str, Any] | None = None,
    status: dict[str, Any] | None = None,
) -> None:
    httpx_mock.add_response(url=_PLAN_URL, method="POST", json=plan or _plan_response())
    httpx_mock.add_response(url=_SUBMIT_URL, method="POST", json=start or _start_response())
    if status is not False:  # type: ignore[comparison-overlap]
        httpx_mock.add_response(
            url=_STATUS_URL, method="POST", json=status or _status_response()
        )


def _recorded_body(httpx_mock: Any, url: str) -> dict[str, Any]:
    for request in httpx_mock.get_requests():
        if request.method == "POST" and str(request.url) == url:
            return json.loads(request.content.decode("utf-8"))
    raise AssertionError(f"no POST recorded for {url}")


# --------------------------------------------------------------------------- command


def test_imports_every_independent_spec_in_a_directory(httpx_mock: Any, tmp_path: Path) -> None:
    _mock_batch(httpx_mock)

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert result.exit_code == 0, result.output
    assert "Orders API" in result.output
    assert "Bulk import: 2 imported" in result.output


def test_packs_the_directory_into_the_payload_both_calls_share(
    httpx_mock: Any, tmp_path: Path
) -> None:
    _mock_batch(httpx_mock)

    runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    planned = _recorded_body(httpx_mock, _PLAN_URL)
    submitted = _recorded_body(httpx_mock, _SUBMIT_URL)
    assert planned["filename"] == "specs.zip"
    # Re-planning server-side only works if the submit sends identical bytes.
    assert submitted["document_base64"] == planned["document_base64"]
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(planned["document_base64"]))) as archive:
        assert sorted(archive.namelist()) == [
            "README.md",
            "events/orders.asyncapi.yaml",
            "openapi/orders.yaml",
        ]


def test_polls_only_the_items_that_started(httpx_mock: Any, tmp_path: Path) -> None:
    _mock_batch(httpx_mock)

    runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert _recorded_body(httpx_mock, _STATUS_URL) == {
        "items": [
            {"key": "events/orders.asyncapi.yaml", "job_id": "job-1"},
            {"key": "openapi/orders.yaml", "job_id": "job-2"},
        ]
    }


def test_forwards_the_dry_run_flag(httpx_mock: Any, tmp_path: Path) -> None:
    _mock_batch(httpx_mock)

    result = runner.invoke(
        app, ["import", "auto", "--bulk", "--dry-run", str(_specs_dir(tmp_path))]
    )

    assert _recorded_body(httpx_mock, _SUBMIT_URL)["dry_run"] is True
    assert "2 validated" in result.output


def test_a_failed_item_does_not_stop_the_others(httpx_mock: Any, tmp_path: Path) -> None:
    start = _start_response()
    start["items"][1] = {
        **start["items"][1],
        "state": "failed",
        "job_id": None,
        "status_path": None,
        "error": {
            "code": "QUALITY_POLICY_BLOCKED",
            "category": "policy",
            "message": "Import scores D, below the tenant floor of B.",
            "remediation": "Fix the findings or request a waiver.",
            "retriable": False,
        },
    }
    start["summary"] = {"requested": 2, "accepted": 1, "failed": 1}
    status = _status_response()
    status["items"] = [status["items"][0]]
    status["summary"] = {"total": 1, "completed": 1, "failed": 0, "running": 0, "not_found": 0}
    _mock_batch(httpx_mock, start=start, status=status)

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert result.exit_code == EXIT_POLICY_BLOCKED, result.output
    assert "QUALITY_POLICY_BLOCKED" in result.output
    assert "1 imported" in result.output
    assert "1 failed" in result.output
    # The item that could import still did.
    assert _recorded_body(httpx_mock, _STATUS_URL)["items"] == [
        {"key": "events/orders.asyncapi.yaml", "job_id": "job-1"}
    ]


def test_a_failed_job_exits_with_its_taxonomy_code(httpx_mock: Any, tmp_path: Path) -> None:
    status = _status_response()
    status["items"][1] = {
        **status["items"][1],
        "state": "failed",
        "project_slug": None,
        "error": {
            "code": "PARSE_FAILED",
            "category": "format",
            "message": "The document could not be parsed.",
            "remediation": "Fix the syntax error.",
            "retriable": False,
        },
    }
    status["summary"] = {"total": 2, "completed": 1, "failed": 1, "running": 0, "not_found": 0}
    _mock_batch(httpx_mock, status=status)

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert result.exit_code == EXIT_USAGE, result.output
    assert "PARSE_FAILED" in result.output


def test_json_mode_emits_the_result_rows(httpx_mock: Any, tmp_path: Path) -> None:
    _mock_batch(httpx_mock)

    result = runner.invoke(
        app, ["--json", "import", "auto", "--bulk", str(_specs_dir(tmp_path))]
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert [row["key"] for row in payload["items"]] == [
        "events/orders.asyncapi.yaml",
        "openapi/orders.yaml",
    ]
    assert payload["items"][1]["project_slug"] == "orders-api"


def test_no_wait_reports_the_started_jobs_without_polling(
    httpx_mock: Any, tmp_path: Path
) -> None:
    httpx_mock.add_response(url=_PLAN_URL, method="POST", json=_plan_response())
    httpx_mock.add_response(url=_SUBMIT_URL, method="POST", json=_start_response())

    result = runner.invoke(
        app, ["import", "auto", "--bulk", "--no-wait", str(_specs_dir(tmp_path))]
    )

    assert result.exit_code == 0, result.output
    assert "started" in result.output
    assert not [
        request
        for request in httpx_mock.get_requests()
        if str(request.url) == _STATUS_URL
    ]


def test_a_payload_with_no_importable_spec_is_a_usage_error(
    httpx_mock: Any, tmp_path: Path
) -> None:
    httpx_mock.add_response(
        url=_PLAN_URL,
        method="POST",
        json=_plan_response(
            items=[],
            total_items=0,
            summary={
                "items": 0,
                "importable": 0,
                "unimportable": 0,
                "skipped_files": 1,
                "by_target": {},
                "by_format": {},
            },
        ),
    )

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert result.exit_code == EXIT_USAGE
    assert "No importable specs" in result.output


def test_a_single_document_is_refused_with_the_single_import_hint(tmp_path: Path) -> None:
    document = tmp_path / "openapi.yaml"
    document.write_text(_OPENAPI, encoding="utf-8")

    result = runner.invoke(app, ["import", "auto", "--bulk", str(document)])

    assert result.exit_code == EXIT_USAGE
    assert "apiome import auto" in result.output


def test_a_missing_path_is_a_usage_error(tmp_path: Path) -> None:
    result = runner.invoke(app, ["import", "auto", "--bulk", str(tmp_path / "nope")])

    assert result.exit_code == EXIT_USAGE


# --------------------------------------------------------------------------- packing


def test_pack_directory_skips_what_cannot_be_imported(tmp_path: Path) -> None:
    root = _specs_dir(tmp_path)
    (root / ".hidden.yaml").write_text("x: 1\n", encoding="utf-8")
    (root / "logo.png").write_bytes(b"\x89PNG\r\n")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "pkg.yaml").write_text("x: 1\n", encoding="utf-8")

    payload = pack_directory(str(root))

    with zipfile.ZipFile(io.BytesIO(payload.document)) as archive:
        names = archive.namelist()
    assert ".hidden.yaml" not in names
    assert "logo.png" not in names
    assert "node_modules/pkg.yaml" not in names
    assert dict(payload.skipped)["logo.png"] == "binary-file"


def test_pack_directory_is_byte_stable(tmp_path: Path) -> None:
    root = _specs_dir(tmp_path)

    assert pack_directory(str(root)).document == pack_directory(str(root)).document


def test_pack_directory_rejects_an_empty_tree(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()

    with pytest.raises(ValueError):
        pack_directory(str(empty))


def test_load_bulk_payload_reads_an_archive_verbatim(tmp_path: Path) -> None:
    archive_path = tmp_path / "specs.zip"
    packed = pack_directory(str(_specs_dir(tmp_path)))
    archive_path.write_bytes(packed.document)

    payload = load_bulk_payload(str(archive_path))

    assert payload.document == packed.document
    assert payload.filename == "specs.zip"
    assert payload.skipped == []


# --------------------------------------------------------------------------- rendering


def test_merge_results_uses_the_start_error_for_items_that_never_started() -> None:
    start = _start_response()
    start["items"][0] = {
        **start["items"][0],
        "state": "failed",
        "job_id": None,
        "error": {
            "code": "FORMAT_UNRECOGNIZED",
            "category": "format",
            "message": "No adapter can import it.",
            "remediation": "Convert it first.",
            "retriable": False,
        },
    }

    rows = merge_bulk_results(start, {"items": [], "done": True})

    assert rows[0]["state"] == "failed"
    assert "FORMAT_UNRECOGNIZED" in rows[0]["detail"]
    assert rows[1]["state"] == "accepted"


def test_exit_code_is_success_only_when_every_item_completed() -> None:
    completed = [{"state": "completed"}, {"state": "completed"}]
    running = [{"state": "completed"}, {"state": "running"}]
    policy = [{"state": "failed", "error": {"category": "policy"}}]
    transport = [{"state": "failed", "error": {"category": "transport"}}]

    assert bulk_exit_code(completed) == 0
    assert bulk_exit_code(running) == EXIT_ERROR
    assert bulk_exit_code(policy) == EXIT_POLICY_BLOCKED
    assert bulk_exit_code(transport) == EXIT_ERROR


# --------------------------------------------------------------- plan rendering (BLK-1.2)


def test_the_plan_table_shows_what_each_item_would_do(capsys: Any) -> None:
    """Without the resolution columns the table describes an empty tenant."""
    emit_bulk_plan(_plan_response(), json_mode=False)

    out = capsys.readouterr().out
    assert "Resolution" in out and "Existing" in out and "Version" in out
    assert "append-version" in out and "create-project" in out
    # The project the re-imported item lands in, and the label it would take.
    assert "orders-events" in out and "1.1.0" in out


def test_the_summary_line_leads_with_the_reconciliation_counts() -> None:
    assert resolution_summary_line(_plan_response()) == (
        "Reconciled against existing projects: 1 new version, 1 new project."
    )


def test_always_create_says_how_many_matches_it_is_ignoring() -> None:
    plan = _plan_response(version_policy="always-create", version_policy_source="tenant")
    plan["summary"] = {**plan["summary"], "by_resolution": {"create-project": 2}, "matched": 1}

    line = resolution_summary_line(plan)

    assert "2 new projects" in line
    assert "'always-create' is ignoring 1 match(es)" in line


def test_always_ask_says_a_choice_is_needed() -> None:
    plan = _plan_response(version_policy="always-ask", version_policy_source="tenant")
    plan["summary"] = {**plan["summary"], "by_resolution": {"unresolved": 2}, "matched": 1}

    line = resolution_summary_line(plan)

    assert "2 needing a choice" in line
    assert "'always-ask' needs a per-item choice" in line


def test_a_plan_from_a_server_without_reconciliation_counts_renders_without_the_line() -> None:
    """The CLI ships ahead of some deployments; a missing block must not raise."""
    plan = _plan_response()
    plan["summary"] = {"items": 2, "importable": 2, "unimportable": 0, "skipped_files": 1}

    assert resolution_summary_line(plan) == ""


def test_the_plan_table_tolerates_items_with_no_reconciliation_block(capsys: Any) -> None:
    plan = _plan_response()
    plan["items"] = [
        {key: value for key, value in item.items() if not key.startswith(("resolution", "match", "proposed"))}
        for item in plan["items"]
    ]

    emit_bulk_plan(plan, json_mode=False)

    assert "Orders API" in capsys.readouterr().out


# ------------------------------------------------- overrides and verify (BLK-1.3)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("specs/orders.yaml=new", {"key": "specs/orders.yaml", "mode": "new"}),
        ("specs/orders.yaml=existing", {"key": "specs/orders.yaml", "mode": "existing"}),
        ("specs/orders.yaml=create", {"key": "specs/orders.yaml", "mode": "new"}),
        ("specs/orders.yaml=append", {"key": "specs/orders.yaml", "mode": "existing"}),
        (
            "specs/orders.yaml=existing:p-9",
            {"key": "specs/orders.yaml", "mode": "existing", "project_id": "p-9"},
        ),
        (
            "specs/orders.yaml=:p-9",
            {"key": "specs/orders.yaml", "mode": "existing", "project_id": "p-9"},
        ),
        (
            "specs/orders.yaml=existing:p-9@2.0.0",
            {
                "key": "specs/orders.yaml",
                "mode": "existing",
                "project_id": "p-9",
                "version_id": "2.0.0",
            },
        ),
        (
            "specs/orders.yaml=new@0.9.0",
            {"key": "specs/orders.yaml", "mode": "new", "version_id": "0.9.0"},
        ),
        ("specs/orders.yaml=@2.1.0", {"key": "specs/orders.yaml", "version_id": "2.1.0"}),
        (" specs/orders.yaml = NEW ", {"key": "specs/orders.yaml", "mode": "new"}),
    ],
)
def test_parse_override_reads_the_shapes_a_reviewer_types(value: str, expected: dict) -> None:
    assert parse_override(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "specs/orders.yaml",
        "=new",
        "specs/orders.yaml=",
        "specs/orders.yaml=maybe",
        "specs/orders.yaml=new:p-9",
    ],
)
def test_parse_override_refuses_what_it_cannot_act_on(value: str) -> None:
    with pytest.raises(ValueError):
        parse_override(value)


def test_two_decisions_for_one_item_are_refused() -> None:
    with pytest.raises(ValueError, match="overridden twice"):
        parse_overrides(["a.yaml=new", "a.yaml=existing"])


def test_overrides_reach_the_submit_as_per_item_decisions(
    httpx_mock: Any, tmp_path: Path
) -> None:
    _mock_batch(httpx_mock)

    result = runner.invoke(
        app,
        [
            "import",
            "auto",
            "--bulk",
            "--override",
            "openapi/orders.yaml=existing:p-9@2.0.0",
            "--override",
            "events/orders.asyncapi.yaml=new",
            str(_specs_dir(tmp_path)),
        ],
    )

    assert result.exit_code == 0, result.output
    assert _recorded_body(httpx_mock, _SUBMIT_URL)["overrides"] == [
        {
            "key": "openapi/orders.yaml",
            "mode": "existing",
            "project_id": "p-9",
            "version_id": "2.0.0",
        },
        {"key": "events/orders.asyncapi.yaml", "mode": "new"},
    ]


def test_a_batch_with_no_overrides_sends_none(httpx_mock: Any, tmp_path: Path) -> None:
    """Agreeing with the plan must stay a one-command apply."""
    _mock_batch(httpx_mock)

    runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert "overrides" not in _recorded_body(httpx_mock, _SUBMIT_URL)


def test_a_malformed_override_is_a_usage_error_before_anything_is_sent(
    httpx_mock: Any, tmp_path: Path
) -> None:
    result = runner.invoke(
        app,
        ["import", "auto", "--bulk", "--override", "nonsense", str(_specs_dir(tmp_path))],
    )

    assert result.exit_code == EXIT_USAGE
    assert "not an override" in result.output
    assert httpx_mock.get_requests() == []


def test_override_without_bulk_is_a_usage_error(tmp_path: Path) -> None:
    document = tmp_path / "orders.yaml"
    document.write_text(_OPENAPI, encoding="utf-8")

    result = runner.invoke(
        app, ["import", "auto", "--override", "a=new", str(document)]
    )

    assert result.exit_code == EXIT_USAGE
    assert "--bulk" in result.output


def test_the_plan_fingerprint_is_echoed_on_the_apply(httpx_mock: Any, tmp_path: Path) -> None:
    _mock_batch(httpx_mock)

    runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert _recorded_body(httpx_mock, _SUBMIT_URL)["plan_fingerprint"] == "bp1.reviewed-plan"


def test_a_stale_plan_is_reported_with_the_drift_and_nothing_imported(
    httpx_mock: Any, tmp_path: Path
) -> None:
    httpx_mock.add_response(url=_PLAN_URL, method="POST", json=_plan_response())
    httpx_mock.add_response(
        url=_SUBMIT_URL,
        method="POST",
        status_code=409,
        json={
            "detail": {
                "code": "TARGET_PLAN_STALE",
                "category": "input",
                "message": "The plan you reviewed no longer describes this batch: 1 item(s) changed.",
                "remediation": "Re-plan the payload.",
                "retriable": True,
                "drift": [
                    {
                        "key": "openapi/orders.yaml",
                        "change": "resolution",
                        "reviewed": "create-project at 1.0.0",
                        "current": "append-version onto project p-4 at 1.1.0",
                        "detail": "'openapi/orders.yaml' would do something different now.",
                    }
                ],
            }
        },
    )

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert result.exit_code == EXIT_USAGE
    assert "no longer describes this batch" in result.output
    assert "openapi/orders.yaml" in result.output
    assert "Nothing was imported" in result.output
    # The batch stopped at the submit: no status poll was made.
    assert not any(str(request.url) == _STATUS_URL for request in httpx_mock.get_requests())


def test_the_result_table_names_what_each_item_was_applied_as(
    httpx_mock: Any, tmp_path: Path
) -> None:
    _mock_batch(httpx_mock)

    result = runner.invoke(app, ["import", "auto", "--bulk", str(_specs_dir(tmp_path))])

    assert "Action" in result.output and "Version" in result.output
    assert "append" in result.output and "create" in result.output
    assert "Destinations: 1 new version, 1 new project." in result.output


def test_a_dry_run_states_the_resolutions_it_would_apply(
    httpx_mock: Any, tmp_path: Path
) -> None:
    start = _start_response(dry_run=True)
    _mock_batch(httpx_mock, start=start)

    result = runner.invoke(
        app, ["import", "auto", "--bulk", "--dry-run", str(_specs_dir(tmp_path))]
    )

    assert "Appends version 1.1.0 to Orders Events." in result.output
    assert "2 validated" in result.output


def test_the_destination_line_prefers_what_actually_happened() -> None:
    realized = [
        {"state": "completed", "resolution": "create-project", "outcome": "version-appended"},
        {"state": "completed", "resolution": "create-project", "outcome": "version-appended"},
    ]

    assert destination_summary_line(realized) == "Destinations: 2 new versions."


def test_the_destination_line_falls_back_to_what_was_started() -> None:
    planned = [
        {"state": "accepted", "resolution": "append-version", "outcome": None},
        {"state": "accepted", "resolution": "create-project", "outcome": None},
        {"state": "failed", "resolution": None, "outcome": None},
    ]

    assert destination_summary_line(planned) == "Destinations: 1 new version, 1 new project."


def test_the_destination_line_is_empty_when_nothing_got_that_far() -> None:
    assert destination_summary_line([{"state": "failed", "resolution": None}]) == ""


def test_results_from_a_server_without_the_apply_fields_still_render(capsys: Any) -> None:
    """The CLI ships ahead of some deployments; missing BLK-1.3 fields must not raise."""
    started = {
        "items": [
            {
                "key": "a.yaml",
                "state": "accepted",
                "job_id": "job-1",
                "predicted_target": "project",
            }
        ]
    }

    rows = merge_bulk_results(started, None)
    emit_bulk_results(rows, json_mode=False, dry_run=False)

    assert rows[0]["resolution"] is None
    assert "a.yaml" in capsys.readouterr().out
