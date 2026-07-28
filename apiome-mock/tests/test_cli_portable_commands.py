"""``apiome-mock run``/``verify``/``conformance``/``selftest`` tests (#4742, PMR-1.2).

The portable CLI is what CI scripts branch on, so the exit codes and the failure messages are the
contract under test here — not just the happy path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from app.mock_bundle import BundleIdentity, build_bundle, bundle_bytes

from apiome_mock.cli import main
from apiome_mock.cli_run import (
    EXIT_BUNDLE_INCOMPATIBLE,
    EXIT_BUNDLE_INVALID,
    EXIT_CONFIG_ERROR,
    EXIT_CONFORMANCE_FAILED,
    EXIT_OK,
    EXIT_PARITY_FAILED,
)
from apiome_mock.conformance import DEFAULT_BUNDLE_PATH
from apiome_mock.portable_config import RUNTIME_OPTIONS

SECRET = "conformance-signing-secret"

_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Tiny", "version": "1.0.0"},
    "paths": {"/things": {"get": {"responses": {"200": {"description": "ok"}}}}},
}


def _write_bundle(tmp_path: Path, *, secret: str | None = None, **overrides: Any) -> Path:
    """Write a bundle to disk exactly as the exporter would."""
    document = build_bundle(
        identity=BundleIdentity(
            tenant="acme",
            project="tiny",
            version="1.0.0",
            revision_id="11111111-2222-3333-4444-555555555555",
        ),
        spec=_SPEC,
        secret=secret,
    )
    document.update(overrides)
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


# ---------------------------------------------------------------------------
# Argument surface
# ---------------------------------------------------------------------------


def test_run_help_lists_every_declared_option(capsys: pytest.CaptureFixture[str]) -> None:
    """The help text is generated from the declaration, so it can never omit a knob."""
    with pytest.raises(SystemExit):
        main(["run", "--help"])

    printed = capsys.readouterr().out
    for option in RUNTIME_OPTIONS:
        if option.flag is not None:
            assert option.flag in printed
            assert option.env in printed or option.kind == "flag"


def test_no_subcommand_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == EXIT_OK
    assert "usage: apiome-mock" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# run --print-config
# ---------------------------------------------------------------------------


def test_print_config_reports_the_resolved_configuration(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_HTTP_HOST", "0.0.0.0")
    bundle = _write_bundle(tmp_path)

    assert main(["run", "--bundle", str(bundle), "--port", "9100", "--print-config"]) == EXIT_OK

    payload = json.loads(capsys.readouterr().out)
    assert payload["bundle"] == str(bundle)
    assert payload["http_host"] == "0.0.0.0"
    assert payload["http_port"] == 9100


def test_print_config_never_prints_the_secret(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", SECRET)
    bundle = _write_bundle(tmp_path, secret=SECRET)

    main(["run", "--bundle", str(bundle), "--print-config"])

    printed = capsys.readouterr().out
    assert SECRET not in printed
    assert json.loads(printed)["bundle_secret"] == "set"


def test_invalid_flag_value_exits_with_the_configuration_code(tmp_path: Path) -> None:
    bundle = _write_bundle(tmp_path)

    with pytest.raises(SystemExit) as exit_info:
        main(["run", "--bundle", str(bundle), "--port", "0"])

    assert exit_info.value.code == EXIT_CONFIG_ERROR


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------


def test_verify_reports_what_the_bundle_contains(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle = _write_bundle(tmp_path)

    assert main(["verify", "--bundle", str(bundle)]) == EXIT_OK

    printed = capsys.readouterr().out
    assert "Bundle verified: acme/tiny/1.0.0" in printed
    assert "sha256:" in printed


def test_verify_json_output_is_machine_readable(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle = _write_bundle(tmp_path)

    assert main(["verify", "--bundle", str(bundle), "--json"]) == EXIT_OK

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["bundle"]["operations"] == ["GET /things"]
    assert payload["bundle"]["source"] == str(bundle)


def test_verify_without_a_bundle_is_a_configuration_error(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["verify"])

    assert exit_info.value.code == EXIT_CONFIG_ERROR
    assert "APIOME_MOCK_BUNDLE" in capsys.readouterr().err


def test_verify_reads_the_bundle_path_from_the_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path)))

    assert main(["verify", "--json"]) == EXIT_OK


def test_verify_rejects_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["verify", "--bundle", str(tmp_path / "absent.json")])

    assert exit_info.value.code == EXIT_BUNDLE_INVALID


def test_verify_rejects_a_tampered_bundle(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle = _write_bundle(tmp_path)
    document = json.loads(bundle.read_text(encoding="utf-8"))
    document["spec"]["info"]["title"] = "Swapped"
    bundle.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(SystemExit) as exit_info:
        main(["verify", "--bundle", str(bundle)])

    assert exit_info.value.code == EXIT_BUNDLE_INVALID
    assert "digest-mismatch" in capsys.readouterr().err


def test_verify_rejects_an_unsigned_bundle_when_a_signature_is_required(tmp_path: Path) -> None:
    bundle = _write_bundle(tmp_path)

    with pytest.raises(SystemExit) as exit_info:
        main(["verify", "--bundle", str(bundle), "--require-signature"])

    assert exit_info.value.code == EXIT_BUNDLE_INVALID


def test_verify_accepts_a_signed_bundle_with_the_configured_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", SECRET)
    bundle = _write_bundle(tmp_path, secret=SECRET)

    assert main(["verify", "--bundle", str(bundle), "--require-signature"]) == EXIT_OK


def test_verify_rejects_a_signature_from_a_different_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", "not-the-secret")
    bundle = _write_bundle(tmp_path, secret=SECRET)

    with pytest.raises(SystemExit) as exit_info:
        main(["verify", "--bundle", str(bundle)])

    assert exit_info.value.code == EXIT_BUNDLE_INVALID


def test_verify_separates_incompatibility_from_corruption(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A bundle from a future format is a different problem than a broken one, and says so."""
    document = build_bundle(
        identity=BundleIdentity(tenant="acme", project="tiny", version="1.0.0", revision_id="x"),
        spec=_SPEC,
    )
    document["manifest"]["runtime"]["minRuntimeVersion"] = "99.0.0"
    document["manifest"]["runtime"]["maxRuntimeVersion"] = "100.0.0"
    path = tmp_path / "future.json"
    path.write_bytes(bundle_bytes(document))

    with pytest.raises(SystemExit) as exit_info:
        main(["verify", "--bundle", str(path)])

    assert exit_info.value.code == EXIT_BUNDLE_INCOMPATIBLE
    assert "runtime-too-old" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# conformance / selftest
# ---------------------------------------------------------------------------


def test_conformance_against_an_unreachable_runtime_fails(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["conformance", "--base-url", "http://127.0.0.1:1", "--wait", "0"])

    assert code == EXIT_CONFORMANCE_FAILED
    assert "conformance cases passed" in capsys.readouterr().out


def test_conformance_reports_a_readiness_timeout(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["conformance", "--base-url", "http://127.0.0.1:1", "--wait", "0.2"])

    assert code == EXIT_CONFORMANCE_FAILED
    assert "did not become ready" in capsys.readouterr().err


def test_conformance_rejects_an_unreadable_corpus(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["conformance", "--base-url", "http://127.0.0.1:1", "--corpus", str(tmp_path / "absent.json")])

    assert exit_info.value.code == EXIT_CONFIG_ERROR
    assert "corpus could not be loaded" in capsys.readouterr().err


def test_selftest_serves_the_packaged_bundle_and_passes(capsys: pytest.CaptureFixture[str]) -> None:
    """One command proves a deployment of the runtime answers the corpus — no mount, no port."""
    assert main(["selftest", "--json"]) == EXIT_OK

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["failed"] == 0
    assert payload["total"] >= 20


def test_selftest_ignores_a_configured_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The subject under test is the runtime, not whichever bundle happens to be mounted."""
    monkeypatch.setenv("APIOME_MOCK_BUNDLE", str(_write_bundle(tmp_path)))

    assert main(["selftest", "--json"]) == EXIT_OK
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_selftest_ignores_ambient_runtime_tuning(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Environment left over from a deployment must not fail cases about the runtime itself."""
    monkeypatch.setenv("APIOME_MOCK_BASE_PATH", "root")
    monkeypatch.setenv("APIOME_MOCK_SESSION_MAX_RESOURCES", "1")
    monkeypatch.setenv("APIOME_MOCK_BUNDLE_SECRET", SECRET)
    monkeypatch.setenv("APIOME_MOCK_REQUIRE_SIGNATURE", "true")

    assert main(["selftest", "--json"]) == EXIT_OK
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_the_packaged_bundle_is_the_one_selftest_serves() -> None:
    assert DEFAULT_BUNDLE_PATH.is_file()


# ---------------------------------------------------------------------------
# parity (#4748, PMR-3.1)
# ---------------------------------------------------------------------------


def test_parity_against_two_unreachable_deployments_reports_every_case(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Both sides failing is a parity failure, not a crash — and every case is still reported."""
    code = main(
        [
            "parity",
            "--hosted-url",
            "http://127.0.0.1:1",
            "--portable-url",
            "http://127.0.0.1:2",
            "--wait",
            "0",
            "--json",
        ]
    )

    assert code == EXIT_PARITY_FAILED
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["mismatched"] == payload["compared"]
    assert payload["skipped"] == 2  # /health and /ready describe the deployment, not the contract
    assert all(
        "hosted request failed" in "".join(case["differences"]) for case in payload["cases"] if not case["skipped"]
    )


def test_parity_reports_a_portable_readiness_timeout(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        [
            "parity",
            "--hosted-url",
            "http://127.0.0.1:1",
            "--portable-url",
            "http://127.0.0.1:2",
            "--wait",
            "0.2",
        ]
    )

    assert code == EXIT_CONFORMANCE_FAILED
    assert "did not become ready" in capsys.readouterr().err


def test_parity_rejects_an_unreadable_corpus(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(
            [
                "parity",
                "--hosted-url",
                "http://127.0.0.1:1",
                "--portable-url",
                "http://127.0.0.1:2",
                "--corpus",
                str(tmp_path / "absent.json"),
            ]
        )

    assert exit_info.value.code == EXIT_CONFIG_ERROR
    assert "corpus could not be loaded" in capsys.readouterr().err


def test_parity_prints_a_human_report_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        [
            "parity",
            "--hosted-url",
            "http://127.0.0.1:1",
            "--portable-url",
            "http://127.0.0.1:2",
            "--wait",
            "0",
        ]
    )
    output = capsys.readouterr().out

    assert code == EXIT_PARITY_FAILED
    assert "[SKIP] health-is-reserved-and-live (deployment-shape endpoint)" in output
    assert "[DIFF]" in output
    assert "cases match between hosted and portable" in output
