"""Spectral-compatible custom rule DSL — GOV-1.3 (#4429).

Org standards ("all list endpoints paginate", "headers use Train-Case") could not be expressed
before this module: the built-in ruleset (GOV-1.2, :mod:`app.lint_rule_registry`) is fixed. This
module lets a tenant author custom lint rules in a YAML dialect that is a strict subset of the
Spectral ruleset format (stoplight.io), easing migration from Stoplight/Redocly:

.. code-block:: yaml

    rules:
      operation-must-have-summary:
        description: Every operation carries a human summary.
        severity: warning
        given: $.paths[*][*]
        then:
          field: summary
          function: truthy

Supported surface (everything else is rejected by strict validation):

* ``rules.<id>``: ``description`` (required), ``severity`` (``error`` | ``warning`` | ``info``),
  ``given`` (one JSONPath string or a list of them), ``then`` (one object or a list of objects).
* ``then``: optional ``field`` (a property name, or ``@key`` to test each key of a matched
  object), required ``function``, optional ``functionOptions``.
* Core functions: ``pattern``, ``casing``, ``enumeration``, ``truthy``, ``defined``,
  ``undefined``, ``length``.

JS-function custom rules are explicitly **out of scope** (v2, per the governance roadmap).

Two additive keys beyond the Spectral subset (FMT-4.3, #5436)
------------------------------------------------------------

Spectral rules are always written against a *source document*. Schematron is a rule language
over XML instances, so importing one (:mod:`app.schematron_import`) produces rules that read
the **canonical model** instead — and assertions whose XPath has no canonical analogue at all,
which must stay visible rather than be dropped. Two optional keys express exactly that, and
nothing else:

* ``scope`` — ``document`` (the default, and what every Spectral-imported and hand-written rule
  keeps), ``canonical``, or ``declared``. :func:`evaluate_custom_rules` evaluates one scope per
  call, so adding canonical-scoped rules to a guide cannot change what a document-scoped lint
  run reports.
* ``unevaluable`` — ``{reason, detail}``, required on (and only on) a ``declared`` rule.

Both are omitted from a rule's serialized ``custom_def`` when they carry no information, so a
stored guide's content fingerprint is unchanged by this addition.

Strict validation
-----------------

:func:`parse_style_guide_yaml` (and :func:`validate_custom_definition` for a single already-parsed
rule, e.g. a ``style_guide_rules.custom_def`` jsonb value from GOV-1.1 / V159) reject every
malformed construct with a :class:`CustomRuleValidationError` carrying a **pointer** to the
offending node (``rules.my-rule.then.functionOptions.match``), which the REST validation route
surfaces as an HTTP 422.

Sandboxed evaluation
--------------------

Rule authors control two potentially explosive inputs — regexes and JSONPath expressions — so
evaluation is sandboxed:

* **No regex catastrophic backtracking.** User patterns are matched through the third-party
  :mod:`regex` engine with a hard per-match timeout (re2-style bound,
  :data:`REGEX_MATCH_TIMEOUT_SECONDS`); a timeout aborts the rule (recorded in
  ``rule_errors``), never the whole evaluation. Pattern length is capped at validation time.
* **Bounded JSONPath evaluation budget.** ``given`` expressions are evaluated by ``jsonpath-ng``
  over a budget-counting proxy of the document: every container access spends from a fixed
  per-rule budget (:data:`JSONPATH_NODE_BUDGET`), so even adversarial expressions such as
  ``$..*..*..*`` (whose cost is exponential in the number of ``..`` operators) abort with
  :class:`JsonPathBudgetExceededError` instead of hanging the service. Expression length and the
  number of ``..`` operators are additionally capped at validation time, and the extension
  filter's ``=~`` regex operator is rejected (it would bypass the regex timeout).

Evaluation is **pure and deterministic**: no I/O, findings sorted ``(path, rule, id)`` exactly
like :mod:`app.schema_lint`, so custom findings can be merged into lint reports (GOV-1.4)
without disturbing report fingerprints for guides that don't change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import regex as _regex
import yaml
from jsonpath_ng import DatumInContext, Fields, Index, JSONPath, Slice
from jsonpath_ng.ext import parse as _jsonpath_parse

from .schema_lint import LintFinding

__all__ = [
    "CASING_TYPES",
    "CORE_FUNCTIONS",
    "CustomRule",
    "CustomRuleEvaluation",
    "CustomRuleSet",
    "CustomRuleThen",
    "CustomRuleUnevaluable",
    "CustomRuleValidationError",
    "JSONPATH_NODE_BUDGET",
    "JsonPathBudgetExceededError",
    "MAX_GIVEN_PER_RULE",
    "MAX_RULES_PER_GUIDE",
    "MAX_THEN_PER_RULE",
    "MAX_UNEVALUABLE_DETAIL_LENGTH",
    "REGEX_MATCH_TIMEOUT_SECONDS",
    "RULE_SCOPES",
    "SCOPE_CANONICAL",
    "SCOPE_DECLARED",
    "SCOPE_DOCUMENT",
    "EMPTY_STYLE_GUIDE_YAML",
    "evaluate_custom_rules",
    "parse_jsonpath_expression",
    "parse_style_guide_yaml",
    "serialize_style_guide_yaml",
    "validate_custom_definition",
]

#: The editor's blank slate when a guide has no custom rules yet (GOV-2.3).
EMPTY_STYLE_GUIDE_YAML = "rules: {}\n"

# --- Limits (the sandbox contract) ------------------------------------------------------------

#: Category attached to every finding a custom rule emits (built-in categories are
#: naming/documentation/structure/compatibility; custom rules roll up under their own bar).
CUSTOM_RULE_CATEGORY = "custom"

#: Severities a rule may declare — matches the linter's ``Severity`` type and the
#: ``style_guide_rules_severity_ck`` check constraint (V159).
VALID_SEVERITIES = frozenset({"error", "warning", "info"})

#: **Which model a rule reads** (FMT-4.3, #5436). Spectral rules are written against a source
#: document, so ``document`` is the default and every pre-existing rule keeps it — the key is
#: additive and absent from a rule's ``custom_def`` unless it is non-default, which is what
#: keeps stored-guide fingerprints (:func:`app.style_guide_engine.rules_content_fingerprint`)
#: byte-identical across the upgrade.
#:
#: * ``document`` — the reconstructed source document (an OpenAPI/JSON-Schema mapping). What
#:   every GOV-1.3 / GOV-1.5 rule targets.
#: * ``canonical`` — the canonical-model governance projection
#:   (:func:`app.schematron_projection.canonical_governance_document`), which is what a rule
#:   imported from a *schema-agnostic* rule language such as Schematron can actually read.
#: * ``declared`` — the rule is recorded but never evaluated. It carries a mandatory
#:   ``unevaluable`` reason, so an assertion Apiome cannot project is visible in the guide
#:   instead of being dropped on import.
SCOPE_DOCUMENT = "document"
SCOPE_CANONICAL = "canonical"
SCOPE_DECLARED = "declared"
RULE_SCOPES = frozenset({SCOPE_DOCUMENT, SCOPE_CANONICAL, SCOPE_DECLARED})

#: Maximum length of a declared rule's ``unevaluable.detail`` explanation.
MAX_UNEVALUABLE_DETAIL_LENGTH = 1024

#: The Spectral-compatible core functions supported by this subset (GOV-1.3).
CORE_FUNCTIONS = frozenset(
    {"pattern", "casing", "enumeration", "truthy", "defined", "undefined", "length"}
)

#: Casing styles accepted by the ``casing`` function (Spectral's casing types).
CASING_TYPES = frozenset({"flat", "camel", "pascal", "kebab", "cobol", "snake", "macro"})

#: Maximum rules per guide / ``given`` paths per rule / ``then`` clauses per rule.
MAX_RULES_PER_GUIDE = 200
MAX_GIVEN_PER_RULE = 10
MAX_THEN_PER_RULE = 10

#: Maximum length of a rule id, a JSONPath expression, and a user regex pattern.
MAX_RULE_ID_LENGTH = 128
MAX_JSONPATH_LENGTH = 512
MAX_PATTERN_LENGTH = 512

#: Maximum number of recursive-descent (``..``) operators per ``given`` expression. Each ``..``
#: multiplies traversal cost by the document size, so this is capped hard at validation time
#: (the runtime budget below is the backstop).
MAX_DESCENDANT_OPS = 4

#: Maximum ``enumeration`` values and maximum YAML document size accepted for validation.
MAX_ENUM_VALUES = 200
MAX_YAML_BYTES = 262_144

#: Container accesses one rule's JSONPath evaluation may spend before it is aborted.
JSONPATH_NODE_BUDGET = 100_000

#: Hard per-match timeout for user-supplied regexes (re2-style bound; the ``regex`` engine
#: checks it during matching, so catastrophic backtracking cannot hang the service).
REGEX_MATCH_TIMEOUT_SECONDS = 0.1

#: Rule ids: dotted kebab/snake segments, starting alphanumeric (``my-org.headers-train-case``).
_RULE_ID_RE = _regex.compile(r"^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$")

#: Reason codes on a ``declared`` rule: lowercase snake_case, machine-readable and stable
#: (the same shape :mod:`app.spectral_import` uses for its unsupported-entry reasons).
_REASON_CODE_RE = _regex.compile(r"^[a-z][a-z0-9_]*$")

#: How many characters of an offending value are echoed into a finding message.
_MESSAGE_VALUE_MAX = 60


# --- Errors ------------------------------------------------------------------------------------


class CustomRuleValidationError(ValueError):
    """A style-guide document or rule definition failed strict validation.

    Attributes:
        message: Human-readable, actionable description of the problem.
        pointer: Dotted pointer to the offending YAML node (``rules.my-rule.then.function``);
            empty string when the problem is document-level (e.g. unparseable YAML).
    """

    def __init__(self, message: str, pointer: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.pointer = pointer


class JsonPathBudgetExceededError(RuntimeError):
    """A rule's JSONPath evaluation spent its entire node budget and was aborted."""


# --- Model -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CustomRuleThen:
    """One validated ``then`` clause: which value to test and how.

    Attributes:
        field: ``None`` to test the matched value itself, ``"@key"`` to test each key of a
            matched object, or a property name to test that property of the matched object.
        function: One of :data:`CORE_FUNCTIONS`.
        function_options: The validated ``functionOptions`` mapping (empty for functions that
            take none).
    """

    field: Optional[str]
    function: str
    function_options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CustomRuleUnevaluable:
    """Why a ``declared`` rule is recorded but never evaluated (FMT-4.3, #5436).

    Attributes:
        reason: Stable, machine-readable snake_case code (``context_predicate``,
            ``unsupported_xpath_function``, ``inactive_phase``, …). The UI keys guidance off
            this rather than parsing ``detail``.
        detail: Human explanation naming the construct that could not be projected.
    """

    reason: str
    detail: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON-serializable ``unevaluable`` mapping."""
        body: Dict[str, Any] = {"reason": self.reason}
        if self.detail:
            body["detail"] = self.detail
        return body


@dataclass(frozen=True)
class CustomRule:
    """One validated custom rule from the DSL.

    Attributes:
        rule_id: The rule's id — the key under ``rules``. Findings carry it in their ``rule``
            field, so it must not shadow a built-in rule id (enforced when the caller passes
            ``reserved_rule_ids``).
        description: Required human description; used as the base finding message.
        severity: ``error`` | ``warning`` | ``info`` (default ``warning``).
        given: One or more JSONPath expressions selecting the values the rule applies to.
            Empty only for a ``declared`` rule that could not be projected at all.
        then: One or more clauses applied to every ``given`` match. Empty only for a
            ``declared`` rule that could not be projected at all.
        scope: Which model the rule reads — one of :data:`RULE_SCOPES`. Defaults to
            :data:`SCOPE_DOCUMENT`, so every pre-FMT-4.3 rule is unchanged.
        unevaluable: Present exactly when ``scope`` is :data:`SCOPE_DECLARED`: why the rule is
            recorded but never evaluated.
    """

    rule_id: str
    description: str
    severity: str
    given: Tuple[str, ...]
    then: Tuple[CustomRuleThen, ...]
    scope: str = SCOPE_DOCUMENT
    unevaluable: Optional[CustomRuleUnevaluable] = None

    def as_dict(self) -> Dict[str, Any]:
        """Return the rule as a plain JSON-serializable dict (the ``custom_def`` shape).

        ``scope`` and ``unevaluable`` are emitted only when they carry information, so a
        document-scoped rule serializes exactly as it did before FMT-4.3 — which is what keeps
        stored guides' content fingerprints stable across the upgrade.
        """
        body: Dict[str, Any] = {
            "description": self.description,
            "severity": self.severity,
        }
        if self.scope != SCOPE_DOCUMENT:
            body["scope"] = self.scope
        if self.given:
            body["given"] = list(self.given)
        if self.then:
            body["then"] = [
                {
                    **({"field": t.field} if t.field is not None else {}),
                    "function": t.function,
                    **({"functionOptions": dict(t.function_options)} if t.function_options else {}),
                }
                for t in self.then
            ]
        if self.unevaluable is not None:
            body["unevaluable"] = self.unevaluable.as_dict()
        return body

    def is_evaluable(self) -> bool:
        """Return whether this rule can produce findings at all.

        A ``declared`` rule never can (it is a record of an assertion Apiome could not
        project), and neither can a rule left without a ``given`` or a ``then``.
        """
        return self.scope != SCOPE_DECLARED and bool(self.given) and bool(self.then)


@dataclass(frozen=True)
class CustomRuleSet:
    """A validated style guide: every rule from one ``rules:`` document, in author order."""

    rules: Tuple[CustomRule, ...]

    def rule_ids(self) -> List[str]:
        """Return the rule ids in author order."""
        return [rule.rule_id for rule in self.rules]


@dataclass(frozen=True)
class CustomRuleEvaluation:
    """The outcome of evaluating a rule set against one document.

    Attributes:
        findings: Every violation, sorted by ``(path, rule, id)`` (deterministic).
        rule_errors: Rule id -> reason, for rules whose evaluation was aborted by the sandbox
            (JSONPath budget exhausted or a regex match timed out). Aborted rules contribute no
            findings; the other rules are unaffected.
    """

    findings: Tuple[LintFinding, ...]
    rule_errors: Mapping[str, str]


# --- Strict YAML loading -----------------------------------------------------------------------


class _StrictLoader(yaml.SafeLoader):
    """SafeLoader that rejects duplicate mapping keys (silent overwrite loses a rule)."""


def _strict_mapping(loader: _StrictLoader, node: yaml.MappingNode, deep: bool = False) -> Dict:
    mapping: Dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                None,
                None,
                f"duplicate mapping key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _strict_mapping)


# --- Validation --------------------------------------------------------------------------------


@lru_cache(maxsize=512)
def _compile_user_pattern(pattern: str) -> "_regex.Pattern":
    """Compile a user regex once (cached); match calls pass the hard timeout separately."""
    return _regex.compile(pattern)


def _require_mapping(value: Any, pointer: str, what: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CustomRuleValidationError(
            f"{what} must be a mapping, got {type(value).__name__}", pointer
        )
    return value


def _reject_unknown_keys(value: Mapping[str, Any], allowed: Sequence[str], pointer: str) -> None:
    for key in value:
        if not isinstance(key, str) or key not in allowed:
            raise CustomRuleValidationError(
                f"unknown key {key!r} (allowed: {', '.join(sorted(allowed))})",
                f"{pointer}.{key}" if pointer else str(key),
            )


def _validate_given_expression(expr: Any, pointer: str) -> str:
    """Validate one JSONPath ``given`` expression (syntax and sandbox caps)."""
    if not isinstance(expr, str) or not expr.strip():
        raise CustomRuleValidationError("given must be a non-empty JSONPath string", pointer)
    expr = expr.strip()
    if len(expr) > MAX_JSONPATH_LENGTH:
        raise CustomRuleValidationError(
            f"given expression exceeds {MAX_JSONPATH_LENGTH} characters", pointer
        )
    if not expr.startswith("$"):
        raise CustomRuleValidationError("given must start at the document root ('$')", pointer)
    if "=~" in expr:
        raise CustomRuleValidationError(
            "the '=~' filter operator is not supported (its regexes bypass the sandbox); "
            "use a 'pattern' then-function instead",
            pointer,
        )
    if expr.count("..") > MAX_DESCENDANT_OPS:
        raise CustomRuleValidationError(
            f"given uses more than {MAX_DESCENDANT_OPS} recursive-descent ('..') operators",
            pointer,
        )
    try:
        _parse_jsonpath(expr)
    except Exception as exc:  # jsonpath-ng raises JsonPathParserError and bare Exception
        raise CustomRuleValidationError(f"invalid JSONPath: {exc}", pointer) from exc
    return expr


def _validate_pattern_options(options: Mapping[str, Any], pointer: str) -> Dict[str, Any]:
    _reject_unknown_keys(options, ("match", "notMatch"), pointer)
    if not options:
        raise CustomRuleValidationError(
            "pattern requires functionOptions with 'match' and/or 'notMatch'", pointer
        )
    validated: Dict[str, Any] = {}
    for key in ("match", "notMatch"):
        if key not in options:
            continue
        value = options[key]
        if not isinstance(value, str) or not value:
            raise CustomRuleValidationError(f"'{key}' must be a non-empty string", f"{pointer}.{key}")
        if len(value) > MAX_PATTERN_LENGTH:
            raise CustomRuleValidationError(
                f"'{key}' exceeds {MAX_PATTERN_LENGTH} characters", f"{pointer}.{key}"
            )
        try:
            _compile_user_pattern(value)
        except _regex.error as exc:
            raise CustomRuleValidationError(
                f"'{key}' is not a valid regular expression: {exc}", f"{pointer}.{key}"
            ) from exc
        validated[key] = value
    return validated


def _validate_casing_options(options: Mapping[str, Any], pointer: str) -> Dict[str, Any]:
    _reject_unknown_keys(options, ("type", "disallowDigits"), pointer)
    casing_type = options.get("type")
    if casing_type not in CASING_TYPES:
        raise CustomRuleValidationError(
            f"casing requires functionOptions.type, one of: {', '.join(sorted(CASING_TYPES))}",
            f"{pointer}.type",
        )
    validated: Dict[str, Any] = {"type": casing_type}
    if "disallowDigits" in options:
        if not isinstance(options["disallowDigits"], bool):
            raise CustomRuleValidationError(
                "'disallowDigits' must be a boolean", f"{pointer}.disallowDigits"
            )
        validated["disallowDigits"] = options["disallowDigits"]
    return validated


def _validate_enumeration_options(options: Mapping[str, Any], pointer: str) -> Dict[str, Any]:
    _reject_unknown_keys(options, ("values",), pointer)
    values = options.get("values")
    if not isinstance(values, list) or not values:
        raise CustomRuleValidationError(
            "enumeration requires functionOptions.values, a non-empty list", f"{pointer}.values"
        )
    if len(values) > MAX_ENUM_VALUES:
        raise CustomRuleValidationError(
            f"'values' exceeds {MAX_ENUM_VALUES} entries", f"{pointer}.values"
        )
    for index, value in enumerate(values):
        if not isinstance(value, (str, int, float, bool)) and value is not None:
            raise CustomRuleValidationError(
                "'values' entries must be scalars (string/number/boolean/null)",
                f"{pointer}.values[{index}]",
            )
    return {"values": list(values)}


def _validate_length_options(options: Mapping[str, Any], pointer: str) -> Dict[str, Any]:
    _reject_unknown_keys(options, ("min", "max"), pointer)
    validated: Dict[str, Any] = {}
    for key in ("min", "max"):
        if key not in options:
            continue
        value = options[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise CustomRuleValidationError(f"'{key}' must be a number", f"{pointer}.{key}")
        validated[key] = value
    if not validated:
        raise CustomRuleValidationError(
            "length requires functionOptions with 'min' and/or 'max'", pointer
        )
    if "min" in validated and "max" in validated and validated["min"] > validated["max"]:
        raise CustomRuleValidationError("'min' must not exceed 'max'", f"{pointer}.min")
    return validated


def _validate_no_options(options: Mapping[str, Any], pointer: str) -> Dict[str, Any]:
    if options:
        raise CustomRuleValidationError(
            "this function takes no functionOptions", pointer
        )
    return {}


#: Per-function ``functionOptions`` validators (strict: unknown keys always rejected).
_OPTION_VALIDATORS = {
    "pattern": _validate_pattern_options,
    "casing": _validate_casing_options,
    "enumeration": _validate_enumeration_options,
    "length": _validate_length_options,
    "truthy": _validate_no_options,
    "defined": _validate_no_options,
    "undefined": _validate_no_options,
}


def _validate_then_clause(clause: Any, pointer: str) -> CustomRuleThen:
    """Validate one ``then`` object: field / function / functionOptions."""
    clause = _require_mapping(clause, pointer, "then")
    _reject_unknown_keys(clause, ("field", "function", "functionOptions"), pointer)

    function = clause.get("function")
    if function not in CORE_FUNCTIONS:
        raise CustomRuleValidationError(
            f"'function' must be one of: {', '.join(sorted(CORE_FUNCTIONS))}",
            f"{pointer}.function",
        )

    then_field = clause.get("field")
    if then_field is not None and (not isinstance(then_field, str) or not then_field):
        raise CustomRuleValidationError(
            "'field' must be a non-empty string (a property name, or '@key')", f"{pointer}.field"
        )

    raw_options = clause.get("functionOptions", {})
    raw_options = _require_mapping(raw_options, f"{pointer}.functionOptions", "functionOptions")
    options = _OPTION_VALIDATORS[function](raw_options, f"{pointer}.functionOptions")

    return CustomRuleThen(field=then_field, function=function, function_options=options)


def validate_custom_definition(
    rule_id: Any,
    definition: Any,
    pointer: str = "",
    reserved_rule_ids: Optional[frozenset] = None,
) -> CustomRule:
    """Strictly validate one custom rule definition (the ``custom_def`` jsonb shape).

    Used both by :func:`parse_style_guide_yaml` for each ``rules.<id>`` entry and by later
    tickets (GOV-1.4/1.5) to re-validate ``style_guide_rules.custom_def`` values loaded from
    the database before evaluating them.

    Args:
        rule_id: The rule's id (the key under ``rules``).
        definition: The rule body: ``description`` / ``severity`` / ``given`` / ``then``.
        pointer: Pointer prefix for error messages (e.g. ``rules.my-rule``); defaults to the
            bare rule id when empty.
        reserved_rule_ids: Optional ids the rule must not shadow (pass the built-in catalog's
            ids so custom findings stay attributable to exactly one rule).

    Returns:
        The validated, immutable :class:`CustomRule`.

    Raises:
        CustomRuleValidationError: With a pointer to the offending node.
    """
    pointer = pointer or str(rule_id)

    if not isinstance(rule_id, str) or not _RULE_ID_RE.match(rule_id or ""):
        raise CustomRuleValidationError(
            "rule id must be lowercase alphanumeric segments separated by '.', '-' or '_' "
            "(e.g. 'headers-train-case')",
            pointer,
        )
    if len(rule_id) > MAX_RULE_ID_LENGTH:
        raise CustomRuleValidationError(
            f"rule id exceeds {MAX_RULE_ID_LENGTH} characters", pointer
        )
    if reserved_rule_ids and rule_id in reserved_rule_ids:
        raise CustomRuleValidationError(
            f"rule id {rule_id!r} shadows a built-in rule; pick a different id "
            "(override built-in severity via the style guide instead)",
            pointer,
        )

    definition = _require_mapping(definition, pointer, "rule definition")
    _reject_unknown_keys(
        definition, ("description", "severity", "given", "then", "scope", "unevaluable"), pointer
    )

    description = definition.get("description")
    if not isinstance(description, str) or not description.strip():
        raise CustomRuleValidationError(
            "'description' is required and must be a non-empty string", f"{pointer}.description"
        )

    severity = definition.get("severity", "warning")
    if severity not in VALID_SEVERITIES:
        raise CustomRuleValidationError(
            f"'severity' must be one of: {', '.join(sorted(VALID_SEVERITIES))}",
            f"{pointer}.severity",
        )

    scope = definition.get("scope", SCOPE_DOCUMENT)
    if scope not in RULE_SCOPES:
        raise CustomRuleValidationError(
            f"'scope' must be one of: {', '.join(sorted(RULE_SCOPES))}", f"{pointer}.scope"
        )
    declared = scope == SCOPE_DECLARED
    unevaluable = _validate_unevaluable(definition.get("unevaluable"), declared, pointer)

    # A ``declared`` rule is a record, not a check: it may carry the projection that *would*
    # have run (so re-enabling it is a scope flip) or nothing at all. Every other scope keeps
    # the original contract — both halves are required.
    raw_given = definition.get("given")
    if raw_given is None and not declared:
        raise CustomRuleValidationError("'given' is required", f"{pointer}.given")
    given: List[str] = []
    if raw_given is not None:
        given_list = raw_given if isinstance(raw_given, list) else [raw_given]
        if not given_list:
            raise CustomRuleValidationError("'given' must not be an empty list", f"{pointer}.given")
        if len(given_list) > MAX_GIVEN_PER_RULE:
            raise CustomRuleValidationError(
                f"'given' exceeds {MAX_GIVEN_PER_RULE} expressions", f"{pointer}.given"
            )
        for index, expr in enumerate(given_list):
            suffix = f"[{index}]" if isinstance(raw_given, list) else ""
            given.append(_validate_given_expression(expr, f"{pointer}.given{suffix}"))

    raw_then = definition.get("then")
    if raw_then is None and not declared:
        raise CustomRuleValidationError("'then' is required", f"{pointer}.then")
    then: List[CustomRuleThen] = []
    if raw_then is not None:
        then_list = raw_then if isinstance(raw_then, list) else [raw_then]
        if not then_list:
            raise CustomRuleValidationError("'then' must not be an empty list", f"{pointer}.then")
        if len(then_list) > MAX_THEN_PER_RULE:
            raise CustomRuleValidationError(
                f"'then' exceeds {MAX_THEN_PER_RULE} clauses", f"{pointer}.then"
            )
        for index, clause in enumerate(then_list):
            suffix = f"[{index}]" if isinstance(raw_then, list) else ""
            then.append(_validate_then_clause(clause, f"{pointer}.then{suffix}"))

    return CustomRule(
        rule_id=rule_id,
        description=description.strip(),
        severity=severity,
        given=tuple(given),
        then=tuple(then),
        scope=scope,
        unevaluable=unevaluable,
    )


def _validate_unevaluable(
    raw: Any, declared: bool, pointer: str
) -> Optional[CustomRuleUnevaluable]:
    """Validate a rule's ``unevaluable`` block against its scope.

    Args:
        raw: The ``unevaluable`` node as written, or ``None`` when absent.
        declared: Whether the rule declares :data:`SCOPE_DECLARED`.
        pointer: Pointer prefix of the owning rule (``rules.my-rule``).

    Returns:
        The validated block, or ``None`` for a rule that is not ``declared``.

    Raises:
        CustomRuleValidationError: When the block is missing on a ``declared`` rule, present on
            any other scope, or malformed.
    """
    node_pointer = f"{pointer}.unevaluable"
    if not declared:
        if raw is not None:
            raise CustomRuleValidationError(
                f"'unevaluable' is only allowed on a rule with scope '{SCOPE_DECLARED}'",
                node_pointer,
            )
        return None
    if raw is None:
        raise CustomRuleValidationError(
            f"a rule with scope '{SCOPE_DECLARED}' must say why: "
            "'unevaluable' with a 'reason' is required",
            node_pointer,
        )
    block = _require_mapping(raw, node_pointer, "'unevaluable'")
    _reject_unknown_keys(block, ("reason", "detail"), node_pointer)

    reason = block.get("reason")
    if not isinstance(reason, str) or not _REASON_CODE_RE.match(reason or ""):
        raise CustomRuleValidationError(
            "'reason' is required and must be a lowercase snake_case code "
            "(e.g. 'unsupported_xpath_function')",
            f"{node_pointer}.reason",
        )

    detail = block.get("detail")
    if detail is not None:
        if not isinstance(detail, str) or not detail.strip():
            raise CustomRuleValidationError(
                "'detail' must be a non-empty string", f"{node_pointer}.detail"
            )
        if len(detail) > MAX_UNEVALUABLE_DETAIL_LENGTH:
            raise CustomRuleValidationError(
                f"'detail' exceeds {MAX_UNEVALUABLE_DETAIL_LENGTH} characters",
                f"{node_pointer}.detail",
            )
        detail = detail.strip()
    return CustomRuleUnevaluable(reason=reason, detail=detail)


def parse_style_guide_yaml(
    text: str, reserved_rule_ids: Optional[frozenset] = None
) -> CustomRuleSet:
    """Parse and strictly validate a style-guide YAML document.

    The document must be a mapping with exactly one top-level key, ``rules``, mapping rule ids
    to rule definitions (see the module docstring for the accepted shape). Every violation of
    the schema raises :class:`CustomRuleValidationError` with a pointer to the offending node.

    Args:
        text: The YAML source.
        reserved_rule_ids: Optional ids custom rules must not shadow (pass
            ``frozenset(builtin_rule_ids())`` to protect the built-in catalog).

    Returns:
        The validated :class:`CustomRuleSet`, rules in author order.

    Raises:
        CustomRuleValidationError: On unparseable YAML (including duplicate mapping keys) or
            any schema violation.
    """
    document = _parse_style_guide_document(text)
    _reject_unknown_keys(document, ("rules",), "")

    raw_rules = _require_mapping(document.get("rules"), "rules", "'rules'")
    if not raw_rules:
        raise CustomRuleValidationError("'rules' must contain at least one rule", "rules")
    if len(raw_rules) > MAX_RULES_PER_GUIDE:
        raise CustomRuleValidationError(
            f"'rules' exceeds {MAX_RULES_PER_GUIDE} rules", "rules"
        )

    rules = tuple(
        validate_custom_definition(
            rule_id, definition, pointer=f"rules.{rule_id}", reserved_rule_ids=reserved_rule_ids
        )
        for rule_id, definition in raw_rules.items()
    )
    return CustomRuleSet(rules=rules)


def serialize_style_guide_yaml(ruleset: CustomRuleSet) -> str:
    """Serialize a validated rule set back to YAML for the custom-rules editor (GOV-2.3).

    Round-trips through :func:`parse_style_guide_yaml` for non-empty guides. An empty set
    becomes :data:`EMPTY_STYLE_GUIDE_YAML`.
    """
    if not ruleset.rules:
        return EMPTY_STYLE_GUIDE_YAML
    document: Dict[str, Any] = {"rules": {}}
    for rule in ruleset.rules:
        document["rules"][rule.rule_id] = rule.as_dict()
    return yaml.dump(document, default_flow_style=False, sort_keys=False, allow_unicode=True)


def _parse_style_guide_document(text: str) -> Mapping[str, Any]:
    """Load a style-guide YAML document with the same strict loader as validation."""
    if not isinstance(text, str) or not text.strip():
        raise CustomRuleValidationError("the style-guide document is empty")
    if len(text.encode("utf-8", errors="replace")) > MAX_YAML_BYTES:
        raise CustomRuleValidationError(
            f"the style-guide document exceeds {MAX_YAML_BYTES} bytes"
        )
    try:
        document = yaml.load(text, Loader=_StrictLoader)  # noqa: S506 - SafeLoader subclass
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        problem = getattr(exc, "problem", None) or str(exc)
        raise CustomRuleValidationError(f"invalid YAML: {problem}{where}") from exc
    return _require_mapping(document, "", "the style-guide document")


def parse_style_guide_yaml_for_save(
    text: str, reserved_rule_ids: Optional[frozenset] = None
) -> CustomRuleSet:
    """Parse a style-guide document for persistence, allowing an empty ``rules`` map.

    The editor's "clear all custom rules" save path sends ``rules: {}``; preview treats that
    as zero rules. Every other constraint matches :func:`parse_style_guide_yaml`.
    """
    document = _parse_style_guide_document(text)
    _reject_unknown_keys(document, ("rules",), "")
    raw_rules = _require_mapping(document.get("rules"), "rules", "'rules'")
    if not raw_rules:
        return CustomRuleSet(rules=())
    if len(raw_rules) > MAX_RULES_PER_GUIDE:
        raise CustomRuleValidationError(
            f"'rules' exceeds {MAX_RULES_PER_GUIDE} rules", "rules"
        )
    rules = tuple(
        validate_custom_definition(
            rule_id, definition, pointer=f"rules.{rule_id}", reserved_rule_ids=reserved_rule_ids
        )
        for rule_id, definition in raw_rules.items()
    )
    return CustomRuleSet(rules=rules)


# --- JSONPath parsing (Spectral-compatible wildcard semantics) ---------------------------------


class _AnyChild(JSONPath):
    """``[*]`` with Spectral semantics: every child of an object **or** array.

    jsonpath-ng parses ``[*]`` as an unbounded :class:`~jsonpath_ng.Slice`, which on a dict
    collapses the dict to a bare list of its values — key names disappear from match paths and
    chained wildcards (``$.paths[*][*]``) resolve incorrectly. Spectral (and every OpenAPI
    ruleset written for it) expects ``[*]`` to iterate object properties like ``.*`` does, so
    parsed expressions have their unbounded slices rewritten to this node.
    """

    def find(self, datum: DatumInContext) -> List[DatumInContext]:
        datum = DatumInContext.wrap(datum)
        value = datum.value
        if isinstance(value, dict):
            return [
                DatumInContext(value[key], path=Fields(key), context=datum)
                for key in list(value.keys())
            ]
        if isinstance(value, list):
            return [
                DatumInContext(value[index], path=Index(index), context=datum)
                for index in range(len(value))
            ]
        return []

    def __str__(self) -> str:
        return "[*]"

    def __repr__(self) -> str:
        return "_AnyChild()"

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, _AnyChild)

    def __hash__(self) -> int:
        return hash("_AnyChild")


def _rewrite_wildcards(node: Any) -> Any:
    """Recursively replace unbounded slices (``[*]``) with :class:`_AnyChild` in a parsed AST.

    Every jsonpath-ng composite node (Child, Descendants, Union, the ext extensions, …) stores
    its operands in ``left`` / ``right``, so a generic attribute walk covers them all.
    """
    if isinstance(node, Slice) and node.start is None and node.end is None and node.step is None:
        return _AnyChild()
    for attr in ("left", "right"):
        child = getattr(node, attr, None)
        if isinstance(child, JSONPath):
            setattr(node, attr, _rewrite_wildcards(child))
    return node


@lru_cache(maxsize=512)
def _parse_jsonpath(expression: str):
    """Parse a JSONPath expression once (cached; parsing is pure) with Spectral wildcards."""
    return _rewrite_wildcards(_jsonpath_parse(expression))


def parse_jsonpath_expression(expression: str):
    """Public seam for other intake features that evaluate JSONPath (IXH-7.7 overlays).

    Parses with exactly the Spectral-compatible semantics custom rules use — the
    ``[*]``-on-objects wildcard rewrite and the shared parse cache — so a JSONPath
    written for one feature selects the same nodes in the other.

    Args:
        expression: The JSONPath expression.

    Returns:
        The parsed (rewritten) jsonpath-ng expression.

    Raises:
        Exception: Whatever jsonpath-ng raises for an invalid expression (it raises
            ``JsonPathParserError`` and bare ``Exception`` subclasses; callers catch
            broadly).
    """
    return _parse_jsonpath(expression)


# --- Budget-counting document proxies ----------------------------------------------------------


class _EvalBudget:
    """A per-rule spend counter; raises when the JSONPath traversal budget is exhausted.

    The budget also memoizes container wrappers by object identity, so each document node is
    copied into its counting proxy at most once per evaluation (keeping wrap cost linear in
    the portion of the document actually visited).
    """

    __slots__ = ("remaining", "_wrappers")

    def __init__(self, budget: int) -> None:
        self.remaining = budget
        self._wrappers: Dict[int, Any] = {}

    def spend(self, amount: int = 1) -> None:
        self.remaining -= amount
        if self.remaining < 0:
            raise JsonPathBudgetExceededError(
                "JSONPath evaluation exceeded its node budget"
            )

    def wrap(self, value: Any) -> Any:
        """Return ``value`` with dict/list containers replaced by counting proxies."""
        if isinstance(value, (_CountingDict, _CountingList)):
            return value
        if isinstance(value, dict):
            cached = self._wrappers.get(id(value))
            if cached is None:
                self.spend(len(value) + 1)  # charge the one-time proxy copy up front
                cached = _CountingDict(self, value)
                self._wrappers[id(value)] = cached
            return cached
        if isinstance(value, list):
            cached = self._wrappers.get(id(value))
            if cached is None:
                self.spend(len(value) + 1)
                cached = _CountingList(self, value)
                self._wrappers[id(value)] = cached
            return cached
        return value


class _CountingDict(dict):
    """dict proxy: every access spends budget; child containers are wrapped lazily."""

    def __init__(self, budget: _EvalBudget, source: Mapping) -> None:
        super().__init__(source)
        self._budget = budget

    def __getitem__(self, key):
        self._budget.spend()
        return self._budget.wrap(super().__getitem__(key))

    def get(self, key, default=None):
        self._budget.spend()
        if not super().__contains__(key):
            return default
        return self._budget.wrap(super().__getitem__(key))

    def keys(self):
        self._budget.spend(len(self) + 1)
        return super().keys()

    def values(self):
        self._budget.spend(len(self) + 1)
        return [self._budget.wrap(value) for value in super().values()]

    def items(self):
        self._budget.spend(len(self) + 1)
        return [(key, self._budget.wrap(value)) for key, value in super().items()]

    def __iter__(self):
        self._budget.spend(len(self) + 1)
        return super().__iter__()


class _CountingList(list):
    """list proxy: every access spends budget; child containers are wrapped lazily."""

    def __init__(self, budget: _EvalBudget, source: Sequence) -> None:
        super().__init__(source)
        self._budget = budget

    def __getitem__(self, index):
        self._budget.spend()
        item = super().__getitem__(index)
        if isinstance(index, slice):
            return [self._budget.wrap(entry) for entry in item]
        return self._budget.wrap(item)

    def __iter__(self):
        self._budget.spend(len(self) + 1)
        for item in super().__iter__():
            yield self._budget.wrap(item)


# --- Evaluation --------------------------------------------------------------------------------


def _truncate(value: Any) -> str:
    """Render a value into a finding message, truncated so messages stay bounded."""
    text = repr(value)
    if len(text) > _MESSAGE_VALUE_MAX:
        text = text[: _MESSAGE_VALUE_MAX - 1] + "…"
    return text


@lru_cache(maxsize=32)
def _casing_regex(casing_type: str, disallow_digits: bool) -> "_regex.Pattern":
    """Build the (fixed, linear-time) regex for one casing style."""
    digits = "" if disallow_digits else "0-9"
    bodies = {
        "flat": f"[a-z][a-z{digits}]*",
        "camel": f"[a-z][a-zA-Z{digits}]*",
        "pascal": f"[A-Z][a-zA-Z{digits}]*",
        "kebab": f"[a-z][a-z{digits}]*(?:-[a-z{digits}]+)*",
        "cobol": f"[A-Z][A-Z{digits}]*(?:-[A-Z{digits}]+)*",
        "snake": f"[a-z][a-z{digits}]*(?:_[a-z{digits}]+)*",
        "macro": f"[A-Z][A-Z{digits}]*(?:_[A-Z{digits}]+)*",
    }
    return _regex.compile(f"^{bodies[casing_type]}$")


def _format_match_path(match: DatumInContext) -> str:
    """Render a match's location as a dotted path (``paths./pets/{id}.get.summary``).

    Walks the match's context chain instead of ``str(full_path)`` (which renders parentheses
    and quotes: ``((paths.'/pets/{id}').get)``). Object keys join with ``.``, array positions
    render ``[i]`` — consistent with the dotted paths built-in findings carry.
    """
    segments: List[str] = []
    datum = match
    while datum is not None and datum.context is not None:
        step = datum.path
        if isinstance(step, Fields) and step.fields:
            segments.append(str(step.fields[0]))
        elif isinstance(step, Index):
            # jsonpath-ng >= 1.7 stores a tuple in `indices`; older releases a single `index`.
            indices = getattr(step, "indices", None)
            segments.append(f"[{indices[0] if indices else getattr(step, 'index', 0)}]")
        else:  # pragma: no cover - defensive; Root/This steps carry no location
            rendered = str(step)
            if rendered not in ("$", "`this`"):
                segments.append(rendered)
        datum = datum.context
    segments.reverse()

    path = ""
    for segment in segments:
        if segment.startswith("["):
            path += segment
        else:
            path = f"{path}.{segment}" if path else segment
    return path or "$"


def _function_violation(
    then: CustomRuleThen, target: Any, target_defined: bool
) -> Optional[str]:
    """Apply one core function to one resolved target value.

    Args:
        then: The validated clause (function + options).
        target: The resolved value (the match itself, a field of it, or an object key).
        target_defined: Whether the target exists at all (``field`` present on the match).

    Returns:
        A short violation detail string, or ``None`` when the target passes. Functions follow
        Spectral semantics: ``pattern``/``casing`` only test defined string values,
        ``enumeration``/``length`` only defined values — use ``truthy``/``defined`` to require
        presence.

    Raises:
        TimeoutError: When a user pattern exceeds the regex match timeout (caught per rule).
    """
    function = then.function
    options = then.function_options

    if function == "defined":
        return None if target_defined else "expected the value to be defined"
    if function == "undefined":
        return f"expected the value to be undefined, got {_truncate(target)}" if target_defined else None
    if function == "truthy":
        if not target_defined or not target:
            return "expected the value to be truthy" if target_defined else "expected the value to be defined"
        return None

    if not target_defined:
        return None  # pattern/casing/enumeration/length pass on absent values (Spectral semantics)

    if function == "pattern":
        if not isinstance(target, str):
            return None
        match_pattern = options.get("match")
        if match_pattern is not None:
            compiled = _compile_user_pattern(match_pattern)
            if compiled.search(target, timeout=REGEX_MATCH_TIMEOUT_SECONDS) is None:
                return f"{_truncate(target)} does not match pattern {match_pattern!r}"
        not_match_pattern = options.get("notMatch")
        if not_match_pattern is not None:
            compiled = _compile_user_pattern(not_match_pattern)
            if compiled.search(target, timeout=REGEX_MATCH_TIMEOUT_SECONDS) is not None:
                return f"{_truncate(target)} must not match pattern {not_match_pattern!r}"
        return None

    if function == "casing":
        if not isinstance(target, str) or not target:
            return None
        casing_type = options["type"]
        pattern = _casing_regex(casing_type, options.get("disallowDigits", False))
        if pattern.match(target) is None:
            return f"{_truncate(target)} is not {casing_type} case"
        return None

    if function == "enumeration":
        values = options["values"]
        if any(target is v or target == v for v in values):
            return None
        return f"{_truncate(target)} is not one of the allowed values {_truncate(values)}"

    if function == "length":
        if isinstance(target, bool) or target is None:
            return None
        if isinstance(target, (str, list, dict)):
            measured, unit = len(target), "length"
        elif isinstance(target, (int, float)):
            measured, unit = target, "value"
        else:
            return None
        minimum = options.get("min")
        maximum = options.get("max")
        if minimum is not None and measured < minimum:
            return f"expected {unit} of at least {minimum}, got {measured}"
        if maximum is not None and measured > maximum:
            return f"expected {unit} of at most {maximum}, got {measured}"
        return None

    raise AssertionError(f"unreachable: unknown function {function!r}")  # pragma: no cover


def _apply_then(
    rule: CustomRule, then: CustomRuleThen, match_value: Any, match_path: str
) -> List[LintFinding]:
    """Apply one ``then`` clause to one JSONPath match, returning any findings."""
    targets: List[Tuple[str, Any, bool]] = []  # (path, target, defined)

    if then.field is None:
        targets.append((match_path, match_value, True))
    elif then.field == "@key":
        if isinstance(match_value, dict):
            targets.extend((f"{match_path}.{key}", key, True) for key in list(match_value.keys()))
    else:
        if isinstance(match_value, dict) and then.field in match_value:
            targets.append((f"{match_path}.{then.field}", match_value[then.field], True))
        else:
            targets.append((match_path, None, False))

    findings = []
    for path, target, defined in targets:
        detail = _function_violation(then, target, defined)
        if detail is not None:
            findings.append(
                LintFinding(
                    path=path,
                    category=CUSTOM_RULE_CATEGORY,
                    rule=rule.rule_id,
                    severity=rule.severity,
                    message=f"{rule.description} — {detail}",
                )
            )
    return findings


def evaluate_custom_rules(
    ruleset: CustomRuleSet,
    document: Mapping[str, Any],
    node_budget: int = JSONPATH_NODE_BUDGET,
    scope: str = SCOPE_DOCUMENT,
) -> CustomRuleEvaluation:
    """Evaluate every rule of a validated rule set against one document, sandboxed.

    Pure and deterministic: the same rule set and document always produce the same findings,
    in the same order. Each rule evaluates under its **own** fresh node budget, so one
    pathological rule cannot starve the others; a rule that exhausts its budget (or whose
    regex times out) is aborted and reported in ``rule_errors`` instead of raising.

    Args:
        ruleset: A rule set from :func:`parse_style_guide_yaml` /
            :func:`validate_custom_definition` (already strictly validated).
        document: The document to lint, as plain dicts/lists — it is never mutated. Which
            document that is follows ``scope``: a reconstructed source document for
            :data:`SCOPE_DOCUMENT`, the canonical-model governance projection for
            :data:`SCOPE_CANONICAL`.
        node_budget: Container-access budget per rule (default
            :data:`JSONPATH_NODE_BUDGET`); tests lower it to exercise the sandbox.
        scope: Only rules declaring this scope are evaluated. Defaults to
            :data:`SCOPE_DOCUMENT`, so every caller that predates FMT-4.3 evaluates exactly
            the rules it always did. :data:`SCOPE_DECLARED` rules are never evaluated by any
            scope — passing it evaluates nothing.

    Returns:
        The :class:`CustomRuleEvaluation` with sorted findings and per-rule sandbox errors.
    """
    findings: List[LintFinding] = []
    rule_errors: Dict[str, str] = {}

    for rule in ruleset.rules:
        if rule.scope != scope or not rule.is_evaluable():
            continue
        budget = _EvalBudget(node_budget)
        rule_findings: List[LintFinding] = []
        try:
            root = budget.wrap(document)
            for expression in rule.given:
                for match in _parse_jsonpath(expression).find(root):
                    match_path = _format_match_path(match)
                    for then in rule.then:
                        rule_findings.extend(_apply_then(rule, then, match.value, match_path))
        except JsonPathBudgetExceededError:
            rule_errors[rule.rule_id] = (
                f"evaluation aborted: JSONPath node budget of {node_budget} exhausted"
            )
            continue
        except TimeoutError:
            rule_errors[rule.rule_id] = (
                f"evaluation aborted: a regex match exceeded {REGEX_MATCH_TIMEOUT_SECONDS}s"
            )
            continue
        findings.extend(rule_findings)

    findings.sort(key=lambda f: (f.path, f.rule, f.id))
    return CustomRuleEvaluation(findings=tuple(findings), rule_errors=rule_errors)
