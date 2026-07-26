"""
Deterministic quality-scoring / linting engine over a generated OpenAPI document.

The engine walks the reconstructed OpenAPI/JSON-Schema for a project version and emits an
itemized, deterministic set of findings together with a numeric score (0-100) and an A-F
letter grade. It powers the real ``GET .../lint`` service that replaces the old client-side
(localStorage) quality score (#3609).

Design goals:

* **Deterministic** — the same input spec always produces the same findings, score, grade,
  and ``report_fingerprint``. Findings are sorted by ``(path, rule, id)`` and every finding id
  is a stable hash of ``path|rule|message``.
* **Pure** — no database or network access; callers pass a fully reconstructed spec dict.
* **Composable** — breaking-change findings from :mod:`app.compatibility_engine` can be merged
  in via :func:`merge_compatibility_findings` so the lint report can surface API-evolution risk.

Rule groups:

* ``naming``     — component schema names should be PascalCase; property names camelCase/snake_case.
* ``documentation`` — schemas/operations missing descriptions; leaf properties missing examples.
* ``structure``  — arrays without ``maxItems`` (unbounded collections).
* ``compatibility`` — breaking / unknown findings relative to a base revision (when supplied).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

# --- Severity model -------------------------------------------------------------------------

Severity = str  # "error" | "warning" | "info"

#: Score penalty applied per finding of each severity before per-rule capping.
SEVERITY_PENALTY: Mapping[str, float] = {
    "error": 10.0,
    "warning": 4.0,
    "info": 1.0,
}

#: Maximum total penalty a single rule may contribute, so one noisy rule cannot tank the
#: whole score on its own (keeps the grade meaningful for large specs).
PER_RULE_PENALTY_CAP: float = 20.0

#: Letter-grade thresholds, evaluated high-to-low.
GRADE_THRESHOLDS: Tuple[Tuple[int, str], ...] = (
    (90, "A"),
    (80, "B"),
    (70, "C"),
    (60, "D"),
    (0, "F"),
)

# --- Naming conventions ---------------------------------------------------------------------

_PASCAL_CASE = re.compile(r"^[A-Z][A-Za-z0-9]*$")
_CAMEL_CASE = re.compile(r"^[a-z][A-Za-z0-9]*$")
_SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")

#: Scalar JSON Schema types whose leaf properties are expected to carry an example.
_SCALAR_TYPES = frozenset({"string", "number", "integer", "boolean"})


def _schema_type_set(schema: Mapping[str, Any]) -> frozenset:
    """Normalize a schema's ``type`` to a set of type-name strings.

    OpenAPI 3.1 / JSON Schema 2020-12 allow ``type`` to be a list (a union such as
    ``["string", "null"]``); OpenAPI 3.0 uses a single string. Returns an empty set
    when ``type`` is absent or not a string/list, so membership tests stay list-safe
    (a raw list value is unhashable and crashes ``x in _SCALAR_TYPES``).
    """
    raw = schema.get("type")
    if isinstance(raw, str):
        return frozenset((raw,))
    if isinstance(raw, list):
        return frozenset(item for item in raw if isinstance(item, str))
    return frozenset()


def _is_pascal_case(name: str) -> bool:
    return bool(_PASCAL_CASE.match(name))


def _is_property_name_ok(name: str) -> bool:
    """Property names are acceptable in either camelCase or snake_case."""
    return bool(_CAMEL_CASE.match(name) or _SNAKE_CASE.match(name))


@dataclass(frozen=True)
class LintFinding:
    """One itemized lint result. ``id`` is a stable hash of ``path|rule|message``."""

    path: str
    category: str
    rule: str
    severity: Severity
    message: str
    id: str = field(default="", compare=True)

    def __post_init__(self) -> None:
        if not self.id:
            digest = hashlib.sha256(
                f"{self.path}|{self.rule}|{self.message}".encode("utf-8")
            ).hexdigest()[:16]
            object.__setattr__(self, "id", f"lint-{digest}")

    def as_dict(self) -> Dict[str, str]:
        return {
            "id": self.id,
            "path": self.path,
            "category": self.category,
            "rule": self.rule,
            "severity": self.severity,
            "message": self.message,
        }


@dataclass(frozen=True)
class LintCategoryScore:
    """A per-category 0-100 rollup score (MFI-25.6, #4091).

    ``score`` is the same capped-penalty formula the overall score uses, restricted to the findings
    in this ``name`` category — so a category with no findings scores 100 and a noisy one scores low,
    letting the UI drive per-category bars with real values instead of a severity tally.
    """

    name: str
    score: int

    def as_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "score": self.score}


@dataclass(frozen=True)
class LintResult:
    """Engine output suitable for APIs, CLI rendering, and audit payloads."""

    score: int
    grade: str
    findings: Tuple[LintFinding, ...]
    rule_hits: Mapping[str, int]
    severity_counts: Mapping[str, int]
    report_fingerprint: str
    #: Per-category 0-100 rollup scores (MFI-25.6), sorted by category name. Empty when the caller
    #: supplies no baseline categories and there are no findings.
    categories: Tuple[LintCategoryScore, ...] = ()

    def finding_dicts(self) -> List[Dict[str, str]]:
        return [f.as_dict() for f in self.findings]

    def category_dicts(self) -> List[Dict[str, Any]]:
        return [c.as_dict() for c in self.categories]

    def report_dict(self) -> Dict[str, Any]:
        """Return the full scoring report as a JSON-ready dict for ``versions.quality_report``."""
        return {
            "score": self.score,
            "grade": self.grade,
            "report_fingerprint": self.report_fingerprint,
            "rule_hits": dict(self.rule_hits),
            "severity_counts": dict(self.severity_counts),
            "findings": self.finding_dicts(),
            "categories": self.category_dicts(),
        }


# --- Rule catalogue -------------------------------------------------------------------------
# Each rule maps to (category, severity, rationale). Centralised so the engine, the rule-catalog
# registry (GOV-1.2, :mod:`app.lint_rule_registry`), and the API stay in sync.
#
# Rule ids are **stable identifiers**: they form each finding's ``rule`` field and are hashed
# into finding ids and the ``report_fingerprint``, so they must not change once shipped
# (a rename would flag every captured score stale).

#: Rule id -> (category, default severity, one-line rationale) for the OpenAPI spec linter.
#: The single source of truth this module and the GOV-1.2 rule registry both read.
OPENAPI_RULES: Mapping[str, Tuple[str, Severity, str]] = {
    "naming.schema-pascal-case": (
        "naming",
        "warning",
        "Component schema names should be PascalCase so generated client types are idiomatic.",
    ),
    "naming.property-name": (
        "naming",
        "warning",
        "Property names should be camelCase or snake_case for predictable client bindings.",
    ),
    "documentation.schema-missing-description": (
        "documentation",
        "warning",
        "A schema without a description forces consumers to guess what it models.",
    ),
    "documentation.property-missing-description": (
        "documentation",
        "info",
        "Every property should describe what it holds.",
    ),
    "documentation.property-missing-example": (
        "documentation",
        "info",
        "Scalar leaf properties should carry an example so docs and mocks stay realistic.",
    ),
    "documentation.operation-missing-summary": (
        "documentation",
        "warning",
        "An operation needs a summary or description to produce usable reference docs.",
    ),
    "documentation.info-missing-description": (
        "documentation",
        "info",
        "The API info block should describe what the API is for.",
    ),
    "structure.unbounded-array": (
        "structure",
        "warning",
        "An array without maxItems permits unbounded payloads that strain clients and servers.",
    ),
    "compatibility.breaking": (
        "compatibility",
        "error",
        "A change relative to the base revision breaks existing consumers.",
    ),
    "compatibility.unknown": (
        "compatibility",
        "warning",
        "A change relative to the base revision has an unclassified compatibility impact.",
    ),
}

#: Rule id -> (category, severity), derived from :data:`OPENAPI_RULES` for the engine's
#: hot path (:func:`_make_finding`) and for existing consumers of the two-tuple shape.
RULE_CATALOGUE: Mapping[str, Tuple[str, Severity]] = {
    rule_id: (category, severity)
    for rule_id, (category, severity, _rationale) in OPENAPI_RULES.items()
}


#: Categories the in-spec OpenAPI/JSON-Schema linter evaluates on *every* run (naming, documentation,
#: structure) — always surfaced in the category rollup so their bars render even at a clean 100.
#: ``compatibility`` is intentionally excluded: it is only evaluated against a base revision, so it
#: appears in the rollup only when a comparison actually produced compatibility findings (rather than
#: a misleading 100 for a check that never ran).
IN_SPEC_LINT_CATEGORIES: Tuple[str, ...] = tuple(
    sorted({cat for cat, _sev in RULE_CATALOGUE.values() if cat != "compatibility"})
)


def _make_finding(path: str, rule: str, message: str) -> LintFinding:
    category, severity = RULE_CATALOGUE[rule]
    return LintFinding(path=path, category=category, rule=rule, severity=severity, message=message)


def _has_example(schema: Mapping[str, Any]) -> bool:
    """True when the schema carries an ``example`` or non-empty ``examples`` (OAS 3.0/3.1)."""
    if "example" in schema:
        return True
    examples = schema.get("examples")
    if isinstance(examples, list):
        return len(examples) > 0
    if isinstance(examples, dict):
        return len(examples) > 0
    return False


def _is_ref_only(schema: Mapping[str, Any]) -> bool:
    """A pure ``$ref`` node carries no place for description/example, so skip those checks."""
    return "$ref" in schema and "type" not in schema and "properties" not in schema


def _walk_property(
    name: str,
    schema: Any,
    path: str,
    findings: List[LintFinding],
) -> None:
    """Recursively lint a single property schema (and its nested object/array members)."""
    if not isinstance(schema, dict):
        return

    # Naming: property keys should be camelCase or snake_case.
    if not _is_property_name_ok(name):
        findings.append(
            _make_finding(
                path,
                "naming.property-name",
                f"Property '{name}' is not camelCase or snake_case.",
            )
        )

    ref_only = _is_ref_only(schema)
    # `type` may be a string (OpenAPI 3.0) or a list (3.1 / JSON Schema union, e.g.
    # ["string", "null"]); normalize to a set so checks are list-safe.
    schema_types = _schema_type_set(schema)
    non_null_types = schema_types - {"null"}
    is_array = "array" in schema_types
    type_label = "/".join(sorted(schema_types)) if schema_types else str(schema.get("type"))

    if not ref_only:
        # Documentation: every property should describe itself.
        if not _nonempty_str(schema.get("description")):
            findings.append(
                _make_finding(
                    path,
                    "documentation.property-missing-description",
                    f"Property '{name}' is missing a description.",
                )
            )
        # Documentation: leaf scalar properties should carry an example. A nullable
        # scalar (e.g. ["string","null"]) still counts; a union with a non-scalar does not.
        if non_null_types and non_null_types <= _SCALAR_TYPES and not _has_example(schema):
            findings.append(
                _make_finding(
                    path,
                    "documentation.property-missing-example",
                    f"Property '{name}' ({type_label}) is missing an example.",
                )
            )

    # Structure: arrays must bound their size.
    if is_array and "maxItems" not in schema:
        findings.append(
            _make_finding(
                path,
                "structure.unbounded-array",
                f"Array property '{name}' has no maxItems (unbounded collection).",
            )
        )

    # Recurse into nested object properties.
    nested = schema.get("properties")
    if isinstance(nested, dict):
        for child_name in sorted(nested.keys()):
            _walk_property(
                child_name,
                nested[child_name],
                f"{path}.properties.{child_name}",
                findings,
            )

    # Recurse into array item schemas.
    if is_array:
        items = schema.get("items")
        if isinstance(items, dict):
            item_props = items.get("properties")
            if isinstance(item_props, dict):
                for child_name in sorted(item_props.keys()):
                    _walk_property(
                        child_name,
                        item_props[child_name],
                        f"{path}.items.properties.{child_name}",
                        findings,
                    )


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _lint_schemas(spec: Mapping[str, Any], findings: List[LintFinding]) -> None:
    components = spec.get("components")
    schemas = components.get("schemas") if isinstance(components, dict) else None
    if not isinstance(schemas, dict):
        return
    for schema_name in sorted(schemas.keys()):
        schema = schemas[schema_name]
        base_path = f"components.schemas.{schema_name}"
        if not _is_pascal_case(schema_name):
            findings.append(
                _make_finding(
                    base_path,
                    "naming.schema-pascal-case",
                    f"Schema '{schema_name}' is not PascalCase.",
                )
            )
        if isinstance(schema, dict):
            if not _nonempty_str(schema.get("description")):
                findings.append(
                    _make_finding(
                        base_path,
                        "documentation.schema-missing-description",
                        f"Schema '{schema_name}' is missing a description.",
                    )
                )
            props = schema.get("properties")
            if isinstance(props, dict):
                for prop_name in sorted(props.keys()):
                    _walk_property(
                        prop_name,
                        props[prop_name],
                        f"{base_path}.properties.{prop_name}",
                        findings,
                    )


def _lint_operations(spec: Mapping[str, Any], findings: List[LintFinding]) -> None:
    paths = spec.get("paths")
    if not isinstance(paths, dict):
        return
    http_methods = ("get", "put", "post", "delete", "patch", "options", "head", "trace")
    for path_name in sorted(paths.keys()):
        path_item = paths[path_name]
        if not isinstance(path_item, dict):
            continue
        for method in http_methods:
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            if not _nonempty_str(operation.get("summary")) and not _nonempty_str(
                operation.get("description")
            ):
                findings.append(
                    _make_finding(
                        f"paths.{path_name}.{method}",
                        "documentation.operation-missing-summary",
                        f"Operation {method.upper()} {path_name} has no summary or description.",
                    )
                )


def _lint_info(spec: Mapping[str, Any], findings: List[LintFinding]) -> None:
    info = spec.get("info")
    description = info.get("description") if isinstance(info, dict) else None
    if not _nonempty_str(description):
        findings.append(
            _make_finding(
                "info",
                "documentation.info-missing-description",
                "API info block is missing a description.",
            )
        )


def _report_fingerprint(score: int, grade: str, finding_dicts: List[Dict[str, str]]) -> str:
    """Stable hash over score, grade, and sorted findings for audit / API identity."""
    payload = {
        "score": score,
        "grade": grade,
        "findings": sorted(
            finding_dicts,
            key=lambda x: (x.get("path", ""), x.get("rule", ""), x.get("id", "")),
        ),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _grade_for_score(score: int) -> str:
    for threshold, grade in GRADE_THRESHOLDS:
        if score >= threshold:
            return grade
    return "F"


def _score_from_findings(findings: List[LintFinding]) -> int:
    """Deterministic 0-100 score: 100 minus capped per-rule severity penalties."""
    penalty_by_rule: Dict[str, float] = {}
    for finding in findings:
        weight = SEVERITY_PENALTY.get(finding.severity, 0.0)
        penalty_by_rule[finding.rule] = penalty_by_rule.get(finding.rule, 0.0) + weight
    total_penalty = sum(min(p, PER_RULE_PENALTY_CAP) for p in penalty_by_rule.values())
    return max(0, min(100, round(100.0 - total_penalty)))


def _category_scores(
    findings: List[LintFinding], base_categories: Sequence[str] = ()
) -> Tuple[LintCategoryScore, ...]:
    """Roll up a deterministic 0-100 score per category (MFI-25.6, #4091).

    Each category's score reuses the overall :func:`_score_from_findings` formula (100 minus capped
    per-rule severity penalties) over *only* that category's findings, so it is directly comparable
    to the headline score. The reported categories are the union of every category that has a finding
    and any ``base_categories`` the caller always wants surfaced (which score 100 when clean, so the
    UI can render a stable set of bars). Sorted by category name for a stable, deterministic payload.

    :param findings: all findings (any order; not mutated).
    :param base_categories: categories to always include even with no findings (e.g. the in-spec
        OpenAPI categories that are evaluated on every run).
    :returns: the per-category scores, sorted by name.
    """
    by_category: Dict[str, List[LintFinding]] = {}
    for finding in findings:
        by_category.setdefault(finding.category, []).append(finding)
    names = set(by_category) | set(base_categories)
    return tuple(
        LintCategoryScore(name=name, score=_score_from_findings(by_category.get(name, [])))
        for name in sorted(names)
    )


def _rule_hits(findings: List[LintFinding]) -> Dict[str, int]:
    hits: Dict[str, int] = {}
    for finding in findings:
        hits[finding.rule] = hits.get(finding.rule, 0) + 1
    return dict(sorted(hits.items()))


def _severity_counts(findings: List[LintFinding]) -> Dict[str, int]:
    counts = {"error": 0, "warning": 0, "info": 0}
    for finding in findings:
        if finding.severity in counts:
            counts[finding.severity] += 1
    return counts


def assemble_lint_result(
    findings: List[LintFinding], base_categories: Sequence[str] = ()
) -> LintResult:
    """Assemble a deterministic :class:`LintResult` from an unordered finding list.

    This is the shared tail of every linter (the OpenAPI spec linter below and the
    canonical-model rule-pack engine in :mod:`app.lint_engine`): it sorts the findings
    into a stable order, computes the capped 0-100 score and its letter grade, tallies
    rule hits and severities, rolls up per-category scores (MFI-25.6), and hashes a stable
    ``report_fingerprint``. Centralising it keeps the score/grade/fingerprint formula identical
    across every format so two linters over the same defects always agree.

    :param findings: the findings to roll up (any order; not mutated).
    :param base_categories: categories always surfaced in the per-category rollup even with no
        findings (score 100), so a linter with a fixed category set gets stable bars.
    :returns: score, grade, sorted findings, rule hits, severity counts, category scores, fingerprint.
    """
    # Deterministic ordering: by path, then rule, then stable id. Sort a copy so the
    # caller's list is left untouched (purity for callers that reuse their finding list).
    ordered = sorted(findings, key=lambda f: (f.path, f.rule, f.id))

    score = _score_from_findings(ordered)
    grade = _grade_for_score(score)
    finding_dicts = [f.as_dict() for f in ordered]
    fingerprint = _report_fingerprint(score, grade, finding_dicts)

    return LintResult(
        score=score,
        grade=grade,
        findings=tuple(ordered),
        rule_hits=_rule_hits(ordered),
        severity_counts=_severity_counts(ordered),
        report_fingerprint=fingerprint,
        categories=_category_scores(ordered, base_categories=base_categories),
    )


def _example_conformance_findings(spec: Mapping[str, Any]) -> List[LintFinding]:
    """Run the IXH-5.4 example-conformance rule over a native OpenAPI document.

    The OpenAPI adapter overrides :meth:`app.import_source.ImportSource.lint` to lint the native
    document here rather than through the canonical engine, so the pack that runs
    unconditionally in :func:`app.lint_engine.lint_canonical_model` would otherwise never see an
    OpenAPI revision. Calling it here gives both paths the same rule id and severity.

    Imported inside the function because :mod:`app.example_conformance_lint` imports this module
    for :class:`LintFinding` — the cycle is broken by deferring to call time, matching how the
    other cross-module lint hooks here are wired.

    Args:
        spec: The OpenAPI (or Swagger 2) document being linted.

    Returns:
        One finding per non-conforming example; empty when the document carries none.
    """
    from .example_conformance_lint import example_conformance_findings

    return example_conformance_findings(spec)


def lint_openapi_spec(
    spec: Mapping[str, Any],
    extra_findings: Optional[List[LintFinding]] = None,
) -> LintResult:
    """
    Lint a reconstructed OpenAPI document and return a deterministic :class:`LintResult`.

    :param spec: the OpenAPI/JSON-Schema document (as produced by ``generate_openapi_spec``).
    :param extra_findings: optional pre-built findings (e.g. compatibility breaking flags) to
        merge into the report and the score.
    :returns: score, grade, sorted findings, rule hits, severity counts, and a stable fingerprint.
    """
    findings: List[LintFinding] = list(extra_findings or [])
    _lint_info(spec, findings)
    _lint_schemas(spec, findings)
    _lint_operations(spec, findings)
    findings.extend(_example_conformance_findings(spec))

    # Always surface the in-spec categories (naming/documentation/structure) so the UI's category
    # bars render even when a category is clean (100); compatibility joins only when it has findings.
    return assemble_lint_result(findings, base_categories=IN_SPEC_LINT_CATEGORIES)


def merge_compatibility_findings(compat_findings: Any) -> List[LintFinding]:
    """
    Translate :class:`app.schema_compatibility.CompatibilityFinding` items into lint findings.

    ``breaking`` findings become ``compatibility.breaking`` (error severity); ``unknown``
    findings become ``compatibility.unknown`` (warning). ``safe`` findings are not surfaced as
    lint findings (they are not quality defects).
    """
    out: List[LintFinding] = []
    for f in compat_findings or []:
        category = getattr(f, "category", None)
        path = getattr(f, "path", "") or ""
        message = getattr(f, "message", "") or ""
        if category == "breaking":
            out.append(_make_finding(path, "compatibility.breaking", message))
        elif category == "unknown":
            out.append(_make_finding(path, "compatibility.unknown", message))
    return out
