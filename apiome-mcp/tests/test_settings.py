from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clear_settings_cache() -> None:
    from apiome_mcp.settings import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_settings_anonymous_policy_tenant_id(monkeypatch: pytest.MonkeyPatch) -> None:
    tid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "x" * 16)
    monkeypatch.setenv("APIOME_MCP_ANONYMOUS_POLICY_TENANT_ID", tid)

    from uuid import UUID

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.anonymous_policy_tenant_id == UUID(tid)


def test_settings_anonymous_policy_tenant_id_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "x" * 16)
    monkeypatch.delenv("APIOME_MCP_ANONYMOUS_POLICY_TENANT_ID", raising=False)

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.anonymous_policy_tenant_id is None


def test_settings_database_pool_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "y" * 16)
    monkeypatch.setenv("APIOME_MCP_DATABASE_POOL_MIN_SIZE", "2")
    monkeypatch.setenv("APIOME_MCP_DATABASE_POOL_MAX_SIZE", "20")
    monkeypatch.setenv("APIOME_MCP_DATABASE_POOL_TIMEOUT", "12.5")

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.database_pool_min_size == 2
    assert s.database_pool_max_size == 20
    assert s.database_pool_timeout == 12.5


def test_settings_pool_max_below_min_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    from pydantic import ValidationError

    from apiome_mcp.settings import Settings

    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "y" * 16)
    monkeypatch.setenv("APIOME_MCP_DATABASE_POOL_MIN_SIZE", "5")
    monkeypatch.setenv("APIOME_MCP_DATABASE_POOL_MAX_SIZE", "3")

    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=None)
    assert any(e["type"] == "value_error" for e in exc.value.errors())


def test_settings_http_transport_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "y" * 16)
    monkeypatch.setenv("APIOME_MCP_TRANSPORT", "http")
    monkeypatch.setenv("APIOME_MCP_HTTP_HOST", "0.0.0.0")
    monkeypatch.setenv("APIOME_MCP_HTTP_PORT", "9000")

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.transport == "http"
    assert s.http_host == "0.0.0.0"
    assert s.http_port == 9000


def test_settings_missing_database_url_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    from pydantic import ValidationError

    from apiome_mcp.settings import Settings

    monkeypatch.delenv("APIOME_MCP_DATABASE_URL", raising=False)
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "z" * 16)

    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=None)
    errs = exc.value.errors()
    assert any(e["loc"] == ("database_url",) for e in errs)


def test_settings_short_internal_secret_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    from pydantic import ValidationError

    from apiome_mcp.settings import Settings

    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "short")

    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=None)
    assert any(e["loc"] == ("internal_secret",) for e in exc.value.errors())


def test_cli_serve_exits_zero_with_valid_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APIOME_MCP_TRANSPORT", raising=False)
    env = {
        **os.environ,
        "PYTHONPATH": str(_ROOT / "src"),
        "APIOME_MCP_DATABASE_URL": "postgresql://localhost/db",
        "APIOME_MCP_INTERNAL_SECRET": "s" * 16,
    }
    env.pop("APIOME_MCP_TRANSPORT", None)
    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            [sys.executable, "-m", "apiome_mcp", "serve"],
            capture_output=True,
            text=True,
            check=False,
            cwd=tmpdir,
            env=env,
        )
    assert result.returncode == 0
    line = result.stderr.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["event"] == "mcp_configuration_validated"
    assert payload["request_id"] == "cli-serve"
    assert "tool_name" in payload
    assert "timestamp" in payload
    assert payload["level"] == "info"


def test_cli_serve_fails_fast_without_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("APIOME_MCP_")}
    env["PYTHONPATH"] = str(_ROOT / "src")
    env["APIOME_MCP_INTERNAL_SECRET"] = "t" * 16

    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            [sys.executable, "-m", "apiome_mcp", "serve"],
            capture_output=True,
            text=True,
            check=False,
            cwd=tmpdir,
            env=env,
        )
    assert result.returncode != 0
    combined = result.stderr + result.stdout
    assert "database_url" in combined.lower() or "DATABASE_URL" in combined


def test_settings_mock_public_base_url_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """AGX-2.4 mock root mirrors apiome-rest's default so compose stays consistent."""
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "z" * 16)
    monkeypatch.delenv("APIOME_MCP_MOCK_PUBLIC_BASE_URL", raising=False)

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.mock_public_base_url == "http://localhost:8775"


def test_settings_mock_public_base_url_strips_trailing_slash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "z" * 16)
    monkeypatch.setenv("APIOME_MCP_MOCK_PUBLIC_BASE_URL", "https://mock.apiome.dev/")

    from apiome_mcp.settings import Settings

    s = Settings(_env_file=None)
    assert s.mock_public_base_url == "https://mock.apiome.dev"


def test_settings_mock_public_base_url_rejects_non_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail fast at startup rather than routing agent traffic at an unusable root."""
    monkeypatch.setenv("APIOME_MCP_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MCP_INTERNAL_SECRET", "z" * 16)
    monkeypatch.setenv("APIOME_MCP_MOCK_PUBLIC_BASE_URL", "mock.apiome.dev")

    from apiome_mcp.settings import Settings

    with pytest.raises(ValueError):
        Settings(_env_file=None)
