"""AGENTS.md content checks for layout, clig.dev, and REST contract references."""

from pathlib import Path

import pytest

AGENTS_PATH = Path(__file__).resolve().parents[1] / "AGENTS.md"


@pytest.fixture
def agents() -> str:
    """Load package AGENTS.md text."""
    return AGENTS_PATH.read_text(encoding="utf-8")


def test_agents_exists() -> None:
    """AGENTS.md is present at the package root."""
    assert AGENTS_PATH.is_file()


def test_agents_documents_layout_and_commands(agents: str) -> None:
    """AGENTS.md documents package layout and Typer command groups."""
    assert "## Layout" in agents
    assert "src/apiome_cli/main.py" in agents
    assert "src/apiome_cli/commands/" in agents
    assert "`import`" in agents
    assert "`projects`" in agents
    assert "`auth`" in agents
    assert "`tokens`" in agents
    assert "`api-keys`" in agents
    assert "`integrations`" in agents
    assert "`repos`" in agents
    assert "`types`" in agents
    assert "`paths`" in agents
    assert "`operations`" in agents
    assert "`workflows`" in agents
    assert "`spec`" in agents
    assert "`arazzo`" in agents or "POST /imports/arazzo" in agents


def test_agents_references_clig_dev_and_rest_contract(agents: str) -> None:
    """AGENTS.md cites clig.dev and the REST OpenAPI contract."""
    assert "clig.dev" in agents
    assert "apiome-rest/openapi.yaml" in agents
    assert "spec.openapis.org/oas/v3.2.0" in agents
    assert "GET /versions/{version_id}/paths" in agents
    assert "GET /browse/tenants" in agents
    assert "POST /imports/arazzo" in agents


def test_agents_documents_repository_store_section(agents: str) -> None:
    """AGENTS.md documents Repository Store repos subcommands and REST surfaces."""
    assert "### Repository Store (`repos`)" in agents
    assert "`repos list`" in agents
    assert "`repos add`" in agents
    assert "`repos scan`" in agents
    assert "`repos files`" in agents
    assert "`repos inspect`" in agents
    assert "`repos verify`" in agents
    assert "`repos import`" in agents
    assert "`repos imports`" in agents
    assert "--deep" in agents
    assert "--manifest" in agents
    assert "POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/verify" in agents
    assert "POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/import" in agents
    assert "POST /tenants/{id}/repositories/{repository_id}/imports:manifest" in agents
    assert "GET /tenants/{id}/repositories/{repository_id}/imports" in agents
    assert "emit_import_result" in agents


def test_agents_documents_testing_and_yarn_commands(agents: str) -> None:
    """AGENTS.md documents test layout and turborepo scripts."""
    assert "## Testing" in agents
    assert "yarn cli:test" in agents
    assert "yarn cli:build" in agents
    assert "tests/integration/" in agents


def test_agents_documents_mock_commands(agents: str) -> None:
    """AGENTS.md documents the mock command group and its REST surfaces."""
    assert "`mock`" in agents
    assert "src/apiome_cli/client/mock_settings.py" in agents
    assert "PUT /v1/versions/{tenant}/{project}/{version_record_id}/mock" in agents
    assert "GET /v1/mocks/{tenant}/usage" in agents


def test_agents_documents_diff_command(agents: str) -> None:
    """AGENTS.md documents the classified-diff CI gate command (CTG-2.1)."""
    assert "`diff`" in agents
    assert "src/apiome_cli/output_diff.py" in agents
    assert "POST /v1/diff/{tenant_slug}/classified" in agents
    assert "--fail-on" in agents


def test_agents_documents_repository_refresh_commands(agents: str) -> None:
    """AGENTS.md documents the repository auto-refresh command group (RAR-5.6)."""
    assert "### Repository auto-refresh (`repository refresh`)" in agents
    assert "src/apiome_cli/client/repository_refresh.py" in agents
    assert "src/apiome_cli/repository_refresh_output.py" in agents
    assert "`repository refresh REPO`" in agents
    assert "`repository refresh status REPO`" in agents
    assert "POST /v1/tenants/{tenant_slug}/repositories/{repository_id}/refresh" in agents
    assert "GET /v1/tenants/{tenant_slug}/repositories/{repository_id}/refresh-history" in agents
    assert "GET /v1/tenants/{tenant_slug}/repository-imports/{id}/spec" in agents
