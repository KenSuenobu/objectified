"""Tests for attaching a mock attestation to verification evidence (PMR-3.2, #4749).

``app.mock_attestation`` owns the rules; these tests pin the *wiring* — that the evidence layer
actually carries them end to end:

* a submitted attestation is validated through the evidence taxonomy, so one exception type and one
  set of codes still reach every caller;
* a run against a ``mock`` environment always stores an attestation — the submitted one, or an
  explicitly missing one — while a run against staging stores none, because it has no mock to
  describe;
* the attestation is written in the run's own transaction, never as a second call that could leave
  immutable evidence half-attached;
* both exports carry it, and the DSSE route renders it for self-hosted verification tooling,
  including when what it has to say is "this was never verified".
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch
from xml.etree import ElementTree

import pytest

from app.mock_attestation import (
    CODE_BUNDLE_MUTABLE,
    MOCK_STATUS_FAILED,
    MOCK_STATUS_MISSING,
    MOCK_STATUS_VERIFIED,
    REASON_ATTESTATION_MISSING,
    REASON_CONFORMANCE_FAILED,
    MockAttestationInput,
    MockAttestationRecord,
)
from app.verification_evidence import (
    EvidenceValidationError,
    OperationResultInput,
    VerificationRunInput,
    record_from_rows,
)
from app.verification_evidence_export import export_json, export_junit
from app.verification_evidence_store import MOCK_TARGET_ENVIRONMENT, record_run
from app.verification_target import (
    NETWORK_CLASS_PUBLIC,
    TargetAuthReference,
    VerificationPolicy,
    VerificationTargetRecord,
)
from app.verification_target_store import ACTOR_KIND_API_KEY, TargetActor

_TENANT = "11111111-1111-4111-8111-111111111111"
_TARGET = "22222222-2222-4222-8222-222222222222"
_RUN = "33333333-3333-4333-8333-333333333333"
_REVISION = "55555555-5555-4555-8555-555555555555"
_SUITE_DIGEST = "sha256:" + "a" * 64
_BUNDLE_DIGEST = "sha256:" + "e" * 64
_CORPUS_DIGEST = "sha256:" + "f" * 64
_PACK_DIGEST = "sha256:" + "1" * 64
_START = datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc)
_END = _START + timedelta(seconds=5)

_RUNNER = TargetActor(user_id=None, label="ci-key", kind=ACTOR_KIND_API_KEY)


def _target(environment: str = MOCK_TARGET_ENVIRONMENT) -> VerificationTargetRecord:
    """A stored target in the given environment class."""
    return VerificationTargetRecord(
        id=_TARGET,
        tenant_id=_TENANT,
        slug="ci-mock",
        name="CI mock",
        environment=environment,
        base_url="https://mock.example.com/api",
        network_class=NETWORK_CLASS_PUBLIC,
        auth=TargetAuthReference(),
        policy=VerificationPolicy(),
        enabled=True,
    )


def _mock_block(**overrides: Any) -> MockAttestationInput:
    """A well-formed attestation over a published bundle with a passing corpus."""
    payload: Dict[str, Any] = {
        "bundle": {
            "digest": _BUNDLE_DIGEST,
            "format": "apiome.mock.bundle/v1",
            "format_version": 1,
            "signed": True,
            "api": {
                "tenant": "acme",
                "project": "petstore",
                "version": "1.0.0",
                "revision_id": _REVISION,
                "published": True,
                "protocol": "openapi",
            },
        },
        "runtime": {"name": "apiome-mock", "version": "0.9.0", "image": None},
        "conformance": {
            "corpus_format": "apiome.mock.conformance/v1",
            "corpus_version": "1.0.0",
            "corpus_digest": _CORPUS_DIGEST,
            "corpus_case_count": 30,
            "total": 30,
            "passed": 30,
            "failed": 0,
            "failed_cases": [],
        },
        "fixture_packs": [{"name": "seeded-pets", "digest": _PACK_DIGEST}],
    }
    payload.update(overrides)
    return MockAttestationInput(**payload)


def _run(**overrides: Any) -> VerificationRunInput:
    """A valid submission carrying one passing case."""
    payload: Dict[str, Any] = {
        "target_ref": "ci-mock",
        "suite_digest": _SUITE_DIGEST,
        "runner_name": "apiome-contract-runner",
        "started_at": _START,
        "finished_at": _END,
        "operations": [
            OperationResultInput(
                case_id="get-pets-example-1",
                operation_key="GET /pets",
                http_method="GET",
                http_path="/pets",
                outcome="passed",
                duration_ms=12,
            )
        ],
    }
    payload.update(overrides)
    return VerificationRunInput(**payload)


def _run_row(environment: str = MOCK_TARGET_ENVIRONMENT) -> Dict[str, Any]:
    """A stored ``verification_run`` row."""
    return {
        "id": _RUN,
        "tenant_id": _TENANT,
        "suite_digest": _SUITE_DIGEST,
        "suite_schema_version": None,
        "suite_compiler_version": None,
        "suite_case_count": None,
        "target_id": _TARGET,
        "target_slug": "ci-mock",
        "target_environment": environment,
        "target_network_class": "public",
        "target_base_url": "https://mock.example.com/api",
        "runner_name": "apiome-contract-runner",
        "runner_version": None,
        "recorded_by": None,
        "actor_label": "ci-key",
        "actor_kind": "api_key",
        "started_at": _START,
        "finished_at": _END,
        "duration_ms": 5000,
        "outcome": "passed",
        "total_cases": 1,
        "passed_cases": 1,
        "failed_cases": 0,
        "errored_cases": 0,
        "skipped_cases": 0,
        "source": {},
        "context": {},
        "idempotency_key": None,
        "created_at": _END,
    }


def _mock_row(**overrides: Any) -> Dict[str, Any]:
    """A stored ``verification_run_mock`` row."""
    row: Dict[str, Any] = {
        "status": MOCK_STATUS_VERIFIED,
        "reason_code": None,
        "reason": None,
        "bundle_digest": _BUNDLE_DIGEST,
        "bundle_format": "apiome.mock.bundle/v1",
        "bundle_format_version": 1,
        "bundle_signed": True,
        "bundle_api": {
            "tenant": "acme",
            "project": "petstore",
            "version": "1.0.0",
            "revision_id": _REVISION,
            "published": True,
            "protocol": "openapi",
        },
        "runtime_name": "apiome-mock",
        "runtime_version": "0.9.0",
        "runtime_image": None,
        "corpus_format": "apiome.mock.conformance/v1",
        "corpus_version": "1.0.0",
        "corpus_digest": _CORPUS_DIGEST,
        "corpus_case_count": 30,
        "conformance_total": 30,
        "conformance_passed": 30,
        "conformance_failed": 0,
        "failed_cases": [],
        "fixture_packs": [{"name": "seeded-pets", "digest": _PACK_DIGEST}],
    }
    row.update(overrides)
    return row


class _FakeDb:
    """A stand-in data layer that records the insert and replays a stored run."""

    def __init__(
        self,
        *,
        environment: str = MOCK_TARGET_ENVIRONMENT,
        mock_row: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Build the double.

        Args:
            environment: Environment class of the run row it replays.
            mock_row: The attestation row a read returns.
        """
        self.run_row = _run_row(environment)
        self.mock_row = mock_row
        self.inserts: List[Dict[str, Any]] = []

    def insert_verification_evidence(
        self,
        *,
        run: Dict[str, Any],
        operations: Optional[List[Dict[str, Any]]] = None,
        artifacts: Optional[List[Dict[str, Any]]] = None,
        mock: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        self.inserts.append({"run": run, "mock": mock})
        return self.run_row

    def get_verification_run(self, run_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.run_row if run_id == _RUN else None

    def get_verification_run_by_idempotency_key(
        self, tenant_id: str, idempotency_key: str
    ) -> Optional[Dict[str, Any]]:
        return None

    def list_verification_run_operations(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def list_verification_run_assertions(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def list_verification_run_artifacts(self, run_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        return []

    def get_verification_run_mock(self, run_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.mock_row


def _record_with(fake: _FakeDb, run: VerificationRunInput) -> Any:
    """Record ``run`` against ``fake``, with the target read stubbed."""
    with (
        patch("app.verification_evidence_store.db", fake),
        patch(
            "app.verification_evidence_store.get_target",
            return_value=_target(fake.run_row["target_environment"]),
        ),
    ):
        return record_run(_TENANT, run, actor=_RUNNER)


# ---------------------------------------------------------------------------------------------
# What the store writes
# ---------------------------------------------------------------------------------------------


def test_a_submitted_attestation_is_written_with_the_run_in_one_call() -> None:
    """Immutable evidence cannot be written in parts, so the mock travels with the run."""
    fake = _FakeDb(mock_row=_mock_row())
    _record_with(fake, _run(mock=_mock_block()))

    assert len(fake.inserts) == 1
    stored = fake.inserts[0]["mock"]
    assert stored["status"] == MOCK_STATUS_VERIFIED
    assert stored["bundle_digest"] == _BUNDLE_DIGEST
    assert stored["runtime_version"] == "0.9.0"
    assert stored["corpus_digest"] == _CORPUS_DIGEST
    assert [pack["digest"] for pack in stored["fixture_packs"]] == [_PACK_DIGEST]


def test_a_mock_run_with_no_attestation_records_the_absence_explicitly() -> None:
    """The criterion: a skipped mock verification is a stored fact, never silence."""
    fake = _FakeDb(mock_row=None)
    _record_with(fake, _run())

    stored = fake.inserts[0]["mock"]
    assert stored is not None
    assert stored["status"] == MOCK_STATUS_MISSING
    assert stored["reason_code"] == REASON_ATTESTATION_MISSING
    assert stored["bundle_digest"] is None
    assert stored["runtime_version"] is None


def test_a_non_mock_run_with_no_attestation_stores_nothing() -> None:
    """A staging run has no mock to describe; inventing an empty one would be noise."""
    fake = _FakeDb(environment="staging")
    _record_with(fake, _run())

    assert fake.inserts[0]["mock"] is None


def test_a_failing_corpus_is_stored_as_failed_with_its_reason() -> None:
    """A red mock is as durable as a green one — the release proof needs both."""
    fake = _FakeDb()
    block = _mock_block()
    block.conformance.total = 30
    block.conformance.passed = 28
    block.conformance.failed = 2
    block.conformance.failed_cases = ["chaos-latency", "scenario-404"]
    _record_with(fake, _run(mock=block))

    stored = fake.inserts[0]["mock"]
    assert stored["status"] == MOCK_STATUS_FAILED
    assert stored["reason_code"] == REASON_CONFORMANCE_FAILED
    assert stored["conformance_failed"] == 2
    assert stored["failed_cases"] == ["chaos-latency", "scenario-404"]


def test_a_bad_attestation_is_refused_in_the_evidence_taxonomy() -> None:
    """One exception type and one set of codes still reach the route, store, and CLI."""
    fake = _FakeDb()
    block = _mock_block()
    block.bundle.api.published = False

    with pytest.raises(EvidenceValidationError) as excinfo:
        _record_with(fake, _run(mock=block))
    assert excinfo.value.code == CODE_BUNDLE_MUTABLE
    assert fake.inserts == []  # nothing reached the database


# ---------------------------------------------------------------------------------------------
# What a read gives back
# ---------------------------------------------------------------------------------------------


def test_a_read_run_carries_its_stored_attestation() -> None:
    """The record the exporters and the route work from includes the mock."""
    record = record_from_rows(_run_row(), mock_row=_mock_row())

    assert record.mock is not None
    assert record.mock.status == MOCK_STATUS_VERIFIED
    assert record.mock.bundle is not None
    assert record.mock.bundle.digest == _BUNDLE_DIGEST


def test_a_run_with_no_stored_attestation_reads_back_as_none() -> None:
    """``null`` means "this run had nothing to do with a mock", and stays distinguishable."""
    assert record_from_rows(_run_row("staging")).mock is None


# ---------------------------------------------------------------------------------------------
# What leaves the platform
# ---------------------------------------------------------------------------------------------


def test_the_json_export_carries_the_whole_attestation() -> None:
    """Self-hosted release-proof tooling reads the export, so nothing may be dropped from it."""
    document = json.loads(export_json(record_from_rows(_run_row(), mock_row=_mock_row())))

    mock = document["mock"]
    assert mock["status"] == MOCK_STATUS_VERIFIED
    assert mock["bundle"]["digest"] == _BUNDLE_DIGEST
    assert mock["runtime"]["version"] == "0.9.0"
    assert mock["conformance"]["corpus_digest"] == _CORPUS_DIGEST
    assert mock["fixture_packs"][0]["digest"] == _PACK_DIGEST


def test_the_junit_export_surfaces_the_mock_identity_as_properties() -> None:
    """A CI viewer shows properties, so the mock behind a green run is visible without the API."""
    xml = export_junit(record_from_rows(_run_row(), mock_row=_mock_row()))
    properties = {
        element.get("name"): element.get("value")
        for element in ElementTree.fromstring(xml).iter("property")
    }

    assert properties["apiome.mock.status"] == MOCK_STATUS_VERIFIED
    assert properties["apiome.mock.bundle_digest"] == _BUNDLE_DIGEST
    assert properties["apiome.mock.runtime_version"] == "0.9.0"
    assert properties["apiome.mock.corpus_digest"] == _CORPUS_DIGEST
    assert properties["apiome.mock.conformance"] == "30/30 passed"


def test_the_junit_export_shows_an_unverified_mock_too() -> None:
    """A missing verification must be visible where a passing one would have been."""
    row = _mock_row(
        status=MOCK_STATUS_MISSING,
        reason_code=REASON_ATTESTATION_MISSING,
        reason="nothing was attached",
        bundle_digest=None,
        runtime_version=None,
        corpus_digest=None,
        conformance_total=0,
        conformance_passed=0,
    )
    xml = export_junit(record_from_rows(_run_row(), mock_row=row))
    properties = {
        element.get("name"): element.get("value")
        for element in ElementTree.fromstring(xml).iter("property")
    }

    assert properties["apiome.mock.status"] == MOCK_STATUS_MISSING
    assert properties["apiome.mock.reason_code"] == REASON_ATTESTATION_MISSING
    assert "apiome.mock.bundle_digest" not in properties


def test_a_run_without_a_mock_emits_no_mock_properties() -> None:
    """Nothing to say means nothing said; an empty property would read as a claim."""
    xml = export_junit(record_from_rows(_run_row("staging")))
    names = {element.get("name") for element in ElementTree.fromstring(xml).iter("property")}

    assert not any(str(name).startswith("apiome.mock.") for name in names)


def test_the_record_model_accepts_an_attestation_with_no_bundle() -> None:
    """The stored shape must be able to represent "not verified", or the criterion is unwritable."""
    record = MockAttestationRecord(
        status=MOCK_STATUS_MISSING, reason_code=REASON_ATTESTATION_MISSING, reason="none attached"
    )

    assert record.bundle is None
    assert record.model_dump(mode="json")["reason_code"] == REASON_ATTESTATION_MISSING
