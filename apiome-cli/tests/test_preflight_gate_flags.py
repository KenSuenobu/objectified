"""``--min-grade`` / ``--fail-on`` gating on the import and export commands (IXH-2.6, #5101).

AC-3: the gate short-circuits **before** the job is created. Every blocking case here asserts
that no job/emit request ever reached the mocked API, not merely that the exit code was
non-zero — a command that created the job and then failed would satisfy the exit code and
still leave the artifact behind.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import (
    EXIT_POLICY_BLOCKED,
    EXIT_QUALITY_GATE,
    EXIT_SUCCESS,
)
from apiome_cli.main import app

runner = CliRunner()

_BASE = "http://localhost:8000"
_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_VERSION_RECORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
_JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

_IMPORT_PREFLIGHT_URL = f"{_BASE}/v1/tenants/acme-corp/import/preflight"
_EXPORT_PREFLIGHT_URL = f"{_BASE}/v1/tenants/acme-corp/export/preflight"
_UPLOAD_URL = f"{_BASE}/v1/tenants/acme-corp/imports/upload"
_IMPORT_URL = f"{_BASE}/v1/tenants/acme-corp/imports"
_JOB_URL = f"{_BASE}/v1/tenants/acme-corp/imports/{_JOB_ID}"
_PROJECT_URL = f"{_BASE}/v1/projects/acme-corp/by-slug/payments-api"
_SOURCES_URL = f"{_BASE}/v1/import/sources"

_SPEC = {"openapi": "3.1.0", "info": {"title": "Payments API", "version": "1.0.0"}, "paths": {}}

_IMPORT_RESULT = {
    "project_id": _PROJECT_ID,
    "version_id": "1.0.0",
    "version_record_id": _VERSION_RECORD_ID,
    "project": {"id": _PROJECT_ID, "name": "Payments API", "slug": "payments-api"},
    "version": {"id": _VERSION_RECORD_ID, "version": "1.0.0", "slug": "1.0.0"},
    "created": {"schemas": 0, "properties": 0, "project_properties": 0, "version_schemas": 0},
    "warnings": [],
    "errors": [],
}

_PROJECT = {"id": _PROJECT_ID, "name": "Payments API", "slug": "payments-api", "enabled": True}


@pytest.fixture(autouse=True)
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", _BASE)
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


@pytest.fixture
def spec_file(tmp_path: Path) -> Path:
    path = tmp_path / "payments.json"
    path.write_text(json.dumps(_SPEC), encoding="utf-8")
    return path


def _import_report(*, grade: str = "B", score: int = 88, blocking: bool = False) -> dict:
    return {
        "ok": True,
        "detection": {
            "adapter_key": "openapi",
            "detected_adapter_key": "openapi",
            "detected_format": "openapi-3.1",
            "confidence": 0.99,
            "matched": True,
            "importable": True,
            "ambiguous": False,
            "agrees_with_request": True,
            "archive_members": [],
        },
        "routing": {"target": "project", "reason": "Document declares paths."},
        "paradigm": "rest",
        "format": "openapi-3.1",
        "counts": {"services": 1, "operations": 0, "types": 0, "channels": 0},
        "fingerprint": "sha256:abc",
        "lint": {
            "score": score,
            "grade": grade,
            "report_fingerprint": "lintfp",
            "severity_counts": {"error": 1} if blocking else {"warning": 1},
            "rule_hits": {},
            "categories": [],
            "findings": [],
        },
        "style_guide": {"guide_id": None, "name": "Defaults", "source": "fallback", "fingerprint": "g"},
        "policy": {
            "verdict": "block" if blocking else "pass",
            "blocking": blocking,
            "source": "tenant" if blocking else "default",
            "reason": "Score floor missed." if blocking else "No policy configured.",
            "allow_override": True,
            "scope": "import",
            "enforcement": "block" if blocking else "advisory",
            "failures": [{"kind": "score", "required": 90, "actual": score}] if blocking else [],
            "override_roles": [],
            "waiver_id": None,
            "waiver_expires_at": None,
        },
        "error": None,
        "cache": {"hit": False, "key": "k", "content_hash": "abc"},
    }


def _export_report(*, grade: str = "B", score: int = 88, band: str = "ready") -> dict:
    return {
        "artifact": _PROJECT_ID,
        "version": "1.0.0",
        "version_record_id": _VERSION_RECORD_ID,
        "version_label": "1.0.0",
        "paradigm": "rest",
        "format": "openapi-3.1",
        "lint": {
            "score": score,
            "grade": grade,
            "report_fingerprint": "lintfp",
            "severity_counts": {"warning": 1},
            "rule_hits": {},
            "categories": [],
            "findings": [],
        },
        "style_guide": {"guide_id": None, "name": "Defaults", "source": "fallback", "fingerprint": "g"},
        "capability_demand": ["operations"],
        "targets": [
            {
                "rank": 1,
                "key": "openapi",
                "format": "openapi-3.1",
                "descriptor": {},
                "capability_profile": {},
                "readiness": 90,
                "band": band,
                "blocked": band == "blocked",
                "selectable": band == "ready",
                "rationale": "ok",
                "fidelity": {"summary": {"tier": "lossless", "preserved_percent": 100.0}},
                "capability": {"verdict": "full", "required": [], "supported": [], "missing": []},
                "policy": {
                    "verdict": "block" if band == "blocked" else "pass",
                    "blocking": band == "blocked",
                    "source": "tenant",
                    "reason": "Source grade below floor." if band == "blocked" else "ok",
                    "allow_override": True,
                    "scope": "export",
                    "enforcement": "block",
                    "failures": [],
                    "override_roles": [],
                    "waiver_id": None,
                    "waiver_expires_at": None,
                },
            }
        ],
        "ranking_fingerprint": "rankfp",
    }


def _urls(httpx_mock: object) -> list[str]:
    return [str(request.url) for request in httpx_mock.get_requests()]  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# import openapi
# ---------------------------------------------------------------------------


def test_import_without_gate_flags_never_preflights(httpx_mock: object, spec_file: Path) -> None:
    """An ungated import behaves exactly as it did before IXH-2.6 — no extra round trip."""
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_UPLOAD_URL, method="POST", status_code=202, json={"job_id": _JOB_ID, "state": "pending"}
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_JOB_URL, method="GET", json={"state": "completed", "job_id": _JOB_ID, "result": _IMPORT_RESULT}
    )
    result = runner.invoke(app, ["import", "openapi", str(spec_file)])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert _IMPORT_PREFLIGHT_URL not in _urls(httpx_mock)


def test_import_min_grade_blocks_before_the_job_is_created(
    httpx_mock: object, spec_file: Path
) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="D", score=61)
    )
    result = runner.invoke(app, ["import", "openapi", str(spec_file), "--min-grade", "B"])
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "Import pre-flight gate failed; no import job was created." in result.stderr
    assert _urls(httpx_mock) == [_IMPORT_PREFLIGHT_URL]


def test_import_policy_block_stops_before_the_job(httpx_mock: object, spec_file: Path) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(blocking=True, score=54)
    )
    result = runner.invoke(app, ["import", "openapi", str(spec_file), "--fail-on", "error"])
    assert result.exit_code == EXIT_POLICY_BLOCKED
    assert _urls(httpx_mock) == [_IMPORT_PREFLIGHT_URL]


def test_import_passing_gate_proceeds_to_the_job(httpx_mock: object, spec_file: Path) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="A", score=95)
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_UPLOAD_URL, method="POST", status_code=202, json={"job_id": _JOB_ID, "state": "pending"}
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_JOB_URL, method="GET", json={"state": "completed", "job_id": _JOB_ID, "result": _IMPORT_RESULT}
    )
    result = runner.invoke(app, ["import", "openapi", str(spec_file), "--min-grade", "B"])
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert _UPLOAD_URL in _urls(httpx_mock)
    # The passing verdict is a diagnostic — it must not contaminate stdout.
    assert "Pre-flight: OK" in result.stderr
    assert "Pre-flight: OK" not in result.stdout


def test_import_gate_passing_summary_respects_no_progress(
    httpx_mock: object, spec_file: Path
) -> None:
    """``--no-progress`` silences the passing verdict; the gate itself still runs."""
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="A", score=95)
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_UPLOAD_URL, method="POST", status_code=202, json={"job_id": _JOB_ID, "state": "pending"}
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_JOB_URL, method="GET", json={"state": "completed", "job_id": _JOB_ID, "result": _IMPORT_RESULT}
    )
    result = runner.invoke(
        app, ["--no-progress", "import", "openapi", str(spec_file), "--min-grade", "B"]
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert _IMPORT_PREFLIGHT_URL in _urls(httpx_mock)
    assert "Pre-flight: OK" not in result.stderr


def test_import_gate_failure_is_reported_even_under_no_progress(
    httpx_mock: object, spec_file: Path
) -> None:
    """A *failing* verdict is never silenced — CI must always be told why it stopped."""
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="D", score=61)
    )
    result = runner.invoke(
        app, ["--no-progress", "import", "openapi", str(spec_file), "--min-grade", "B"]
    )
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "Pre-flight: OK" in result.stderr
    assert "--min-grade B: grade is D." in result.stderr


def test_import_gate_grades_the_bytes_that_would_be_imported(
    httpx_mock: object, spec_file: Path
) -> None:
    """The pre-flight sees the document *after* --project-name/--version overrides.

    ``source_kind`` is the adapter *registry* key, not the spec-import job's legacy
    ``openapi-3`` discriminator, which the pre-flight registry would not recognize.
    """
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="D")
    )
    runner.invoke(
        app,
        ["import", "openapi", str(spec_file), "--min-grade", "A", "--project-name", "Renamed"],
    )
    body = json.loads(httpx_mock.get_requests()[-1].content)  # type: ignore[attr-defined]
    document = json.loads(base64.b64decode(body["document_base64"]))
    assert document["info"]["title"] == "Renamed"
    assert body["source_kind"] == "openapi"


def test_import_rejects_an_off_ladder_gate_flag(spec_file: Path) -> None:
    result = runner.invoke(app, ["import", "openapi", str(spec_file), "--min-grade", "E"])
    assert result.exit_code == 2


# ---------------------------------------------------------------------------
# import <format> (registry dispatch)
# ---------------------------------------------------------------------------


def test_generic_import_gate_blocks_before_the_job(httpx_mock: object, spec_file: Path) -> None:
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_SOURCES_URL,
        method="GET",
        json={"sources": [{"key": "sample", "label": "Sample", "formats": []}]},
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_IMPORT_PREFLIGHT_URL, method="POST", json=_import_report(grade="D", score=55)
    )
    result = runner.invoke(app, ["import", "sample", str(spec_file), "--min-grade", "B"])
    assert result.exit_code == EXIT_QUALITY_GATE
    assert _IMPORT_URL not in _urls(httpx_mock)


# ---------------------------------------------------------------------------
# export openapi
# ---------------------------------------------------------------------------


def test_export_min_grade_blocks_before_any_bytes_are_fetched(
    httpx_mock: object, tmp_path: Path
) -> None:
    httpx_mock.add_response(url=_PROJECT_URL, json=_PROJECT)  # type: ignore[attr-defined]
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_EXPORT_PREFLIGHT_URL, method="POST", json=_export_report(grade="D", score=58)
    )
    out = tmp_path / "openapi.json"
    result = runner.invoke(
        app,
        [
            "export", "openapi",
            "--project", "payments-api",
            "--version", "1.0.0",
            "--output", str(out),
            "--min-grade", "B",
        ],
    )
    assert result.exit_code == EXIT_QUALITY_GATE
    assert "Export pre-flight gate failed; nothing was emitted." in result.stderr
    assert _urls(httpx_mock) == [_PROJECT_URL, _EXPORT_PREFLIGHT_URL]
    assert not out.exists()


def test_export_gate_narrows_the_ranking_to_the_target_being_exported(
    httpx_mock: object, tmp_path: Path
) -> None:
    httpx_mock.add_response(url=_PROJECT_URL, json=_PROJECT)  # type: ignore[attr-defined]
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=_EXPORT_PREFLIGHT_URL, method="POST", json=_export_report(band="blocked")
    )
    result = runner.invoke(
        app,
        [
            "export", "asyncapi",
            "--project", "payments-api",
            "--version", "1.0.0",
            "--output", str(tmp_path / "async.json"),
            "--fail-on", "error",
        ],
    )
    assert result.exit_code == EXIT_POLICY_BLOCKED
    body = json.loads(httpx_mock.get_requests()[-1].content)  # type: ignore[attr-defined]
    assert body["targets"] == ["asyncapi"]
    assert body["include_findings"] is False


def test_export_without_gate_flags_never_preflights(httpx_mock: object, tmp_path: Path) -> None:
    httpx_mock.add_response(url=_PROJECT_URL, json=_PROJECT)  # type: ignore[attr-defined]
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=f"{_BASE}/v1/export/acme-corp/document",
        method="POST",
        json={"asyncapi": "3.0.0"},
        headers={"content-type": "application/json"},
    )
    httpx_mock.add_response(  # type: ignore[attr-defined]
        url=f"{_BASE}/v1/export/acme-corp/preview",
        method="POST",
        json={"fidelity": {"summary": {"tier": "lossless", "preserved_percent": 100.0}}},
    )
    result = runner.invoke(
        app,
        [
            "export", "asyncapi",
            "--project", "payments-api",
            "--version", "1.0.0",
            "--output", str(tmp_path / "async.json"),
        ],
    )
    assert result.exit_code == EXIT_SUCCESS, result.stdout
    assert _EXPORT_PREFLIGHT_URL not in _urls(httpx_mock)
