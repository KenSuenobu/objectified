"""End-to-end tests for ``apiome import git`` (MFI-29.3, #4390).

The command makes two REST calls: the git fileset endpoint resolves a repository
selection to packed bytes plus commit provenance, and the normal spec-import endpoint
imports those bytes. These tests drive both against a mocked service and assert the
provenance is forwarded, the format is taken from detection unless overridden, and the
failure paths exit with the documented codes.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_USAGE
from apiome_cli.main import app

from helpers import strip_ansi

runner = CliRunner()

_BASE = "http://localhost:8000"
_SOURCES_URL = f"{_BASE}/v1/import/sources"
_GIT_URL = f"{_BASE}/v1/tenants/acme-corp/import/git/fileset"
_IMPORT_URL = f"{_BASE}/v1/tenants/acme-corp/imports"
_JOB_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
_JOB_URL = f"{_IMPORT_URL}/{_JOB_ID}"

_REPO_URL = "https://github.com/acme/specs"
_COMMIT = "9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60"

_GRPC_SOURCE = {
    "key": "grpc",
    "label": "gRPC / Protobuf",
    "description": "Import a gRPC / Protocol Buffers API.",
    "icon": "share-2",
    "paradigm": "rpc",
    "input_kinds": ["file", "url", "paste", "fileset"],
    "supports_live_discovery": True,
    "formats": ["protobuf"],
}

_PREVIEW_SUMMARY = {
    "source": "grpc",
    "paradigm": "rpc",
    "format": "protobuf",
    "fingerprint": "sha256:grpc123",
    "counts": {"services": 1, "operations": 2, "types": 3, "channels": 0},
    "lint": {
        "score": 88,
        "grade": "B",
        "report_fingerprint": "grpclintfp",
        "findings": 0,
        "severity_counts": {},
    },
    "dry_run": False,
    "incremental_mode": False,
    "persisted": False,
}

_GIT_SOURCE = {
    "provider": "github",
    "repo_url": _REPO_URL,
    "owner": "acme",
    "repo": "specs",
    "ref": "main",
    "commit_sha": _COMMIT,
    "path": "protos/**",
    "browse_url": f"{_REPO_URL}/tree/{_COMMIT}/protos",
}


def _packed_selection() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("common/types.proto", 'syntax = "proto3";\n')
        archive.writestr(
            "user/user_service.proto", 'syntax = "proto3";\nservice Users {}\n'
        )
    return buffer.getvalue()


def _git_response(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "git_source": _GIT_SOURCE,
        "filename": f"specs-main-{_COMMIT[:7]}.zip",
        "document_base64": base64.b64encode(_packed_selection()).decode("ascii"),
        "archive_root": "user/user_service.proto",
        "members": ["common/types.proto", "user/user_service.proto"],
        "skipped": [{"path": "docs/logo.png", "reason": "binary-file"}],
        "total_bytes": 64,
        "source_kind": "grpc",
        "detection": {
            "matched": True,
            "detected": {
                "format": "protobuf",
                "confidence": 0.95,
                "reason": "proto3 syntax marker",
                "source_key": "grpc",
                "importable": True,
            },
            "ambiguous": False,
            "candidates": [],
            "ambiguous_candidates": [],
            "archive_root": None,
            "archive_members": [],
        },
    }
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-import-key")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _mock_sources(httpx_mock: object) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_SOURCES_URL, method="GET", json={"sources": [_GRPC_SOURCE]}
    )


def _mock_git(httpx_mock: object, **overrides: Any) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_GIT_URL, method="POST", json=_git_response(**overrides)
    )


def _mock_import_completed(httpx_mock: object) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_URL,
        method="POST",
        status_code=202,
        json={"job_id": _JOB_ID, "state": "pending"},
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_JOB_URL,
        method="GET",
        json={"state": "completed", "job_id": _JOB_ID, "summary": _PREVIEW_SUMMARY},
    )


def _recorded_body(httpx_mock: object, url: str) -> dict[str, Any]:
    for request in httpx_mock.get_requests():  # type: ignore[attr-defined]
        if request.method == "POST" and str(request.url) == url:
            return json.loads(request.content.decode("utf-8"))
    raise AssertionError(f"no POST recorded for {url}")


def test_imports_a_repository_path_with_commit_provenance(httpx_mock: object) -> None:
    _mock_sources(httpx_mock)
    _mock_git(httpx_mock)
    _mock_import_completed(httpx_mock)

    result = runner.invoke(
        app,
        ["import", "git", _REPO_URL, "--ref", "main", "--path", "protos/**"],
    )
    assert result.exit_code == 0, result.output

    selection = _recorded_body(httpx_mock, _GIT_URL)
    assert selection == {"repo_url": _REPO_URL, "ref": "main", "path": "protos/**"}

    body = _recorded_body(httpx_mock, _IMPORT_URL)
    assert body["metadata"]["source_kind"] == "grpc"
    options = body["metadata"]["options"]
    assert options["archive_root"] == "user/user_service.proto"
    assert options["input_kind"] == "fileset"
    assert options["git_source"] == _GIT_SOURCE
    # The packed selection is forwarded verbatim.
    assert base64.b64decode(body["document_base64"]) == _packed_selection()

    text = strip_ansi(result.output)
    assert "Fetched 2 file(s)" in text
    assert _COMMIT[:7] in text
    assert "1 skipped" in text
    assert "Import preview completed." in text


def test_explicit_format_overrides_detection(httpx_mock: object) -> None:
    _mock_sources(httpx_mock)
    _mock_git(httpx_mock, source_kind=None)
    _mock_import_completed(httpx_mock)

    result = runner.invoke(
        app, ["import", "git", _REPO_URL, "--path", "protos/", "--format", "grpc"]
    )
    assert result.exit_code == 0, result.output
    assert _recorded_body(httpx_mock, _IMPORT_URL)["metadata"]["source_kind"] == "grpc"


def test_credential_and_root_flags_are_forwarded(httpx_mock: object) -> None:
    _mock_sources(httpx_mock)
    _mock_git(httpx_mock)
    _mock_import_completed(httpx_mock)

    result = runner.invoke(
        app,
        [
            "import",
            "git",
            _REPO_URL,
            "--path",
            "protos/",
            "--root",
            "user/user_service.proto",
            "--linked-account-id",
            "acct-1",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output

    selection = _recorded_body(httpx_mock, _GIT_URL)
    assert selection["root"] == "user/user_service.proto"
    assert selection["linked_account_id"] == "acct-1"
    assert _recorded_body(httpx_mock, _IMPORT_URL)["metadata"]["options"]["dry_run"] is True


def test_undetected_format_without_override_is_a_usage_error(httpx_mock: object) -> None:
    _mock_git(httpx_mock, source_kind=None)

    result = runner.invoke(app, ["import", "git", _REPO_URL, "--path", "docs/"])

    assert result.exit_code == EXIT_USAGE, result.output
    assert "--format" in strip_ansi(result.output)


def test_unknown_format_lists_the_registry(httpx_mock: object) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_SOURCES_URL, method="GET", json={"sources": []}
    )
    _mock_git(httpx_mock)

    result = runner.invoke(app, ["import", "git", _REPO_URL, "--path", "protos/"])

    assert result.exit_code == EXIT_USAGE, result.output
    assert "Unknown import format 'grpc'" in strip_ansi(result.output)


def test_preview_only_response_without_bytes_is_an_error(httpx_mock: object) -> None:
    _mock_git(httpx_mock, document_base64=None)

    result = runner.invoke(app, ["import", "git", _REPO_URL, "--path", "protos/"])

    assert result.exit_code == EXIT_ERROR, result.output
    assert "no document to import" in strip_ansi(result.output)


def test_selection_failure_surfaces_the_taxonomy_message(httpx_mock: object) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_GIT_URL,
        method="POST",
        status_code=422,
        json={
            "detail": {
                "code": "SOURCE_SELECTION_EMPTY",
                "category": "input",
                "message": "No importable files matching 'schemas/**' were found.",
                "remediation": "Widen the pattern.",
                "retriable": False,
            }
        },
    )

    result = runner.invoke(app, ["import", "git", _REPO_URL, "--path", "schemas/**"])

    assert result.exit_code != 0
    assert "SOURCE_SELECTION_EMPTY" in strip_ansi(result.output) or "No importable files" in strip_ansi(
        result.output
    )
