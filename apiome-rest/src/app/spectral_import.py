"""Spectral ruleset importer — GOV-1.5 (#4431).

Teams migrating from Stoplight/Redocly arrive with a ``.spectral.yaml`` that encodes years of
org standards. Re-authoring every rule by hand is a real switching cost, so this module reads a
Spectral ruleset and translates as much of it as the Apiome governance model can express:

* ``extends: spectral:oas`` — the rules Spectral inherits from its bundled OpenAPI ruleset are
  mapped onto the corresponding **built-in** Apiome rules from the GOV-1.2 registry
  (:mod:`app.lint_rule_registry`), as enable/severity overrides a style guide can store.
* ``rules.<id>: <severity>`` — a severity-only override of an inherited rule; resolved through
  the same map (``off`` / ``false`` disable the rule).
* ``rules.<id>: {given, then, …}`` — a custom rule definition, translated into the GOV-1.3
  custom-rule DSL (:mod:`app.custom_rule_dsl`) and validated by that module, so anything the
  importer emits is guaranteed storable and evaluable.

Everything else is **reported, never silently dropped**: each rule that could not be translated
comes back with a machine-readable reason code (:data:`REASON_JS_FUNCTION`,
:data:`REASON_UNSUPPORTED_FUNCTION`, :data:`REASON_UNSUPPORTED_EXTENDS`, …), a human detail
string, and — for definitions rejected by the DSL — the pointer to the offending node. Lossy but
successful translations carry ``notes`` (a dropped ``message``, a dropped ``formats``
restriction, a normalized rule id), so the importer's coverage is transparent rather than
silently partial.

The module is pure and deterministic: :func:`import_spectral_ruleset` does no I/O, and the one
network helper (:func:`fetch_spectral_ruleset`) delegates to the SSRF-guarded ingestion boundary
in :mod:`app.import_ingestion`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from .custom_rule_dsl import (
    CORE_FUNCTIONS,
    MAX_RULE_ID_LENGTH,
    MAX_RULES_PER_GUIDE,
    MAX_YAML_BYTES,
    CustomRule,
    CustomRuleSet,
    CustomRuleValidationError,
    serialize_style_guide_yaml,
    validate_custom_definition,
)
from .lint_rule_registry import builtin_rule_descriptors

__all__ = [
    "MAX_RULESET_BYTES",
    "OUTCOME_BUILTIN",
    "OUTCOME_CUSTOM",
    "OUTCOME_UNSUPPORTED",
    "REASON_INVALID_DEFINITION",
    "REASON_JS_FUNCTION",
    "REASON_MALFORMED_RULE",
    "REASON_RULE_LIMIT",
    "REASON_UNKNOWN_ALIAS",
    "REASON_UNKNOWN_RULE",
    "REASON_UNMAPPED_BUILTIN",
    "REASON_UNSUPPORTED_EXTENDS",
    "REASON_UNSUPPORTED_FUNCTION",
    "REASON_UNSUPPORTED_SEVERITY",
    "SPECTRAL_OAS",
    "SpectralBuiltinRule",
    "SpectralExtendsEntry",
    "SpectralImportEntry",
    "SpectralImportError",
    "SpectralImportResult",
    "builtin_rules_for_spectral_rule",
    "fetch_spectral_ruleset",
    "import_spectral_ruleset",
    "supported_spectral_rulesets",
]

#: Maximum ruleset document size accepted (matches the custom-rule DSL's own YAML cap).
MAX_RULESET_BYTES = MAX_YAML_BYTES

#: The bundled Spectral ruleset this importer understands in ``extends``.
SPECTRAL_OAS = "spectral:oas"

#: Per-rule outcomes reported for every ``rules.<id>`` entry in the source document.
OUTCOME_CUSTOM = "custom"
OUTCOME_BUILTIN = "builtin"
OUTCOME_UNSUPPORTED = "unsupported"

#: Reason codes attached to every unsupported entry (stable, machine-readable).
REASON_UNSUPPORTED_EXTENDS = "unsupported_extends"
REASON_UNMAPPED_BUILTIN = "unmapped_builtin"
REASON_UNKNOWN_RULE = "unknown_rule"
REASON_JS_FUNCTION = "js_function"
REASON_UNSUPPORTED_FUNCTION = "unsupported_function"
REASON_UNSUPPORTED_SEVERITY = "unsupported_severity"
REASON_INVALID_DEFINITION = "invalid_definition"
REASON_MALFORMED_RULE = "malformed_rule"
REASON_UNKNOWN_ALIAS = "unknown_alias"
REASON_RULE_LIMIT = "rule_limit"

#: Spectral severity tokens -> Apiome severities. ``hint`` has no Apiome equivalent and lands on
#: ``info`` (the lowest severity a finding can carry); ``off`` disables the rule instead.
_SEVERITY_TOKENS: Mapping[str, str] = {
    "error": "error",
    "warn": "warning",
    "warning": "warning",
    "info": "info",
    "hint": "info",
}

#: Spectral's numeric severities (``DiagnosticSeverity``): 0=error, 1=warn, 2=info, 3=hint.
_NUMERIC_SEVERITIES: Mapping[int, str] = {0: "error", 1: "warn", 2: "info", 3: "hint"}

#: Spectral's own core functions. The ones outside :data:`app.custom_rule_dsl.CORE_FUNCTIONS`
#: are recognised (so the reason says *which* function is missing) but cannot be translated.
_SPECTRAL_CORE_FUNCTIONS = frozenset(
    {
        "alphabetical",
        "casing",
        "defined",
        "enumeration",
        "falsy",
        "length",
        "pattern",
        "schema",
        "truthy",
        "undefined",
        "unreferencedReusableObject",
        "xor",
    }
)

#: ``spectral:oas`` rule id -> the Apiome built-in rule ids that cover the same ground. One
#: Spectral rule may map onto several Apiome rules (Apiome splits the OpenAPI spec linter and the
#: cross-format canonical-model pack). Rules absent from this map are reported as
#: :data:`REASON_UNMAPPED_BUILTIN` — Apiome has no equivalent, which is a coverage fact worth
#: surfacing rather than hiding.
_SPECTRAL_OAS_RULE_MAP: Mapping[str, Tuple[str, ...]] = {
    "info-description": (
        "documentation.info-missing-description",
        "common.api-missing-description",
    ),
    "operation-description": (
        "documentation.operation-missing-summary",
        "common.operation-missing-description",
    ),
    "oas2-valid-media-example": ("examples.non-conforming-example",),
    "oas2-valid-schema-example": ("examples.non-conforming-example",),
    "oas3-valid-media-example": ("examples.non-conforming-example",),
    "oas3-valid-schema-example": ("examples.non-conforming-example",),
}

#: Every rule id ``spectral:oas`` ships (Spectral v6). Used only to tell "a real Spectral rule
#: Apiome has no equivalent for" (:data:`REASON_UNMAPPED_BUILTIN`) apart from "a rule name that
#: exists nowhere in this document or in Spectral" (:data:`REASON_UNKNOWN_RULE`).
_SPECTRAL_OAS_RULE_IDS = frozenset(
    {
        "contact-properties",
        "duplicated-entry-in-enum",
        "info-contact",
        "info-description",
        "info-license",
        "license-url",
        "no-$ref-siblings",
        "no-eval-in-markdown",
        "no-script-tags-in-markdown",
        "openapi-tags",
        "openapi-tags-alphabetical",
        "openapi-tags-uniqueness",
        "operation-description",
        "operation-operationId",
        "operation-operationId-unique",
        "operation-operationId-valid-in-url",
        "operation-parameters",
        "operation-singular-tag",
        "operation-success-response",
        "operation-tag-defined",
        "operation-tags",
        "path-declarations-must-exist",
        "path-keys-no-trailing-slash",
        "path-not-include-query",
        "path-params",
        "tag-description",
        "typed-enum",
        "oas2-anyOf",
        "oas2-api-host",
        "oas2-api-schemes",
        "oas2-discriminator",
        "oas2-host-not-example",
        "oas2-host-trailing-slash",
        "oas2-oneOf",
        "oas2-operation-formData-consume-check",
        "oas2-operation-security-defined",
        "oas2-parameter-description",
        "oas2-schema",
        "oas2-unused-definition",
        "oas2-valid-media-example",
        "oas2-valid-schema-example",
        "oas3-api-servers",
        "oas3-examples-value-or-externalValue",
        "oas3-operation-security-defined",
        "oas3-parameter-description",
        "oas3-schema",
        "oas3-server-not-example.com",
        "oas3-server-trailing-slash",
        "oas3-server-variables",
        "oas3-unused-component",
        "oas3-valid-media-example",
        "oas3-valid-schema-example",
    }
)

#: Top-level ruleset keys Spectral defines. Recognised-but-ignored keys produce a document note;
#: anything else produces an "unknown key" note. Neither aborts the import.
_KNOWN_TOPLEVEL_KEYS = frozenset(
    {
        "aliases",
        "documentationUrl",
        "extends",
        "formats",
        "functions",
        "functionsDir",
        "overrides",
        "parserOptions",
        "rules",
    }
)

#: Rule-definition keys Spectral defines. Unknown keys are noted and ignored.
_KNOWN_RULE_KEYS = frozenset(
    {
        "description",
        "documentationUrl",
        "formats",
        "given",
        "message",
        "recommended",
        "resolved",
        "severity",
        "then",
        "type",
    }
)

#: Prefix applied to an imported rule id that would otherwise shadow a built-in rule id.
_IMPORTED_ID_PREFIX = "imported."

#: Characters allowed in a custom rule id (see ``custom_rule_dsl._RULE_ID_RE``).
_ID_SAFE = set("abcdefghijklmnopqrstuvwxyz0123456789-_.")


class SpectralImportError(Exception):
    """The ruleset document could not be read at all (fetch failure, bad YAML, wrong shape).

    Per-rule problems are never raised — they are reported as unsupported entries. This
    exception is reserved for a document the importer cannot even begin to translate.

    Attributes:
        message: Human-readable, safe-to-surface explanation.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class SpectralImportEntry:
    """The outcome of translating one ``rules.<id>`` entry of the source document.

    Attributes:
        source_rule_id: The rule id exactly as written in the ``.spectral.yaml``.
        outcome: :data:`OUTCOME_CUSTOM` (translated into the DSL), :data:`OUTCOME_BUILTIN`
            (resolved onto built-in rules), or :data:`OUTCOME_UNSUPPORTED`.
        rule_id: The Apiome custom rule id the rule was imported as (custom outcome only;
            differs from ``source_rule_id`` when the id had to be normalized).
        builtin_rule_ids: The built-in rule ids the entry resolved onto (builtin outcome only).
        severity: The Apiome severity the entry assigns, or ``None`` to keep the default.
        enabled: ``False`` when the source turned the rule off (``off`` / ``false`` /
            ``recommended: false``). Disabled custom rules are reported but left out of
            :attr:`SpectralImportResult.yaml`.
        reason: Machine-readable reason code (unsupported outcome only).
        detail: Human explanation of the reason (unsupported outcome only).
        pointer: Pointer to the offending node for DSL validation failures
            (``rules.my-rule.then.functionOptions.match``).
        notes: Lossy-translation notes for an otherwise successful import.
    """

    source_rule_id: str
    outcome: str
    rule_id: Optional[str] = None
    builtin_rule_ids: Tuple[str, ...] = ()
    severity: Optional[str] = None
    enabled: bool = True
    reason: Optional[str] = None
    detail: Optional[str] = None
    pointer: Optional[str] = None
    notes: Tuple[str, ...] = ()


@dataclass(frozen=True)
class SpectralExtendsEntry:
    """One ``extends`` target and whether the importer could resolve it.

    Attributes:
        target: The target as written (``spectral:oas``, ``./shared.yaml``, an npm package, …).
        supported: True when the target is a bundled ruleset this importer maps.
        modifier: The Spectral modifier of a ``[target, modifier]`` pair (``recommended``,
            ``all``, ``off``), or ``None``.
        mapped_rule_count: Built-in rules inherited from this target.
        reason: Reason code when unsupported (:data:`REASON_UNSUPPORTED_EXTENDS`).
        detail: Human explanation when unsupported.
    """

    target: str
    supported: bool
    modifier: Optional[str] = None
    mapped_rule_count: int = 0
    reason: Optional[str] = None
    detail: Optional[str] = None


@dataclass(frozen=True)
class SpectralBuiltinRule:
    """A built-in rule row the import resolves to — the shape a style guide stores.

    Attributes:
        rule_id: A registered built-in rule id (GOV-1.2).
        enabled: Whether the imported ruleset leaves the rule on.
        severity: The severity to store (the registry default when the source did not override).
        source_rule_id: The Spectral rule (or ``extends`` target) it came from.
    """

    rule_id: str
    enabled: bool
    severity: str
    source_rule_id: str


@dataclass(frozen=True)
class SpectralImportResult:
    """Everything one ``.spectral.yaml`` translated into, plus what it could not.

    Attributes:
        source_label: Human label for the source (filename or URL), when known.
        entries: One entry per ``rules.<id>`` of the source, in document order.
        extends: One entry per ``extends`` target, in document order.
        builtin_rules: Built-in rule rows to store on a style guide, sorted by rule id.
        custom_rules: The rules that translated into the GOV-1.3 DSL (enabled ones only).
        yaml: :attr:`custom_rules` serialized as a style-guide document — the exact body
            ``PUT /v1/style-guides/{tenant}/{guide}/custom-rules`` accepts.
        notes: Document-level notes (ignored top-level keys, dropped ``overrides``, …).
    """

    source_label: Optional[str]
    entries: Tuple[SpectralImportEntry, ...]
    extends: Tuple[SpectralExtendsEntry, ...]
    builtin_rules: Tuple[SpectralBuiltinRule, ...]
    custom_rules: CustomRuleSet
    yaml: str
    notes: Tuple[str, ...] = ()

    @property
    def rule_count(self) -> int:
        """Number of ``rules.<id>`` entries the source document declared."""
        return len(self.entries)

    @property
    def mapped_count(self) -> int:
        """Entries the importer translated (custom rules + built-in resolutions)."""
        return sum(1 for entry in self.entries if entry.outcome != OUTCOME_UNSUPPORTED)

    @property
    def unsupported_count(self) -> int:
        """Entries the importer could not translate (each carries a reason)."""
        return sum(1 for entry in self.entries if entry.outcome == OUTCOME_UNSUPPORTED)

    @property
    def coverage(self) -> float:
        """Fraction of source rules that mapped, ``0.0``–``1.0`` (``1.0`` for an empty ruleset).

        This is the number the GOV-1.5 acceptance criterion measures (a Zalando-style public
        ruleset must import with at least 70% of its rules mapped).
        """
        if not self.entries:
            return 1.0
        return round(self.mapped_count / len(self.entries), 4)


def supported_spectral_rulesets() -> Tuple[str, ...]:
    """Return the bundled Spectral rulesets the importer resolves in ``extends``."""
    return (SPECTRAL_OAS,)


def builtin_rules_for_spectral_rule(spectral_rule_id: str) -> Tuple[str, ...]:
    """Return the Apiome built-in rule ids a ``spectral:oas`` rule maps onto (may be empty).

    Args:
        spectral_rule_id: A Spectral rule id (``info-description``).

    Returns:
        The mapped built-in rule ids, or an empty tuple when Apiome has no equivalent.
    """
    return _SPECTRAL_OAS_RULE_MAP.get(spectral_rule_id, ())


# --- Severity / id helpers ---------------------------------------------------------------------


def _resolve_severity(value: Any) -> Tuple[bool, Optional[str]]:
    """Resolve a Spectral severity token to ``(enabled, apiome_severity)``.

    Spectral accepts ``error`` / ``warn`` / ``info`` / ``hint`` / ``off``, the booleans
    ``true`` / ``false`` (keep the inherited severity / turn the rule off), and the numeric
    ``DiagnosticSeverity`` values ``0``–``3`` (``-1`` meaning off).

    Args:
        value: The raw severity node.

    Returns:
        ``(enabled, severity)`` where ``severity`` is ``None`` when the source did not pick one.

    Raises:
        ValueError: When the token is not a Spectral severity.
    """
    if isinstance(value, bool):
        return (value, None)
    if isinstance(value, int):
        if value == -1:
            return (False, None)
        token = _NUMERIC_SEVERITIES.get(value)
        if token is None:
            raise ValueError(f"{value!r} is not a Spectral severity (0-3, or -1 for off)")
        return (True, _SEVERITY_TOKENS[token])
    if isinstance(value, str):
        token = value.strip().lower()
        if token == "off":
            return (False, None)
        if token in _SEVERITY_TOKENS:
            return (True, _SEVERITY_TOKENS[token])
    raise ValueError(
        f"{value!r} is not a Spectral severity "
        f"(error, warn, info, hint, off, true, false, or 0-3)"
    )


def _normalize_rule_id(source_rule_id: str, taken: Sequence[str], reserved: frozenset) -> Optional[str]:
    """Map a Spectral rule id onto a legal, unused Apiome custom rule id.

    Spectral ids are freer than the DSL's (which is lowercase alphanumeric segments separated by
    ``.``, ``-`` or ``_``), so uppercase and punctuation are folded down. An id that would shadow
    a built-in rule is prefixed with ``imported.``; a collision with an already-imported rule
    gets a numeric suffix.

    Args:
        source_rule_id: The rule id as written in the ruleset.
        taken: Ids already used by this import.
        reserved: Built-in rule ids the result must not shadow.

    Returns:
        The normalized id, or ``None`` when nothing legal remains (e.g. an id of pure
        punctuation).
    """
    lowered = "".join(char if char in _ID_SAFE else "-" for char in source_rule_id.strip().lower())
    # Collapse runs of separators introduced by folding and trim edge separators.
    while "--" in lowered:
        lowered = lowered.replace("--", "-")
    # Stripping the separators leaves an id that starts and ends alphanumeric, as the DSL wants.
    candidate = lowered.strip("-._")
    if not candidate:
        return None
    if candidate in reserved:
        candidate = f"{_IMPORTED_ID_PREFIX}{candidate}"
    candidate = candidate[:MAX_RULE_ID_LENGTH]
    if candidate not in taken:
        return candidate
    for suffix in range(2, 1000):
        alternative = f"{candidate[: MAX_RULE_ID_LENGTH - 5]}-{suffix}"
        if alternative not in taken:
            return alternative
    return None  # pragma: no cover - 998 colliding ids is not reachable in practice


def _builtin_default_severities() -> Dict[str, str]:
    """Return ``rule_id -> default severity`` for every registered built-in rule (GOV-1.2)."""
    return {d.rule_id: d.default_severity for d in builtin_rule_descriptors()}


# --- Document parsing --------------------------------------------------------------------------


def _load_ruleset(text: str) -> Mapping[str, Any]:
    """Load the ruleset YAML, enforcing the size cap and the top-level mapping shape."""
    if not isinstance(text, str) or not text.strip():
        raise SpectralImportError("the Spectral ruleset document is empty")
    if len(text.encode("utf-8", errors="replace")) > MAX_RULESET_BYTES:
        raise SpectralImportError(
            f"the Spectral ruleset document exceeds {MAX_RULESET_BYTES} bytes"
        )
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        problem = getattr(exc, "problem", None) or str(exc)
        raise SpectralImportError(f"invalid YAML: {problem}{where}") from exc
    if document is None:
        raise SpectralImportError("the Spectral ruleset document is empty")
    if not isinstance(document, Mapping):
        raise SpectralImportError(
            f"a Spectral ruleset must be a YAML mapping, got {type(document).__name__}"
        )
    return document


def _collect_aliases(document: Mapping[str, Any], notes: List[str]) -> Dict[str, List[str]]:
    """Resolve the ruleset's ``aliases`` block to ``name -> JSONPath list``.

    Spectral aliases come in two shapes: a plain list of JSONPaths, and the format-scoped
    ``{description, targets: [{formats, given}]}`` form. Only the plain form can be inlined
    without losing the format scoping, so the scoped form is skipped (and noted); rules
    referencing a skipped alias are reported as :data:`REASON_UNKNOWN_ALIAS`.
    """
    raw = document.get("aliases")
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        notes.append("'aliases' is not a mapping and was ignored")
        return {}

    aliases: Dict[str, List[str]] = {}
    for name, value in raw.items():
        if isinstance(value, str):
            aliases[str(name)] = [value]
        elif isinstance(value, list) and value and all(isinstance(item, str) for item in value):
            aliases[str(name)] = list(value)
        else:
            notes.append(
                f"alias '{name}' uses the format-scoped 'targets' form, which has no Apiome "
                "equivalent; rules referencing it were not imported"
            )
    return aliases


def _resolve_given(
    raw_given: Any, aliases: Mapping[str, List[str]]
) -> Tuple[List[str], Optional[str]]:
    """Expand alias references (``#Name``) in a rule's ``given``.

    Args:
        raw_given: The ``given`` node (a string or a list of strings).
        aliases: Resolved aliases from the document.

    Returns:
        ``(expressions, unresolved_alias)`` — ``unresolved_alias`` names the first ``#Alias``
        that could not be resolved, in which case ``expressions`` is unusable.
    """
    items = raw_given if isinstance(raw_given, list) else [raw_given]
    expressions: List[str] = []
    for item in items:
        if isinstance(item, str) and item.startswith("#"):
            name = item[1:].split(".", 1)[0]
            if name not in aliases:
                return ([], item)
            if "." in item[1:]:
                # '#Alias.tail' appends a path suffix to every alias target.
                tail = item[1:].split(".", 1)[1]
                expressions.extend(f"{target}.{tail}" for target in aliases[name])
            else:
                expressions.extend(aliases[name])
        else:
            expressions.append(item)
    return (expressions, None)


# --- Rule translation --------------------------------------------------------------------------


@dataclass
class _TranslationContext:
    """Mutable state shared by the per-rule translation helpers."""

    aliases: Mapping[str, List[str]]
    js_functions: frozenset
    reserved: frozenset
    extended_rules: Mapping[str, Tuple[str, ...]]
    extends_all_known: frozenset
    taken_ids: List[str] = field(default_factory=list)
    imported_rules: List[CustomRule] = field(default_factory=list)


def _unsupported(
    source_rule_id: str, reason: str, detail: str, pointer: Optional[str] = None
) -> SpectralImportEntry:
    """Build an unsupported entry (the only way a rule fails to import)."""
    return SpectralImportEntry(
        source_rule_id=source_rule_id,
        outcome=OUTCOME_UNSUPPORTED,
        reason=reason,
        detail=detail,
        pointer=pointer,
    )


def _translate_severity_override(
    source_rule_id: str, value: Any, context: _TranslationContext
) -> SpectralImportEntry:
    """Resolve ``rules.<id>: <severity>`` — a severity-only override of an inherited rule."""
    try:
        enabled, severity = _resolve_severity(value)
    except ValueError as exc:
        return _unsupported(
            source_rule_id, REASON_UNSUPPORTED_SEVERITY, str(exc), f"rules.{source_rule_id}"
        )

    mapped = context.extended_rules.get(source_rule_id)
    if mapped:
        return SpectralImportEntry(
            source_rule_id=source_rule_id,
            outcome=OUTCOME_BUILTIN,
            builtin_rule_ids=mapped,
            severity=severity,
            enabled=enabled,
        )
    if source_rule_id in context.extends_all_known:
        return _unsupported(
            source_rule_id,
            REASON_UNMAPPED_BUILTIN,
            f"'{source_rule_id}' is a Spectral rule with no equivalent Apiome built-in rule; "
            "re-author it as a custom rule if you need it",
            f"rules.{source_rule_id}",
        )
    return _unsupported(
        source_rule_id,
        REASON_UNKNOWN_RULE,
        f"'{source_rule_id}' has a severity but no definition, and is not inherited from any "
        "supported 'extends' ruleset",
        f"rules.{source_rule_id}",
    )


def _translate_then_clauses(
    source_rule_id: str, raw_then: Any, context: _TranslationContext
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[SpectralImportEntry]]:
    """Translate a rule's ``then`` clauses, rejecting functions the DSL cannot evaluate.

    Returns:
        ``(clauses, failure)`` — exactly one is non-``None``.
    """
    clauses_in = raw_then if isinstance(raw_then, list) else [raw_then]
    clauses: List[Dict[str, Any]] = []
    for index, clause in enumerate(clauses_in):
        pointer = f"rules.{source_rule_id}.then"
        if isinstance(raw_then, list):
            pointer = f"{pointer}[{index}]"
        if not isinstance(clause, Mapping):
            return (
                None,
                _unsupported(
                    source_rule_id,
                    REASON_MALFORMED_RULE,
                    f"'then' must be an object or a list of objects, got "
                    f"{type(clause).__name__}",
                    pointer,
                ),
            )
        function = clause.get("function")
        if not isinstance(function, str) or not function:
            return (
                None,
                _unsupported(
                    source_rule_id,
                    REASON_MALFORMED_RULE,
                    "'then' requires a 'function' name",
                    f"{pointer}.function",
                ),
            )
        if function not in CORE_FUNCTIONS:
            if function in context.js_functions:
                return (
                    None,
                    _unsupported(
                        source_rule_id,
                        REASON_JS_FUNCTION,
                        f"'{function}' is a JavaScript function from the ruleset's 'functions' "
                        "list; custom code cannot be imported",
                        f"{pointer}.function",
                    ),
                )
            if function in _SPECTRAL_CORE_FUNCTIONS:
                return (
                    None,
                    _unsupported(
                        source_rule_id,
                        REASON_UNSUPPORTED_FUNCTION,
                        f"the Spectral core function '{function}' is outside the supported "
                        f"subset ({', '.join(sorted(CORE_FUNCTIONS))})",
                        f"{pointer}.function",
                    ),
                )
            return (
                None,
                _unsupported(
                    source_rule_id,
                    REASON_JS_FUNCTION,
                    f"'{function}' is not a core function, so it resolves to custom JavaScript, "
                    "which cannot be imported",
                    f"{pointer}.function",
                ),
            )

        translated: Dict[str, Any] = {"function": function}
        if clause.get("field") is not None:
            translated["field"] = clause["field"]
        options = clause.get("functionOptions")
        if options is not None:
            translated["functionOptions"] = options
        clauses.append(translated)
    return (clauses, None)


def _translate_definition(
    source_rule_id: str, definition: Mapping[str, Any], context: _TranslationContext
) -> SpectralImportEntry:
    """Translate one ``rules.<id>: {given, then, …}`` definition into the GOV-1.3 DSL."""
    notes: List[str] = []

    for key in definition:
        if key not in _KNOWN_RULE_KEYS:
            notes.append(f"ignored unknown rule key '{key}'")

    enabled = True
    severity: Optional[str] = None
    if "severity" in definition:
        try:
            enabled, severity = _resolve_severity(definition["severity"])
        except ValueError as exc:
            return _unsupported(
                source_rule_id,
                REASON_UNSUPPORTED_SEVERITY,
                str(exc),
                f"rules.{source_rule_id}.severity",
            )
        if isinstance(definition["severity"], str) and definition["severity"].strip().lower() == "hint":
            notes.append("severity 'hint' has no Apiome equivalent and was imported as 'info'")
    if definition.get("recommended") is False:
        enabled = False
        notes.append("'recommended: false' imported as a disabled rule")
    if definition.get("message") is not None:
        notes.append("custom 'message' templates are not supported; the description is used")
    if definition.get("formats") is not None:
        notes.append(
            "the 'formats' restriction was dropped; the rule applies to every linted document"
        )
    if definition.get("resolved") is False:
        notes.append("'resolved: false' was dropped; rules evaluate the resolved document")

    description = definition.get("description")
    if not isinstance(description, str) or not description.strip():
        fallback = definition.get("message")
        if isinstance(fallback, str) and fallback.strip() and "{{" not in fallback:
            description = fallback.strip()
            notes.append("'description' was missing; the rule's 'message' was used instead")
        else:
            description = source_rule_id.replace("-", " ").replace("_", " ").strip()
            notes.append("'description' was missing; one was derived from the rule id")

    if "given" not in definition:
        return _unsupported(
            source_rule_id,
            REASON_MALFORMED_RULE,
            "'given' is required",
            f"rules.{source_rule_id}.given",
        )
    given, unresolved_alias = _resolve_given(definition["given"], context.aliases)
    if unresolved_alias is not None:
        return _unsupported(
            source_rule_id,
            REASON_UNKNOWN_ALIAS,
            f"'given' references the alias '{unresolved_alias}', which this ruleset does not "
            "define in a form the importer can inline",
            f"rules.{source_rule_id}.given",
        )
    if len(given) > 1 and not isinstance(definition["given"], list):
        notes.append("an alias reference expanded 'given' into several JSONPath expressions")

    if "then" not in definition:
        return _unsupported(
            source_rule_id,
            REASON_MALFORMED_RULE,
            "'then' is required",
            f"rules.{source_rule_id}.then",
        )
    clauses, failure = _translate_then_clauses(source_rule_id, definition["then"], context)
    if failure is not None:
        return failure

    if len(context.imported_rules) >= MAX_RULES_PER_GUIDE:
        return _unsupported(
            source_rule_id,
            REASON_RULE_LIMIT,
            f"a style guide holds at most {MAX_RULES_PER_GUIDE} custom rules; this rule was "
            "beyond the limit",
            f"rules.{source_rule_id}",
        )

    rule_id = _normalize_rule_id(source_rule_id, context.taken_ids, context.reserved)
    if rule_id is None:
        return _unsupported(
            source_rule_id,
            REASON_MALFORMED_RULE,
            "the rule id contains no characters usable in an Apiome rule id",
            f"rules.{source_rule_id}",
        )
    if rule_id != source_rule_id:
        notes.append(f"rule id normalized from '{source_rule_id}' to '{rule_id}'")

    # Keep the source document's scalar/list shape so DSL pointers address the node the author
    # actually wrote (``rules.r.then.function``, not ``rules.r.then[0].function``).
    candidate: Dict[str, Any] = {
        "description": description,
        "severity": severity or "warning",
        "given": given if isinstance(definition["given"], list) or len(given) != 1 else given[0],
        "then": clauses if isinstance(definition["then"], list) else clauses[0],
    }
    try:
        rule = validate_custom_definition(
            rule_id,
            candidate,
            pointer=f"rules.{source_rule_id}",
            reserved_rule_ids=context.reserved,
        )
    except CustomRuleValidationError as exc:
        return _unsupported(source_rule_id, REASON_INVALID_DEFINITION, exc.message, exc.pointer)

    context.taken_ids.append(rule_id)
    if enabled:
        context.imported_rules.append(rule)
    return SpectralImportEntry(
        source_rule_id=source_rule_id,
        outcome=OUTCOME_CUSTOM,
        rule_id=rule_id,
        severity=rule.severity,
        enabled=enabled,
        notes=tuple(notes),
    )


# --- extends -----------------------------------------------------------------------------------


def _extends_targets(document: Mapping[str, Any], notes: List[str]) -> List[Tuple[str, Optional[str]]]:
    """Normalize the ``extends`` node to ``[(target, modifier)]`` pairs."""
    raw = document.get("extends")
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    targets: List[Tuple[str, Optional[str]]] = []
    for item in items:
        if isinstance(item, str):
            targets.append((item, None))
        elif isinstance(item, list) and item and isinstance(item[0], str):
            targets.append((item[0], _extends_modifier(item[1] if len(item) > 1 else None)))
        else:
            notes.append(f"ignored malformed 'extends' entry: {item!r}")
    return targets


def _extends_modifier(raw: Any) -> Optional[str]:
    """Normalize an ``extends`` modifier token.

    YAML 1.1 resolves the bare word ``off`` to the boolean ``False`` (and ``on`` to ``True``),
    so a ``.spectral.yaml`` never delivers the literal string Spectral's JSON rulesets carry.
    """
    if isinstance(raw, bool):
        return "off" if raw is False else "recommended"
    if isinstance(raw, str) and raw.strip():
        return raw.strip().lower()
    return None


def _resolve_extends(
    document: Mapping[str, Any], notes: List[str], defaults: Mapping[str, str]
) -> Tuple[List[SpectralExtendsEntry], Dict[str, Tuple[str, ...]], frozenset, Dict[str, SpectralBuiltinRule]]:
    """Resolve every ``extends`` target to inherited built-in rules.

    Args:
        document: The parsed ruleset.
        notes: Document-level notes, appended to in place.
        defaults: ``rule_id -> default severity`` from the GOV-1.2 registry.

    Returns:
        ``(entries, mapped_rules, known_rule_ids, builtin_rows)`` where ``mapped_rules`` maps a
        Spectral rule id to the built-in ids it covers, ``known_rule_ids`` is every rule id the
        extended rulesets ship (mapped or not), and ``builtin_rows`` is the inherited built-in
        state keyed by Apiome rule id.
    """
    entries: List[SpectralExtendsEntry] = []
    mapped_rules: Dict[str, Tuple[str, ...]] = {}
    known_rule_ids: set = set()
    builtin_rows: Dict[str, SpectralBuiltinRule] = {}

    for target, modifier in _extends_targets(document, notes):
        if target != SPECTRAL_OAS:
            entries.append(
                SpectralExtendsEntry(
                    target=target,
                    supported=False,
                    modifier=modifier,
                    reason=REASON_UNSUPPORTED_EXTENDS,
                    detail=(
                        f"'{target}' is not a bundled ruleset this importer maps "
                        f"(supported: {', '.join(supported_spectral_rulesets())}); its rules "
                        "were not inherited"
                    ),
                )
            )
            continue

        mapped_rules.update(_SPECTRAL_OAS_RULE_MAP)
        known_rule_ids |= _SPECTRAL_OAS_RULE_IDS
        inherit_enabled = (modifier or "recommended").strip().lower() != "off"
        for spectral_rule_id, builtin_ids in _SPECTRAL_OAS_RULE_MAP.items():
            for builtin_id in builtin_ids:
                builtin_rows[builtin_id] = SpectralBuiltinRule(
                    rule_id=builtin_id,
                    enabled=inherit_enabled,
                    severity=defaults.get(builtin_id, "warning"),
                    source_rule_id=spectral_rule_id,
                )
        if modifier and modifier.strip().lower() == "off":
            notes.append(
                f"'extends: [{target}, off]' inherits the ruleset with every rule disabled"
            )
        entries.append(
            SpectralExtendsEntry(
                target=target,
                supported=True,
                modifier=modifier,
                mapped_rule_count=len(builtin_rows),
            )
        )
    return (entries, mapped_rules, frozenset(known_rule_ids), builtin_rows)


# --- Public API --------------------------------------------------------------------------------


def import_spectral_ruleset(
    text: str,
    *,
    source_label: Optional[str] = None,
    reserved_rule_ids: Optional[frozenset] = None,
) -> SpectralImportResult:
    """Translate a ``.spectral.yaml`` ruleset into Apiome governance state.

    Every ``rules.<id>`` entry lands in exactly one of three outcomes — imported as a GOV-1.3
    custom rule, resolved onto GOV-1.2 built-in rules, or reported unsupported with a reason —
    so the result accounts for the whole document.

    Args:
        text: The ruleset YAML source.
        source_label: Human label for the source (filename or URL), echoed in the result.
        reserved_rule_ids: Built-in rule ids imported custom rules must not shadow; defaults to
            the live GOV-1.2 registry.

    Returns:
        The :class:`SpectralImportResult`.

    Raises:
        SpectralImportError: When the document itself cannot be read (empty, invalid YAML, not
            a mapping, or larger than :data:`MAX_RULESET_BYTES`). Per-rule problems never raise.
    """
    document = _load_ruleset(text)
    notes: List[str] = []

    for key in document:
        if key not in _KNOWN_TOPLEVEL_KEYS:
            notes.append(f"ignored unknown top-level key '{key}'")
    if document.get("overrides"):
        notes.append(
            "top-level 'overrides' (per-file rule targeting) has no Apiome equivalent and was "
            "ignored; a style guide is assigned per project instead"
        )
    if document.get("parserOptions"):
        notes.append("'parserOptions' was ignored; Apiome parses documents with its own intake")

    defaults = _builtin_default_severities()
    reserved = reserved_rule_ids if reserved_rule_ids is not None else frozenset(defaults)

    extends_entries, mapped_rules, known_rule_ids, builtin_rows = _resolve_extends(
        document, notes, defaults
    )

    raw_functions = document.get("functions")
    js_functions = frozenset(
        name for name in raw_functions if isinstance(name, str)
    ) if isinstance(raw_functions, list) else frozenset()

    context = _TranslationContext(
        aliases=_collect_aliases(document, notes),
        js_functions=js_functions,
        reserved=reserved,
        extended_rules=mapped_rules,
        extends_all_known=known_rule_ids,
    )

    raw_rules = document.get("rules")
    if raw_rules is not None and not isinstance(raw_rules, Mapping):
        raise SpectralImportError(
            f"'rules' must be a mapping of rule id to definition, got {type(raw_rules).__name__}"
        )

    entries: List[SpectralImportEntry] = []
    for source_rule_id, value in (raw_rules or {}).items():
        source_rule_id = str(source_rule_id)
        if isinstance(value, Mapping):
            entry = _translate_definition(source_rule_id, value, context)
        elif isinstance(value, (str, bool, int)):
            entry = _translate_severity_override(source_rule_id, value, context)
        else:
            entry = _unsupported(
                source_rule_id,
                REASON_MALFORMED_RULE,
                f"a rule must be a definition object or a severity, got {type(value).__name__}",
                f"rules.{source_rule_id}",
            )
        if entry.outcome == OUTCOME_BUILTIN:
            for builtin_id in entry.builtin_rule_ids:
                inherited = builtin_rows.get(builtin_id)
                # A bare 'true' keeps the inherited severity, else the registry default.
                severity = entry.severity or (
                    inherited.severity if inherited else defaults.get(builtin_id, "warning")
                )
                builtin_rows[builtin_id] = SpectralBuiltinRule(
                    rule_id=builtin_id,
                    enabled=entry.enabled,
                    severity=severity,
                    source_rule_id=entry.source_rule_id,
                )
        entries.append(entry)

    ruleset = CustomRuleSet(rules=tuple(context.imported_rules))
    return SpectralImportResult(
        source_label=source_label,
        entries=tuple(entries),
        extends=tuple(extends_entries),
        builtin_rules=tuple(builtin_rows[key] for key in sorted(builtin_rows)),
        custom_rules=ruleset,
        yaml=serialize_style_guide_yaml(ruleset),
        notes=tuple(notes),
    )


def fetch_spectral_ruleset(url: str) -> Tuple[str, str]:
    """Fetch a ruleset document over http/https through the SSRF-guarded ingestion boundary.

    Args:
        url: The ruleset URL.

    Returns:
        ``(text, resolved_label)``.

    Raises:
        SpectralImportError: On a malformed/blocked URL, a network failure, an oversized body,
            or a document that is not parseable at all.
    """
    from .import_ingestion import IngestionError, ingest_source
    from .intake_resource_guard import IntakeLimitError

    try:
        ingested = ingest_source("url", url=url, max_bytes=MAX_RULESET_BYTES)
    except IngestionError as exc:
        raise SpectralImportError(exc.message) from exc
    except IntakeLimitError as exc:
        raise SpectralImportError(str(exc)) from exc
    return (ingested.text, ingested.resolved_label or url)
