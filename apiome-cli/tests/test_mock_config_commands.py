"""Tests for ``apiome mock config pull|push|diff`` (#5530, MSC-1.4)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app
from apiome_cli.mock_config import CONFIG_FORMAT, serialize_document

pytestmark = pytest.mark.usefixtures("api_key_env")

runner = CliRunner()

_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
_BASE = f"http://localhost:8000/v1/versions/acme-corp/{_PROJECT_ID}/{_VERSION_ID}/mock"

_SCENARIOS_URL = f"{_BASE}/scenarios"
_CORRELATION_URL = f"{_BASE}/correlation"
_PACKS_URL = f"{_BASE}/fixture-packs"

_PROJECT = {"id": _PROJECT_ID, "name": "Payments API", "slug": "payments-api"}
_VERSION_LOOKUP = {"id": _VERSION_ID, "project_id": _PROJECT_ID, "version": "1.0.0"}

_STORED_SCENARIOS = {
    "scenarios": {
        "outage": {
            "description": "Everything is on fire",
            "operations": {"GET /pets": {"responses": [{"status": 503}]}},
            "chaos": None,
        }
    },
    "chaos": {"default": {"delayMs": 100}, "operations": {}},
}
_STORED_CORRELATION = {
    "correlation": {
        "mode": "inferred",
        "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
    }
}
_STORED_PACKS = {
    "packs": {"seed": {"packFormat": "apiome.mock.fixture-pack/v1", "data": {"tenant": "acme"}}},
    "digests": {"seed": "sha256:abc"},
}


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tier-2 commands require an API key and tenant scope."""
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _scope(httpx_mock: object) -> None:
    """Register project/version slug-to-UUID resolution responses."""
    httpx_mock.add_response(
        url="http://localhost:8000/v1/projects/acme-corp/by-slug/payments-api",
        json=_PROJECT,
    )
    httpx_mock.add_response(
        url=f"http://localhost:8000/v1/versions/acme-corp/{_PROJECT_ID}/by-version/1.0.0",
        json=_VERSION_LOOKUP,
    )


def _stored_config(httpx_mock: object) -> None:
    """Register the three reads a configuration pull performs."""
    httpx_mock.add_response(url=_SCENARIOS_URL, method="GET", json=_STORED_SCENARIOS)
    httpx_mock.add_response(url=_CORRELATION_URL, method="GET", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=_PACKS_URL, method="GET", json=_STORED_PACKS)


def _dry_run_accepted(httpx_mock: object) -> None:
    """Register the three validation calls a push always performs first."""
    httpx_mock.add_response(url=f"{_SCENARIOS_URL}?dryRun=true", method="PUT", json=_STORED_SCENARIOS)
    httpx_mock.add_response(url=f"{_CORRELATION_URL}?dryRun=true", method="PUT", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=f"{_PACKS_URL}?dryRun=true", method="PUT", json=_STORED_PACKS)


def _writes_accepted(httpx_mock: object) -> None:
    """Register the three writes an applied push performs."""
    httpx_mock.add_response(url=_SCENARIOS_URL, method="PUT", json=_STORED_SCENARIOS)
    httpx_mock.add_response(url=_CORRELATION_URL, method="PUT", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=_PACKS_URL, method="PUT", json=_STORED_PACKS)


def _pulled(httpx_mock: object, tmp_path: Path) -> Path:
    """Pull the stored configuration to a file and return its path."""
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    path = tmp_path / "mock-config.json"
    result = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0", "--out", str(path)])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    return path


# --------------------------------------------------------------------------- pull


def test_pull_prints_a_canonical_document(httpx_mock: object) -> None:
    _scope(httpx_mock)
    _stored_config(httpx_mock)

    result = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    document = json.loads(result.stdout)
    assert document["configFormat"] == CONFIG_FORMAT
    assert document["correlation"] == _STORED_CORRELATION["correlation"]
    assert document["scenarios"] == _STORED_SCENARIOS["scenarios"]
    assert document["chaos"] == _STORED_SCENARIOS["chaos"]
    assert document["fixturePacks"] == _STORED_PACKS["packs"]


def test_pull_carries_the_active_scenario(httpx_mock: object) -> None:
    """What the mock defaults to travels with the document (#5531, MSC-2.1)."""
    _scope(httpx_mock)
    httpx_mock.add_response(
        url=_SCENARIOS_URL, method="GET", json={**_STORED_SCENARIOS, "activeScenario": "outage"}
    )
    httpx_mock.add_response(url=_CORRELATION_URL, method="GET", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=_PACKS_URL, method="GET", json=_STORED_PACKS)

    result = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert json.loads(result.stdout)["activeScenario"] == "outage"


def test_pull_reports_no_active_scenario_as_null(httpx_mock: object) -> None:
    _scope(httpx_mock)
    _stored_config(httpx_mock)

    result = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    assert json.loads(result.stdout)["activeScenario"] is None


def test_pull_omits_the_derived_pack_digests(httpx_mock: object) -> None:
    """Digests describe the packs; they are not settings, so they never come back on a push."""
    _scope(httpx_mock)
    _stored_config(httpx_mock)

    result = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    assert "digests" not in json.loads(result.stdout)


def test_pull_is_byte_stable_across_runs(httpx_mock: object) -> None:
    for _ in range(2):
        _scope(httpx_mock)
        _stored_config(httpx_mock)

    first = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    second = runner.invoke(app, ["mock", "config", "pull", "payments-api", "1.0.0"])
    assert first.stdout == second.stdout


def test_pull_writes_the_document_to_out(httpx_mock: object, tmp_path: Path) -> None:
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    path = tmp_path / "mock-config.json"

    result = runner.invoke(
        app, ["mock", "config", "pull", "payments-api", "1.0.0", "--out", str(path)]
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert result.stdout.strip() == f"Wrote {path}"
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["configFormat"] == CONFIG_FORMAT
    assert document["scenarios"] == _STORED_SCENARIOS["scenarios"]


def test_pull_out_reports_the_path_and_document_in_json_mode(
    httpx_mock: object, tmp_path: Path
) -> None:
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    path = tmp_path / "mock-config.json"

    result = runner.invoke(
        app,
        ["--json", "mock", "config", "pull", "payments-api", "1.0.0", "--out", str(path)],
    )
    assert result.exit_code == EXIT_SUCCESS
    payload = json.loads(result.stdout)
    assert payload["path"] == str(path)
    assert payload["document"]["configFormat"] == CONFIG_FORMAT


def test_pull_reports_an_unwritable_out_path(httpx_mock: object, tmp_path: Path) -> None:
    _scope(httpx_mock)
    _stored_config(httpx_mock)

    result = runner.invoke(
        app,
        ["mock", "config", "pull", "payments-api", "1.0.0", "--out", str(tmp_path / "no" / "x.json")],
    )
    assert result.exit_code == EXIT_USAGE
    assert "Cannot write" in result.stderr


# --------------------------------------------------------------------------- diff


def test_diff_of_an_unedited_pull_reports_no_changes(httpx_mock: object, tmp_path: Path) -> None:
    """The acceptance criterion: pull, then diff, is a no-op."""
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)

    result = runner.invoke(
        app, ["mock", "config", "diff", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_SUCCESS
    assert "No changes" in result.stdout


def test_diff_exits_one_on_drift_and_names_what_changed(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    document = json.loads(path.read_text(encoding="utf-8"))
    document["scenarios"]["maintenance"] = {"description": "New", "operations": {}, "chaos": None}
    path.write_text(serialize_document(document), encoding="utf-8")

    _scope(httpx_mock)
    _stored_config(httpx_mock)
    result = runner.invoke(
        app, ["mock", "config", "diff", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_ERROR
    assert '+ scenarios["maintenance"]' in result.stdout
    assert "--- payments-api 1.0.0" in result.stdout


def test_diff_json_shape(httpx_mock: object, tmp_path: Path) -> None:
    path = _pulled(httpx_mock, tmp_path)
    document = json.loads(path.read_text(encoding="utf-8"))
    document["correlation"] = None
    path.write_text(serialize_document(document), encoding="utf-8")

    _scope(httpx_mock)
    _stored_config(httpx_mock)
    result = runner.invoke(
        app, ["--json", "mock", "config", "diff", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_ERROR
    payload = json.loads(result.stdout)
    assert payload["changed"] is True
    assert payload["changes"][0]["path"] == "correlation"


def test_diff_remaps_a_transport_failure_to_two_so_drift_stays_distinguishable(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    httpx_mock.add_response(url=_SCENARIOS_URL, method="GET", status_code=500, json={"message": "boom"})

    result = runner.invoke(
        app, ["mock", "config", "diff", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE


def test_diff_rejects_a_file_without_the_format_marker(tmp_path: Path) -> None:
    path = tmp_path / "mock-config.json"
    path.write_text(json.dumps({"scenarios": {}}), encoding="utf-8")

    result = runner.invoke(
        app, ["mock", "config", "diff", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert "configFormat" in result.stderr


# --------------------------------------------------------------------------- push


def test_push_of_an_unedited_pull_writes_and_reports_no_changes(
    httpx_mock: object, tmp_path: Path
) -> None:
    """The acceptance criterion: pull, then push, is a no-op."""
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)
    _writes_accepted(httpx_mock)

    result = runner.invoke(
        app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert "Applied" in result.stdout
    assert "(no changes)" in result.stdout


def test_push_validates_every_section_before_writing_any(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)
    _writes_accepted(httpx_mock)

    runner.invoke(app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)])

    methods_and_urls = [(r.method, str(r.url)) for r in httpx_mock.get_requests()]
    dry_runs = [i for i, (method, url) in enumerate(methods_and_urls) if method == "PUT" and "dryRun" in url]
    writes = [i for i, (method, url) in enumerate(methods_and_urls) if method == "PUT" and "dryRun" not in url]
    assert len(dry_runs) == 3 and len(writes) == 3
    assert max(dry_runs) < min(writes)


def test_push_dry_run_writes_nothing(httpx_mock: object, tmp_path: Path) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)

    result = runner.invoke(
        app,
        ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path), "--dry-run"],
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert "--dry-run" in result.stdout
    assert not [r for r in httpx_mock.get_requests() if r.method == "PUT" and "dryRun" not in str(r.url)]


def test_push_dry_run_reports_what_would_change(httpx_mock: object, tmp_path: Path) -> None:
    path = _pulled(httpx_mock, tmp_path)
    document = json.loads(path.read_text(encoding="utf-8"))
    document["scenarios"] = {}
    path.write_text(serialize_document(document), encoding="utf-8")

    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)

    result = runner.invoke(
        app,
        ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path), "--dry-run"],
    )
    assert result.exit_code == EXIT_SUCCESS
    assert '- scenarios["outage"]' in result.stdout


def test_a_rejected_document_reports_errors_against_its_own_paths_and_writes_nothing(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    httpx_mock.add_response(
        url=f"{_SCENARIOS_URL}?dryRun=true",
        method="PUT",
        status_code=422,
        json={
            "detail": {
                "message": "Scenario definitions failed validation.",
                "errors": [
                    "Scenario 'outage', operation 'GET /pets': status 503 is not defined for GET /pets."
                ],
            }
        },
    )
    httpx_mock.add_response(url=f"{_CORRELATION_URL}?dryRun=true", method="PUT", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=f"{_PACKS_URL}?dryRun=true", method="PUT", json=_STORED_PACKS)

    result = runner.invoke(
        app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert 'scenarios["outage"].operations["GET /pets"]' in result.stderr
    assert "status 503 is not defined for GET /pets." in result.stderr
    assert not [r for r in httpx_mock.get_requests() if r.method == "PUT" and "dryRun" not in str(r.url)]


def test_every_rejected_section_is_reported_at_once(httpx_mock: object, tmp_path: Path) -> None:
    """Validating all three routes first is what lets one run name every problem in the file."""
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    httpx_mock.add_response(
        url=f"{_SCENARIOS_URL}?dryRun=true",
        method="PUT",
        status_code=422,
        json={"detail": {"errors": ["Scenario 'outage': bad."]}},
    )
    httpx_mock.add_response(
        url=f"{_CORRELATION_URL}?dryRun=true",
        method="PUT",
        status_code=422,
        json={"detail": {"errors": ["Correlation: also bad."]}},
    )
    httpx_mock.add_response(url=f"{_PACKS_URL}?dryRun=true", method="PUT", json=_STORED_PACKS)

    result = runner.invoke(
        app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert "2 problems" in result.stderr
    assert 'scenarios["outage"]' in result.stderr
    assert "correlation" in result.stderr


def test_push_json_shape_reports_errors_and_the_diff(httpx_mock: object, tmp_path: Path) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    httpx_mock.add_response(
        url=f"{_SCENARIOS_URL}?dryRun=true",
        method="PUT",
        status_code=422,
        json={"detail": {"errors": ["Correlation: bad."]}},
    )
    httpx_mock.add_response(url=f"{_CORRELATION_URL}?dryRun=true", method="PUT", json=_STORED_CORRELATION)
    httpx_mock.add_response(url=f"{_PACKS_URL}?dryRun=true", method="PUT", json=_STORED_PACKS)

    result = runner.invoke(
        app, ["--json", "mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    payload = json.loads(result.stdout)
    assert payload["valid"] is False
    assert payload["applied"] is False
    assert payload["errors"][0]["path"] == "correlation"
    assert payload["diff"]["changed"] is False


def test_push_sends_the_document_sections_to_the_routes_that_own_them(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)
    _writes_accepted(httpx_mock)

    runner.invoke(app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)])

    bodies = {
        str(request.url).split("/mock/")[1].split("?")[0]: json.loads(request.content)
        for request in httpx_mock.get_requests()
        if request.method == "PUT"
    }
    assert bodies["scenarios"] == {
        "scenarios": _STORED_SCENARIOS["scenarios"],
        "chaos": _STORED_SCENARIOS["chaos"],
        # Always sent, even as null: a whole-document push clears what the file leaves out
        # (#5531, MSC-2.1).
        "activeScenario": _STORED_SCENARIOS.get("activeScenario"),
    }
    assert bodies["correlation"] == {"correlation": _STORED_CORRELATION["correlation"]}
    assert bodies["fixture-packs"] == {"packs": _STORED_PACKS["packs"]}


def test_a_write_that_fails_after_validation_names_what_was_already_applied(
    httpx_mock: object, tmp_path: Path
) -> None:
    """Validation passed, so a failing write is the ownership gate or the service — say how far it got."""
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    _dry_run_accepted(httpx_mock)
    httpx_mock.add_response(url=_SCENARIOS_URL, method="PUT", json=_STORED_SCENARIOS)
    httpx_mock.add_response(
        url=_CORRELATION_URL,
        method="PUT",
        status_code=403,
        json={"message": "Only the version creator can change mock settings"},
    )

    result = runner.invoke(
        app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert "Already applied before the failure: scenarios, activeScenario, chaos" in result.stderr


def test_push_forwards_a_non_validation_failure_to_the_shared_error_mapping(
    httpx_mock: object, tmp_path: Path
) -> None:
    path = _pulled(httpx_mock, tmp_path)
    _scope(httpx_mock)
    _stored_config(httpx_mock)
    httpx_mock.add_response(
        url=f"{_SCENARIOS_URL}?dryRun=true",
        method="PUT",
        status_code=403,
        json={"message": "Only the version creator can change mock settings"},
    )

    result = runner.invoke(
        app, ["mock", "config", "push", "payments-api", "1.0.0", "--file", str(path)]
    )
    assert result.exit_code == EXIT_USAGE
    assert "creator" in result.stderr
