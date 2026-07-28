"""Declared-configuration tests for the portable runtime (#4742, PMR-1.2).

The acceptance criterion is "runtime configuration uses declared flags/environment only", so these
tests treat :data:`RUNTIME_OPTIONS` as the contract and check both directions: nothing settable is
undeclared, and nothing declared is unreachable.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest
from pydantic import ValidationError

from apiome_mock.portable_config import (
    ENV_PREFIX,
    RUNTIME_OPTIONS,
    SECRET_FIELDS,
    PortableSettings,
    add_runtime_arguments,
    option_for_field,
    settings_from_args,
)

DOC_PATH = Path(__file__).resolve().parent.parent.parent / "docs" / "guide" / "portable-mock-runtime.md"


def _parse(argv: list[str]) -> argparse.Namespace:
    """Parse ``argv`` with a parser built from the declared options."""
    parser = argparse.ArgumentParser()
    add_runtime_arguments(parser)
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# The declaration is the contract
# ---------------------------------------------------------------------------


def test_every_settings_field_is_declared() -> None:
    """A knob that exists but is not declared would be settable only by accident."""
    declared = {option.field for option in RUNTIME_OPTIONS}
    assert set(PortableSettings.model_fields) == declared


def test_every_declared_option_names_a_real_field() -> None:
    """A declared knob that maps to no field would produce a flag that silently does nothing."""
    for option in RUNTIME_OPTIONS:
        assert option.field in PortableSettings.model_fields
        assert option_for_field(option.field) is option


def test_every_option_declares_a_prefixed_environment_variable() -> None:
    """Environment access is uniform, so a deployment can configure everything without flags."""
    for option in RUNTIME_OPTIONS:
        assert option.env.startswith(ENV_PREFIX)
        assert option.env == option.env.upper()
        assert option.help.strip()


def test_option_flags_are_unique_and_long_form() -> None:
    """Two options sharing a flag would make one of them unreachable."""
    flags = [option.flag for option in RUNTIME_OPTIONS if option.flag is not None]
    assert len(flags) == len(set(flags))
    assert all(flag.startswith("--") for flag in flags)


def test_the_signing_secret_has_no_command_line_flag() -> None:
    """Secrets on a command line are readable by every user on the box via ps."""
    for field in SECRET_FIELDS:
        assert option_for_field(field).flag is None


def test_documentation_lists_every_declared_option() -> None:
    """The published reference table and the code cannot drift apart."""
    documentation = DOC_PATH.read_text(encoding="utf-8")
    for option in RUNTIME_OPTIONS:
        assert option.env in documentation, f"{option.env} is not documented"
        if option.flag is not None:
            assert option.flag in documentation, f"{option.flag} is not documented"


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def test_defaults_apply_when_nothing_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(f"{ENV_PREFIX}HTTP_PORT", raising=False)

    settings = settings_from_args(_parse([]))

    assert settings.http_host == "127.0.0.1"
    assert settings.http_port == 8775
    assert settings.base_path == "version"
    assert settings.bundle == ""
    assert settings.access_log is True


def test_environment_configures_every_flagged_option(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(f"{ENV_PREFIX}BUNDLE", "/bundle/mock-bundle.json")
    monkeypatch.setenv(f"{ENV_PREFIX}HTTP_HOST", "0.0.0.0")
    monkeypatch.setenv(f"{ENV_PREFIX}HTTP_PORT", "9001")
    monkeypatch.setenv(f"{ENV_PREFIX}BASE_PATH", "root")
    monkeypatch.setenv(f"{ENV_PREFIX}REQUIRE_SIGNATURE", "true")
    monkeypatch.setenv(f"{ENV_PREFIX}LOG_LEVEL", "debug")

    settings = settings_from_args(_parse([]))

    assert settings.bundle == "/bundle/mock-bundle.json"
    assert settings.http_host == "0.0.0.0"
    assert settings.http_port == 9001
    assert settings.base_path == "root"
    assert settings.require_signature is True
    assert settings.log_level == "DEBUG"


def test_flags_win_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit flag is the operator speaking now; the environment is ambient."""
    monkeypatch.setenv(f"{ENV_PREFIX}HTTP_PORT", "9001")

    settings = settings_from_args(_parse(["--port", "9100"]))

    assert settings.http_port == 9100


def test_omitted_flags_do_not_mask_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flags default to None so "not given" stays distinct from "given the default"."""
    monkeypatch.setenv(f"{ENV_PREFIX}HTTP_HOST", "0.0.0.0")

    settings = settings_from_args(_parse(["--port", "9100"]))

    assert settings.http_host == "0.0.0.0"


def test_secret_is_read_from_the_environment_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(f"{ENV_PREFIX}BUNDLE_SECRET", "shhh")

    settings = settings_from_args(_parse([]))

    assert settings.bundle_secret == "shhh"


def test_no_access_log_switch_disables_the_access_log() -> None:
    assert settings_from_args(_parse(["--no-access-log"])).access_log is False


def test_dot_env_files_are_ignored(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A portable runtime must not absorb whatever .env happens to sit in the working directory."""
    (tmp_path / ".env").write_text(f"{ENV_PREFIX}HTTP_PORT=4321\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv(f"{ENV_PREFIX}HTTP_PORT", raising=False)

    assert settings_from_args(_parse([])).http_port == 8775


def test_undeclared_environment_variables_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(f"{ENV_PREFIX}DATABASE_URL", "postgresql://nope/nope")

    settings = settings_from_args(_parse([]))

    assert not hasattr(settings, "database_url")


@pytest.mark.parametrize(
    "argv",
    [
        ["--port", "0"],
        ["--port", "70000"],
        ["--base-path", "sideways"],
        ["--log-level", "LOUD"],
        ["--session-ttl", "-1"],
    ],
)
def test_invalid_values_are_rejected(argv: list[str]) -> None:
    """Fail-fast beats serving with a nonsensical knob."""
    with pytest.raises(ValidationError):
        settings_from_args(_parse(argv))


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def test_redacted_reports_every_option_without_leaking_the_secret() -> None:
    settings = PortableSettings(bundle="/tmp/bundle.json", bundle_secret="top-secret")

    payload = settings.redacted()

    assert set(payload) == {option.field for option in RUNTIME_OPTIONS}
    assert payload["bundle_secret"] == "set"
    assert "top-secret" not in str(payload)


def test_redacted_reports_an_unset_secret_as_unset() -> None:
    assert PortableSettings().redacted()["bundle_secret"] == "unset"


# ---------------------------------------------------------------------------
# Environment-free construction
# ---------------------------------------------------------------------------


def test_isolated_settings_ignore_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """The conformance selftest must not be steered by a deployment's ambient tuning."""
    monkeypatch.setenv(f"{ENV_PREFIX}BASE_PATH", "root")
    monkeypatch.setenv(f"{ENV_PREFIX}SESSION_MAX_RESOURCES", "1")
    monkeypatch.setenv(f"{ENV_PREFIX}BUNDLE_SECRET", "ambient")
    monkeypatch.setenv(f"{ENV_PREFIX}REQUIRE_SIGNATURE", "true")

    settings = PortableSettings.isolated(bundle="/tmp/bundle.json")

    assert settings.bundle == "/tmp/bundle.json"
    assert settings.base_path == "version"
    assert settings.session_max_resources == 200
    assert settings.bundle_secret is None
    assert settings.require_signature is False


def test_isolated_settings_cover_every_declared_field() -> None:
    """A field added later must get a default here too, not silently fall back to the environment."""
    isolated = PortableSettings.isolated(bundle="/tmp/bundle.json")

    for option in RUNTIME_OPTIONS:
        assert hasattr(isolated, option.field)
