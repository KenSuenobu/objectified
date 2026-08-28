"""Tests for the release-proof mock attestation contract (PMR-3.2, #4749).

``app.mock_attestation`` is the pure rule set behind the mock block a verification run carries.
These tests pin the four rules the acceptance criteria turn into refusals:

* **only immutable digests are linked** — a malformed digest, or one naming an unpublished
  revision, is refused rather than stored;
* **a verification names its runtime and its corpus** — a version that does not parse, one outside
  the bundle format's runtime window, or a conformance result with no corpus digest, is refused;
* **the status is derived** — it comes from the conformance counts, and a contradicting declaration
  is refused, so no upload records a verified mock over a red corpus;
* **a missing or failed verification is explicit** — every non-verified status carries a reason
  code, and a run that attached nothing gets a *recorded* absence rather than silence.

The statement tests pin what self-hosted tooling actually consumes: an in-toto Statement v1 whose
subject is the bundle, in a DSSE envelope that verifies with the shared attestation secret alone.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

import pytest

from app.lint_attestation import STATEMENT_TYPE, verify_attestation_envelope
from app.mock_attestation import (
    ATTESTATION_KEY_ID,
    CODE_BUNDLE_DIGEST_INVALID,
    CODE_BUNDLE_MUTABLE,
    CODE_CONFORMANCE_COUNTS_MISMATCH,
    CODE_CORPUS_UNIDENTIFIED,
    CODE_FIXTURE_DIGEST_INVALID,
    CODE_RUNTIME_INCOMPATIBLE,
    CODE_RUNTIME_VERSION_INVALID,
    CODE_STATUS_INVALID,
    CODE_STATUS_MISMATCH,
    MOCK_PREDICATE_TYPE,
    MOCK_STATUS_FAILED,
    MOCK_STATUS_MISSING,
    MOCK_STATUS_VERIFIED,
    REASON_ATTESTATION_MISSING,
    REASON_CONFORMANCE_FAILED,
    REASON_CONFORMANCE_MISSING,
    MockAttestationError,
    MockAttestationInput,
    attestation_from_row,
    build_mock_attestation_statement,
    derive_mock_status,
    missing_mock_attestation,
    mock_attestation_envelope,
    validate_mock_attestation,
)

_BUNDLE_DIGEST = "sha256:" + "a" * 64
_CORPUS_DIGEST = "sha256:" + "b" * 64
_PACK_DIGEST = "sha256:" + "c" * 64
_REVISION = "33333333-3333-4333-8333-333333333333"
_STAMP = datetime(2026, 8, 27, 9, 0, 0, tzinfo=timezone.utc)


def _conformance(**overrides: Any) -> Dict[str, Any]:
    """A passing conformance result."""
    payload: Dict[str, Any] = {
        "corpus_format": "apiome.mock.conformance/v1",
        "corpus_version": "1.0.0",
        "corpus_digest": _CORPUS_DIGEST,
        "corpus_case_count": 30,
        "total": 30,
        "passed": 30,
        "failed": 0,
        "failed_cases": [],
    }
    payload.update(overrides)
    return payload


def _attestation(**overrides: Any) -> MockAttestationInput:
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
        "runtime": {"name": "apiome-mock", "version": "0.9.0", "image": "ghcr.io/x@sha256:beef"},
        "conformance": _conformance(),
        "fixture_packs": [
            {
                "name": "seeded-pets",
                "digest": _PACK_DIGEST,
                "format": "apiome.mock.fixture-pack/v1",
                "format_version": 1,
                "origin": "authored",
                "redaction_status": "not-applicable",
            }
        ],
    }
    payload.update(overrides)
    return MockAttestationInput(**payload)


def _run_context() -> Dict[str, Any]:
    """The verification-run block a statement embeds."""
    return {
        "id": "44444444-4444-4444-8444-444444444444",
        "suiteDigest": "sha256:" + "d" * 64,
        "outcome": "passed",
        "targetSlug": "ci-mock",
        "targetEnvironment": "mock",
    }


# ---------------------------------------------------------------------------------------------
# Only immutable digests are linked
# ---------------------------------------------------------------------------------------------


def test_a_verified_attestation_keeps_every_identity_it_was_given() -> None:
    """The happy path stores all four identities the issue asks a release proof to carry."""
    record = validate_mock_attestation(_attestation())

    assert record.status == MOCK_STATUS_VERIFIED
    assert record.reason_code is None
    assert record.bundle is not None and record.bundle.digest == _BUNDLE_DIGEST
    assert record.runtime is not None and record.runtime.version == "0.9.0"
    assert record.conformance is not None
    assert record.conformance.corpus_digest == _CORPUS_DIGEST
    assert [pack.digest for pack in record.fixture_packs] == [_PACK_DIGEST]


@pytest.mark.parametrize(
    "digest",
    ["", "abc", "sha256:" + "a" * 63, "sha1:" + "a" * 40, "SHA256:" + "A" * 64],
)
def test_a_bundle_digest_that_is_not_sha256_is_refused(digest: str) -> None:
    """A release proof links digests, not names; anything else cannot identify a bundle later."""
    attestation = _attestation()
    attestation.bundle.digest = digest

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_BUNDLE_DIGEST_INVALID


def test_an_unpublished_revision_cannot_be_attested() -> None:
    """A draft revision can still change, so a digest naming one proves nothing afterwards."""
    attestation = _attestation()
    attestation.bundle.api.published = False

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_BUNDLE_MUTABLE


def test_a_bundle_with_no_revision_id_cannot_be_attested() -> None:
    """Without a revision id the digest names no fixed revision, so it is not linkable."""
    attestation = _attestation()
    attestation.bundle.api.revision_id = "  "

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_BUNDLE_MUTABLE


def test_a_fixture_pack_digest_is_held_to_the_same_shape() -> None:
    """Fixture packs are linked the same way the bundle is, or the seed data is unidentifiable."""
    attestation = _attestation()
    attestation.fixture_packs[0].digest = "not-a-digest"

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_FIXTURE_DIGEST_INVALID


# ---------------------------------------------------------------------------------------------
# The runtime and the corpus must be identified
# ---------------------------------------------------------------------------------------------


def test_a_runtime_version_that_is_not_semantic_is_refused() -> None:
    """"It passed" is unreproducible without knowing which runtime produced the behavior."""
    attestation = _attestation()
    attestation.runtime.version = "latest"

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_RUNTIME_VERSION_INVALID


@pytest.mark.parametrize("version", ["0.1.0", "1.0.0", "2.3.4"])
def test_a_runtime_outside_the_bundle_format_window_is_refused(version: str) -> None:
    """The same window PMR-1.1 pins on a bundle applies to the runtime an attestation names."""
    attestation = _attestation()
    attestation.runtime.version = version

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_RUNTIME_INCOMPATIBLE


def test_a_conformance_result_without_a_corpus_digest_is_refused() -> None:
    """A pass with no corpus behind it is a claim, not a result."""
    attestation = _attestation(conformance=_conformance(corpus_digest="sha256:short"))

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_CORPUS_UNIDENTIFIED


def test_conformance_counts_that_do_not_sum_are_refused() -> None:
    """Counts that contradict each other cannot be compared across runs."""
    attestation = _attestation(conformance=_conformance(total=30, passed=28, failed=0))

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_CONFORMANCE_COUNTS_MISMATCH


def test_a_failure_that_names_no_case_is_refused() -> None:
    """A failing corpus with no case named cannot be acted on by whoever reads the proof."""
    attestation = _attestation(
        conformance=_conformance(total=30, passed=29, failed=1, failed_cases=[])
    )

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_CONFORMANCE_COUNTS_MISMATCH


# ---------------------------------------------------------------------------------------------
# The status is derived, never asserted
# ---------------------------------------------------------------------------------------------


def test_a_failing_corpus_derives_a_failed_status_with_its_reason() -> None:
    """A red corpus is recorded as failed, naming the cases, whatever the runner declared."""
    record = validate_mock_attestation(
        _attestation(
            conformance=_conformance(
                total=30, passed=28, failed=2, failed_cases=["chaos-latency", "scenario-404"]
            )
        )
    )

    assert record.status == MOCK_STATUS_FAILED
    assert record.reason_code == REASON_CONFORMANCE_FAILED
    assert "chaos-latency" in (record.reason or "")


def test_no_conformance_result_derives_an_explicitly_missing_status() -> None:
    """A bundle that was never exercised says so, rather than looking like a pass."""
    record = validate_mock_attestation(_attestation(conformance=None))

    assert record.status == MOCK_STATUS_MISSING
    assert record.reason_code == REASON_CONFORMANCE_MISSING
    assert record.bundle is not None  # the bundle is still identified


def test_an_empty_corpus_run_proves_nothing_and_says_so() -> None:
    """Zero cases executed is not a pass; a gate must be able to tell the difference."""
    record = validate_mock_attestation(
        _attestation(conformance=_conformance(total=0, passed=0, failed=0, corpus_case_count=0))
    )

    assert record.status == MOCK_STATUS_MISSING
    assert record.reason_code == REASON_CONFORMANCE_MISSING


def test_a_declared_status_that_contradicts_the_result_is_refused() -> None:
    """No upload can record a verified mock over a red corpus."""
    attestation = _attestation(
        conformance=_conformance(total=30, passed=29, failed=1, failed_cases=["scenario-404"]),
        status=MOCK_STATUS_VERIFIED,
    )

    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(attestation)
    assert excinfo.value.code == CODE_STATUS_MISMATCH


def test_a_declared_status_that_agrees_is_accepted() -> None:
    """A runner that states the status it derived is not punished for saying so."""
    record = validate_mock_attestation(_attestation(status=MOCK_STATUS_VERIFIED))
    assert record.status == MOCK_STATUS_VERIFIED


@pytest.mark.parametrize(
    "field,value",
    [("status", "green"), ("reason_code", "because-i-said-so")],
)
def test_values_outside_the_closed_vocabularies_are_refused(field: str, value: str) -> None:
    """Both vocabularies are closed so a gate branches on codes rather than parsing prose."""
    with pytest.raises(MockAttestationError) as excinfo:
        validate_mock_attestation(_attestation(**{field: value}))
    assert excinfo.value.code == CODE_STATUS_INVALID


def test_derive_mock_status_states_a_reason_for_every_non_verified_status() -> None:
    """The derivation never produces a bare unexplained status."""
    for conformance in (None, _conformance(total=0, passed=0, failed=0)):
        payload = None
        if conformance is not None:
            payload = _attestation(conformance=conformance).conformance
        status, code, reason = derive_mock_status(payload)
        assert status != MOCK_STATUS_VERIFIED
        assert code is not None and reason


# ---------------------------------------------------------------------------------------------
# A missing attestation is recorded, not omitted
# ---------------------------------------------------------------------------------------------


def test_a_missing_attestation_is_a_record_rather_than_an_absence() -> None:
    """The whole point: "nothing was attested" is itself evidence, with a code to branch on."""
    record = missing_mock_attestation()

    assert record.status == MOCK_STATUS_MISSING
    assert record.reason_code == REASON_ATTESTATION_MISSING
    assert record.bundle is None and record.runtime is None
    assert record.reason


def test_a_supplied_reason_is_scrubbed_before_it_is_stored() -> None:
    """A runner's explanation may quote what it saw, and what it saw may be a credential."""
    record = missing_mock_attestation(
        "runner aborted, Authorization: Bearer sk-live-0123456789abcdef0123456789abcdef"
    )
    assert "sk-live-0123456789abcdef0123456789abcdef" not in (record.reason or "")


# ---------------------------------------------------------------------------------------------
# Storage round trip
# ---------------------------------------------------------------------------------------------


def test_a_stored_row_reads_back_as_the_record_that_wrote_it() -> None:
    """The row adaptation is lossless for everything a release proof consumes."""
    row = {
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
        "runtime_image": "ghcr.io/x@sha256:beef",
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

    record = attestation_from_row(row)

    assert record.status == MOCK_STATUS_VERIFIED
    assert record.bundle is not None and record.bundle.api.revision_id == _REVISION
    assert record.runtime is not None and record.runtime.image == "ghcr.io/x@sha256:beef"
    assert record.conformance is not None and record.conformance.corpus_case_count == 30
    assert record.fixture_packs[0].digest == _PACK_DIGEST


def test_a_row_recording_an_absent_attestation_reads_back_with_no_bundle() -> None:
    """An explicitly-missing row must not be rebuilt into one that names a bundle."""
    record = attestation_from_row(
        {
            "status": MOCK_STATUS_MISSING,
            "reason_code": REASON_ATTESTATION_MISSING,
            "reason": "nothing was attached",
            "bundle_digest": None,
            "runtime_version": None,
            "corpus_digest": None,
            "fixture_packs": [],
        }
    )

    assert record.bundle is None
    assert record.runtime is None
    assert record.conformance is None


# ---------------------------------------------------------------------------------------------
# The signed statement self-hosted tooling consumes
# ---------------------------------------------------------------------------------------------


def test_the_statement_names_the_bundle_as_its_subject() -> None:
    """A holder of the bundle file ties it to the statement with ``sha256sum`` alone."""
    record = validate_mock_attestation(_attestation())
    statement = build_mock_attestation_statement(
        record, run=_run_context(), generated_at=_STAMP
    )

    assert statement["_type"] == STATEMENT_TYPE
    assert statement["predicateType"] == MOCK_PREDICATE_TYPE
    assert statement["subject"] == [
        {"name": "acme/petstore/1.0.0", "digest": {"sha256": "a" * 64}}
    ]
    predicate = statement["predicate"]
    assert predicate["status"] == MOCK_STATUS_VERIFIED
    assert predicate["runtime"]["version"] == "0.9.0"
    assert predicate["conformance"]["corpus_digest"] == _CORPUS_DIGEST
    assert predicate["fixturePacks"][0]["digest"] == _PACK_DIGEST
    assert predicate["verificationRun"]["targetEnvironment"] == "mock"
    assert predicate["generatedAt"] == _STAMP.isoformat()


def test_a_missing_verification_is_still_attested_with_no_subject() -> None:
    """Silence is never the answer: the absence is signed too, it just has nothing to name."""
    statement = build_mock_attestation_statement(
        missing_mock_attestation(), run=_run_context(), generated_at=_STAMP
    )

    assert statement["subject"] == []
    assert statement["predicate"]["status"] == MOCK_STATUS_MISSING
    assert statement["predicate"]["reasonCode"] == REASON_ATTESTATION_MISSING


def test_the_envelope_verifies_with_the_shared_secret_and_names_the_shared_key() -> None:
    """One verifier covers all three attestation flavours, so no new CI configuration is needed."""
    record = validate_mock_attestation(_attestation())
    statement = build_mock_attestation_statement(record, run=_run_context(), generated_at=_STAMP)

    envelope = mock_attestation_envelope(statement, secret="shared-secret")

    assert envelope["signatures"][0]["keyid"] == ATTESTATION_KEY_ID
    assert verify_attestation_envelope(envelope, "shared-secret") is True
    assert verify_attestation_envelope(envelope, "other-secret") is False


def test_without_a_configured_secret_the_envelope_is_well_formed_but_unsigned() -> None:
    """An unsigned attestation is still a readable document; it is simply not verifiable."""
    statement = build_mock_attestation_statement(
        missing_mock_attestation(), run=_run_context(), generated_at=_STAMP
    )

    envelope = mock_attestation_envelope(statement, secret=None)

    assert envelope["signatures"] == []
    assert envelope["payload"]


def test_a_statement_is_byte_stable_for_the_same_inputs() -> None:
    """Two renderings of one stored attestation must not differ, or a diff is meaningless."""
    record = validate_mock_attestation(_attestation())
    first = mock_attestation_envelope(
        build_mock_attestation_statement(record, run=_run_context(), generated_at=_STAMP),
        secret="shared-secret",
    )
    second = mock_attestation_envelope(
        build_mock_attestation_statement(record, run=_run_context(), generated_at=_STAMP),
        secret="shared-secret",
    )

    assert first == second
