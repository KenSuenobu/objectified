"""Export delivery gate on quality policy, with a signed attestation — IXH-2.5 (#5100).

MFX-5.3 (:mod:`app.export_validation_gate`) blocks a delivery only when the emitted artifact is
*provably illegal in its target format*. Everything else ships silently: an artifact that parses
cleanly but was generated from a source with open error-severity findings, or one whose projected
fidelity fell below what the tenant is willing to publish, leaves the building without comment —
and with nothing attached that a downstream consumer could check.

This module is the delivery decision. It combines **four** dimensions into one verdict:

============  ===============================================================================
Dimension     Input
============  ===============================================================================
validation    The MFX-5.3 :class:`~app.export_validation_gate.EmittedValidationReport` — did
              the emitted artifact re-parse, was validation skipped, or was it rejected?
lint          The **source** revision's lint roll-up (score, grade, severity tallies) — the
              same report the IXH-2.4 export pre-flight ranks targets with.
fidelity      The projected preserved-construct percentage for this conversion, against the
              tenant's export ``minFidelity`` floor (IXH-2.5, migration V238).
policy        The tenant's export quality policy (IXH-2.3) — its floors, its enforcement mode,
              and any active waiver — evaluated by :func:`evaluate_export_quality`, the same
              function the pre-flight calls, so a target the pre-flight banded ``blocked`` is
              the target this gate refuses.
============  ===============================================================================

The result is one :class:`DeliveryDecision` — ``allow``, ``allow_with_warning``, or ``block`` —
plus the **named contributing reasons** that produced it. Nothing is inferred from prose: every
reason carries a stable :class:`DeliveryReasonCode`, the dimension it came from, and whether it
blocked or merely warned.

Blocking
--------
A blocked delivery returns its reasons *and* its override path (:class:`DeliveryOverride`: the
waiver endpoint, the subject key to record it under, and the roles permitted to record it), and
**no artifact bytes are produced or served** — callers run this gate before packaging, so a
blocked job never reaches the artifact store and its download route has nothing to hand out.
An override exists only for a *policy* block: an artifact the validator rejected is illegal in
its target format, and no waiver makes it legal.

Attestation
-----------
Every **delivered** artifact carries a :class:`DeliveryAttestation` — an in-toto Statement v1 in
a DSSE envelope, HMAC-SHA256 signed with the shared attestation secret. It reuses
:mod:`app.lint_attestation` (one attestation format, one signer, one verifier — see
:func:`~app.lint_attestation.build_delivery_attestation_statement`) rather than growing a second
one, and it records what a verifier needs to reproduce the decision offline: the delivery
identity, the tool versions, the source lint fingerprint, the policy version and content
fingerprint, the waiver reference where one applied, and the decision with its reasons. The
subject is the artifact itself, digested with a plain ``sha256`` over the exact delivered bytes.

Default behaviour
-----------------
Under the documented default policy (no floors, advisory, no waiver required) a clean export
decides ``allow`` and delivers exactly as it did before this module existed. The only new
non-blocking outcome is ``allow_with_warning``, which annotates a delivery that previously went
out silent — it never withholds bytes.
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field

from .config import settings
from .export_validation_gate import TOOL_BY_TARGET, EmittedValidationReport, ValidationVerdict
from .import_export_quality_policy import (
    SCOPE_EXPORT,
    QualityPolicy,
    QualityVerdict,
    evaluate_export_quality,
    subject_key_for_export,
    verdict_response_model,
)
from .import_source import LintReport
from .lint_attestation import (
    DELIVERY_PREDICATE_TYPE,
    attestation_envelope,
    build_delivery_attestation_statement,
)
from .models import ImportPreflightPolicy

logger = logging.getLogger(__name__)

__all__ = [
    "ATTESTATION_KEY_ID",
    "DeliveryAttestation",
    "DeliveryDecision",
    "DeliveryDimension",
    "DeliveryGateReport",
    "DeliveryOverride",
    "DeliveryReason",
    "DeliveryReasonCode",
    "DeliverySeverity",
    "WAIVER_ENDPOINT_TEMPLATE",
    "build_delivery_attestation",
    "delivery_tool_versions",
    "evaluate_delivery",
    "lint_delivery_source",
]

#: Key id put on the DSSE signature. The delivery attestation is signed with the *same* shared
#: secret as a lint gate attestation, so it names the same key: a verifier that already holds the
#: CLX-4.2 secret verifies a delivery attestation with no new configuration.
ATTESTATION_KEY_ID = "apiome-lint-hmac-v1"

#: Where a blocked delivery's override is recorded (IXH-2.3's waiver endpoint). Formatted with the
#: tenant slug so the reason the client renders is directly actionable.
WAIVER_ENDPOINT_TEMPLATE = "/v1/tenants/{tenant_slug}/governance/quality-waivers"


class DeliveryDecision(str, Enum):
    """The gate's single verdict for one delivery.

    ``allow`` — nothing to say; the artifact is delivered as before.
    ``allow_with_warning`` — delivered, but with at least one reason the consumer should read
    (validation could not run, the source carries open errors, an advisory floor was missed, or
    a waiver is carrying the delivery).
    ``block`` — refused: no artifact bytes are produced or served.
    """

    ALLOW = "allow"
    ALLOW_WITH_WARNING = "allow_with_warning"
    BLOCK = "block"


class DeliveryDimension(str, Enum):
    """Which of the four inputs a reason came from."""

    VALIDATION = "validation"
    LINT = "lint"
    FIDELITY = "fidelity"
    POLICY = "policy"


class DeliverySeverity(str, Enum):
    """How much a reason weighs on the decision."""

    INFO = "info"
    WARNING = "warning"
    BLOCKING = "blocking"


class DeliveryReasonCode(str, Enum):
    """Stable, additive-only reason codes. A shipped code is never repurposed."""

    #: A validator ran and rejected the emitted artifact.
    ARTIFACT_INVALID = "DELIVERY_ARTIFACT_INVALID"
    #: A matching validator exists but its toolchain was unavailable in this runtime.
    VALIDATION_SKIPPED = "DELIVERY_VALIDATION_SKIPPED"
    #: No importer matches the target, so the artifact could not be re-validated at all.
    VALIDATION_NOT_APPLICABLE = "DELIVERY_VALIDATION_NOT_APPLICABLE"
    #: The source revision carries findings at or above ``error`` severity.
    SOURCE_ERRORS_OPEN = "DELIVERY_SOURCE_ERRORS_OPEN"
    #: The source revision could not be linted, so its quality is unknown for this delivery.
    SOURCE_UNGRADED = "DELIVERY_SOURCE_UNGRADED"
    #: A source-quality floor (score, grade, or severity) was missed.
    SOURCE_BELOW_FLOOR = "DELIVERY_SOURCE_BELOW_FLOOR"
    #: The projected fidelity floor was missed.
    FIDELITY_BELOW_FLOOR = "DELIVERY_FIDELITY_BELOW_FLOOR"
    #: The tenant policy refuses this delivery (its named failures ride alongside).
    POLICY_BLOCK = "DELIVERY_POLICY_BLOCKED"
    #: An active waiver downgraded a blocking policy verdict.
    POLICY_WAIVED = "DELIVERY_POLICY_WAIVED"


#: Reason sort order: blocking first, then warning, then info — so a client that renders only the
#: head of the list renders the reason the delivery was actually refused for.
_SEVERITY_ORDER = (
    DeliverySeverity.BLOCKING,
    DeliverySeverity.WARNING,
    DeliverySeverity.INFO,
)

#: Which policy failure ``kind`` maps onto which reason code and dimension. A kind with no entry
#: falls back to the source-quality pair, so an added floor is reported rather than dropped.
_FAILURE_REASONS: Mapping[str, tuple] = {
    "score": (DeliveryReasonCode.SOURCE_BELOW_FLOOR, DeliveryDimension.LINT),
    "grade": (DeliveryReasonCode.SOURCE_BELOW_FLOOR, DeliveryDimension.LINT),
    "severity": (DeliveryReasonCode.SOURCE_BELOW_FLOOR, DeliveryDimension.LINT),
    "fidelity": (DeliveryReasonCode.FIDELITY_BELOW_FLOOR, DeliveryDimension.FIDELITY),
}


class DeliveryReason(BaseModel):
    """One named contribution to the delivery decision."""

    model_config = ConfigDict(extra="forbid")

    code: DeliveryReasonCode = Field(
        description="Stable reason code (additive-only); branch on this, never on the message."
    )
    dimension: DeliveryDimension = Field(
        description="Which input produced the reason: validation, lint, fidelity, or policy."
    )
    severity: DeliverySeverity = Field(
        description="``blocking`` refuses the delivery; ``warning`` annotates it; ``info`` is "
        "context only.",
    )
    message: str = Field(description="Ready-to-render sentence explaining this reason.")
    detail: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Structured backing for the reason (the missed floor and the actual value, "
        "the validation verdict, the finding tally). Rendered by clients that drill in.",
    )


class DeliveryOverride(BaseModel):
    """The path a blocked delivery may be unblocked through, if any."""

    model_config = ConfigDict(extra="forbid")

    available: bool = Field(
        description="Whether an override exists at all. False when nothing is blocked, when the "
        "policy forbids overrides, or when the block came from the validator (an artifact that "
        "is illegal in its target format cannot be waived).",
    )
    endpoint: Optional[str] = Field(
        default=None,
        description="Relative URL a waiver is recorded at (``POST``), when one may be recorded.",
    )
    scope: str = Field(
        default=SCOPE_EXPORT, description="The gate scope a waiver must be recorded under."
    )
    subject_key: Optional[str] = Field(
        default=None,
        description="The subject key the waiver must carry — the source revision id, matching "
        "what the export pre-flight reported.",
    )
    format_key: Optional[str] = Field(
        default=None,
        description="The export target the waiver must name; a waiver for one target never "
        "covers another.",
    )
    roles: List[str] = Field(
        default_factory=list,
        description="Effective role slugs permitted to record the waiver.",
    )
    instructions: str = Field(
        description="One sentence telling the user what to do next — rendered verbatim."
    )


class DeliveryAttestation(BaseModel):
    """The signed evidence attached to a delivered artifact."""

    model_config = ConfigDict(extra="forbid")

    predicate_type: str = Field(
        description="The in-toto predicate type of the wrapped statement.",
    )
    signed: bool = Field(
        description="Whether the envelope carries a signature. False when no attestation signing "
        "secret is configured on this server — the document is still well-formed, just not "
        "verifiable.",
    )
    key_id: Optional[str] = Field(
        default=None, description="The key id a verifier uses to select the shared secret."
    )
    generated_at: str = Field(description="Statement timestamp (ISO-8601, UTC).")
    envelope: Dict[str, Any] = Field(
        description="The DSSE envelope: ``payloadType`` / base64 ``payload`` / ``signatures``. "
        "Verifiable offline with the shared secret and the standard library alone.",
    )


class DeliveryGateReport(BaseModel):
    """The delivery gate's decision for one export, with everything that produced it."""

    model_config = ConfigDict(extra="forbid")

    decision: DeliveryDecision = Field(description="The single delivery verdict.")
    blocks_delivery: bool = Field(
        description="True only for ``block``. The one flag a delivery path branches on."
    )
    warns: bool = Field(description="True for ``allow_with_warning``.")
    headline: str = Field(description="Short banner heading for the gate.")
    message: str = Field(description="The full, ready-to-display sentence. Render verbatim.")
    reasons: List[DeliveryReason] = Field(
        default_factory=list,
        description="Every named contribution, blocking reasons first. Empty on a clean allow.",
    )
    target: str = Field(description="The resolved target format key the decision applies to.")
    validation_verdict: Optional[ValidationVerdict] = Field(
        default=None,
        description="The emitted-artifact validation band the decision folded in, when one ran.",
    )
    source_score: Optional[int] = Field(
        default=None, description="The source revision's lint score, when it was graded."
    )
    source_grade: Optional[str] = Field(
        default=None, description="The source revision's lint grade, when it was graded."
    )
    source_report_fingerprint: Optional[str] = Field(
        default=None,
        description="Fingerprint of the source lint report the decision used — the same value "
        "the attestation records, so a verdict can be tied to an exact lint run.",
    )
    preserved_percent: Optional[int] = Field(
        default=None,
        description="The projected preserved-construct percentage the fidelity floor was "
        "measured against; null when the caller measured none.",
    )
    policy: ImportPreflightPolicy = Field(
        description="The tenant's export quality-policy verdict, in the one shape every "
        "import/export policy surface returns.",
    )
    override: DeliveryOverride = Field(description="The override path, or its absence.")
    attestation: Optional[DeliveryAttestation] = Field(
        default=None,
        description="The signed delivery attestation. Attached once the artifact bytes exist "
        "(:func:`build_delivery_attestation`); always null on a blocked delivery, which has no "
        "artifact to attest to.",
    )

    def attestation_payload(
        self,
        *,
        tenant_id: str,
        delivery: Mapping[str, Any],
        artifact: Mapping[str, Any],
        tools: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """Assemble the payload the attestation statement is built from.

        Kept on the report so the attested decision and the returned decision cannot drift: every
        field below is read off ``self``, never recomputed.

        Args:
            tenant_id: The tenant the delivery belongs to.
            delivery: Delivery identity — job id, artifact/project id, revision, target, snapshot.
            artifact: The delivered bytes' identity — filename, ``contentSha256``, size, media type.
            tools: Tool identities and versions that produced the artifact.

        Returns:
            The attestation payload dict (fingerprints, versions and verdicts only).
        """
        return {
            "tenantId": tenant_id,
            "delivery": dict(delivery),
            "artifact": dict(artifact),
            "decision": {
                "decision": self.decision.value,
                "blocksDelivery": self.blocks_delivery,
                "reasons": [
                    {
                        "code": reason.code.value,
                        "dimension": reason.dimension.value,
                        "severity": reason.severity.value,
                        "message": reason.message,
                    }
                    for reason in self.reasons
                ],
            },
            "inputs": {
                "validationVerdict": (
                    self.validation_verdict.value if self.validation_verdict else None
                ),
                "lintReportFingerprint": self.source_report_fingerprint,
                "lintScore": self.source_score,
                "lintGrade": self.source_grade,
                "preservedPercent": self.preserved_percent,
            },
            "policy": {
                "verdict": self.policy.verdict,
                "scope": self.policy.scope,
                "source": self.policy.source,
                "formatKey": self.policy.format_key,
                "policyVersionId": self.policy.policy_version_id,
                "policyContentFingerprint": self.policy.policy_content_fingerprint,
                "enforcement": self.policy.enforcement,
                "minGrade": self.policy.min_grade,
                "minScore": self.policy.threshold_score,
                "minFidelity": self.policy.min_fidelity,
                "blockOnSeverity": self.policy.block_on_severity,
                "failures": [
                    {
                        "kind": failure.kind,
                        "required": failure.required,
                        "actual": failure.actual,
                    }
                    for failure in self.policy.failures
                ],
            },
            "waiver": (
                {
                    "waiverId": self.policy.waiver_id,
                    "expiresAt": self.policy.waiver_expires_at,
                }
                if self.policy.waiver_id
                else {}
            ),
            "tools": dict(tools),
        }


# ===========================================================================
# Reason assembly
# ===========================================================================


def _validation_reasons(
    validation: Optional[EmittedValidationReport],
) -> List[DeliveryReason]:
    """Reasons contributed by the emitted-artifact validation band (MFX-5.3)."""
    if validation is None:
        return []
    if validation.verdict is ValidationVerdict.INVALID:
        return [
            DeliveryReason(
                code=DeliveryReasonCode.ARTIFACT_INVALID,
                dimension=DeliveryDimension.VALIDATION,
                severity=DeliverySeverity.BLOCKING,
                message=validation.message,
                detail={
                    "target": validation.target,
                    "tool": validation.tool,
                    "findings": len(validation.findings),
                },
            )
        ]
    if validation.verdict is ValidationVerdict.SKIPPED:
        return [
            DeliveryReason(
                code=DeliveryReasonCode.VALIDATION_SKIPPED,
                dimension=DeliveryDimension.VALIDATION,
                severity=DeliverySeverity.WARNING,
                message=validation.message,
                detail={"target": validation.target, "tool": validation.tool},
            )
        ]
    if validation.verdict is ValidationVerdict.NOT_APPLICABLE:
        return [
            DeliveryReason(
                code=DeliveryReasonCode.VALIDATION_NOT_APPLICABLE,
                dimension=DeliveryDimension.VALIDATION,
                severity=DeliverySeverity.INFO,
                message=validation.message,
                detail={"target": validation.target},
            )
        ]
    return []


def _lint_reasons(lint: Optional[LintReport], *, covered_by_policy: bool) -> List[DeliveryReason]:
    """Reasons contributed by the source lint roll-up, independent of any configured floor.

    This is the "ships without comment" half of the problem statement: a source with open
    error-severity findings is worth saying out loud even when the tenant has set no floor, so the
    delivery is annotated rather than silent. It never blocks — only a policy floor can do that.

    Args:
        lint: The source revision's lint report, or ``None`` when it could not be linted.
        covered_by_policy: True when the policy verdict already names a shortfall, so the generic
            "open errors" note would be a duplicate of a more specific reason.

    Returns:
        Zero or one reason.
    """
    if lint is None:
        return [
            DeliveryReason(
                code=DeliveryReasonCode.SOURCE_UNGRADED,
                dimension=DeliveryDimension.LINT,
                severity=DeliverySeverity.WARNING,
                message=(
                    "The source revision could not be linted for this delivery, so the artifact "
                    "ships without a source-quality check."
                ),
            )
        ]
    errors = int(lint.severity_counts.get("error", 0) or 0)
    if errors <= 0 or covered_by_policy:
        return []
    noun = "finding" if errors == 1 else "findings"
    return [
        DeliveryReason(
            code=DeliveryReasonCode.SOURCE_ERRORS_OPEN,
            dimension=DeliveryDimension.LINT,
            severity=DeliverySeverity.WARNING,
            message=(
                f"The source revision has {errors} open error-severity lint {noun}; the exported "
                "artifact inherits them."
            ),
            detail={
                "errors": errors,
                "score": lint.score,
                "grade": lint.grade,
                "report_fingerprint": lint.report_fingerprint,
            },
        )
    ]


def _policy_reasons(verdict: QualityVerdict) -> List[DeliveryReason]:
    """Reasons contributed by the tenant's export quality policy verdict (IXH-2.3)."""
    reasons: List[DeliveryReason] = []
    severity = (
        DeliverySeverity.BLOCKING if verdict.blocking else DeliverySeverity.WARNING
    )
    for failure in verdict.failures:
        kind = str(failure.get("kind"))
        code, dimension = _FAILURE_REASONS.get(
            kind, (DeliveryReasonCode.SOURCE_BELOW_FLOOR, DeliveryDimension.LINT)
        )
        reasons.append(
            DeliveryReason(
                code=code,
                dimension=dimension,
                severity=severity,
                message=_failure_sentence(kind, failure, blocking=verdict.blocking),
                detail={
                    "kind": kind,
                    "required": failure.get("required"),
                    "actual": failure.get("actual"),
                    "enforcement": verdict.thresholds.enforcement,
                    "policy_source": verdict.source,
                },
            )
        )
    if verdict.blocking:
        reasons.append(
            DeliveryReason(
                code=DeliveryReasonCode.POLICY_BLOCK,
                dimension=DeliveryDimension.POLICY,
                severity=DeliverySeverity.BLOCKING,
                message=verdict.reason,
                detail={
                    "policy_version_id": verdict.policy_version_id,
                    "policy_content_fingerprint": verdict.policy_content_fingerprint,
                    "policy_source": verdict.source,
                },
            )
        )
    elif verdict.waiver_id:
        reasons.append(
            DeliveryReason(
                code=DeliveryReasonCode.POLICY_WAIVED,
                dimension=DeliveryDimension.POLICY,
                severity=DeliverySeverity.WARNING,
                message=verdict.reason,
                detail={
                    "waiver_id": verdict.waiver_id,
                    "waiver_expires_at": verdict.waiver_expires_at,
                },
            )
        )
    return reasons


def _failure_sentence(
    kind: str, failure: Mapping[str, Any], *, blocking: bool
) -> str:
    """One readable sentence for a missed floor, toned by whether it blocks."""
    required = failure.get("required")
    actual = failure.get("actual")
    tail = "refuses this delivery" if blocking else "records this delivery as below its floor"
    if kind == "fidelity":
        return (
            f"Only {actual}% of the source survives this conversion, below the tenant's "
            f"{required}% fidelity floor; policy {tail}."
        )
    if kind == "score":
        return (
            f"The source lint score is {actual}, below the required {required}; policy {tail}."
        )
    if kind == "grade":
        return (
            f"The source lint grade is {actual or 'ungraded'}, below the required {required}; "
            f"policy {tail}."
        )
    if kind == "severity":
        return (
            f"The source has {actual} finding(s) at or above {required} severity; policy {tail}."
        )
    return f"The source misses the {kind} floor ({actual} vs {required}); policy {tail}."


def _decide(reasons: Sequence[DeliveryReason]) -> DeliveryDecision:
    """Fold the reasons into the single decision: any blocker blocks, any warning warns."""
    if any(reason.severity is DeliverySeverity.BLOCKING for reason in reasons):
        return DeliveryDecision.BLOCK
    if any(reason.severity is DeliverySeverity.WARNING for reason in reasons):
        return DeliveryDecision.ALLOW_WITH_WARNING
    return DeliveryDecision.ALLOW


def _headline_and_message(
    decision: DeliveryDecision, target: str, reasons: Sequence[DeliveryReason]
) -> tuple:
    """Ready-to-render copy for each decision band."""
    blocking = [r for r in reasons if r.severity is DeliverySeverity.BLOCKING]
    warnings = [r for r in reasons if r.severity is DeliverySeverity.WARNING]
    if decision is DeliveryDecision.BLOCK:
        lead = blocking[0].message if blocking else "The delivery was refused."
        extra = (
            f" {len(blocking) - 1} further blocking reason(s) apply."
            if len(blocking) > 1
            else ""
        )
        return (
            "Delivery blocked",
            f"The {target!r} delivery was blocked before any artifact was produced. {lead}{extra}",
        )
    if decision is DeliveryDecision.ALLOW_WITH_WARNING:
        noun = "reason" if len(warnings) == 1 else "reasons"
        joined = " ".join(reason.message for reason in warnings)
        return (
            "Delivered with warnings",
            f"The {target!r} artifact was delivered with {len(warnings)} advisory {noun}. "
            f"{joined}",
        )
    return (
        "Delivery allowed",
        f"The {target!r} artifact met every delivery requirement this tenant sets.",
    )


def _override_for(
    verdict: QualityVerdict,
    *,
    decision: DeliveryDecision,
    reasons: Sequence[DeliveryReason],
    tenant_slug: Optional[str],
    subject_key: Optional[str],
) -> DeliveryOverride:
    """Build the override path for a decision.

    An override is offered only when the block is a **policy** block that policy itself permits
    waiving. A validator-rejected artifact has no override: it is illegal in its target format,
    and a waiver would only ship a broken file.
    """
    if decision is not DeliveryDecision.BLOCK:
        return DeliveryOverride(
            available=False,
            scope=SCOPE_EXPORT,
            instructions="No override is needed; the delivery was not blocked.",
        )
    if any(reason.dimension is DeliveryDimension.VALIDATION for reason in reasons
           if reason.severity is DeliverySeverity.BLOCKING):
        return DeliveryOverride(
            available=False,
            scope=SCOPE_EXPORT,
            format_key=verdict.format_key,
            instructions=(
                "This artifact is not valid in its target format, so it cannot be waived. Fix "
                "the reported validation findings and export again."
            ),
        )
    if not verdict.allow_override or not verdict.override_roles:
        return DeliveryOverride(
            available=False,
            scope=SCOPE_EXPORT,
            format_key=verdict.format_key,
            instructions=(
                "The tenant's quality policy does not permit an override for this delivery. "
                "Raise the source's quality (or the conversion's fidelity) and export again."
            ),
        )
    endpoint = (
        WAIVER_ENDPOINT_TEMPLATE.format(tenant_slug=tenant_slug) if tenant_slug else None
    )
    roles = ", ".join(verdict.override_roles)
    where = f" at POST {endpoint}" if endpoint else ""
    return DeliveryOverride(
        available=True,
        endpoint=endpoint,
        scope=SCOPE_EXPORT,
        subject_key=subject_key,
        format_key=verdict.format_key,
        roles=list(verdict.override_roles),
        instructions=(
            f"Record an export waiver{where} for this revision with a stated reason, then export "
            f"again. Permitted roles: {roles}."
        ),
    )


# ===========================================================================
# The gate
# ===========================================================================


def lint_delivery_source(
    api: Any, *, tenant_id: str, project_id: Optional[str] = None
) -> Optional[LintReport]:
    """Lint the source of a delivery, degrading to ``None`` on any fault.

    The single entry point every delivery path uses — the async job and both synchronous export
    routes — so the grade this gate judges is the grade the IXH-2.4 pre-flight showed for the same
    revision, and one fix to the degradation rule covers all three.

    The :mod:`app.export_preflight` import is deferred: it pulls the emitter registry and the
    style-guide engine, which a caller that only wants the gate's models has no need of.

    Args:
        api: The source :class:`~app.canonical_model.CanonicalApi` being exported.
        tenant_id: The tenant whose style guide governs the lint.
        project_id: The owning artifact/project, so a project-assigned guide wins (GOV-1.4).

    Returns:
        The source's lint report, or ``None`` when linting failed — the gate then reports the
        delivery as ungraded rather than refusing it.
    """
    try:
        from .export_preflight import lint_export_source

        report, _guide = lint_export_source(api, tenant_id=tenant_id, project_id=project_id)
        return report
    except Exception:  # noqa: BLE001 - an unlintable source is a warning, not a failed export
        logger.warning(
            "Could not lint the export source for the delivery gate (tenant %s)",
            tenant_id,
            exc_info=True,
        )
        return None


def evaluate_delivery(
    *,
    tenant_id: str,
    tenant_slug: Optional[str],
    target_format: str,
    target_key: Optional[str] = None,
    version_record_id: str,
    validation: Optional[EmittedValidationReport] = None,
    lint: Optional[LintReport] = None,
    preserved_percent: Optional[int] = None,
    policy: Optional[QualityPolicy] = None,
) -> DeliveryGateReport:
    """Decide whether one delivery may proceed, and say exactly why (IXH-2.5).

    Pure apart from the tenant policy read (and the waiver lookup a would-be block triggers): it
    emits nothing, packages nothing, and persists nothing. Callers run it **before** producing
    artifact bytes so a blocked delivery never materializes an artifact.

    Args:
        tenant_id: The tenant whose export policy governs.
        tenant_slug: The tenant slug, used to render the waiver endpoint in the override path.
            ``None`` still returns the override's roles and subject key, without a URL.
        target_format: The resolved target format key (``openapi-3.1``) — what the decision is
            reported against.
        target_key: The target's registry key (``openapi``) for policy override resolution;
            defaults to ``target_format`` when the caller only has the format.
        version_record_id: The source revision, which is the waiver subject key.
        validation: The MFX-5.3 emitted-artifact validation report, when one was computed.
        lint: The source revision's lint report, or ``None`` when it could not be linted.
        preserved_percent: The conversion's projected preserved-construct percentage, for the
            fidelity floor. ``None`` leaves that floor unexercised.
        policy: A pre-loaded tenant policy, so a caller gating several deliveries reads it once.

    Returns:
        The :class:`DeliveryGateReport`. Its :attr:`~DeliveryGateReport.attestation` is ``None``;
        attach one with :func:`build_delivery_attestation` once the artifact bytes exist.
    """
    subject_key = subject_key_for_export(version_record_id)
    verdict = evaluate_export_quality(
        tenant_id=tenant_id,
        target_key=target_key or target_format,
        score=lint.score if lint else None,
        grade=lint.grade if lint else None,
        severity_counts=dict(lint.severity_counts) if lint else None,
        preserved_percent=preserved_percent,
        subject_key=subject_key,
        policy=policy,
    )

    reasons: List[DeliveryReason] = []
    reasons.extend(_validation_reasons(validation))
    policy_reasons = _policy_reasons(verdict)
    reasons.extend(policy_reasons)
    reasons.extend(
        _lint_reasons(
            lint,
            covered_by_policy=any(
                reason.dimension is DeliveryDimension.LINT for reason in policy_reasons
            ),
        )
    )
    # Blocking reasons first so a client that renders only the head of the list renders the
    # reason the delivery was actually refused for.
    reasons.sort(key=lambda reason: _SEVERITY_ORDER.index(reason.severity))

    decision = _decide(reasons)
    headline, message = _headline_and_message(decision, target_format, reasons)
    override = _override_for(
        verdict,
        decision=decision,
        reasons=reasons,
        tenant_slug=tenant_slug,
        subject_key=subject_key,
    )
    return DeliveryGateReport(
        decision=decision,
        blocks_delivery=decision is DeliveryDecision.BLOCK,
        warns=decision is DeliveryDecision.ALLOW_WITH_WARNING,
        headline=headline,
        message=message,
        reasons=reasons,
        target=target_format,
        validation_verdict=validation.verdict if validation else None,
        source_score=lint.score if lint else None,
        source_grade=lint.grade if lint else None,
        source_report_fingerprint=lint.report_fingerprint if lint else None,
        preserved_percent=preserved_percent,
        policy=verdict_response_model(verdict),
        override=override,
        attestation=None,
    )


def delivery_tool_versions(
    *,
    target_format: str,
    emitter_version: Optional[str] = None,
    registry_version: Optional[str] = None,
    apiome_version: Optional[str] = None,
    validation: Optional[EmittedValidationReport] = None,
) -> Dict[str, Any]:
    """The tool identities an attestation records for one delivery.

    Every value is something a verifier can compare against a known-good build: the emitter that
    produced the artifact, the capability registry that constrained it, the Apiome version that
    ran, and the validator that (may have) checked the result.

    Args:
        target_format: The resolved target format key.
        emitter_version: The emitter's version, from the projection provenance.
        registry_version: The capability registry version.
        apiome_version: The running Apiome version.
        validation: The emitted-artifact validation report, for the validator identity.

    Returns:
        A JSON-ready mapping of tool name to version/identity.
    """
    validator = (validation.tool if validation else None) or TOOL_BY_TARGET.get(target_format)
    return {
        "emitter": emitter_version,
        "capabilityRegistry": registry_version,
        "apiome": apiome_version,
        "validator": validator,
        "validatorRan": bool(validation and validation.validated),
        "policyEngine": "import_export_quality_policy/IXH-2.5",
    }


def build_delivery_attestation(
    report: DeliveryGateReport,
    *,
    tenant_id: str,
    delivery: Mapping[str, Any],
    artifact: Mapping[str, Any],
    tools: Mapping[str, Any],
    secret: Optional[str] = None,
    generated_at: Optional[Any] = None,
) -> DeliveryGateReport:
    """Attach the signed attestation for a delivered artifact, returning the updated report.

    Called **after** the delivery bytes exist so the statement can name the artifact by its real
    ``sha256``. A blocked report is returned untouched: there is no artifact to attest to, and
    signing a refusal would imply one shipped.

    Never raises: an attestation that cannot be built (an unexpected payload shape, a signing
    fault) is logged and omitted rather than failing a delivery that policy already allowed.

    Args:
        report: The decision from :func:`evaluate_delivery`.
        tenant_id: The tenant the delivery belongs to.
        delivery: Delivery identity (job id, artifact id, revision, target, snapshot hash).
        artifact: The delivered bytes (``filename``, ``contentSha256``, ``sizeBytes``,
            ``mediaType``).
        tools: The tool versions from :func:`delivery_tool_versions`.
        secret: The HMAC signing secret; defaults to the configured
            ``lint_attestation_signing_secret``. Without one the envelope is emitted unsigned.
        generated_at: Statement timestamp; defaults to now (UTC). Injectable for deterministic
            tests.

    Returns:
        A copy of ``report`` carrying its :class:`DeliveryAttestation`, or the original report
        when it was blocked or the attestation could not be built.
    """
    if report.blocks_delivery:
        return report
    try:
        payload = report.attestation_payload(
            tenant_id=tenant_id, delivery=delivery, artifact=artifact, tools=tools
        )
        statement = build_delivery_attestation_statement(payload, generated_at=generated_at)
        signing_secret = (
            secret if secret is not None else settings.lint_attestation_signing_secret
        )
        envelope = attestation_envelope(
            statement, secret=signing_secret, key_id=ATTESTATION_KEY_ID
        )
        attestation = DeliveryAttestation(
            predicate_type=DELIVERY_PREDICATE_TYPE,
            signed=bool(envelope.get("signatures")),
            key_id=ATTESTATION_KEY_ID if envelope.get("signatures") else None,
            generated_at=str(statement["predicate"]["generatedAt"]),
            envelope=envelope,
        )
    except Exception:  # noqa: BLE001 - an unattestable delivery is still an allowed delivery
        logger.warning(
            "Could not build the delivery attestation for tenant %s target %s",
            tenant_id,
            report.target,
            exc_info=True,
        )
        return report
    return report.model_copy(update={"attestation": attestation})
