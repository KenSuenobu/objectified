"""End-to-end tests for ``apiome repository refresh`` / ``refresh status`` (RAR-5.6)."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

from helpers import strip_ansi

runner = CliRunner()

_TENANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
_REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_BASE = "http://localhost:8000"

_TENANTS_ME_URL = f"{_BASE}/v1/tenants/me?offset=0&limit=200"
_TENANTS_ME_BODY = {"items": [{"slug": _TENANT_ID}], "total": 1, "offset": 0, "limit": 200}

_REPOSITORIES_URL = f"{_BASE}/v1/tenants/{_TENANT_ID}/repositories?limit=200"
_REPOSITORY_BODY = {
    "items": [{"id": _REPO_ID, "name": "API", "full_name": "acme/api"}],
    "total": 1,
}

_CATALOG_URL = (
    f"{_BASE}/v1/tenants/{_TENANT_ID}/repository-files"
    f"?repository_id={_REPO_ID}&importable_only=true&sort=path&limit=50&offset=0"
)
_SPEC_URL = (
    f"{_BASE}/v1/tenants/{_TENANT_ID}/repository-imports/{_REPO_ID}/spec"
    "?path=openapi.yaml&branch=main"
)
_HISTORY_URL = (
    f"{_BASE}/v1/tenants/{_TENANT_ID}/repositories/{_REPO_ID}/refresh-history?limit=50&offset=0"
)
_REFRESH_URL = f"{_BASE}/v1/tenants/{_TENANT_ID}/repositories/{_REPO_ID}/refresh"
# The refresh flow tracks every branch with a stored spec, so its catalog reads
# carry all_branches=true; the status listing defaults to the default branch.
_REFRESH_CATALOG_URL = f"{_CATALOG_URL}&all_branches=true"

_CATALOG_ROW = {
    "id": "11111111-1111-4111-8111-111111111111",
    "repository_id": _REPO_ID,
    "branch": "main",
    "path": "openapi.yaml",
    "format": "openapi",
    "project_slug": "pet-store",
    "version_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "last_imported_at": "2026-07-30T10:00:00Z",
}


def _catalog_body(match_count: int = 1) -> dict:
    return {
        "success": True,
        "catalog_total": 1,
        "match_count": match_count,
        "limit": 50,
        "offset": 0,
        "sort": "path",
        "specs": [_CATALOG_ROW],
    }


def _spec_body(status: str) -> dict:
    return {
        "spec_schema_version": 1,
        "source_kind": "openapi-3",
        "options": {},
        "last_imported_commit_sha": "abcdef1234567890",
        "refresh_status": status,
        "backfilled": False,
    }


@pytest.fixture
def refresh_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """API key + tenant scope for the repository refresh commands."""
    monkeypatch.setenv("APIOME_API_KEY", "obj_test_workspace_key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    monkeypatch.setenv("APIOME_TENANT_ID", _TENANT_ID)


@pytest.fixture
def api_key_only_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """API key without tenant scope, to exercise the usage guard."""
    monkeypatch.setenv("APIOME_API_KEY", "obj_test_workspace_key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)


def _mock_scope(httpx_mock: object) -> None:
    """Register the tenant-slug and repository-resolution responses."""
    httpx_mock.add_response(url=_TENANTS_ME_URL, json=_TENANTS_ME_BODY)
    httpx_mock.add_response(url=_REPOSITORIES_URL, json=_REPOSITORY_BODY)


def test_refresh_status_requires_api_key() -> None:
    result = runner.invoke(app, ["repository", "refresh", "status", "acme/api"])
    assert result.exit_code == EXIT_USAGE
    assert "API key required" in strip_ansi(result.stderr)


def test_refresh_requires_tenant_scope(api_key_only_env: None) -> None:
    result = runner.invoke(app, ["repository", "refresh", "acme/api"])
    assert result.exit_code == EXIT_USAGE
    assert "Tenant scope required" in strip_ansi(result.stderr)


def test_refresh_status_human_table(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))

    result = runner.invoke(app, ["repository", "refresh", "status", "acme/api"])
    assert result.exit_code == EXIT_SUCCESS
    output = strip_ansi(result.stdout)
    assert "openapi.yaml" in output
    assert "stale" in output
    assert "Refresh state: stale: 1" in output


def test_refresh_status_json_output(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))

    result = runner.invoke(
        app,
        ["repository", "refresh", "status", "acme/api", "--format", "json"],
    )
    assert result.exit_code == EXIT_SUCCESS
    payload = json.loads(result.stdout)
    assert payload["repository"]["full_name"] == "acme/api"
    assert payload["items"][0]["refresh_status"] == "up-to-date"
    assert payload["summary"] == {"up-to-date": 1}


def test_refresh_status_notes_truncated_page(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(
        url=(
            f"{_BASE}/v1/tenants/{_TENANT_ID}/repository-files"
            f"?repository_id={_REPO_ID}&importable_only=true&sort=path&limit=1&offset=0"
        ),
        json={**_catalog_body(match_count=9), "limit": 1},
    )
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))

    result = runner.invoke(
        app,
        ["repository", "refresh", "status", "acme/api", "--limit", "1"],
    )
    assert result.exit_code == EXIT_SUCCESS
    assert "Showing the first 1 of 9 catalog rows" in strip_ansi(result.stderr)


def test_refresh_status_rejects_out_of_range_limit(refresh_env: None) -> None:
    result = runner.invoke(
        app,
        ["repository", "refresh", "status", "acme/api", "--limit", "0"],
    )
    assert result.exit_code == EXIT_USAGE
    assert "--limit must be between 1 and 500." in strip_ansi(result.stderr)


def test_refresh_status_rejects_unknown_format(refresh_env: None) -> None:
    result = runner.invoke(
        app,
        ["repository", "refresh", "status", "acme/api", "--format", "yaml"],
    )
    assert result.exit_code == EXIT_USAGE
    assert "--format must be 'table' or 'json'." in strip_ansi(result.stderr)


def test_refresh_no_wait_reports_enqueue_counts(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 2, "skipped": 1, "branches": ["main"]},
    )

    result = runner.invoke(app, ["repository", "refresh", "acme/api", "--no-wait"])
    assert result.exit_code == EXIT_SUCCESS
    output = strip_ansi(result.stdout)
    assert "Refresh requested." in output
    assert "Enqueued: 2" in output
    assert "Branches: main" in output


def test_refresh_reports_freshness_no_op(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 0, "skipped": 1, "branches": ["main"]},
    )

    result = runner.invoke(app, ["repository", "refresh", "acme/api"])
    assert result.exit_code == EXIT_SUCCESS
    assert "nothing to refresh" in strip_ansi(result.stdout)


def test_refresh_waits_for_the_file_to_settle(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    # Pre-trigger snapshot: one stale lineage is the refresh target.
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(
        url=f"{_HISTORY_URL}&path=openapi.yaml",
        json={"items": [{"id": "cycle-0"}]},
    )
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={"path": "openapi.yaml"},
        json={"success": True, "enqueued": 1, "skipped": 0, "branches": ["main"]},
    )
    # First (and only) poll: the anchors have moved forward.
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))
    httpx_mock.add_response(
        url=f"{_HISTORY_URL}&path=openapi.yaml",
        json={
            "items": [
                {
                    "id": "cycle-1",
                    "branch": "main",
                    "path": "openapi.yaml",
                    "outcome": "new-version",
                    "changeReportId": "cr-9",
                },
                {"id": "cycle-0"},
            ]
        },
    )

    result = runner.invoke(
        app,
        [
            "--no-progress",
            "repository",
            "refresh",
            "acme/api",
            "--path",
            "openapi.yaml",
            "--poll-interval",
            "0.1",
        ],
    )
    assert result.exit_code == EXIT_SUCCESS
    output = strip_ansi(result.stdout)
    assert "Enqueued: 1" in output
    assert "up-to-date" in output
    assert "openapi.yaml: new-version (change report cr-9)" in output


def test_refresh_exits_non_zero_on_a_failed_cycle(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 1, "skipped": 0, "branches": ["main"]},
    )
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("failed"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})

    result = runner.invoke(
        app,
        ["--no-progress", "repository", "refresh", "acme/api", "--poll-interval", "0.1"],
    )
    assert result.exit_code == EXIT_ERROR
    assert "failed" in strip_ansi(result.stdout)


def test_refresh_wait_json_envelope(httpx_mock: object, refresh_env: None) -> None:
    _mock_scope(httpx_mock)
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 1, "skipped": 0, "branches": ["main"]},
    )
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("diverged"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})

    result = runner.invoke(
        app,
        [
            "--no-progress",
            "--json",
            "repository",
            "refresh",
            "acme/api",
            "--poll-interval",
            "0.1",
        ],
    )
    assert result.exit_code == EXIT_SUCCESS
    payload = json.loads(result.stdout)
    assert payload["refresh"]["enqueued"] == 1
    assert payload["items"][0]["refresh_status"] == "diverged"
    assert payload["summary"] == {"diverged": 1}
    assert payload["cycles"] == []


def test_refresh_unknown_repository_is_a_usage_error(
    httpx_mock: object,
    refresh_env: None,
) -> None:
    httpx_mock.add_response(url=_TENANTS_ME_URL, json=_TENANTS_ME_BODY)
    httpx_mock.add_response(url=_REPOSITORIES_URL, json={"items": [], "total": 0})

    result = runner.invoke(app, ["repository", "refresh", "acme/missing", "--no-wait"])
    assert result.exit_code == EXIT_USAGE
    assert "Repository not found: acme/missing" in strip_ansi(result.stderr)


def test_repository_group_help_lists_refresh() -> None:
    result = runner.invoke(app, ["repository", "--help"])
    assert result.exit_code == EXIT_SUCCESS
    assert "refresh" in strip_ansi(result.stdout)


def test_refresh_group_help_lists_status() -> None:
    result = runner.invoke(app, ["repository", "refresh", "--help"])
    assert result.exit_code == EXIT_SUCCESS
    assert "status" in strip_ansi(result.stdout)


def test_refresh_notes_enqueued_work_it_cannot_track(
    httpx_mock: object,
    refresh_env: None,
) -> None:
    """Jobs enqueued for lineages outside the tracked page are reported, not waited on."""
    _mock_scope(httpx_mock)
    # Nothing pending on the tracked page, yet the server enqueued work anyway.
    httpx_mock.add_response(url=_REFRESH_CATALOG_URL, json=_catalog_body())
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 3, "skipped": 0, "branches": ["main", "dev"]},
    )

    result = runner.invoke(app, ["repository", "refresh", "acme/api"])
    assert result.exit_code == EXIT_SUCCESS
    assert "Enqueued: 3" in strip_ansi(result.stdout)
    assert "outside the tracked listing" in strip_ansi(result.stderr)
