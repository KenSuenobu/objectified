"""Pure evidence-backed policy evaluation — ECA-3.1 (#4734).

Turns a pinned :class:`~app.verification_policy.VerificationPolicy`, a list of ECA-1.3
passing-run summaries, and an optional CTG-3.1 changelog severity into one decision that
cites exact evidence run IDs. No database or network access — callers load inputs and
persist the result.

Gates
-----
* ``suite_digest`` — each required digest must have a newest passing run matching the
  optional network-class filter.
* ``evidence_age`` — that cited run must be no older than ``max_evidence_age_seconds``.
* ``breaking_change`` — whole-spec ``version_changelogs.max_severity == breaking`` under
  the policy's ``ignore`` / ``warn`` / ``block`` posture. **Not consumer-aware** (#4479).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .verification_policy import (
    PURPOSE_DEPLOY,
    PURPOSE_PUBLISH,
    VerificationPolicy,
    policy_applies_to_purpose,
)

__all__ = [
    "EvidenceRunSummary",
    "GateResult",
    "PolicyDecision",
    "evaluate_verification_policy",
]

GATE_SUITE_DIGEST = "suite_digest"
GATE_EVIDENCE_AGE = "evidence_age"
GATE_BREAKING_CHANGE = "breaking_change"


@dataclass(frozen=True)
class EvidenceRunSummary:
    """Minimal evidence fields the evaluator needs for one verification_run.

    Attributes:
        run_id: The ECA-1.3 run id.
        suite_digest: The executed suite digest.
        outcome: Run outcome (``passed`` is the only green outcome).
        target_network_class: Snapshotted network class.
        finished_at: When the run finished (preferred for age), or created_at.
        created_at: When the run was recorded.
    """

    run_id: str
    suite_digest: str
    outcome: str
    target_network_class: str = "public"
    finished_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


@dataclass(frozen=True)
class GateResult:
    """One named gate's pass/fail with machine-readable detail.

    Attributes:
        gate: Gate name (``suite_digest``, ``evidence_age``, ``breaking_change``).
        passed: Whether the gate passed.
        detail: Structured explanation (digests, ages, severities, cited ids).
        action: Optional action taken (e.g. breaking ``warn`` / ``block``).
    """

    gate: str
    passed: bool
    detail: Dict[str, Any] = field(default_factory=dict)
    action: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for JSON persistence / API responses."""
        out: Dict[str, Any] = {
            "gate": self.gate,
            "passed": self.passed,
            "detail": dict(self.detail),
        }
        if self.action is not None:
            out["action"] = self.action
        return out


@dataclass(frozen=True)
class PolicyDecision:
    """Auditable evaluate result shared by API, publish precheck, and dashboard.

    Attributes:
        passed: True when every applicable gate passed (warnings do not fail).
        enforcement: Policy enforcement at evaluation time.
        policy_version_id: Pinned policy id, or ``None`` for the default.
        policy_content_fingerprint: Fingerprint of the evaluated body.
        gate_results: Per-gate results in evaluation order.
        evidence_run_ids: Exact run ids the decision relied on.
        warnings: Non-blocking notices (e.g. breaking warn).
        purpose: Evaluate purpose (``publish`` or ``deploy``).
        skipped: True when the policy does not cover this purpose (always passes).
    """

    passed: bool
    enforcement: str
    policy_version_id: Optional[str]
    policy_content_fingerprint: str
    gate_results: Tuple[GateResult, ...]
    evidence_run_ids: Tuple[str, ...]
    warnings: Tuple[Dict[str, Any], ...]
    purpose: str
    skipped: bool = False

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for JSON persistence / API responses (snake_case keys)."""
        return {
            "passed": self.passed,
            "enforcement": self.enforcement,
            "policy_version_id": self.policy_version_id,
            "policy_content_fingerprint": self.policy_content_fingerprint,
            "gate_results": [g.as_dict() for g in self.gate_results],
            "evidence_run_ids": list(self.evidence_run_ids),
            "warnings": [dict(w) for w in self.warnings],
            "purpose": self.purpose,
            "skipped": self.skipped,
        }


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Normalize a datetime to aware UTC, or return ``None``."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _run_timestamp(run: EvidenceRunSummary) -> Optional[datetime]:
    """Prefer finished_at, fall back to created_at."""
    return _as_utc(run.finished_at) or _as_utc(run.created_at)


def _newest_passing_for_digest(
    runs: Sequence[EvidenceRunSummary],
    *,
    digest: str,
    network_class: Optional[str],
) -> Optional[EvidenceRunSummary]:
    """Return the newest passing run for ``digest``, optionally filtered by network class."""
    matches: List[Tuple[datetime, EvidenceRunSummary]] = []
    for run in runs:
        if run.suite_digest != digest:
            continue
        if run.outcome != "passed":
            continue
        if network_class and run.target_network_class != network_class:
            continue
        stamp = _run_timestamp(run)
        if stamp is None:
            continue
        matches.append((stamp, run))
    if not matches:
        # Still accept a matching run with no timestamp (age gate will fail separately).
        for run in runs:
            if (
                run.suite_digest == digest
                and run.outcome == "passed"
                and (not network_class or run.target_network_class == network_class)
            ):
                return run
        return None
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]


def evaluate_verification_policy(
    policy: VerificationPolicy,
    *,
    purpose: str,
    evidence_runs: Sequence[EvidenceRunSummary],
    changelog_max_severity: Optional[str] = None,
    changelog_id: Optional[str] = None,
    changelog_status: Optional[str] = None,
    now: Optional[datetime] = None,
) -> PolicyDecision:
    """Evaluate ``policy`` against evidence and whole-spec breaking severity.

    Args:
        policy: The policy in force (or the documented default).
        purpose: ``publish`` or ``deploy``.
        evidence_runs: Candidate ECA-1.3 runs (caller may pre-filter by tenant).
        changelog_max_severity: ``breaking`` / ``non-breaking`` / ``docs-only``, or ``None``.
        changelog_id: Optional changelog row id for audit detail.
        changelog_status: Optional changelog status (``ready`` / ``initial`` / ``failed``).
        now: Evaluation clock (defaults to UTC now); injectable for tests.

    Returns:
        A :class:`PolicyDecision`. When the policy does not cover ``purpose``, returns a
        skipped passing decision with empty gates.

    Raises:
        ValueError: When ``purpose`` is not ``publish`` or ``deploy``.
    """
    if purpose not in (PURPOSE_PUBLISH, PURPOSE_DEPLOY):
        raise ValueError("purpose must be 'publish' or 'deploy'")

    clock = _as_utc(now) or datetime.now(timezone.utc)
    fingerprint = policy.content_fingerprint
    common = dict(
        enforcement=policy.enforcement,
        policy_version_id=policy.policy_version_id,
        policy_content_fingerprint=fingerprint,
        purpose=purpose,
    )

    if not policy_applies_to_purpose(policy, purpose):
        return PolicyDecision(
            passed=True,
            gate_results=(),
            evidence_run_ids=(),
            warnings=(
                {
                    "kind": "purpose_not_covered",
                    "message": (
                        f"Policy purpose is {policy.purpose!r}; evaluate purpose "
                        f"{purpose!r} is not gated."
                    ),
                },
            ),
            skipped=True,
            **common,
        )

    gates: List[GateResult] = []
    evidence_ids: List[str] = []
    warnings: List[Dict[str, Any]] = []
    network = policy.required_target_network_class

    # --- suite_digest + evidence_age -------------------------------------------------
    digest_details: List[Dict[str, Any]] = []
    age_details: List[Dict[str, Any]] = []
    digests_passed = True
    age_passed = True

    if not policy.required_suite_digests:
        gates.append(
            GateResult(
                gate=GATE_SUITE_DIGEST,
                passed=True,
                detail={"requiredSuiteDigests": [], "message": "No digests required."},
            )
        )
        gates.append(
            GateResult(
                gate=GATE_EVIDENCE_AGE,
                passed=True,
                detail={
                    "maxEvidenceAgeSeconds": policy.max_evidence_age_seconds,
                    "message": "No digests required; age gate not applicable.",
                },
            )
        )
    else:
        for digest in policy.required_suite_digests:
            run = _newest_passing_for_digest(
                evidence_runs, digest=digest, network_class=network
            )
            entry: Dict[str, Any] = {
                "suiteDigest": digest,
                "requiredTargetNetworkClass": network,
            }
            if run is None:
                digests_passed = False
                entry["found"] = False
                entry["message"] = (
                    "No passing verification_run found for this suite digest"
                    + (f" with network_class={network}" if network else "")
                    + "."
                )
                digest_details.append(entry)
                age_details.append({**entry, "ageOk": False})
                age_passed = False
                continue

            evidence_ids.append(run.run_id)
            entry["found"] = True
            entry["evidenceRunId"] = run.run_id
            entry["targetNetworkClass"] = run.target_network_class
            digest_details.append(entry)

            stamp = _run_timestamp(run)
            age_entry: Dict[str, Any] = {
                "suiteDigest": digest,
                "evidenceRunId": run.run_id,
                "finishedAt": stamp.isoformat() if stamp else None,
                "maxEvidenceAgeSeconds": policy.max_evidence_age_seconds,
            }
            if policy.max_evidence_age_seconds is None:
                age_entry["ageOk"] = True
                age_entry["message"] = "No maximum evidence age configured."
            elif stamp is None:
                age_passed = False
                age_entry["ageOk"] = False
                age_entry["message"] = "Evidence run has no finished_at/created_at."
            else:
                age_seconds = int((clock - stamp).total_seconds())
                age_entry["ageSeconds"] = age_seconds
                if age_seconds > int(policy.max_evidence_age_seconds):
                    age_passed = False
                    age_entry["ageOk"] = False
                    age_entry["message"] = (
                        f"Evidence is {age_seconds}s old; max allowed is "
                        f"{policy.max_evidence_age_seconds}s."
                    )
                else:
                    age_entry["ageOk"] = True
            age_details.append(age_entry)

        gates.append(
            GateResult(
                gate=GATE_SUITE_DIGEST,
                passed=digests_passed,
                detail={"digests": digest_details},
            )
        )
        gates.append(
            GateResult(
                gate=GATE_EVIDENCE_AGE,
                passed=age_passed,
                detail={
                    "maxEvidenceAgeSeconds": policy.max_evidence_age_seconds,
                    "checks": age_details,
                },
            )
        )

    # --- breaking_change (whole-spec #4475) ------------------------------------------
    action = policy.breaking_change_action
    breaking_detail: Dict[str, Any] = {
        "maxSeverity": changelog_max_severity,
        "changelogId": changelog_id,
        "changelogStatus": changelog_status,
        "consumerAware": False,
        "note": (
            "Whole-spec breaking via version_changelogs (#4475); "
            "consumer-aware acknowledgment is #4479 follow-up."
        ),
    }
    is_breaking = (changelog_max_severity or "").lower() == "breaking"

    if action == "ignore":
        gates.append(
            GateResult(
                gate=GATE_BREAKING_CHANGE,
                passed=True,
                action=action,
                detail={**breaking_detail, "message": "Breaking-change gate ignored."},
            )
        )
    elif not is_breaking:
        gates.append(
            GateResult(
                gate=GATE_BREAKING_CHANGE,
                passed=True,
                action=action,
                detail={
                    **breaking_detail,
                    "message": "No whole-spec breaking severity on the subject changelog.",
                },
            )
        )
    elif action == "warn":
        warning = {
            "kind": "breaking_change",
            "maxSeverity": "breaking",
            "changelogId": changelog_id,
            "message": (
                "Whole-spec breaking changes are present; policy action is warn."
            ),
        }
        warnings.append(warning)
        gates.append(
            GateResult(
                gate=GATE_BREAKING_CHANGE,
                passed=True,
                action=action,
                detail={**breaking_detail, "message": warning["message"]},
            )
        )
    else:  # block
        gates.append(
            GateResult(
                gate=GATE_BREAKING_CHANGE,
                passed=False,
                action=action,
                detail={
                    **breaking_detail,
                    "message": (
                        "Whole-spec breaking changes are present; policy action is block."
                    ),
                },
            )
        )

    # Deduplicate evidence ids while preserving order.
    seen: set[str] = set()
    unique_ids: List[str] = []
    for rid in evidence_ids:
        if rid not in seen:
            seen.add(rid)
            unique_ids.append(rid)

    all_passed = all(g.passed for g in gates)
    return PolicyDecision(
        passed=all_passed,
        gate_results=tuple(gates),
        evidence_run_ids=tuple(unique_ids),
        warnings=tuple(warnings),
        skipped=False,
        **common,
    )
