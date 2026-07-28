"""Unit tests for declarative mock request predicates (#4744, PMR-2.1)."""

from __future__ import annotations

from app.mock_match import (
    MAX_IN_VALUES,
    MAX_MATCH_PATTERN_CHARS,
    MAX_PREDICATES_PER_WHEN,
    CompiledWhen,
    MatchContext,
    compile_when,
    evaluate_when,
    resolve_json_pointer,
    validate_when,
)


def _ctx(**overrides: object) -> MatchContext:
    defaults: dict = {
        "method": "GET",
        "path_params": {"petId": "42"},
        "query": {"limit": ("25",), "tag": ("a", "b")},
        "headers": {"x-tier": "gold", "content-type": "application/json"},
        "body": {"items": [{"sku": "SKU-1", "qty": 3}], "note": "hello"},
        "body_present": True,
    }
    defaults.update(overrides)
    return MatchContext(**defaults)


def _compiled(when: dict) -> CompiledWhen:
    compiled = compile_when(when)
    assert compiled is not None, f"expected {when!r} to compile"
    return compiled


# ---------------------------------------------------------------------------
# JSON Pointer resolution
# ---------------------------------------------------------------------------


def test_resolve_json_pointer_addresses_documents() -> None:
    document = {"a": [{"b~x": 1, "c/d": 2}], "": 3}
    assert resolve_json_pointer(document, "") == (document, True)
    assert resolve_json_pointer(document, "/a/0/b~0x") == (1, True)
    assert resolve_json_pointer(document, "/a/0/c~1d") == (2, True)
    assert resolve_json_pointer(document, "/") == (3, True)
    assert resolve_json_pointer(document, "/a/1") == (None, False)
    assert resolve_json_pointer(document, "/a/01") == (None, False)
    assert resolve_json_pointer(document, "/missing") == (None, False)
    assert resolve_json_pointer("scalar", "/a") == (None, False)


# ---------------------------------------------------------------------------
# validate_when / compile_when
# ---------------------------------------------------------------------------


def test_validate_when_accepts_a_full_block() -> None:
    when = {
        "path": {"petId": {"equals": "42"}},
        "query": {"limit": {"gt": 10, "lte": 100}},
        "header": {"x-tier": {"in": ["gold", "silver"]}},
        "body": {"/items/0/sku": {"matches": "^SKU-"}},
    }
    assert validate_when(when) == []
    assert compile_when(when) is not None


def test_validate_when_rejects_bad_shapes() -> None:
    assert validate_when(None)
    assert validate_when("nope")
    assert validate_when({})  # no predicates at all
    assert validate_when({"cookies": {"a": {"equals": 1}}})  # unknown section
    assert validate_when({"query": "nope"})
    assert validate_when({"query": {"limit": {}}})  # no operators
    assert validate_when({"query": {"limit": "nope"}})
    assert validate_when({"query": {"": {"equals": 1}}})  # blank key


def test_validate_when_rejects_bad_operators() -> None:
    assert validate_when({"query": {"a": {"like": "x"}}})
    assert validate_when({"query": {"a": {"matches": "("}}})
    assert validate_when({"query": {"a": {"matches": 42}}})
    assert validate_when({"query": {"a": {"matches": "x" * (MAX_MATCH_PATTERN_CHARS + 1)}}})
    assert validate_when({"query": {"a": {"contains": 42}}})
    assert validate_when({"query": {"a": {"in": []}}})
    assert validate_when({"query": {"a": {"in": "nope"}}})
    assert validate_when({"query": {"a": {"in": [{"nested": True}]}}})
    assert validate_when({"query": {"a": {"in": list(range(MAX_IN_VALUES + 1))}}})
    assert validate_when({"query": {"a": {"exists": "yes"}}})
    assert validate_when({"query": {"a": {"gt": "10"}}})
    assert validate_when({"query": {"a": {"gt": True}}})


def test_validate_when_rejects_bad_body_pointers() -> None:
    assert validate_when({"body": {"items": {"equals": 1}}})  # no leading slash
    assert validate_when({"body": {"/" + "a" * 600: {"equals": 1}}})  # too long
    assert validate_when({"body": {"": {"exists": True}}}) == []  # whole body is fine


def test_validate_when_caps_predicate_count() -> None:
    when = {"query": {f"q{i}": {"equals": i} for i in range(MAX_PREDICATES_PER_WHEN + 1)}}
    assert any("at most" in error for error in validate_when(when))


def test_compile_when_returns_none_on_any_invalid_input() -> None:
    assert compile_when(None) is None
    assert compile_when({}) is None
    assert compile_when({"query": {"a": {"like": "x"}}}) is None


# ---------------------------------------------------------------------------
# evaluate_when
# ---------------------------------------------------------------------------


def test_equals_coerces_string_sources() -> None:
    assert evaluate_when(_compiled({"path": {"petId": {"equals": 42}}}), _ctx())
    assert evaluate_when(_compiled({"path": {"petId": {"equals": "42"}}}), _ctx())
    assert not evaluate_when(_compiled({"path": {"petId": {"equals": 43}}}), _ctx())
    assert evaluate_when(_compiled({"query": {"limit": {"equals": 25}}}), _ctx())
    ctx = _ctx(query={"flag": ("true",)})
    assert evaluate_when(_compiled({"query": {"flag": {"equals": True}}}), ctx)


def test_not_equals_and_in() -> None:
    assert evaluate_when(_compiled({"header": {"x-tier": {"notEquals": "silver"}}}), _ctx())
    assert not evaluate_when(_compiled({"header": {"x-tier": {"notEquals": "gold"}}}), _ctx())
    assert evaluate_when(_compiled({"header": {"X-Tier": {"in": ["gold", "silver"]}}}), _ctx())
    assert not evaluate_when(_compiled({"header": {"x-tier": {"in": ["bronze"]}}}), _ctx())


def test_multi_value_query_matches_any_value() -> None:
    assert evaluate_when(_compiled({"query": {"tag": {"equals": "b"}}}), _ctx())
    assert not evaluate_when(_compiled({"query": {"tag": {"equals": "c"}}}), _ctx())


def test_contains_on_strings_and_arrays() -> None:
    assert evaluate_when(_compiled({"body": {"/note": {"contains": "ell"}}}), _ctx())
    ctx = _ctx(body={"tags": ["alpha", "beta"]})
    assert evaluate_when(_compiled({"body": {"/tags": {"contains": "beta"}}}), ctx)
    assert not evaluate_when(_compiled({"body": {"/tags": {"contains": "gamma"}}}), ctx)
    # contains never matches non-string, non-array values.
    assert not evaluate_when(_compiled({"body": {"/items/0/qty": {"contains": "3"}}}), _ctx())


def test_matches_applies_regex_to_strings_only() -> None:
    assert evaluate_when(_compiled({"body": {"/items/0/sku": {"matches": "^SKU-"}}}), _ctx())
    assert not evaluate_when(_compiled({"body": {"/items/0/qty": {"matches": "3"}}}), _ctx())


def test_numeric_comparisons_coerce_strings() -> None:
    assert evaluate_when(_compiled({"query": {"limit": {"gt": 10, "lte": 25}}}), _ctx())
    assert not evaluate_when(_compiled({"query": {"limit": {"gt": 25}}}), _ctx())
    assert evaluate_when(_compiled({"body": {"/items/0/qty": {"gte": 3, "lt": 4}}}), _ctx())
    assert not evaluate_when(_compiled({"header": {"x-tier": {"gt": 0}}}), _ctx())


def test_exists_checks_presence_and_absence() -> None:
    assert evaluate_when(_compiled({"query": {"limit": {"exists": True}}}), _ctx())
    assert evaluate_when(_compiled({"query": {"missing": {"exists": False}}}), _ctx())
    assert not evaluate_when(_compiled({"query": {"missing": {"exists": True}}}), _ctx())
    assert evaluate_when(_compiled({"body": {"/items/0/sku": {"exists": True}}}), _ctx())
    assert evaluate_when(_compiled({"body": {"/missing": {"exists": False}}}), _ctx())
    assert evaluate_when(_compiled({"body": {"": {"exists": False}}}), _ctx(body=None, body_present=False))


def test_missing_targets_fail_value_operators() -> None:
    assert not evaluate_when(_compiled({"query": {"missing": {"equals": "x"}}}), _ctx())
    assert not evaluate_when(_compiled({"path": {"missing": {"equals": "x"}}}), _ctx())
    assert not evaluate_when(_compiled({"header": {"missing": {"equals": "x"}}}), _ctx())
    assert not evaluate_when(_compiled({"body": {"/missing": {"equals": "x"}}}), _ctx())


def test_all_predicates_must_hold() -> None:
    when = {
        "path": {"petId": {"equals": "42"}},
        "query": {"limit": {"gt": 100}},
    }
    assert not evaluate_when(_compiled(when), _ctx())
