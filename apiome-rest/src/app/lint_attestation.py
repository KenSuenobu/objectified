"""Attestable gate evidence summaries (CLX-4.2, #4860; extended by IXH-2.5, #5100).

Wraps a gate payload in an **in-toto Statement v1** signed as a **DSSE envelope** so a release
pipeline can prove, offline, exactly which input, scanners, policy pack, and reports produced a
gate verdict. Two statement flavours share this one format, one signer, and one verifier:

* :func:`build_attestation_statement` — the **lint gate** statement (CLX-4.2);
* :func:`build_delivery_attestation_statement` — the **export delivery gate** statement
  (IXH-2.5), whose subject is the delivered artifact itself.

They differ only in ``predicateType`` and predicate shape, which is exactly what in-toto
predicate types are for; everything below the statement — canonical JSON, PAEv1, HMAC-SHA256,
the envelope, and :func:`verify_attestation_envelope` — is shared, so a verifier that can check
one can check the other without new code.

For the lint gate statement:

* Statement subjects are the contributing scanners, identified by their immutable
  ``report_fingerprint`` (the custom digest algorithm name ``apiome-report-fingerprint`` —
  report fingerprints are opaque content ids, not raw sha256 hex of a file).
* The predicate carries the subject / policy / evaluation identity: subject type + id,
  baseline, policy version id + content fingerprint, per-scanner input/source/config/report
  fingerprints, and the gate verdict. Fingerprints only — never source text or credentials.
* The envelope signature is HMAC-SHA256 over the DSSE PAEv1 encoding of the payload, keyed by
  the shared ``lint_attestation_signing_secret``. HMAC keeps verification symmetric and
  dependency-free; any holder of the secret can verify with ~10 lines of stdlib code (the
  apiome-cli ``lint verify-attestation`` command is exactly that — keep the two in lockstep).
  When no secret is configured the envelope is emitted with an empty ``signatures`` list:
  still a well-formed attestation document, just not verifiable.

Canonical JSON here matches the webhook delivery signer: ``sort_keys`` + compact separators,
so identical statements always produce identical bytes and signatures.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional

__all__ = [
    "DELIVERY_PREDICATE_TYPE",
    "PAYLOAD_TYPE",
    "PREDICATE_TYPE",
    "STATEMENT_TYPE",
    "attestation_envelope",
    "build_attestation_statement",
    "build_delivery_attestation_statement",
    "verify_attestation_envelope",
]

STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
PREDICATE_TYPE = "https://apiome.dev/attestations/lint-gate/v1"
#: Predicate type for an export delivery attestation (IXH-2.5) — the same envelope and signature
#: as a lint gate attestation, a different predicate body.
DELIVERY_PREDICATE_TYPE = "https://apiome.dev/attestations/export-delivery/v1"
PAYLOAD_TYPE = "application/vnd.in-toto+json"

#: Digest algorithm label for subjects — report fingerprints are opaque Apiome content ids.
DIGEST_ALGORITHM = "apiome-report-fingerprint"

#: Digest algorithm for a delivery subject: a real SHA-256 over the artifact bytes, so a holder
#: of the downloaded file can recompute it without any Apiome-specific knowledge.
CONTENT_DIGEST_ALGORITHM = "sha256"


def _canonical_json(value: Any) -> str:
    """Deterministic JSON: sorted keys, compact separators (same as webhook signing)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def build_attestation_statement(
    gate_payload: Mapping[str, Any],
    *,
    generated_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Build the in-toto Statement for one lint gate payload.

    Args:
        gate_payload: Output of :func:`app.lint_gate.gate_payload`.
        generated_at: Statement timestamp; defaults to now (UTC). Pass a fixed value for
            deterministic output in tests.

    Returns:
        An in-toto Statement v1 dict (unsigned).
    """
    scanners = [dict(s) for s in gate_payload.get("scanners") or []]
    subjects = [
        {
            "name": str(s.get("scannerId") or "unknown"),
            "digest": {DIGEST_ALGORITHM: str(s.get("reportFingerprint") or "")},
        }
        for s in scanners
    ]
    stamp = (generated_at or datetime.now(timezone.utc)).isoformat()
    return {
        "_type": STATEMENT_TYPE,
        "subject": subjects,
        "predicateType": PREDICATE_TYPE,
        "predicate": {
            "subjectType": gate_payload.get("subjectType"),
            "subjectId": gate_payload.get("subjectId"),
            "projectId": gate_payload.get("projectId"),
            "baselineSubjectId": gate_payload.get("baselineSubjectId"),
            "newOnly": bool(gate_payload.get("newOnly")),
            "policy": dict(gate_payload.get("policy") or {}),
            "scanners": scanners,
            "evaluation": dict(gate_payload.get("evaluation") or {}),
            "gate": dict(gate_payload.get("gate") or {}),
            "counts": dict(gate_payload.get("counts") or {}),
            "generatedAt": stamp,
        },
    }


def build_delivery_attestation_statement(
    delivery_payload: Mapping[str, Any],
    *,
    generated_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Build the in-toto Statement for one export **delivery** gate decision (IXH-2.5).

    The subject is the delivered artifact, named by its bundle filename and digested with a plain
    ``sha256`` over the exact bytes the download route serves — so a holder of the file can tie it
    to this statement with ``sha256sum`` alone. The predicate records everything a verifier needs
    to reproduce the decision without the server: the delivery identity (tenant, job, artifact,
    revision, target, snapshot), the tool versions that produced it, the lint fingerprint the
    source quality was judged from, the policy version and content fingerprint applied, any waiver
    the decision honoured, and the decision itself with its named contributing reasons.

    Fingerprints, versions and verdicts only — never source text, artifact bytes, or credentials.

    Args:
        delivery_payload: The gate's attestation payload
            (:meth:`app.export_delivery_gate.DeliveryGateReport.attestation_payload`).
        generated_at: Statement timestamp; defaults to now (UTC). Pass a fixed value for
            deterministic output in tests.

    Returns:
        An in-toto Statement v1 dict (unsigned) — wrap it with :func:`attestation_envelope`.
    """
    artifact = dict(delivery_payload.get("artifact") or {})
    digest = str(artifact.get("contentSha256") or "")
    subjects = [
        {
            "name": str(artifact.get("filename") or "export-artifact"),
            "digest": {CONTENT_DIGEST_ALGORITHM: digest},
        }
    ]
    stamp = (generated_at or datetime.now(timezone.utc)).isoformat()
    return {
        "_type": STATEMENT_TYPE,
        "subject": subjects,
        "predicateType": DELIVERY_PREDICATE_TYPE,
        "predicate": {
            "tenantId": delivery_payload.get("tenantId"),
            "delivery": dict(delivery_payload.get("delivery") or {}),
            "artifact": artifact,
            "decision": dict(delivery_payload.get("decision") or {}),
            "inputs": dict(delivery_payload.get("inputs") or {}),
            "policy": dict(delivery_payload.get("policy") or {}),
            "waiver": dict(delivery_payload.get("waiver") or {}) or None,
            "tools": dict(delivery_payload.get("tools") or {}),
            "generatedAt": stamp,
        },
    }


def _pae(payload_type: str, payload: bytes) -> bytes:
    """DSSE Pre-Authentication Encoding v1: ``DSSEv1 <len> <type> <len> <payload>``."""
    type_bytes = payload_type.encode("utf-8")
    return b" ".join(
        [
            b"DSSEv1",
            str(len(type_bytes)).encode("ascii"),
            type_bytes,
            str(len(payload)).encode("ascii"),
            payload,
        ]
    )


def _sign(payload: bytes, secret: str) -> str:
    """Hex HMAC-SHA256 of the PAE bytes with the shared secret."""
    return hmac.new(
        secret.encode("utf-8"), _pae(PAYLOAD_TYPE, payload), hashlib.sha256
    ).hexdigest()


def attestation_envelope(
    statement: Mapping[str, Any],
    *,
    secret: Optional[str] = None,
    key_id: str = "apiome-lint-hmac-v1",
) -> Dict[str, Any]:
    """Wrap a statement in a DSSE envelope, HMAC-signed when a secret is configured.

    Args:
        statement: Output of :func:`build_attestation_statement`.
        secret: Shared HMAC secret; ``None`` emits an unsigned envelope.
        key_id: Identifier verifiers use to pick the right shared secret.

    Returns:
        ``{"payloadType", "payload" (base64 canonical JSON), "signatures": [...]}``.
    """
    payload = _canonical_json(dict(statement)).encode("utf-8")
    envelope: Dict[str, Any] = {
        "payloadType": PAYLOAD_TYPE,
        "payload": base64.b64encode(payload).decode("ascii"),
        "signatures": [],
    }
    if secret:
        envelope["signatures"].append(
            {
                "keyid": key_id,
                "alg": "hmac-sha256",
                "sig": _sign(payload, secret),
            }
        )
    return envelope


def verify_attestation_envelope(envelope: Mapping[str, Any], secret: str) -> bool:
    """Verify a DSSE envelope's HMAC signature against the shared secret.

    Args:
        envelope: A DSSE envelope produced by :func:`attestation_envelope`.
        secret: The shared HMAC secret.

    Returns:
        ``True`` when at least one signature verifies; ``False`` for missing/invalid
        signatures, wrong payload type, or undecodable payloads (never raises).
    """
    if not secret or not isinstance(envelope, Mapping):
        return False
    if envelope.get("payloadType") != PAYLOAD_TYPE:
        return False
    try:
        payload = base64.b64decode(str(envelope.get("payload") or ""), validate=True)
    except Exception:  # noqa: BLE001 - malformed payloads are just unverifiable
        return False
    expected = _sign(payload, secret)
    for signature in envelope.get("signatures") or []:
        if not isinstance(signature, Mapping):
            continue
        if hmac.compare_digest(str(signature.get("sig") or ""), expected):
            return True
    return False
