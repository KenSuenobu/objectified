"""Service-level tests for the HTTP contract runner — ECA-2.1 (#4732).

Asserts orchestration: compile → resolve → run → **always** ``record_run`` for a successful
execution, and that auth/empty-suite failures answer ``ok=false`` without inventing evidence.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx

from app.contract_runner import RUNNER_NAME
from app.contract_runner_service import ContractRunRequest, run_version_contract_suite
from app.contract_suite import (
    OUTCOME_SUCCESS,
    ContractCase,
    ContractCaseExpectation,
    ContractCaseRequest,
    ContractSuiteManifest,
    ContractSuiteOptions,
    SuiteApiInfo,
)
from app.contract_suite_service import ContractSuiteResponse
from app.import_source_pipeline import build_job_error
from app.verification_evidence import VerificationRunRecord
from app.verification_evidence_store import RecordedRun, TargetActor
from app.verification_target import (
    NETWORK_CLASS_PRIVATE,
    ResolvedTarget,
    TargetAuthReference,
    VerificationPolicy,
)

_DIGEST = "sha256:" + "b" * 64
_START = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
_ACTOR = TargetActor(user_id="u1", kind="user")


def _manifest() -> ContractSuiteManifest:
    return ContractSuiteManifest(
        digest=_DIGEST,
        options=ContractSuiteOptions(),
        api=SuiteApiInfo(
            name="pets",
            namespace="pets",
            title="Pets",
            version="1.0.0",
            format="openapi",
            paradigm="rest",
            protocol="http",
        ),
        cases=[
            ContractCase(
                case_id="get-pets",
                operation_key="GET /pets",
                operation_name="listPets",
                source="declared_example",
                title="get pets",
                description="list",
                synthetic=False,
                request=ContractCaseRequest(
                    method="GET", path_template="/pets", path="/pets"
                ),
                expect=ContractCaseExpectation(
                    outcome=OUTCOME_SUCCESS,
                    status_codes=["200"],
                    status_declared=True,
                    response_schema_id="type:Pet",
                    reason="ok",
                ),
            )
        ],
        schemas={
            "type:Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            }
        },
    )


def _resolved() -> ResolvedTarget:
    return ResolvedTarget(
        target_id="22222222-2222-4222-8222-222222222222",
        slug="mock",
        name="Mock",
        environment="mock",
        network_class=NETWORK_CLASS_PRIVATE,
        base_url="http://mock.test/acme/pets/1.0.0",
        policy=VerificationPolicy(retry_attempts=0),
        auth=TargetAuthReference(),
        resolved_at=_START,
    )


def _recorded_run() -> VerificationRunRecord:
    return VerificationRunRecord(
        id="33333333-3333-4333-8333-333333333333",
        tenant_id="t1",
        suite_digest=_DIGEST,
        target_id="22222222-2222-4222-8222-222222222222",
        target_slug="mock",
        target_environment="mock",
        target_network_class="private",
        target_base_url="http://mock.test/acme/pets/1.0.0",
        runner_name=RUNNER_NAME,
        started_at=_START,
        finished_at=_START + timedelta(seconds=1),
        duration_ms=1000,
        outcome="passed",
        counts={"total": 1, "passed": 1, "failed": 0, "errored": 0, "skipped": 0},
        operations=[],
    )


def test_successful_run_always_records_evidence() -> None:
    """Acceptance: produces ECA-1.3 evidence for every execution."""
    manifest = _manifest()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    with (
        patch(
            "app.contract_runner_service.compile_version_contract_suite",
            return_value=ContractSuiteResponse(
                ok=True, version_ref="project/pets/1.0.0", manifest=manifest
            ),
        ),
        patch(
            "app.contract_runner_service.resolve_target",
            return_value=_resolved(),
        ) as resolve,
        patch(
            "app.contract_runner_service.record_run",
            return_value=RecordedRun(record=_recorded_run(), created=True),
        ) as recorded,
        patch(
            "app.contract_runner.build_guarded_client",
            return_value=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
    ):
        result = run_version_contract_suite(
            "project/pets/1.0.0",
            ContractRunRequest(target_ref="mock", context={"commit": "abc"}),
            tenant_id="t1",
            actor=_ACTOR,
        )

    assert result.ok is True
    assert result.suite_digest == _DIGEST
    assert result.created is True
    assert result.run is not None
    assert result.run.runner_name == RUNNER_NAME
    resolve.assert_called_once()
    recorded.assert_called_once()
    run_input = recorded.call_args.args[1]
    assert run_input.suite_digest == _DIGEST
    assert run_input.runner_name == RUNNER_NAME
    assert run_input.context == {"commit": "abc"}
    assert len(run_input.operations) == 1
    assert run_input.operations[0].outcome == "passed"


def test_empty_suite_does_not_record() -> None:
    empty = _manifest()
    empty = empty.model_copy(update={"cases": []})

    with (
        patch(
            "app.contract_runner_service.compile_version_contract_suite",
            return_value=ContractSuiteResponse(
                ok=True, version_ref="project/pets/1.0.0", manifest=empty
            ),
        ),
        patch("app.contract_runner_service.record_run") as recorded,
    ):
        result = run_version_contract_suite(
            "project/pets/1.0.0",
            ContractRunRequest(target_ref="mock"),
            tenant_id="t1",
            actor=_ACTOR,
        )

    assert result.ok is False
    assert result.error is not None
    recorded.assert_not_called()


def test_compile_failure_propagates_error() -> None:
    with (
        patch(
            "app.contract_runner_service.compile_version_contract_suite",
            return_value=ContractSuiteResponse(
                ok=False,
                version_ref="project/pets/1.0.0",
                error=build_job_error(
                    "FORMAT_MISMATCH",
                    "no operations",
                ),
            ),
        ),
        patch("app.contract_runner_service.record_run") as recorded,
    ):
        result = run_version_contract_suite(
            "project/pets/1.0.0",
            ContractRunRequest(target_ref="mock"),
            tenant_id="t1",
            actor=_ACTOR,
        )

    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "FORMAT_MISMATCH"
    recorded.assert_not_called()
