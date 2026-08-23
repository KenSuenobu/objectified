"""Data-contract lint rule pack — FMT-5.5 (#5443).

Apiome's lint engine scores *API description* quality: are operations summarised, are
schemas named well, is an array bounded. A data contract's quality is a different set of
questions, and none of them is about shape. Is there a named owner somebody can reach? Does
the dataset promise anything — a latency, a freshness window, a retention period? Are its
columns described? Is a row identifiable? Are the columns that carry personal data marked as
such? Is there a declared quality check on the columns that matter? Is it versioned, does it
say whether it is draft or active, and does it say where it is actually served?

Before this pack, an imported ODCS contract, dbt project, Kafka Connect schema or Arrow
schema was scored by the cross-format hygiene pack alone — rules written for API
descriptions — so a contract with no owner, no SLA and no quality rules could score an A.
This pack is what makes the data half of the catalog scoreable on its own terms.

**It is a paradigm pack, not a format pack.** Every rule here is written against
:class:`~app.data_contract_facts.ContractFacts` rather than against any format's extras, so
it runs for *every* ``data_schema``-paradigm artifact — the four formats that exist today
and the ones that come later — and never for a REST, RPC, event or graph artifact. The
engine dispatches it on :attr:`~app.canonical_model.CanonicalApi.paradigm`
(:func:`app.lint_engine.get_paradigm_rule_pack`), which is the dimension the ticket asks for:
"a ``data_schema``-paradigm item is scored by the data-contract pack, not the API pack".

**Severity is deliberately advisory, and a style guide is how a tenant makes it binding.**
Every rule ships at ``warning`` or ``info``: turning "no declared owner" into a blocking
``error`` for every existing data-schema item in every catalog on upgrade is not a decision a
rule pack gets to make. A tenant that wants to *require* a data contract before publish
enables these rule ids in a style guide at the severity it chooses — that is exactly the
GOV-1.4 mechanism, and re-scoring under the guide is what makes the requirement real.

**Every rule publishes remediation and a fixture.** :data:`DATA_CONTRACT_RULES` carries the
remediation sentence and the scanner-evaluation fixture id beside each rule's id, category
and severity, and :mod:`app.scanner_rule_transparency` surfaces both through
``GET /v1/lint/rules`` — the same fields the blocking-rule catalogue publishes, now available
to a non-blocking pack.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, List, Mapping, Tuple

from .canonical_model import ApiParadigm, CanonicalApi, Type
from .data_contract_facts import ContractFacts, describes_a_data_contract, read_contract_facts
from .lint_engine import LintRule, RulePack
from .schema_lint import Severity

__all__ = [
    "DATA_CONTRACT_CATEGORIES",
    "DATA_CONTRACT_PACK_ID",
    "DATA_CONTRACT_RULES",
    "DESCRIPTION_COVERAGE_THRESHOLD",
    "DataContractRuleMeta",
    "DataContractRulePack",
]

#: Stable pack id recorded on every descriptor this pack contributes to the GOV-1.2
#: catalogue, and the id a style guide's rule rows are grouped under in the UI.
DATA_CONTRACT_PACK_ID = "data-contract"

#: The category bars this pack always surfaces, even on a clean contract.
#:
#: ``governance`` is new, and it is load-bearing beyond presentation: its presence in a
#: report's ``categories`` rollup is the signal :mod:`app.axis_score` uses to tell a report
#: that *was* scored by this pack (and so can speak to supportability) from one that was
#: not. A clean contract must therefore still publish the bar, which is what passing these
#: as ``base_categories`` guarantees.
DATA_CONTRACT_CATEGORIES: Tuple[str, ...] = ("governance", "documentation", "structure")

#: Share of a table's columns that must carry a description before the coverage rule is
#: satisfied. Set at three quarters rather than "all": a warehouse table routinely carries a
#: handful of mechanical audit columns whose names are their documentation, and a rule that
#: fires until literally every column is prosed is a rule teams switch off.
DESCRIPTION_COVERAGE_THRESHOLD = 0.75

#: Below this many columns, the coverage rule does not fire at all — on a two-column table
#: one undescribed column is 50% coverage, which says nothing useful.
_COVERAGE_MIN_FIELDS = 4


@dataclass(frozen=True)
class DataContractRuleMeta:
    """Catalogue metadata for one data-contract rule.

    The engine only needs id/category/severity/description; the remaining two fields are
    what the ticket's "each rule has … remediation text and a fixture" asks for, and they
    are published through the rule catalogue rather than living in a docs file that can
    drift from the code.

    Attributes:
        category: The rule's group — ``governance`` / ``documentation`` / ``structure``.
        severity: Default severity. Never ``error``: see the module docstring.
        rationale: One line on why the rule exists (what a consumer loses without it).
        remediation: What an author should change to clear the finding.
        fixture_id: The scanner-evaluation corpus fixture that makes the rule fire, under
            ``tests/fixtures/scanner_evaluation/``.
    """

    category: str
    severity: Severity
    rationale: str
    remediation: str
    fixture_id: str


def _meta(
    category: str, severity: Severity, rationale: str, remediation: str, fixture: str
) -> DataContractRuleMeta:
    """Build one catalogue entry, prefixing the fixture id with its corpus directory."""
    return DataContractRuleMeta(
        category=category,
        severity=severity,
        rationale=rationale,
        remediation=remediation,
        fixture_id=f"catalog/{fixture}",
    )


#: Rule id -> catalogue metadata. The single source of truth for this pack's ids,
#: categories, default severities, rationales, remediation text and fixtures; the engine
#: rules below, the GOV-1.2 registry, the transparency catalogue and the generated rule
#: reference all read it, so the five can never disagree.
#:
#: Rule ids are **stable identifiers**: they form each finding's ``rule`` field and are
#: hashed into finding ids and the ``report_fingerprint``, so they are never renamed once
#: shipped.
DATA_CONTRACT_RULES: Mapping[str, DataContractRuleMeta] = {
    "data-contract.owner-missing": _meta(
        "governance",
        "warning",
        "A dataset nobody owns is a dataset nobody fixes.",
        "Declare an owner: an ODCS `team[]` member, a dbt `meta.owner`, or an exposure "
        "`owner` block naming the team accountable for the dataset.",
        "data-contract-owner-missing",
    ),
    "data-contract.owner-unresolvable": _meta(
        "governance",
        "warning",
        "An ownership entry with no name, address or channel cannot actually be reached.",
        "Give the ownership entry a `name`, `username`, `email` or `channel` — a role with "
        "no contact is a label, not an owner.",
        "data-contract-owner-unresolvable",
    ),
    "data-contract.sla-missing": _meta(
        "governance",
        "warning",
        "Without a stated service level, a consumer cannot tell a nightly batch from a "
        "streaming table.",
        "Declare `slaProperties[]` (ODCS) or a source `freshness` block (dbt) stating the "
        "latency, frequency or availability the dataset promises.",
        "data-contract-sla-missing",
    ),
    "data-contract.freshness-missing": _meta(
        "governance",
        "info",
        "Freshness is the service level consumers of a dataset ask about first.",
        "State a freshness expectation — an ODCS `frequency`/`latency` SLA property, or a "
        "dbt source `freshness` block with `warn_after`/`error_after`.",
        "data-contract-freshness-missing",
    ),
    "data-contract.retention-undocumented": _meta(
        "governance",
        "info",
        "Undocumented retention is a compliance question nobody can answer from the "
        "contract.",
        "State how long the data is kept: an ODCS `retention` SLA property, or a custom "
        "property naming the retention window.",
        "data-contract-retention-undocumented",
    ),
    "data-contract.quality-rules-missing": _meta(
        "governance",
        "warning",
        "A critical column with no declared check is an expectation held only in somebody's "
        "head.",
        "Attach a quality rule to the column — an ODCS `quality[]` entry, or a dbt data "
        "test — or attach a table-level rule that covers it.",
        "data-contract-quality-rules-missing",
    ),
    "data-contract.column-description-coverage": _meta(
        "documentation",
        "warning",
        "A column nobody described is a column consumers guess at.",
        "Describe the table's columns: at least three quarters of them need a "
        "`description` before the table reads as documented.",
        "data-contract-column-description-coverage",
    ),
    "data-contract.primary-key-missing": _meta(
        "structure",
        "warning",
        "Without a declared key, a row cannot be addressed, deduplicated or joined "
        "reliably.",
        "Declare row identity: an ODCS `primaryKey`/`unique` property, a dbt `unique` test, "
        "or a model-contract `primary_key` constraint.",
        "data-contract-primary-key-missing",
    ),
    "data-contract.classification-missing": _meta(
        "governance",
        "info",
        "Personal data that is not labelled cannot be governed, masked or audited.",
        "Classify the columns that carry personal or restricted data — an ODCS "
        "`classification` / `criticalDataElement`, or a dbt `meta` marker.",
        "data-contract-classification-missing",
    ),
    "data-contract.version-missing": _meta(
        "governance",
        "warning",
        "An unversioned contract cannot be changed safely: nothing distinguishes revisions.",
        "Declare the contract's own `version` (ODCS `version`, a dbt project `version`), so "
        "consumers can pin one.",
        "data-contract-version-missing",
    ),
    "data-contract.status-missing": _meta(
        "governance",
        "info",
        "A consumer cannot tell a draft dataset from a production one without a status.",
        "Declare a lifecycle `status` (`draft`, `active`, `deprecated`, `retired`).",
        "data-contract-status-missing",
    ),
    "data-contract.server-missing": _meta(
        "governance",
        "warning",
        "A contract that never says where the data is served describes a table nobody can "
        "find.",
        "Declare the serving location — an ODCS `servers[]` entry, or the "
        "database/schema/alias a dbt resource materializes to.",
        "data-contract-server-missing",
    ),
}

#: Path recorded on artifact-scope findings, matching the cross-format pack's convention.
_ARTIFACT_PATH = "artifact"


def _type_path(type_: Type) -> str:
    """Path for a finding scoped to one dataset."""
    return f"types/{type_.key}"


def _field_path(type_: Type, field_name: str) -> str:
    """Path for a finding scoped to one column."""
    return f"types/{type_.key}/fields/{field_name}"


# ---------------------------------------------------------------------------
# Checks — one per rule, each a pure generator over the read facts
# ---------------------------------------------------------------------------


def _owner_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when the artifact declares no ownership at all."""
    if not facts.has_owner():
        yield (
            _ARTIFACT_PATH,
            "This data contract declares no owner, so there is nobody to ask about it or "
            "hold to its promises",
        )


def _owner_unresolvable(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when ownership is declared but no entry names a reachable party."""
    if facts.has_owner() and not facts.has_resolvable_owner():
        yield (
            _ARTIFACT_PATH,
            "Ownership is declared but no entry names a reachable party (no name, email, "
            "username or channel), so the owner cannot actually be contacted",
        )


def _sla_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when the artifact promises no service level."""
    if not facts.has_sla():
        yield (
            _ARTIFACT_PATH,
            "This data contract declares no service-level properties, so it promises "
            "nothing about latency, frequency or availability",
        )


def _freshness_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when nothing in the artifact states a freshness expectation."""
    if not facts.has_freshness():
        yield (
            _ARTIFACT_PATH,
            "No freshness expectation is stated anywhere in this contract, so a consumer "
            "cannot tell how current the data is meant to be",
        )


def _retention_undocumented(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when no retention window is documented."""
    if not facts.has_retention():
        yield (
            _ARTIFACT_PATH,
            "No retention window is documented, so how long this data is kept is not part "
            "of the contract",
        )


def _quality_rules_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield once per *critical* column with no quality rule covering it.

    Deliberately scoped to critical columns — those the contract itself singled out with a
    classification or a critical-data marker — rather than to every column, because a rule
    that demands a check on every audit timestamp is one teams switch off rather than
    satisfy. "Covered" counts every place a declared expectation lands, including the
    constraints the readers modelled natively.
    """
    for type_ in facts.api.types:
        for field in type_.fields:
            if not ContractFacts.is_critical(field):
                continue
            if facts.has_declared_expectation(type_, field):
                continue
            yield (
                _field_path(type_, field.name),
                f"Critical column `{field.name}` of `{type_.key}` declares no quality rule "
                "or constraint, so the expectation it carries is not part of the contract",
            )


def _column_description_coverage(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield once per dataset whose column descriptions fall below the threshold."""
    for type_ in facts.api.types:
        described, total = ContractFacts.described_fields(type_)
        if total < _COVERAGE_MIN_FIELDS:
            continue
        coverage = described / total
        if coverage >= DESCRIPTION_COVERAGE_THRESHOLD:
            continue
        yield (
            _type_path(type_),
            f"Only {described} of {total} columns of `{type_.key}` are described "
            f"({coverage:.0%}), below the {DESCRIPTION_COVERAGE_THRESHOLD:.0%} a documented "
            "dataset needs",
        )


def _primary_key_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield once per dataset that declares no row identity."""
    for type_ in facts.api.types:
        if not type_.fields:
            # A dataset whose columns this reader could not see says nothing about its key
            # either; reporting one would be reporting the absence of the document.
            continue
        if facts.has_identity(type_):
            continue
        yield (
            _type_path(type_),
            f"`{type_.key}` declares no primary key or unique column, so a row cannot be "
            "addressed, deduplicated or joined reliably",
        )


def _classification_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield once per artifact whose columns carry no governance classification.

    Reported at the artifact rather than per column on purpose: this reader cannot tell
    which columns *should* be classified, only that not one of them is — and "no column in
    this dataset is classified" is a single, actionable fact.
    """
    if any(
        ContractFacts.is_classified(field)
        for type_ in facts.api.types
        for field in type_.fields
    ):
        return
    if not any(type_.fields for type_ in facts.api.types):
        return
    yield (
        _ARTIFACT_PATH,
        "No column in this contract carries a classification or personal-data marker, so "
        "nothing here can be governed, masked or audited by sensitivity",
    )


def _version_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when the artifact declares no version of its own."""
    if not facts.has_version():
        yield (
            _ARTIFACT_PATH,
            "This data contract declares no version, so consumers have nothing to pin and "
            "a change cannot be told from a correction",
        )


def _status_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when the artifact declares no lifecycle status."""
    if not facts.has_status():
        yield (
            _ARTIFACT_PATH,
            "This data contract declares no lifecycle status, so a draft dataset is "
            "indistinguishable from a production one",
        )


def _server_missing(facts: ContractFacts) -> Iterable[Tuple[str, str]]:
    """Yield when the artifact never says where the dataset is served."""
    if not facts.has_server():
        yield (
            _ARTIFACT_PATH,
            "This data contract declares no serving location, so a consumer cannot find "
            "the dataset it describes",
        )


#: Rule id -> the check that answers it. Kept beside the catalogue rather than inside it so
#: :data:`DATA_CONTRACT_RULES` stays a pure data table that docs and the registry can read
#: without importing the engine.
_CHECKS: Mapping[str, Any] = {
    "data-contract.owner-missing": _owner_missing,
    "data-contract.owner-unresolvable": _owner_unresolvable,
    "data-contract.sla-missing": _sla_missing,
    "data-contract.freshness-missing": _freshness_missing,
    "data-contract.retention-undocumented": _retention_undocumented,
    "data-contract.quality-rules-missing": _quality_rules_missing,
    "data-contract.column-description-coverage": _column_description_coverage,
    "data-contract.primary-key-missing": _primary_key_missing,
    "data-contract.classification-missing": _classification_missing,
    "data-contract.version-missing": _version_missing,
    "data-contract.status-missing": _status_missing,
    "data-contract.server-missing": _server_missing,
}


class DataContractRulePack(RulePack, register_paradigm=True):
    """The FMT-5.5 rule pack: every data-schema artifact's governance questions.

    Registered against the ``data_schema`` **paradigm** rather than a format key, so one
    pack covers ODCS contracts, dbt projects, Kafka Connect schemas, Arrow schemas and
    every data format added later — and never runs for an API-paradigm artifact.
    """

    paradigm = ApiParadigm.DATA_SCHEMA
    pack_id = DATA_CONTRACT_PACK_ID
    base_categories = DATA_CONTRACT_CATEGORIES

    def lint(self, api: CanonicalApi) -> List[Any]:
        """Run the pack, unless the artifact's format cannot state a data contract.

        Half of the ``data_schema`` paradigm is schema *languages* — Avro, XSD, RELAX NG,
        CDDL, a Kafka Connect schema — which have no syntax in which to write an owner, a
        service level or a retention window. Reporting those as missing would put a dozen
        unfixable findings on every such artifact in every catalog: a capability limit of the
        format presented as a defect of the document. So the pack self-gates to nothing for
        them, the way the IXH-5.4 example-conformance pack self-gates on an artifact that
        retained no walkable document. Which formats can carry a contract is declared, and
        checked, in :mod:`app.data_contract_facts`.

        Args:
            api: The canonical artifact to lint. Not mutated.

        Returns:
            This pack's findings, or an empty list for a schema-only artifact.
        """
        if not describes_a_data_contract(api):
            return []
        return super().lint(api)

    def categories_for(self, api: CanonicalApi) -> Tuple[str, ...]:
        """Publish the category bars only for artifacts this pack actually scored."""
        return tuple(self.base_categories) if describes_a_data_contract(api) else ()

    def rules(self) -> List[LintRule]:
        """Return this pack's rules in catalogue order.

        Each rule reads the artifact's facts once through
        :func:`~app.data_contract_facts.read_contract_facts` and answers one question, so a
        rule never reaches into any format's extras namespace itself.

        Returns:
            One :class:`~app.lint_engine.LintRule` per entry of :data:`DATA_CONTRACT_RULES`.
        """
        return [
            LintRule(
                rule_id=rule_id,
                category=meta.category,
                severity=meta.severity,
                description=meta.rationale,
                check=_bind(rule_id),
            )
            for rule_id, meta in DATA_CONTRACT_RULES.items()
        ]


def _bind(rule_id: str) -> Any:
    """Return a check that reads the facts, then answers ``rule_id``.

    Args:
        rule_id: A key of :data:`DATA_CONTRACT_RULES`.

    Returns:
        A pure ``CanonicalApi -> Iterable[(path, message)]`` callable.
    """
    answer = _CHECKS[rule_id]

    def _check(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
        return answer(read_contract_facts(api))

    _check.__name__ = f"check_{rule_id.replace('.', '_').replace('-', '_')}"
    return _check
