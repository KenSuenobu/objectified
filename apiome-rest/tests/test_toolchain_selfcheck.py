"""Tests for the bundled-toolchain startup self-check — FMT-1.3 (#5414).

Pins the ticket's acceptance criteria on the REST side:

* **the pin is single-sourced** — ``toolchain/package.json`` (the manifest the container build
  and CI install from), ``BUNDLED_TOOLS`` and the Dockerfile cannot disagree about which
  ``@asyncapi/parser`` this runtime ships;
* **startup emits the resolved version** — the self-check invokes the required tool and logs
  the version it reported, and warns when that disagrees with the pin;
* **a missing toolchain fails loudly** — enforcement raises :class:`ToolchainUnavailableError`
  at startup instead of booting with a shipped format silently gone; without enforcement it is
  an ``ERROR`` log and a ``degraded`` verdict, never silence;
* **availability is on a health surface** — ``GET /health`` carries the compact verdict and
  ``GET /v1/ops/toolchain`` reports, per gated tool, whether it is required and which formats
  it gates.

No real bundled binary is needed: availability and invocability are driven through the
``app.toolchain_selfcheck`` seam (``probe_tool`` / ``verify_tool``), the same way
``test_toolchain_packaging`` drives the packaging layer.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import app.toolchain_selfcheck as selfcheck
from app.auth import validate_authentication
from app.main import app
from app.toolchain_packaging import ToolAvailability, ToolVerification, bundled_tool
from app.toolchain_selfcheck import (
    REQUIRED_NPM_PACKAGES,
    REQUIRED_TOOL_KEYS,
    TOOLCHAIN_MANIFEST_PATH,
    ToolchainSelfCheck,
    ToolchainToolStatus,
    ToolchainUnavailableError,
    enforce_toolchain_selfcheck,
    latest_toolchain_selfcheck,
    main,
    manifest_pins,
    run_toolchain_selfcheck,
    toolchain_health_detail,
)

client = TestClient(app)

#: The repository's apiome-rest directory (this file lives in ``apiome-rest/tests``).
_REST_ROOT = Path(__file__).resolve().parents[1]

_AUTH = {
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_id": "22222222-2222-2222-2222-222222222222",
    "auth_method": "jwt",
    "user_email": "ops@acme.io",
}


@pytest.fixture(autouse=True)
def _isolate_cached_selfcheck():
    """Keep a test's self-check result out of every other test's health surface.

    ``run_toolchain_selfcheck`` caches its verdict module-side so ``/health`` can report the
    startup outcome for free. A test that fakes a missing tool must not leave that fake behind.
    """
    previous = selfcheck._latest
    yield
    selfcheck._latest = previous


def _availability(
    key: str, *, available: bool, resolved_path: Optional[str] = "/opt/tools/bin/x"
) -> ToolAvailability:
    """Build a stand-in availability record for ``key``."""
    tool = bundled_tool(key)
    assert tool is not None
    return ToolAvailability(
        key=key,
        executable=tool.executable,
        pinned_version=tool.version,
        runtime=tool.runtime,
        available=available,
        resolved_path=resolved_path if available else None,
        override_env=tool.env_override_key,
        detail="resolved" if available else "executable not found on PATH",
    )


def _fake_toolchain(
    monkeypatch: pytest.MonkeyPatch,
    *,
    available: bool,
    invocable: bool = True,
    banner: Optional[str] = None,
) -> None:
    """Drive every *required* tool to a chosen state; leave the optional ones absent."""

    def _probe(key: str) -> Optional[ToolAvailability]:
        if key in REQUIRED_TOOL_KEYS:
            return _availability(key, available=available)
        return _availability(key, available=False)

    async def _verify(key: str, *, timeout: Optional[float] = None) -> ToolVerification:
        tool = bundled_tool(key)
        assert tool is not None
        if invocable:
            return ToolVerification(
                key=key,
                pinned_version=tool.version,
                invocable=True,
                reported=banner
                if banner is not None
                else f"asyncapi-parse (apiome) @asyncapi/parser {tool.version}",
            )
        return ToolVerification(
            key=key, pinned_version=tool.version, invocable=False, error="exec format error"
        )

    monkeypatch.setattr(selfcheck, "probe_tool", _probe)
    monkeypatch.setattr(selfcheck, "verify_tool", _verify)


# ===========================================================================
# The pin is single-sourced
# ===========================================================================


def test_required_tools_are_declared_bundled_tools():
    """A required key that names no bundled tool would enforce something unbuildable."""
    for key in REQUIRED_TOOL_KEYS:
        assert bundled_tool(key) is not None, key


def test_asyncapi_parser_is_a_hard_dependency():
    """The ticket's whole point: the AsyncAPI parser may not be optional."""
    assert "asyncapi-parser" in REQUIRED_TOOL_KEYS


def test_toolchain_manifest_exists_and_pins_every_required_npm_package():
    """``toolchain/package.json`` is what the image and CI install from."""
    assert TOOLCHAIN_MANIFEST_PATH.is_file(), TOOLCHAIN_MANIFEST_PATH
    pins = manifest_pins()
    for key, package in REQUIRED_NPM_PACKAGES.items():
        assert key in REQUIRED_TOOL_KEYS, key
        assert package in pins, f"{package} is not pinned in {TOOLCHAIN_MANIFEST_PATH}"


def test_manifest_pins_are_exact_versions():
    """A range (``^3.6.0``) would let a rebuild ship a parser the runtime never verified."""
    exact = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")
    for package, version in manifest_pins().items():
        assert exact.match(version), f"{package} is pinned loosely as {version!r}"


def test_manifest_pin_matches_the_bundled_tool_version():
    """The version the runtime *reports* must be the version the build *installs*."""
    pins = manifest_pins()
    for key, package in REQUIRED_NPM_PACKAGES.items():
        tool = bundled_tool(key)
        assert tool is not None
        assert pins[package] == tool.version, (
            f"{package} is pinned {pins[package]} in {TOOLCHAIN_MANIFEST_PATH.name} but "
            f"BUNDLED_TOOLS declares {tool.version}"
        )


def test_dockerfile_installs_the_hard_dependency_from_the_manifest():
    """The build must not re-pin the parser behind the manifest's back."""
    dockerfile = (_REST_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY apiome-rest/toolchain/package.json" in dockerfile
    # A build ARG for the parser would be a second, overridable source of truth.
    assert "ARG ASYNCAPI_PARSER_VERSION" not in dockerfile
    assert "@asyncapi/parser@" not in dockerfile
    # The image ships the toolchain, so it enforces it.
    assert "APIOME_REQUIRE_TOOLCHAIN=1" in dockerfile


def test_manifest_is_valid_json_with_a_dependencies_block():
    raw = json.loads(TOOLCHAIN_MANIFEST_PATH.read_text(encoding="utf-8"))
    assert isinstance(raw.get("dependencies"), dict) and raw["dependencies"]


# ===========================================================================
# The self-check itself
# ===========================================================================


async def test_selfcheck_reports_ok_and_the_resolved_version(monkeypatch):
    _fake_toolchain(monkeypatch, available=True)
    result = await run_toolchain_selfcheck()

    assert result.status == "ok"
    assert result.ok
    assert result.missing_required == []
    parser = result.tool("asyncapi-parser")
    assert parser is not None
    assert parser.required and parser.available and parser.invocable
    assert parser.reported_version == parser.pinned_version
    assert parser.version_matches_pin


async def test_selfcheck_records_the_formats_a_tool_gates(monkeypatch):
    """"What did this deployment lose?" is answered on the same record as "what is missing?"."""
    _fake_toolchain(monkeypatch, available=False)
    result = await run_toolchain_selfcheck()

    parser = result.tool("asyncapi-parser")
    assert parser is not None
    assert "asyncapi" in parser.gated_formats
    # Derived from the live registry, so the optional tools are covered too.
    buf = result.tool("buf")
    assert buf is not None
    # The registry keys, not the format keys: `grpc` is the adapter that owns protobuf.
    assert {"grpc", "connectrpc"} <= set(buf.gated_formats)


async def test_optional_tools_are_never_missing_required(monkeypatch):
    """Absent optional tools stay a degraded *format*, not a broken *runtime*."""
    _fake_toolchain(monkeypatch, available=True)
    result = await run_toolchain_selfcheck()

    assert result.status == "ok"
    assert not any(status.available for status in result.tools if not status.required)


async def test_missing_required_tool_is_degraded_without_enforcement(monkeypatch):
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)
    _fake_toolchain(monkeypatch, available=False)

    result = await run_toolchain_selfcheck()

    assert result.status == "degraded"
    assert result.missing_required == ["asyncapi-parser"]
    assert not result.ok


async def test_missing_required_tool_is_failed_when_enforced(monkeypatch):
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", True)
    _fake_toolchain(monkeypatch, available=False)

    result = await run_toolchain_selfcheck()

    assert result.status == "failed"
    assert result.enforced


async def test_a_tool_that_resolves_but_cannot_run_is_missing(monkeypatch):
    """Resolution is not proof: a wrapper pointing at a deleted node_modules must be caught."""
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)
    _fake_toolchain(monkeypatch, available=True, invocable=False)

    result = await run_toolchain_selfcheck()

    parser = result.tool("asyncapi-parser")
    assert parser is not None
    assert parser.available and parser.invocable is False
    assert not parser.ok
    assert result.missing_required == ["asyncapi-parser"]
    assert "version probe failed" in parser.detail


async def test_verify_false_skips_the_subprocess(monkeypatch):
    _fake_toolchain(monkeypatch, available=True)
    result = await run_toolchain_selfcheck(verify=False)

    assert result.verified is False
    parser = result.tool("asyncapi-parser")
    assert parser is not None
    assert parser.invocable is None and parser.reported_version is None


async def test_an_unverified_run_does_not_replace_the_startup_verdict(monkeypatch):
    """A cheap ops probe must not downgrade what ``/health`` reports."""
    _fake_toolchain(monkeypatch, available=True)
    startup = await run_toolchain_selfcheck(verify=True)
    assert latest_toolchain_selfcheck() is startup

    await run_toolchain_selfcheck(verify=False)

    assert latest_toolchain_selfcheck() is startup
    assert toolchain_health_detail()["status"] == "ok"


@pytest.mark.parametrize(
    ("banner", "expected"),
    [
        ("asyncapi-parse (apiome) @asyncapi/parser 3.6.0", "3.6.0"),
        ("some-tool 1.2", "1.2"),
        ("tool v2.0.0-rc.1", "2.0.0-rc.1"),
        ("no version here", None),
        ("", None),
        (None, None),
    ],
)
def test_version_is_parsed_from_the_tools_own_banner(banner, expected):
    assert selfcheck._parse_version(banner) == expected


# ===========================================================================
# Enforcement at startup
# ===========================================================================


async def test_enforce_logs_the_resolved_version(monkeypatch, caplog):
    _fake_toolchain(monkeypatch, available=True)

    with caplog.at_level(logging.INFO, logger="app.toolchain_selfcheck"):
        result = await enforce_toolchain_selfcheck()

    assert result.ok
    assert any(
        "asyncapi-parser" in record.getMessage() and "@asyncapi/parser" in record.getMessage()
        for record in caplog.records
    )


async def test_enforce_warns_when_the_reported_version_is_not_the_pin(monkeypatch, caplog):
    """The image installed something other than what it declares — say so, do not fail."""
    _fake_toolchain(
        monkeypatch, available=True, banner="asyncapi-parse (apiome) @asyncapi/parser 9.9.9"
    )

    with caplog.at_level(logging.WARNING, logger="app.toolchain_selfcheck"):
        result = await enforce_toolchain_selfcheck()

    assert result.ok
    assert any("9.9.9" in record.getMessage() for record in caplog.records)


async def test_enforce_raises_when_a_required_tool_is_missing(monkeypatch):
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", True)
    _fake_toolchain(monkeypatch, available=False)

    with pytest.raises(ToolchainUnavailableError) as excinfo:
        await enforce_toolchain_selfcheck()

    message = str(excinfo.value)
    assert "asyncapi-parser" in message
    # Operator-actionable: names the override and the formats that were lost.
    assert "APIOME_ASYNCAPI_PARSER_BIN" in message
    assert "asyncapi" in message


async def test_enforce_logs_an_error_instead_of_raising_without_enforcement(
    monkeypatch, caplog
):
    """Degrading is allowed in development — silently degrading is not."""
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)
    _fake_toolchain(monkeypatch, available=False)

    with caplog.at_level(logging.ERROR, logger="app.toolchain_selfcheck"):
        result = await enforce_toolchain_selfcheck()

    assert result.status == "degraded"
    assert any(record.levelno >= logging.ERROR for record in caplog.records)


def test_cli_main_exits_non_zero_when_the_toolchain_is_broken(monkeypatch, capsys):
    """``python -m app.toolchain_selfcheck`` is CI's named gate; it must actually fail."""
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)
    _fake_toolchain(monkeypatch, available=False)

    assert main() == 1
    assert "asyncapi-parser" in capsys.readouterr().out


def test_cli_main_exits_zero_when_the_toolchain_is_intact(monkeypatch, capsys):
    _fake_toolchain(monkeypatch, available=True)

    assert main() == 0
    out = capsys.readouterr().out
    assert "ok" in out and "asyncapi-parser" in out


# ===========================================================================
# Enforcement policy
# ===========================================================================


def test_enforcement_defaults_to_the_deployment_environment(monkeypatch):
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", None)
    monkeypatch.setattr(selfcheck.settings, "app_env", "production")
    assert selfcheck.settings.enforce_bundled_toolchain is True

    monkeypatch.setattr(selfcheck.settings, "app_env", "development")
    assert selfcheck.settings.enforce_bundled_toolchain is False


def test_explicit_enforcement_setting_wins(monkeypatch):
    monkeypatch.setattr(selfcheck.settings, "app_env", "development")
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", True)
    assert selfcheck.settings.enforce_bundled_toolchain is True

    monkeypatch.setattr(selfcheck.settings, "app_env", "production")
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)
    assert selfcheck.settings.enforce_bundled_toolchain is False


# ===========================================================================
# Health / ops surfaces
# ===========================================================================


async def test_health_detail_reports_the_cached_startup_verdict(monkeypatch):
    _fake_toolchain(monkeypatch, available=True)
    await run_toolchain_selfcheck()

    detail = toolchain_health_detail()

    assert detail["status"] == "ok"
    assert detail["required"] == len(REQUIRED_TOOL_KEYS)
    assert detail["available"] == len(REQUIRED_TOOL_KEYS)
    assert detail["missing"] == []
    assert latest_toolchain_selfcheck() is not None


def test_health_detail_falls_back_to_a_probe_before_startup(monkeypatch):
    """A worker that never booted the app still reports honestly rather than omitting."""
    selfcheck._latest = None
    _fake_toolchain(monkeypatch, available=False)
    monkeypatch.setattr(selfcheck.settings, "require_bundled_toolchain", False)

    detail = toolchain_health_detail()

    assert detail["status"] == "degraded"
    assert detail["missing"] == ["asyncapi-parser"]


async def test_health_detail_reports_availability_without_fingerprinting_the_runtime(
    monkeypatch,
):
    """``/health`` is unauthenticated: no resolved paths, no third-party versions."""
    _fake_toolchain(monkeypatch, available=True)
    await run_toolchain_selfcheck()

    detail = toolchain_health_detail()

    assert set(detail) == {"status", "enforced", "required", "available", "missing"}
    rendered = json.dumps(detail)
    assert "/opt/tools/bin" not in rendered
    assert "3.6.0" not in rendered


@pytest.fixture
def _auth_override():
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_ops_toolchain_marks_required_tools_and_what_they_gate(_auth_override):
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr("app.ops_routes.enforce_platform_admin", lambda db, auth: None)
        response = client.get("/v1/ops/toolchain")

    assert response.status_code == 200
    body = response.json()
    by_key = {tool["key"]: tool for tool in body["tools"]}

    parser = by_key["asyncapi-parser"]
    assert parser["required"] is True
    assert "asyncapi" in parser["gated_formats"]
    assert by_key["vacuum"]["required"] is False

    assert body["summary"]["required"] == len(REQUIRED_TOOL_KEYS)
    assert body["summary"]["toolchain_status"] in {"ok", "degraded", "failed"}
    assert isinstance(body["summary"]["required_missing"], list)


# ===========================================================================
# Model behaviour
# ===========================================================================


def _status(**overrides) -> ToolchainToolStatus:
    base = dict(
        key="asyncapi-parser",
        required=True,
        available=True,
        invocable=True,
        pinned_version="3.6.0",
        reported_version="3.6.0",
        gated_formats=["asyncapi"],
        detail="resolved",
    )
    base.update(overrides)
    return ToolchainToolStatus(**base)


def test_optional_tool_is_ok_even_when_absent():
    assert _status(required=False, available=False, invocable=None).ok


def test_required_tool_is_not_ok_when_absent():
    assert not _status(available=False, invocable=None).ok


def test_unverified_tool_makes_no_version_claim():
    assert _status(reported_version=None).version_matches_pin


def test_reported_version_that_differs_from_the_pin_is_flagged():
    assert not _status(reported_version="3.5.0").version_matches_pin


def test_selfcheck_tool_lookup_returns_none_for_an_unknown_key():
    check = ToolchainSelfCheck(
        status="ok",
        enforced=False,
        verified=True,
        required_keys=list(REQUIRED_TOOL_KEYS),
        missing_required=[],
        tools=[_status()],
    )
    assert check.tool("asyncapi-parser") is not None
    assert check.tool("nope") is None
