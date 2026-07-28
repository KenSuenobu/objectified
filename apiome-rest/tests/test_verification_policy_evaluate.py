"""Evidence-backed policy evaluator — ECA-3.1 (#4734).

Covers the pure evaluate matrix:

* default / empty policy passes;
* missing / stale / wrong-network digest fails the right gate;
* breaking ignore / warn / block;
* purpose not covered skips gates and passes.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.verification_policy import (
    DEFAULT_POLICY,
    VerificationPolicy,
    canonical_policy_body,
    policy_applies_to_purpose,
    policy_content_fingerprint,
    policy_from_row,
    validate_policy_body,
)
from app.verification_policy_evaluate import (
    EvidenceRunSummary,
    evaluate_verification_policy,
)

DIGEST_A = "sha256:" + ("a" * 64)
DIGEST_B = "sha256:" + ("b" * 64)
RUN_1 = "11111111-1111-1111-1111-111111111111"
RUN_2 = "22222222-2222-2222-2222-222222222222"
NOW = datetime(2026, 7, 27, 20, 0, 0, tzinfo=timezone.utc)


def _policy(**overrides) -> VerificationPolicy:
    body = {
        "required_suite_digests": (),
        "max_evidence_age_seconds": None,
        "required_target_network_class": None,
        "purpose": "both",
        "breaking_change_action": "warn",
        "enforcement": "advisory",
        "is_default": False,
        "policy_version_id": "pppppppp-pppp-pppp-pppp-pppppppppppp",
        "version_number": 1,
    }
    body.update(overrides)
    digests = body["required_suite_digests"]
    fingerprint = policy_content_fingerprint(
        canonical_policy_body(
            required_suite_digests=digests,
            max_evidence_age_seconds=body["max_evidence_age_seconds"],
            required_target_network_class=body["required_target_network_class"],
            purpose=body["purpose"],
            breaking_change_action=body["breaking_change_action"],
            enforcement=body["enforcement"],
        )
    )
    return VerificationPolicy(content_fingerprint=fingerprint, **body)


def _run(
    *,
    run_id: str = RUN_1,
    digest: str = DIGEST_A,
    outcome: str = "passed",
    network: str = "public",
    age_seconds: int = 60,
) -> EvidenceRunSummary:
    finished = NOW - timedelta(seconds=age_seconds)
    return EvidenceRunSummary(
        run_id=run_id,
        suite_digest=digest,
        outcome=outcome,
        target_network_class=network,
        finished_at=finished,
        created_at=finished,
    )


# ---------------------------------------------------------------------------
# Policy body helpers
# ---------------------------------------------------------------------------


def test_default_policy_is_advisory_with_no_digests():
    assert DEFAULT_POLICY.is_default is True
    assert DEFAULT_POLICY.enforcement == "advisory"
    assert DEFAULT_POLICY.required_suite_digests == ()
    assert DEFAULT_POLICY.breaking_change_action == "warn"
    assert DEFAULT_POLICY.content_fingerprint


def test_validate_rejects_bad_digest_and_network():
    errors = validate_policy_body(
        required_suite_digests=["not-a-digest"],
        required_target_network_class="vpn",
        purpose="nope",
        breaking_change_action="maybe",
        enforcement="strict",
    )
    assert any("sha256" in e for e in errors)
    assert any("network_class" in e for e in errors)
    assert any("purpose" in e for e in errors)


def test_policy_from_row_and_fingerprint_stable():
    digests = [DIGEST_B, DIGEST_A]
    body = canonical_policy_body(
        required_suite_digests=digests,
        max_evidence_age_seconds=3600,
        required_target_network_class="private",
        purpose="publish",
        breaking_change_action="block",
        enforcement="block",
    )
    # Digests sorted in canonical body.
    assert body["requiredSuiteDigests"] == [DIGEST_A, DIGEST_B]
    fp = policy_content_fingerprint(body)
    row = {
        "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "version_number": 2,
        "content_fingerprint": fp,
        "required_suite_digests": digests,
        "max_evidence_age_seconds": 3600,
        "required_target_network_class": "private",
        "purpose": "publish",
        "breaking_change_action": "block",
        "enforcement": "block",
    }
    policy = policy_from_row(row)
    assert policy.is_default is False
    assert policy.required_suite_digests == (DIGEST_B, DIGEST_A) or set(
        policy.required_suite_digests
    ) == {DIGEST_A, DIGEST_B}
    assert policy.content_fingerprint == fp
    assert policy_applies_to_purpose(policy, "publish") is True
    assert policy_applies_to_purpose(policy, "deploy") is False


# ---------------------------------------------------------------------------
# Evaluate matrix
# ---------------------------------------------------------------------------


def test_empty_policy_passes_with_no_evidence():
    decision = evaluate_verification_policy(
        DEFAULT_POLICY,
        purpose="publish",
        evidence_runs=[],
        now=NOW,
    )
    assert decision.passed is True
    assert decision.skipped is False
    assert decision.evidence_run_ids == ()
    assert {g.gate for g in decision.gate_results} >= {
        "suite_digest",
        "evidence_age",
        "breaking_change",
    }


def test_missing_digest_fails_suite_gate():
    policy = _policy(required_suite_digests=(DIGEST_A,), enforcement="block")
    decision = evaluate_verification_policy(
        policy, purpose="publish", evidence_runs=[], now=NOW
    )
    assert decision.passed is False
    suite = next(g for g in decision.gate_results if g.gate == "suite_digest")
    assert suite.passed is False
    assert decision.evidence_run_ids == ()


def test_passing_digest_cites_run_id():
    policy = _policy(required_suite_digests=(DIGEST_A,), max_evidence_age_seconds=3600)
    decision = evaluate_verification_policy(
        policy,
        purpose="deploy",
        evidence_runs=[_run(age_seconds=10)],
        now=NOW,
    )
    assert decision.passed is True
    assert decision.evidence_run_ids == (RUN_1,)
    age = next(g for g in decision.gate_results if g.gate == "evidence_age")
    assert age.passed is True


def test_stale_evidence_fails_age_gate():
    policy = _policy(required_suite_digests=(DIGEST_A,), max_evidence_age_seconds=30)
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[_run(age_seconds=120)],
        now=NOW,
    )
    assert decision.passed is False
    suite = next(g for g in decision.gate_results if g.gate == "suite_digest")
    age = next(g for g in decision.gate_results if g.gate == "evidence_age")
    assert suite.passed is True
    assert age.passed is False
    assert decision.evidence_run_ids == (RUN_1,)


def test_wrong_network_class_fails_digest_gate():
    policy = _policy(
        required_suite_digests=(DIGEST_A,),
        required_target_network_class="private",
    )
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[_run(network="public")],
        now=NOW,
    )
    assert decision.passed is False
    suite = next(g for g in decision.gate_results if g.gate == "suite_digest")
    assert suite.passed is False


def test_breaking_warn_passes_with_warning():
    policy = _policy(breaking_change_action="warn")
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[],
        changelog_max_severity="breaking",
        changelog_id="cccccccc-cccc-cccc-cccc-cccccccccccc",
        now=NOW,
    )
    assert decision.passed is True
    assert any(w["kind"] == "breaking_change" for w in decision.warnings)
    breaking = next(g for g in decision.gate_results if g.gate == "breaking_change")
    assert breaking.passed is True
    assert breaking.action == "warn"
    assert breaking.detail.get("consumerAware") is False


def test_breaking_block_fails():
    policy = _policy(breaking_change_action="block", enforcement="block")
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[],
        changelog_max_severity="breaking",
        now=NOW,
    )
    assert decision.passed is False
    breaking = next(g for g in decision.gate_results if g.gate == "breaking_change")
    assert breaking.passed is False
    assert breaking.action == "block"


def test_breaking_ignore_skips_severity():
    policy = _policy(breaking_change_action="ignore")
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[],
        changelog_max_severity="breaking",
        now=NOW,
    )
    assert decision.passed is True
    breaking = next(g for g in decision.gate_results if g.gate == "breaking_change")
    assert breaking.action == "ignore"
    assert decision.warnings == ()


def test_purpose_not_covered_skips():
    policy = _policy(purpose="deploy")
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[],
        changelog_max_severity="breaking",
        now=NOW,
    )
    assert decision.passed is True
    assert decision.skipped is True
    assert decision.gate_results == ()


def test_failed_outcome_does_not_satisfy_digest():
    policy = _policy(required_suite_digests=(DIGEST_A,))
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[_run(outcome="failed")],
        now=NOW,
    )
    assert decision.passed is False


def test_newest_passing_run_is_cited():
    policy = _policy(required_suite_digests=(DIGEST_A,), max_evidence_age_seconds=10_000)
    older = _run(run_id=RUN_1, age_seconds=500)
    newer = _run(run_id=RUN_2, age_seconds=10)
    decision = evaluate_verification_policy(
        policy,
        purpose="publish",
        evidence_runs=[older, newer],
        now=NOW,
    )
    assert decision.evidence_run_ids == (RUN_2,)


def test_as_dict_shape():
    policy = _policy(required_suite_digests=(DIGEST_A,))
    decision = evaluate_verification_policy(
        policy, purpose="publish", evidence_runs=[_run()], now=NOW
    )
    payload = decision.as_dict()
    assert payload["passed"] is True
    assert payload["purpose"] == "publish"
    assert isinstance(payload["gate_results"], list)
    assert payload["evidence_run_ids"] == [RUN_1]


def test_invalid_purpose_raises():
    with pytest.raises(ValueError, match="purpose"):
        evaluate_verification_policy(DEFAULT_POLICY, purpose="ship", evidence_runs=[])
