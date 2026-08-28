"""HTTP contract tests for the verification-evidence endpoints — ECA-1.3 (#4731).

``/v1/tenants/{tenant_slug}/verification-runs`` and its export. The store is faked (its own tests
cover it); what is asserted here is the endpoint's own contract:

* every route is gated on the ``verification_evidence`` RBAC resource, with **recording** separated
  from reading, and a denial is a 403 rather than a silent no-op;
* a refusal from the contract layer becomes the HTTP status that matches its *kind* (404 unknown
  run or target, 400 bad submission) and always carries the stable code;
* an idempotent replay answers 200 rather than claiming a creation;
* the export is served with the media type its format is served as, and its body is the stored
  evidence;
* there is **no** update or delete route — evidence is immutable, and the API says so by having
  nowhere to say otherwise;
* the mock-attestation route (PMR-3.2) renders a run's mock as a signed DSSE envelope — including
  when what it has to say is "this was never verified" — and 404s only when the run recorded no
  mock at all.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.config import settings
from app.main import app
from app.mock_attestation import (
    MOCK_PREDICATE_TYPE,
    MOCK_STATUS_MISSING,
    MOCK_STATUS_VERIFIED,
    REASON_ATTESTATION_MISSING,
    MockAttestationRecord,
    MockBundleApi,
    MockBundleRef,
    MockRuntimeRef,
)
from app.verification_evidence import (
    CODE_ARTIFACT_EMBEDDED,
    CODE_MOCK_ATTESTATION_ABSENT,
    CODE_OUTCOME_MISMATCH,
    CODE_RUN_NOT_FOUND,
    CODE_TARGET_NOT_FOUND,
    EvidenceValidationError,
    OperationRecord,
    VerificationRunRecord,
    VerificationRunSummary,
)
from app.verification_evidence_store import RecordedRun

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}
_RUN = "33333333-3333-4333-8333-333333333333"
_TARGET = "22222222-2222-4222-8222-222222222222"
_DIGEST = "sha256:" + "a" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
_BASE = "/v1/tenants/acme/verification-runs"


def _record(**overrides: Any) -> VerificationRunRecord:
    """Stored evidence, as the store returns it."""
    payload: Dict[str, Any] = {
        "id": _RUN,
        "tenant_id": "test-tenant-id",
        "suite_digest": _DIGEST,
        "target_id": _TARGET,
        "target_slug": "staging",
        "target_environment": "staging",
        "target_network_class": "public",
        "target_base_url": "https://staging.example.com/api",
        "runner_name": "apiome-contract-runner",
        "started_at": _START,
        "finished_at": _START + timedelta(seconds=5),
        "duration_ms": 5000,
        "outcome": "failed",
        "counts": {"total": 2, "passed": 1, "failed": 1, "errored": 0, "skipped": 0},
        "operations": [
            OperationRecord(
                id="a1",
                sequence=0,
                case_id="get-pets-example-1",
                operation_key="GET /pets",
                http_method="GET",
                http_path="/pets",
                outcome="passed",
                duration_ms=120,
            ),
            OperationRecord(
                id="a2",
                sequence=1,
                case_id="get-pet-negative-1",
                operation_key="GET /pets/{petId}",
                http_method="GET",
                http_path="/pets/abc",
                outcome="failed",
                failure_code="status-mismatch",
                failure_message="expected 400, got 500",
                duration_ms=300,
            ),
        ],
    }
    payload.update(overrides)
    return VerificationRunRecord(**payload)


def _summary() -> VerificationRunSummary:
    """A run summary, as a list read returns one."""
    return VerificationRunSummary(
        **_record().model_dump(exclude={"operations", "artifacts", "mock"})
    )


def _submission(**overrides: Any) -> Dict[str, Any]:
    """A valid POST body."""
    body: Dict[str, Any] = {
        "target_ref": "staging",
        "suite_digest": _DIGEST,
        "runner_name": "apiome-contract-runner",
        "started_at": _START.isoformat(),
        "finished_at": (_START + timedelta(seconds=5)).isoformat(),
        "operations": [
            {
                "case_id": "get-pets-example-1",
                "operation_key": "GET /pets",
                "http_method": "GET",
                "http_path": "/pets",
                "outcome": "passed",
            }
        ],
    }
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate every request and grant the permission each route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch(
        "app.verification_evidence_routes.enforce_permission", return_value="test-user-id"
    ):
        yield
    app.dependency_overrides.clear()


# ===========================================================================
# Recording
# ===========================================================================


def test_recording_a_run_answers_201_with_the_stored_evidence() -> None:
    with patch(
        "app.verification_evidence_routes.record_run",
        return_value=RecordedRun(_record(), created=True),
    ):
        response = client.post(_BASE, json=_submission())

    assert response.status_code == 201
    body = response.json()
    assert body["id"] == _RUN
    assert body["suite_digest"] == _DIGEST
    assert body["counts"]["failed"] == 1
    assert len(body["operations"]) == 2


def test_an_idempotent_replay_answers_200_because_nothing_was_created() -> None:
    with patch(
        "app.verification_evidence_routes.record_run",
        return_value=RecordedRun(_record(idempotency_key="build-42"), created=False),
    ):
        response = client.post(_BASE, json=_submission(idempotency_key="build-42"))

    assert response.status_code == 200
    assert response.json()["id"] == _RUN


def test_the_stored_record_names_the_target_it_ran_against() -> None:
    with patch(
        "app.verification_evidence_routes.record_run",
        return_value=RecordedRun(_record(), created=True),
    ):
        body = client.post(_BASE, json=_submission()).json()

    assert body["target_id"] == _TARGET
    assert body["target_slug"] == "staging"
    assert body["target_environment"] == "staging"
    assert body["target_base_url"] == "https://staging.example.com/api"


def test_a_rejected_submission_becomes_a_400_carrying_its_stable_code() -> None:
    error = EvidenceValidationError(CODE_OUTCOME_MISMATCH, "the run declares 'passed'")
    with patch("app.verification_evidence_routes.record_run", side_effect=error):
        response = client.post(_BASE, json=_submission())

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == CODE_OUTCOME_MISMATCH


def test_an_unknown_target_becomes_a_404_rather_than_a_bad_request() -> None:
    error = EvidenceValidationError(CODE_TARGET_NOT_FOUND, "no such target")
    with patch("app.verification_evidence_routes.record_run", side_effect=error):
        response = client.post(_BASE, json=_submission())

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == CODE_TARGET_NOT_FOUND


def test_an_embedded_artifact_is_refused_at_the_boundary() -> None:
    error = EvidenceValidationError(CODE_ARTIFACT_EMBEDDED, "linked, not embedded")
    with patch("app.verification_evidence_routes.record_run", side_effect=error):
        response = client.post(
            _BASE,
            json=_submission(
                artifacts=[{"kind": "log", "uri": "data:text/plain,hello"}]
            ),
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == CODE_ARTIFACT_EMBEDDED


def test_an_unknown_field_in_a_submission_is_rejected_rather_than_ignored() -> None:
    response = client.post(_BASE, json=_submission(content="the whole response body"))
    assert response.status_code == 422


def test_recording_requires_the_create_permission() -> None:
    from fastapi import HTTPException

    with patch(
        "app.verification_evidence_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="denied"),
    ):
        response = client.post(_BASE, json=_submission())
    assert response.status_code == 403


# ===========================================================================
# Reading
# ===========================================================================


def test_listing_returns_summaries_with_a_count() -> None:
    with patch("app.verification_evidence_routes.list_runs", return_value=[_summary()]):
        response = client.get(_BASE)

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["runs"][0]["outcome"] == "failed"
    # A summary is a summary: per-case detail belongs to the single-run read.
    assert "operations" not in body["runs"][0]


def test_the_gate_filters_reach_the_store() -> None:
    with patch("app.verification_evidence_routes.list_runs", return_value=[]) as listed:
        client.get(
            _BASE, params={"suite_digest": _DIGEST, "target_id": _TARGET, "outcome": "passed"}
        )

    kwargs = listed.call_args.kwargs
    assert kwargs["suite_digest"] == _DIGEST
    assert kwargs["target_id"] == _TARGET
    assert kwargs["outcome"] == "passed"


def test_reading_one_run_returns_its_cases() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}")

    assert response.status_code == 200
    body = response.json()
    assert [operation["case_id"] for operation in body["operations"]] == [
        "get-pets-example-1",
        "get-pet-negative-1",
    ]
    assert body["operations"][1]["failure_code"] == "status-mismatch"


def test_an_unknown_run_is_a_404_with_its_code() -> None:
    error = EvidenceValidationError(CODE_RUN_NOT_FOUND, "no such run")
    with patch("app.verification_evidence_routes.get_run", side_effect=error):
        response = client.get(f"{_BASE}/{_RUN}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == CODE_RUN_NOT_FOUND


def test_reading_requires_the_view_permission() -> None:
    from fastapi import HTTPException

    with patch(
        "app.verification_evidence_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="denied"),
    ):
        assert client.get(_BASE).status_code == 403
        assert client.get(f"{_BASE}/{_RUN}").status_code == 403
        assert client.get(f"{_BASE}/{_RUN}/export").status_code == 403


# ===========================================================================
# Export
# ===========================================================================


def test_the_json_export_is_served_as_json() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/export", params={"format": "json"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["counts"]["failed"] == 1


def test_json_is_the_default_export_format() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/export")
    assert response.headers["content-type"].startswith("application/json")


def test_the_junit_export_is_served_as_xml_and_reproduces_the_outcomes() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/export", params={"format": "junit"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert 'tests="2"' in response.text
    assert 'failures="1"' in response.text
    assert 'name="get-pet-negative-1"' in response.text
    assert 'type="status-mismatch"' in response.text


def test_an_export_is_offered_as_a_file_a_ci_job_can_save() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/export", params={"format": "junit"})
    assert response.headers["content-disposition"] == (
        f'attachment; filename="verification-run-{_RUN}.xml"'
    )


def test_an_unsupported_export_format_is_a_400_with_its_code() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/export", params={"format": "tap"})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "evidence-export-format-unsupported"


def test_exporting_an_unknown_run_is_a_404() -> None:
    error = EvidenceValidationError(CODE_RUN_NOT_FOUND, "no such run")
    with patch("app.verification_evidence_routes.get_run", side_effect=error):
        response = client.get(f"{_BASE}/{_RUN}/export")
    assert response.status_code == 404


# ===========================================================================
# Immutability, expressed as an absent surface
# ===========================================================================


@pytest.mark.parametrize("method", ["PATCH", "PUT", "DELETE"])
def test_evidence_cannot_be_edited_or_deleted_through_the_api(method: str) -> None:
    response = client.request(method, f"{_BASE}/{_RUN}")
    assert response.status_code == 405


def test_no_evidence_route_advertises_a_mutating_verb() -> None:
    paths = [route for route in app.routes if "verification-runs" in getattr(route, "path", "")]
    assert paths, "the evidence router must be mounted"
    for route in paths:
        assert not {"PUT", "PATCH", "DELETE"} & set(getattr(route, "methods", set()))


# ===========================================================================
# Mock attestation (PMR-3.2, #4749)
# ===========================================================================


def _verified_mock() -> MockAttestationRecord:
    """A stored attestation over a published bundle with a passing corpus."""
    return MockAttestationRecord(
        status=MOCK_STATUS_VERIFIED,
        bundle=MockBundleRef(
            digest="sha256:" + "e" * 64,
            format="apiome.mock.bundle/v1",
            format_version=1,
            signed=True,
            api=MockBundleApi(
                tenant="acme",
                project="petstore",
                version="1.0.0",
                revision_id="55555555-5555-4555-8555-555555555555",
                published=True,
            ),
        ),
        runtime=MockRuntimeRef(version="0.9.0"),
    )


def test_the_mock_attestation_route_returns_a_signed_dsse_envelope() -> None:
    with (
        patch(
            "app.verification_evidence_routes.get_run",
            return_value=_record(mock=_verified_mock()),
        ),
        patch.object(settings, "lint_attestation_signing_secret", "shared-secret"),
    ):
        response = client.get(f"{_BASE}/{_RUN}/mock-attestation")

    assert response.status_code == 200
    body = response.json()
    assert body["predicateType"] == MOCK_PREDICATE_TYPE
    assert body["signed"] is True
    assert body["keyId"] == "apiome-lint-hmac-v1"
    assert body["envelope"]["payloadType"] == "application/vnd.in-toto+json"


def test_an_unverified_mock_is_still_attested_rather_than_404() -> None:
    missing = MockAttestationRecord(
        status=MOCK_STATUS_MISSING,
        reason_code=REASON_ATTESTATION_MISSING,
        reason="nothing was attached",
    )
    with patch(
        "app.verification_evidence_routes.get_run", return_value=_record(mock=missing)
    ):
        response = client.get(f"{_BASE}/{_RUN}/mock-attestation")

    assert response.status_code == 200
    assert response.json()["envelope"]["payload"]


def test_a_run_that_recorded_no_mock_answers_404_with_its_code() -> None:
    with patch("app.verification_evidence_routes.get_run", return_value=_record()):
        response = client.get(f"{_BASE}/{_RUN}/mock-attestation")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == CODE_MOCK_ATTESTATION_ABSENT


def test_an_unknown_run_answers_404_from_the_mock_attestation_route() -> None:
    with patch(
        "app.verification_evidence_routes.get_run",
        side_effect=EvidenceValidationError(CODE_RUN_NOT_FOUND, "no such run"),
    ):
        response = client.get(f"{_BASE}/{_RUN}/mock-attestation")

    assert response.status_code == 404
