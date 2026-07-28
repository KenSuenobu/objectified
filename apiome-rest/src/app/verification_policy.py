"""Verification publish/deploy policy body — ECA-3.1 (#4734).

Tenant-scoped, append-only policy that turns ECA-1.3 evidence (and CTG-3.1 whole-spec
breaking severity) into an auditable gate. A tenant with **no** saved row runs
:data:`DEFAULT_POLICY`: advisory, no required digests, breaking changes warn only —
so upgrading changes no behaviour.

Consumer-aware breaking findings and acknowledgment (#4479 / #4480) are deliberately
out of scope: the breaking gate reads ``version_changelogs.max_severity`` only (#4475).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .verification_evidence import SUITE_DIGEST_PATTERN
from .verification_target import NETWORK_CLASSES

__all__ = [
    "BREAKING_ACTIONS",
    "DEFAULT_POLICY",
    "ENFORCEMENTS",
    "PURPOSES",
    "PURPOSE_BOTH",
    "PURPOSE_DEPLOY",
    "PURPOSE_PUBLISH",
    "VerificationPolicy",
    "canonical_policy_body",
    "policy_applies_to_purpose",
    "policy_content_fingerprint",
    "policy_from_row",
    "validate_policy_body",
]

PURPOSE_PUBLISH = "publish"
PURPOSE_DEPLOY = "deploy"
PURPOSE_BOTH = "both"
PURPOSES: Tuple[str, ...] = (PURPOSE_PUBLISH, PURPOSE_DEPLOY, PURPOSE_BOTH)

ENFORCEMENTS: Tuple[str, ...] = ("advisory", "block")
BREAKING_ACTIONS: Tuple[str, ...] = ("ignore", "warn", "block")

_SUITE_DIGEST_RE = re.compile(SUITE_DIGEST_PATTERN)


@dataclass(frozen=True)
class VerificationPolicy:
    """One version of a tenant's evidence-backed publish/deploy policy.

    Attributes:
        policy_version_id: Stored row id, or ``None`` for the documented default.
        version_number: Monotonic version, or ``0`` for the default.
        content_fingerprint: SHA-256 of the canonical policy body.
        required_suite_digests: ECA-1.1 digests that need recent passing evidence.
        max_evidence_age_seconds: Freshness ceiling, or ``None`` for no age gate.
        required_target_network_class: Optional ``public``/``private`` filter.
        purpose: ``publish``, ``deploy``, or ``both``.
        breaking_change_action: Whole-spec breaking posture (``ignore``/``warn``/``block``).
        enforcement: ``advisory`` (report only) or ``block`` (refuse when evaluate fails).
        is_default: True when no saved row exists for the tenant.
    """

    policy_version_id: Optional[str] = None
    version_number: int = 0
    content_fingerprint: str = ""
    required_suite_digests: Tuple[str, ...] = ()
    max_evidence_age_seconds: Optional[int] = None
    required_target_network_class: Optional[str] = None
    purpose: str = PURPOSE_BOTH
    breaking_change_action: str = "warn"
    enforcement: str = "advisory"
    is_default: bool = True


def canonical_policy_body(
    *,
    required_suite_digests: Sequence[str],
    max_evidence_age_seconds: Optional[int],
    required_target_network_class: Optional[str],
    purpose: str,
    breaking_change_action: str,
    enforcement: str,
) -> Dict[str, Any]:
    """Return the stable dict that fingerprints and persists as policy content.

    Args:
        required_suite_digests: Digests the gate requires.
        max_evidence_age_seconds: Freshness ceiling, or ``None``.
        required_target_network_class: Network class filter, or ``None``.
        purpose: Policy purpose coverage.
        breaking_change_action: Breaking posture.
        enforcement: Overall enforcement mode.

    Returns:
        A JSON-serializable dict with sorted digests and camelCase keys.
    """
    digests = sorted({str(d).strip() for d in required_suite_digests if str(d).strip()})
    return {
        "requiredSuiteDigests": digests,
        "maxEvidenceAgeSeconds": max_evidence_age_seconds,
        "requiredTargetNetworkClass": required_target_network_class,
        "purpose": purpose,
        "breakingChangeAction": breaking_change_action,
        "enforcement": enforcement,
    }


def policy_content_fingerprint(body: Mapping[str, Any]) -> str:
    """SHA-256 over the canonicalized policy body.

    Args:
        body: Policy content (typically from :func:`canonical_policy_body`).

    Returns:
        The 64-character hex digest.
    """
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_policy_body(
    *,
    required_suite_digests: Optional[Sequence[str]] = None,
    max_evidence_age_seconds: Optional[int] = None,
    required_target_network_class: Optional[str] = None,
    purpose: str = PURPOSE_BOTH,
    breaking_change_action: str = "warn",
    enforcement: str = "advisory",
) -> List[str]:
    """Validate a policy body; return a list of human-readable errors (empty when valid).

    Args:
        required_suite_digests: Digests to require.
        max_evidence_age_seconds: Freshness ceiling.
        required_target_network_class: Network class filter.
        purpose: Purpose coverage.
        breaking_change_action: Breaking posture.
        enforcement: Enforcement mode.

    Returns:
        Error strings; empty when the body is valid.
    """
    errors: List[str] = []
    digests = list(required_suite_digests or ())
    for digest in digests:
        if not _SUITE_DIGEST_RE.match(str(digest).strip()):
            errors.append(
                f"required_suite_digests entry {digest!r} must be 'sha256:<64 hex>'"
            )
    if max_evidence_age_seconds is not None:
        try:
            age = int(max_evidence_age_seconds)
        except (TypeError, ValueError):
            errors.append("max_evidence_age_seconds must be an integer >= 1 or null")
        else:
            if age < 1:
                errors.append("max_evidence_age_seconds must be an integer >= 1 or null")
    if required_target_network_class is not None:
        if required_target_network_class not in NETWORK_CLASSES:
            errors.append(
                "required_target_network_class must be one of "
                + ", ".join(NETWORK_CLASSES)
                + ", or null"
            )
    if purpose not in PURPOSES:
        errors.append("purpose must be one of " + ", ".join(PURPOSES))
    if breaking_change_action not in BREAKING_ACTIONS:
        errors.append(
            "breaking_change_action must be one of " + ", ".join(BREAKING_ACTIONS)
        )
    if enforcement not in ENFORCEMENTS:
        errors.append("enforcement must be one of " + ", ".join(ENFORCEMENTS))
    return errors


def policy_from_row(row: Optional[Mapping[str, Any]]) -> VerificationPolicy:
    """Adapt a ``verification_policies`` row into a :class:`VerificationPolicy`.

    Args:
        row: The stored policy row, or ``None`` when the tenant has none.

    Returns:
        The policy, or :data:`DEFAULT_POLICY` when ``row`` is ``None``.
    """
    if not row:
        return DEFAULT_POLICY
    digests_raw = row.get("required_suite_digests") or []
    if isinstance(digests_raw, str):
        digests_raw = [digests_raw]
    digests = tuple(str(d) for d in digests_raw if d)
    age = row.get("max_evidence_age_seconds")
    try:
        age_int: Optional[int] = int(age) if age is not None else None
    except (TypeError, ValueError):
        age_int = None
    network = row.get("required_target_network_class")
    network_str = str(network) if network else None
    purpose = str(row.get("purpose") or PURPOSE_BOTH)
    if purpose not in PURPOSES:
        purpose = PURPOSE_BOTH
    breaking = str(row.get("breaking_change_action") or "warn")
    if breaking not in BREAKING_ACTIONS:
        breaking = "warn"
    enforcement = str(row.get("enforcement") or "advisory")
    if enforcement not in ENFORCEMENTS:
        enforcement = "advisory"
    fingerprint = str(row.get("content_fingerprint") or "")
    if not fingerprint:
        fingerprint = policy_content_fingerprint(
            canonical_policy_body(
                required_suite_digests=digests,
                max_evidence_age_seconds=age_int,
                required_target_network_class=network_str,
                purpose=purpose,
                breaking_change_action=breaking,
                enforcement=enforcement,
            )
        )
    return VerificationPolicy(
        policy_version_id=str(row["id"]) if row.get("id") else None,
        version_number=int(row.get("version_number") or 1),
        content_fingerprint=fingerprint,
        required_suite_digests=digests,
        max_evidence_age_seconds=age_int,
        required_target_network_class=network_str,
        purpose=purpose,
        breaking_change_action=breaking,
        enforcement=enforcement,
        is_default=False,
    )


def policy_applies_to_purpose(policy: VerificationPolicy, purpose: str) -> bool:
    """Return whether ``policy`` covers the given evaluate purpose.

    Args:
        policy: The policy in force.
        purpose: ``publish`` or ``deploy``.

    Returns:
        True when the policy's purpose is ``both`` or matches ``purpose``.
    """
    if purpose not in (PURPOSE_PUBLISH, PURPOSE_DEPLOY):
        return False
    return policy.purpose in (PURPOSE_BOTH, purpose)


#: Documented default — advisory, no digests, warn on whole-spec breaking.
DEFAULT_POLICY = VerificationPolicy(
    content_fingerprint=policy_content_fingerprint(
        canonical_policy_body(
            required_suite_digests=(),
            max_evidence_age_seconds=None,
            required_target_network_class=None,
            purpose=PURPOSE_BOTH,
            breaking_change_action="warn",
            enforcement="advisory",
        )
    ),
)
