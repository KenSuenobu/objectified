"""Spectral ruleset importer — GOV-1.5 (#4431).

Covers the three per-rule outcomes (custom / builtin / unsupported), every reason code, the
lossy-translation notes, and the acceptance criterion: a Zalando-style public ruleset imports
with at least 70% of its rules mapped.
"""

from pathlib import Path

import pytest

from app.custom_rule_dsl import (
    MAX_RULES_PER_GUIDE,
    parse_style_guide_yaml,
    validate_custom_definition,
)
from app.lint_rule_registry import builtin_rule_ids
from app.spectral_import import (
    MAX_RULESET_BYTES,
    OUTCOME_BUILTIN,
    OUTCOME_CUSTOM,
    OUTCOME_UNSUPPORTED,
    REASON_INVALID_DEFINITION,
    REASON_JS_FUNCTION,
    REASON_MALFORMED_RULE,
    REASON_RULE_LIMIT,
    REASON_UNKNOWN_ALIAS,
    REASON_UNKNOWN_RULE,
    REASON_UNMAPPED_BUILTIN,
    REASON_UNSUPPORTED_EXTENDS,
    REASON_UNSUPPORTED_FUNCTION,
    REASON_UNSUPPORTED_SEVERITY,
    SPECTRAL_OAS,
    SpectralImportError,
    builtin_rules_for_spectral_rule,
    import_spectral_ruleset,
    supported_spectral_rulesets,
)

FIXTURE = Path(__file__).parent / "fixtures" / "spectral" / "zalando-style.spectral.yaml"

#: The acceptance criterion of GOV-1.5 (#4431).
MIN_COVERAGE = 0.70


def _entry(result, source_rule_id):
    """Return the single entry for ``source_rule_id`` (fails loudly when absent)."""
    matches = [e for e in result.entries if e.source_rule_id == source_rule_id]
    assert matches, f"no entry for {source_rule_id!r}"
    return matches[0]


def _rule(then_body="{function: truthy}", **keys):
    """Build a one-rule ruleset document with ``keys`` merged into the rule definition."""
    lines = ["rules:", "  r1:", "    description: d", "    given: $.info", f"    then: {then_body}"]
    for key, value in keys.items():
        lines.append(f"    {key}: {value}")
    return "\n".join(lines) + "\n"


# --- Acceptance criterion ----------------------------------------------------------------------


def test_zalando_style_ruleset_maps_at_least_seventy_percent():
    result = import_spectral_ruleset(FIXTURE.read_text(), source_label="zalando-style.spectral.yaml")

    assert result.source_label == "zalando-style.spectral.yaml"
    assert result.rule_count == len(result.entries)
    assert result.mapped_count + result.unsupported_count == result.rule_count
    assert result.coverage >= MIN_COVERAGE, (
        f"coverage {result.coverage} below the {MIN_COVERAGE} acceptance criterion; "
        f"unsupported: {[(e.source_rule_id, e.reason) for e in result.entries if e.reason]}"
    )


def test_zalando_style_import_round_trips_through_the_dsl():
    """Everything the importer emits must be storable by the GOV-1.3 custom-rules endpoint."""
    result = import_spectral_ruleset(FIXTURE.read_text())

    ruleset = parse_style_guide_yaml(result.yaml, reserved_rule_ids=frozenset(builtin_rule_ids()))
    assert [rule.rule_id for rule in ruleset.rules] == [
        rule.rule_id for rule in result.custom_rules.rules
    ]
    assert len(ruleset.rules) == sum(
        1 for e in result.entries if e.outcome == OUTCOME_CUSTOM and e.enabled
    )


def test_zalando_style_unsupported_rules_all_carry_a_reason_and_detail():
    result = import_spectral_ruleset(FIXTURE.read_text())

    unsupported = [e for e in result.entries if e.outcome == OUTCOME_UNSUPPORTED]
    assert unsupported, "the fixture deliberately contains untranslatable rules"
    for entry in unsupported:
        assert entry.reason and entry.detail
        assert entry.rule_id is None and entry.builtin_rule_ids == ()
    assert {e.reason for e in unsupported} == {
        REASON_UNMAPPED_BUILTIN,
        REASON_UNSUPPORTED_FUNCTION,
        REASON_JS_FUNCTION,
    }


# --- extends -----------------------------------------------------------------------------------


def test_extends_spectral_oas_inherits_mapped_builtin_rules():
    result = import_spectral_ruleset("extends: spectral:oas\nrules: {}\n")

    assert [x.target for x in result.extends] == [SPECTRAL_OAS]
    assert result.extends[0].supported is True
    assert result.extends[0].mapped_rule_count == len(result.builtin_rules)
    assert result.builtin_rules
    assert all(row.enabled for row in result.builtin_rules)
    assert [row.rule_id for row in result.builtin_rules] == sorted(
        row.rule_id for row in result.builtin_rules
    )


def test_extends_targets_map_onto_registered_builtin_rule_ids():
    """Guards drift: every mapping target must still exist in the GOV-1.2 registry."""
    registered = set(builtin_rule_ids())
    result = import_spectral_ruleset("extends: spectral:oas\nrules: {}\n")

    assert result.builtin_rules
    for row in result.builtin_rules:
        assert row.rule_id in registered, f"{row.rule_id} is not a registered built-in rule"
        assert row.severity in {"error", "warning", "info"}


def test_extends_off_modifier_inherits_rules_disabled():
    result = import_spectral_ruleset("extends: [[spectral:oas, off]]\nrules: {}\n")

    assert result.extends[0].modifier == "off"
    assert result.builtin_rules and not any(row.enabled for row in result.builtin_rules)
    assert any("every rule disabled" in note for note in result.notes)


def test_unsupported_extends_is_reported_with_a_reason():
    result = import_spectral_ruleset(
        "extends:\n  - spectral:asyncapi\n  - ./local.yaml\nrules: {}\n"
    )

    assert [x.target for x in result.extends] == ["spectral:asyncapi", "./local.yaml"]
    for entry in result.extends:
        assert entry.supported is False
        assert entry.reason == REASON_UNSUPPORTED_EXTENDS
        assert "spectral:oas" in entry.detail
    assert result.builtin_rules == ()


def test_malformed_extends_entry_is_noted_not_fatal():
    result = import_spectral_ruleset("extends: [{a: 1}]\nrules: {}\n")

    assert result.extends == ()
    assert any("malformed 'extends'" in note for note in result.notes)


def test_supported_rulesets_and_rule_map_are_public():
    assert supported_spectral_rulesets() == (SPECTRAL_OAS,)
    assert builtin_rules_for_spectral_rule("info-description")
    assert builtin_rules_for_spectral_rule("no-such-spectral-rule") == ()


# --- Severity overrides of inherited rules -------------------------------------------------------


@pytest.mark.parametrize(
    "token,expected_enabled,expected_severity",
    [
        ("error", True, "error"),
        ("warn", True, "warning"),
        ("info", True, "info"),
        ("hint", True, "info"),
        ("off", False, None),
        ("true", True, None),
        ("false", False, None),
        ("0", True, "error"),
        ("1", True, "warning"),
        ("3", True, "info"),
        ("-1", False, None),
    ],
)
def test_severity_tokens_resolve(token, expected_enabled, expected_severity):
    result = import_spectral_ruleset(
        f"extends: spectral:oas\nrules:\n  info-description: {token}\n"
    )

    entry = _entry(result, "info-description")
    assert entry.outcome == OUTCOME_BUILTIN
    assert entry.enabled is expected_enabled
    assert entry.severity == expected_severity
    assert "documentation.info-missing-description" in entry.builtin_rule_ids


def test_severity_override_updates_the_builtin_rows():
    result = import_spectral_ruleset(
        "extends: spectral:oas\nrules:\n  info-description: error\n  operation-description: off\n"
    )

    rows = {row.rule_id: row for row in result.builtin_rules}
    assert rows["documentation.info-missing-description"].severity == "error"
    assert rows["documentation.info-missing-description"].enabled is True
    assert rows["documentation.info-missing-description"].source_rule_id == "info-description"
    assert rows["documentation.operation-missing-summary"].enabled is False


def test_bare_true_keeps_the_inherited_severity():
    result = import_spectral_ruleset("extends: spectral:oas\nrules:\n  info-description: true\n")

    rows = {row.rule_id: row for row in result.builtin_rules}
    inherited = rows["documentation.info-missing-description"]
    assert inherited.enabled is True
    assert inherited.severity in {"error", "warning", "info"}


def test_unknown_severity_token_is_unsupported():
    result = import_spectral_ruleset("extends: spectral:oas\nrules:\n  info-description: loud\n")

    entry = _entry(result, "info-description")
    assert entry.outcome == OUTCOME_UNSUPPORTED
    assert entry.reason == REASON_UNSUPPORTED_SEVERITY
    assert entry.pointer == "rules.info-description"


def test_spectral_rule_without_an_apiome_equivalent_is_unmapped_builtin():
    result = import_spectral_ruleset("extends: spectral:oas\nrules:\n  operation-tags: warn\n")

    entry = _entry(result, "operation-tags")
    assert entry.outcome == OUTCOME_UNSUPPORTED
    assert entry.reason == REASON_UNMAPPED_BUILTIN


def test_severity_for_a_rule_no_ruleset_defines_is_unknown_rule():
    result = import_spectral_ruleset("extends: spectral:oas\nrules:\n  our-internal-rule: warn\n")

    entry = _entry(result, "our-internal-rule")
    assert entry.outcome == OUTCOME_UNSUPPORTED
    assert entry.reason == REASON_UNKNOWN_RULE


def test_inherited_rule_without_extends_is_unknown_rule():
    result = import_spectral_ruleset("rules:\n  info-description: error\n")

    assert _entry(result, "info-description").reason == REASON_UNKNOWN_RULE
    assert result.builtin_rules == ()


# --- Custom rule translation ---------------------------------------------------------------------


def test_custom_rule_is_translated_into_the_dsl():
    result = import_spectral_ruleset(
        "rules:\n"
        "  servers-use-https:\n"
        "    description: Every server URL uses https.\n"
        "    severity: error\n"
        "    given: $.servers[*].url\n"
        "    then: {function: pattern, functionOptions: {match: '^https://'}}\n"
    )

    entry = _entry(result, "servers-use-https")
    assert entry.outcome == OUTCOME_CUSTOM
    assert entry.rule_id == "servers-use-https"
    assert entry.severity == "error"
    assert entry.notes == ()
    rule = result.custom_rules.rules[0]
    assert rule.given == ("$.servers[*].url",)
    assert rule.then[0].function == "pattern"
    assert result.coverage == 1.0


def test_list_given_and_then_are_preserved():
    result = import_spectral_ruleset(
        "rules:\n"
        "  described:\n"
        "    description: d\n"
        "    given:\n"
        "      - $.info\n"
        "      - $.externalDocs\n"
        "    then:\n"
        "      - {field: description, function: truthy}\n"
        "      - {field: description, function: pattern, functionOptions: {match: '\\\\S'}}\n"
    )

    rule = result.custom_rules.rules[0]
    assert rule.given == ("$.info", "$.externalDocs")
    assert [clause.function for clause in rule.then] == ["truthy", "pattern"]


def test_default_severity_is_warning():
    result = import_spectral_ruleset(_rule())

    assert _entry(result, "r1").severity == "warning"


def test_hint_severity_is_imported_as_info_with_a_note():
    result = import_spectral_ruleset(_rule(severity="hint"))

    entry = _entry(result, "r1")
    assert entry.severity == "info"
    assert any("hint" in note for note in entry.notes)


def test_rule_disabled_at_source_is_reported_but_not_serialized():
    result = import_spectral_ruleset(_rule(severity="off"))

    entry = _entry(result, "r1")
    assert entry.outcome == OUTCOME_CUSTOM
    assert entry.enabled is False
    assert result.custom_rules.rules == ()
    assert "rules: {}" in result.yaml


def test_recommended_false_disables_the_rule_with_a_note():
    result = import_spectral_ruleset(_rule(recommended="false"))

    entry = _entry(result, "r1")
    assert entry.enabled is False
    assert any("recommended" in note for note in entry.notes)


def test_message_formats_and_resolved_are_dropped_with_notes():
    result = import_spectral_ruleset(
        _rule(message="'{{path}} is wrong'", formats="[oas3]", resolved="false")
    )

    notes = " ".join(_entry(result, "r1").notes)
    assert "message" in notes and "formats" in notes and "resolved" in notes


def test_unknown_rule_keys_are_noted_and_ignored():
    result = import_spectral_ruleset(_rule(**{"x-owner": "platform-team"}))

    entry = _entry(result, "r1")
    assert entry.outcome == OUTCOME_CUSTOM
    assert any("x-owner" in note for note in entry.notes)


def test_missing_description_falls_back_to_message_then_to_the_rule_id():
    from_message = import_spectral_ruleset(
        "rules:\n"
        "  needs-summary:\n"
        "    message: Operations need a summary\n"
        "    given: $.info\n"
        "    then: {function: truthy}\n"
    )
    assert from_message.custom_rules.rules[0].description == "Operations need a summary"
    assert any("message" in note for note in _entry(from_message, "needs-summary").notes)

    from_id = import_spectral_ruleset(
        "rules:\n  needs-summary:\n    given: $.info\n    then: {function: truthy}\n"
    )
    assert from_id.custom_rules.rules[0].description == "needs summary"
    assert any("rule id" in note for note in _entry(from_id, "needs-summary").notes)


def test_templated_message_is_not_used_as_a_description():
    result = import_spectral_ruleset(
        "rules:\n"
        "  needs-summary:\n"
        "    message: '{{path}} is bad'\n"
        "    given: $.info\n"
        "    then: {function: truthy}\n"
    )

    assert result.custom_rules.rules[0].description == "needs summary"


# --- Rule id normalization ------------------------------------------------------------------------


def test_rule_id_is_normalized_with_a_note():
    result = import_spectral_ruleset(
        "rules:\n"
        "  Zalando/MUST Use Snake Case:\n"
        "    description: d\n"
        "    given: $.info\n"
        "    then: {function: truthy}\n"
    )

    entry = _entry(result, "Zalando/MUST Use Snake Case")
    assert entry.rule_id == "zalando-must-use-snake-case"
    assert any("normalized" in note for note in entry.notes)


def test_rule_id_shadowing_a_builtin_is_prefixed():
    builtin = builtin_rule_ids()[0]
    result = import_spectral_ruleset(
        f"rules:\n  {builtin}:\n    description: d\n    given: $.info\n    then: {{function: truthy}}\n"
    )

    entry = _entry(result, builtin)
    assert entry.outcome == OUTCOME_CUSTOM
    assert entry.rule_id == f"imported.{builtin}"
    validate_custom_definition(
        entry.rule_id, result.custom_rules.rules[0].as_dict(), reserved_rule_ids=frozenset([builtin])
    )


def test_colliding_normalized_ids_get_a_suffix():
    result = import_spectral_ruleset(
        "rules:\n"
        "  Must-Paginate:\n"
        "    description: a\n    given: $.info\n    then: {function: truthy}\n"
        "  must/paginate:\n"
        "    description: b\n    given: $.info\n    then: {function: truthy}\n"
    )

    assert [rule.rule_id for rule in result.custom_rules.rules] == ["must-paginate", "must-paginate-2"]


def test_rule_id_of_pure_punctuation_is_malformed():
    result = import_spectral_ruleset(
        "rules:\n  '///':\n    description: d\n    given: $.info\n    then: {function: truthy}\n"
    )

    entry = _entry(result, "///")
    assert entry.outcome == OUTCOME_UNSUPPORTED
    assert entry.reason == REASON_MALFORMED_RULE


# --- Functions ------------------------------------------------------------------------------------


@pytest.mark.parametrize("function", ["schema", "alphabetical", "xor", "falsy", "unreferencedReusableObject"])
def test_spectral_only_core_functions_are_unsupported(function):
    result = import_spectral_ruleset(_rule(then_body=f"{{function: {function}}}"))

    entry = _entry(result, "r1")
    assert entry.reason == REASON_UNSUPPORTED_FUNCTION
    assert function in entry.detail
    assert entry.pointer == "rules.r1.then.function"


def test_declared_js_function_is_reported_as_js():
    result = import_spectral_ruleset(
        "functions: [checkIdempotencyKey]\n" + _rule(then_body="{function: checkIdempotencyKey}")
    )

    entry = _entry(result, "r1")
    assert entry.reason == REASON_JS_FUNCTION
    assert "functions" in entry.detail


def test_undeclared_unknown_function_is_reported_as_js():
    result = import_spectral_ruleset(_rule(then_body="{function: mysteryFn}"))

    assert _entry(result, "r1").reason == REASON_JS_FUNCTION


def test_then_without_a_function_is_malformed():
    result = import_spectral_ruleset(_rule(then_body="{field: description}"))

    entry = _entry(result, "r1")
    assert entry.reason == REASON_MALFORMED_RULE
    assert entry.pointer == "rules.r1.then.function"


def test_then_that_is_not_an_object_is_malformed():
    result = import_spectral_ruleset(_rule(then_body="[truthy]"))

    entry = _entry(result, "r1")
    assert entry.reason == REASON_MALFORMED_RULE
    assert entry.pointer == "rules.r1.then[0]"


def test_missing_given_or_then_is_malformed():
    missing_given = import_spectral_ruleset(
        "rules:\n  r1:\n    description: d\n    then: {function: truthy}\n"
    )
    assert _entry(missing_given, "r1").pointer == "rules.r1.given"

    missing_then = import_spectral_ruleset("rules:\n  r1:\n    description: d\n    given: $.info\n")
    assert _entry(missing_then, "r1").pointer == "rules.r1.then"


# --- DSL rejections -------------------------------------------------------------------------------


def test_dsl_rejection_is_reported_with_the_offending_pointer():
    result = import_spectral_ruleset(
        "rules:\n"
        "  bad-pattern:\n"
        "    description: d\n"
        "    given: $.info\n"
        "    then: {function: pattern, functionOptions: {match: '('}}\n"
    )

    entry = _entry(result, "bad-pattern")
    assert entry.reason == REASON_INVALID_DEFINITION
    assert entry.pointer == "rules.bad-pattern.then.functionOptions.match"


def test_spectral_only_function_options_are_reported_not_silently_dropped():
    result = import_spectral_ruleset(
        "rules:\n"
        "  kebab-headers:\n"
        "    description: d\n"
        "    given: $.info\n"
        "    then:\n"
        "      function: casing\n"
        "      functionOptions: {type: pascal, separator: {char: '-'}}\n"
    )

    entry = _entry(result, "kebab-headers")
    assert entry.reason == REASON_INVALID_DEFINITION
    assert "separator" in entry.detail


def test_sandbox_rejections_surface_as_invalid_definitions():
    result = import_spectral_ruleset(
        "rules:\n"
        "  filtered:\n"
        "    description: d\n"
        "    given: \"$.paths[?(@.x =~ /y/)]\"\n"
        "    then: {function: truthy}\n"
    )

    assert _entry(result, "filtered").reason == REASON_INVALID_DEFINITION


# --- Aliases ---------------------------------------------------------------------------------------


def test_simple_alias_is_inlined():
    result = import_spectral_ruleset(
        "aliases:\n"
        "  PathItem:\n"
        "    - $.paths[*][*]\n"
        "rules:\n"
        "  summaries:\n"
        "    description: d\n"
        "    given: '#PathItem'\n"
        "    then: {field: summary, function: truthy}\n"
    )

    assert result.custom_rules.rules[0].given == ("$.paths[*][*]",)


def test_alias_with_a_path_suffix_is_expanded():
    result = import_spectral_ruleset(
        "aliases:\n"
        "  Schemas:\n"
        "    - $.components.schemas[*]\n"
        "    - $.components.responses[*]\n"
        "rules:\n"
        "  described:\n"
        "    description: d\n"
        "    given: '#Schemas.description'\n"
        "    then: {function: truthy}\n"
    )

    rule = result.custom_rules.rules[0]
    assert rule.given == (
        "$.components.schemas[*].description",
        "$.components.responses[*].description",
    )
    assert any("alias" in note for note in _entry(result, "described").notes)


def test_format_scoped_alias_is_noted_and_its_rules_are_unsupported():
    result = import_spectral_ruleset(
        "aliases:\n"
        "  PathItem:\n"
        "    description: format scoped\n"
        "    targets:\n"
        "      - formats: [oas3]\n"
        "        given: ['$.paths[*][*]']\n"
        "rules:\n"
        "  summaries:\n"
        "    description: d\n"
        "    given: '#PathItem'\n"
        "    then: {field: summary, function: truthy}\n"
    )

    assert any("targets" in note for note in result.notes)
    assert _entry(result, "summaries").reason == REASON_UNKNOWN_ALIAS


def test_unknown_alias_reference_is_reported():
    result = import_spectral_ruleset(
        "rules:\n  r1:\n    description: d\n    given: '#Nope'\n    then: {function: truthy}\n"
    )

    entry = _entry(result, "r1")
    assert entry.reason == REASON_UNKNOWN_ALIAS
    assert entry.pointer == "rules.r1.given"


def test_non_mapping_aliases_block_is_noted():
    result = import_spectral_ruleset("aliases: [a, b]\nrules: {}\n")

    assert any("aliases" in note for note in result.notes)


# --- Document-level handling -------------------------------------------------------------------------


def test_overrides_and_parser_options_are_noted():
    result = import_spectral_ruleset(
        "parserOptions:\n  duplicateKeys: warn\n"
        "overrides:\n"
        "  - files: ['legacy/**']\n"
        "    rules: {some-rule: off}\n"
        "rules: {}\n"
    )

    notes = " ".join(result.notes)
    assert "overrides" in notes and "parserOptions" in notes


def test_unknown_top_level_key_is_noted():
    result = import_spectral_ruleset("madeUpKey: 1\nrules: {}\n")

    assert any("madeUpKey" in note for note in result.notes)


def test_empty_ruleset_reports_full_coverage():
    result = import_spectral_ruleset("extends: spectral:oas\n")

    assert result.entries == ()
    assert result.rule_count == 0
    assert result.coverage == 1.0
    assert result.yaml.strip() == "rules: {}"


def test_rule_value_that_is_neither_definition_nor_severity_is_malformed():
    result = import_spectral_ruleset("rules:\n  r1: [1, 2]\n")

    assert _entry(result, "r1").reason == REASON_MALFORMED_RULE


def test_rule_limit_is_enforced_with_a_reason():
    rules = "".join(
        f"  rule-{index}:\n    description: d\n    given: $.info\n    then: {{function: truthy}}\n"
        for index in range(MAX_RULES_PER_GUIDE + 3)
    )
    result = import_spectral_ruleset("rules:\n" + rules)

    assert len(result.custom_rules.rules) == MAX_RULES_PER_GUIDE
    limited = [e for e in result.entries if e.reason == REASON_RULE_LIMIT]
    assert len(limited) == 3
    parse_style_guide_yaml(result.yaml, reserved_rule_ids=frozenset(builtin_rule_ids()))


@pytest.mark.parametrize(
    "text,fragment",
    [
        ("", "empty"),
        ("   \n", "empty"),
        ("rules: [\n", "invalid YAML"),
        ("- a\n- b\n", "must be a YAML mapping"),
        ("rules: [a, b]\n", "'rules' must be a mapping"),
    ],
)
def test_unreadable_documents_raise(text, fragment):
    with pytest.raises(SpectralImportError) as excinfo:
        import_spectral_ruleset(text)

    assert fragment in excinfo.value.message


def test_oversized_document_raises():
    with pytest.raises(SpectralImportError) as excinfo:
        import_spectral_ruleset("rules: {}\n#" + "x" * MAX_RULESET_BYTES)

    assert "exceeds" in excinfo.value.message


def test_reserved_rule_ids_default_to_the_live_registry():
    builtin = builtin_rule_ids()[0]
    explicit = import_spectral_ruleset(
        f"rules:\n  {builtin}:\n    description: d\n    given: $.info\n    then: {{function: truthy}}\n",
        reserved_rule_ids=frozenset(),
    )

    assert _entry(explicit, builtin).rule_id == builtin
