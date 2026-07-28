"""Tests for the ``contract suite`` command — ECA-1.1 (#4729).

The CLI compiles nothing; what is asserted here is the value it adds around the call: the
reference it builds, the options it forwards, the canonical bytes it writes, and the local
digest re-derivation that turns "the server says this is suite X" into something the CLI has
checked for itself.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

pytestmark = pytest.mark.usefixtures("api_key_env")

runner = CliRunner()

_SUITE_URL = (
    "http://localhost:8000/v1/tenants/acme-corp/contracts/project/petstore/1.0.0/suite"
)


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIOME_API_KEY", "test-key")
    monkeypatch.setenv("APIOME_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("APIOME_TENANT_ID", "acme-corp")


def _canonical(manifest: dict[str, Any]) -> str:
    """Serialize a manifest the way both the server and the CLI do."""
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def _manifest(**overrides: Any) -> dict[str, Any]:
    """A manifest whose ``digest`` is the true hash of its own canonical bytes."""
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "compiler_version": 1,
        "digest": "",
        "digest_algorithm": "sha256",
        "options": {"seed": 0},
        "api": {"name": "Petstore", "title": "Petstore", "format": "openapi-3.1"},
        "source": {"reference": "project/petstore/1.0.0", "published": True},
        "operations": [{"key": "GET /pets", "case_count": 2}],
        "cases": [{"case_id": "case_1", "operation_key": "GET /pets"}],
        "schemas": {},
        "findings": [
            {
                "code": "AUTHENTICATION_REQUIRED",
                "level": "info",
                "message": "supply credentials",
                "operation_key": None,
            }
        ],
        "counts": {
            "cases": 3,
            "declared_example": 1,
            "negative_cases": 2,
            "operations_compiled": 1,
            "operations_skipped": 0,
        },
    }
    manifest.update(overrides)
    manifest["digest"] = "sha256:" + hashlib.sha256(
        _canonical({**manifest, "digest": ""}).encode("utf-8")
    ).hexdigest()
    return manifest


def _payload(**overrides: Any) -> dict[str, Any]:
    return {"ok": True, "version_ref": "project/petstore/1.0.0", "manifest": _manifest(**overrides)}


def test_it_summarizes_a_compiled_suite(httpx_mock: Any) -> None:
    """The default output is the summary a human reads in a CI log."""
    httpx_mock.add_response(url=_SUITE_URL, method="POST", json=_payload())

    result = runner.invoke(
        app, ["contract", "suite", "--project", "petstore", "--version", "1.0.0"]
    )

    assert result.exit_code == EXIT_SUCCESS
    assert "Contract suite for project/petstore/1.0.0" in result.stdout
    assert "published" in result.stdout
    assert "1 compiled" in result.stdout
    assert "cases: 3 (1 declared, 2 negative)" in result.stdout
    assert "AUTHENTICATION_REQUIRED" in result.stdout


def test_it_builds_the_reference_and_forwards_the_options(httpx_mock: Any) -> None:
    """The options are the suite's identity, so the CLI must send exactly what was asked for."""
    httpx_mock.add_response(url=_SUITE_URL, method="POST", json=_payload())

    result = runner.invoke(
        app,
        [
            "contract",
            "suite",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--seed",
            "9",
            "--no-negative",
            "--operation",
            "GET /pets",
            "--operation",
            "POST /pets",
            "--max-operations",
            "5",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    sent = json.loads(httpx_mock.get_requests()[0].content)
    assert sent["options"] == {
        "seed": 9,
        "include_declared_examples": True,
        "include_generated": True,
        "include_negative": False,
        "operations": ["GET /pets", "POST /pets"],
        "max_operations": 5,
    }


def test_the_catalog_kind_changes_the_reference(httpx_mock: Any) -> None:
    """A Catalog revision is addressed on its own surface, never through `project/`."""
    url = "http://localhost:8000/v1/tenants/acme-corp/contracts/catalog/legacy/latest/suite"
    httpx_mock.add_response(url=url, method="POST", json=_payload())

    result = runner.invoke(
        app,
        [
            "contract",
            "suite",
            "--project",
            "legacy",
            "--version",
            "latest",
            "--kind",
            "catalog",
        ],
    )

    assert result.exit_code == EXIT_SUCCESS


def test_an_unknown_kind_is_a_usage_error() -> None:
    """Only the two addressable surfaces exist; anything else is a typo, caught locally."""
    result = runner.invoke(
        app,
        ["contract", "suite", "--project", "p", "--version", "1", "--kind", "registry"],
    )

    assert result.exit_code == EXIT_USAGE
    assert "project, catalog" in result.stderr


def test_out_writes_the_bytes_the_digest_covers(httpx_mock: Any, tmp_path: Path) -> None:
    """A committed suite file must hash to the digest the server reported."""
    payload = _payload()
    httpx_mock.add_response(url=_SUITE_URL, method="POST", json=payload)
    target = tmp_path / "suite.json"

    result = runner.invoke(
        app,
        [
            "contract",
            "suite",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--out",
            str(target),
        ],
    )

    assert result.exit_code == EXIT_SUCCESS
    written = target.read_text(encoding="utf-8")
    assert written == _canonical(payload["manifest"])
    assert written.endswith("\n")
    blanked = dict(payload["manifest"])
    blanked["digest"] = ""
    recomputed = hashlib.sha256(_canonical(blanked).encode("utf-8")).hexdigest()
    assert payload["manifest"]["digest"] == f"sha256:{recomputed}"
    assert f"wrote {target}" in result.stdout


def test_a_digest_that_does_not_match_the_manifest_fails_before_writing_anything(
    httpx_mock: Any, tmp_path: Path
) -> None:
    """Either the manifest was altered in transit or the two sides disagree — both are faults,
    and a file that does not hash to its own digest is worse than no file."""
    payload = _payload()
    payload["manifest"]["digest"] = "sha256:" + "0" * 64
    httpx_mock.add_response(url=_SUITE_URL, method="POST", json=payload)
    target = tmp_path / "suite.json"

    result = runner.invoke(
        app,
        [
            "contract",
            "suite",
            "--project",
            "petstore",
            "--version",
            "1.0.0",
            "--out",
            str(target),
        ],
    )

    assert result.exit_code == EXIT_ERROR
    assert "Digest mismatch" in result.stderr
    assert not target.exists()


def test_json_mode_emits_the_whole_response(httpx_mock: Any) -> None:
    """A pipeline consumes the manifest, not the summary."""
    httpx_mock.add_response(url=_SUITE_URL, method="POST", json=_payload())

    result = runner.invoke(
        app, ["--json", "contract", "suite", "--project", "petstore", "--version", "1.0.0"]
    )

    assert result.exit_code == EXIT_SUCCESS
    emitted = json.loads(result.stdout)
    assert emitted["ok"] is True
    assert emitted["manifest"]["digest"].startswith("sha256:")


def test_a_version_with_no_suite_exits_non_zero(httpx_mock: Any) -> None:
    """`ok: false` is a 200, but it is not a success for the caller."""
    httpx_mock.add_response(
        url=_SUITE_URL,
        method="POST",
        json={
            "ok": False,
            "version_ref": "project/petstore/1.0.0",
            "manifest": None,
            "error": {
                "code": "FORMAT_MISMATCH",
                "message": "This version declares no operations.",
                "remediation": "Validate payloads against its types instead.",
            },
        },
    )

    result = runner.invoke(
        app, ["contract", "suite", "--project", "petstore", "--version", "1.0.0"]
    )

    assert result.exit_code == EXIT_ERROR
    assert "FORMAT_MISMATCH" in result.stdout
    assert "Validate payloads against its types instead." in result.stdout


def test_an_unpublished_version_is_labelled_as_such(httpx_mock: Any) -> None:
    """A suite compiled from an unpublished revision is valid, but it is not an agreed contract."""
    httpx_mock.add_response(
        url=_SUITE_URL,
        method="POST",
        json=_payload(source={"reference": "project/petstore/1.0.0", "published": False}),
    )

    result = runner.invoke(
        app, ["contract", "suite", "--project", "petstore", "--version", "1.0.0"]
    )

    assert result.exit_code == EXIT_SUCCESS
    assert "unpublished" in result.stdout
