"""LLM tool-bundle lint pack — IXH-7.3 (#5128).

Native hygiene rules for qualities that determine tool-call success:

* description presence and specificity
* parameter descriptions
* enum use over free text where options are enumerable
* required-field discipline
* duplicate tool names
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .canonical_model import CanonicalApi, Operation
from .lint_engine import LintRule, RulePack, lint_canonical_model
from .schema_lint import LintResult

__all__ = [
    "LlmToolsRulePack",
    "lint_llm_tools_result",
    "lint_llm_tools",
]

_WEAK_DESCRIPTION_MAX_LEN = 12
_ENUM_HINT = re.compile(
    r"\b(one of|must be one of|allowed values?|choose from|either)\b",
    re.IGNORECASE,
)


def _ops_sorted(api: CanonicalApi) -> List[Operation]:
    ops: List[Operation] = []
    for service in sorted(api.services, key=lambda s: s.key):
        ops.extend(sorted(service.operations, key=lambda o: o.key))
    return ops


def _parameters_schema(op: Operation) -> Dict[str, Any]:
    extras = op.extras or {}
    schema = extras.get("input_schema")
    if isinstance(schema, dict):
        return schema
    for message in op.messages:
        bag = message.extras or {}
        params = bag.get("llm_tools_parameters")
        if isinstance(params, dict):
            return params
    return {}


def _check_tool_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for op in _ops_sorted(api):
        if not (op.description or "").strip():
            yield (
                f"operations.{op.key}",
                f"Tool {op.name!r} has no description; models need it to decide when to call.",
            )


def _check_tool_weak_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for op in _ops_sorted(api):
        desc = (op.description or "").strip()
        if not desc:
            continue
        if desc.lower() == (op.name or "").lower() or len(desc) < _WEAK_DESCRIPTION_MAX_LEN:
            yield (
                f"operations.{op.key}",
                f"Tool {op.name!r} description is weak (too short or equals the name).",
            )


def _check_param_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for op in _ops_sorted(api):
        schema = _parameters_schema(op)
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            continue
        for prop_name, prop_schema in sorted(properties.items()):
            if not isinstance(prop_schema, dict):
                continue
            if not (prop_schema.get("description") or "").strip():
                yield (
                    f"operations.{op.key}.parameters.{prop_name}",
                    f"Parameter {prop_name!r} on tool {op.name!r} has no description.",
                )


def _is_const_string_branch(schema: Any) -> bool:
    return isinstance(schema, dict) and isinstance(schema.get("const"), str)


def _enumerates_in_description(description: Optional[str]) -> bool:
    if not description:
        return False
    return bool(_ENUM_HINT.search(description))


def _check_prefer_enum_over_freetext(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for op in _ops_sorted(api):
        schema = _parameters_schema(op)
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            continue
        for prop_name, prop_schema in sorted(properties.items()):
            if not isinstance(prop_schema, dict):
                continue
            if "enum" in prop_schema:
                continue
            type_ = prop_schema.get("type")
            if type_ not in (None, "string"):
                continue
            one_of = prop_schema.get("oneOf") or prop_schema.get("anyOf")
            const_branches = (
                isinstance(one_of, list)
                and len(one_of) >= 2
                and all(_is_const_string_branch(branch) for branch in one_of)
            )
            desc = prop_schema.get("description")
            if const_branches or _enumerates_in_description(
                desc if isinstance(desc, str) else None
            ):
                yield (
                    f"operations.{op.key}.parameters.{prop_name}",
                    f"Parameter {prop_name!r} on tool {op.name!r} looks enumerable; "
                    "prefer an explicit `enum` over free text.",
                )


def _check_required_field_hygiene(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for op in _ops_sorted(api):
        schema = _parameters_schema(op)
        required = schema.get("required")
        if required is None:
            continue
        if not isinstance(required, list):
            yield (
                f"operations.{op.key}.parameters",
                f"Tool {op.name!r} has a non-array `required` list.",
            )
            continue
        if len(required) == 0:
            yield (
                f"operations.{op.key}.parameters",
                f"Tool {op.name!r} has an empty `required` list; omit it or list names.",
            )
            continue
        properties = schema.get("properties")
        property_names = set(properties) if isinstance(properties, dict) else set()
        seen: Dict[str, int] = {}
        for name in required:
            if not isinstance(name, str):
                continue
            seen[name] = seen.get(name, 0) + 1
        duplicates = sorted(name for name, count in seen.items() if count > 1)
        if duplicates:
            yield (
                f"operations.{op.key}.parameters",
                f"Tool {op.name!r} has duplicate required names: "
                + ", ".join(duplicates)
                + ".",
            )
        missing = sorted(name for name in seen if name not in property_names)
        if missing:
            yield (
                f"operations.{op.key}.parameters",
                f"Tool {op.name!r} requires fields absent from properties: "
                + ", ".join(missing)
                + ".",
            )


def _check_duplicate_tool_name(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    seen: Dict[str, List[str]] = {}
    for op in _ops_sorted(api):
        seen.setdefault(op.name, []).append(op.key)
    for name, keys in sorted(seen.items()):
        if len(keys) > 1:
            yield (
                f"operations.{keys[0]}",
                f"Duplicate tool name {name!r} appears on: " + ", ".join(keys) + ".",
            )


class LlmToolsRulePack(RulePack, register=True):
    """Native hygiene rules for LLM tool / function-calling bundles."""

    format = "llm-tools"
    pack_id = "llm-tools"

    _RULES: Tuple[LintRule, ...] = (
        LintRule(
            rule_id="llm-tools.tool-missing-description",
            category="quality",
            severity="warning",
            description="Flag tools with no description.",
            check=_check_tool_missing_description,
        ),
        LintRule(
            rule_id="llm-tools.tool-weak-description",
            category="quality",
            severity="info",
            description="Flag tools whose description is too short or equals the name.",
            check=_check_tool_weak_description,
        ),
        LintRule(
            rule_id="llm-tools.param-missing-description",
            category="quality",
            severity="warning",
            description="Flag parameters without descriptions.",
            check=_check_param_missing_description,
        ),
        LintRule(
            rule_id="llm-tools.prefer-enum-over-freetext",
            category="quality",
            severity="info",
            description="Flag free-text parameters that look enumerable.",
            check=_check_prefer_enum_over_freetext,
        ),
        LintRule(
            rule_id="llm-tools.required-field-hygiene",
            category="structure",
            severity="warning",
            description="Flag required lists with missing or duplicate names.",
            check=_check_required_field_hygiene,
        ),
        LintRule(
            rule_id="llm-tools.duplicate-tool-name",
            category="naming",
            severity="error",
            description="Flag colliding tool names within a bundle.",
            check=_check_duplicate_tool_name,
        ),
    )

    def rules(self) -> List[LintRule]:
        return list(self._RULES)


def lint_llm_tools_result(model: CanonicalApi) -> LintResult:
    """Lint a normalized LLM tool bundle through the shared engine."""
    return lint_canonical_model(model)


def lint_llm_tools(raw: str) -> LintResult:
    """Parse, normalize, and lint a raw LLM tool bundle end-to-end."""
    from .llm_tools_import_source import LlmToolsImportSource

    adapter = LlmToolsImportSource()
    native = adapter.parse(raw)
    model = adapter.normalize(native)
    return lint_llm_tools_result(model)
