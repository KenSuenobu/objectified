"""Export pre-flight — source lint and target-readiness ranking — IXH-2.4 (#5099).

The export job lints and validates the **emitted** artifact
(:mod:`app.export_validation`, :mod:`app.export_validation_gate`, the emitted-lint lens):
the right check at the wrong end. A user picks a target, waits for a job, and only then
learns the *source* was too thin for that target. ``GET …/export/targets`` (MFX-2.5) helps
— it badges every target with a fidelity tier — but it says nothing about the source's own
quality, nothing about the tenant's export policy, and it hands back a flat, registry-ordered
list with no opinion about which target is the best bet.

This module is the pre-job counterpart to the post-job verify workbench (MFX-EPIC-42). For one
source revision it computes, **once**, the source's lint verdict under the tenant's resolved
style guide, and then for **every registered target**:

* the projected fidelity envelope (:func:`app.export_fidelity.build_target_fidelity` — the same
  prediction engine the job embeds in its result, so the numbers reconcile);
* the **capability verdict** — which construct classes this source actually uses vs. which the
  target's :class:`~app.emitter.CapabilityProfile` declares it can carry;
* the **policy verdict** — the tenant's export quality policy (IXH-2.3) evaluated against the
  source's grade *and* this target's projected fidelity (the IXH-2.5 fidelity floor), honouring
  an active waiver;
* a composite **readiness** score, a band, a rank, and a one-line rationale.

Nothing is emitted and nothing is written: no export job, no artifact, no field-identity rows.
The only reads are the source revision, the tenant's style guide, and the tenant's policy.

Ranking
-------
:data:`READINESS_WEIGHTS` mixes three normalized 0–100 inputs — projected fidelity (how much of
the source survives), source quality (the lint score), and capability fit (whether the target
can carry what this source is made of). The mix is then ordered by *band* first, so an
unusable target never outranks a usable one no matter how good its numbers look:

``ready`` → ``caution`` → ``blocked`` (policy refuses it) → ``unavailable`` (the emitter cannot
run in this runtime). Ties inside a band break on the descending composite score and then the
target key, so the ordering is **total** and therefore reproducible for a fixed source revision,
style guide, and policy.

Determinism
-----------
Every input is either pure (the prediction engine, the capability profile, the lint engine) or
tenant state read at request time (style guide, policy, waivers). The report carries a
:attr:`ExportPreflightReport.ranking_fingerprint` over the ranked inputs, so a caller can assert
two pre-flights of the same revision produced the same ranking without diffing the whole body.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi, TypeKind
from .cross_format_conformance import TargetConformance, check_cross_format_conformance
from .emitter import CapabilityProfile, Emitter, EmitterDescriptor, describe_emit_targets, get_emitter
from .export_fidelity import TargetFidelity, build_target_fidelity
from .export_source import ExportSource
from .fidelity_rulepack import _EVENT_OPERATION_KINDS, _has_any_constraint
from .import_export_quality_policy import (
    evaluate_export_quality,
    load_tenant_policy,
    subject_key_for_export,
    verdict_response_model,
)
from .import_preflight import rank_lint_findings
from .import_source import LintReport
from .lint_engine import lint_canonical_model
from .models import (
    ImportPreflightLint,
    ImportPreflightPolicy,
    ImportPreflightStyleGuide,
)
from .quality_rank_telemetry import observe_export_preflight
from .style_guide_engine import FALLBACK_GUIDE_SOURCE, CompiledStyleGuide, resolve_style_guide

logger = logging.getLogger(__name__)

__all__ = [
    "CAPABILITY_AXES",
    "READINESS_WEIGHTS",
    "READY_SCORE_THRESHOLD",
    "ExportPreflightCapability",
    "ExportPreflightReport",
    "ExportPreflightRequest",
    "ExportPreflightTarget",
    "SourceCapabilityDemand",
    "apply_instance_conformance",
    "capability_verdict",
    "lint_export_source",
    "rank_export_targets",
    "run_export_preflight",
    "source_capability_demand",
]

#: The six capability axes a :class:`~app.emitter.CapabilityProfile` declares, in report order.
#: A pre-flight only ever talks about the axes a *source* actually uses, so this is the
#: vocabulary of :class:`ExportPreflightCapability`, not a list of flags to render blindly.
CAPABILITY_AXES: Tuple[str, ...] = (
    "operations",
    "events",
    "unions",
    "nullability",
    "constraints",
    "field_identity",
)

#: How the composite readiness score mixes its three normalized 0–100 inputs. Fidelity leads
#: because it answers "how much of this source survives the trip"; source quality is next
#: because a D-grade source exports a D-grade artifact whatever the target; capability fit is
#: the tie-breaker that separates two targets whose predicted loss happens to land on the same
#: percentage. The weights sum to 1.0 — asserted by the test-suite, since a drifted sum would
#: silently rescale every rank.
READINESS_WEIGHTS: Dict[str, float] = {
    "fidelity": 0.50,
    "quality": 0.30,
    "capability": 0.20,
}

#: Composite score at or above which an otherwise-unobstructed target is banded ``ready``.
#: Below it the target is ``caution`` — usable, but the user should look at why first.
READY_SCORE_THRESHOLD = 80

#: Capability-fit contribution per verdict, on the same 0–100 scale as the other two inputs.
_CAPABILITY_FIT: Dict[str, int] = {
    "full": 100,
    "partial": 60,
    "schema_only": 20,
    "unavailable": 0,
}

#: Band ordering: usable targets first, then the ones a waiver could unblock, then the ones
#: this runtime cannot run at all. The index is the primary sort key.
_BAND_ORDER: Tuple[str, ...] = ("ready", "caution", "blocked", "unavailable")


# ===========================================================================
# Request / response models
# ===========================================================================


class ExportPreflightRequest(BaseModel):
    """A pre-flight request: the source revision, optionally narrowed to some targets."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id to export.")
    version: Optional[str] = Field(
        default=None,
        description="Revision UUID, version label (``1.0.0``), or null for the latest revision.",
    )
    targets: Optional[List[str]] = Field(
        default=None,
        description="Restrict the ranking to these target keys or format keys (``openapi`` / "
        "``openapi-3.1``); null ranks every registered target. Unknown entries are ignored — a "
        "pre-flight reports what it can rank rather than failing on a stale client's target list.",
    )
    include_findings: bool = Field(
        default=True,
        description="When false, the source lint verdict is returned without its ranked finding "
        "list (score, grade, and tallies are always present). Lets a target-grid caller skip the "
        "findings payload it does not render.",
    )
    include_conformance: bool = Field(
        default=False,
        description="When true, run the IXH-5.6 instance-conformance check per ranked target: "
        "source-valid instances (IXH-5.2) are validated against each target's actually-emitted "
        "schema, the per-target verdict is attached beside the fidelity envelope, and a "
        "``ready`` target whose emitted schema rejected instances is demoted to ``caution``. "
        "Off by default because it emits every ranked target for real — heavier than the "
        "prediction-only pre-flight.",
    )


class ExportPreflightCapability(BaseModel):
    """How well a target's declared capabilities cover what this source is made of.

    Answers a question the fidelity percentage cannot: *why* a target loses what it loses.
    ``preserved_percent`` of 60 reads very differently when the target simply cannot carry
    operations (a schema-only destination) than when it carries everything but drops a handful
    of validation facets.
    """

    model_config = ConfigDict(extra="forbid")

    verdict: Literal["full", "partial", "schema_only", "unavailable"] = Field(
        description="``full`` — the target declares every axis this source uses; ``partial`` — "
        "some are missing; ``schema_only`` — the source carries operations or events and the "
        "target carries neither, so only type shapes survive; ``unavailable`` — the emitter "
        "cannot run in this runtime, so no verdict can be given.",
    )
    required: List[str] = Field(
        default_factory=list,
        description="Capability axes this source actually uses (operations, events, unions, "
        "nullability, constraints, field_identity).",
    )
    supported: List[str] = Field(
        default_factory=list,
        description="Of those, the axes the target's capability profile declares it can carry.",
    )
    missing: List[str] = Field(
        default_factory=list,
        description="Of those, the axes the target cannot carry — the cause of the predicted loss.",
    )
    synthesized: List[str] = Field(
        default_factory=list,
        description="Axes the target *requires* that this source does not provide, so the "
        "emitter must invent them (protobuf field numbers for a source that has none).",
    )
    reason: str = Field(description="One-sentence explanation of the verdict.")


class ExportPreflightTarget(BaseModel):
    """One ranked export target: its inputs, its readiness, and why it ranks where it does."""

    model_config = ConfigDict(extra="forbid")

    rank: int = Field(description="1-based position in the readiness ranking.")
    key: str = Field(description="The target's registry key (``openapi``).")
    format: str = Field(description="The target's output format key (``openapi-3.1``).")
    descriptor: EmitterDescriptor = Field(description="The target emitter's descriptor.")
    capability_profile: CapabilityProfile = Field(
        description="The target's static capability declaration (MFX-1.1)."
    )
    readiness: int = Field(
        description="Composite 0–100 readiness score: a weighted mix of projected fidelity, "
        "source lint score, and capability fit. Comparable across targets of one pre-flight; "
        "not a quality score for the target itself.",
    )
    band: Literal["ready", "caution", "blocked", "unavailable"] = Field(
        description="``ready`` — go; ``caution`` — usable, look at the rationale first; "
        "``blocked`` — the tenant's export policy refuses this delivery; ``unavailable`` — the "
        "emitter cannot run in this runtime.",
    )
    blocked: bool = Field(
        description="True when the tenant's export policy blocks this target. Blocked targets "
        "are ranked and returned (never hidden) so the user sees the reason.",
    )
    selectable: bool = Field(
        description="Whether a client should let the user choose this target: false when the "
        "emitter is unavailable or policy blocks it.",
    )
    rationale: str = Field(
        description="One line explaining the rank in the user's terms — the fidelity outcome, "
        "the source grade, and any blocking reason.",
    )
    fidelity: TargetFidelity = Field(
        description="The projected fidelity envelope (tier, preserved %, DROP/APPROX/SYNTH "
        "counts) from the same prediction engine the export job embeds in its result.",
    )
    capability: ExportPreflightCapability = Field(
        description="The capability verdict for this source against this target.",
    )
    policy: ImportPreflightPolicy = Field(
        description="The tenant's export quality policy verdict for this source and target "
        "(IXH-2.3). Shares the import pre-flight's verdict shape — one policy engine, one "
        "response shape — and names its own ``scope`` (``export``).",
    )
    conformance: Optional[TargetConformance] = Field(
        default=None,
        description="The IXH-5.6 instance-level conformance verdict for this target — "
        "source-valid instances validated against the *actually emitted* schema — reported "
        "alongside the structural fidelity envelope. ``None`` unless the pre-flight was "
        "requested with ``include_conformance``.",
    )


class ExportPreflightReport(BaseModel):
    """The full export pre-flight: one source lint verdict plus every target, ranked."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the pre-flight ran for.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    paradigm: Optional[str] = Field(
        default=None, description="The source model's canonical paradigm (``rest``, ``event``…)."
    )
    format: Optional[str] = Field(
        default=None, description="The source model's format key (``openapi-3.1``)."
    )
    lint: ImportPreflightLint = Field(
        description="The source's lint verdict under the resolved style guide — the same engine "
        "and scoring formula an import pre-flight reports, run over the reconstructed source "
        "model rather than a candidate document.",
    )
    style_guide: Optional[ImportPreflightStyleGuide] = Field(
        default=None, description="The style guide that governed the lint, when one resolved."
    )
    capability_demand: List[str] = Field(
        default_factory=list,
        description="The capability axes this source uses — the yardstick every target's "
        "capability verdict is measured against.",
    )
    targets: List[ExportPreflightTarget] = Field(
        default_factory=list,
        description="Every ranked target, best readiness first. Blocked and unavailable targets "
        "are included (ranked last), never hidden.",
    )
    ranking_fingerprint: str = Field(
        description="Stable hash over the ranked (target, readiness, band) triples. Identical "
        "for two pre-flights of the same revision under the same guide and policy.",
    )


# ===========================================================================
# Source capability demand
# ===========================================================================


class SourceCapabilityDemand(BaseModel):
    """Which capability axes a source model actually exercises.

    Mirrors, axis for axis, the checks
    :class:`~app.fidelity_rulepack.CapabilityRulePack` makes when it decides whether a construct
    survives — so "the target is missing the ``unions`` axis" and "the prediction dropped the
    union types" are always the same statement seen from two directions. The predicates come
    *from the pack itself* (its event-kind set and its constraint test are imported, not
    re-declared) so the two can never drift apart.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    operations: bool = Field(default=False, description="Has at least one request/response operation.")
    events: bool = Field(default=False, description="Has an event channel or a publish/subscribe operation.")
    unions: bool = Field(default=False, description="Declares at least one union type.")
    nullability: bool = Field(default=False, description="Declares at least one non-null field.")
    constraints: bool = Field(default=False, description="Carries at least one validation facet.")
    field_identity: bool = Field(default=False, description="Carries at least one stable field number.")

    def axes(self) -> List[str]:
        """The demanded axes, in :data:`CAPABILITY_AXES` order."""
        return [axis for axis in CAPABILITY_AXES if getattr(self, axis)]


def source_capability_demand(api: CanonicalApi) -> SourceCapabilityDemand:
    """Determine which capability axes ``api`` exercises.

    Pure and cheap: one pass over the model's operations, channels, types, and fields, applying
    the same predicates the fidelity rule pack applies per construct.

    Args:
        api: The source canonical model.

    Returns:
        The axes this source needs a target to carry.
    """
    operations = False
    events = bool(api.channels)
    for service in api.services:
        for operation in service.operations:
            if operation.kind in _EVENT_OPERATION_KINDS:
                events = True
            else:
                operations = True

    unions = False
    nullability = False
    constraints = False
    field_identity = False
    for type_ in api.types:
        if type_.kind is TypeKind.UNION:
            unions = True
        if _has_any_constraint(type_.constraints):
            constraints = True
        for field in type_.fields:
            if field.type.nullable is False:
                nullability = True
            if _has_any_constraint(field.constraints):
                constraints = True
            if field.field_number is not None:
                field_identity = True

    return SourceCapabilityDemand(
        operations=operations,
        events=events,
        unions=unions,
        nullability=nullability,
        constraints=constraints,
        field_identity=field_identity,
    )


def capability_verdict(
    demand: SourceCapabilityDemand,
    profile: CapabilityProfile,
    *,
    target_label: str,
    available: bool,
    unavailable_reason: Optional[str] = None,
) -> ExportPreflightCapability:
    """Compare what a source needs against what a target declares it can carry.

    Args:
        demand: The source's capability demand from :func:`source_capability_demand`.
        profile: The target emitter's capability profile.
        target_label: Human label for the target, woven into the reason sentence.
        available: Whether the emitter can run in this runtime.
        unavailable_reason: The runtime's explanation when it cannot.

    Returns:
        The capability verdict, its axis lists, and a one-sentence reason.
    """
    if not available:
        return ExportPreflightCapability(
            verdict="unavailable",
            required=demand.axes(),
            reason=unavailable_reason
            or f"{target_label} is not available in this runtime, so its fit cannot be judged.",
        )

    required = demand.axes()
    supported = [axis for axis in required if getattr(profile, axis)]
    missing = [axis for axis in required if not getattr(profile, axis)]
    # A target that *requires* stable field numbers the source never had must invent them; that
    # is a synthesis, not a missing capability, so it is reported on its own axis list.
    synthesized = (
        ["field_identity"] if profile.field_identity and not demand.field_identity else []
    )

    if not missing:
        return ExportPreflightCapability(
            verdict="full",
            required=required,
            supported=supported,
            missing=missing,
            synthesized=synthesized,
            reason=f"{target_label} carries every construct class this source uses.",
        )

    carries_flows = profile.operations or profile.events
    if (demand.operations or demand.events) and not carries_flows:
        return ExportPreflightCapability(
            verdict="schema_only",
            required=required,
            supported=supported,
            missing=missing,
            synthesized=synthesized,
            reason=f"{target_label} keeps type shapes only — this source's operations and "
            "event flows have no representation there.",
        )

    return ExportPreflightCapability(
        verdict="partial",
        required=required,
        supported=supported,
        missing=missing,
        synthesized=synthesized,
        reason=f"{target_label} cannot carry {_join(missing)}; the rest of this source survives.",
    )


def _join(values: Sequence[str]) -> str:
    """Join axis names into a readable clause (``a``, ``a and b``, ``a, b and c``)."""
    items = list(values)
    if not items:
        return "nothing"
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} and {items[-1]}"


# ===========================================================================
# Source lint
# ===========================================================================


def lint_export_source(
    api: CanonicalApi, *, tenant_id: str, project_id: Optional[str] = None
) -> Tuple[LintReport, Optional[CompiledStyleGuide]]:
    """Lint an export source under the tenant's resolved style guide.

    Runs :func:`~app.lint_engine.lint_canonical_model` — the same engine, and therefore the same
    scoring formula, an import pre-flight and a committed import use — and re-scores the result
    under the guide GOV-1.4 resolves for ``(tenant, project)``. The in-code fallback guide is a
    no-op by construction, so it is skipped rather than applied.

    Strictly best-effort about the *guide*: a guide that cannot be resolved or applied leaves the
    default-scored report in place rather than failing the pre-flight, exactly as the import
    pipeline does.

    Args:
        api: The reconstructed source canonical model.
        tenant_id: The tenant whose style guide governs.
        project_id: The owning artifact/project, so a project-assigned guide wins (GOV-1.4).

    Returns:
        ``(report, guide)`` — the SPI-shaped lint report and the guide that produced it (``None``
        when guide resolution failed outright).
    """
    result = lint_canonical_model(api)
    guide: Optional[CompiledStyleGuide] = None
    try:
        guide = resolve_style_guide(tenant_id, project_id)
        if result.score is not None and guide.source != FALLBACK_GUIDE_SOURCE:
            result = guide.apply(result)
    except Exception:  # noqa: BLE001 - a guide fault must never fail a pre-flight
        logger.warning(
            "Style-guide application failed for export pre-flight (tenant %s); keeping default score",
            tenant_id,
            exc_info=True,
        )
    return LintReport.from_lint_result(result), guide


def _lint_model(report: LintReport, *, include_findings: bool) -> ImportPreflightLint:
    """Adapt a lint report into the response shape, ranking its findings the wizard's way."""
    return ImportPreflightLint(
        score=report.score,
        grade=report.grade,
        report_fingerprint=report.report_fingerprint,
        severity_counts=dict(report.severity_counts),
        rule_hits=dict(report.rule_hits),
        categories=list(report.categories),
        findings=rank_lint_findings(report) if include_findings else [],
    )


def _style_guide_model(guide: Optional[CompiledStyleGuide]) -> Optional[ImportPreflightStyleGuide]:
    """Adapt a compiled style guide into its response shape, or ``None`` when unresolved."""
    if guide is None:
        return None
    return ImportPreflightStyleGuide(
        guide_id=guide.guide_id,
        name=guide.name,
        source=guide.source,
        fingerprint=guide.fingerprint,
    )


# ===========================================================================
# Ranking
# ===========================================================================


def _selected_emitters(targets: Optional[Sequence[str]]) -> List[Tuple[Any, type[Emitter]]]:
    """Resolve the registry entries to rank, honouring an optional caller-supplied filter.

    Args:
        targets: Target keys or format keys to keep; ``None`` keeps every registered target.
            Unknown entries are ignored rather than rejected — a stale client asking for a
            target this build does not ship should still get a ranking for the rest.

    Returns:
        ``(registry entry, emitter class)`` pairs in registry (key) order.
    """
    wanted = {value.strip().lower() for value in targets or () if value and value.strip()}
    pairs: List[Tuple[Any, type[Emitter]]] = []
    for entry in describe_emit_targets():
        descriptor = entry.descriptor
        if wanted and descriptor.key.lower() not in wanted and descriptor.format.lower() not in wanted:
            continue
        emitter_cls = get_emitter(descriptor.format)
        if emitter_cls is None:  # pragma: no cover - registry/describe are always in sync
            continue
        pairs.append((entry, emitter_cls))
    return pairs


def _composite_score(*, fidelity: int, quality: Optional[int], capability: int) -> int:
    """Mix the three normalized inputs into the 0–100 composite, rounded to an integer.

    An **unscored** source (a lint that declined to score) contributes no quality term; its
    weight is redistributed across the remaining two rather than being counted as a zero, which
    would punish every target for a missing measurement.

    Args:
        fidelity: Projected preserved percentage, 0–100.
        quality: The source's lint score, or ``None`` when unscored.
        capability: The capability-fit contribution, 0–100.

    Returns:
        The composite readiness score, 0–100.
    """
    terms = [
        (READINESS_WEIGHTS["fidelity"], float(fidelity)),
        (READINESS_WEIGHTS["capability"], float(capability)),
    ]
    if quality is not None:
        terms.append((READINESS_WEIGHTS["quality"], float(quality)))
    total_weight = sum(weight for weight, _ in terms)
    if total_weight <= 0:  # pragma: no cover - the weights are constants and positive
        return 0
    score = sum(weight * value for weight, value in terms) / total_weight
    return max(0, min(100, round(score)))


def _band(
    *, available: bool, blocked: bool, readiness: int, policy_verdict: str
) -> str:
    """Classify a target into its readiness band (see :data:`_BAND_ORDER`)."""
    if not available:
        return "unavailable"
    if blocked:
        return "blocked"
    if readiness >= READY_SCORE_THRESHOLD and policy_verdict == "pass":
        return "ready"
    return "caution"


def _rationale(
    *,
    band: str,
    label: str,
    fidelity: TargetFidelity,
    capability: ExportPreflightCapability,
    grade: Optional[str],
    policy: ImportPreflightPolicy,
    unavailable_reason: Optional[str],
) -> str:
    """Compose the one-line explanation for a target's rank.

    The sentence always leads with the reason the target sits where it does — an unusable target
    explains why it is unusable, a usable one explains its fidelity — and then adds the source's
    grade, which is the input a user can act on without changing target.
    """
    if band == "unavailable":
        return unavailable_reason or f"{label} is not available in this runtime."
    if band == "blocked":
        return f"Blocked by the tenant export policy: {policy.reason}"

    if fidelity.tier.value == "lossless":
        head = f"Carries this source without loss ({fidelity.preserved_percent}% preserved)."
    elif capability.verdict == "schema_only":
        head = (
            f"Type shapes only: {fidelity.preserved_percent}% preserved, "
            f"{fidelity.dropped} construct(s) dropped."
        )
    else:
        head = (
            f"{fidelity.preserved_percent}% preserved — {fidelity.dropped} dropped, "
            f"{fidelity.approximated} approximated, {fidelity.synthesized} synthesized."
        )

    parts = [head]
    if grade:
        parts.append(f"Source grade {grade}.")
    if capability.missing:
        parts.append(f"{label} cannot carry {_join(capability.missing)}.")
    if policy.verdict == "warn":
        parts.append(policy.reason)
    return " ".join(parts)


def rank_export_targets(
    api: CanonicalApi,
    *,
    tenant_id: str,
    version_record_id: str,
    lint: LintReport,
    targets: Optional[Sequence[str]] = None,
) -> Tuple[List[ExportPreflightTarget], SourceCapabilityDemand]:
    """Rank every registered export target by readiness for ``api``.

    The pure core of the pre-flight: it emits nothing, persists nothing, and reads only the
    tenant's export policy (and any waiver) per target. Callers that already hold a canonical
    model — the route, the corpus reconciliation tests — use this directly.

    Args:
        api: The source canonical model.
        tenant_id: The tenant whose export policy governs.
        version_record_id: The source revision, used as the policy waiver's subject key.
        lint: The source's lint report (see :func:`lint_export_source`).
        targets: Optional target keys/format keys to restrict the ranking to.

    Returns:
        ``(ranked targets, capability demand)`` — the targets ordered best readiness first, with
        1-based ranks already assigned.
    """
    demand = source_capability_demand(api)
    # One policy read for the whole ranking: the tenant's policy is the same for every target
    # (per-format overrides are resolved from it in memory), so reading it per target would be
    # 30-odd identical queries per pre-flight.
    policy = load_tenant_policy(tenant_id)
    subject_key = subject_key_for_export(version_record_id)
    rows: List[Tuple[Tuple[int, int, str], ExportPreflightTarget]] = []

    for entry, emitter_cls in _selected_emitters(targets):
        descriptor = entry.descriptor
        profile = entry.capability_profile
        available = descriptor.available
        fidelity = build_target_fidelity(api, emitter_cls)
        capability = capability_verdict(
            demand,
            profile,
            target_label=descriptor.label,
            available=available,
            unavailable_reason=descriptor.unavailable_reason,
        )
        # The projected preserved percentage is the fidelity floor's input (IXH-2.5): the
        # pre-flight answers it from the prediction, the delivery gate from the job's own
        # envelope — the same number, so a target banded ``blocked`` here is refused there.
        verdict = evaluate_export_quality(
            tenant_id=tenant_id,
            target_key=descriptor.key,
            score=lint.score,
            grade=lint.grade,
            severity_counts=dict(lint.severity_counts),
            preserved_percent=fidelity.preserved_percent,
            subject_key=subject_key,
            policy=policy,
        )
        target_policy = verdict_response_model(verdict)
        readiness = _composite_score(
            fidelity=fidelity.preserved_percent,
            quality=lint.score,
            capability=_CAPABILITY_FIT[capability.verdict],
        )
        band = _band(
            available=available,
            blocked=target_policy.blocking,
            readiness=readiness,
            policy_verdict=target_policy.verdict,
        )
        target = ExportPreflightTarget(
            rank=0,  # assigned after the sort
            key=descriptor.key,
            format=descriptor.format,
            descriptor=descriptor,
            capability_profile=profile,
            readiness=readiness,
            band=band,
            blocked=target_policy.blocking,
            selectable=available and not target_policy.blocking,
            rationale=_rationale(
                band=band,
                label=descriptor.label,
                fidelity=fidelity,
                capability=capability,
                grade=lint.grade,
                policy=target_policy,
                unavailable_reason=descriptor.unavailable_reason,
            ),
            fidelity=fidelity,
            capability=capability,
            policy=target_policy,
        )
        # Band first, then the composite descending, then the key: a total order, so the
        # ranking is reproducible for a fixed revision, style guide, and policy.
        rows.append(((_BAND_ORDER.index(band), -readiness, descriptor.key), target))

    rows.sort(key=lambda row: row[0])
    ranked = [
        target.model_copy(update={"rank": position})
        for position, (_, target) in enumerate(rows, start=1)
    ]
    return ranked, demand


def _ranking_fingerprint(targets: Sequence[ExportPreflightTarget]) -> str:
    """Hash the ranked ``(key, readiness, band)`` triples into a stable ranking handle."""
    payload = json.dumps(
        [[target.key, target.readiness, target.band] for target in targets],
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_export_preflight(
    source: ExportSource,
    request: ExportPreflightRequest,
    *,
    tenant_id: str,
) -> ExportPreflightReport:
    """Build the full export pre-flight report for a loaded source revision (IXH-2.4).

    Lints the source once under the tenant's resolved style guide, ranks every registered
    target against it, and assembles the report. **No export job, artifact, or field-identity
    row is created** — the only writes anywhere on this path are none.

    Args:
        source: The loaded source revision (:func:`app.export_source.load_export_source`).
        request: The pre-flight request (target filter, findings toggle).
        tenant_id: The tenant the pre-flight runs for; selects the style guide and the policy.

    Returns:
        The assembled :class:`ExportPreflightReport`.
    """
    lint, guide = lint_export_source(
        source.api, tenant_id=tenant_id, project_id=source.artifact_id
    )
    targets, demand = rank_export_targets(
        source.api,
        tenant_id=tenant_id,
        version_record_id=source.version_record_id,
        lint=lint,
        targets=request.targets,
    )
    report = ExportPreflightReport(
        artifact=source.artifact_id,
        version=request.version,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
        paradigm=source.api.paradigm.value,
        format=source.api.format,
        lint=_lint_model(lint, include_findings=request.include_findings),
        style_guide=_style_guide_model(guide),
        capability_demand=demand.axes(),
        targets=targets,
        ranking_fingerprint=_ranking_fingerprint(targets),
    )
    # Append the readiness ranks to the quality-rank series (IXH-2.7). Only the head of the
    # ranking is recorded — see EXPORT_PREFLIGHT_RANK_SAMPLE — so a pre-flight over 30-odd
    # registered targets contributes a handful of rows rather than 30. Best-effort by contract:
    # the helper swallows and logs its own failures, so telemetry never fails a pre-flight.
    observe_export_preflight(report, tenant_id=tenant_id, project_id=source.artifact_id)
    return report


async def apply_instance_conformance(
    report: ExportPreflightReport,
    api: CanonicalApi,
    *,
    seed: int = 0,
) -> ExportPreflightReport:
    """Attach IXH-5.6 instance-conformance verdicts and fold them into the ranking.

    Runs :func:`app.cross_format_conformance.check_cross_format_conformance` once over the
    report's ranked target formats, attaches each :class:`TargetConformance` beside that
    target's structural fidelity envelope, and **feeds the result into the rank**: a target
    banded ``ready`` whose validator ran and rejected source-valid instances is demoted to
    ``caution`` (the band is the ranking's primary key, so the demotion reorders the list),
    with the failure counts appended to its rationale. The readiness *score* is untouched —
    it remains the weighted prediction mix — and so are ``blocked``/``unavailable`` bands,
    which already sit below ``caution``. Transcode failures never demote: they mean an
    instance could not be represented on the target wire, not that the emitted schema
    rejected it.

    Args:
        report: The assembled pre-flight report to enrich.
        api: The source canonical model the report was ranked from (instances are emitted
            and validated against this model's targets for real).
        seed: Synthesis seed forwarded to the conformance check.

    Returns:
        A new :class:`ExportPreflightReport` with per-target ``conformance``, re-sorted
        ranks, and a recomputed ``ranking_fingerprint``.
    """
    conformance = await check_cross_format_conformance(
        api, targets=[target.format for target in report.targets], seed=seed
    )
    by_format = {entry.target: entry for entry in conformance.targets}

    rows: List[Tuple[Tuple[int, int, str], ExportPreflightTarget]] = []
    for target in report.targets:
        entry = by_format.get(target.format)
        band = target.band
        rationale = target.rationale
        if entry is not None and entry.failed and band == "ready":
            band = "caution"
            rationale = (
                f"{rationale} Instance conformance: the emitted schema rejected "
                f"{entry.conformance_failures} check(s) across "
                f"{entry.instances_checked} source-valid instance(s)."
            )
        updated = target.model_copy(
            update={"conformance": entry, "band": band, "rationale": rationale}
        )
        # The same total order rank_export_targets uses: band, then composite descending,
        # then key — so the demotion feeds the rank exactly like any other band change.
        rows.append(((_BAND_ORDER.index(band), -updated.readiness, updated.key), updated))

    rows.sort(key=lambda row: row[0])
    ranked = [
        target.model_copy(update={"rank": position})
        for position, (_, target) in enumerate(rows, start=1)
    ]
    return report.model_copy(
        update={"targets": ranked, "ranking_fingerprint": _ranking_fingerprint(ranked)}
    )
