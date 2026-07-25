"""Export pre-flight engine tests — IXH-2.4 (#5099).

Covers the four things the ticket promises, at the engine level (the HTTP surface is
:mod:`test_export_preflight_routes`):

* a pre-flight **creates nothing** — no export job, no artifact, no emit;
* every target reports a readiness rank plus its four inputs (source lint grade, projected
  preserved %, capability verdict, policy verdict) and a human-readable rationale;
* the ranking is **deterministic** for a fixed source revision, style guide, and policy;
* a target the tenant's export policy blocks is **ranked and returned** with its reason, not
  hidden — and neither is a target whose emitter cannot run in this runtime.

Plus the reconciliation the acceptance criteria call for: on corpus entries, the pre-flight's
projected envelope equals the envelope an export job embeds in its result for the same inputs.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from corpus_adapter_support import KNOWN_IMPORT_BUGS, missing_tools, valid_entries
from corpus_snapshot import run_pipeline

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    _REGISTRY,
    CapabilityProfile,
    EmitResult,
    Emitter,
    get_emitter,
    register_emitter,
)
from app.export_fidelity import build_export_fidelity
from app.export_preflight import (
    CAPABILITY_AXES,
    READINESS_WEIGHTS,
    READY_SCORE_THRESHOLD,
    ExportPreflightRequest,
    capability_verdict,
    lint_export_source,
    rank_export_targets,
    run_export_preflight,
    source_capability_demand,
)
from app.export_source import ExportSource
from app.import_export_quality_policy import (
    DEFAULT_POLICY,
    QualityPolicy,
    QualityThresholds,
    subject_key_for_export,
)
from app.import_source import LintReport

_TENANT = "11111111-1111-4111-8111-111111111111"


# ===========================================================================
# Fixtures
# ===========================================================================


def _rest_api() -> CanonicalApi:
    """A REST source: one operation, one record type with a constrained non-null field."""
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Widget.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(min_length=1),
            )
        ],
    )
    operation = Operation(key="GET /widgets", name="listWidgets", kind=OperationKind.QUERY)
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        services=[Service(key="widgets", name="widgets", operations=[operation])],
        types=[widget],
    )


def _source(api: Optional[CanonicalApi] = None) -> ExportSource:
    """A loaded export source wrapping ``api`` (the REST source by default)."""
    return ExportSource(
        api=api if api is not None else _rest_api(),
        artifact_id="artifact-1",
        version_record_id="22222222-2222-4222-8222-222222222222",
        version_label="1.0.0",
    )


def _lint(score: int = 90, grade: str = "A", severity_counts: Optional[Dict[str, int]] = None) -> LintReport:
    """A lint report standing in for the source's verdict, with no findings attached."""
    return LintReport(
        score=score,
        grade=grade,
        report_fingerprint="fp-1",
        severity_counts=severity_counts or {},
    )


@pytest.fixture(autouse=True)
def _default_policy():
    """Run every test under the documented default policy unless it says otherwise.

    Keeps the suite off the live policy table: the engine reads the tenant policy once per
    ranking, and a test that cares about policy patches this to its own.
    """
    with patch("app.export_preflight.load_tenant_policy", return_value=DEFAULT_POLICY), patch(
        "app.import_export_quality_policy.load_tenant_policy", return_value=DEFAULT_POLICY
    ), patch("app.import_export_quality_policy.find_active_waiver", return_value=None):
        yield


@pytest.fixture(autouse=True)
def _fallback_style_guide():
    """Resolve the in-code fallback guide, so lint never depends on tenant rows."""
    from app.style_guide_engine import builtin_fallback_guide

    with patch("app.export_preflight.resolve_style_guide", return_value=builtin_fallback_guide()):
        yield


class _UnavailableEmitter(Emitter):
    """A registered target whose toolchain is missing in this runtime.

    Availability is derived from ``required_tools``, so naming a tool that cannot resolve is all
    it takes to make the descriptor report ``available = False`` with the runtime's own reason.
    """

    key = "preflight-unavailable"
    format = "preflight-unavailable-1"
    label = "Unavailable Target"
    description = "A target that cannot run here."
    icon = "file-x"
    paradigm = ApiParadigm.REST
    multi_file = False
    required_tools = ("apiome-preflight-missing-tool",)

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        return CapabilityProfile(
            operations=True, events=True, unions=True, nullability=True, constraints=True
        )

    def emit(self, api: CanonicalApi, *, opts: Any = None) -> EmitResult:  # pragma: no cover
        raise AssertionError("an unavailable emitter must never be asked to emit")


@pytest.fixture
def unavailable_target():
    """Register :class:`_UnavailableEmitter` for the duration of one test."""
    register_emitter(_UnavailableEmitter)
    try:
        yield _UnavailableEmitter
    finally:
        _REGISTRY.pop(_UnavailableEmitter.format, None)


# ===========================================================================
# Capability demand + verdict
# ===========================================================================


def test_capability_demand_reports_only_the_axes_the_source_uses():
    demand = source_capability_demand(_rest_api())
    assert demand.axes() == ["operations", "nullability", "constraints"]
    assert demand.events is False
    assert demand.unions is False
    assert demand.field_identity is False


def test_capability_demand_counts_channels_and_pubsub_as_events():
    api = _rest_api().model_copy(
        update={"channels": [Channel(key="orders", name="orders", address="orders")]}
    )
    assert source_capability_demand(api).events is True

    publish = Operation(key="publish", name="publish", kind=OperationKind.PUBLISH)
    api = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="orders"),
        services=[Service(key="s", name="s", operations=[publish])],
    )
    demand = source_capability_demand(api)
    assert demand.events is True
    assert demand.operations is False


def test_capability_demand_axes_are_the_declared_vocabulary():
    demand = source_capability_demand(_rest_api())
    assert set(demand.axes()) <= set(CAPABILITY_AXES)


def test_capability_verdict_full_when_the_target_carries_everything():
    demand = source_capability_demand(_rest_api())
    verdict = capability_verdict(
        demand,
        CapabilityProfile(operations=True, nullability=True, constraints=True),
        target_label="OpenAPI 3.1",
        available=True,
    )
    assert verdict.verdict == "full"
    assert verdict.missing == []
    assert verdict.supported == ["operations", "nullability", "constraints"]
    assert "carries every construct class" in verdict.reason


def test_capability_verdict_schema_only_when_the_target_carries_no_flows():
    demand = source_capability_demand(_rest_api())
    verdict = capability_verdict(
        demand,
        CapabilityProfile(nullability=True, constraints=True),
        target_label="Apache Avro",
        available=True,
    )
    assert verdict.verdict == "schema_only"
    assert verdict.missing == ["operations"]
    assert "type shapes only" in verdict.reason.lower()


def test_capability_verdict_partial_names_the_missing_axes():
    demand = source_capability_demand(_rest_api())
    verdict = capability_verdict(
        demand,
        CapabilityProfile(operations=True),
        target_label="Postman",
        available=True,
    )
    assert verdict.verdict == "partial"
    assert verdict.missing == ["nullability", "constraints"]
    assert "nullability and constraints" in verdict.reason


def test_capability_verdict_reports_synthesized_axes():
    demand = source_capability_demand(_rest_api())
    verdict = capability_verdict(
        demand,
        CapabilityProfile(operations=True, nullability=True, constraints=True, field_identity=True),
        target_label="Protobuf",
        available=True,
    )
    assert verdict.synthesized == ["field_identity"]


def test_capability_verdict_unavailable_carries_the_runtime_reason():
    verdict = capability_verdict(
        source_capability_demand(_rest_api()),
        CapabilityProfile(operations=True),
        target_label="Protobuf",
        available=False,
        unavailable_reason="protoc is not installed.",
    )
    assert verdict.verdict == "unavailable"
    assert verdict.reason == "protoc is not installed."


# ===========================================================================
# Ranking
# ===========================================================================


def test_readiness_weights_sum_to_one():
    assert pytest.approx(sum(READINESS_WEIGHTS.values()), abs=1e-9) == 1.0


def test_every_target_reports_its_ranking_inputs_and_a_rationale():
    targets, demand = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )

    assert targets, "the registry ships targets to rank"
    assert demand.axes()
    for target in targets:
        assert 0 <= target.readiness <= 100
        assert target.band in {"ready", "caution", "blocked", "unavailable"}
        assert target.rationale.strip()
        assert target.fidelity.preserved_percent >= 0
        assert target.capability.verdict in {"full", "partial", "schema_only", "unavailable"}
        assert target.policy.scope == "export"
        assert target.policy.verdict in {"pass", "warn", "block"}


def test_ranks_are_dense_and_ordered_by_band_then_score():
    targets, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )
    assert [target.rank for target in targets] == list(range(1, len(targets) + 1))

    bands = ["ready", "caution", "blocked", "unavailable"]
    keys = [(bands.index(target.band), -target.readiness, target.key) for target in targets]
    assert keys == sorted(keys)


def test_lossless_targets_outrank_lossy_ones():
    targets, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )
    by_key = {target.key: target for target in targets}
    assert by_key["openapi"].rank < by_key["avro"].rank
    assert by_key["openapi"].fidelity.tier.value == "lossless"
    assert by_key["avro"].capability.verdict == "schema_only"


def test_ranking_is_deterministic_for_a_fixed_revision():
    first = run_export_preflight(_source(), ExportPreflightRequest(artifact="artifact-1"), tenant_id=_TENANT)
    second = run_export_preflight(_source(), ExportPreflightRequest(artifact="artifact-1"), tenant_id=_TENANT)
    assert first.ranking_fingerprint == second.ranking_fingerprint
    assert first.model_dump() == second.model_dump()


def test_a_worse_source_grade_lowers_every_readiness_score():
    good, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint(score=95, grade="A")
    )
    poor, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint(score=40, grade="F")
    )
    good_by_key = {target.key: target.readiness for target in good}
    for target in poor:
        assert target.readiness < good_by_key[target.key]


def test_an_unscored_source_redistributes_the_quality_weight():
    """A lint that declined to score must not read as a zero-quality source."""
    unscored, _ = rank_export_targets(
        _rest_api(),
        tenant_id=_TENANT,
        version_record_id="rev-1",
        lint=LintReport(score=None, grade=None),
    )
    zero, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint(score=0, grade="F")
    )
    unscored_by_key = {target.key: target.readiness for target in unscored}
    for target in zero:
        assert unscored_by_key[target.key] > target.readiness


def test_target_filter_narrows_the_ranking_and_ignores_unknown_keys():
    targets, _ = rank_export_targets(
        _rest_api(),
        tenant_id=_TENANT,
        version_record_id="rev-1",
        lint=_lint(),
        targets=["avro", "not-a-target"],
    )
    assert [target.key for target in targets] == ["avro"]


def test_target_filter_accepts_format_keys():
    targets, _ = rank_export_targets(
        _rest_api(),
        tenant_id=_TENANT,
        version_record_id="rev-1",
        lint=_lint(),
        targets=[get_emitter("openapi-3.1").format],
    )
    assert [target.key for target in targets] == ["openapi"]


def test_unavailable_targets_rank_last_and_are_not_selectable(unavailable_target):
    targets, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )
    entry = next(target for target in targets if target.key == _UnavailableEmitter.key)
    assert entry.rank == len(targets)
    assert entry.band == "unavailable"
    assert entry.selectable is False
    assert entry.capability.verdict == "unavailable"
    assert entry.rationale == _UnavailableEmitter.descriptor().unavailable_reason


# ===========================================================================
# Policy
# ===========================================================================


def _blocking_policy() -> QualityPolicy:
    """A tenant policy that refuses any export below grade B."""
    return QualityPolicy(
        policy_version_id="policy-1",
        version_number=1,
        content_fingerprint="fp-policy-1",
        export_thresholds=QualityThresholds(min_grade="B", enforcement="block"),
        override_roles=("tenant-administrator",),
        is_default=False,
    )


def test_policy_blocked_targets_are_ranked_and_returned_with_their_reason():
    with patch("app.export_preflight.load_tenant_policy", return_value=_blocking_policy()):
        targets, _ = rank_export_targets(
            _rest_api(),
            tenant_id=_TENANT,
            version_record_id="rev-1",
            lint=_lint(score=42, grade="D"),
        )

    assert targets, "blocked targets are ranked, never dropped"
    for target in targets:
        assert target.blocked is True
        assert target.band == "blocked"
        assert target.selectable is False
        assert target.policy.verdict == "block"
        assert target.rationale.startswith("Blocked by the tenant export policy:")
        assert target.policy.failures, "the missed floor is itemized"


def test_a_waiver_downgrades_the_block_and_restores_selectability():
    waiver = {"id": "waiver-1", "actor_label": "Dana", "expires_at": "2030-01-01T00:00:00Z"}
    with patch("app.export_preflight.load_tenant_policy", return_value=_blocking_policy()), patch(
        "app.import_export_quality_policy.find_active_waiver", return_value=waiver
    ) as lookup:
        targets, _ = rank_export_targets(
            _rest_api(),
            tenant_id=_TENANT,
            version_record_id="rev-1",
            lint=_lint(score=42, grade="D"),
            targets=["avro"],
        )

    entry = targets[0]
    assert entry.blocked is False
    assert entry.policy.verdict == "warn"
    assert entry.policy.waiver_id == "waiver-1"
    assert entry.selectable is True
    lookup.assert_called_once()
    assert lookup.call_args.kwargs["subject_key"] == subject_key_for_export("rev-1")


def test_the_default_policy_never_looks_up_a_waiver():
    """No floor means no block means nothing a waiver could change — so no query is made."""
    with patch("app.import_export_quality_policy.find_active_waiver") as lookup:
        rank_export_targets(
            _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
        )
    lookup.assert_not_called()


# ===========================================================================
# Report assembly
# ===========================================================================


def test_report_carries_the_source_lint_verdict_and_style_guide():
    report = run_export_preflight(
        _source(), ExportPreflightRequest(artifact="artifact-1"), tenant_id=_TENANT
    )
    assert report.version_record_id == "22222222-2222-4222-8222-222222222222"
    assert report.version_label == "1.0.0"
    assert report.paradigm == "rest"
    assert report.format == "openapi-3.1"
    assert report.lint.score is not None and report.lint.grade
    assert report.style_guide is not None and report.style_guide.source == "fallback"
    assert report.capability_demand == ["operations", "nullability", "constraints"]
    assert report.targets[0].rank == 1


def test_findings_are_ranked_and_can_be_omitted():
    with_findings = run_export_preflight(
        _source(), ExportPreflightRequest(artifact="artifact-1"), tenant_id=_TENANT
    )
    without = run_export_preflight(
        _source(),
        ExportPreflightRequest(artifact="artifact-1", include_findings=False),
        tenant_id=_TENANT,
    )
    assert with_findings.lint.findings, "the sample source has documentation findings"
    assert [finding.rank for finding in with_findings.lint.findings] == list(
        range(1, len(with_findings.lint.findings) + 1)
    )
    assert without.lint.findings == []
    assert without.lint.score == with_findings.lint.score


def test_preflight_emits_nothing_and_persists_nothing():
    """A pre-flight must not reach the emit path or any persistence helper."""
    with patch("app.export_service.emit_canonical") as emit, patch(
        "app.export_dispatch.dispatch_from_source"
    ) as dispatch, patch("app.field_identity_store.persist_field_number_assignments") as persist:
        run_export_preflight(
            _source(), ExportPreflightRequest(artifact="artifact-1"), tenant_id=_TENANT
        )
    emit.assert_not_called()
    dispatch.assert_not_called()
    persist.assert_not_called()


def test_a_style_guide_fault_leaves_the_default_score_in_place():
    with patch("app.export_preflight.resolve_style_guide", side_effect=RuntimeError("boom")):
        report, guide = lint_export_source(_rest_api(), tenant_id=_TENANT)
    assert guide is None
    assert report.score is not None


def test_ready_band_requires_the_score_threshold():
    targets, _ = rank_export_targets(
        _rest_api(), tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )
    for target in targets:
        if target.band == "ready":
            assert target.readiness >= READY_SCORE_THRESHOLD
        elif target.band == "caution":
            assert target.readiness < READY_SCORE_THRESHOLD or target.policy.verdict != "pass"


# ===========================================================================
# Reconciliation with the job's fidelity report (corpus)
# ===========================================================================


def _reconcilable_entries(limit: int = 12) -> List[Any]:
    """A deterministic slice of runnable corpus entries, one per adapter at most.

    The reconciliation claim is about the *engine*, not about any one fixture, so one entry per
    adapter is enough to cover every source shape the corpus can build while keeping the suite
    fast. Entries this runtime cannot import (missing tool, known adapter bug) are skipped by
    the same gates the other corpus suites use.
    """
    seen: set[str] = set()
    picked: List[Any] = []
    for entry in sorted(valid_entries(), key=lambda e: e.path):
        if entry.adapter_key in seen:
            continue
        if entry.path in KNOWN_IMPORT_BUGS or missing_tools(entry.adapter_key):
            continue
        seen.add(entry.adapter_key)
        picked.append(entry)
        if len(picked) >= limit:
            break
    return picked


@pytest.mark.parametrize("entry", _reconcilable_entries(), ids=lambda e: e.path)
def test_preflight_fidelity_reconciles_with_the_job_envelope(entry):
    """The pre-flight's projected envelope equals the one an export job embeds in its result.

    The job attaches :func:`app.export_fidelity.build_export_fidelity`; the pre-flight reports
    the cheap :func:`~app.export_fidelity.build_target_fidelity` summary for every target. Both
    read the same prediction engine, and this asserts they agree construct for construct — so a
    user who acts on the ranking gets the fidelity the ranking promised.
    """
    model = run_pipeline(entry).model
    targets, _ = rank_export_targets(
        model, tenant_id=_TENANT, version_record_id="rev-1", lint=_lint()
    )
    assert targets

    for target in targets:
        emitter_cls = get_emitter(target.format)
        job_envelope = build_export_fidelity(model, emitter_cls)
        assert target.fidelity == job_envelope.summary, (
            f"{entry.path} → {target.key}: pre-flight fidelity diverged from the job's envelope"
        )
        assert target.fidelity.preserved_percent == job_envelope.summary.preserved_percent
