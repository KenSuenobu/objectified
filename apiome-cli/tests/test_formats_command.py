"""Tests for the ``apiome formats`` command (FMT-1.5, #5416).

Drive the command end to end against a mocked endpoint: the table renders the facts a reader came
for, ``--json`` hands back the response untouched, the filters travel to the server as query
parameters rather than being applied client-side, and a bad ``--direction`` is a usage error rather
than a 422 traceback.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

runner = CliRunner()

_BASE = "http://localhost:8000"
_MATRIX_URL = f"{_BASE}/v1/formats/matrix"

_PAYLOAD: dict[str, Any] = {
    "version": "1",
    "capability_registry_version": "3",
    "filters": {"paradigm": None, "direction": None},
    "counts": {
        "total": 2,
        "importable": 2,
        "exportable": 1,
        "round_trip": 1,
        "import_only": 1,
        "export_only": 0,
        "live_discovery": 1,
        "publishable": 1,
        "toolchain_gated": 1,
        "unavailable_here": 1,
    },
    "formats": [
        {
            "key": "grpc",
            "label": "gRPC / Protobuf",
            "description": "Protocol buffer service definitions.",
            "icon": "boxes",
            "paradigm": "rpc",
            "direction": "import_only",
            "version_coverage": ["protobuf-3"],
            "file_extensions": [".proto"],
            "import_support": {
                "supported": True,
                "input_kinds": ["file", "fileset"],
                "supports_live_discovery": True,
                "supports_remote_refs": False,
                "publishable": False,
                "available": False,
                "unavailable_reason": "buf is not installed.",
            },
            "export_support": {
                "supported": False,
                "target_key": None,
                "label": None,
                "format": None,
                "multi_file": False,
                "capability_profile": None,
                "available": False,
                "unavailable_reason": None,
            },
            "toolchain": {
                "required_tools": ["buf"],
                "import_tools": ["buf"],
                "export_tools": [],
                "missing_tools": ["buf"],
                "satisfied": False,
            },
            "capability": {"provenance": "derived", "notes": []},
        },
        {
            "key": "openapi",
            "label": "OpenAPI / Swagger",
            "description": "REST API description.",
            "icon": "file-json",
            "paradigm": "rest",
            "direction": "both",
            "version_coverage": ["openapi-3.0", "openapi-3.1"],
            "file_extensions": [".json", ".yaml"],
            "import_support": {
                "supported": True,
                "input_kinds": ["file", "url", "paste"],
                "supports_live_discovery": False,
                "supports_remote_refs": True,
                "publishable": True,
                "available": True,
                "unavailable_reason": None,
            },
            "export_support": {
                "supported": True,
                "target_key": "openapi",
                "label": "OpenAPI 3.1",
                "format": "openapi-3.1",
                "multi_file": False,
                "capability_profile": {"operations": True},
                "available": True,
                "unavailable_reason": None,
            },
            "toolchain": {
                "required_tools": [],
                "import_tools": [],
                "export_tools": [],
                "missing_tools": [],
                "satisfied": True,
            },
            "capability": {"provenance": "reviewed", "notes": []},
        },
    ],
}


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a key and base URL so the Tier-2 registry route is reachable."""
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


# ===========================================================================
# The human table
# ===========================================================================


def test_formats_renders_a_readable_table(api_key_env: None, httpx_mock: Any) -> None:
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["formats"])
    assert result.exit_code == EXIT_SUCCESS
    for header in ("Format", "Direction", "Routing", "Versions", "Extensions", "Runtime"):
        assert header in result.stdout
    assert "openapi" in result.stdout
    assert "grpc" in result.stdout
    assert "Project" in result.stdout
    assert "Catalog" in result.stdout


def test_table_reports_the_missing_toolchain_rather_than_hiding_the_format(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    """A format this deployment cannot run is still supported; the table says which is which."""
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["formats"])
    assert "needs buf" in result.stdout
    assert "supported, just not runnable here" in result.stdout


def test_table_prints_the_headline_counts(api_key_env: None, httpx_mock: Any) -> None:
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["formats"])
    assert "2 formats — 2 importable, 1 exportable, 1 round-trip." in result.stdout


def test_empty_matrix_prints_a_message_not_an_empty_frame(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    httpx_mock.add_response(url=_MATRIX_URL, json={"version": "1", "counts": {}, "formats": []})
    result = runner.invoke(app, ["formats"])
    assert result.exit_code == EXIT_SUCCESS
    assert "No formats match." in result.stdout


# ===========================================================================
# --json
# ===========================================================================


def test_json_flag_prints_the_response_verbatim(api_key_env: None, httpx_mock: Any) -> None:
    """A script piping ``apiome formats --json`` must receive exactly what a partner calling the
    endpoint receives — not a CLI-flavoured reshaping of it."""
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["formats", "--json"])
    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout) == _PAYLOAD


def test_root_json_flag_also_works(api_key_env: None, httpx_mock: Any) -> None:
    """``--json`` is accepted in either position, so neither spelling surprises a user."""
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["--json", "formats"])
    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout) == _PAYLOAD


# ===========================================================================
# Filters travel to the server
# ===========================================================================


def test_paradigm_filter_is_sent_as_a_query_parameter(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    httpx_mock.add_response(url=f"{_MATRIX_URL}?paradigm=rest", json=_PAYLOAD)
    result = runner.invoke(app, ["formats", "--paradigm", "rest"])
    assert result.exit_code == EXIT_SUCCESS
    assert str(httpx_mock.get_requests()[0].url) == f"{_MATRIX_URL}?paradigm=rest"


def test_direction_filter_is_sent_as_a_query_parameter(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    httpx_mock.add_response(url=f"{_MATRIX_URL}?direction=both", json=_PAYLOAD)
    result = runner.invoke(app, ["formats", "--direction", "both"])
    assert result.exit_code == EXIT_SUCCESS
    assert str(httpx_mock.get_requests()[0].url) == f"{_MATRIX_URL}?direction=both"


def test_both_filters_travel_together(api_key_env: None, httpx_mock: Any) -> None:
    """The server owns the filter rules, so neither flag overrides the other client-side."""
    url = f"{_MATRIX_URL}?paradigm=event&direction=import"
    httpx_mock.add_response(url=url, json=_PAYLOAD)
    result = runner.invoke(
        app,
        ["formats", "--paradigm", "event", "--direction", "import"],
    )
    assert result.exit_code == EXIT_SUCCESS
    assert str(httpx_mock.get_requests()[0].url) == url


def test_filter_values_are_normalized_before_the_request(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    """``--direction Import`` is the same request as ``--direction import``."""
    httpx_mock.add_response(url=f"{_MATRIX_URL}?direction=import", json=_PAYLOAD)
    result = runner.invoke(app, ["formats", "--direction", "  Import "])
    assert result.exit_code == EXIT_SUCCESS
    assert str(httpx_mock.get_requests()[0].url) == f"{_MATRIX_URL}?direction=import"


def test_unfiltered_call_sends_no_query_string(api_key_env: None, httpx_mock: Any) -> None:
    httpx_mock.add_response(url=_MATRIX_URL, json=_PAYLOAD)
    result = runner.invoke(app, ["formats"])
    assert result.exit_code == EXIT_SUCCESS
    assert str(httpx_mock.get_requests()[0].url) == _MATRIX_URL


# ===========================================================================
# Usage errors
# ===========================================================================


def test_bad_direction_is_a_usage_error_with_the_accepted_values(api_key_env: None) -> None:
    """Rejected before the request, so a typo never becomes a 422 traceback."""
    result = runner.invoke(app, ["formats", "--direction", "sideways"])
    assert result.exit_code == EXIT_USAGE
    assert "sideways" in result.output
    assert "import, export, both" in result.output


def test_bad_paradigm_is_the_servers_rejection_not_a_traceback(
    api_key_env: None,
    httpx_mock: Any,
) -> None:
    """The paradigm vocabulary belongs to the server, so an unknown value travels and comes back
    as its 422 — surfaced as a readable usage error rather than a stack trace. Hard-coding the
    list here would rot the moment a paradigm is added."""
    httpx_mock.add_response(
        url=f"{_MATRIX_URL}?paradigm=telepathy",
        status_code=422,
        json={"detail": [{"loc": ["query", "paradigm"], "msg": "Input should be 'rest', ..."}]},
    )
    result = runner.invoke(app, ["formats", "--paradigm", "telepathy"])
    assert result.exit_code == EXIT_USAGE
    assert "Traceback" not in result.output


def test_missing_api_key_is_a_usage_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A registry listing still needs credentials; say so instead of failing at the transport."""
    monkeypatch.delenv("APIOME_API_KEY", raising=False)
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    result = runner.invoke(app, ["formats"])
    assert result.exit_code == EXIT_USAGE


# ===========================================================================
# Discoverability
# ===========================================================================


def test_formats_is_listed_in_the_command_directory() -> None:
    from apiome_cli.help_util import build_command_directory

    assert "formats" in build_command_directory()


def test_formats_help_documents_every_flag() -> None:
    result = runner.invoke(app, ["formats", "--help"])
    assert result.exit_code == EXIT_SUCCESS
    for flag in ("--json", "--paradigm", "--direction"):
        assert flag in result.stdout
