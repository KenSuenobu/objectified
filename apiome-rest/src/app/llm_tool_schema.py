"""Provider tool-array vocabulary and validation — FMT-2.5 (#5423).

The rules OpenAI and Anthropic enforce on a function-calling tool array, expressed once
so both halves of the ``llm-tools`` round trip can rely on them:
:mod:`app.llm_tools_emitter` builds arrays that satisfy them, and
:func:`validate_tool_array` re-checks a finished array against them independently of how
it was produced.

Neither provider publishes a machine-readable JSON Schema for its tool array, and
neither API is reachable from this runtime, so this module is the *vendored
equivalent* — the same contract, expressed in Python and runnable in CI on every emit.
It encodes the parts an emitter can get wrong:

* the **envelope** of each dialect — OpenAI's ``{type: "function", function: {…}}``,
  Anthropic's ``{name, description, input_schema}``, and the bare ``{name,
  description, parameters}`` shape — including the closed key sets, because a stray key
  is rejected by the API rather than ignored;
* the **name grammar** (:data:`~app.tool_projection.TOOL_NAME_PATTERN`) and the
  requirement that names be unique within one array, since a duplicate silently
  shadows the tool declared before it;
* the **argument schema** contract: the root must be a JSON-Schema *object*, ``required``
  may only name declared properties, the document must be JSON-serializable, and it must
  not nest deeper than :data:`~app.tool_projection.DEFAULT_MAX_NESTING_DEPTH`;
* the **strict** (structured-output) subset, checked whenever a tool declares
  ``strict: true``: only :data:`~app.tool_projection.STRICT_SUPPORTED_KEYWORDS`, every
  object closed with ``additionalProperties: false``, and every declared property listed
  in ``required``.

It deliberately does **not** validate the *content* of a description or the semantics of
a schema keyword — a tool whose description is unhelpful is a lint finding
(:mod:`app.llm_tools_lint`), not a schema violation.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .tool_projection import (
    DEFAULT_MAX_NESTING_DEPTH,
    STRICT_SUPPORTED_KEYWORDS,
    TOOL_NAME_PATTERN,
)

__all__ = [
    "TOOL_MODES",
    "OPENAI_TOOL_KEYS",
    "OPENAI_FUNCTION_KEYS",
    "ANTHROPIC_TOOL_KEYS",
    "BARE_TOOL_KEYS",
    "MODE_SCHEMA_FIELD",
    "anthropic_tool_violations",
    "bare_tool_violations",
    "openai_tool_violations",
    "tool_array_violations",
    "tool_violations",
    "validate_tool_array",
]


# ===========================================================================
# Dialect vocabulary
# ===========================================================================

#: The three tool-array dialects this module knows, in emit-option order.
TOOL_MODES: Tuple[str, ...] = ("openai", "anthropic", "bare")

#: Keys an OpenAI tool entry may carry.
OPENAI_TOOL_KEYS: frozenset = frozenset({"type", "function"})

#: Keys the OpenAI ``function`` object may carry.
OPENAI_FUNCTION_KEYS: frozenset = frozenset({"name", "description", "parameters", "strict"})

#: Keys an Anthropic tool entry may carry. ``cache_control`` is accepted because the
#: Messages API allows it on a tool definition; this emitter never writes one.
ANTHROPIC_TOOL_KEYS: frozenset = frozenset(
    {"name", "description", "input_schema", "cache_control"}
)

#: Keys a bare tool entry may carry.
BARE_TOOL_KEYS: frozenset = frozenset({"name", "description", "parameters"})

#: Mode → the key its argument schema lives under (``function.parameters`` is nested,
#: so the OpenAI entry is spelled out separately).
MODE_SCHEMA_FIELD: Dict[str, str] = {
    "openai": "function.parameters",
    "anthropic": "input_schema",
    "bare": "parameters",
}


# ===========================================================================
# Shared checks
# ===========================================================================


def _name_violations(value: Any, *, path: str) -> List[str]:
    """Check one tool name against the provider grammar."""
    if not isinstance(value, str) or not value:
        return [f"{path}: tool name must be a non-empty string"]
    if not TOOL_NAME_PATTERN.fullmatch(value):
        return [
            f"{path}: tool name {value!r} must match {TOOL_NAME_PATTERN.pattern} "
            "(letters, digits, underscore and hyphen, at most 64 characters)"
        ]
    return []


def _description_violations(value: Any, *, path: str) -> List[str]:
    """A description, when present, must be a non-empty string."""
    if value is None:
        return []
    if not isinstance(value, str) or not value.strip():
        return [f"{path}: description must be a non-empty string when present"]
    return []


def _unknown_key_violations(
    entry: Mapping[str, Any], allowed: frozenset, *, path: str
) -> List[str]:
    """Report keys outside a dialect's closed key set."""
    unknown = sorted(key for key in entry if key not in allowed)
    if not unknown:
        return []
    return [
        f"{path}: unknown key(s) {', '.join(repr(key) for key in unknown)}; "
        f"allowed keys are {', '.join(sorted(allowed))}"
    ]


def _json_serializable_violations(value: Any, *, path: str) -> List[str]:
    """The argument schema must survive a JSON round trip to reach the provider."""
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        return [f"{path}: argument schema is not JSON-serializable ({exc})"]
    return []


def _depth_violations(node: Any, *, path: str, depth: int, maximum: int) -> List[str]:
    """Report any schema node nested deeper than ``maximum`` levels."""
    if not isinstance(node, Mapping):
        return []
    if depth > maximum:
        return [f"{path}: schema nests deeper than the {maximum}-level provider limit"]

    violations: List[str] = []
    properties = node.get("properties")
    if isinstance(properties, Mapping):
        for name, child in properties.items():
            violations += _depth_violations(
                child, path=f"{path}.properties.{name}", depth=depth + 1, maximum=maximum
            )
    for key in ("items", "additionalProperties", "contains"):
        child = node.get(key)
        if isinstance(child, Mapping):
            violations += _depth_violations(
                child, path=f"{path}.{key}", depth=depth + 1, maximum=maximum
            )
    for key in ("anyOf", "oneOf", "allOf"):
        branches = node.get(key)
        if isinstance(branches, Sequence) and not isinstance(branches, (str, bytes)):
            for index, branch in enumerate(branches):
                violations += _depth_violations(
                    branch, path=f"{path}.{key}[{index}]", depth=depth, maximum=maximum
                )
    return violations


def _required_violations(node: Any, *, path: str) -> List[str]:
    """``required`` must be a list of strings naming declared properties."""
    if not isinstance(node, Mapping):
        return []
    violations: List[str] = []
    required = node.get("required")
    if required is not None:
        if not isinstance(required, list) or not all(isinstance(n, str) for n in required):
            violations.append(f"{path}.required: must be a list of property-name strings")
        else:
            properties = node.get("properties")
            declared = set(properties) if isinstance(properties, Mapping) else set()
            missing = sorted(name for name in required if name not in declared)
            if missing:
                violations.append(
                    f"{path}.required: names undeclared propert(y|ies) "
                    f"{', '.join(repr(name) for name in missing)}"
                )
    properties = node.get("properties")
    if isinstance(properties, Mapping):
        for name, child in properties.items():
            violations += _required_violations(child, path=f"{path}.properties.{name}")
    items = node.get("items")
    if isinstance(items, Mapping):
        violations += _required_violations(items, path=f"{path}.items")
    return violations


def _strict_violations(node: Any, *, path: str) -> List[str]:
    """Check the structured-output subset on one schema node and its children."""
    if not isinstance(node, Mapping):
        return []
    violations: List[str] = []

    unsupported = sorted(key for key in node if key not in STRICT_SUPPORTED_KEYWORDS)
    if unsupported:
        violations.append(
            f"{path}: strict schemas accept a fixed keyword subset; "
            f"{', '.join(repr(key) for key in unsupported)} is outside it"
        )

    properties = node.get("properties")
    if node.get("type") == "object" or isinstance(properties, Mapping):
        if node.get("additionalProperties") is not False:
            violations.append(
                f"{path}: a strict object schema must set `additionalProperties: false`"
            )
        declared = list(properties) if isinstance(properties, Mapping) else []
        required = node.get("required")
        listed = set(required) if isinstance(required, list) else set()
        missing = [name for name in declared if name not in listed]
        if missing:
            violations.append(
                f"{path}: a strict object schema must list every property in `required`; "
                f"{', '.join(repr(name) for name in missing)} is missing"
            )

    if isinstance(properties, Mapping):
        for name, child in properties.items():
            violations += _strict_violations(child, path=f"{path}.properties.{name}")
    items = node.get("items")
    if isinstance(items, Mapping):
        violations += _strict_violations(items, path=f"{path}.items")
    for key in ("anyOf",):
        branches = node.get(key)
        if isinstance(branches, list):
            for index, branch in enumerate(branches):
                violations += _strict_violations(branch, path=f"{path}.{key}[{index}]")
    return violations


def _argument_schema_violations(
    schema: Any,
    *,
    path: str,
    strict: bool = False,
    max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
) -> List[str]:
    """Validate one tool's argument schema against the shared provider contract."""
    if not isinstance(schema, Mapping):
        return [f"{path}: argument schema must be a JSON-Schema object"]
    violations = _json_serializable_violations(schema, path=path)
    if any(not isinstance(key, str) for key in schema):
        violations.append(f"{path}: schema keys must be strings")
    if schema.get("type") != "object":
        violations.append(f"{path}.type: a tool's argument schema must be `object`")
    if not isinstance(schema.get("properties"), Mapping):
        violations.append(f"{path}.properties: must be an object (empty when the tool takes none)")
    violations += _required_violations(schema, path=path)
    violations += _depth_violations(schema, path=path, depth=1, maximum=max_depth)
    if strict:
        violations += _strict_violations(schema, path=path)
    return violations


# ===========================================================================
# Per-dialect entry checks
# ===========================================================================


def openai_tool_violations(
    entry: Any, *, path: str = "tool", max_depth: int = DEFAULT_MAX_NESTING_DEPTH
) -> List[str]:
    """Return every way ``entry`` violates the OpenAI tool contract (empty when valid).

    Args:
        entry: One candidate ``{"type": "function", "function": {…}}`` object.
        path: Human-readable coordinate prefixed to each violation.
        max_depth: Deepest schema nesting the provider accepts.

    Returns:
        A list of violation messages, empty when ``entry`` is a valid OpenAI tool.
    """
    if not isinstance(entry, Mapping):
        return [f"{path}: tool entry must be an object"]
    violations = _unknown_key_violations(entry, OPENAI_TOOL_KEYS, path=path)
    if entry.get("type") != "function":
        violations.append(f"{path}.type: must be the literal 'function'")
    function = entry.get("function")
    if not isinstance(function, Mapping):
        violations.append(f"{path}.function: must be an object")
        return violations

    violations += _unknown_key_violations(function, OPENAI_FUNCTION_KEYS, path=f"{path}.function")
    violations += _name_violations(function.get("name"), path=f"{path}.function.name")
    violations += _description_violations(
        function.get("description"), path=f"{path}.function.description"
    )
    strict = function.get("strict")
    if strict is not None and not isinstance(strict, bool):
        violations.append(f"{path}.function.strict: must be a boolean when present")
    violations += _argument_schema_violations(
        function.get("parameters"),
        path=f"{path}.function.parameters",
        strict=strict is True,
        max_depth=max_depth,
    )
    return violations


def anthropic_tool_violations(
    entry: Any, *, path: str = "tool", max_depth: int = DEFAULT_MAX_NESTING_DEPTH
) -> List[str]:
    """Return every way ``entry`` violates the Anthropic tool contract (empty when valid).

    Args:
        entry: One candidate ``{"name", "description", "input_schema"}`` object.
        path: Human-readable coordinate prefixed to each violation.
        max_depth: Deepest schema nesting the provider accepts.

    Returns:
        A list of violation messages, empty when ``entry`` is a valid Anthropic tool.
    """
    if not isinstance(entry, Mapping):
        return [f"{path}: tool entry must be an object"]
    violations = _unknown_key_violations(entry, ANTHROPIC_TOOL_KEYS, path=path)
    violations += _name_violations(entry.get("name"), path=f"{path}.name")
    violations += _description_violations(entry.get("description"), path=f"{path}.description")
    violations += _argument_schema_violations(
        entry.get("input_schema"), path=f"{path}.input_schema", max_depth=max_depth
    )
    return violations


def bare_tool_violations(
    entry: Any, *, path: str = "tool", max_depth: int = DEFAULT_MAX_NESTING_DEPTH
) -> List[str]:
    """Return every way ``entry`` violates the bare tool contract (empty when valid).

    The bare shape has no provider of its own, so it is held to the *intersection* of
    the two that do: the same name grammar, the same argument-schema contract. A bare
    array that passes here can be lifted into either dialect by rewrapping it, which is
    the only reason the shape is worth emitting.

    Args:
        entry: One candidate ``{"name", "description", "parameters"}`` object.
        path: Human-readable coordinate prefixed to each violation.
        max_depth: Deepest schema nesting the provider accepts.

    Returns:
        A list of violation messages, empty when ``entry`` is a valid bare tool.
    """
    if not isinstance(entry, Mapping):
        return [f"{path}: tool entry must be an object"]
    violations = _unknown_key_violations(entry, BARE_TOOL_KEYS, path=path)
    violations += _name_violations(entry.get("name"), path=f"{path}.name")
    violations += _description_violations(entry.get("description"), path=f"{path}.description")
    violations += _argument_schema_violations(
        entry.get("parameters"), path=f"{path}.parameters", max_depth=max_depth
    )
    return violations


_MODE_VALIDATORS = {
    "openai": openai_tool_violations,
    "anthropic": anthropic_tool_violations,
    "bare": bare_tool_violations,
}


def tool_violations(
    entry: Any,
    *,
    mode: str,
    path: str = "tool",
    max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
) -> List[str]:
    """Validate one tool entry in the dialect named by ``mode``.

    Args:
        entry: The candidate tool object.
        mode: One of :data:`TOOL_MODES`.
        path: Human-readable coordinate prefixed to each violation.
        max_depth: Deepest schema nesting the provider accepts.

    Returns:
        A list of violation messages, empty when the entry is valid.

    Raises:
        ValueError: When ``mode`` is not a known dialect.
    """
    validator = _MODE_VALIDATORS.get(mode)
    if validator is None:
        raise ValueError(f"Unknown tool mode {mode!r}; expected one of {', '.join(TOOL_MODES)}")
    return validator(entry, path=path, max_depth=max_depth)


# ===========================================================================
# Array-level checks
# ===========================================================================


def tool_array_violations(
    document: Any,
    *,
    mode: str,
    max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
) -> List[str]:
    """Return every way ``document`` violates the tool-array contract for ``mode``.

    Accepts either the bare JSON array a provider SDK takes or the
    ``{"tools": [...]}`` wrapper an on-disk bundle often uses, because the
    ``llm-tools`` import adapter accepts both and a validator that rejected one of them
    could not be pointed at a corpus fixture.

    Args:
        document: The parsed tool array (or ``{"tools": [...]}`` wrapper).
        mode: One of :data:`TOOL_MODES`.
        max_depth: Deepest schema nesting the provider accepts.

    Returns:
        A list of violation messages, empty when the whole array is valid.

    Raises:
        ValueError: When ``mode`` is not a known dialect.
    """
    entries = document
    if isinstance(document, Mapping):
        entries = document.get("tools")
    if not isinstance(entries, list):
        return ["document: a tool array must be a JSON array (or an object with `tools`)"]
    if not entries:
        return ["document: a tool array must declare at least one tool"]

    violations: List[str] = []
    seen: Dict[str, int] = {}
    for index, entry in enumerate(entries):
        path = f"tools[{index}]"
        violations += tool_violations(entry, mode=mode, path=path, max_depth=max_depth)
        name = _entry_name(entry, mode=mode)
        if name is None:
            continue
        if name in seen:
            violations.append(
                f"{path}.name: {name!r} is already declared by tools[{seen[name]}]; "
                "tool names must be unique within one array"
            )
        else:
            seen[name] = index
    return violations


def _entry_name(entry: Any, *, mode: str) -> Optional[str]:
    """Extract a tool entry's name for the uniqueness check, or ``None``."""
    if not isinstance(entry, Mapping):
        return None
    source: Any = entry
    if mode == "openai":
        source = entry.get("function")
        if not isinstance(source, Mapping):
            return None
    name = source.get("name")
    return name if isinstance(name, str) else None


def validate_tool_array(
    document: Any,
    *,
    mode: str,
    max_depth: int = DEFAULT_MAX_NESTING_DEPTH,
    source_label: Optional[str] = None,
) -> None:
    """Raise when ``document`` is not a valid tool array in ``mode``.

    Args:
        document: The parsed tool array (or ``{"tools": [...]}`` wrapper).
        mode: One of :data:`TOOL_MODES`.
        max_depth: Deepest schema nesting the provider accepts.
        source_label: Optional label naming the document in the error message.

    Raises:
        ValueError: With every violation listed, when the array is invalid.
    """
    violations = tool_array_violations(document, mode=mode, max_depth=max_depth)
    if not violations:
        return
    where = f" ({source_label})" if source_label else ""
    raise ValueError(
        f"Invalid {mode} tool array{where}: " + "; ".join(violations)
    )
