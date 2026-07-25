"""README content checks for install, config, import, and list examples."""

from pathlib import Path

import pytest

README_PATH = Path(__file__).resolve().parents[1] / "README.md"


@pytest.fixture
def readme() -> str:
    """Load package README text."""
    return README_PATH.read_text(encoding="utf-8")


def test_readme_exists() -> None:
    """README.md is present at the package root."""
    assert README_PATH.is_file()


def test_readme_documents_install_section(readme: str) -> None:
    """README includes an Install section with uv sync."""
    assert "## Install" in readme
    assert "uv sync" in readme
    assert "apiome --version" in readme


def test_readme_documents_configuration(readme: str) -> None:
    """README documents env vars, .env, and user config file."""
    assert "## Configuration" in readme
    assert "APIOME_BASE_URL" in readme
    assert "APIOME_API_KEY" in readme
    assert ".env.example" in readme
    assert "config.toml" in readme
    assert "CLI flags" in readme


def test_readme_examples_are_copy_pasteable(readme: str) -> None:
    """README Examples section includes install, config, import, and list commands."""
    assert "## Examples" in readme
    examples_start = readme.index("## Examples")
    examples = readme[examples_start:]

    for command in (
        "apiome config set base-url",
        "apiome config show",
        "apiome import openapi",
        "apiome import arazzo",
        "apiome import json-schema",
        "apiome import json-schema-type",
        "apiome projects list",
        "apiome properties list",
        "apiome schemas list",
        "apiome types list",
        "apiome types show email",
        "apiome versions list",
        "apiome paths list",
        "apiome paths show",
        "apiome operations show",
        "apiome workflows list",
        "apiome workflows show",
        "apiome spec export",
        "apiome spec download-original",
    ):
        assert command in examples, f"missing example command: {command}"

    assert "### OpenAPI/Arazzo path workflow" in examples
    assert "import → inspect → export" in examples
    assert "```bash" in examples
    assert "export APIOME_BASE_URL" in examples


def test_readme_documents_repository_store_subcommands(readme: str) -> None:
    """README documents each repos subcommand with copy-pasteable examples."""
    assert "### Repository Store" in readme
    assert "#### `repos list`" in readme
    assert "#### `repos add`" in readme
    assert "#### `repos scan`" in readme
    assert "#### `repos files`" in readme
    assert "#### `repos inspect`" in readme
    assert "#### `repos verify`" in readme
    assert "#### `repos import`" in readme
    assert "#### `repos imports`" in readme

    repo_section_start = readme.index("### Repository Store")
    repo_section = readme[repo_section_start:]

    for command in (
        "apiome repos list",
        "apiome repos add --url",
        "apiome repos add --account",
        "apiome repos scan",
        "apiome repos files",
        "apiome repos inspect",
        "apiome repos verify",
        "apiome repos import",
        "apiome repos imports",
    ):
        assert command in repo_section, f"missing repos example: {command}"

    assert "--deep" in repo_section
    assert "--manifest" in repo_section
    assert "add` → `scan` → `files` → `inspect` → `import` → `imports`" in repo_section


def test_readme_documents_preflight_and_gate_exit_codes(readme: str) -> None:
    """AC-5: both pre-flight commands and their exit codes are in the CLI reference."""
    assert "### Pre-flight and CI quality gates" in readme
    section_start = readme.index("### Pre-flight and CI quality gates")
    section = readme[section_start : readme.index("### Import auto-detect")]

    for command in (
        "apiome import preflight",
        "apiome --json import preflight",
        "apiome export preflight",
        "apiome --json export preflight",
        "apiome import openapi ./payments.json --min-grade B",
        "apiome export openapi --project payments-api",
    ):
        assert command in section, f"missing pre-flight example: {command}"

    for flag in ("--min-grade", "--fail-on", "--to openapi"):
        assert flag in section, f"missing pre-flight flag: {flag}"

    # Each documented gate exit code, distinct from transport (1) and usage/auth (2).
    for code in ("| `3` |", "| `4` |", "| `5` |"):
        assert code in section, f"missing documented exit code row: {code}"
    assert "Waivers." in section


def test_readme_references_clig_dev(readme: str) -> None:
    """README cites clig.dev CLI guidelines."""
    assert "clig.dev" in readme


def test_readme_documents_mock_commands(readme: str) -> None:
    """README documents hosted-mock management with copy-pasteable examples."""
    assert "### Manage hosted mocks" in readme
    mock_section_start = readme.index("### Manage hosted mocks")
    mock_section = readme[mock_section_start:]

    for command in (
        "apiome mock status payments-api 1.0.0",
        "apiome mock enable payments-api 1.0.0",
        "apiome mock disable payments-api 1.0.0",
        "apiome --json mock status payments-api 1.0.0",
    ):
        assert command in mock_section, f"missing mock example: {command}"

    assert "--days" in mock_section
    assert "published" in mock_section
