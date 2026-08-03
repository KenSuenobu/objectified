"""GraphQL lint pack — MFI-10.4 (#3773).

Quality signals for GraphQL (graph) APIs, layered on the canonical lint engine
(MFI-4.1 :mod:`app.lint_engine`) and the shared scoring/grade/fingerprint formula
(MFI-4.2 :mod:`app.schema_lint`). Like the AsyncAPI pack (MFI-8.3 :mod:`app.asyncapi_lint`)
it has two complementary halves, here modelling the three ``graphql-eslint`` rule families the
roadmap calls out — ``schema-recommended`` / ``require-description`` / ``naming-convention``:

* **Native rules** (:class:`GraphqlRulePack`) — a :class:`~app.lint_engine.RulePack` registered
  under the ``graphql`` format key (the one the MFI-10.2 normalizer emits). The rules run purely
  over the :class:`~app.canonical_model.CanonicalApi` — no I/O, no Node — encoding the
  SDL-checkable semantics of the three ``graphql-eslint`` configs:

  - **naming-convention** — type names PascalCase, field / input-field / root-operation names
    and arguments camelCase, enum values ``UPPER_CASE`` (``graphql-eslint``'s
    ``naming-convention`` defaults).
  - **require-description** — the GraphQL-specific description gaps the cross-format common pack
    does not already cover: **enum values** and **operation arguments**. (The common pack
    already flags missing type / field / operation / message descriptions, so we do not repeat
    them here.)
  - **schema-recommended** — the recommended-config rule that survives into a *valid* built
    schema and is checkable over the canonical model: **require-deprecation-reason** (an entity
    marked ``@deprecated`` with no reason).

  Because the pack is registered, it runs automatically via the engine default
  (:func:`app.lint_engine.lint_canonical_model`) for any ``graphql`` artifact — i.e. the
  always-on import-time score (MFI-4.2) — even with no external linter present. Unlike the
  AsyncAPI seam, the whole GraphQL toolchain in this service is pure Python (``graphql-core``,
  see MFI-10.1/10.2/10.3), so the native pack alone fully satisfies "lints SDL; findings scored".

* **graphql-eslint findings** (:func:`eslint_findings`) — the authoritative ``graphql-eslint``
  configs (``schema-recommended`` + ``require-description`` + ``naming-convention``) are a Node
  linter. This function maps ``graphql-eslint``'s standard ESLint JSON output into
  :class:`~app.schema_lint.LintFinding`\\s so they merge into the *very same* weighted score —
  i.e. we *wrap* the external linter's verdicts rather than re-implementing every rule. Running
  the ``graphql-eslint`` CLI itself is the job of the generic external-linter adapter
  (**MFI-4.3**, via the polyglot toolchain runner :mod:`app.toolchain_runner`); the moment that
  adapter feeds this pack ``graphql-eslint`` output, it is scored alongside the native findings.

The two halves come together in :func:`lint_graphql_result` (sync, pure — takes a model plus
optional ``graphql-eslint`` output) and the convenience :func:`lint_graphql` (parses SDL,
normalizes, then lints). The external findings are **opt-in and degrade gracefully**: with no
``graphql-eslint`` output supplied the native + common packs still produce a deterministic
score, exactly as MFI-4.3 requires of an external-linter adapter.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Operation,
    Parameter,
    Service,
    Type,
    TypeKind,
)
from .lint_engine import (
    LintRule,
    RulePack,
    lint_canonical_model,
)
from .schema_lint import LintFinding, LintResult, Severity

__all__ = [
    "GraphqlRulePack",
    "eslint_findings",
    "lint_graphql_result",
    "lint_graphql",
    "GRAPHQL_ESLINT_RULE_PREFIX",
    "GRAPHQL_ESLINT_PLUGIN_PREFIX",
]


# ===========================================================================
# Naming conventions (graphql-eslint `naming-convention` defaults)
# ===========================================================================
#
# graphql-eslint's `naming-convention` rule defaults: type definitions PascalCase, every
# FieldDefinition / InputValueDefinition (object & input fields, root-operation fields) and
# Argument camelCase, and EnumValueDefinition UPPER_CASE. We mirror those case styles here.

#: A type/interface/union/enum/scalar/input name should be PascalCase (``User``, ``PostStatus``).
_PASCAL_CASE = re.compile(r"^[A-Z][A-Za-z0-9]*$")

#: A field / input-field / operation / argument name should be camelCase (``userId``, ``createPost``).
_CAMEL_CASE = re.compile(r"^[a-z][A-Za-z0-9]*$")

#: An enum value should be SCREAMING_SNAKE / UPPER_CASE (``DRAFT``, ``IN_PROGRESS``, ``LEVEL_1``).
_UPPER_CASE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$")


def _is_pascal_case(name: str) -> bool:
    return bool(_PASCAL_CASE.match(name))


def _is_camel_case(name: str) -> bool:
    return bool(_CAMEL_CASE.match(name))


def _is_upper_case(name: str) -> bool:
    return bool(_UPPER_CASE.match(name))


def _nonempty_str(value: Any) -> bool:
    """True when ``value`` is a non-blank string."""
    return isinstance(value, str) and value.strip() != ""


# ===========================================================================
# Deterministic, sorted iteration over the canonical GraphQL model
# ===========================================================================
#
# Every check yields ``(path, message)`` pairs in sorted-key order so the engine's deterministic
# re-sort never depends on emission order. Paths mirror the common pack's coordinates —
# ``types.{type}``, ``types.{type}.fields.{field}``, ``services.{service}.operations.{op}`` — so
# a defect carries the same path no matter which pack reports it.


def _types_sorted(api: CanonicalApi) -> List[Type]:
    return sorted(api.types, key=lambda t: t.key)


def _fields_sorted(api_type: Type) -> List[CanonicalField]:
    return sorted(api_type.fields, key=lambda f: f.key)


def _enum_values_sorted(api_type: Type) -> List[EnumValue]:
    return sorted(api_type.enum_values, key=lambda v: v.key)


def _services_sorted(api: CanonicalApi) -> List[Service]:
    return sorted(api.services, key=lambda s: s.key)


def _operations_sorted(service: Service) -> List[Operation]:
    return sorted(service.operations, key=lambda o: o.key)


def _parameters_sorted(operation: Operation) -> List[Parameter]:
    return sorted(operation.parameters, key=lambda p: p.key)


def _graphql_family(api_type: Type) -> str:
    """The GraphQL type family the MFI-10.2 normalizer stowed in ``extras`` (``object`` …).

    Falls back to ``"type"`` if the model was built without the family extra (e.g. a hand-built
    test fixture), so messages stay readable either way.
    """
    family = api_type.extras.get("graphql_type")
    return family if isinstance(family, str) and family else "type"


def _deprecation_reason(extras: Dict[str, Any]) -> Any:
    """The ``deprecation_reason`` the normalizer consumes ``@deprecated(reason:)`` into."""
    return extras.get("deprecation_reason")


# ===========================================================================
# Native rule checks (pure generators over the canonical model)
# ===========================================================================


def _is_spec_machinery(name: str) -> bool:
    """Whether a name is federation/spec machinery (``join__Graph``, ``link__Purpose``…).

    The double-underscore infix is the Apollo spec-namespace convention
    (``join__``/``link__``/``federation__``); flagging those names against the
    author's naming conventions would put deterministic noise on every
    supergraph import, so the naming checks skip them (IXH-7.6).
    """
    return "__" in name


def _check_type_naming(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Type-like definitions should be PascalCase (graphql-eslint ``naming-convention``)."""
    for api_type in _types_sorted(api):
        if _is_spec_machinery(api_type.name):
            continue
        if not _is_pascal_case(api_type.name):
            family = _graphql_family(api_type)
            yield (
                f"types.{api_type.key}",
                f"{family.capitalize()} type '{api_type.name}' is not PascalCase.",
            )


def _check_field_naming(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Object/input fields and root-operation fields should be camelCase.

    Covers ``graphql-eslint``'s ``FieldDefinition``/``InputValueDefinition`` case rule across
    every record type's fields and every root-operation field (a query/mutation/subscription
    field is a ``FieldDefinition`` too).
    """
    for api_type in _types_sorted(api):
        for field in _fields_sorted(api_type):
            if not _is_camel_case(field.name):
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' is not camelCase.",
                )
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            if not _is_camel_case(operation.name):
                yield (
                    f"services.{service.key}.operations.{operation.key}",
                    f"Operation '{operation.name}' is not camelCase.",
                )


def _check_argument_naming(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Operation arguments should be camelCase (graphql-eslint ``Argument`` case rule)."""
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            for parameter in _parameters_sorted(operation):
                if not _is_camel_case(parameter.name):
                    yield (
                        f"services.{service.key}.operations.{operation.key}"
                        f".arguments.{parameter.key}",
                        f"Argument '{parameter.name}' is not camelCase.",
                    )


def _check_enum_value_naming(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Enum values should be UPPER_CASE (graphql-eslint ``EnumValueDefinition`` case rule)."""
    for api_type in _types_sorted(api):
        if api_type.kind is not TypeKind.ENUM:
            continue
        for value in _enum_values_sorted(api_type):
            if not _is_upper_case(value.name):
                yield (
                    f"types.{api_type.key}.values.{value.key}",
                    f"Enum value '{value.name}' on '{api_type.name}' is not UPPER_CASE.",
                )


def _check_enum_value_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every enum value should describe itself (graphql-eslint ``require-description``).

    The cross-format common pack covers type/field/operation/message descriptions but not enum
    values, so this fills that GraphQL-specific gap.
    """
    for api_type in _types_sorted(api):
        if api_type.kind is not TypeKind.ENUM:
            continue
        for value in _enum_values_sorted(api_type):
            if not _nonempty_str(value.description):
                yield (
                    f"types.{api_type.key}.values.{value.key}",
                    f"Enum value '{value.name}' on '{api_type.name}' is missing a description.",
                )


def _check_argument_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every operation argument should describe itself (graphql-eslint ``require-description``).

    The common pack does not lint operation parameters, so this covers GraphQL field arguments.
    """
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            for parameter in _parameters_sorted(operation):
                if not _nonempty_str(parameter.description):
                    yield (
                        f"services.{service.key}.operations.{operation.key}"
                        f".arguments.{parameter.key}",
                        f"Argument '{parameter.name}' on operation '{operation.name}' is "
                        "missing a description.",
                    )


def _check_require_deprecation_reason(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """A ``@deprecated`` entity should give a reason (graphql-eslint ``require-deprecation-reason``).

    The MFI-10.2 normalizer sets ``deprecated=True`` and stows ``@deprecated(reason:)`` under
    ``extras['deprecation_reason']``; a deprecated field / enum value / operation / argument with
    a blank reason is flagged, in deterministic ``(types…, services…)`` order. Note ``graphql-core``
    fills a bare ``@deprecated`` with the spec default reason (``"No longer supported"``), so over
    the normalized model this fires on an *explicitly empty* ``reason: ""`` — the authoritative
    bare-``@deprecated`` check is graphql-eslint's own rule (merged via :func:`eslint_findings`).
    """
    for api_type in _types_sorted(api):
        for field in _fields_sorted(api_type):
            if field.deprecated and not _nonempty_str(_deprecation_reason(field.extras)):
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' is @deprecated without a reason.",
                )
        if api_type.kind is TypeKind.ENUM:
            for value in _enum_values_sorted(api_type):
                if value.deprecated and not _nonempty_str(_deprecation_reason(value.extras)):
                    yield (
                        f"types.{api_type.key}.values.{value.key}",
                        f"Enum value '{value.name}' on '{api_type.name}' is @deprecated "
                        "without a reason.",
                    )
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            if operation.deprecated and not _nonempty_str(
                _deprecation_reason(operation.extras)
            ):
                yield (
                    f"services.{service.key}.operations.{operation.key}",
                    f"Operation '{operation.name}' is @deprecated without a reason.",
                )
            for parameter in _parameters_sorted(operation):
                if parameter.deprecated and not _nonempty_str(
                    _deprecation_reason(parameter.extras)
                ):
                    yield (
                        f"services.{service.key}.operations.{operation.key}"
                        f".arguments.{parameter.key}",
                        f"Argument '{parameter.name}' on operation '{operation.name}' is "
                        "@deprecated without a reason.",
                    )


# ===========================================================================
# Composition checks (Federation, IXH-7.6)
# ===========================================================================
#
# The ``composition`` lint dimension: deterministic checks over a federated
# subgraph set, each finding naming the offending subgraph. The per-subgraph
# SDL rides on ``CanonicalApi.raw["subgraphs"]`` (kept out of the fingerprint),
# so these rules simply no-op for non-federated artifacts and for models
# normalized with ``include_raw=False``. The ``rover supergraph compose``
# verdict captured at import time (``raw["composition"]``) surfaces through its
# own rule so the authoritative composer's errors merge into the same score.


def _raw_subgraph_sdls(api: CanonicalApi) -> Dict[str, str]:
    """The per-subgraph SDL map stowed by the IXH-7.6 normalizer, or ``{}``."""
    raw = api.raw or {}
    subgraphs = raw.get("subgraphs")
    if not isinstance(subgraphs, dict):
        return {}
    return {
        str(name): text for name, text in subgraphs.items() if isinstance(text, str)
    }


def _composition_findings_for(api: CanonicalApi, rule: str) -> Iterable[Tuple[str, str]]:
    """Findings of one pure composition check, in deterministic order."""
    subgraph_sdls = _raw_subgraph_sdls(api)
    if len(subgraph_sdls) < 2:
        return
    from .graphql_federation import check_composition

    for finding in check_composition(subgraph_sdls):
        if finding.rule == rule:
            yield (finding.path, finding.message)


def _check_composition_invalid_key(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """A ``@key(fields:)`` selection must name fields its type declares there."""
    yield from _composition_findings_for(api, "invalid-key")


def _check_composition_non_shareable(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """A field resolved by several subgraphs must be ``@shareable`` in each."""
    yield from _composition_findings_for(api, "non-shareable-field")


def _check_composition_unresolvable(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """``@requires``/``@provides`` selections must resolve against known fields."""
    yield from _composition_findings_for(api, "unresolvable-selection")


def _check_composition_rover(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Surface ``rover supergraph compose`` errors captured at import time."""
    raw = api.raw or {}
    entries = raw.get("composition")
    if not isinstance(entries, list):
        return
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        message = str(entry.get("message", "") or "").strip()
        if not message:
            continue
        subgraph = str(entry.get("subgraph", "") or "unknown")
        type_name = entry.get("type_name")
        field_name = entry.get("field_name")
        if type_name and field_name:
            path = f"types.{type_name}.fields.{type_name}.{field_name}"
        elif type_name:
            path = f"types.{type_name}"
        else:
            path = f"subgraphs.{subgraph}"
        yield (path, message)


# ===========================================================================
# The GraphQL native rule pack
# ===========================================================================


class GraphqlRulePack(RulePack, register=True):
    """Native, deterministic hygiene rules for GraphQL (graph) artifacts.

    Runs in addition to the always-on :class:`~app.lint_engine.CommonRulePack` whenever the
    canonical model's ``format`` is ``graphql`` (the key the MFI-10.2 normalizer emits). Pure
    over the model — no I/O, no Node — so it is safe on the always-on lint path even when the
    ``graphql-eslint`` CLI is unavailable; that linter's findings, when supplied, are merged in
    separately by :func:`lint_graphql_result`.
    """

    format = "graphql"
    pack_id = "graphql"

    #: Built once at class-definition time (the pack is stateless). Grouped by the three
    #: graphql-eslint configs they model; the engine re-sorts findings deterministically anyway.
    _RULES: Tuple[LintRule, ...] = (
        # --- naming-convention ---
        LintRule(
            rule_id="graphql.naming-type-pascal-case",
            category="naming",
            severity="warning",
            description="Type definitions should be PascalCase.",
            check=_check_type_naming,
        ),
        LintRule(
            rule_id="graphql.naming-field-camel-case",
            category="naming",
            severity="warning",
            description="Fields and operations should be camelCase.",
            check=_check_field_naming,
        ),
        LintRule(
            rule_id="graphql.naming-argument-camel-case",
            category="naming",
            severity="warning",
            description="Operation arguments should be camelCase.",
            check=_check_argument_naming,
        ),
        LintRule(
            rule_id="graphql.naming-enum-value-upper-case",
            category="naming",
            severity="warning",
            description="Enum values should be UPPER_CASE.",
            check=_check_enum_value_naming,
        ),
        # --- require-description (GraphQL-specific gaps the common pack misses) ---
        LintRule(
            rule_id="graphql.enum-value-missing-description",
            category="documentation",
            severity="info",
            description="Every enum value should describe itself.",
            check=_check_enum_value_missing_description,
        ),
        LintRule(
            rule_id="graphql.argument-missing-description",
            category="documentation",
            severity="info",
            description="Every operation argument should describe itself.",
            check=_check_argument_missing_description,
        ),
        # --- schema-recommended ---
        LintRule(
            rule_id="graphql.require-deprecation-reason",
            category="documentation",
            severity="warning",
            description="A @deprecated entity should carry a deprecation reason.",
            check=_check_require_deprecation_reason,
        ),
        # --- composition (Federation subgraph sets, IXH-7.6) ---
        LintRule(
            rule_id="graphql.composition-invalid-key",
            category="composition",
            severity="error",
            description="A @key(fields:) selection must name fields its type declares "
            "in that subgraph.",
            check=_check_composition_invalid_key,
        ),
        LintRule(
            rule_id="graphql.composition-non-shareable-field",
            category="composition",
            severity="error",
            description="A field resolved by more than one subgraph must be @shareable "
            "in every subgraph that resolves it.",
            check=_check_composition_non_shareable,
        ),
        LintRule(
            rule_id="graphql.composition-unresolvable-selection",
            category="composition",
            severity="error",
            description="A @requires/@provides selection must reference fields some "
            "subgraph declares.",
            check=_check_composition_unresolvable,
        ),
        LintRule(
            rule_id="graphql.composition-error",
            category="composition",
            severity="error",
            description="A composition error reported by `rover supergraph compose` "
            "over the imported subgraph set.",
            check=_check_composition_rover,
        ),
    )

    def rules(self) -> List[LintRule]:
        """Return the GraphQL native rules in deterministic execution order."""
        return list(self._RULES)


# ===========================================================================
# graphql-eslint output -> canonical findings
# ===========================================================================

#: Namespace every graphql-eslint-sourced finding's rule id lives under, so they group cleanly
#: against the ``graphql.*`` native rules and the ``common.*`` cross-format rules.
GRAPHQL_ESLINT_RULE_PREFIX = "graphql.eslint"

#: graphql-eslint rule ids are ESLint-plugin-namespaced (``@graphql-eslint/naming-convention``);
#: we strip this prefix before re-namespacing under :data:`GRAPHQL_ESLINT_RULE_PREFIX`.
GRAPHQL_ESLINT_PLUGIN_PREFIX = "@graphql-eslint/"

# ESLint reports two numeric severities (2 = error, 1 = warning); the canonical scorer recognizes
# three. Anything else (a 0 "off" leaking through, or a fatal parse message) folds to ``info`` so
# it still contributes — gently — to the score.
_ESLINT_SEVERITY: Dict[int, Severity] = {
    2: "error",
    1: "warning",
}


def _eslint_rule_id(raw_rule_id: Any) -> str:
    """Normalize a graphql-eslint ``ruleId`` into a namespaced canonical rule id.

    ``@graphql-eslint/naming-convention`` → ``graphql.eslint.naming-convention``. A ``None``
    rule id (an ESLint fatal/parse message has none) becomes ``graphql.eslint.fatal``.
    """
    rule = str(raw_rule_id).strip() if raw_rule_id is not None else ""
    if not rule:
        return f"{GRAPHQL_ESLINT_RULE_PREFIX}.fatal"
    if rule.startswith(GRAPHQL_ESLINT_PLUGIN_PREFIX):
        rule = rule[len(GRAPHQL_ESLINT_PLUGIN_PREFIX):]
    return f"{GRAPHQL_ESLINT_RULE_PREFIX}.{rule}"


def _eslint_path(file_path: str, message: Dict[str, Any]) -> str:
    """Build a stable finding path from a graphql-eslint message's file + line/column."""
    base = file_path.strip() if isinstance(file_path, str) and file_path.strip() else "(sdl)"
    line = message.get("line")
    column = message.get("column")
    if isinstance(line, int):
        if isinstance(column, int):
            return f"{base}:{line}:{column}"
        return f"{base}:{line}"
    return base


def eslint_findings(report: Any) -> List[LintFinding]:
    """Map ``graphql-eslint`` ESLint JSON output into canonical :class:`LintFinding`\\s.

    ``graphql-eslint`` runs through ESLint, whose JSON formatter emits a list of *file result*
    objects — ``{"filePath": str, "messages": [{"ruleId", "severity", "message", "line",
    "column"}, …]}``. Each message becomes one finding whose ``rule`` is the plugin rule id
    re-namespaced ``graphql.eslint.<rule>`` (so it merges into the score and groups with the
    native rules), with the ESLint numeric severity folded to ``error``/``warning``/``info``.

    Args:
        report: The parsed ``graphql-eslint`` output — an iterable of file-result mappings (or a
            single such mapping). Anything falsy (``None``, ``[]``) yields no findings, so the
            report degrades gracefully to the native + common packs.

    Returns:
        One :class:`LintFinding` per ESLint message. The list preserves input order; the engine
        re-sorts deterministically.
    """
    findings: List[LintFinding] = []
    for file_result in _iter_file_results(report):
        if not isinstance(file_result, dict):
            continue
        file_path = file_result.get("filePath", "")
        for message in file_result.get("messages", []) or []:
            if not isinstance(message, dict):
                continue
            raw_severity = message.get("severity")
            severity = _ESLINT_SEVERITY.get(
                raw_severity if isinstance(raw_severity, int) else -1, "info"
            )
            findings.append(
                LintFinding(
                    path=_eslint_path(file_path, message),
                    category="graphql-eslint",
                    rule=_eslint_rule_id(message.get("ruleId")),
                    severity=severity,
                    message=str(message.get("message", "") or ""),
                )
            )
    return findings


def _iter_file_results(report: Any) -> Iterable[Any]:
    """Yield each ESLint file-result mapping from a report that is a list or a single mapping."""
    if not report:
        return
    if isinstance(report, dict):
        yield report
        return
    if isinstance(report, (str, bytes)):
        return
    try:
        yield from report
    except TypeError:
        return


# ===========================================================================
# Merge entry points
# ===========================================================================


def lint_graphql_result(
    model: CanonicalApi,
    eslint_report: Any = None,
) -> LintResult:
    """Lint a GraphQL model, merging ``graphql-eslint`` findings into the score when available.

    Combines three sources through the shared engine so the score, grade, and
    ``report_fingerprint`` use the exact same formula as every other format:

    * the always-on :class:`~app.lint_engine.CommonRulePack` (cross-format hygiene),
    * the registered :class:`GraphqlRulePack` (native GraphQL rules), looked up by the model's
      ``graphql`` format, and
    * the ``graphql-eslint`` ESLint output in ``eslint_report`` (supplied by the MFI-4.3
      external-linter adapter), if any.

    Args:
        model: The canonical GraphQL artifact (from the MFI-10.2 normalizer). Not mutated.
        eslint_report: Optional parsed ``graphql-eslint`` output (see :func:`eslint_findings`).
            When ``None`` / empty, the external linter contributes nothing and the report
            degrades gracefully to the native + common packs.

    Returns:
        A deterministic :class:`~app.schema_lint.LintResult`.
    """
    return lint_canonical_model(model, extra_findings=eslint_findings(eslint_report))


def lint_graphql(
    raw: str,
    *,
    source_label: Optional[str] = None,
    eslint_report: Any = None,
) -> LintResult:
    """Parse, normalize, and lint raw GraphQL SDL end-to-end.

    A convenience that ties MFI-10.1 (parse + build schema) and MFI-10.2 (normalize) to this
    pack: it builds the schema from ``raw`` SDL, normalizes it into the canonical model, then
    lints via :func:`lint_graphql_result`. The MFI-10.5/10.6 import pipeline, which already
    holds the normalized model, calls :func:`lint_graphql_result` directly instead.

    Args:
        raw: The raw GraphQL SDL source text.
        source_label: Optional file label used in parse-error diagnostics.
        eslint_report: Optional ``graphql-eslint`` output to merge (see :func:`eslint_findings`).

    Returns:
        A deterministic :class:`~app.schema_lint.LintResult`.

    Raises:
        app.graphql_parser.GraphQlParseError: If ``raw`` is not valid SDL (no schema to lint).
    """
    # Imported lazily so importing this pack (e.g. for native-rule registration on the always-on
    # lint path) never pulls in the parser/normalizer machinery.
    from .graphql_normalizer import GraphQlNormalizer
    from .graphql_parser import build_graphql_schema

    schema = build_graphql_schema(raw, source_label=source_label)
    model = GraphQlNormalizer().normalize(schema)
    return lint_graphql_result(model, eslint_report)
