"""The safe effect vocabulary — DUW-5.5 (private-suite#2592).

Pure tests over :mod:`app.workspace_custom_action_rules`: what a stored custom action may say,
and — the half the acceptance criteria hang on — everything it may not. "Declarative effects only
(enforced by schema)" is proven here as rejections: a script has no spelling that survives these
validators, because every effect is reduced to exactly the fields its type declares and every
field is checked against a closed vocabulary.

The rejection messages matter too: until the DUW-8.2 management page lands these errors are the
management UI, so each is asserted to name the offending field as a pointer (``effects[1].lens``).
"""

from __future__ import annotations

import pytest

from app.workspace_custom_action_rules import (
    EFFECT_TYPES,
    MAX_EFFECTS,
    MAX_NAME_CONTAINS_LENGTH,
    MAX_NAME_LENGTH,
    MAX_URL_LENGTH,
    SUBJECT_KINDS,
    WORKSPACE_LENSES,
    CustomActionValidationError,
    normalize_action_name,
    normalize_effects,
    normalize_name_contains,
    normalize_subject,
    validate_effects_against_subject,
)


class TestActionName:
    def test_a_name_is_trimmed(self):
        assert normalize_action_name("  Open runbook  ") == "Open runbook"

    def test_a_name_may_carry_the_subject_placeholder(self):
        assert normalize_action_name("Open runbook for {subject}") == "Open runbook for {subject}"

    @pytest.mark.parametrize("raw", [None, 7, ["Open"], {"name": "Open"}])
    def test_a_non_string_is_rejected(self, raw):
        with pytest.raises(CustomActionValidationError, match="name must be a string"):
            normalize_action_name(raw)

    @pytest.mark.parametrize("raw", ["", "   "])
    def test_a_blank_name_is_rejected(self, raw):
        with pytest.raises(CustomActionValidationError, match="name must not be blank"):
            normalize_action_name(raw)

    def test_the_length_cap_is_enforced_after_trimming(self):
        assert normalize_action_name("  " + "x" * MAX_NAME_LENGTH + "  ")
        with pytest.raises(CustomActionValidationError, match=str(MAX_NAME_LENGTH)):
            normalize_action_name("x" * (MAX_NAME_LENGTH + 1))


class TestSubject:
    @pytest.mark.parametrize("kind", SUBJECT_KINDS)
    def test_every_palette_kind_is_accepted(self, kind):
        assert normalize_subject(kind) == kind

    @pytest.mark.parametrize("raw", ["folder", "Class", "", None, 3])
    def test_anything_else_is_rejected(self, raw):
        with pytest.raises(CustomActionValidationError, match="subject must be one of"):
            normalize_subject(raw)


class TestNameContains:
    def test_none_means_no_narrowing(self):
        assert normalize_name_contains(None) is None

    def test_blank_normalizes_to_none_rather_than_matching_nothing(self):
        # An empty substring is contained in every label, so storing one would say "no narrowing"
        # in the least readable way; an all-blank one after trimming would match nothing forever.
        assert normalize_name_contains("   ") is None

    def test_a_substring_is_trimmed(self):
        assert normalize_name_contains("  Invoice ") == "Invoice"

    def test_a_non_string_is_rejected(self):
        with pytest.raises(CustomActionValidationError, match="nameContains must be a string"):
            normalize_name_contains(42)

    def test_the_length_cap_is_enforced(self):
        with pytest.raises(CustomActionValidationError, match=str(MAX_NAME_CONTAINS_LENGTH)):
            normalize_name_contains("x" * (MAX_NAME_CONTAINS_LENGTH + 1))


class TestEffectsList:
    def test_a_non_list_is_rejected(self):
        with pytest.raises(CustomActionValidationError, match="effects must be a list"):
            normalize_effects({"type": "hydrate-set"})

    def test_an_empty_list_is_rejected(self):
        with pytest.raises(CustomActionValidationError, match="at least one"):
            normalize_effects([])

    def test_the_count_cap_is_enforced(self):
        with pytest.raises(CustomActionValidationError, match=str(MAX_EFFECTS)):
            normalize_effects([{"type": "hydrate-set"}] * (MAX_EFFECTS + 1))

    def test_a_non_object_element_is_rejected_with_its_index(self):
        with pytest.raises(CustomActionValidationError, match=r"effects\[1\] must be an object"):
            normalize_effects([{"type": "hydrate-set"}, "open-url"])

    @pytest.mark.parametrize("bad_type", ["eval", "hydrate_set", "", None, 3])
    def test_a_type_outside_the_vocabulary_is_rejected(self, bad_type):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.type must be one of"):
            normalize_effects([{"type": bad_type}])

    def test_order_is_preserved(self):
        effects = normalize_effects(
            [{"type": "hydrate-set"}, {"type": "lens-switch", "lens": "combined"}]
        )
        assert [effect["type"] for effect in effects] == ["hydrate-set", "lens-switch"]

    def test_every_vocabulary_entry_has_a_validator(self):
        # A new EFFECT_TYPES entry without a validator would make normalize_effects reject its own
        # vocabulary, which this pins as a loud failure rather than a mystery 422.
        for effect_type in EFFECT_TYPES:
            valid = {
                "hydrate-set": {"type": "hydrate-set"},
                "lens-switch": {"type": "lens-switch", "lens": "combined"},
                "open-inspector-tab": {"type": "open-inspector-tab", "tab": "schema"},
                "run-consumption-query": {"type": "run-consumption-query"},
                "open-url": {"type": "open-url", "url": "https://example.com"},
            }[effect_type]
            assert normalize_effects([valid]) == [valid]


class TestBareEffects:
    @pytest.mark.parametrize("effect_type", ["hydrate-set", "run-consumption-query"])
    def test_a_bare_effect_carries_nothing_but_its_type(self, effect_type):
        assert normalize_effects([{"type": effect_type}]) == [{"type": effect_type}]

    def test_an_unknown_key_is_rejected_not_ignored(self):
        # Ignoring extra keys is how a typo becomes an effect that silently does less than its
        # author meant. The pointer names the key so the author can fix it.
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.script"):
            normalize_effects([{"type": "hydrate-set", "script": "alert(1)"}])


class TestLensSwitch:
    @pytest.mark.parametrize("lens", WORKSPACE_LENSES)
    def test_every_canvas_lens_is_accepted(self, lens):
        assert normalize_effects([{"type": "lens-switch", "lens": lens}]) == [
            {"type": "lens-switch", "lens": lens}
        ]

    @pytest.mark.parametrize("lens", [None, "", "Combined", "code", 3])
    def test_anything_else_is_rejected_with_a_pointer(self, lens):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.lens must be one of"):
            normalize_effects([{"type": "lens-switch", "lens": lens}])

    def test_a_missing_lens_is_rejected(self):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.lens"):
            normalize_effects([{"type": "lens-switch"}])


class TestOpenInspectorTab:
    @pytest.mark.parametrize("tab", ["schema", "example-payloads", "x1"])
    def test_a_bounded_slug_is_accepted(self, tab):
        assert normalize_effects([{"type": "open-inspector-tab", "tab": tab}]) == [
            {"type": "open-inspector-tab", "tab": tab}
        ]

    @pytest.mark.parametrize("tab", ["", None, "Schema", "sche ma", "-schema", "schema-", "x" * 41])
    def test_anything_else_is_rejected(self, tab):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.tab"):
            normalize_effects([{"type": "open-inspector-tab", "tab": tab}])


class TestOpenUrl:
    def test_an_https_url_is_accepted(self):
        url = "https://runbooks.example.com/classes/{subject}"
        assert normalize_effects([{"type": "open-url", "url": url}]) == [
            {"type": "open-url", "url": url}
        ]

    @pytest.mark.parametrize(
        "url",
        [
            "http://example.com",  # https is the whole scheme vocabulary
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "//example.com/protocol-relative",
            "https://",  # no host
            "ftp://example.com",
        ],
    )
    def test_every_other_scheme_is_a_payload_not_an_effect(self, url):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.url"):
            normalize_effects([{"type": "open-url", "url": url}])

    def test_embedded_credentials_are_rejected(self):
        with pytest.raises(CustomActionValidationError, match="credentials"):
            normalize_effects([{"type": "open-url", "url": "https://user:pw@example.com"}])

    def test_the_length_cap_is_enforced(self):
        url = "https://example.com/" + "x" * MAX_URL_LENGTH
        with pytest.raises(CustomActionValidationError, match=str(MAX_URL_LENGTH)):
            normalize_effects([{"type": "open-url", "url": url}])

    @pytest.mark.parametrize("url", [None, "", "   ", 3])
    def test_a_missing_or_blank_url_is_rejected(self, url):
        with pytest.raises(CustomActionValidationError, match=r"effects\[0\]\.url"):
            normalize_effects([{"type": "open-url", "url": url}])


class TestCrossFieldRule:
    def test_a_consumption_query_needs_a_class_subject(self):
        effects = normalize_effects([{"type": "run-consumption-query"}])
        validate_effects_against_subject("class", effects)

    @pytest.mark.parametrize("subject", ["path", "property", "any"])
    def test_every_other_subject_is_a_contradiction(self, subject):
        effects = normalize_effects([{"type": "run-consumption-query"}])
        with pytest.raises(CustomActionValidationError, match="requires subject 'class'"):
            validate_effects_against_subject(subject, effects)

    @pytest.mark.parametrize("subject", SUBJECT_KINDS)
    def test_other_effects_are_indifferent_to_the_subject(self, subject):
        effects = normalize_effects(
            [
                {"type": "hydrate-set"},
                {"type": "lens-switch", "lens": "combined"},
                {"type": "open-url", "url": "https://example.com"},
            ]
        )
        validate_effects_against_subject(subject, effects)

    def test_the_error_names_the_offending_index(self):
        effects = normalize_effects(
            [{"type": "hydrate-set"}, {"type": "run-consumption-query"}]
        )
        with pytest.raises(CustomActionValidationError, match=r"effects\[1\]"):
            validate_effects_against_subject("path", effects)
