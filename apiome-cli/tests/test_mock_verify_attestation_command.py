"""Tests for ``apiome mock verify-attestation`` (PMR-3.2, #4749).

The command is what makes release-proof mock evidence consumable by *self-hosted* tooling: no
server, no network, just the shared HMAC secret and the standard library. What is pinned here is
the contract a CI script branches on:

* a valid signature over a verified mock exits 0 and prints the four identities the attestation
  carries;
* a signed statement saying the mock **failed** or was **never verified** is a valid attestation
  and an unacceptable release proof, so it exits non-zero — the distinction lives in the exit code,
  not in prose a script would have to grep;
* a wrong secret or a tampered payload fails, and an unreadable file is a usage error;
* the wrapper the REST route returns is accepted alongside a bare envelope, so a saved response can
  be verified without being unwrapped first.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any, Dict

from typer.testing import CliRunner

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE
from apiome_cli.main import app

# No API key fixture: verification is offline by design — that is the point of the command.
runner = CliRunner()

_BUNDLE_DIGEST = "sha256:" + "e" * 64
_CORPUS_DIGEST = "sha256:" + "f" * 64
_PACK_DIGEST = "sha256:" + "1" * 64
_PAYLOAD_TYPE = "application/vnd.in-toto+json"


def _statement(**overrides: Any) -> Dict[str, Any]:
    """A mock attestation statement over a verified mock."""
    predicate: Dict[str, Any] = {
        "status": "verified",
        "reasonCode": None,
        "reason": None,
        "bundle": {"digest": _BUNDLE_DIGEST},
        "runtime": {"name": "apiome-mock", "version": "0.9.0"},
        "conformance": {
            "corpus_digest": _CORPUS_DIGEST,
            "total": 30,
            "passed": 30,
            "failed": 0,
        },
        "fixturePacks": [{"name": "seeded-pets", "digest": _PACK_DIGEST}],
    }
    predicate.update(overrides)
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": "acme/petstore/1.0.0", "digest": {"sha256": "e" * 64}}],
        "predicateType": "https://apiome.dev/attestations/mock-runtime/v1",
        "predicate": predicate,
    }


def _signed_envelope(secret: str, **overrides: Any) -> Dict[str, Any]:
    """Sign a statement the way the server does: HMAC-SHA256 over DSSE PAEv1."""
    payload = json.dumps(_statement(**overrides), sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    type_bytes = _PAYLOAD_TYPE.encode("utf-8")
    pae = b" ".join(
        [
            b"DSSEv1",
            str(len(type_bytes)).encode("ascii"),
            type_bytes,
            str(len(payload)).encode("ascii"),
            payload,
        ]
    )
    return {
        "payloadType": _PAYLOAD_TYPE,
        "payload": base64.b64encode(payload).decode("ascii"),
        "signatures": [
            {
                "keyid": "apiome-lint-hmac-v1",
                "alg": "hmac-sha256",
                "sig": hmac.new(secret.encode("utf-8"), pae, hashlib.sha256).hexdigest(),
            }
        ],
    }


def _write(tmp_path: Path, document: Any) -> Path:
    """Write an attestation document to disk."""
    path = tmp_path / "mock.att"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_a_verified_attestation_prints_every_identity_it_carries(tmp_path: Path) -> None:
    path = _write(tmp_path, _signed_envelope("shared"))

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "shared"]
    )

    assert result.exit_code == EXIT_SUCCESS
    assert "Mock attestation verified." in result.stdout
    assert "Status: verified" in result.stdout
    assert _BUNDLE_DIGEST in result.stdout
    assert "apiome-mock 0.9.0" in result.stdout
    assert "30/30 passed" in result.stdout
    assert _PACK_DIGEST in result.stdout


def test_the_route_wrapper_is_accepted_without_unwrapping(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        {
            "predicateType": "https://apiome.dev/attestations/mock-runtime/v1",
            "signed": True,
            "keyId": "apiome-lint-hmac-v1",
            "envelope": _signed_envelope("shared"),
        },
    )

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "shared"]
    )

    assert result.exit_code == EXIT_SUCCESS


def test_a_signed_but_unverified_mock_fails_the_job(tmp_path: Path) -> None:
    """The signature is genuine; what it attests is that nothing was proved."""
    path = _write(
        tmp_path,
        _signed_envelope(
            "shared",
            status="missing",
            reasonCode="mock-attestation-missing",
            reason="nothing was attached",
            bundle=None,
            runtime=None,
            conformance=None,
            fixturePacks=[],
        ),
    )

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "shared"]
    )

    assert result.exit_code == EXIT_ERROR
    assert "Mock attestation verified." in result.stdout
    assert "Status: missing" in result.stdout
    assert "mock-attestation-missing" in result.stdout


def test_a_signed_failed_mock_fails_the_job(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        _signed_envelope(
            "shared",
            status="failed",
            reasonCode="mock-conformance-failed",
            reason="2 of 30 conformance cases failed: chaos-latency, scenario-404",
        ),
    )

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "shared"]
    )

    assert result.exit_code == EXIT_ERROR
    assert "Status: failed" in result.stdout


def test_the_wrong_secret_does_not_verify(tmp_path: Path) -> None:
    path = _write(tmp_path, _signed_envelope("shared"))

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "other"]
    )

    assert result.exit_code == EXIT_ERROR
    assert "FAILED" in result.stderr


def test_a_tampered_payload_does_not_verify(tmp_path: Path) -> None:
    envelope = _signed_envelope("shared")
    tampered = json.loads(base64.b64decode(envelope["payload"]))
    tampered["predicate"]["bundle"]["digest"] = "sha256:" + "0" * 64
    envelope["payload"] = base64.b64encode(
        json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    path = _write(tmp_path, envelope)

    result = runner.invoke(
        app, ["mock", "verify-attestation", "--file", str(path), "--secret", "shared"]
    )

    assert result.exit_code == EXIT_ERROR


def test_an_unreadable_file_is_a_usage_error(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "mock",
            "verify-attestation",
            "--file",
            str(tmp_path / "nope.json"),
            "--secret",
            "shared",
        ],
    )

    assert result.exit_code == EXIT_USAGE
