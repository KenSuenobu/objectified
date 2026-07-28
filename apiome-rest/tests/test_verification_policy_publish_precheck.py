"""Publish precheck wiring for ECA-3.1 verification policy (#4734)."""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models import VersionPublishRequest
from app.verification_policy_evaluate import GateResult, PolicyDecision
from app.version_publish_prechecks import (
    PublishPrecheckOutcome,
    _with_verification_policy,
    enforce_publish_prechecks,
)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
PROJECT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
VERSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"


def _decision(*, passed: bool, enforcement: str) -> PolicyDecision:
    return PolicyDecision(
        passed=passed,
        enforcement=enforcement,
        policy_version_id="pppppppp-pppp-pppp-pppp-pppppppppppp",
        policy_content_fingerprint="fp",
        gate_results=(
            GateResult(gate="suite_digest", passed=passed, detail={}),
            GateResult(gate="evidence_age", passed=True, detail={}),
            GateResult(gate="breaking_change", passed=True, detail={}),
        ),
        evidence_run_ids=("dddddddd-dddd-dddd-dddd-dddddddddddd",) if passed else (),
        warnings=(),
        purpose="publish",
    )


def test_skip_publish_checks_bypasses_verification_policy():
    request = VersionPublishRequest(skip_publish_checks=True, force_publish_reason="emergency")
    # VersionPublishRequest may use different field names — tolerate construction.
    outcome = enforce_publish_prechecks(
        tenant_slug="acme",
        tenant_id=TENANT_ID,
        project_id=PROJECT_ID,
        existing={"id": VERSION_ID, "version_id": "1.0.0"},
        request=request,
    )
    assert outcome.verification_decision is None


def test_advisory_failure_does_not_block():
    decision = _decision(passed=False, enforcement="advisory")
    with patch(
        "app.version_publish_prechecks.evaluate_and_record",
        return_value=(decision, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
    ):
        outcome = _with_verification_policy(
            PublishPrecheckOutcome(),
            tenant_id=TENANT_ID,
            project_id=PROJECT_ID,
            version_record_id=VERSION_ID,
        )
    assert outcome.verification_decision is not None
    assert outcome.verification_decision["passed"] is False
    assert outcome.verification_decision["enforcement"] == "advisory"


def test_block_enforcement_raises_422_with_decision_payload():
    decision = _decision(passed=False, enforcement="block")
    with patch(
        "app.version_publish_prechecks.evaluate_and_record",
        return_value=(decision, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
    ):
        with pytest.raises(HTTPException) as exc_info:
            _with_verification_policy(
                PublishPrecheckOutcome(),
                tenant_id=TENANT_ID,
                project_id=PROJECT_ID,
                version_record_id=VERSION_ID,
            )
    assert exc_info.value.status_code == 422
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert "verificationPolicyDecision" in detail
    assert detail["verificationPolicyDecision"]["passed"] is False
    assert detail["verificationPolicyDecision"]["evaluationId"] == (
        "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    )


def test_block_enforcement_passes_when_decision_passes():
    decision = _decision(passed=True, enforcement="block")
    with patch(
        "app.version_publish_prechecks.evaluate_and_record",
        return_value=(decision, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
    ):
        outcome = _with_verification_policy(
            PublishPrecheckOutcome(),
            tenant_id=TENANT_ID,
            project_id=PROJECT_ID,
            version_record_id=VERSION_ID,
        )
    assert outcome.verification_decision["passed"] is True
    assert outcome.verification_decision["evidenceRunIds"] == [
        "dddddddd-dddd-dddd-dddd-dddddddddddd"
    ]
