"""Serverless deployment preflight tests (#4743, PMR-1.3).

Preflight is the surface that turns "cold-start, size, and timeout constraints are surfaced" from a
sentence into numbers a CI job can branch on, so what is asserted here is that each constraint
produces the finding it should — including the ones that must *not* fire on a healthy bundle.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest
from app.mock_bundle import BundleIdentity, build_bundle, bundle_bytes

from apiome_mock.cli import main
from apiome_mock.cli_run import EXIT_CONFIG_ERROR, EXIT_OK, EXIT_SERVERLESS_FAILED
from apiome_mock.conformance import DEFAULT_BUNDLE_PATH
from apiome_mock.serverless import ColdStart
from apiome_mock.serverless_preflight import (
    ERROR,
    NOTE,
    WARNING,
    _cold_start_findings,
    preflight,
)
from apiome_mock.serverless_providers import PROVIDER_NAMES, Provider, ProviderLimits, provider_for

SECRET = "serverless-signing-secret"

_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Tiny", "version": "1.0.0"},
    "paths": {"/things": {"get": {"responses": {"200": {"description": "ok"}}}}},
}


def _write_bundle(tmp_path: Path, *, secret: str | None = None, spec: dict[str, Any] | None = None) -> Path:
    """Write a bundle to disk exactly as the exporter would."""
    document = build_bundle(
        identity=BundleIdentity(
            tenant="acme",
            project="tiny",
            version="1.0.0",
            revision_id="11111111-2222-3333-4444-555555555555",
        ),
        spec=spec if spec is not None else _SPEC,
        secret=secret,
    )
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


def _codes(report: Any, level: str) -> set[str]:
    """The finding codes reported at one level."""
    return {finding.code for finding in report.findings if finding.level == level}


def _printed_document(printed: str) -> Any:
    """Parse the pretty-printed report out of captured stdout.

    Structlog caches a bound logger on first use, so a logger another test bound at INFO can still
    write single-line JSON onto this stream. The report is the only document printed with
    indentation, and therefore the only one whose opening brace is a line of its own.
    """
    lines = printed.splitlines()
    start = next(index for index, line in enumerate(lines) if line == "{")
    return json.loads("\n".join(lines[start:]))


def _with_limits(provider: Provider, **overrides: Any) -> Provider:
    """Copy a provider with some of its published limits replaced, for the boundary tests."""
    return dataclasses.replace(provider, limits=_limits_with(provider.limits, **overrides))


# ---------------------------------------------------------------------------
# A healthy bundle
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("provider_name", PROVIDER_NAMES)
def test_a_signed_bundle_is_deployable_to_every_provider(tmp_path: Path, provider_name: str) -> None:
    """The shipped path has to come back clean, or the report would be noise nobody reads."""
    report = preflight(
        _write_bundle(tmp_path, secret=SECRET),
        provider=provider_for(provider_name),
        secret=SECRET,
    )

    assert report.ok
    assert report.errors == ()
    assert report.warnings == ()
    assert report.digest is not None and report.signed is True


def test_a_healthy_bundle_reports_every_constraint_as_a_note(tmp_path: Path) -> None:
    """Constraints are surfaced whether or not anything is wrong with them."""
    report = preflight(_write_bundle(tmp_path, secret=SECRET), provider=provider_for("aws-lambda"), secret=SECRET)

    assert {
        "bundle-fits-package-budget",
        "cold-start-within-budget",
        "request-timeout",
        "payload-limits",
        "session-state-is-per-instance",
    } <= _codes(report, NOTE)


def test_cold_start_and_warm_latency_are_both_measured(tmp_path: Path) -> None:
    """Initialization is performed rather than estimated, and warm is measured to compare against."""
    report = preflight(_write_bundle(tmp_path), provider=provider_for("aws-lambda"))

    assert report.cold_start is not None and report.cold_start.total_ms > 0
    assert report.warm_ms is not None and report.warm_ms >= 0


def test_the_report_renders_for_json_output(tmp_path: Path) -> None:
    """CI reads the JSON, so it has to be complete and serializable."""
    report = preflight(_write_bundle(tmp_path), provider=provider_for("gcp-functions"))
    document = json.loads(json.dumps(report.as_dict()))

    assert document["ok"] is True
    assert document["provider"]["name"] == "gcp-functions"
    assert document["bundle"]["digest"] == report.digest
    assert document["coldStart"]["totalMs"] > 0
    assert document["findings"]


def test_findings_are_ordered_most_severe_first(tmp_path: Path) -> None:
    """A reader who stops after the first line must have read the worst news."""
    report = preflight(_write_bundle(tmp_path), provider=provider_for("aws-lambda"))
    levels = [finding.level for finding in report.findings]

    assert levels == sorted(levels, key=lambda level: {ERROR: 0, WARNING: 1, NOTE: 2}[level])


# ---------------------------------------------------------------------------
# Findings that should fire
# ---------------------------------------------------------------------------


def test_an_unsigned_bundle_is_a_warning(tmp_path: Path) -> None:
    """Unsigned works, so it is not an error — but a swapped bundle is worth naming."""
    report = preflight(_write_bundle(tmp_path), provider=provider_for("aws-lambda"))

    assert report.ok
    assert "bundle-unsigned" in _codes(report, WARNING)


def test_a_bundle_carrying_a_provider_credential_is_not_deployable(tmp_path: Path) -> None:
    """The acceptance criterion, reported rather than raised so one run shows everything."""
    spec = json.loads(json.dumps(_SPEC))
    spec["info"]["description"] = "Use AKIAIOSFODNN7EXAMPLE"
    report = preflight(_write_bundle(tmp_path, spec=spec), provider=provider_for("aws-lambda"))

    assert not report.ok
    assert "provider-secret-aws-access-key-id" in _codes(report, ERROR)
    assert report.cold_start is None  # a credential-bearing bundle is never compiled


def test_a_missing_bundle_is_reported_not_raised(tmp_path: Path) -> None:
    """Preflight is a report; a caller should get findings back, not an exception to catch."""
    report = preflight(tmp_path / "absent.json", provider=provider_for("aws-lambda"))

    assert not report.ok
    assert "bundle-invalid" in _codes(report, ERROR)


def test_an_oversized_bundle_cannot_be_deployed(tmp_path: Path) -> None:
    """The package budget is the hard edge a deploy fails on; preflight must find it first."""
    provider = _with_limits(provider_for("aws-lambda"), max_package_bytes=128)

    report = preflight(_write_bundle(tmp_path), provider=provider)

    assert not report.ok
    assert "bundle-exceeds-package-limit" in _codes(report, ERROR)


def test_a_bundle_using_most_of_the_package_budget_is_a_warning(tmp_path: Path) -> None:
    """The runtime and its dependencies share that budget, so "under the limit" is not enough."""
    path = _write_bundle(tmp_path)
    provider = _with_limits(provider_for("aws-lambda"), max_package_bytes=path.stat().st_size * 2)

    report = preflight(path, provider=provider)

    assert report.ok
    assert "bundle-uses-most-of-package-budget" in _codes(report, WARNING)


def test_a_cold_start_over_the_budget_is_an_error(tmp_path: Path) -> None:
    """On AWS, blowing the init budget makes the first invocation pay for initialization twice."""
    provider = _with_limits(provider_for("aws-lambda"), max_init_seconds=0.000001)

    report = preflight(_write_bundle(tmp_path), provider=provider)

    assert not report.ok
    assert "cold-start-exceeds-budget" in _codes(report, ERROR)


@pytest.mark.parametrize(
    ("total_ms", "level", "code"),
    [
        (1_000.0, NOTE, "cold-start-within-budget"),
        (6_000.0, WARNING, "cold-start-uses-most-of-budget"),
        (11_000.0, ERROR, "cold-start-exceeds-budget"),
    ],
)
def test_the_cold_start_bands_are_measured_against_the_published_budget(total_ms: float, level: str, code: str) -> None:
    """The bands are asserted on a fixed measurement: a real one would make this test a stopwatch.

    AWS Lambda publishes a 10s initialization budget, so 1s is comfortable, 6s is past the
    warning ratio, and 11s is over the edge.
    """
    findings = _cold_start_findings(
        ColdStart(bundle_ms=total_ms / 2, app_ms=total_ms / 2, total_ms=total_ms),
        provider_for("aws-lambda"),
    )

    assert [(finding.level, finding.code) for finding in findings] == [(level, code)]


def _limits_with(base: ProviderLimits, **overrides: Any) -> ProviderLimits:
    """Copy published limits with a field replaced, for the boundary tests."""
    fields = {
        "max_package_bytes": base.max_package_bytes,
        "max_request_bytes": base.max_request_bytes,
        "max_response_bytes": base.max_response_bytes,
        "max_function_timeout_seconds": base.max_function_timeout_seconds,
        "max_gateway_timeout_seconds": base.max_gateway_timeout_seconds,
        "max_init_seconds": base.max_init_seconds,
        "docs_url": base.docs_url,
        "verified_on": base.verified_on,
        "notes": base.notes,
    }
    fields.update(overrides)
    return ProviderLimits(**fields)


# ---------------------------------------------------------------------------
# The command line
# ---------------------------------------------------------------------------


def test_serverless_command_reports_a_healthy_bundle(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["serverless", "--bundle", str(_write_bundle(tmp_path)), "--provider", "aws-lambda"])
    printed = capsys.readouterr().out

    assert code == EXIT_OK
    assert "apiome_mock.serverless.aws_lambda_handler" in printed
    assert "AWS Lambda: ready" in printed


def test_serverless_command_emits_json(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["serverless", "--bundle", str(_write_bundle(tmp_path)), "--json"])
    document = _printed_document(capsys.readouterr().out)

    assert code == EXIT_OK
    assert document["preflight"]["ok"] is True
    assert "conformance" not in document


def test_serverless_command_exits_seven_when_the_bundle_is_not_deployable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """CI branches on the code; 7 has to mean exactly "cannot be deployed"."""
    spec = json.loads(json.dumps(_SPEC))
    spec["info"]["description"] = "AKIAIOSFODNN7EXAMPLE"

    code = main(["serverless", "--bundle", str(_write_bundle(tmp_path, spec=spec))])
    printed = capsys.readouterr().out

    assert code == EXIT_SERVERLESS_FAILED
    assert "provider-secret-aws-access-key-id" in printed


def test_serverless_command_requires_something_to_do(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """No bundle and no --conformance leaves nothing to check, so it is a configuration error."""
    monkeypatch.delenv("APIOME_MOCK_BUNDLE", raising=False)

    with pytest.raises(SystemExit) as excinfo:
        main(["serverless"])

    assert excinfo.value.code == EXIT_CONFIG_ERROR
    assert "APIOME_MOCK_BUNDLE" in capsys.readouterr().err


def test_conformance_alone_needs_no_bundle(capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    """Proving the invocation path is about the runtime, so it must not require a bundle to check."""
    monkeypatch.delenv("APIOME_MOCK_BUNDLE", raising=False)

    code = main(["serverless", "--provider", "gcp-functions", "--conformance", "--json"])
    document = _printed_document(capsys.readouterr().out)

    assert code == EXIT_OK
    assert "preflight" not in document
    assert document["conformance"]["ok"] is True


def test_serverless_command_runs_the_corpus_through_provider_events(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``--conformance`` proves the invocation path, using the packaged bundle deliberately."""
    code = main(
        [
            "serverless",
            "--bundle",
            str(_write_bundle(tmp_path)),
            "--provider",
            "azure-functions",
            "--conformance",
            "--json",
        ]
    )
    document = _printed_document(capsys.readouterr().out)

    assert code == EXIT_OK
    assert document["conformance"]["ok"] is True
    assert document["conformance"]["passed"] == document["conformance"]["total"]
    # The corpus runs against the packaged bundle, not the one being preflighted.
    assert document["preflight"]["bundle"]["path"] != str(DEFAULT_BUNDLE_PATH)


def test_serverless_help_lists_every_supported_provider(capsys: pytest.CaptureFixture[str]) -> None:
    """The supported set is a documented deployment decision; --help is where it is read."""
    with pytest.raises(SystemExit):
        main(["serverless", "--help"])

    printed = capsys.readouterr().out
    for name in PROVIDER_NAMES:
        assert name in printed
