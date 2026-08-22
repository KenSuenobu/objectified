"""Tests for tool runtime packaging (MFI-5.2, #3751).

Covers the bundled-tool declarations, their registration into the runner registry, the
lazy availability probe (the "format unavailable" path), the optional version verification,
and the platform-admin ``GET /v1/ops/toolchain`` surface. No real bundled binary
(buf/tsp/…) is required: availability is asserted via the ``APIOME_<KEY>_BIN`` override
pointed at a portable stand-in, and verification is exercised against a real executable.
"""

from __future__ import annotations

import shutil
import sys
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.toolchain_packaging import (
    BUNDLED_TOOLS,
    ToolAvailability,
    ToolVerification,
    bundled_tool,
    probe_all,
    probe_tool,
    register_bundled_tools,
    verify_tool,
)
from app.toolchain_runner import available_tools, get_tool

client = TestClient(app)

_EXPECTED_KEYS = {
    "buf",
    "tsp",
    "smithy",
    "drafter",
    "amf",
    "asyncapi",
    "asyncapi-parser",
    "asyncapi-diff",
    "rover",
    "graphql-inspector-diff",
    "spectral",
    "vacuum",
    "redocly",
    "oasdiff",
    "openapi-changes",
}

_AUTH = {
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_id": "22222222-2222-2222-2222-222222222222",
    "auth_method": "jwt",
    "user_email": "ops@acme.io",
}


# --- declarations & registration -------------------------------------------


def test_bundled_set_covers_every_required_tool():
    keys = {t.key for t in BUNDLED_TOOLS}
    assert keys == _EXPECTED_KEYS


def test_every_bundled_tool_is_fully_specified():
    for tool in BUNDLED_TOOLS:
        assert tool.key and tool.executable and tool.version
        # The override env var follows the documented APIOME_<KEY>_BIN convention; a
        # hyphen in a multi-word key (e.g. ``asyncapi-parser``) maps to ``_`` so the var name
        # stays a valid shell identifier.
        env_key = tool.key.upper().replace("-", "_")
        assert tool.env_override_key == f"APIOME_{env_key}_BIN"
        assert tool.runtime in {"native", "node", "jvm"}
        assert tool.version_probe_args  # something to ask the version with


def test_bundled_tools_are_registered_in_the_runner_registry():
    register_bundled_tools()
    registered = set(available_tools())
    assert _EXPECTED_KEYS <= registered
    spec = get_tool("buf")
    assert spec is not None
    assert spec.env_override_keys == ("APIOME_BUF_BIN",)


def test_register_is_idempotent():
    first = register_bundled_tools()
    second = register_bundled_tools()
    assert first == second == [t.key for t in BUNDLED_TOOLS]


def test_bundled_tool_lookup():
    assert bundled_tool("rover").version == "0.27.0"
    assert bundled_tool("not-a-tool") is None


def test_to_spec_round_trips_packaging_facts():
    tool = bundled_tool("amf")
    spec = tool.to_spec()
    assert spec.key == "amf"
    assert spec.executable == "amf"
    assert spec.env_override_keys == ("APIOME_AMF_BIN",)


# --- availability probe (lazy, no subprocess) ------------------------------


def test_probe_unknown_tool_returns_none():
    assert probe_tool("nope") is None


def test_probe_reports_unavailable_when_binary_absent(monkeypatch):
    # Ensure neither PATH nor an override resolves the tool.
    monkeypatch.delenv("APIOME_BUF_BIN", raising=False)
    with patch("app.toolchain_packaging.resolve_executable", return_value=None):
        avail = probe_tool("buf")
    assert isinstance(avail, ToolAvailability)
    assert avail.available is False
    assert avail.resolved_path is None
    # FMT-3.7 raised the pin to the first release that compiles Protobuf Edition 2024.
    assert avail.pinned_version == "1.72.0"
    assert "unavailable" in avail.detail


def test_probe_reports_available_via_override(monkeypatch):
    real = shutil.which("echo") or "/bin/echo"
    monkeypatch.setenv("APIOME_BUF_BIN", real)
    avail = probe_tool("buf")
    assert avail.available is True
    assert avail.resolved_path == real


def test_probe_override_to_missing_file_is_unavailable(monkeypatch):
    monkeypatch.setenv("APIOME_TSP_BIN", "/definitely/not/here/tsp")
    avail = probe_tool("tsp")
    assert avail.available is False
    assert "does not point at an executable file" in avail.detail


def test_probe_all_returns_one_entry_per_tool():
    probes = probe_all()
    assert {p.key for p in probes} == _EXPECTED_KEYS
    assert all(isinstance(p, ToolAvailability) for p in probes)


def test_resolve_executable_finds_dev_tools_bin_buf(tmp_path, monkeypatch):
    """Local dev installs land in apiome-rest/.tools/bin (run.sh / install_dev_toolchain.sh)."""
    from app.toolchain_runner import ToolSpec, resolve_executable

    tools_bin = tmp_path / ".tools" / "bin"
    tools_bin.mkdir(parents=True)
    buf = tools_bin / "buf"
    buf.write_text("#!/bin/sh\necho buf\n", encoding="utf-8")
    buf.chmod(0o755)

    fake_root = tmp_path
    monkeypatch.setattr("app.toolchain_runner._apiome_rest_root", lambda: fake_root)
    monkeypatch.delenv("APIOME_BUF_BIN", raising=False)

    spec = ToolSpec(key="buf", executable="buf", description="test")
    assert resolve_executable(spec) == str(buf)
    assert probe_tool("buf").available is True


# --- verification (optional, real subprocess) ------------------------------


async def test_verify_unknown_tool_returns_none():
    assert await verify_tool("nope") is None


async def test_verify_invocable_tool(monkeypatch):
    # Point a bundled tool at a real binary whose --version exits 0 and prints text.
    real = shutil.which("python3") or sys.executable
    monkeypatch.setenv("APIOME_BUF_BIN", real)
    report = await verify_tool("buf")
    assert isinstance(report, ToolVerification)
    assert report.invocable is True
    assert report.reported  # captured first line of version output


async def test_verify_absent_tool_is_not_invocable(monkeypatch):
    monkeypatch.delenv("APIOME_ROVER_BIN", raising=False)
    with patch("app.toolchain_runner.resolve_executable", return_value=None):
        report = await verify_tool("rover")
    assert report.invocable is False
    assert report.error


# --- ops route -------------------------------------------------------------


@pytest.fixture
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_ops_toolchain_requires_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = False
        r = client.get("/v1/ops/toolchain")
    assert r.status_code == 403


def test_ops_toolchain_lists_tools_for_platform_admin(_auth_override):
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/toolchain")
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["total"] == len(BUNDLED_TOOLS)
    keys = {t["key"] for t in body["tools"]}
    assert keys == _EXPECTED_KEYS
    for tool in body["tools"]:
        assert {"key", "pinned_version", "runtime", "available", "override_env"} <= tool.keys()


def test_ops_toolchain_verify_adds_reports_for_available_tools(_auth_override, monkeypatch):
    real = shutil.which("python3") or sys.executable
    monkeypatch.setenv("APIOME_BUF_BIN", real)
    with patch("app.ops_routes.db") as mdb:
        mdb.is_platform_admin.return_value = True
        r = client.get("/v1/ops/toolchain", params={"verify": "true"})
    assert r.status_code == 200
    by_key = {t["key"]: t for t in r.json()["tools"]}
    assert by_key["buf"]["available"] is True
    assert by_key["buf"]["verification"]["invocable"] is True
