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
    load_bulk_payload,
    merge_bulk_results,
    pack_directory,
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
                "document_base64": None,
            },
        ],
        "skipped": [{"path": "README.md", "reason": "no-recognisable-format"}],
        "truncated": False,
        "total_items": 2,
        "max_items": 50,
        "source_label": "specs.zip",
        "git_source": None,
        "summary": {
            "items": 2,
            "importable": 2,
            "unimportable": 0,
            "skipped_files": 1,
            "by_target": {"catalog": 1, "project": 1},
            "by_format": {"asyncapi-2": 1, "openapi-3.0": 1},
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
                "job_id": "job-2",
                "status_path": "/v1/tenants/acme-corp/imports/job-2",
                "error": None,
            },
        ],
        "skipped": [{"path": "README.md", "reason": "no-recognisable-format"}],
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
                "project_id": "p1",
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
                "error": None,
            },
        ],
        "summary": {"total": 2, "completed": 2, "failed": 0, "running": 0, "not_found": 0},
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
