"""Unit tests for the bounded mock response template language (#4744, PMR-2.1)."""

from __future__ import annotations

import time

import pytest

from app.mock_match import MatchContext
from app.mock_template import (
    MAX_EXPRESSIONS_PER_VALUE,
    RenderBudget,
    RenderEnv,
    TemplateError,
    TemplateLimitError,
    make_rng,
    parse_template,
    render_text,
    render_value,
    validate_template_text,
    validate_template_value,
    value_contains_template,
    value_references_request_body,
)


def _ctx(**overrides: object) -> MatchContext:
    defaults: dict = {
        "method": "POST",
        "path_params": {"petId": "42"},
        "query": {"limit": ("25", "50")},
        "headers": {"x-request-id": "req-1"},
        "body": {"name": "Rex", "qty": 3},
        "body_present": True,
    }
    defaults.update(overrides)
    return MatchContext(**defaults)


def _env(seed: int = 0, fixtures: dict | None = None, **ctx_overrides: object) -> RenderEnv:
    return RenderEnv(
        ctx=_ctx(**ctx_overrides),
        rng=make_rng(seed, "scenario", "GET /pets", "0", "0"),
        fixtures=fixtures or {},
    )


# ---------------------------------------------------------------------------
# Parsing and validation
# ---------------------------------------------------------------------------


def test_parse_template_accepts_every_expression_form() -> None:
    text = (
        "{{request.method}} {{request.path.petId}} {{request.query.limit}} "
        "{{request.header.x-request-id}} {{request.body}} {{request.body#/name}} "
        "{{fixture.pets}} {{fixture.pets#/0/name}} {{random.int(1, 5)}} "
        "{{random.float(0, 1)}} {{random.uuid()}} {{random.hex(8)}} "
        "{{random.bool()}} {{random.choice('a', \"b\", 3)}}"
    )
    assert validate_template_text(text) == []


def test_parse_template_rejects_invalid_expressions() -> None:
    assert validate_template_text("{{}}")
    assert validate_template_text("{{unterminated")
    assert validate_template_text("{{secrets.env}}")
    assert validate_template_text("{{request.cookies.session}}")
    assert validate_template_text("{{request.body#items}}")  # pointer must start with /
    assert validate_template_text("{{fixture.bad name}}")
    assert validate_template_text("{{random.eval('x')}}")
    assert validate_template_text("{{random.int(1)}}")
    assert validate_template_text("{{random.int(1.5, 2)}}")
    assert validate_template_text("{{random.int(9, 1)}}")
    assert validate_template_text("{{random.hex(0)}}")
    assert validate_template_text("{{random.hex(65)}}")
    assert validate_template_text("{{random.uuid(1)}}")
    assert validate_template_text("{{random.choice()}}")
    assert validate_template_text("{{random.choice('a\\'b')}}")
    assert validate_template_text("{{random.int}}")


def test_dunder_and_python_shapes_are_not_expressible() -> None:
    """The language has no attribute access or call surface beyond the whitelist."""
    assert validate_template_text("{{__import__('os')}}")
    assert validate_template_text("{{request.__class__}}")
    assert validate_template_text("{{request.body.__init__}}")
    assert validate_template_text("{{open('/etc/passwd')}}")


def test_validate_template_value_walks_structures_and_caps_expressions() -> None:
    assert validate_template_value({"a": ["{{request.method}}"], "b": 1}) == []
    errors = validate_template_value({"a": "{{nope.x}}"})
    assert errors and "unknown expression root" in errors[0]
    over = ["{{request.method}}"] * (MAX_EXPRESSIONS_PER_VALUE + 1)
    assert any("at most" in error for error in validate_template_value(over))


def test_value_contains_template_and_body_reference_detection() -> None:
    assert value_contains_template({"a": "{{request.method}}"})
    assert not value_contains_template({"a": "plain", "b": 3})
    assert not value_contains_template({"a": "{{ not a template"})
    assert value_references_request_body(["{{request.body#/name}}"])
    assert not value_references_request_body(["{{request.method}}"])


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_whole_string_expression_keeps_native_type() -> None:
    env = _env()
    assert render_value("{{request.body#/qty}}", env, RenderBudget()) == 3
    assert render_value("{{request.body}}", env, RenderBudget()) == {"name": "Rex", "qty": 3}
    assert render_value("{{random.bool()}}", env, RenderBudget()) in (True, False)


def test_embedded_expressions_stringify() -> None:
    env = _env()
    rendered = render_value("pet {{request.path.petId}} x{{request.body#/qty}}", env, RenderBudget())
    assert rendered == "pet 42 x3"
    rendered = render_value("body: {{request.body}}", env, RenderBudget())
    assert rendered == 'body: {"name":"Rex","qty":3}'


def test_missing_references_render_null_or_empty() -> None:
    env = _env()
    assert render_value("{{request.query.absent}}", env, RenderBudget()) is None
    assert render_value("[{{request.query.absent}}]", env, RenderBudget()) == "[]"
    assert render_value("{{fixture.absent}}", env, RenderBudget()) is None
    env = _env(body=None, body_present=False)
    assert render_value("{{request.body#/name}}", env, RenderBudget()) is None


def test_query_uses_first_value_and_headers_are_case_insensitive() -> None:
    env = _env()
    assert render_value("{{request.query.limit}}", env, RenderBudget()) == "25"
    assert render_value("{{request.header.X-Request-Id}}", env, RenderBudget()) == "req-1"


def test_fixture_lookup_with_pointer() -> None:
    fixtures = {"pets": [{"name": "Rex"}, {"name": "Ada"}]}
    env = _env(fixtures=fixtures)
    assert render_value("{{fixture.pets#/1/name}}", env, RenderBudget()) == "Ada"
    assert render_value("{{fixture.pets#/9/name}}", env, RenderBudget()) is None


def test_escaped_braces_render_literally() -> None:
    env = _env()
    assert render_value("{{{{not a template }}", env, RenderBudget()) == "{{not a template }}"


def test_unparseable_strings_pass_through_verbatim_at_render_time() -> None:
    env = _env()
    assert render_value("{{ broken", env, RenderBudget()) == "{{ broken"
    assert render_value("{{unknown.root}}", env, RenderBudget()) == "{{unknown.root}}"


def test_render_walks_nested_structures_preserving_keys() -> None:
    env = _env()
    value = {"id": "{{request.path.petId}}", "list": [{"m": "{{request.method}}"}], "n": 7}
    assert render_value(value, env, RenderBudget()) == {"id": "42", "list": [{"m": "POST"}], "n": 7}


def test_render_text_always_returns_text() -> None:
    env = _env()
    assert render_text("{{request.body#/qty}}", env, RenderBudget()) == "3"
    assert render_text("plain", env, RenderBudget()) == "plain"


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_seeded_randomness_is_deterministic_per_seed_and_scope() -> None:
    value = {
        "n": "{{random.int(1, 1000000)}}",
        "u": "{{random.uuid()}}",
        "h": "{{random.hex(16)}}",
        "c": "{{random.choice('a', 'b', 'c')}}",
    }
    first = render_value(value, _env(seed=7), RenderBudget())
    second = render_value(value, _env(seed=7), RenderBudget())
    assert first == second
    other_seed = render_value(value, _env(seed=8), RenderBudget())
    assert first != other_seed


def test_random_values_respect_bounds() -> None:
    env = _env(seed=3)
    for _ in range(50):
        drawn = render_value("{{random.int(1, 5)}}", env, RenderBudget())
        assert 1 <= drawn <= 5
    drawn = render_value("{{random.float(0, 1)}}", env, RenderBudget())
    assert 0 <= drawn < 1.0000005
    assert render_value("{{random.choice('only')}}", env, RenderBudget()) == "only"


# ---------------------------------------------------------------------------
# Limits (CPU and output)
# ---------------------------------------------------------------------------


def test_operation_budget_is_enforced() -> None:
    env = _env()
    budget = RenderBudget(max_ops=10)
    with pytest.raises(TemplateLimitError):
        render_value(["{{request.method}}"] * 50, env, budget)


def test_output_byte_budget_is_enforced() -> None:
    env = _env(fixtures={"big": "x" * 1000})
    budget = RenderBudget(max_output_bytes=500)
    with pytest.raises(TemplateLimitError):
        render_value("{{fixture.big}}", env, budget)


def test_deadline_is_enforced() -> None:
    env = _env()
    budget = RenderBudget(deadline=time.monotonic() - 1)
    with pytest.raises(TemplateLimitError):
        render_value("{{request.method}}", env, budget)


def test_template_string_length_is_capped() -> None:
    with pytest.raises(TemplateError):
        parse_template("x" * 70_000)
