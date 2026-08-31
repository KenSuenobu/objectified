"""``apiome-mock preview`` tests — the offline half of ``apiome mock preview`` (#5530, MSC-1.4).

The CLI's ``--bundle`` path shells out to this command, so its exit codes, its JSON shape and its
refusal to take the request on a command line are the contract under test here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from app.mock_bundle import BundleIdentity, build_bundle, bundle_bytes

from apiome_mock.cli import main
from apiome_mock.cli_run import EXIT_BUNDLE_INVALID, EXIT_CONFIG_ERROR, EXIT_OK

_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "parameters": [
                    {
                        "name": "petId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "string"},
                                        "name": {"type": "string"},
                                    },
                                },
                                "example": {"id": "1", "name": "Rex"},
                            }
                        },
                    }
                },
            }
        }
    },
}

_CORRELATED_SETTINGS = {"responseCorrelation": {"mode": "path-params"}}


def _write_bundle(tmp_path: Path, *, mock_settings: dict[str, Any] | None = None) -> Path:
    """Write a bundle to disk exactly as the exporter would."""
    document = build_bundle(
        identity=BundleIdentity(
            tenant="acme",
            project="petstore",
            version="1.0.0",
            revision_id="11111111-2222-3333-4444-555555555555",
        ),
        spec=_SPEC,
        mock_settings=mock_settings,
    )
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


def _request(monkeypatch: pytest.MonkeyPatch, document: dict[str, Any]) -> None:
    """Feed a request document to the command's standard input."""
    monkeypatch.setattr("sys.stdin", _Stdin(json.dumps(document)))


class _Stdin:
    """A minimal stdin stand-in; the command only ever calls ``read()``."""

    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> str:
        return self._text


def test_preview_renders_the_request_and_prints_the_trace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    _request(monkeypatch, {"method": "GET", "path": "/pets/42"})

    assert main(["preview", "--bundle", str(bundle)]) == EXIT_OK
    printed = capsys.readouterr().out
    assert "200 application/json" in printed
    assert "GET /pets/{petId}" in printed
    assert "layer" in printed


def test_preview_json_is_the_shape_the_hosted_endpoint_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    _request(monkeypatch, {"method": "GET", "path": "/pets/42"})

    assert main(["preview", "--bundle", str(bundle), "--json"]) == EXIT_OK
    payload = json.loads(capsys.readouterr().out)
    assert set(payload) == {
        "operation",
        "pathParams",
        "status",
        "headers",
        "mediaType",
        "body",
        "bodyEncoding",
        "trace",
        "chaos",
    }
    assert payload["operation"] == "GET /pets/{petId}"
    assert payload["pathParams"] == {"petId": "42"}
    assert payload["trace"]["layer"]


def test_correlation_in_the_bundle_reaches_the_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A bundle is the whole configuration: what it carries is what the preview renders."""
    bundle = _write_bundle(tmp_path, mock_settings=_CORRELATED_SETTINGS)
    _request(monkeypatch, {"method": "GET", "path": "/pets/42"})

    assert main(["preview", "--bundle", str(bundle), "--json"]) == EXIT_OK
    payload = json.loads(capsys.readouterr().out)
    assert payload["body"]["id"] == "42"
    assert payload["trace"]["correlationMode"] == "path-params"


def test_the_request_can_come_from_a_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle = _write_bundle(tmp_path)
    request_file = tmp_path / "request.json"
    request_file.write_text(json.dumps({"path": "/pets/7"}), encoding="utf-8")

    assert main(["preview", "--bundle", str(bundle), "--request-file", str(request_file), "--json"]) == EXIT_OK
    assert json.loads(capsys.readouterr().out)["pathParams"] == {"petId": "7"}


def test_an_empty_request_document_previews_the_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    monkeypatch.setattr("sys.stdin", _Stdin(""))

    assert main(["preview", "--bundle", str(bundle), "--json"]) == EXIT_OK
    assert json.loads(capsys.readouterr().out)["operation"] is None


def test_a_request_document_that_is_not_json_is_a_configuration_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    monkeypatch.setattr("sys.stdin", _Stdin("{"))

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle)])
    assert exc.value.code == EXIT_CONFIG_ERROR
    assert "not valid JSON" in capsys.readouterr().err


def test_an_unknown_request_field_is_refused_exactly_as_the_hosted_hop_refuses_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    _request(monkeypatch, {"path": "/pets/42", "cookies": {"a": "b"}})

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle)])
    assert exc.value.code == EXIT_CONFIG_ERROR
    assert "not a valid preview request" in capsys.readouterr().err


def test_a_request_over_the_header_limit_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    _request(monkeypatch, {"path": "/pets/42", "headers": {f"X-{i}": "v" for i in range(65)}})

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle)])
    assert exc.value.code == EXIT_CONFIG_ERROR
    assert "exceeds a preview limit" in capsys.readouterr().err


def test_a_missing_request_file_is_a_configuration_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle = _write_bundle(tmp_path)

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle), "--request-file", str(tmp_path / "absent.json")])
    assert exc.value.code == EXIT_CONFIG_ERROR
    assert "Cannot read the request document" in capsys.readouterr().err


def test_no_bundle_configured_is_a_configuration_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("APIOME_MOCK_BUNDLE", raising=False)
    _request(monkeypatch, {})

    with pytest.raises(SystemExit) as exc:
        main(["preview"])
    assert exc.value.code == EXIT_CONFIG_ERROR
    assert "No bundle configured" in capsys.readouterr().err


def test_a_tampered_bundle_is_refused_before_anything_is_rendered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path)
    document = json.loads(bundle.read_text(encoding="utf-8"))
    document["spec"]["info"]["title"] = "Tampered"
    bundle.write_text(json.dumps(document), encoding="utf-8")
    _request(monkeypatch, {"path": "/pets/42"})

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle)])
    assert exc.value.code == EXIT_BUNDLE_INVALID
    assert capsys.readouterr().err.strip()


def test_an_unsigned_bundle_is_refused_when_a_signature_is_required(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = _write_bundle(tmp_path)
    _request(monkeypatch, {"path": "/pets/42"})

    with pytest.raises(SystemExit) as exc:
        main(["preview", "--bundle", str(bundle), "--require-signature"])
    assert exc.value.code == EXIT_BUNDLE_INVALID
