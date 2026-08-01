"""Tests for the REST calls behind ``apiome repository refresh`` (RAR-5.6)."""

from __future__ import annotations

import pytest
import typer

from apiome_cli.client.http import RestClient
from apiome_cli.client.repository_refresh import (
    fetch_refresh_history,
    fetch_status_rows,
    history_entry_ids,
    resolve_repository,
    trigger_refresh,
    wait_for_refresh,
)
from apiome_cli.config import CliSettings
from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE

_TENANT = "acme"
_REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_BASE = "http://localhost:8000"
_CATALOG_URL = (
    f"{_BASE}/v1/tenants/{_TENANT}/repository-files"
    f"?repository_id={_REPO_ID}&importable_only=true&sort=path&limit=50&offset=0"
)
_SPEC_URL = (
    f"{_BASE}/v1/tenants/{_TENANT}/repository-imports/{_REPO_ID}/spec"
    "?path=openapi.yaml&branch=main"
)
_HISTORY_URL = (
    f"{_BASE}/v1/tenants/{_TENANT}/repositories/{_REPO_ID}/refresh-history?limit=50&offset=0"
)
_REFRESH_URL = f"{_BASE}/v1/tenants/{_TENANT}/repositories/{_REPO_ID}/refresh"

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

_DISCOVERED_ROW = {
    "id": "22222222-2222-4222-8222-222222222222",
    "repository_id": _REPO_ID,
    "branch": "main",
    "path": "never-imported.yaml",
    "format": "openapi",
}


def _catalog_body(rows: list[dict[str, object]], *, match_count: int | None = None) -> dict:
    return {
        "success": True,
        "catalog_total": len(rows),
        "match_count": len(rows) if match_count is None else match_count,
        "limit": 50,
        "offset": 0,
        "sort": "path",
        "specs": rows,
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
def client() -> RestClient:
    """REST client pointed at the mocked local service."""
    return RestClient(CliSettings(base_url=_BASE), timeout=30.0)


def test_resolve_repository_by_uuid(httpx_mock: object, client: RestClient) -> None:
    httpx_mock.add_response(
        url=f"{_BASE}/v1/tenants/{_TENANT}/repositories/{_REPO_ID}",
        json={"success": True, "repository": {"id": _REPO_ID, "full_name": "acme/api"}},
    )
    record = resolve_repository(client, _TENANT, _REPO_ID)
    assert record["id"] == _REPO_ID


def test_resolve_repository_by_full_name(httpx_mock: object, client: RestClient) -> None:
    httpx_mock.add_response(
        url=f"{_BASE}/v1/tenants/{_TENANT}/repositories?limit=200",
        json={
            "items": [
                {"id": _REPO_ID, "name": "API", "full_name": "acme/api"},
                {"id": "other", "name": "Docs", "full_name": "acme/docs"},
            ],
            "total": 2,
        },
    )
    record = resolve_repository(client, _TENANT, "ACME/API")
    assert record["id"] == _REPO_ID


def test_resolve_repository_reports_ambiguous_name(
    httpx_mock: object,
    client: RestClient,
    capsys: pytest.CaptureFixture[str],
) -> None:
    httpx_mock.add_response(
        url=f"{_BASE}/v1/tenants/{_TENANT}/repositories?limit=200",
        json={
            "items": [
                {"id": "one", "name": "API", "full_name": "acme/api"},
                {"id": "two", "name": "API", "full_name": "beta/api"},
            ],
            "total": 2,
        },
    )
    with pytest.raises(typer.Exit) as exc_info:
        resolve_repository(client, _TENANT, "API")
    assert exc_info.value.exit_code == EXIT_USAGE
    assert "matches 2 repositories" in capsys.readouterr().err


def test_resolve_repository_reports_unknown_name(
    httpx_mock: object,
    client: RestClient,
    capsys: pytest.CaptureFixture[str],
) -> None:
    httpx_mock.add_response(
        url=f"{_BASE}/v1/tenants/{_TENANT}/repositories?limit=200",
        json={"items": [], "total": 0},
    )
    with pytest.raises(typer.Exit) as exc_info:
        resolve_repository(client, _TENANT, "acme/missing")
    assert exc_info.value.exit_code == EXIT_USAGE
    assert "Repository not found" in capsys.readouterr().err


def test_resolve_repository_rejects_blank_reference(
    client: RestClient,
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(typer.Exit) as exc_info:
        resolve_repository(client, _TENANT, "   ")
    assert exc_info.value.exit_code == EXIT_USAGE
    assert "must not be empty" in capsys.readouterr().err


def test_fetch_status_rows_joins_catalog_and_spec(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    rows, match_count = fetch_status_rows(client, _TENANT, _REPO_ID)
    assert match_count == 1
    assert rows == [
        {
            "path": "openapi.yaml",
            "branch": "main",
            "refresh_status": "stale",
            "source_kind": "openapi-3",
            "format": "openapi",
            "project_slug": "pet-store",
            "project_name": None,
            "version_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "last_imported_at": "2026-07-30T10:00:00Z",
            "last_imported_commit_sha": "abcdef1234567890",
            "backfilled": False,
            "file_id": "11111111-1111-4111-8111-111111111111",
        }
    ]


def test_fetch_status_rows_skips_files_without_an_import(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(
        url=_CATALOG_URL,
        json=_catalog_body([_CATALOG_ROW, _DISCOVERED_ROW]),
    )
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))
    rows, _match_count = fetch_status_rows(client, _TENANT, _REPO_ID)
    assert [row["path"] for row in rows] == ["openapi.yaml"]


def test_fetch_status_rows_degrades_when_spec_is_missing(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, status_code=404, json={"detail": "not found"})
    rows, _match_count = fetch_status_rows(client, _TENANT, _REPO_ID)
    assert rows[0]["refresh_status"] == "unknown"


def test_fetch_status_rows_filters_by_path_and_branch(
    httpx_mock: object,
    client: RestClient,
) -> None:
    other_branch = {**_CATALOG_ROW, "branch": "dev"}
    httpx_mock.add_response(
        url=(
            f"{_BASE}/v1/tenants/{_TENANT}/repository-files"
            f"?repository_id={_REPO_ID}&importable_only=true&sort=path"
            "&limit=50&offset=0&all_branches=true"
        ),
        json=_catalog_body([_CATALOG_ROW, other_branch]),
    )
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    rows, _match_count = fetch_status_rows(
        client,
        _TENANT,
        _REPO_ID,
        path="openapi.yaml",
        branch="main",
    )
    assert [row["branch"] for row in rows] == ["main"]


def test_trigger_refresh_sends_selectors(httpx_mock: object, client: RestClient) -> None:
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={"path": "openapi.yaml", "branch": "main"},
        json={"success": True, "enqueued": 1, "skipped": 0, "branches": ["main"]},
    )
    payload = trigger_refresh(
        client,
        _TENANT,
        _REPO_ID,
        path=" openapi.yaml ",
        branch="main",
    )
    assert payload["enqueued"] == 1


def test_trigger_refresh_whole_repository_sends_empty_body(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(
        url=_REFRESH_URL,
        method="POST",
        match_json={},
        json={"success": True, "enqueued": 2, "skipped": 1, "branches": ["main"]},
    )
    assert trigger_refresh(client, _TENANT, _REPO_ID)["skipped"] == 1


def test_fetch_refresh_history_and_ids(httpx_mock: object, client: RestClient) -> None:
    httpx_mock.add_response(
        url=_HISTORY_URL,
        json={
            "schemaVersion": 1,
            "items": [{"id": "cycle-1", "path": "openapi.yaml", "outcome": "new-version"}],
            "pagination": {"limit": 50, "total": 1, "offset": 0, "has_more": False},
        },
    )
    entries = fetch_refresh_history(client, _TENANT, _REPO_ID)
    assert history_entry_ids(entries) == {"cycle-1"}


def test_wait_for_refresh_returns_when_status_settles(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("up-to-date"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})

    rows, cycles = wait_for_refresh(
        client,
        _TENANT,
        _REPO_ID,
        targets=[("main", "openapi.yaml")],
        baseline_history_ids=set(),
        poll_interval=0.01,
        timeout=5.0,
        no_progress=True,
        sleep=lambda _seconds: None,
    )
    assert rows[0]["refresh_status"] == "up-to-date"
    assert cycles == []


def test_wait_for_refresh_returns_recorded_cycles(
    httpx_mock: object,
    client: RestClient,
) -> None:
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(
        url=_HISTORY_URL,
        json={
            "items": [
                {
                    "id": "cycle-2",
                    "branch": "main",
                    "path": "openapi.yaml",
                    "outcome": "failed",
                },
                {"id": "cycle-1", "branch": "main", "path": "openapi.yaml"},
            ]
        },
    )

    rows, cycles = wait_for_refresh(
        client,
        _TENANT,
        _REPO_ID,
        targets=[("main", "openapi.yaml")],
        baseline_history_ids={"cycle-1"},
        poll_interval=0.01,
        timeout=5.0,
        no_progress=True,
        sleep=lambda _seconds: None,
    )
    assert rows[0]["refresh_status"] == "stale"
    assert [cycle["id"] for cycle in cycles] == ["cycle-2"]


def test_wait_for_refresh_times_out(
    httpx_mock: object,
    client: RestClient,
    capsys: pytest.CaptureFixture[str],
) -> None:
    httpx_mock.add_response(url=_CATALOG_URL, json=_catalog_body([_CATALOG_ROW]))
    httpx_mock.add_response(url=_SPEC_URL, json=_spec_body("stale"))
    httpx_mock.add_response(url=_HISTORY_URL, json={"items": []})

    clock = iter([0.0, 6.0])
    with pytest.raises(typer.Exit) as exc_info:
        wait_for_refresh(
            client,
            _TENANT,
            _REPO_ID,
            targets=[("main", "openapi.yaml")],
            baseline_history_ids=set(),
            poll_interval=0.01,
            timeout=5.0,
            no_progress=True,
            sleep=lambda _seconds: None,
            monotonic=lambda: next(clock),
        )
    assert exc_info.value.exit_code == EXIT_ERROR
    assert "did not complete within 5 seconds" in capsys.readouterr().err


def test_resolve_repository_rejects_a_match_without_an_id(
    httpx_mock: object,
    client: RestClient,
    capsys: pytest.CaptureFixture[str],
) -> None:
    httpx_mock.add_response(
        url=f"{_BASE}/v1/tenants/{_TENANT}/repositories?limit=200",
        json={"items": [{"name": "API", "full_name": "acme/api"}], "total": 1},
    )
    with pytest.raises(typer.Exit) as exc_info:
        resolve_repository(client, _TENANT, "acme/api")
    assert exc_info.value.exit_code == EXIT_USAGE
    assert "without an id" in capsys.readouterr().err
