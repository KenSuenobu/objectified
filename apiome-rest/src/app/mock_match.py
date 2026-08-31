"""Declarative request predicates for mock scenario rules (#4744, PMR-2.1).

A scenario operation override may carry *rules*: ordered ``{"when": ..., "responses": ...}``
entries where ``when`` is a declarative predicate block over the incoming request. The first rule
whose predicates all hold serves its responses; when no rule matches, the override's plain
``responses`` list (if any) is the fallback, and with no fallback the request falls through to the
default spec-driven flow.

This module owns the ``when`` contract end to end, and lives here (like :mod:`app.mock_bundle` and
:mod:`app.mock_routing`) so the author-time validator in apiome-rest and the runtime evaluator in
apiome-mock can never drift:

* :func:`validate_when` — strict, save-time: returns human-readable errors for the editor.
* :func:`compile_when` — runtime: compiles the stored shape, returning ``None`` for anything
  invalid so a hand-edited blob silently drops the rule instead of breaking the runtime.
* :func:`evaluate_when` — runtime: evaluates a compiled block against a :class:`MatchContext`.

The ``when`` storage shape::

    {
      "path":   {"petId":        {"equals": "42"}},
      "query":  {"limit":        {"gt": 10, "lte": 100}},
      "header": {"x-tier":       {"in": ["gold", "silver"]}},
      "body":   {"/items/0/sku": {"matches": "^SKU-"}}
    }

Sections are optional; every predicate present must hold (logical AND). ``path`` keys are path
template parameter names, ``query`` keys are query parameter names, ``header`` keys are
case-insensitive header names, and ``body`` keys are RFC 6901 JSON Pointers into the parsed JSON
request body (``""`` addresses the whole body).

Operators (one predicate object may combine several; all must hold):

============  =====================================================================
``equals``    Value equality. String sources coerce to the expected scalar type.
``notEquals`` Negated ``equals``.
``contains``  Substring for strings; element equality for arrays.
``matches``   Bounded regular expression (``re.search``), pattern <= 256 chars.
``in``        Equality against any entry of a list (<= 50 entries).
``exists``    Presence (``true``) or absence (``false``) of the parameter/pointer.
``gt(e)``     Numeric comparison; non-numeric actual values never match.
``lt(e)``     Numeric comparison; non-numeric actual values never match.
============  =====================================================================

Multi-valued query parameters match when *any* value satisfies the value operators
(``exists`` tests presence of the parameter itself).

Evaluation is pure computation over the already-parsed request — no I/O of any kind — and regex
subjects are capped (:data:`MAX_REGEX_SUBJECT_CHARS`) so a pathological pattern cannot stall the
runtime on a large input.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Tuple

MAX_PREDICATES_PER_WHEN = 20
"""Maximum individual predicate objects in one ``when`` block."""

MAX_MATCH_PATTERN_CHARS = 256
"""Maximum length of a ``matches`` regular expression pattern."""

MAX_IN_VALUES = 50
"""Maximum entries in an ``in`` operator list."""

MAX_POINTER_CHARS = 512
"""Maximum length of a ``body`` JSON Pointer key."""

MAX_REGEX_SUBJECT_CHARS = 4096
"""Regex subjects longer than this are truncated before matching (stall guard)."""

_SOURCES = ("path", "query", "header", "body")
_VALUE_OPERATORS = frozenset({"equals", "notEquals", "contains", "matches", "in", "gt", "gte", "lt", "lte"})
_ALL_OPERATORS = _VALUE_OPERATORS | {"exists"}
_NUMERIC_OPERATORS = frozenset({"gt", "gte", "lt", "lte"})


@dataclass(frozen=True)
class CompiledPredicate:
    """One compiled predicate: every check must hold for the predicate to match.

    Attributes:
        source: Where the actual value comes from (``path``/``query``/``header``/``body``).
        key: Parameter or header name, or a JSON Pointer for ``body``.
        checks: ``(operator, expected)`` pairs; ``matches`` carries a pre-compiled pattern.
    """

    source: str
    key: str
    checks: Tuple[Tuple[str, Any], ...]


@dataclass(frozen=True)
class CompiledWhen:
    """A compiled ``when`` block: every predicate must hold (logical AND).

    Attributes:
        predicates: The compiled predicates, in stored order.
        needs_body: Whether evaluation requires the parsed request body.
    """

    predicates: Tuple[CompiledPredicate, ...]

    @property
    def needs_body(self) -> bool:
        """Whether any predicate reads the request body."""
        return any(predicate.source == "body" for predicate in self.predicates)


@dataclass(frozen=True)
class MatchContext:
    """The request facts predicates (and templates) are evaluated against.

    Attributes:
        method: Upper-case HTTP method.
        path_params: Path template parameters extracted by routing.
        query: Query parameters, each with every supplied value in order.
        headers: Headers with lower-cased names (last value wins).
        body: The parsed JSON request body, or ``None`` when absent/unparseable.
        body_present: Whether the raw request body was non-empty.
    """

    method: str
    path_params: Mapping[str, str]
    query: Mapping[str, Tuple[str, ...]]
    headers: Mapping[str, str]
    body: Any = None
    body_present: bool = False


_POINTER_UNESCAPE = (("~1", "/"), ("~0", "~"))


def resolve_json_pointer(document: Any, pointer: str) -> Tuple[Any, bool]:
    """Resolve an RFC 6901 JSON Pointer against ``document``.

    Args:
        document: The parsed JSON value to address into.
        pointer: The pointer text (``""`` addresses the whole document).

    Returns:
        ``(value, found)`` — ``found`` is ``False`` when any segment is missing.
    """
    if pointer == "":
        return document, True
    node = document
    for raw_token in pointer.split("/")[1:]:
        token = raw_token
        for escaped, plain in _POINTER_UNESCAPE:
            token = token.replace(escaped, plain)
        if isinstance(node, dict):
            if token not in node:
                return None, False
            node = node[token]
        elif isinstance(node, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) >= len(node):
                return None, False
            node = node[int(token)]
        else:
            return None, False
    return node, True


def _is_valid_pointer(pointer: str) -> bool:
    """A body key must be ``""`` or start with ``/`` (RFC 6901)."""
    return pointer == "" or pointer.startswith("/")


def _is_json_scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _validate_operator(op: str, expected: Any, *, context: str, errors: List[str]) -> None:
    """Validate one ``(operator, expected)`` pair, appending errors in place."""
    if op not in _ALL_OPERATORS:
        allowed = ", ".join(sorted(_ALL_OPERATORS))
        errors.append(f"{context}: unknown operator '{op}' (allowed: {allowed}).")
        return
    if op == "matches":
        if not isinstance(expected, str):
            errors.append(f"{context}: 'matches' takes a regular expression string.")
            return
        if len(expected) > MAX_MATCH_PATTERN_CHARS:
            errors.append(f"{context}: 'matches' pattern exceeds {MAX_MATCH_PATTERN_CHARS} characters.")
            return
        try:
            re.compile(expected)
        except re.error as exc:
            errors.append(f"{context}: 'matches' pattern is not a valid regular expression ({exc}).")
    elif op == "contains":
        if not isinstance(expected, str):
            errors.append(f"{context}: 'contains' takes a string.")
    elif op == "in":
        if not isinstance(expected, list) or not expected:
            errors.append(f"{context}: 'in' takes a non-empty list of scalar values.")
            return
        if len(expected) > MAX_IN_VALUES:
            errors.append(f"{context}: 'in' lists at most {MAX_IN_VALUES} values.")
        if not all(_is_json_scalar(entry) for entry in expected):
            errors.append(f"{context}: 'in' entries must be scalar values.")
    elif op == "exists":
        if not isinstance(expected, bool):
            errors.append(f"{context}: 'exists' takes true or false.")
    elif op in _NUMERIC_OPERATORS:
        if isinstance(expected, bool) or not isinstance(expected, (int, float)):
            errors.append(f"{context}: '{op}' takes a number.")


def validate_when(when: Any, *, context: str = "when") -> List[str]:
    """Validate one stored-shape ``when`` block for the save path.

    Args:
        when: The raw ``when`` mapping (sections -> key -> operator object).
        context: Prefix for error messages.

    Returns:
        Human-readable error strings; empty when the block is valid.
    """
    errors: List[str] = []
    if not isinstance(when, Mapping):
        errors.append(f"{context}: must be an object with path/query/header/body sections.")
        return errors

    predicate_count = 0
    for section in when:
        if section not in _SOURCES:
            errors.append(f"{context}: unknown section '{section}' (allowed: {', '.join(_SOURCES)}).")
    for source in _SOURCES:
        section = when.get(source)
        if section is None:
            continue
        if not isinstance(section, Mapping):
            errors.append(f"{context}.{source}: must be an object keyed by name.")
            continue
        for key, operators in section.items():
            key_context = f"{context}.{source}['{key}']"
            if not isinstance(key, str) or (source != "body" and not key.strip()):
                errors.append(f"{key_context}: keys must be non-empty strings.")
                continue
            if source == "body":
                if len(key) > MAX_POINTER_CHARS:
                    errors.append(f"{key_context}: JSON Pointer exceeds {MAX_POINTER_CHARS} characters.")
                    continue
                if not _is_valid_pointer(key):
                    errors.append(f'{key_context}: body keys are JSON Pointers ("" or starting with "/").')
                    continue
            predicate_count += 1
            if not isinstance(operators, Mapping) or not operators:
                errors.append(f"{key_context}: must be a non-empty object of operators.")
                continue
            for op, expected in operators.items():
                _validate_operator(str(op), expected, context=key_context, errors=errors)

    if predicate_count == 0:
        errors.append(f"{context}: at least one predicate is required.")
    if predicate_count > MAX_PREDICATES_PER_WHEN:
        errors.append(f"{context}: at most {MAX_PREDICATES_PER_WHEN} predicates are allowed.")
    return errors


def compile_when(when: Any) -> Optional[CompiledWhen]:
    """Compile a stored ``when`` block for runtime evaluation.

    Returns ``None`` when the block is invalid in any way — the runtime drops the whole rule
    rather than matching more broadly than the author intended.
    """
    if validate_when(when):
        return None
    predicates: List[CompiledPredicate] = []
    for source in _SOURCES:
        section = when.get(source)
        if not isinstance(section, Mapping):
            continue
        for key, operators in section.items():
            checks: List[Tuple[str, Any]] = []
            for op, expected in operators.items():
                if op == "matches":
                    checks.append((op, re.compile(expected)))
                else:
                    checks.append((op, expected))
            predicates.append(CompiledPredicate(source=source, key=key, checks=tuple(checks)))
    return CompiledWhen(predicates=tuple(predicates))


def _coerce_expected_to_actual(expected: Any, actual: str) -> Any:
    """Coerce a string actual toward the expected scalar's type for equality checks."""
    if isinstance(expected, bool):
        lowered = actual.strip().lower()
        if lowered in ("true", "false"):
            return lowered == "true"
        return actual
    if isinstance(expected, (int, float)):
        try:
            return float(actual)
        except ValueError:
            return actual
    return actual


def _values_equal(expected: Any, actual: Any) -> bool:
    """Equality with string-source coercion and cross-numeric comparison."""
    if isinstance(actual, str) and not isinstance(expected, str):
        actual = _coerce_expected_to_actual(expected, actual)
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual or expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return float(expected) == float(actual)
    return bool(expected == actual)


def _as_number(actual: Any) -> Optional[float]:
    if isinstance(actual, bool):
        return None
    if isinstance(actual, (int, float)):
        return float(actual)
    if isinstance(actual, str):
        try:
            return float(actual.strip())
        except ValueError:
            return None
    return None


def _check_holds(op: str, expected: Any, actual: Any) -> bool:
    """Evaluate one value operator against one actual value."""
    if op == "equals":
        return _values_equal(expected, actual)
    if op == "notEquals":
        return not _values_equal(expected, actual)
    if op == "contains":
        if isinstance(actual, str):
            return expected in actual
        if isinstance(actual, list):
            return any(_values_equal(expected, entry) for entry in actual)
        return False
    if op == "matches":
        if not isinstance(actual, str):
            return False
        return expected.search(actual[:MAX_REGEX_SUBJECT_CHARS]) is not None
    if op == "in":
        return any(_values_equal(entry, actual) for entry in expected)
    if op in _NUMERIC_OPERATORS:
        number = _as_number(actual)
        if number is None:
            return False
        bound = float(expected)
        if op == "gt":
            return number > bound
        if op == "gte":
            return number >= bound
        if op == "lt":
            return number < bound
        return number <= bound
    return False


def _actual_values(predicate: CompiledPredicate, ctx: MatchContext) -> Tuple[Tuple[Any, ...], bool]:
    """Return ``(candidate values, present)`` for one predicate's target."""
    if predicate.source == "path":
        if predicate.key in ctx.path_params:
            return (ctx.path_params[predicate.key],), True
        return (), False
    if predicate.source == "query":
        values = ctx.query.get(predicate.key, ())
        return tuple(values), bool(values)
    if predicate.source == "header":
        name = predicate.key.lower()
        if name in ctx.headers:
            return (ctx.headers[name],), True
        return (), False
    value, found = resolve_json_pointer(ctx.body, predicate.key)
    if predicate.key == "" and not ctx.body_present:
        found = False
    return ((value,) if found else ()), found


def evaluate_when(when: CompiledWhen, ctx: MatchContext) -> bool:
    """Evaluate a compiled ``when`` block: ``True`` when every predicate holds."""
    for predicate in when.predicates:
        values, present = _actual_values(predicate, ctx)
        for op, expected in predicate.checks:
            if op == "exists":
                if present is not expected:
                    return False
                continue
            if not present:
                return False
            if not any(_check_holds(op, expected, value) for value in values):
                return False
    return True
