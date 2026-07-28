"""HTTP contract tests for ``POST …/contracts/{version_ref}/run`` — ECA-2.1 (#4732).

The service is faked; this asserts the route's own contract: dual RBAC gates, addressing and
target fault mapping, and 201 for newly recorded evidence.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.contract_runner import RUNNER_NAME
from app.contract_runner_service import ContractRunResponse
from app.main import app
from app.schema_reference import SchemaReferenceError
from app.verification_evidence import VerificationRunRecord
from app.verification_target import CODE_NOT_FOUND, TargetValidationError

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}
_DIGEST = "sha256:" + "c" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
_BASE = "/v1/tenants/acme/contracts/project/pets/1.0.0/run"


def _run_record() -> VerificationRunRecord:
    return VerificationRunRecord(
        id="33333333-3333-4333-8333-333333333333",
        tenant_id="test-tenant-id",
        suite_digest=_DIGEST,
        target_id="22222222-2222-4222-8222-222222222222",
        target_slug="mock",
        target_environment="mock",
        target_network_class="private",
        target_base_url="http://localhost:8775/acme/pets/1.0.0",
        runner_name=RUNNER_NAME,
        started_at=_START,
        finished_at=_START + timedelta(seconds=2),
        duration_ms=2000,
        outcome="passed",
        counts={"total": 1, "passed": 1, "failed": 0, "errored": 0, "skipped": 0},
        operations=[],
    )


@pytest.fixture(autouse=True)
def _auth():
    """Authenticate and grant both permissions the route checks."""
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    with patch(
        "app.contract_runner_routes.enforce_permission", return_value="test-user-id"
    ):
        yield
    app.dependency_overrides.clear()


def test_run_answers_201_with_evidence() -> None:
    response_body = ContractRunResponse(
        ok=True,
        version_ref="project/pets/1.0.0",
        suite_digest=_DIGEST,
        run=_run_record(),
        created=True,
    )
    with patch(
        "app.contract_runner_routes.run_version_contract_suite",
        return_value=response_body,
    ):
        response = client.post(_BASE, json={"target_ref": "mock"})

    assert response.status_code == 201
    payload = response.json()
    assert payload["ok"] is True
    assert payload["suite_digest"] == _DIGEST
    assert payload["run"]["runner_name"] == RUNNER_NAME
    assert payload["created"] is True


def test_idempotent_replay_answers_200() -> None:
    response_body = ContractRunResponse(
        ok=True,
        version_ref="project/pets/1.0.0",
        suite_digest=_DIGEST,
        run=_run_record(),
        created=False,
    )
    with patch(
        "app.contract_runner_routes.run_version_contract_suite",
        return_value=response_body,
    ):
        response = client.post(
            _BASE, json={"target_ref": "mock", "idempotency_key": "ci-1"}
        )

    assert response.status_code == 200
    assert response.json()["created"] is False


def test_ok_false_answers_200() -> None:
    from app.import_source_pipeline import build_job_error

    response_body = ContractRunResponse(
        ok=False,
        version_ref="project/pets/1.0.0",
        error=build_job_error("FORMAT_MISMATCH", "no cases"),
    )
    with patch(
        "app.contract_runner_routes.run_version_contract_suite",
        return_value=response_body,
    ):
        response = client.post(_BASE, json={"target_ref": "mock"})

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["error"]["code"] == "FORMAT_MISMATCH"


def test_addressing_fault_is_http_error() -> None:
    with patch(
        "app.contract_runner_routes.run_version_contract_suite",
        side_effect=SchemaReferenceError("not found", status_code=404),
    ):
        response = client.post(_BASE, json={"target_ref": "mock"})

    assert response.status_code == 404


def test_unknown_target_is_404() -> None:
    with patch(
        "app.contract_runner_routes.run_version_contract_suite",
        side_effect=TargetValidationError(CODE_NOT_FOUND, "no such target"),
    ):
        response = client.post(_BASE, json={"target_ref": "missing"})

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == CODE_NOT_FOUND


def test_missing_target_ref_is_422() -> None:
    response = client.post(_BASE, json={})
    assert response.status_code == 422


def test_permission_denied_is_403() -> None:
    from fastapi import HTTPException

    with patch(
        "app.contract_runner_routes.enforce_permission",
        side_effect=HTTPException(status_code=403, detail="denied"),
    ):
        response = client.post(_BASE, json={"target_ref": "mock"})
    assert response.status_code == 403
