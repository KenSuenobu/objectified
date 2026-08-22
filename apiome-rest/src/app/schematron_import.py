"""Schematron -> style-guide importer — FMT-4.3 (#5436).

The third piece of FMT-4.3, and the only one a caller normally touches:
:mod:`app.schematron_parser` reads the rule set, :mod:`app.schematron_projection` decides what
each assertion means against the canonical model, and this module turns the pair into
**governance state** — the exact YAML ``PUT /v1/style-guides/{tenant}/{guide}/custom-rules``
stores, plus a per-assertion report of what happened to it.

Deliberately the same shape as the Spectral importer (:mod:`app.spectral_import`, GOV-1.5): pure
and deterministic, nothing persisted, one entry per source rule, and every shortfall carried as a
machine-readable ``reason`` rather than a silence. A Peppol-shaped profile therefore becomes an
Apiome style guide that scores any XSD- or UBL-derived catalog item, and the rules it *cannot*
score are still in the guide, still attributable, still explaining themselves.

Three decisions worth stating outright, because they are what make the import honest:

* **One rule per assertion, always.** An assertion the projection cannot express becomes a
  ``declared`` rule (:data:`~app.custom_rule_dsl.SCOPE_DECLARED`) carrying its reason, not a
  dropped line in a report. "Never silent" is a storage property here, not a UI one.
* **Phase is selection, role is severity.** ``@role`` maps through
  :data:`~app.schematron_parser.ROLE_SEVERITIES` onto the lint severity vocabulary. A pattern
  the resolved phase does not activate is imported as ``declared`` with
  :data:`~app.schematron_projection.REASON_INACTIVE_PHASE` — the profile's own statement that
  the rule does not apply in this phase — *unless* the assertion already has a more specific
  reason, which is the more useful fact to record.
* **Ids stay traceable.** A rule id is ``schematron.<assertion id>``, slugged into the DSL's id
  grammar. The prefix is what keeps an imported rule from ever shadowing a built-in one, and
  what makes a finding point back at the business rule number the profile published.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .custom_rule_dsl import (
    MAX_RULE_ID_LENGTH,
    MAX_RULES_PER_GUIDE,
    MAX_UNEVALUABLE_DETAIL_LENGTH,
    SCOPE_CANONICAL,
    SCOPE_DECLARED,
    CustomRule,
    CustomRuleSet,
    CustomRuleUnevaluable,
    CustomRuleValidationError,
    serialize_style_guide_yaml,
    validate_custom_definition,
)
from .schematron_parser import (
    SchematronAssertion,
    SchematronDocument,
    SchematronParseError,
    parse_schematron,
    parse_schematron_bytes,
)
from .schematron_projection import (
    REASON_INACTIVE_PHASE,
    REASON_INVALID_PROJECTION,
    REASON_RULE_LIMIT,
    project_assertion,
)

#: The one failure a caller must handle — re-exported so a caller need not import the reader
#: module just to catch it. Per-assertion problems never raise; they become declared rules.
SchematronImportError = SchematronParseError

__all__ = [
    "DEFAULT_GUIDE_NAME",
    "OUTCOME_DECLARED",
    "OUTCOME_PROJECTED",
    "RULE_ID_PREFIX",
    "SchematronImportEntry",
    "SchematronImportError",
    "SchematronImportResult",
    "import_schematron_bytes",
    "import_schematron_ruleset",
    "schematron_rule_id",
]

#: Prefix every imported rule id carries. Keeps imported rules in their own id space, so they can
#: never shadow a GOV-1.2 built-in and a finding names the profile it came from.
RULE_ID_PREFIX = "schematron"

#: Guide name used when the rule set declares no ``title`` and the caller supplies no label.
DEFAULT_GUIDE_NAME = "Schematron rules"

#: Per-assertion outcomes.
OUTCOME_PROJECTED = "projected"  # became an evaluable canonical-scoped rule
OUTCOME_DECLARED = "declared"  # recorded with a reason, never evaluated

#: Characters that are not part of the DSL's rule-id grammar.
_ID_SLUG_RE = re.compile(r"[^a-z0-9_-]+")


def _clamp_detail(detail: Optional[str]) -> Optional[str]:
    """Trim an explanation to the length the DSL stores.

    A reason's detail quotes the offending XPath, and a profile is free to write a very long one.
    Trimming here keeps the *reason* — the machine-readable half a caller keys off — rather than
    letting an over-long explanation fail validation and collapse into ``invalid_projection``.
    """
    if detail is None or len(detail) <= MAX_UNEVALUABLE_DETAIL_LENGTH:
        return detail
    return detail[: MAX_UNEVALUABLE_DETAIL_LENGTH - 1].rstrip() + "…"


@dataclass(frozen=True)
class SchematronImportEntry:
    """What became of one ``assert`` / ``report`` of the source rule set.

    Attributes:
        assertion_id: The assertion's ``@id`` as written, or the coordinate derived for it.
        kind: ``assert`` or ``report``.
        outcome: :data:`OUTCOME_PROJECTED` or :data:`OUTCOME_DECLARED`.
        rule_id: The Apiome rule id the assertion imported as.
        severity: The lint severity the assertion's ``@role`` maps onto.
        role: The ``@role`` as written, or ``None``.
        context: The rule's ``@context`` XPath, recorded verbatim — the rule's target.
        test: The assertion's ``@test`` XPath, recorded verbatim.
        target: The canonical element the rule scores, when the context named one.
        pattern_id: The enclosing pattern.
        phases: Phases that activate the pattern (empty when the schema declares none).
        active: Whether the pattern is active in the resolved phase.
        reason: Machine-readable reason the rule is declared rather than evaluable
            (:data:`~app.schematron_projection.PROJECTION_REASONS`); ``None`` when projected.
        detail: Human explanation of ``reason``.
        notes: Lossy-but-successful translation notes for a projected rule.
        stored: Whether the rule made it into :attr:`SchematronImportResult.yaml` (``False``
            only for assertions past the guide's rule ceiling).
    """

    assertion_id: str
    kind: str
    outcome: str
    rule_id: str
    severity: str
    role: Optional[str]
    context: str
    test: str
    target: Optional[str] = None
    pattern_id: str = ""
    phases: Tuple[str, ...] = ()
    active: bool = True
    reason: Optional[str] = None
    detail: Optional[str] = None
    notes: Tuple[str, ...] = ()
    stored: bool = True


@dataclass(frozen=True)
class SchematronImportResult:
    """Everything one Schematron rule set translated into.

    Attributes:
        source_label: Human label for the source (filename), when known.
        guide_name: Suggested style-guide name — the rule set's ``title``, else the label.
        description: The rule set's prose, for the guide's description.
        entries: One entry per assertion, in document order.
        custom_rules: The rules that will be stored, in the same order.
        yaml: :attr:`custom_rules` serialized as a style-guide document — the exact body
            ``PUT /v1/style-guides/{tenantSlug}/{guideId}/custom-rules`` accepts.
        resolved_phase: The phase whose patterns are active (``#ALL`` when none was selected).
        phases: Every phase the rule set declares.
        namespaces: The ``ns`` prefix bindings the rule set declares.
        modules: Modules spliced in by ``include``.
        notes: Document-level notes (rule ceiling reached, legacy namespace, …).
    """

    source_label: Optional[str]
    guide_name: str
    description: Optional[str]
    entries: Tuple[SchematronImportEntry, ...]
    custom_rules: CustomRuleSet
    yaml: str
    resolved_phase: str
    phases: Tuple[str, ...] = ()
    namespaces: Mapping[str, str] = field(default_factory=dict)
    modules: Tuple[str, ...] = ()
    notes: Tuple[str, ...] = ()

    @property
    def assertion_count(self) -> int:
        """Number of assertions the rule set declared."""
        return len(self.entries)

    @property
    def projected_count(self) -> int:
        """Assertions that became evaluable canonical-scoped rules."""
        return sum(1 for entry in self.entries if entry.outcome == OUTCOME_PROJECTED)

    @property
    def declared_count(self) -> int:
        """Assertions recorded as declared-but-unevaluable, each with a reason."""
        return sum(1 for entry in self.entries if entry.outcome == OUTCOME_DECLARED)

    @property
    def coverage(self) -> float:
        """Fraction of assertions that became evaluable rules, ``0.0``–``1.0``.

        The honest measure of how much of a rule language about *instances* Apiome can score
        against a *model*. It is reported, never gated on: an assertion that does not project is
        a fact about Schematron, not a defect in the import.
        """
        if not self.entries:
            return 0.0
        return round(self.projected_count / len(self.entries), 4)


def schematron_rule_id(assertion_id: str, taken: Mapping[str, Any], index: int) -> str:
    """Return the DSL rule id for one assertion, unique within the guide.

    Schematron ids carry their profile's casing and punctuation (``BR-CO-10``, ``INV-R001``);
    the DSL's grammar is lowercase dotted segments, so the id is slugged and prefixed. A slug
    collision (two assertions whose ids differ only in case or punctuation) gets a numeric
    suffix rather than one rule silently overwriting the other.

    Args:
        assertion_id: The assertion's id as written or derived.
        taken: Rule ids already used in this guide.
        index: The assertion's document position, used when the id slugs to nothing.

    Returns:
        A rule id of the form ``schematron.<slug>``.
    """
    slug = _ID_SLUG_RE.sub("-", assertion_id.strip().lower()).strip("-")
    if not slug or not slug[0].isalnum():
        slug = f"rule-{index + 1}" if not slug else f"r{slug}"
    budget = MAX_RULE_ID_LENGTH - len(RULE_ID_PREFIX) - 1
    slug = slug[:budget].rstrip("-") or f"rule-{index + 1}"

    candidate = f"{RULE_ID_PREFIX}.{slug}"
    if candidate not in taken:
        return candidate
    suffix = 2
    while f"{candidate}-{suffix}" in taken:
        suffix += 1
    return f"{candidate}-{suffix}"


def import_schematron_ruleset(
    text: str,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
    reserved_rule_ids: Optional[frozenset] = None,
) -> SchematronImportResult:
    """Import a Schematron rule set as style-guide state.

    Args:
        text: The rule set's text (the root member of a multi-file set).
        source_label: Relative path / filename of ``text``, used to resolve a relative
            ``include`` and echoed back on the result.
        members: Fileset members (relative path -> text) an ``include`` may name.
        reserved_rule_ids: Ids an imported rule must not shadow — pass
            ``frozenset(builtin_rule_ids())``. The ``schematron.`` prefix already makes a clash
            impossible, so this is defence in depth.

    Returns:
        The :class:`SchematronImportResult`.

    Raises:
        SchematronParseError: When the document cannot be read at all (each carries an intake
            taxonomy code). Per-assertion problems never raise — they become declared rules.
    """
    document = parse_schematron(text, source_label=source_label, members=members)
    return _project_document(document, source_label, reserved_rule_ids)


def import_schematron_bytes(
    data: bytes,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, bytes]] = None,
    reserved_rule_ids: Optional[frozenset] = None,
) -> SchematronImportResult:
    """Import a Schematron rule set from bytes (adds the UTF-8 encoding gate).

    Args:
        data: The rule set's bytes.
        source_label: Relative path / filename of ``data``.
        members: Fileset members (relative path -> bytes).
        reserved_rule_ids: Ids an imported rule must not shadow.

    Returns:
        The :class:`SchematronImportResult`.

    Raises:
        SchematronParseError: As :func:`import_schematron_ruleset`, plus
            ``INPUT_ENCODING_INVALID`` for non-UTF-8 input.
    """
    document = parse_schematron_bytes(data, source_label=source_label, members=members)
    return _project_document(document, source_label, reserved_rule_ids)


def _project_document(
    document: SchematronDocument,
    source_label: Optional[str],
    reserved_rule_ids: Optional[frozenset],
) -> SchematronImportResult:
    """Turn a resolved rule set into entries, custom rules and the storable YAML."""
    entries: List[SchematronImportEntry] = []
    rules: List[CustomRule] = []
    notes: List[str] = []
    taken: Dict[str, bool] = {}

    for index, assertion in enumerate(document.assertions):
        rule_id = schematron_rule_id(assertion.assertion_id, taken, index)
        taken[rule_id] = True
        at_limit = len(rules) >= MAX_RULES_PER_GUIDE
        entry, rule = _project_one(assertion, rule_id, reserved_rule_ids, at_limit=at_limit)
        entries.append(entry)
        if rule is not None:
            rules.append(rule)

    if len(document.assertions) > MAX_RULES_PER_GUIDE:
        notes.append(
            f"the rule set declares {len(document.assertions)} assertions; the first "
            f"{MAX_RULES_PER_GUIDE} were imported and the rest are reported with reason "
            f"'{REASON_RULE_LIMIT}'"
        )
    if document.modules:
        notes.append(
            f"assembled from {len(document.modules) + 1} documents via `include`: "
            + ", ".join(document.modules)
        )
    if document.default_phase and document.resolved_phase == "#ALL":
        notes.append(
            f"`defaultPhase` names {document.default_phase!r}, which the rule set does not "
            "declare as a phase; every pattern was treated as active"
        )

    ruleset = CustomRuleSet(rules=tuple(rules))
    return SchematronImportResult(
        source_label=source_label,
        guide_name=document.title or source_label or DEFAULT_GUIDE_NAME,
        description=document.description,
        entries=tuple(entries),
        custom_rules=ruleset,
        yaml=serialize_style_guide_yaml(ruleset),
        resolved_phase=document.resolved_phase,
        phases=tuple(phase.phase_id for phase in document.phases),
        namespaces=dict(document.namespaces),
        modules=document.modules,
        notes=tuple(notes),
    )


def _project_one(
    assertion: SchematronAssertion,
    rule_id: str,
    reserved_rule_ids: Optional[frozenset],
    at_limit: bool,
) -> Tuple[SchematronImportEntry, Optional[CustomRule]]:
    """Project one assertion into an entry and, unless the ceiling was hit, a storable rule.

    Args:
        assertion: The parsed assertion.
        rule_id: The rule id already allocated for it.
        reserved_rule_ids: Ids the rule must not shadow.
        at_limit: Whether the guide's rule ceiling has already been reached.

    Returns:
        ``(entry, rule)``; ``rule`` is ``None`` when the assertion is past the ceiling or its
        definition failed re-validation (which is reported on the entry, never raised).
    """
    projection = project_assertion(assertion)
    description = _description(assertion)

    reason: Optional[str] = None
    detail: Optional[str] = None
    target: Optional[str] = None
    notes: Tuple[str, ...] = ()
    given: Tuple[str, ...] = ()
    then: Tuple[Mapping[str, Any], ...] = ()

    if projection.rule is not None:
        target = projection.rule.target
        notes = projection.rule.notes
        given = projection.rule.given
        then = projection.rule.then
    else:
        unprojectable = projection.unprojectable
        assert unprojectable is not None  # a Projection always carries exactly one half
        reason, detail, target = unprojectable.reason, unprojectable.detail, unprojectable.target

    # The profile's own phase selection only decides the outcome when the assertion had no more
    # specific problem: "this XPath has no analogue" is a more useful fact than "this pattern is
    # not in the default phase".
    if reason is None and not assertion.active:
        reason = REASON_INACTIVE_PHASE
        detail = (
            f"pattern {assertion.pattern_id!r} is not active in the rule set's phase; the "
            "profile itself says this assertion does not apply here"
        )

    if at_limit:
        reason = REASON_RULE_LIMIT
        detail = (
            f"the guide's ceiling of {MAX_RULES_PER_GUIDE} rules was reached before this "
            "assertion, so it was not stored"
        )

    outcome = OUTCOME_PROJECTED if reason is None else OUTCOME_DECLARED
    detail = _clamp_detail(detail)
    entry_kwargs: Dict[str, Any] = {
        "assertion_id": assertion.assertion_id,
        "kind": assertion.kind,
        "outcome": outcome,
        "rule_id": rule_id,
        "severity": assertion.severity,
        "role": assertion.role,
        "context": assertion.context,
        "test": assertion.test,
        "target": target,
        "pattern_id": assertion.pattern_id,
        "phases": assertion.phases,
        "active": assertion.active,
        "reason": reason,
        "detail": detail,
        "notes": notes,
    }

    if at_limit:
        return SchematronImportEntry(**entry_kwargs, stored=False), None

    definition: Dict[str, Any] = {
        "description": description,
        "severity": assertion.severity,
    }
    if outcome == OUTCOME_DECLARED:
        definition["scope"] = SCOPE_DECLARED
        definition["unevaluable"] = {"reason": reason, "detail": detail}
    else:
        definition["scope"] = SCOPE_CANONICAL
    if given:
        definition["given"] = list(given)
    if then:
        definition["then"] = [dict(clause) for clause in then]

    try:
        rule = validate_custom_definition(
            rule_id, definition, reserved_rule_ids=reserved_rule_ids
        )
    except CustomRuleValidationError as exc:
        # Everything this module emits is machine-built, so a rejection here is a projection bug
        # rather than user input — but the assertion still must not vanish. Fall back to a bare
        # declared rule that records what happened.
        fallback = CustomRule(
            rule_id=rule_id,
            description=description,
            severity=assertion.severity,
            given=(),
            then=(),
            scope=SCOPE_DECLARED,
            unevaluable=CustomRuleUnevaluable(
                reason=REASON_INVALID_PROJECTION,
                detail=_clamp_detail(
                    f"the projected rule failed validation at {exc.pointer!r}: {exc.message}"
                ),
            ),
        )
        entry_kwargs.update(
            outcome=OUTCOME_DECLARED,
            reason=REASON_INVALID_PROJECTION,
            detail=fallback.unevaluable.detail if fallback.unevaluable else None,
            notes=(),
        )
        return SchematronImportEntry(**entry_kwargs), fallback

    return SchematronImportEntry(**entry_kwargs), rule


def _description(assertion: SchematronAssertion) -> str:
    """Return the rule description: the assertion's message, plus its diagnostic remediation.

    Schematron's ``diagnostic`` is remediation copy attached to an assertion — "add a
    ``doc:Header`` as the first child" — which is precisely what a lint finding wants after the
    statement of what is wrong, so the two are joined into the one description field the DSL
    carries. An assertion with no message at all falls back to naming its own test, so a rule is
    never described by an empty string.
    """
    message = (assertion.message or "").strip()
    if not message:
        message = (
            f"{assertion.kind} {assertion.assertion_id}: `{assertion.test}` on "
            f"`{assertion.context}`"
        )
    if assertion.diagnostics:
        message = f"{message} {assertion.diagnostics.strip()}"
    return message
