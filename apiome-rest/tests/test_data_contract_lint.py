"""Unit tests for the data-contract lint rule pack — FMT-5.5 (#5443).

Organised around the ticket's four acceptance criteria:

#. a ``data_schema``-paradigm item is scored by the data-contract pack, not the API pack;
#. each rule has an id, severity, message, remediation text and a fixture;
#. the pack is selectable as a style guide and re-scores on application;
#. scores for existing API-paradigm items are unchanged.

Plus the two things the scope statement asks for beyond them: the pack is wired into the
axis-score model as the data-schema paradigm's ruleset, and the built-in style guide the
database seeds actually enables its rules (without which every finding would be dropped).

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Mapping

import pytest

from app.axis_score import (
    AXIS_QUALITY,
    AXIS_SUPPORTABILITY,
    DATA_CONTRACT_RULESET_ID,
    GOVERNANCE_CATEGORY,
    REASON_SUPPORTABILITY,
    axis_key_for_finding,
    catalog_axis_evaluation,
)
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from app.data_contract_facts import (
    CONTRACT_FORMATS,
    SCHEMA_ONLY_FORMATS,
    ContractFacts,
    describes_a_data_contract,
    read_contract_facts,
)
from app.data_contract_lint import (
    DATA_CONTRACT_CATEGORIES,
    DATA_CONTRACT_PACK_ID,
    DATA_CONTRACT_RULES,
    DESCRIPTION_COVERAGE_THRESHOLD,
    DataContractRulePack,
)
from app.lint_engine import (
    available_lint_paradigms,
    get_paradigm_rule_pack,
    lint_canonical_model,
    register_paradigm_rule_pack,
)
from app.lint_rule_registry import builtin_rule_descriptors
from app.scanner_evaluation_corpus import load_fixture, load_manifest, run_fixture
from app.scanner_rule_transparency import enrich_rule_dict
from app.style_guide_engine import (
    apply_style_guide_to_canonical_result,
    builtin_fallback_guide,
    compile_style_guide,
)

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples"
RESEED_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "apiome-db"
    / "scripts"
    / "V246__style_guide_builtin_reseed_5443.sql"
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _import(adapter_key: str, relative: str) -> CanonicalApi:
    """Import a shipped corpus fixture through its real adapter."""
    from app.import_source import get_import_source, load_builtin_import_sources

    load_builtin_import_sources()
    path = CORPUS / relative
    assert path.is_file(), f"corpus fixture {relative} is missing"
    adapter = get_import_source(adapter_key)
    return adapter.normalize(adapter.parse(path.read_text(encoding="utf-8"), source_label=relative))


@pytest.fixture(scope="module")
def rich_contract() -> CanonicalApi:
    """An ODCS contract that states ownership, SLAs, quality rules, servers and classification."""
    return _import("odcs", "odcs/04-stress-quality-sla-and-custom.yaml")


@pytest.fixture(scope="module")
def bare_contract() -> CanonicalApi:
    """A minimal ODCS contract that states almost none of the governance facts."""
    return _import("odcs", "odcs/01-minimal-contract.yaml")


@pytest.fixture(scope="module")
def dbt_project() -> CanonicalApi:
    """A dbt project — a second data format, to prove the pack is not ODCS-specific."""
    return _import("dbt", "dbt/04-stress-contracts-sources-and-exposures.yml")


@pytest.fixture(scope="module")
def graphql_api() -> CanonicalApi:
    """A graph-paradigm artifact: the pack must never touch it."""
    return _import("graphql", "graphql/10-comprehensive-ecommerce.graphql")


def _rules(result: Any) -> List[str]:
    """Sorted data-contract rule ids a lint result carries."""
    return sorted({f.rule for f in result.findings if f.rule.startswith("data-contract.")})


def _api(
    *,
    paradigm: ApiParadigm = ApiParadigm.DATA_SCHEMA,
    extras: Mapping[str, Any] | None = None,
    types: List[Type] | None = None,
    version: str | None = "1.0.0",
) -> CanonicalApi:
    """Build a hand-authored canonical artifact for a single-rule assertion."""
    return CanonicalApi(
        paradigm=paradigm,
        format="odcs",
        identity=ApiIdentity(name="orders"),
        version=version,
        types=list(types or []),
        extras=dict(extras or {}),
    )


def _field(name: str, *, description: str | None = None, **extras: Any) -> CanonicalField:
    """Build a canonical field with the extras a data reader would have written."""
    return CanonicalField(
        key=f"orders.{name}",
        name=name,
        type=TypeRef(name="string"),
        description=description,
        extras=dict(extras),
    )


def _record(*fields: CanonicalField, key: str = "orders") -> Type:
    """Build a canonical record type from fields."""
    return Type(key=key, name=key, kind=TypeKind.RECORD, fields=list(fields))


# ===========================================================================
# 1. A data_schema item is scored by the data-contract pack
# ===========================================================================


def test_the_pack_is_registered_against_the_data_schema_paradigm() -> None:
    """AC1: dispatch is on paradigm, which is the dimension the ticket names."""
    assert available_lint_paradigms() == ["data_schema"]
    assert get_paradigm_rule_pack(ApiParadigm.DATA_SCHEMA) is DataContractRulePack
    # The enum member and its string value must resolve to the same pack: `str(member)` of a
    # str-Enum renders as `ApiParadigm.DATA_SCHEMA`, which is exactly how a paradigm pack
    # silently stops running.
    assert get_paradigm_rule_pack("data_schema") is DataContractRulePack


def test_a_data_schema_item_is_scored_by_the_pack(bare_contract: CanonicalApi) -> None:
    """AC1: the rules actually run for a data-schema artifact."""
    result = lint_canonical_model(bare_contract)
    assert _rules(result), "no data-contract rule fired for a data-schema artifact"
    assert GOVERNANCE_CATEGORY in {c.name for c in result.categories}


def test_the_pack_runs_for_every_data_format_not_just_odcs(dbt_project: CanonicalApi) -> None:
    """AC1: a paradigm pack is format-agnostic, so a dbt project is scored the same way."""
    assert dbt_project.format == "dbt"
    assert _rules(lint_canonical_model(dbt_project))


def test_an_api_paradigm_item_is_never_touched(graphql_api: CanonicalApi) -> None:
    """AC4: the pack must not reach a graph/REST/RPC artifact."""
    result = lint_canonical_model(graphql_api)
    assert _rules(result) == []
    assert GOVERNANCE_CATEGORY not in {c.name for c in result.categories}


def test_scores_for_api_paradigm_items_are_unchanged(graphql_api: CanonicalApi) -> None:
    """AC4, stated as the invariant that matters: the score and fingerprint do not move.

    Asserted by reproducing the pre-FMT-5.5 assembly — the unconditional packs plus the
    format pack, with no base categories — and requiring byte equality with what the engine
    now produces.
    """
    from app.lint_engine import get_rule_pack, unconditional_rule_packs
    from app.schema_lint import assemble_lint_result

    findings = []
    for pack in unconditional_rule_packs():
        findings.extend(pack.lint(graphql_api))
    pack_cls = get_rule_pack(graphql_api.format)
    if pack_cls is not None:
        findings.extend(pack_cls().lint(graphql_api))
    expected = assemble_lint_result(findings)

    actual = lint_canonical_model(graphql_api)
    assert actual.score == expected.score
    assert actual.grade == expected.grade
    assert actual.report_fingerprint == expected.report_fingerprint


def test_a_clean_contract_still_publishes_the_category_bars(rich_contract: CanonicalApi) -> None:
    """A pack whose bars vanish when clean cannot be told from one that never ran."""
    result = lint_canonical_model(rich_contract)
    names = {c.name for c in result.categories}
    assert set(DATA_CONTRACT_CATEGORIES) <= names


def test_a_well_governed_contract_trips_almost_nothing(rich_contract: CanonicalApi) -> None:
    """The pack must reward a contract that does state its governance facts."""
    fired = _rules(lint_canonical_model(rich_contract))
    assert "data-contract.owner-missing" not in fired
    assert "data-contract.sla-missing" not in fired
    assert "data-contract.server-missing" not in fired
    assert "data-contract.classification-missing" not in fired


def test_a_bare_contract_trips_the_governance_rules(bare_contract: CanonicalApi) -> None:
    """And must report a contract that states none of them."""
    fired = set(_rules(lint_canonical_model(bare_contract)))
    assert {
        "data-contract.owner-missing",
        "data-contract.sla-missing",
        "data-contract.server-missing",
        "data-contract.classification-missing",
    } <= fired


# ===========================================================================
# The gate: a schema language is not a data contract
# ===========================================================================


def test_a_schema_language_is_not_scored_as_a_data_contract() -> None:
    """Avro, XSD, RELAX NG and friends have no syntax for an owner or an SLA.

    Reporting those as missing would be reporting a capability limit of the *format* as a
    defect of the *document* — a dozen unfixable findings on every such artifact in every
    catalog — so the pack self-gates to nothing, publishing no findings and no bars.
    """
    avro = _import("avro", "avro/02-order-record.avsc")
    assert avro.paradigm is ApiParadigm.DATA_SCHEMA
    assert not describes_a_data_contract(avro)
    result = lint_canonical_model(avro)
    assert _rules(result) == []
    assert GOVERNANCE_CATEGORY not in {c.name for c in result.categories}


def test_a_gated_artifact_leaves_supportability_not_assessed() -> None:
    """Self-gated must read as *never scored*, not as *scored and clean*."""
    avro = _import("avro", "avro/02-order-record.avsc")
    report = lint_canonical_model(avro).report_dict()
    axes = {a["key"]: a for a in catalog_axis_evaluation(report).as_dict()["axes"]}
    assert axes[AXIS_SUPPORTABILITY]["assessed"] is False


def test_the_gate_is_an_allow_list() -> None:
    """The paradigm is a property of the document, so a deny-list would rope in artifacts
    nobody triaged — a WIT file of types only normalizes to `data_schema` too."""
    assert describes_a_data_contract(_api()) is True  # format="odcs"
    for fmt in ("wit", "avro", "xsd", "kafka-connect", "brand-new-reader"):
        artifact = CanonicalApi(
            paradigm=ApiParadigm.DATA_SCHEMA, format=fmt, identity=ApiIdentity(name="x")
        )
        assert describes_a_data_contract(artifact) is False, fmt


def test_every_data_schema_format_is_classified() -> None:
    """A new data-schema reader must be triaged into one set or the other.

    This is the pressure that stops the next data-contract format (FMT-5.6's SQL DDL, say)
    from shipping with no governance coverage and nobody noticing.
    """
    from app.import_source import describe_import_sources, load_builtin_import_sources

    load_builtin_import_sources()
    declared = {
        d.key
        for d in describe_import_sources()
        if getattr(d, "paradigm", None) is ApiParadigm.DATA_SCHEMA
    }
    classified = CONTRACT_FORMATS | SCHEMA_ONLY_FORMATS
    assert declared <= classified, (
        "unclassified data-schema formats — add each to CONTRACT_FORMATS or "
        f"SCHEMA_ONLY_FORMATS in app.data_contract_facts: {sorted(declared - classified)}"
    )
    assert not (CONTRACT_FORMATS & SCHEMA_ONLY_FORMATS)


# ===========================================================================
# 2. Each rule: id, severity, message, remediation, fixture
# ===========================================================================


def test_every_rule_declares_an_id_category_severity_and_rationale() -> None:
    """AC2, the engine half."""
    rules = {rule.rule_id: rule for rule in DataContractRulePack().rules()}
    assert set(rules) == set(DATA_CONTRACT_RULES)
    for rule_id, rule in rules.items():
        meta = DATA_CONTRACT_RULES[rule_id]
        assert rule_id.startswith("data-contract.")
        assert rule.category == meta.category
        assert rule.severity == meta.severity
        assert rule.description == meta.rationale
        assert rule.category in DATA_CONTRACT_CATEGORIES


def test_no_rule_ships_blocking() -> None:
    """A pack does not get to fail every existing catalog item's gate on upgrade.

    A tenant that wants these binding raises the severity in a style guide; that is the
    documented mechanism and it is asserted below.
    """
    assert {meta.severity for meta in DATA_CONTRACT_RULES.values()} <= {"warning", "info"}


def test_every_rule_publishes_remediation_and_a_fixture() -> None:
    """AC2, the catalogue half — through the same payload ``GET /v1/lint/rules`` returns."""
    descriptors = {d.rule_id: d for d in builtin_rule_descriptors() if d.pack == DATA_CONTRACT_PACK_ID}
    assert set(descriptors) == set(DATA_CONTRACT_RULES)
    for rule_id, descriptor in descriptors.items():
        payload = descriptor.as_dict()
        assert payload["remediation"] == DATA_CONTRACT_RULES[rule_id].remediation
        assert payload["fixture_id"] == DATA_CONTRACT_RULES[rule_id].fixture_id
        assert payload["docs_anchor"] == rule_id.replace(".", "-")
        assert payload["reference"].endswith(payload["docs_anchor"])


def test_pack_transparency_never_overrides_a_blocking_rule() -> None:
    """The CLX-4.3 catalogue stays authoritative for anything that can fail a gate."""
    payload = enrich_rule_dict({"rule_id": "compatibility.breaking"})
    assert payload["fixture_id"] == "catalog/compatibility-breaking"
    assert "false_positive_guidance" in payload


def test_every_rule_has_a_fixture_that_makes_it_fire() -> None:
    """AC2, the fixture half: a rule with no reproducing fixture is an untested claim."""
    manifest = {entry["id"]: entry for entry in load_manifest()["fixtures"]}
    for rule_id, meta in DATA_CONTRACT_RULES.items():
        entry = manifest.get(meta.fixture_id)
        assert entry is not None, f"{rule_id}: no manifest entry for {meta.fixture_id}"
        assert entry["expected_rule_ids"] == [rule_id]
        _blocking, findings = run_fixture(load_fixture(meta.fixture_id))
        assert rule_id in {f["rule"] for f in findings}


def test_the_compliant_fixture_trips_nothing_at_all() -> None:
    """The strongest evidence the pack is honest: a contract that states everything is clean.

    Without this, every rule firing on its own fixture proves only that the rules fire.
    """
    _blocking, findings = run_fixture(load_fixture("catalog/data-contract-clean"))
    fired = sorted({f["rule"] for f in findings if f["rule"].startswith("data-contract.")})
    assert fired == []


def test_every_rule_message_names_the_defect_not_the_rule() -> None:
    """A finding a reader cannot act on is a finding they ignore."""
    for finding in lint_canonical_model(_api()).findings:
        if not finding.rule.startswith("data-contract."):
            continue
        assert len(finding.message) > 40
        assert finding.rule not in finding.message


# ===========================================================================
# 3. Selectable as a style guide, and re-scores on application
# ===========================================================================


def test_the_rules_are_in_the_builtin_rule_catalogue() -> None:
    """AC3: a guide can only govern rules the GOV-1.2 registry lists."""
    catalogued = {d.rule_id for d in builtin_rule_descriptors()}
    assert set(DATA_CONTRACT_RULES) <= catalogued


def test_the_in_code_fallback_guide_enables_every_rule() -> None:
    """A guide that omits a registry rule silently drops its findings — including these."""
    guide = builtin_fallback_guide()
    for rule_id, meta in DATA_CONTRACT_RULES.items():
        assert guide.is_enabled(rule_id), f"{rule_id} is not enabled by the fallback guide"
        assert guide.severity_for(rule_id) == meta.severity


def test_a_guide_that_disables_the_pack_rescoring_removes_its_findings(
    bare_contract: CanonicalApi,
) -> None:
    """AC3: applying a guide re-scores, and dropping the pack raises the score."""
    result = lint_canonical_model(bare_contract)
    assert _rules(result)

    rows = [
        {"rule_id": d.rule_id, "enabled": True, "severity": d.default_severity}
        for d in builtin_rule_descriptors()
        if not d.rule_id.startswith("data-contract.")
    ]
    guide = compile_style_guide(None, "No data contract", "custom", rows)
    rescored = apply_style_guide_to_canonical_result(result, guide, bare_contract)

    assert _rules(rescored) == []
    assert rescored.score > result.score


def test_a_guide_can_make_the_pack_binding_before_publish(bare_contract: CanonicalApi) -> None:
    """AC3 / the scope statement: "so a tenant can require it before publish".

    The rules ship advisory; a tenant that requires a data contract raises them to ``error``
    in its guide, and re-scoring is what turns that into a gate-failing report.
    """
    result = lint_canonical_model(bare_contract)
    assert result.severity_counts.get("error", 0) == 0

    rows = [
        {
            "rule_id": d.rule_id,
            "enabled": True,
            "severity": "error" if d.rule_id.startswith("data-contract.") else d.default_severity,
        }
        for d in builtin_rule_descriptors()
    ]
    guide = compile_style_guide(None, "Data contract required", "custom", rows)
    rescored = apply_style_guide_to_canonical_result(result, guide, bare_contract)

    assert rescored.severity_counts["error"] > 0
    assert rescored.score < result.score
    assert all(
        f.severity == "error" for f in rescored.findings if f.rule.startswith("data-contract.")
    )


def test_the_seeded_builtin_guide_matches_the_live_rule_registry() -> None:
    """The database's builtin guide must enable exactly the registry, or findings vanish.

    ``CompiledStyleGuide.apply`` drops a finding whose rule is registered but absent from the
    guide. V159 seeded a static list that every pack shipped since silently fell out of; V246
    re-seeds from the full registry. This is the check that stops it drifting again — and it
    lives here because apiome-rest is the only place that can read the registry.
    """
    assert RESEED_MIGRATION.is_file(), f"missing re-seed migration: {RESEED_MIGRATION}"
    seeded: Dict[str, str] = dict(
        re.findall(
            r"^\s*\('([A-Za-z0-9.\-]+)',\s*'(error|warning|info)'\)",
            RESEED_MIGRATION.read_text(encoding="utf-8"),
            re.M,
        )
    )
    live = {d.rule_id: d.default_severity for d in builtin_rule_descriptors()}
    assert set(seeded) == set(live), (
        f"seed/registry drift — missing from seed: {sorted(set(live) - set(seeded))}; "
        f"stale in seed: {sorted(set(seeded) - set(live))}"
    )
    assert seeded == live, "a seeded severity disagrees with the rule's default"


# ===========================================================================
# The axis-score wiring
# ===========================================================================


def test_governance_findings_score_the_supportability_axis(bare_contract: CanonicalApi) -> None:
    """Scope: "wire it into the axis-score model as a data-schema-paradigm ruleset"."""
    report = lint_canonical_model(bare_contract).report_dict()
    axes = {axis["key"]: axis for axis in catalog_axis_evaluation(report).as_dict()["axes"]}
    supportability = axes[AXIS_SUPPORTABILITY]
    assert supportability["assessed"] is True
    assert supportability["ruleset"] == DATA_CONTRACT_RULESET_ID
    assert supportability["score"] < 100
    assert supportability["severity_counts"]["warning"] > 0


def test_a_clean_contract_scores_supportability_100(rich_contract: CanonicalApi) -> None:
    """Assessed-and-clean and never-assessed must not collapse into the same reading."""
    from app.schema_lint import assemble_lint_result

    result = assemble_lint_result([], base_categories=DATA_CONTRACT_CATEGORIES)
    axes = {a["key"]: a for a in catalog_axis_evaluation(result.report_dict()).as_dict()["axes"]}
    assert axes[AXIS_SUPPORTABILITY]["assessed"] is True
    assert axes[AXIS_SUPPORTABILITY]["score"] == 100
    # And the real contract, which is clean of governance findings, agrees.
    report = lint_canonical_model(rich_contract).report_dict()
    live = {a["key"]: a for a in catalog_axis_evaluation(report).as_dict()["axes"]}
    assert live[AXIS_SUPPORTABILITY]["score"] == 100


def test_an_api_paradigm_report_leaves_supportability_not_assessed(
    graphql_api: CanonicalApi,
) -> None:
    """AC4 again, on the axis surface: nothing about an API report may change."""
    report = lint_canonical_model(graphql_api).report_dict()
    axes = {a["key"]: a for a in catalog_axis_evaluation(report).as_dict()["axes"]}
    assert axes[AXIS_SUPPORTABILITY]["assessed"] is False
    assert axes[AXIS_SUPPORTABILITY]["not_assessed_reason"] == REASON_SUPPORTABILITY


def test_governance_findings_are_not_double_counted_on_quality(
    bare_contract: CanonicalApi,
) -> None:
    """A finding scored on the supportability axis must leave the quality tally alone."""
    report = lint_canonical_model(bare_contract).report_dict()
    axes = {a["key"]: a for a in catalog_axis_evaluation(report).as_dict()["axes"]}
    quality_total = sum(axes[AXIS_QUALITY]["severity_counts"].values())
    governance = [
        f for f in report["findings"] if f["category"] == GOVERNANCE_CATEGORY
    ]
    assert governance
    assert quality_total == len(report["findings"]) - len(governance)


def test_a_workspace_queue_routes_governance_findings_to_supportability() -> None:
    """CLX-4.1: the axis a finding is filtered under must match the axis it is scored on."""
    assert axis_key_for_finding(GOVERNANCE_CATEGORY) == AXIS_SUPPORTABILITY
    assert axis_key_for_finding("documentation") == AXIS_QUALITY


# ===========================================================================
# The fact reader — where each format put each fact
# ===========================================================================


def test_ownership_is_read_from_the_odcs_team_block(rich_contract: CanonicalApi) -> None:
    """ODCS states ownership in `team[]`."""
    facts = read_contract_facts(rich_contract)
    assert facts.has_owner()
    assert facts.has_resolvable_owner()


def test_ownership_is_read_from_a_dbt_exposure_owner(dbt_project: CanonicalApi) -> None:
    """dbt states it on an exposure — a different key, the same question."""
    facts = read_contract_facts(dbt_project)
    assert facts.has_owner()
    assert facts.has_resolvable_owner()


def test_an_exposure_without_an_owner_block_does_not_satisfy_ownership() -> None:
    """A dbt exposure *carries* an owner; it is not one.

    Reading the exposure itself as an ownership entry would let a dashboard with no owner
    satisfy the rule on the strength of having a name — the exact false pass the rule exists
    to catch.
    """
    def _facts(exposure: Dict[str, Any]):
        return read_contract_facts(
            CanonicalApi(
                paradigm=ApiParadigm.DATA_SCHEMA,
                format="dbt",
                identity=ApiIdentity(name="x"),
                extras={"dbt_exposures": [exposure]},
            )
        )

    none_declared = _facts({"name": "revenue_dashboard", "type": "dashboard"})
    assert none_declared.has_owner() is False

    named = _facts({"name": "d", "owner": {"name": "Analytics", "email": "a@example.com"}})
    assert named.has_owner() and named.has_resolvable_owner()

    empty = _facts({"name": "d", "owner": {}})
    assert empty.has_owner() and not empty.has_resolvable_owner()


def test_an_ownership_entry_with_no_contact_is_present_but_unresolvable() -> None:
    """"Present" and "resolvable" are different defects with different fixes."""
    facts = read_contract_facts(_api(extras={"odcs_team": [{"role": "owner"}]}))
    assert facts.has_owner()
    assert not facts.has_resolvable_owner()


def test_quality_cover_counts_the_shared_namespace_both_readers_write() -> None:
    """The FMT-5.1 dependency, asserted: one key answers the question for both formats."""
    field = _field("email", odcs_classification="restricted")
    type_ = _record(field)
    covered = _api(types=[type_], extras={})
    facts = read_contract_facts(covered)
    assert ContractFacts.is_critical(field)
    assert not facts.has_declared_expectation(type_, field)

    with_rule = _record(
        _field("email", odcs_classification="restricted", odcs_quality=[{"type": "library"}])
    )
    facts = read_contract_facts(_api(types=[with_rule]))
    assert facts.has_declared_expectation(with_rule, with_rule.fields[0])


def test_a_modelled_constraint_counts_as_a_declared_expectation() -> None:
    """A dbt `accepted_values` test becomes an enum; counting only carried rules would
    report the column as unchecked *because* its check was modelled well."""
    field = CanonicalField(
        key="orders.status",
        name="status",
        type=TypeRef(name="string"),
        constraints=Constraints(enum=["new", "paid"]),
        extras={"odcs_classification": "internal"},
    )
    type_ = _record(field)
    assert read_contract_facts(_api(types=[type_])).has_declared_expectation(type_, field)


def test_row_identity_is_read_from_either_format() -> None:
    """ODCS spells it `odcs_key`; dbt spells it `dbt_key` or a model constraint."""
    odcs = _record(_field("id", odcs_key={"primaryKey": True}))
    dbt = _record(_field("id", dbt_key={"unique": True}))
    constrained = Type(
        key="orders",
        name="orders",
        kind=TypeKind.RECORD,
        fields=[_field("id")],
        extras={"dbt_constraints": [{"type": "primary_key", "columns": ["id"]}]},
    )
    for type_ in (odcs, dbt, constrained):
        assert read_contract_facts(_api(types=[type_])).has_identity(type_)
    assert not read_contract_facts(_api(types=[_record(_field("id"))])).has_identity(
        _record(_field("id"))
    )


def test_a_free_form_tag_is_not_a_classification() -> None:
    """`nightly` is a selection tag; `pii` is a governance marker. Only one counts."""
    assert not ContractFacts.is_classified(_field("a", dbt_tags=["nightly", "commerce"]))
    assert ContractFacts.is_classified(_field("b", dbt_tags=["pii"]))
    assert ContractFacts.is_classified(_field("c", odcs_classification="restricted"))


def test_freshness_is_recognised_however_the_format_spells_it() -> None:
    """Four formats, four spellings, one promise."""
    for extras in (
        {"odcs_sla_properties": [{"property": "frequency", "value": 1}]},
        {"odcs_sla_properties": [{"property": "latency", "value": 15}]},
    ):
        assert read_contract_facts(_api(extras=extras)).has_freshness()
    dbt_style = Type(
        key="orders",
        name="orders",
        kind=TypeKind.RECORD,
        extras={"dbt_freshness": {"freshness": {"warn_after": {"count": 6, "period": "hour"}}}},
    )
    assert read_contract_facts(_api(types=[dbt_style])).has_freshness()
    assert not read_contract_facts(_api()).has_freshness()


def test_the_fact_reader_tolerates_a_malformed_extras_bag() -> None:
    """A lint pass must never fail because a normalizer produced something odd."""
    facts = read_contract_facts(
        _api(
            extras={
                "odcs_team": "a string, not a list",
                "odcs_sla_properties": 17,
                "odcs_servers": None,
            }
        )
    )
    assert facts.has_owner() is True  # a non-blank string is a party
    assert facts.has_sla() is True
    assert facts.has_server() is False


def test_the_reader_does_not_recurse_forever_on_a_self_referential_block() -> None:
    """Depth is bounded, so a cyclic extras bag stops contributing rather than hanging."""
    cycle: Dict[str, Any] = {"property": "x"}
    cycle["self"] = cycle
    facts = read_contract_facts(_api(extras={"odcs_sla_properties": [cycle]}))
    assert facts.has_freshness() is False


# ===========================================================================
# Individual rules
# ===========================================================================


def test_column_description_coverage_uses_the_documented_threshold() -> None:
    """Above the bar is clean; below it reports the actual ratio."""
    described = _record(*(_field(f"c{i}", description=f"Column {i}.") for i in range(4)))
    assert "data-contract.column-description-coverage" not in _rules(
        lint_canonical_model(_api(types=[described]))
    )

    mixed = _record(
        _field("c0", description="Described."),
        _field("c1", description="Described."),
        _field("c2"),
        _field("c3"),
    )
    result = lint_canonical_model(_api(types=[mixed]))
    assert "data-contract.column-description-coverage" in _rules(result)
    message = next(
        f.message for f in result.findings if f.rule == "data-contract.column-description-coverage"
    )
    assert "2 of 4" in message and f"{DESCRIPTION_COVERAGE_THRESHOLD:.0%}" in message


def test_column_description_coverage_ignores_a_tiny_table() -> None:
    """On a two-column table one undescribed column is 50%, which says nothing useful."""
    tiny = _record(_field("a", description="Described."), _field("b"))
    assert "data-contract.column-description-coverage" not in _rules(
        lint_canonical_model(_api(types=[tiny]))
    )


def test_primary_key_missing_skips_a_type_with_no_columns() -> None:
    """A dataset whose columns the reader could not see says nothing about its key either."""
    empty = Type(key="orders", name="orders", kind=TypeKind.RECORD)
    assert "data-contract.primary-key-missing" not in _rules(
        lint_canonical_model(_api(types=[empty]))
    )


def test_classification_missing_is_reported_once_for_the_artifact() -> None:
    """The reader cannot tell which column *should* be classified — only that none is."""
    types = [_record(_field("a"), _field("b"), key="orders"), _record(_field("c"), key="items")]
    findings = [
        f
        for f in lint_canonical_model(_api(types=types)).findings
        if f.rule == "data-contract.classification-missing"
    ]
    assert len(findings) == 1
    assert findings[0].path == "artifact"


def test_quality_rules_missing_names_the_column_it_is_about() -> None:
    """A per-column finding must locate the column."""
    type_ = _record(_field("email", odcs_critical_data_element=True))
    findings = [
        f
        for f in lint_canonical_model(_api(types=[type_])).findings
        if f.rule == "data-contract.quality-rules-missing"
    ]
    assert len(findings) == 1
    assert findings[0].path == "types/orders/fields/email"
    assert "email" in findings[0].message


def test_version_and_status_are_reported_separately() -> None:
    """Two facts, two fixes, two findings."""
    fired = set(_rules(lint_canonical_model(_api(version=None))))
    assert {"data-contract.version-missing", "data-contract.status-missing"} <= fired
    with_both = _api(version="1.0.0", extras={"odcs": {"status": "active"}})
    fired = set(_rules(lint_canonical_model(with_both)))
    assert "data-contract.version-missing" not in fired
    assert "data-contract.status-missing" not in fired


# ===========================================================================
# Registry hygiene
# ===========================================================================


def test_the_paradigm_registry_refuses_a_pack_with_no_paradigm() -> None:
    """A pack that forgets its key would register under "" and never run."""

    class _Nameless(DataContractRulePack):
        paradigm = ""

    with pytest.raises(ValueError):
        register_paradigm_rule_pack(_Nameless)


def test_the_paradigm_registry_refuses_a_conflicting_registration() -> None:
    """Two packs for one paradigm is a silent loss of one of them."""

    class _Other(DataContractRulePack):
        paradigm = ApiParadigm.DATA_SCHEMA

    with pytest.raises(ValueError):
        register_paradigm_rule_pack(_Other)


def test_registering_the_same_pack_twice_is_a_no_op() -> None:
    """Module re-import must stay safe."""
    assert register_paradigm_rule_pack(DataContractRulePack) is DataContractRulePack


def test_the_pack_is_deterministic(bare_contract: CanonicalApi) -> None:
    """The same model must always produce the same findings, score and fingerprint."""
    first = lint_canonical_model(bare_contract)
    second = lint_canonical_model(bare_contract)
    assert first.report_fingerprint == second.report_fingerprint
    assert first.finding_dicts() == second.finding_dicts()
