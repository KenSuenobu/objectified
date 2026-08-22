"""Schematron import projected onto the lint engine — FMT-4.3 (#5436).

Drives the three modules the feature is built from against the shipped corpus
(``apiome-ui/examples/schematron/``) and against hand-built canonical models:

* **the reader** (:mod:`app.schematron_parser`) — composition (``include``, abstract patterns,
  abstract rules), literal ``let`` substitution, phase resolution, and each of the six negative
  classes grounding on the intake taxonomy code the manifest declares;
* **the projection** (:mod:`app.schematron_projection`) — every shape that maps and every reason
  code for the shapes that do not, plus the governance document a mapped rule reads;
* **the importer** (:mod:`app.schematron_import`) — one rule per assertion, severity from role,
  phase as selection, unevaluable rules stored (not dropped) with a reason;

and then closes the loop the ticket asks for: an imported guide re-scores a catalog item.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Type,
    TypeKind,
    TypeRef,
)
from app.custom_rule_dsl import (
    MAX_RULES_PER_GUIDE,
    SCOPE_CANONICAL,
    SCOPE_DECLARED,
    SCOPE_DOCUMENT,
    CustomRuleValidationError,
    evaluate_custom_rules,
    parse_style_guide_yaml,
    validate_custom_definition,
)
from app.lint_engine import lint_canonical_model
from app.lint_rule_registry import builtin_rule_ids
from app.schematron_import import (
    OUTCOME_DECLARED,
    OUTCOME_PROJECTED,
    RULE_ID_PREFIX,
    import_schematron_bytes,
    import_schematron_ruleset,
    schematron_rule_id,
)
from app.schematron_parser import (
    ROLE_SEVERITIES,
    SCHEMATRON_NS,
    SchematronParseError,
    detect_schematron_confidence,
    is_schematron_document,
    parse_schematron,
)
from app.schematron_projection import (
    CANONICAL_ROOT_KEY,
    PROJECTION_REASONS,
    REASON_CONTEXT_NOT_PROJECTABLE,
    REASON_CONTEXT_PREDICATE,
    REASON_INACTIVE_PHASE,
    REASON_INSTANCE_VALUE_ASSERTION,
    REASON_INVALID_PROJECTION,
    REASON_NO_TEST,
    REASON_RULE_LIMIT,
    REASON_UNSUPPORTED_REPORT_INVERSION,
    REASON_UNSUPPORTED_XPATH_FUNCTION,
    REASON_UNSUPPORTED_XPATH_OPERATOR,
    REASON_UNSUPPORTED_XPATH_PATH,
    REASON_VARIABLE_REFERENCE,
    canonical_governance_document,
    project_assertion,
)
from app.style_guide_engine import apply_style_guide_to_canonical_result, compile_style_guide

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "schematron"

RESERVED = frozenset(builtin_rule_ids())


def _fixture(name: str) -> str:
    """Return a corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _import(name: str, **kwargs):
    """Import a corpus fixture, reserving the built-in rule ids."""
    return import_schematron_ruleset(
        _fixture(name), source_label=name, reserved_rule_ids=RESERVED, **kwargs
    )


def _entry(result, assertion_id: str):
    """Return the single entry for ``assertion_id`` (fails loudly when absent)."""
    matches = [e for e in result.entries if e.assertion_id == assertion_id]
    assert matches, f"no entry for {assertion_id!r}"
    return matches[0]


def _sch(patterns: str, extra: str = "") -> str:
    """Build a minimal one-schema document around ``patterns``."""
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<schema xmlns="{SCHEMATRON_NS}">{extra}{patterns}</schema>'
    )


def _one(test: str, context: str = "Invoice", kind: str = "assert", role: str = "error"):
    """Import a one-assertion rule set and return ``(entry, stored rule)``."""
    body = (
        f'<pattern id="p"><rule context="{context}">'
        f'<{kind} test="{test}" id="R1" role="{role}">Rule text.</{kind}>'
        f"</rule></pattern>"
    )
    result = import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED)
    return result.entries[0], result.custom_rules.rules[0]


def _then(rule) -> Dict[str, Any]:
    """Return a stored rule's first ``then`` clause as a plain dict."""
    clause = rule.then[0]
    return {
        "field": clause.field,
        "function": clause.function,
        "functionOptions": dict(clause.function_options),
    }


# ===========================================================================
# Detection
# ===========================================================================


def test_detection_claims_a_schema_root_and_a_bare_pattern_module():
    assert detect_schematron_confidence(_fixture("01-minimal-single-assert.sch")) == 0.95
    assert detect_schematron_confidence(
        _fixture("06-include-set/structure-rules.sch")
    ) == pytest.approx(0.9)
    assert is_schematron_document(_fixture("02-typical-invoice-rules.sch"))


def test_detection_refuses_a_compiled_stylesheet_and_never_raises():
    """A Schematron ships compiled to XSLT, so the stylesheet must not be claimed."""
    assert detect_schematron_confidence(_fixture("negative/04-wrong-format-xslt.xsl")) == 0.0
    assert not is_schematron_document(_fixture("negative/01-syntactic-unclosed-rule.sch"))
    assert detect_schematron_confidence("not xml at all") == 0.0


# ===========================================================================
# Reader: composition
# ===========================================================================


def test_abstract_patterns_are_instantiated_once_per_is_a():
    document = parse_schematron(_fixture("03-composition-abstract-patterns.sch"))
    instantiated = [a for a in document.assertions if a.instantiated_from == "mandatoryChild"]

    assert [(a.context, a.test) for a in instantiated] == [
        ("ord:Order", "ord:Line"),
        ("ord:Line", "ord:Sku"),
    ]
    # The template's own `$parent`/`$child` never survive instantiation.
    assert not any("$" in a.test or "$" in a.context for a in instantiated)
    # Two instantiations of one template keep distinct ids rather than colliding.
    assert [a.assertion_id for a in instantiated] == ["ABS-R001", "ABS-R001-2"]


def test_abstract_rules_are_inlined_into_every_extending_rule_first():
    document = parse_schematron(_fixture("03-composition-abstract-patterns.sch"))
    order = [
        a
        for a in document.assertions
        if a.pattern_id == "identifiers" and a.context == "ord:Order"
    ]

    assert [a.assertion_id for a in order] == ["ID-R001", "ID-R002", "ORD-R001"]
    assert order[0].inherited_from == "identifiedThing"
    assert order[2].inherited_from is None


def test_include_splices_a_module_and_records_it():
    members = {path.name: path.read_text(encoding="utf-8") for path in (CORPUS / "06-include-set").iterdir()}
    document = parse_schematron(
        members["main.sch"], source_label="main.sch", members=members
    )

    assert document.modules == ("structure-rules.sch",)
    assert [a.assertion_id for a in document.assertions] == [
        "SHR-001",
        "SHR-002",
        "SHR-010",
        "LOC-001",
    ]


def test_include_of_a_file_outside_the_set_is_an_unresolved_reference():
    body = '<include href="missing.sch"/><pattern id="p"><rule context="a"><assert test="b">m</assert></rule></pattern>'
    with pytest.raises(SchematronParseError) as excinfo:
        parse_schematron(_sch(body), source_label="main.sch", members={})
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_include_cycle_is_refused_rather_than_unrolled():
    members = {
        "a.sch": _sch('<include href="b.sch"/>'),
        "b.sch": _sch('<include href="a.sch"/>'),
    }
    with pytest.raises(SchematronParseError) as excinfo:
        parse_schematron(members["a.sch"], source_label="a.sch", members=members)
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_a_bare_pattern_module_reads_on_its_own():
    document = parse_schematron(_fixture("06-include-set/structure-rules.sch"))
    assert [a.assertion_id for a in document.assertions] == ["SHR-001", "SHR-002", "SHR-010"]


# ===========================================================================
# Reader: let substitution, phases, message text
# ===========================================================================


def test_literal_lets_substitute_and_computed_lets_do_not():
    document = parse_schematron(_fixture("02-typical-invoice-rules.sch"))
    by_id = {a.assertion_id: a for a in document.assertions}

    # `('EUR', 'GBP', 'USD')` is a constant, so it becomes readable to the projection...
    assert by_id["INV-R002"].test == "inv:Currency = ('EUR', 'GBP', 'USD')"
    # ...while `sum(inv:Line/inv:LineAmount)` is computed at validation time and stays a variable.
    assert by_id["INV-R001"].test == "inv:Total = $lineSum"


def test_default_phase_selects_which_patterns_are_active():
    document = parse_schematron(_fixture("04-stress-phases-and-diagnostics.sch"))
    by_id = {a.assertion_id: a for a in document.assertions}

    assert document.resolved_phase == "submission"
    assert by_id["STR-001"].active and by_id["STR-001"].phases == ("submission", "publication")
    assert not by_id["EDT-001"].active and by_id["EDT-001"].phases == ("publication",)


def test_an_undeclared_default_phase_leaves_every_pattern_active():
    body = '<pattern id="p"><rule context="a"><assert test="b">m</assert></rule></pattern>'
    document = parse_schematron(
        _sch(body).replace("<schema ", '<schema defaultPhase="nope" ')
    )
    assert document.resolved_phase == "#ALL"
    assert document.assertions[0].active


def test_message_text_keeps_name_and_value_of_as_placeholders():
    document = parse_schematron(_fixture("04-stress-phases-and-diagnostics.sch"))
    by_id = {a.assertion_id: a for a in document.assertions}
    # `<value-of select="$maxTitleLength"/>` becomes a placeholder, and the literal `let` behind
    # it is substituted, so the stored message reads the way a validator would render it.
    assert by_id["STR-011"].message == "Section titles are capped at {120} characters."

    body = (
        '<pattern id="p"><rule context="Invoice">'
        '<assert test="ID">A <name/> needs <value-of select="count(Line)"/> lines.</assert>'
        "</rule></pattern>"
    )
    assert (
        parse_schematron(_sch(body)).assertions[0].message
        == "A <name> needs {count(Line)} lines."
    )


def test_roles_map_onto_the_lint_severity_vocabulary():
    document = parse_schematron(_fixture("05-real-world-billing-bis-rules.sch"))
    assert {a.severity for a in document.assertions} <= {"error", "warning", "info"}
    assert ROLE_SEVERITIES["fatal"] == "error"
    # An assertion with no role is not allowed to block a build on import.
    body = '<pattern id="p"><rule context="a"><assert test="b">m</assert></rule></pattern>'
    assert parse_schematron(_sch(body)).assertions[0].severity == "warning"


# ===========================================================================
# Reader: the six negative classes
# ===========================================================================


@pytest.mark.parametrize(
    ("fixture", "code"),
    [
        ("negative/01-syntactic-unclosed-rule.sch", "INPUT_MALFORMED"),
        ("negative/02-semantic-pattern-without-rules.sch", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-assert.sch", "INPUT_TRUNCATED"),
        ("negative/04-wrong-format-xslt.xsl", "FORMAT_MISMATCH"),
        ("negative/05-encoding-utf16.sch", "INPUT_ENCODING_INVALID"),
        ("negative/06-unresolvable-is-a-reference.sch", "INPUT_REFERENCE_UNRESOLVED"),
    ],
)
def test_every_negative_corpus_entry_grounds_on_its_declared_code(fixture: str, code: str):
    with pytest.raises(SchematronParseError) as excinfo:
        import_schematron_bytes((CORPUS / fixture).read_bytes(), source_label=fixture)
    assert excinfo.value.code == code


def test_truncation_is_distinguished_from_a_mismatched_tag():
    """Both are ill-formed XML; only one means the upload was cut off."""
    truncated = '<?xml version="1.0"?><schema xmlns="%s"><pattern id="p' % SCHEMATRON_NS
    with pytest.raises(SchematronParseError) as excinfo:
        parse_schematron(truncated)
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_dtd_is_refused_by_the_hardened_xml_reader():
    hostile = (
        '<?xml version="1.0"?><!DOCTYPE schema [<!ENTITY a "x">]>'
        f'<schema xmlns="{SCHEMATRON_NS}"/>'
    )
    with pytest.raises(SchematronParseError) as excinfo:
        parse_schematron(hostile)
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


# ===========================================================================
# Projection: what maps
# ===========================================================================


def test_a_bare_child_path_projects_onto_member_presence():
    entry, rule = _one("Total")
    assert entry.outcome == OUTCOME_PROJECTED
    assert entry.target == "Invoice"
    assert rule.scope == SCOPE_CANONICAL
    assert rule.given == ("$.elements['Invoice'].children",)
    assert rule.then[0].field == "Total" and rule.then[0].function == "defined"


def test_an_attribute_step_projects_onto_the_attribute_bucket():
    _, rule = _one("@currency")
    assert rule.given == ("$.elements['Invoice'].attributes",)
    assert rule.then[0].field == "currency"


def test_not_and_report_both_invert_presence_and_two_inversions_cancel():
    assert _then(_one("not(Total)")[1])["function"] == "undefined"
    assert _then(_one("Total", kind="report")[1])["function"] == "undefined"
    assert _then(_one("not(Total)", kind="report")[1])["function"] == "defined"


def test_existence_counts_project_onto_presence():
    for test in ("count(Line) >= 1", "count(Line) > 0", "exists(Line)"):
        entry, rule = _one(test)
        assert entry.outcome == OUTCOME_PROJECTED, test
        assert _then(rule)["function"] == "defined", test
    # `count(X) = 0` is the absence form.
    assert _then(_one("count(Line) = 0")[1])["function"] == "undefined"


def test_a_higher_count_bound_narrows_to_presence_and_says_so():
    entry, _ = _one("count(Line) >= 3")
    assert entry.outcome == OUTCOME_PROJECTED
    assert any("bounds how many times" in note for note in entry.notes)


def test_a_report_on_a_higher_count_bound_is_not_projected():
    """`report count(X) > 50` does not mean "X must not be declared" — refuse to guess."""
    entry, _ = _one("count(Line) > 50", kind="report")
    assert entry.outcome == OUTCOME_DECLARED
    assert entry.reason == REASON_INSTANCE_VALUE_ASSERTION


def test_an_upper_count_bound_alone_is_not_a_presence_assertion():
    entry, _ = _one("count(Line) &lt;= 3")
    assert entry.outcome == OUTCOME_DECLARED


def test_a_value_set_projects_onto_the_declared_enumeration():
    _, rule = _one("Currency = ('EUR', 'GBP', 'USD')")
    assert rule.given == ("$.elements['Invoice'].children['Currency'].enum[*]",)
    assert rule.then[0].function == "enumeration"
    assert rule.then[0].function_options == {"values": ["EUR", "GBP", "USD"]}


def test_a_single_literal_equality_is_a_one_value_enumeration():
    _, rule = _one("CustomizationID = 'urn:example:3.0'")
    assert rule.then[0].function_options == {"values": ["urn:example:3.0"]}


def test_a_multi_step_path_checks_its_first_step_and_says_what_it_skipped():
    entry, rule = _one("Supplier/Party/Name")
    assert entry.outcome == OUTCOME_PROJECTED
    assert _then(rule)["field"] == "Supplier"
    assert any("walks 3 steps" in note for note in entry.notes)


def test_namespace_prefixes_are_dropped_and_the_drop_is_recorded():
    entry, rule = _one("cbc:ID", context="ubl:Invoice")
    assert entry.target == "Invoice"
    assert _then(rule)["field"] == "ID"
    assert any("prefix `cbc:` is dropped" in note for note in entry.notes)


# ===========================================================================
# Projection: what does not map, and why
# ===========================================================================


@pytest.mark.parametrize(
    ("test", "context", "kind", "reason"),
    [
        ("Total = $lineSum", "Invoice", "assert", REASON_VARIABLE_REFERENCE),
        ("string-length(Country) = 2", "Invoice", "assert", REASON_UNSUPPORTED_XPATH_FUNCTION),
        ("not(Due) or Due >= Issued", "Invoice", "assert", REASON_UNSUPPORTED_XPATH_OPERATOR),
        ("Issued castable as xs:date", "Invoice", "assert", REASON_UNSUPPORTED_XPATH_OPERATOR),
        ("Total &gt; 0", "Invoice", "assert", REASON_INSTANCE_VALUE_ASSERTION),
        ("Tax/Code = ('S', 'Z')", "Invoice", "assert", REASON_UNSUPPORTED_XPATH_PATH),
        ("Code = 'E'", "Invoice", "report", REASON_UNSUPPORTED_REPORT_INVERSION),
        ("Total", "Party[@role = 'seller']", "assert", REASON_CONTEXT_PREDICATE),
        ("Total", "//Invoice", "assert", REASON_CONTEXT_NOT_PROJECTABLE),
        ("Total", "*", "assert", REASON_CONTEXT_NOT_PROJECTABLE),
    ],
)
def test_unprojectable_shapes_report_their_specific_reason(test, context, kind, reason):
    entry, _ = _one(test, context=context, kind=kind)
    assert entry.outcome == OUTCOME_DECLARED
    assert entry.reason == reason
    assert entry.detail, "a declared rule must explain itself"


def test_a_regex_literal_does_not_masquerade_as_a_variable_reference():
    """`$` inside a quoted pattern is not a `let` — classification masks literals first."""
    entry, _ = _one("matches(@id, '^[A-Z]{3}$')")
    assert entry.reason == REASON_UNSUPPORTED_XPATH_FUNCTION


def test_an_assertion_with_no_test_is_declared_rather_than_dropped():
    body = '<pattern id="p"><rule context="Invoice"><assert id="R1">m</assert></rule></pattern>'
    result = import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED)
    assert result.entries[0].reason == REASON_NO_TEST


def test_project_assertion_reads_only_kind_context_and_test():
    """The projection is usable on its own — it never needs the importer around it."""

    class _Assertion:
        kind = "assert"
        context = "Invoice"
        test = "TaxId"

    projection = project_assertion(_Assertion())
    assert projection.projected
    assert projection.rule is not None
    assert projection.rule.target == "Invoice"
    assert projection.unprojectable is None


def test_a_projection_the_dsl_rejects_is_recorded_rather_than_raised():
    """The machine-built rule is still user input at one remove — it must never blow up."""
    long_name = "E" + "x" * 600  # a `given` past the DSL's JSONPath length cap
    body = (
        f'<pattern id="p"><rule context="{long_name}">'
        '<assert test="child" id="R1">m</assert></rule></pattern>'
    )
    result = import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED)

    assert result.entries[0].outcome == OUTCOME_DECLARED
    assert result.entries[0].reason == REASON_INVALID_PROJECTION
    assert "exceeds 512 characters" in (result.entries[0].detail or "")
    stored = result.custom_rules.rules[0]
    assert stored.scope == SCOPE_DECLARED and stored.given == ()


def test_a_very_long_explanation_is_trimmed_rather_than_losing_its_reason():
    """The detail quotes the offending XPath; a huge one must not collapse the reason code."""
    long_test = "Total = $" + "v" * 2000
    body = (
        '<pattern id="p"><rule context="Invoice">'
        f'<assert test="{long_test}" id="R1">m</assert></rule></pattern>'
    )
    result = import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED)

    assert result.entries[0].reason == REASON_VARIABLE_REFERENCE
    assert result.entries[0].detail.endswith("…")
    assert result.custom_rules.rules[0].unevaluable.reason == REASON_VARIABLE_REFERENCE


def test_every_declared_reason_is_a_registered_code():
    for name in ("04-stress-phases-and-diagnostics.sch", "05-real-world-billing-bis-rules.sch"):
        for entry in _import(name).entries:
            if entry.reason:
                assert entry.reason in PROJECTION_REASONS, entry.reason


# ===========================================================================
# The governance document
# ===========================================================================


def _invoice_model(currencies: List[str] | None = None, with_tax_id: bool = True) -> CanonicalApi:
    """Build a small UBL-shaped canonical model to score Schematron rules against."""
    fields = [
        CanonicalField(key="Invoice.ID", name="ID", type=TypeRef(name="string", nullable=False)),
        CanonicalField(
            key="Invoice.Currency",
            name="Currency",
            type=TypeRef(name="CurrencyCode"),
            constraints=Constraints(enum=list(currencies)) if currencies else None,
        ),
        CanonicalField(key="Invoice.@number", name="@number", type=TypeRef(name="string")),
    ]
    if with_tax_id:
        fields.append(
            CanonicalField(key="Invoice.TaxId", name="TaxId", type=TypeRef(name="string"))
        )
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="xsd",
        identity=ApiIdentity(name="billing"),
        types=[
            Type(key="Invoice", name="Invoice", kind=TypeKind.RECORD, fields=fields),
            Type(
                key="CurrencyCode",
                name="CurrencyCode",
                kind=TypeKind.ENUM,
                enum_values=[EnumValue(key="CurrencyCode.EUR", name="EUR")],
            ),
        ],
    )


def test_the_governance_document_keys_elements_and_splits_attributes():
    document = canonical_governance_document(_invoice_model())
    invoice = document[CANONICAL_ROOT_KEY]["Invoice"]

    assert set(invoice["children"]) == {"ID", "Currency", "TaxId"}
    assert set(invoice["attributes"]) == {"number"}  # the `@` sigil is the attribute marker
    assert invoice["children"]["ID"]["required"] is True


def test_a_member_inherits_the_enumeration_of_the_enum_type_it_references():
    document = canonical_governance_document(_invoice_model())
    assert document[CANONICAL_ROOT_KEY]["Invoice"]["children"]["Currency"]["enum"] == ["EUR"]


def test_inline_constraints_win_over_a_referenced_enum_type():
    document = canonical_governance_document(_invoice_model(currencies=["GBP"]))
    assert document[CANONICAL_ROOT_KEY]["Invoice"]["children"]["Currency"]["enum"] == ["GBP"]


def test_a_member_marked_an_attribute_by_extras_reaches_the_attribute_bucket():
    """XSD and RELAX NG mark attributes in `extras`; only DTD uses the `@` sigil."""
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="xsd",
        identity=ApiIdentity(name="billing"),
        types=[
            Type(
                key="AmountType",
                name="AmountType",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="AmountType.currencyID",
                        name="currencyID",
                        type=TypeRef(name="string"),
                        extras={"xsd_kind": "attribute"},
                    ),
                    CanonicalField(
                        key="AmountType.Value", name="Value", type=TypeRef(name="double")
                    ),
                ],
            )
        ],
    )
    amount = canonical_governance_document(api)[CANONICAL_ROOT_KEY]["AmountType"]
    assert set(amount["attributes"]) == {"currencyID"}
    assert set(amount["children"]) == {"Value"}


def test_a_type_that_declares_an_element_is_addressable_by_the_element_name():
    """DTD/RELAX NG record the element a type declares; a Schematron context names *that*."""
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="relaxng",
        identity=ApiIdentity(name="catalogue"),
        types=[
            Type(
                key="catalogueDef",
                name="catalogueDef",
                kind=TypeKind.RECORD,
                extras={"relaxng_element": "catalogue"},
                fields=[
                    CanonicalField(
                        key="catalogueDef.product", name="product", type=TypeRef(name="string")
                    )
                ],
            )
        ],
    )
    elements = canonical_governance_document(api)[CANONICAL_ROOT_KEY]

    assert "catalogueDef" in elements and "catalogue" in elements
    assert elements["catalogue"]["children"].keys() == {"product"}


def test_an_xsd_derived_model_is_addressable_by_its_declared_element_names():
    """XSD names the complex type `InvoiceType` and the element `Invoice`; rules say `Invoice`."""
    from app.import_source import get_import_source, resolve_import_source_key

    source = (
        Path(__file__).resolve().parents[2]
        / "apiome-ui"
        / "examples"
        / "xsd"
        / "05-ubl-invoice-shape.xsd"
    ).read_text(encoding="utf-8")
    adapter = get_import_source(resolve_import_source_key("xsd"))
    api = adapter.normalize(adapter.parse(source), include_raw=False)

    elements = canonical_governance_document(api)[CANONICAL_ROOT_KEY]
    assert "InvoiceType" in elements
    assert elements["Invoice"] is elements["InvoiceType"]
    assert "currencyID" in elements["AmountType"]["attributes"]


def test_an_imported_profile_scores_a_real_xsd_derived_catalog_item():
    """Acceptance criterion 4, end to end on a corpus fixture rather than a hand-built model."""
    from app.import_source import get_import_source, resolve_import_source_key

    source = (
        Path(__file__).resolve().parents[2]
        / "apiome-ui"
        / "examples"
        / "xsd"
        / "05-ubl-invoice-shape.xsd"
    ).read_text(encoding="utf-8")
    adapter = get_import_source(resolve_import_source_key("xsd"))
    api = adapter.normalize(adapter.parse(source), include_raw=False)

    body = (
        '<pattern id="p"><rule context="ubl:Invoice">'
        '<assert test="cbc:PaymentTerms" id="BR-99" role="fatal">An invoice shall state payment terms.</assert>'
        '<assert test="cbc:ID" id="BR-02" role="fatal">An invoice shall have an invoice number.</assert>'
        "</rule></pattern>"
    )
    guide = _guide_from(import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED))
    scored = apply_style_guide_to_canonical_result(lint_canonical_model(api), guide, api)

    hits = {finding.rule for finding in scored.findings}
    assert "schematron.br-99" in hits  # the XSD declares no PaymentTerms
    assert "schematron.br-02" not in hits  # it does declare an ID


# ===========================================================================
# Acceptance criteria
# ===========================================================================


def test_a_schematron_file_imports_as_a_style_guide_with_one_rule_per_assertion():
    """Acceptance criterion 1, against the Peppol-shaped profile."""
    result = _import("05-real-world-billing-bis-rules.sch")
    document = parse_schematron(_fixture("05-real-world-billing-bis-rules.sch"))

    ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=RESERVED)
    assert len(result.entries) == len(document.assertions)
    assert len(ruleset.rules) == len(document.assertions)
    assert [rule.rule_id for rule in ruleset.rules] == [e.rule_id for e in result.entries]
    assert result.guide_name == "Cross-border billing profile — business rules"


def test_severity_and_phase_map_onto_the_lint_vocabulary():
    """Acceptance criterion 2."""
    result = _import("04-stress-phases-and-diagnostics.sch")

    assert result.resolved_phase == "submission"
    assert list(result.phases) == ["submission", "publication"]
    assert {entry.severity for entry in result.entries} <= {"error", "warning", "info"}
    # `role="error"` -> error; a pattern the resolved phase does not activate is not evaluated.
    assert _entry(result, "STR-001").severity == "error"
    assert _entry(result, "XRF-002").reason == REASON_INACTIVE_PHASE


def test_a_more_specific_projection_reason_outranks_the_phase_reason():
    """An out-of-phase rule that *also* cannot project reports the useful fact."""
    result = _import("04-stress-phases-and-diagnostics.sch")
    entry = _entry(result, "XRF-001")
    assert entry.active is False
    assert entry.reason == REASON_UNSUPPORTED_XPATH_FUNCTION
    assert "resolve-external()" in (entry.detail or "")


def test_unevaluable_rules_are_stored_declared_with_a_reason_never_dropped():
    """Acceptance criterion 3: visible in the guide itself, not only in the report."""
    result = _import("04-stress-phases-and-diagnostics.sch")
    ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=RESERVED)
    by_id = {rule.rule_id: rule for rule in ruleset.rules}

    declared = [entry for entry in result.entries if entry.outcome == OUTCOME_DECLARED]
    assert declared, "the stress fixture carries deliberately unevaluable rules"
    for entry in declared:
        rule = by_id[entry.rule_id]
        assert rule.scope == SCOPE_DECLARED
        assert rule.unevaluable is not None
        assert rule.unevaluable.reason == entry.reason
        assert rule.unevaluable.detail
        assert not rule.is_evaluable()


def test_a_declared_rule_never_produces_a_finding_in_any_scope():
    result = _import("04-stress-phases-and-diagnostics.sch")
    ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=RESERVED)
    declared_ids = {
        entry.rule_id for entry in result.entries if entry.outcome == OUTCOME_DECLARED
    }
    document = canonical_governance_document(_invoice_model())

    for scope in (SCOPE_DOCUMENT, SCOPE_CANONICAL, SCOPE_DECLARED):
        evaluation = evaluate_custom_rules(ruleset, document, scope=scope)
        assert not declared_ids & {finding.rule for finding in evaluation.findings}


def test_applying_an_imported_schematron_guide_rescores_a_catalog_item():
    """Acceptance criterion 4: the imported profile changes a canonical item's score."""
    body = (
        '<pattern id="core"><rule context="ubl:Invoice">'
        '<assert test="cbc:TaxId" id="BR-90" role="fatal">An invoice shall declare a tax id.</assert>'
        '<assert test="cbc:Currency = (\'GBP\')" id="BR-91" role="error">Currency must be GBP.</assert>'
        "</rule></pattern>"
    )
    result = import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED)
    guide = _guide_from(result)

    clean = _invoice_model(currencies=["GBP"], with_tax_id=True)
    dirty = _invoice_model(currencies=["EUR"], with_tax_id=False)

    clean_scored = apply_style_guide_to_canonical_result(lint_canonical_model(clean), guide, clean)
    dirty_scored = apply_style_guide_to_canonical_result(lint_canonical_model(dirty), guide, dirty)

    clean_rules = {finding.rule for finding in clean_scored.findings}
    dirty_rules = {finding.rule for finding in dirty_scored.findings}
    assert f"{RULE_ID_PREFIX}.br-90" not in clean_rules
    assert f"{RULE_ID_PREFIX}.br-90" in dirty_rules  # the missing tax id is caught
    assert f"{RULE_ID_PREFIX}.br-91" in dirty_rules  # EUR is outside the allowed set
    assert dirty_scored.score < clean_scored.score


def test_an_imported_guide_leaves_an_unrelated_canonical_item_untouched():
    """A rule whose context names no declared element fires on nothing — Schematron semantics."""
    body = (
        '<pattern id="core"><rule context="Order">'
        '<assert test="PlacedAt" id="ORD-1" role="error">Orders record when placed.</assert>'
        "</rule></pattern>"
    )
    guide = _guide_from(import_schematron_ruleset(_sch(body), reserved_rule_ids=RESERVED))
    api = _invoice_model()

    scored = apply_style_guide_to_canonical_result(lint_canonical_model(api), guide, api)
    assert not [f for f in scored.findings if f.rule.startswith(f"{RULE_ID_PREFIX}.")]


@pytest.mark.parametrize(
    ("fixture", "assertions", "projected"),
    [
        ("01-minimal-single-assert.sch", 1, 1),
        ("02-typical-invoice-rules.sch", 9, 1),
        ("03-composition-abstract-patterns.sch", 8, 6),
        ("04-stress-phases-and-diagnostics.sch", 10, 3),
        ("05-real-world-billing-bis-rules.sch", 16, 10),
    ],
)
def test_corpus_coverage_matches_the_published_table(fixture, assertions, projected):
    """Pins the counts ``apiome-ui/examples/schematron/README.md`` publishes."""
    result = _import(fixture)
    assert (result.assertion_count, result.projected_count) == (assertions, projected)
    assert result.declared_count == assertions - projected


def test_the_corpus_carries_a_peppol_shaped_profile_and_an_abstract_pattern_grammar():
    """Acceptance criterion 5, asserted on the shipped fixtures rather than on prose."""
    peppol = _import("05-real-world-billing-bis-rules.sch")
    assert peppol.projected_count >= 8
    assert [e.assertion_id for e in peppol.entries][:3] == ["BR-01", "BR-02", "BR-03"]

    abstract = _import("03-composition-abstract-patterns.sch")
    assert any(e.assertion_id.startswith("ABS-R001") for e in abstract.entries)
    assert abstract.coverage >= 0.5


# ===========================================================================
# Importer mechanics
# ===========================================================================


def test_every_imported_rule_id_is_prefixed_and_cannot_shadow_a_builtin():
    result = _import("05-real-world-billing-bis-rules.sch")
    assert all(entry.rule_id.startswith(f"{RULE_ID_PREFIX}.") for entry in result.entries)
    assert not {entry.rule_id for entry in result.entries} & RESERVED


def test_rule_ids_are_slugged_and_deduplicated():
    taken: Dict[str, Any] = {}
    first = schematron_rule_id("BR-CO-10", taken, 0)
    taken[first] = True
    second = schematron_rule_id("br.co.10", taken, 1)  # slugs to the same id
    taken[second] = True

    assert first == "schematron.br-co-10"
    assert second == "schematron.br-co-10-2"
    assert schematron_rule_id("///", taken, 7) == "schematron.rule-8"


def test_an_assertion_without_an_id_gets_a_derived_coordinate():
    result = _import("01-minimal-single-assert.sch")
    assert result.entries[0].assertion_id == "identity-1"
    assert result.entries[0].rule_id == "schematron.identity-1"


def test_diagnostics_become_remediation_on_the_rule_description():
    result = _import("04-stress-phases-and-diagnostics.sch")
    ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=RESERVED)
    description = {rule.rule_id: rule.description for rule in ruleset.rules}[
        _entry(result, "STR-001").rule_id
    ]
    assert description.startswith("A document must have a header.")
    assert "Add a doc:Header element" in description


def test_the_import_is_deterministic():
    first = _import("05-real-world-billing-bis-rules.sch")
    second = _import("05-real-world-billing-bis-rules.sch")
    assert first.yaml == second.yaml
    assert [e.rule_id for e in first.entries] == [e.rule_id for e in second.entries]


def test_everything_the_importer_emits_round_trips_through_the_dsl():
    """Whatever is produced must be storable by the GOV-2.3 custom-rules endpoint."""
    for name in (
        "01-minimal-single-assert.sch",
        "02-typical-invoice-rules.sch",
        "03-composition-abstract-patterns.sch",
        "04-stress-phases-and-diagnostics.sch",
        "05-real-world-billing-bis-rules.sch",
    ):
        result = _import(name)
        ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=RESERVED)
        assert len(ruleset.rules) == len(result.entries), name


def test_assertions_past_the_guide_ceiling_are_reported_and_not_stored():
    rules = "".join(
        f'<rule context="E{index}"><assert test="child" id="R{index}">m</assert></rule>'
        for index in range(MAX_RULES_PER_GUIDE + 3)
    )
    result = import_schematron_ruleset(
        _sch(f'<pattern id="p">{rules}</pattern>'), reserved_rule_ids=RESERVED
    )

    assert result.assertion_count == MAX_RULES_PER_GUIDE + 3
    overflow = [entry for entry in result.entries if not entry.stored]
    assert len(overflow) == 3
    assert all(entry.reason == REASON_RULE_LIMIT for entry in overflow)
    assert any("were imported and the rest are reported" in note for note in result.notes)
    assert len(parse_style_guide_yaml(result.yaml).rules) == MAX_RULES_PER_GUIDE


# ===========================================================================
# The DSL additions the projection needs
# ===========================================================================


def test_a_document_scoped_rule_serializes_exactly_as_before():
    """The additive keys must not perturb a stored guide's content fingerprint."""
    rule = validate_custom_definition(
        "r1", {"description": "d", "given": "$.info", "then": {"function": "truthy"}}
    )
    assert rule.scope == SCOPE_DOCUMENT
    assert rule.as_dict() == {
        "description": "d",
        "severity": "warning",
        "given": ["$.info"],
        "then": [{"function": "truthy"}],
    }


def test_a_declared_rule_must_say_why_and_other_scopes_must_not():
    with pytest.raises(CustomRuleValidationError) as missing:
        validate_custom_definition("r1", {"description": "d", "scope": "declared"})
    assert missing.value.pointer == "r1.unevaluable"

    with pytest.raises(CustomRuleValidationError) as extra:
        validate_custom_definition(
            "r1",
            {
                "description": "d",
                "given": "$.info",
                "then": {"function": "truthy"},
                "unevaluable": {"reason": "nope"},
            },
        )
    assert extra.value.pointer == "r1.unevaluable"


def test_an_unevaluable_reason_must_be_a_stable_code():
    with pytest.raises(CustomRuleValidationError) as excinfo:
        validate_custom_definition(
            "r1",
            {"description": "d", "scope": "declared", "unevaluable": {"reason": "Not A Code"}},
        )
    assert excinfo.value.pointer == "r1.unevaluable.reason"


def test_an_unknown_scope_is_rejected():
    with pytest.raises(CustomRuleValidationError) as excinfo:
        validate_custom_definition(
            "r1", {"description": "d", "scope": "instance", "given": "$", "then": {"function": "truthy"}}
        )
    assert excinfo.value.pointer == "r1.scope"


def test_canonical_and_declared_rules_are_kept_out_of_a_generated_spectral_ruleset():
    """The external linter is real Spectral; it must never be handed a rule it cannot load."""
    from app.openapi_validation_profiles import (
        PROFILE_TENANT_GUIDE,
        custom_rules_from_guide_rows,
        render_tenant_guide_spectral_ruleset,
        spectral_ruleset_path,
    )

    result = _import("05-real-world-billing-bis-rules.sch")
    rows = [
        {
            "rule_id": rule.rule_id,
            "enabled": True,
            "severity": rule.severity,
            "custom_def": rule.as_dict(),
        }
        for rule in result.custom_rules.rules
    ] + [
        {
            "rule_id": "servers-use-https",
            "enabled": True,
            "severity": "error",
            "custom_def": {
                "description": "d",
                "severity": "error",
                "given": ["$.servers[*].url"],
                "then": [{"function": "truthy"}],
            },
        }
    ]

    exportable = custom_rules_from_guide_rows(rows)
    assert set(exportable) == {"servers-use-https"}

    overlay = render_tenant_guide_spectral_ruleset(
        baseline_ruleset=spectral_ruleset_path(PROFILE_TENANT_GUIDE),
        custom_rules=exportable,
        custom_rules_yaml=result.yaml,
    )
    assert "schematron." not in overlay
    assert "servers-use-https" in overlay


def test_scope_partitions_evaluation():
    ruleset = parse_style_guide_yaml(
        "rules:\n"
        "  doc-rule:\n"
        "    description: d\n"
        "    given: $.elements\n"
        "    then: {function: truthy}\n"
        "  canonical-rule:\n"
        "    description: c\n"
        "    scope: canonical\n"
        "    given: $.elements\n"
        "    then: {function: undefined}\n"
    )
    document = {"elements": {}}

    assert {f.rule for f in evaluate_custom_rules(ruleset, document).findings} == {"doc-rule"}
    assert {
        f.rule for f in evaluate_custom_rules(ruleset, document, scope=SCOPE_CANONICAL).findings
    } == {"canonical-rule"}


# ===========================================================================
# Helpers
# ===========================================================================


def _guide_from(result):
    """Compile a style guide whose custom rows are an import result's rules."""
    rows = [
        {
            "rule_id": rule.rule_id,
            "enabled": True,
            "severity": rule.severity,
            "custom_def": rule.as_dict(),
        }
        for rule in result.custom_rules.rules
    ]
    return compile_style_guide("guide-1", "Imported profile", "custom", rows)
