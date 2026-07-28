"""Endpoint tests for the evidence-backed verification policy API — ECA-3.1 (#4734)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.verification_policy import (
    DEFAULT_POLICY,
    VerificationPolicy,
    canonical_policy_body,
    policy_content_fingerprint,
)
from app.verification_policy_evaluate import GateResult, PolicyDecision

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"
POLICY_ID = "11111111-1111-1111-1111-111111111111"
EVAL_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
PROJECT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
VERSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
DIGEST = "sha256:" + ("a" * 64)
NOW = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "email": "admin@example.com",
    "auth_method": "jwt",
}

POLICY_URL = f"/v1/tenants/{TENANT_SLUG}/governance/verification-policy"
EVALUATE_URL = f"{POLICY_URL}/evaluate"
EVALUATIONS_URL = f"{POLICY_URL}/evaluations"


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    app.openapi_schema = None
    yield
    app.dependency_overrides.clear()
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _admin():
    with patch(
        "app.verification_policy_routes.db.is_user_tenant_admin", return_value=True
    ):
        yield


@pytest.fixture(autouse=True)
def _audit():
    rows: List[Dict[str, Any]] = []
    with patch(
        "app.verification_policy_routes.db.write_access_audit",
        side_effect=lambda **kwargs: rows.append(kwargs),
    ):
        yield rows


def _row(**overrides: Any) -> Dict[str, Any]:
    body = canonical_policy_body(
        required_suite_digests=[DIGEST],
        max_evidence_age_seconds=3600,
        required_target_network_class="public",
        purpose="both",
        breaking_change_action="block",
        enforcement="block",
    )
    row: Dict[str, Any] = {
        "id": POLICY_ID,
        "tenant_id": TENANT_ID,
        "version_number": 2,
        "content_fingerprint": policy_content_fingerprint(body),
        "required_suite_digests": [DIGEST],
        "max_evidence_age_seconds": 3600,
        "required_target_network_class": "public",
        "purpose": "both",
        "breaking_change_action": "block",
        "enforcement": "block",
        "actor_user_id": USER_ID,
        "actor_label": "admin@example.com",
        "created_at": NOW,
    }
    row.update(overrides)
    return row


def test_openapi_exposes_verification_policy_operations():
    spec = app.openapi()
    base = "/v1/tenants/{tenant_slug}/governance/verification-policy"
    assert {"get", "put"} <= set(spec["paths"][base])
    assert "post" in spec["paths"][f"{base}/evaluate"]
    assert "get" in spec["paths"][f"{base}/versions"]
    assert "get" in spec["paths"][f"{base}/evaluations"]


def test_tenant_without_policy_reads_advisory_default():
    with patch(
        "app.verification_policy_routes.db.get_latest_verification_policy",
        return_value=None,
    ):
        response = client.get(POLICY_URL)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["isDefault"] is True
    assert body["versionNumber"] == 0
    assert body["enforcement"] == "advisory"
    assert body["requiredSuiteDigests"] == []
    assert body["breakingChangeAction"] == "warn"


def test_put_appends_version_and_audits(_audit):
    inserted = _row(version_number=1)
    with (
        patch(
            "app.verification_policy_store.db.insert_verification_policy",
            return_value=inserted,
        ),
        patch(
            "app.verification_policy_routes.db.get_latest_verification_policy",
            return_value=inserted,
        ),
        patch(
            "app.verification_policy_store.load_tenant_policy",
            return_value=DEFAULT_POLICY,
        ),
    ):
        response = client.put(
            POLICY_URL,
            json={
                "requiredSuiteDigests": [DIGEST],
                "maxEvidenceAgeSeconds": 3600,
                "requiredTargetNetworkClass": "public",
                "purpose": "both",
                "breakingChangeAction": "block",
                "enforcement": "block",
            },
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["isDefault"] is False
    assert body["requiredSuiteDigests"] == [DIGEST]
    assert body["enforcement"] == "block"
    assert any(r["action"] == "governance.verification_policy.update" for r in _audit)


def test_put_requires_admin():
    with patch(
        "app.verification_policy_routes.db.is_user_tenant_admin", return_value=False
    ):
        response = client.put(POLICY_URL, json={"enforcement": "block"})
    assert response.status_code == 403


def test_evaluate_returns_decision_with_evidence_ids(_audit):
    decision = PolicyDecision(
        passed=True,
        enforcement="advisory",
        policy_version_id=POLICY_ID,
        policy_content_fingerprint="fp",
        gate_results=(
            GateResult(gate="suite_digest", passed=True, detail={}),
            GateResult(gate="evidence_age", passed=True, detail={}),
            GateResult(gate="breaking_change", passed=True, detail={}),
        ),
        evidence_run_ids=("dddddddd-dddd-dddd-dddd-dddddddddddd",),
        warnings=(),
        purpose="publish",
    )
    with (
        patch(
            "app.verification_policy_routes.evaluate_and_record",
            return_value=(decision, EVAL_ID),
        ),
        patch(
            "app.verification_policy_routes._resolve_subject",
            return_value=(PROJECT_ID, VERSION_ID),
        ),
    ):
        response = client.post(
            EVALUATE_URL,
            json={
                "purpose": "publish",
                "projectSlug": "payments",
                "versionSlug": "1.0.0",
            },
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["passed"] is True
    assert body["evaluationId"] == EVAL_ID
    assert body["evidenceRunIds"] == ["dddddddd-dddd-dddd-dddd-dddddddddddd"]
    assert body["gateResults"][0]["gate"] == "suite_digest"
    assert any(r["action"] == "governance.verification_policy.evaluate" for r in _audit)


def test_evaluate_rejects_bad_purpose():
    response = client.post(EVALUATE_URL, json={"purpose": "ship"})
    assert response.status_code == 422


def test_list_evaluations():
    row = {
        "id": EVAL_ID,
        "tenant_id": TENANT_ID,
        "project_id": PROJECT_ID,
        "version_record_id": VERSION_ID,
        "policy_version_id": POLICY_ID,
        "policy_content_fingerprint": "fp",
        "purpose": "publish",
        "passed": False,
        "enforcement": "block",
        "gate_results": [{"gate": "suite_digest", "passed": False, "detail": {}}],
        "evidence_run_ids": [],
        "warnings": [],
        "actor_label": "admin@example.com",
        "actor_kind": "user",
        "evaluated_at": NOW,
    }
    with patch(
        "app.verification_policy_routes.list_evaluations", return_value=[row]
    ):
        response = client.get(
            EVALUATIONS_URL, params={"versionRecordId": VERSION_ID}
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["count"] == 1
    assert body["evaluations"][0]["id"] == EVAL_ID
    assert body["evaluations"][0]["passed"] is False
