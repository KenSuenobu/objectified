"""Export delivery gate on quality policy with attestation — IXH-2.5 (#5100).

Covers the ticket's acceptance criteria for :mod:`app.export_delivery_gate`:

* the delivery decision combines the emitted-validation verdict, the source lint grade, the
  fidelity floor, and the tenant policy into **one** verdict with named contributing reasons;
* a blocked delivery returns those reasons and the override path — and, because the gate is
  evaluated before packaging, produces no artifact to serve;
* every delivered artifact carries an attestation naming the policy version, the tool versions,
  the lint fingerprint, and any waiver;
* that attestation verifies **offline** — the contract test below re-implements verification
  from the standard library alone, exactly as an external verifier would;
* the documented default policy preserves the pre-IXH-2.5 behaviour (nothing blocked).

The route-level halves live in :mod:`tests.test_export_job_engine` (async job) and
:mod:`tests.test_export_routes` (synchronous document/dispatch).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pytest

from app import import_export_quality_policy as qp
from app.export_delivery_gate import (
    ATTESTATION_KEY_ID,
    DeliveryDecision,
    DeliveryDimension,
    DeliveryGateReport,
    DeliveryReasonCode,
    DeliverySeverity,
    build_delivery_attestation,
    delivery_tool_versions,
    evaluate_delivery,
    lint_delivery_source,
)
from app.export_validation import EmittedArtifactValidation, ValidationFinding
from app.export_validation_gate import build_validation_report
from app.import_source import LintReport
from app.lint_attestation import DELIVERY_PREDICATE_TYPE, PAYLOAD_TYPE

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
REVISION_ID = "rev-uuid-1"
TARGET = "openapi-3.1"
SECRET = "delivery-attestation-test-secret"
STAMP = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _policy_row(**overrides: Any) -> Dict[str, Any]:
    """A stored policy row with every floor unset unless a test says otherwise."""
    row: Dict[str, Any] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": TENANT_ID,
        "version_number": 4,
        "content_fingerprint": "fp-policy-4",
        "import_min_grade": None,
        "import_min_score": None,
        "import_block_on_severity": None,
        "import_enforcement": "advisory",
        "export_min_grade": None,
        "export_min_score": None,
        "export_block_on_severity": None,
        "export_min_fidelity": None,
        "export_enforcement": "advisory",
        "format_overrides": {},
        "allow_override": True,
        "override_roles": ["owner", "admin"],
        "waiver_ttl_hours": 168,
        "actor_user_id": None,
        "actor_label": "Ada",
        "created_at": None,
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _no_tenant_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test starts from "this tenant has no policy row" — the documented default.

    Also blocks the waiver store by default: a test that wants a waiver honoured says so.
    """
    monkeypatch.setattr(
        qp.db, "get_latest_import_export_quality_policy", lambda _tenant: None
    )
    monkeypatch.setattr(
        qp.db,
        "list_active_import_export_quality_waivers",
        lambda _tenant, **_kwargs: [],
    )


def _with_policy(monkeypatch: pytest.MonkeyPatch, **overrides: Any) -> None:
    """Install a stored policy row for the tenant."""
    monkeypatch.setattr(
        qp.db,
        "get_latest_import_export_quality_policy",
        lambda _tenant: _policy_row(**overrides),
    )


def _lint(
    *,
    score: Optional[int] = 92,
    grade: Optional[str] = "A",
    errors: int = 0,
    warnings: int = 0,
) -> LintReport:
    """A source lint roll-up with the tallies a test cares about."""
    counts: Dict[str, int] = {}
    if errors:
        counts["error"] = errors
    if warnings:
        counts["warning"] = warnings
    return LintReport(
        score=score,
        grade=grade,
        report_fingerprint="lint-fp-1",
        severity_counts=counts,
    )


def _validation(verdict: str = "valid"):
    """An MFX-5.3 validation report in one of its four bands."""
    if verdict == "invalid":
        raw = EmittedArtifactValidation(
            target=TARGET,
            applicable=True,
            validated=True,
            valid=False,
            errors=["'info' is a required property (/)"],
            findings=[ValidationFinding(message="'info' is a required property", path="/")],
        )
    elif verdict == "skipped":
        raw = EmittedArtifactValidation(
            target=TARGET,
            applicable=True,
            validated=False,
            valid=True,
            detail="The 'openapi' validator toolchain is unavailable in this runtime.",
        )
    elif verdict == "not_applicable":
        raw = EmittedArtifactValidation(
            target=TARGET, applicable=False, validated=False, valid=True
        )
    else:
        raw = EmittedArtifactValidation(
            target=TARGET, applicable=True, validated=True, valid=True
        )
    return build_validation_report(raw)


def _decide(**overrides: Any) -> DeliveryGateReport:
    """Run the gate with sensible defaults, overriding only what a test varies."""
    kwargs: Dict[str, Any] = {
        "tenant_id": TENANT_ID,
        "tenant_slug": TENANT_SLUG,
        "target_format": TARGET,
        "target_key": "openapi",
        "version_record_id": REVISION_ID,
        "validation": _validation("valid"),
        "lint": _lint(),
        "preserved_percent": 100,
    }
    kwargs.update(overrides)
    return evaluate_delivery(**kwargs)


def _codes(report: DeliveryGateReport) -> List[str]:
    return [reason.code.value for reason in report.reasons]


# ---------------------------------------------------------------------------
# AC5 — the default policy preserves current behaviour
# ---------------------------------------------------------------------------


def test_default_policy_allows_a_clean_delivery_with_no_reasons() -> None:
    """No tenant policy, clean lint, valid artifact: allow, silently, as before IXH-2.5."""
    report = _decide()

    assert report.decision is DeliveryDecision.ALLOW
    assert report.blocks_delivery is False
    assert report.warns is False
    assert report.reasons == []
    assert report.policy.verdict == "pass"
    assert report.policy.scope == "export"
    assert report.override.available is False
    assert report.attestation is None  # attached only once the artifact bytes exist


def test_default_policy_never_blocks_even_on_a_terrible_source() -> None:
    """An F-grade, error-laden, near-empty conversion still ships under the default policy."""
    report = _decide(
        lint=_lint(score=11, grade="F", errors=9),
        preserved_percent=12,
    )

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    assert report.blocks_delivery is False
    assert DeliveryReasonCode.SOURCE_ERRORS_OPEN.value in _codes(report)


# ---------------------------------------------------------------------------
# AC1 — one verdict over four dimensions, with named reasons
# ---------------------------------------------------------------------------


def test_invalid_artifact_blocks_on_the_validation_dimension() -> None:
    report = _decide(validation=_validation("invalid"))

    assert report.decision is DeliveryDecision.BLOCK
    assert report.blocks_delivery is True
    assert _codes(report)[0] == DeliveryReasonCode.ARTIFACT_INVALID.value
    assert report.reasons[0].dimension is DeliveryDimension.VALIDATION
    assert report.reasons[0].severity is DeliverySeverity.BLOCKING


def test_skipped_validation_warns_without_blocking() -> None:
    report = _decide(validation=_validation("skipped"))

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    assert DeliveryReasonCode.VALIDATION_SKIPPED.value in _codes(report)


def test_not_applicable_validation_is_context_only() -> None:
    """No importer matches the target: informational, so the delivery stays a plain allow."""
    report = _decide(validation=_validation("not_applicable"))

    assert report.decision is DeliveryDecision.ALLOW
    assert _codes(report) == [DeliveryReasonCode.VALIDATION_NOT_APPLICABLE.value]


def test_open_source_errors_annotate_a_delivery_the_policy_does_not_gate() -> None:
    """The problem statement's case: a legal artifact from a source with open errors."""
    report = _decide(lint=_lint(score=71, grade="C", errors=3))

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    reason = next(
        r for r in report.reasons if r.code is DeliveryReasonCode.SOURCE_ERRORS_OPEN
    )
    assert reason.dimension is DeliveryDimension.LINT
    assert reason.detail == {
        "errors": 3,
        "score": 71,
        "grade": "C",
        "report_fingerprint": "lint-fp-1",
    }


def test_unlintable_source_warns_that_quality_is_unknown() -> None:
    report = _decide(lint=None)

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    assert _codes(report) == [DeliveryReasonCode.SOURCE_UNGRADED.value]
    assert report.source_grade is None


def test_source_quality_floor_blocks_with_a_named_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    report = _decide(lint=_lint(score=64, grade="C"))

    assert report.decision is DeliveryDecision.BLOCK
    codes = _codes(report)
    assert DeliveryReasonCode.SOURCE_BELOW_FLOOR.value in codes
    assert DeliveryReasonCode.POLICY_BLOCK.value in codes
    shortfall = next(
        r for r in report.reasons if r.code is DeliveryReasonCode.SOURCE_BELOW_FLOOR
    )
    assert shortfall.dimension is DeliveryDimension.LINT
    assert shortfall.detail["required"] == 90
    assert shortfall.detail["actual"] == 64
    # The generic "open errors" note is suppressed: the policy already named the shortfall.
    assert DeliveryReasonCode.SOURCE_ERRORS_OPEN.value not in codes


def test_fidelity_floor_blocks_on_its_own_dimension(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The IXH-2.5 dimension: a clean, well-graded source that simply does not survive."""
    _with_policy(monkeypatch, export_min_fidelity=80, export_enforcement="block")
    report = _decide(preserved_percent=42)

    assert report.decision is DeliveryDecision.BLOCK
    reason = next(
        r for r in report.reasons if r.code is DeliveryReasonCode.FIDELITY_BELOW_FLOOR
    )
    assert reason.dimension is DeliveryDimension.FIDELITY
    assert reason.detail["required"] == 80
    assert reason.detail["actual"] == 42
    assert "42%" in reason.message and "80%" in reason.message
    assert report.policy.min_fidelity == 80
    assert report.preserved_percent == 42


def test_fidelity_floor_is_not_exercised_without_a_measurement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A floor cannot be missed by a delivery that never measured fidelity."""
    _with_policy(monkeypatch, export_min_fidelity=80, export_enforcement="block")
    report = _decide(preserved_percent=None)

    assert report.decision is DeliveryDecision.ALLOW
    assert report.preserved_percent is None


def test_advisory_enforcement_warns_instead_of_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _with_policy(monkeypatch, export_min_fidelity=80)  # enforcement stays advisory
    report = _decide(preserved_percent=42)

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    assert report.blocks_delivery is False
    reason = next(
        r for r in report.reasons if r.code is DeliveryReasonCode.FIDELITY_BELOW_FLOOR
    )
    assert reason.severity is DeliverySeverity.WARNING


def test_blocking_reasons_are_ordered_first() -> None:
    report = _decide(validation=_validation("invalid"), lint=_lint(score=40, grade="D", errors=2))

    severities = [reason.severity for reason in report.reasons]
    assert severities == sorted(
        severities,
        key=[DeliverySeverity.BLOCKING, DeliverySeverity.WARNING, DeliverySeverity.INFO].index,
    )
    assert report.reasons[0].severity is DeliverySeverity.BLOCKING


def test_a_waiver_downgrades_a_block_to_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    monkeypatch.setattr(
        qp.db,
        "list_active_import_export_quality_waivers",
        lambda _tenant, **_kwargs: [
            {
                "id": "waiver-1",
                "format_key": "openapi",
                "expires_at": "2026-09-01T00:00:00Z",
                "actor_label": "Ada",
            }
        ],
    )
    report = _decide(lint=_lint(score=64, grade="C"))

    assert report.decision is DeliveryDecision.ALLOW_WITH_WARNING
    assert DeliveryReasonCode.POLICY_WAIVED.value in _codes(report)
    assert report.policy.waiver_id == "waiver-1"


# ---------------------------------------------------------------------------
# AC2 — a blocked delivery returns reasons and the override path
# ---------------------------------------------------------------------------


def test_policy_block_returns_a_usable_override_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    report = _decide(lint=_lint(score=64, grade="C"))

    override = report.override
    assert override.available is True
    assert override.endpoint == f"/v1/tenants/{TENANT_SLUG}/governance/quality-waivers"
    assert override.scope == "export"
    assert override.subject_key == REVISION_ID
    assert override.format_key == "openapi"
    assert override.roles == ["owner", "admin"]
    assert "owner, admin" in override.instructions


def test_an_invalid_artifact_offers_no_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """A waiver cannot make an illegal artifact legal, even when policy permits overrides."""
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    report = _decide(validation=_validation("invalid"), lint=_lint(score=64, grade="C"))

    assert report.decision is DeliveryDecision.BLOCK
    assert report.override.available is False
    assert "cannot be waived" in report.override.instructions


def test_a_policy_that_forbids_overrides_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    _with_policy(
        monkeypatch,
        export_min_score=90,
        export_enforcement="block",
        allow_override=False,
    )
    report = _decide(lint=_lint(score=64, grade="C"))

    assert report.override.available is False
    assert report.override.endpoint is None
    assert "does not permit an override" in report.override.instructions


def test_a_blocked_delivery_is_never_attested(monkeypatch: pytest.MonkeyPatch) -> None:
    """There is no artifact to attest to — signing one would imply bytes shipped."""
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    report = _decide(lint=_lint(score=64, grade="C"))

    attested = build_delivery_attestation(
        report,
        tenant_id=TENANT_ID,
        delivery={"jobId": "job-1"},
        artifact={"filename": "openapi.json", "contentSha256": "0" * 64},
        tools={},
        secret=SECRET,
    )
    assert attested.attestation is None
    assert attested is report


# ---------------------------------------------------------------------------
# AC3 / AC4 — the attestation and its offline verification contract
# ---------------------------------------------------------------------------

ARTIFACT_BYTES = b'{"openapi":"3.1.0"}'


def _attested(report: DeliveryGateReport, *, secret: Optional[str] = SECRET):
    """Attach an attestation for ``ARTIFACT_BYTES`` with a fixed timestamp."""
    return build_delivery_attestation(
        report,
        tenant_id=TENANT_ID,
        delivery={
            "jobId": "job-1",
            "tenantSlug": TENANT_SLUG,
            "artifactId": "artifact-1",
            "versionRecordId": REVISION_ID,
            "versionLabel": "1.0.0",
            "target": TARGET,
        },
        artifact={
            "filename": "openapi.json",
            "contentSha256": hashlib.sha256(ARTIFACT_BYTES).hexdigest(),
            "sizeBytes": len(ARTIFACT_BYTES),
            "mediaType": "application/json",
        },
        tools=delivery_tool_versions(
            target_format=TARGET,
            emitter_version="1.4.0",
            registry_version="2026.07",
            apiome_version="9.9.9",
            validation=_validation("valid"),
        ),
        secret=secret,
        generated_at=STAMP,
    )


def _statement(report: DeliveryGateReport) -> Dict[str, Any]:
    """Decode the statement back out of the DSSE envelope, as a verifier would."""
    assert report.attestation is not None
    payload = base64.b64decode(report.attestation.envelope["payload"], validate=True)
    return json.loads(payload)


def test_a_delivered_artifact_carries_a_complete_attestation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC3: policy version, tool versions, lint fingerprint, and the waiver reference."""
    _with_policy(monkeypatch, export_min_score=90, export_enforcement="block")
    monkeypatch.setattr(
        qp.db,
        "list_active_import_export_quality_waivers",
        lambda _tenant, **_kwargs: [
            {
                "id": "waiver-1",
                "format_key": "openapi",
                "expires_at": "2026-09-01T00:00:00Z",
                "actor_label": "Ada",
            }
        ],
    )
    report = _attested(_decide(lint=_lint(score=64, grade="C")))
    statement = _statement(report)
    predicate = statement["predicate"]

    assert statement["predicateType"] == DELIVERY_PREDICATE_TYPE
    assert statement["subject"] == [
        {
            "name": "openapi.json",
            "digest": {"sha256": hashlib.sha256(ARTIFACT_BYTES).hexdigest()},
        }
    ]
    assert predicate["policy"]["policyVersionId"] == "11111111-1111-1111-1111-111111111111"
    assert predicate["policy"]["policyContentFingerprint"] == "fp-policy-4"
    assert predicate["policy"]["minScore"] == 90
    assert predicate["inputs"]["lintReportFingerprint"] == "lint-fp-1"
    assert predicate["inputs"]["validationVerdict"] == "valid"
    assert predicate["waiver"] == {
        "waiverId": "waiver-1",
        "expiresAt": "2026-09-01T00:00:00Z",
    }
    assert predicate["tools"]["emitter"] == "1.4.0"
    assert predicate["tools"]["capabilityRegistry"] == "2026.07"
    assert predicate["tools"]["apiome"] == "9.9.9"
    assert predicate["tools"]["validator"] == "OpenAPI meta-schema + OpenAPI import"
    assert predicate["generatedAt"] == STAMP.isoformat()
    # The attested decision is the returned decision — not a recomputation.
    assert predicate["decision"]["decision"] == report.decision.value
    assert [r["code"] for r in predicate["decision"]["reasons"]] == _codes(report)


def _verify_offline(envelope: Dict[str, Any], secret: str) -> bool:
    """Verify a DSSE envelope with the standard library alone.

    Deliberately re-implemented here rather than imported: this is the contract an external
    verifier (CI, ``apiome lint verify-attestation``) implements, so the test proves the
    envelope is checkable without any Apiome code.
    """
    if envelope.get("payloadType") != PAYLOAD_TYPE:
        return False
    payload = base64.b64decode(envelope["payload"], validate=True)
    type_bytes = PAYLOAD_TYPE.encode("utf-8")
    pae = b" ".join(
        [
            b"DSSEv1",
            str(len(type_bytes)).encode("ascii"),
            type_bytes,
            str(len(payload)).encode("ascii"),
            payload,
        ]
    )
    expected = hmac.new(secret.encode("utf-8"), pae, hashlib.sha256).hexdigest()
    return any(
        hmac.compare_digest(str(sig.get("sig") or ""), expected)
        for sig in envelope.get("signatures") or []
    )


def test_the_attestation_verifies_offline_and_detects_tampering() -> None:
    """AC4: the contract test — verifiable with stdlib only, and only when untampered."""
    report = _attested(_decide())
    assert report.attestation is not None
    assert report.attestation.signed is True
    assert report.attestation.key_id == ATTESTATION_KEY_ID
    envelope = report.attestation.envelope

    assert _verify_offline(envelope, SECRET) is True
    assert _verify_offline(envelope, "the-wrong-secret") is False

    tampered = dict(envelope)
    statement = json.loads(base64.b64decode(envelope["payload"], validate=True))
    statement["predicate"]["decision"]["decision"] = "allow"
    statement["subject"][0]["digest"]["sha256"] = "f" * 64
    tampered["payload"] = base64.b64encode(
        json.dumps(statement, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    assert _verify_offline(tampered, SECRET) is False


def test_an_unconfigured_signing_secret_still_emits_a_well_formed_envelope() -> None:
    """No secret: a complete, readable attestation that simply is not verifiable."""
    report = _attested(_decide(), secret="")

    assert report.attestation is not None
    assert report.attestation.signed is False
    assert report.attestation.key_id is None
    assert report.attestation.envelope["signatures"] == []
    assert _statement(report)["predicateType"] == DELIVERY_PREDICATE_TYPE


def test_attestation_bytes_are_deterministic_for_identical_inputs() -> None:
    """Two attestations of the same delivery are byte-identical, so signatures are comparable."""
    first = _attested(_decide())
    second = _attested(_decide())

    assert first.attestation is not None and second.attestation is not None
    assert first.attestation.envelope == second.attestation.envelope


def test_an_attestation_fault_never_fails_an_allowed_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Signing is best-effort: policy already allowed this delivery."""
    monkeypatch.setattr(
        "app.export_delivery_gate.build_delivery_attestation_statement",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    report = _attested(_decide())

    assert report.attestation is None
    assert report.blocks_delivery is False


def test_the_report_round_trips_through_its_wire_shape() -> None:
    """The whole decision (including the envelope) survives serialization to the API."""
    report = _attested(_decide(validation=_validation("skipped")))
    restored = DeliveryGateReport.model_validate(report.model_dump(mode="json"))

    assert restored.decision is report.decision
    assert _codes(restored) == _codes(report)
    assert restored.attestation is not None
    assert restored.attestation.envelope == report.attestation.envelope


# ---------------------------------------------------------------------------
# The shared source linter every delivery path uses
# ---------------------------------------------------------------------------


def test_lint_delivery_source_degrades_to_none_on_a_lint_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unlintable source is an ungraded delivery, never a failed one."""
    monkeypatch.setattr(
        "app.export_preflight.lint_export_source",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("style guide exploded")),
    )
    assert lint_delivery_source(object(), tenant_id=TENANT_ID, project_id="artifact-1") is None
