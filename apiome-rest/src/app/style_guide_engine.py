"""
Style-guide engine integration & score mapping — GOV-1.4 (#4430).

GOV-1.1 (#4427) stored guides, GOV-1.2 (#4428) registered the built-in rule catalog, and
GOV-1.3 (#4429) validated custom rule definitions — but nothing *applied* any of it: every
lint entry point (editor lint, catalog lint, import scoring, publish check) still scored
against the hard-wired defaults. This module closes that loop:

* **Resolution** — :func:`resolve_style_guide` walks the assignment chain
  **project → tenant → tenant default**, exactly as the V159 schema intends. A tenant with
  no guides at all (created before its builtin guide is seeded, or a DB fault) falls back
  to the in-code "Apiome Recommended" guide built from the GOV-1.2 registry, which mirrors
  the shipped defaults — so lint never breaks and never silently changes score.
* **Compilation & caching** — guide rows are compiled into a :class:`CompiledStyleGuide`
  (enabled-rule severity map + validated custom rules). Compilation is the expensive part
  (custom-def validation, regex/JSONPath compile behind it), so it is memoized with
  :func:`functools.lru_cache` keyed on a *content hash* of the rows: edits change the key,
  so the cache needs no invalidation hooks.
* **Application** — :meth:`CompiledStyleGuide.apply` post-processes an engine
  :class:`~app.schema_lint.LintResult`: findings for registry rules the guide disables (or
  does not list) are dropped, severities are remapped to the guide's, findings from rules
  outside the registry (external-tool extras) pass through ungoverned, custom rules are
  evaluated against the raw document, and the result is re-assembled through
  :func:`~app.schema_lint.assemble_lint_result` — so the severity-weighted score formula
  (error ≫ warning ≫ info, per-rule capped) and A–F grade mapping stay *identical* across
  every entry point. Under the default guide the output is byte-for-byte what the engines
  produce today, which is what keeps the regression corpus stable.

Everything here is deliberately **best-effort at the edges**: a lint run must never fail
because guide resolution failed — it degrades to the built-in defaults and logs.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, replace
from functools import lru_cache
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .custom_rule_dsl import (
    CustomRule,
    CustomRuleSet,
    CustomRuleValidationError,
    evaluate_custom_rules,
    validate_custom_definition,
)
from .lint_rule_registry import builtin_rule_descriptors, builtin_rule_ids
from .schema_lint import LintFinding, LintResult, assemble_lint_result, lint_openapi_spec

logger = logging.getLogger(__name__)

__all__ = [
    "CompiledStyleGuide",
    "FALLBACK_GUIDE_SOURCE",
    "builtin_fallback_guide",
    "compile_style_guide",
    "resolve_style_guide",
    "rules_content_fingerprint",
    "guided_lint_openapi_spec",
    "apply_style_guide_to_lint_report",
]

#: ``source`` value of the in-code fallback guide (DB guides are ``builtin`` | ``custom``).
FALLBACK_GUIDE_SOURCE = "fallback"

#: Name shared by the seeded builtin guide (V159) and the in-code fallback.
FALLBACK_GUIDE_NAME = "Apiome Recommended"

#: Size of the compiled-guide cache. Keys are content hashes of a guide's rule rows, so one
#: entry per *distinct guide content* across all tenants; 128 comfortably covers the working
#: set of a node while bounding memory.
_COMPILED_GUIDE_CACHE_SIZE = 128


@dataclass(frozen=True)
class CompiledStyleGuide:
    """A resolved, ready-to-apply style guide.

    Attributes:
        guide_id: The ``style_guides.id`` this was compiled from, or ``None`` for the
            in-code fallback guide.
        name: The guide's display name.
        source: ``builtin`` | ``custom`` (DB guides) or ``fallback`` (in-code defaults).
        rule_severities: rule id -> severity for every **enabled** built-in rule. A finding
            for a *registered* rule absent from this mapping is dropped by :meth:`apply` —
            a guide governs exactly the registry rules it enables. Findings from rules the
            registry does not know (external-tool extras such as eslint/buf merged in via
            ``extra_findings``) pass through unchanged: a guide cannot govern rules it
            cannot list.
        custom_rules: The guide's validated custom rules (GOV-1.3), evaluated against the
            raw document when one is available. Empty for the builtin/fallback guides.
        custom_rule_errors: rule id -> reason for stored custom definitions that failed
            re-validation and were skipped (never fails the lint).
        fingerprint: Stable content hash of the compiled rows; changes whenever the guide's
            effective rule set changes (used as the compilation cache key).
    """

    guide_id: Optional[str]
    name: str
    source: str
    rule_severities: Mapping[str, str]
    custom_rules: CustomRuleSet
    custom_rule_errors: Mapping[str, str]
    fingerprint: str

    def is_enabled(self, rule_id: str) -> bool:
        """Return whether this guide enables the given built-in rule id."""
        return rule_id in self.rule_severities

    def severity_for(self, rule_id: str) -> Optional[str]:
        """Return the severity this guide assigns ``rule_id``, or ``None`` when disabled."""
        return self.rule_severities.get(rule_id)

    def apply(
        self,
        result: LintResult,
        document: Optional[Mapping[str, Any]] = None,
    ) -> LintResult:
        """Re-score an engine result under this guide.

        Findings for registered rules the guide does not enable are dropped; enabled ones
        have their severity remapped to the guide's (finding ids are severity-independent,
        so a remapped finding keeps its stable id); findings from rules outside the GOV-1.2
        registry (external-tool extras) pass through untouched. When ``document`` is given
        and the guide carries custom rules, those are evaluated and their findings merged.
        The filtered finding list is re-assembled through
        :func:`~app.schema_lint.assemble_lint_result`, so score, grade, category rollups
        and fingerprint all follow the one shared severity-weighted formula.

        Args:
            result: The engine output (:func:`~app.schema_lint.lint_openapi_spec` or
                :func:`~app.lint_engine.lint_canonical_model`).
            document: The raw JSON document the result was computed from, for custom-rule
                (JSONPath) evaluation. ``None`` skips custom rules — canonical-model lint
                paths without a JSON document still get enable/disable + severity overrides.

        Returns:
            A new :class:`~app.schema_lint.LintResult` scored under this guide.
        """
        registered = _builtin_registry_ids()
        findings: List[LintFinding] = []
        for finding in result.findings:
            severity = self.rule_severities.get(finding.rule)
            if severity is None:
                if finding.rule in registered:
                    continue  # a registry rule this guide disabled or omitted
                findings.append(finding)  # ungovernable external finding: pass through
            elif finding.severity == severity:
                findings.append(finding)
            else:
                findings.append(replace(finding, severity=severity))

        if document is not None and self.custom_rules.rules:
            evaluation = evaluate_custom_rules(self.custom_rules, document)
            findings.extend(evaluation.findings)
            for rule_id, reason in evaluation.rule_errors.items():
                logger.warning(
                    "Custom rule %r of style guide %s aborted: %s",
                    rule_id,
                    self.guide_id or self.name,
                    reason,
                )

        # Preserve the entry point's always-on category bars (e.g. naming/documentation/
        # structure for OpenAPI): the categories the base result surfaced stay surfaced.
        base_categories = tuple(c.name for c in result.categories)
        return assemble_lint_result(findings, base_categories=base_categories)


@lru_cache(maxsize=1)
def _builtin_category_by_rule() -> Mapping[str, str]:
    """rule id -> category for every registered built-in rule (GOV-1.2 registry)."""
    return {d.rule_id: d.category for d in builtin_rule_descriptors()}


@lru_cache(maxsize=1)
def _builtin_registry_ids() -> frozenset:
    """Every registered built-in rule id — the set a guide is able to govern."""
    return frozenset(builtin_rule_ids())


@lru_cache(maxsize=1)
def builtin_fallback_guide() -> CompiledStyleGuide:
    """The in-code "Apiome Recommended" guide: every built-in rule at its default severity.

    Mirrors the V159-seeded builtin guide (which itself mirrors the shipped rule packs), so
    applying it to any engine result is a no-op on score and findings. Used whenever a
    tenant has no resolvable guide or resolution fails — lint behaviour is then exactly
    what it was before GOV-1.4.
    """
    rows = tuple(
        {"rule_id": d.rule_id, "enabled": True, "severity": d.default_severity, "custom_def": None}
        for d in builtin_rule_descriptors()
    )
    return compile_style_guide(None, FALLBACK_GUIDE_NAME, FALLBACK_GUIDE_SOURCE, rows)


def _rows_cache_key(rows: Sequence[Mapping[str, Any]]) -> str:
    """Canonical JSON for a guide's rule rows — the content-addressed compile-cache key."""
    canonical = [
        {
            "rule_id": str(row.get("rule_id") or ""),
            "enabled": bool(row.get("enabled")),
            "severity": str(row.get("severity") or ""),
            "custom_def": row.get("custom_def"),
        }
        for row in rows
    ]
    canonical.sort(key=lambda r: r["rule_id"])
    return json.dumps(canonical, sort_keys=True, separators=(",", ":"))


def rules_content_fingerprint(rows: Sequence[Mapping[str, Any]]) -> str:
    """Return the content fingerprint of a guide's rule rows.

    The **one** definition of "what this guide's rules are": SHA-256 over the canonical JSON
    of the rows (sorted by rule id, sorted keys, no separator whitespace). It is exactly the
    fingerprint :func:`compile_style_guide` stamps on a :class:`CompiledStyleGuide`, so a
    stored guide revision (GOV-1.6) whose ``content_fingerprint`` matches a compiled guide's
    ``fingerprint`` is provably the same ruleset — which is how a lint result pins itself to
    the revision that produced it.

    Args:
        rows: ``style_guide_rules`` rows as mappings with ``rule_id`` / ``enabled`` /
            ``severity`` / ``custom_def`` keys. Order is irrelevant.

    Returns:
        The 64-character lowercase hex digest.
    """
    return hashlib.sha256(_rows_cache_key(rows).encode("utf-8")).hexdigest()


def compile_style_guide(
    guide_id: Optional[str],
    name: str,
    source: str,
    rows: Sequence[Mapping[str, Any]],
) -> CompiledStyleGuide:
    """Compile a guide's rule rows into a :class:`CompiledStyleGuide` (cached).

    Args:
        guide_id: The ``style_guides.id`` (``None`` for the in-code fallback).
        name: The guide's display name.
        source: ``builtin`` | ``custom`` | ``fallback``.
        rows: ``style_guide_rules`` rows as mappings with ``rule_id`` / ``enabled`` /
            ``severity`` / ``custom_def`` keys.

    Returns:
        The compiled guide. Identical row content always returns the same cached object.
    """
    return _compile_cached(guide_id, name, source, _rows_cache_key(rows))


@lru_cache(maxsize=_COMPILED_GUIDE_CACHE_SIZE)
def _compile_cached(
    guide_id: Optional[str], name: str, source: str, rows_key: str
) -> CompiledStyleGuide:
    """Content-addressed compile: ``rows_key`` is the canonical JSON of the rule rows.

    Keying on content (not just the guide id) makes cache invalidation automatic — editing
    a guide's rules changes ``rows_key``, so the stale entry is simply never hit again and
    ages out of the LRU.
    """
    rows: List[Dict[str, Any]] = json.loads(rows_key)
    # Hash the canonical key itself, so the compiled fingerprint and
    # :func:`rules_content_fingerprint` can never drift apart (GOV-1.6 pins on this equality).
    fingerprint = hashlib.sha256(rows_key.encode("utf-8")).hexdigest()

    reserved = frozenset(builtin_rule_ids())
    rule_severities: Dict[str, str] = {}
    custom_rules: List[CustomRule] = []
    custom_rule_errors: Dict[str, str] = {}

    for row in rows:
        rule_id = row["rule_id"]
        if not row["enabled"] or not rule_id:
            continue
        custom_def = row.get("custom_def")
        if custom_def is None:
            rule_severities[rule_id] = row["severity"]
            continue
        # Custom rule row: re-validate the stored definition (defence in depth — it was
        # validated on write, but the linter must never trust stored JSON blindly). The
        # row's severity column is authoritative over the definition's embedded severity,
        # matching how severity overrides work for built-in rules.
        try:
            rule = validate_custom_definition(rule_id, custom_def, reserved_rule_ids=reserved)
        except CustomRuleValidationError as exc:
            custom_rule_errors[rule_id] = exc.message
            logger.warning(
                "Skipping invalid stored custom rule %r of guide %s: %s",
                rule_id,
                guide_id or name,
                exc.message,
            )
            continue
        if row["severity"] and rule.severity != row["severity"]:
            rule = replace(rule, severity=row["severity"])
        custom_rules.append(rule)

    return CompiledStyleGuide(
        guide_id=guide_id,
        name=name,
        source=source,
        rule_severities=rule_severities,
        custom_rules=CustomRuleSet(rules=tuple(custom_rules)),
        custom_rule_errors=custom_rule_errors,
        fingerprint=fingerprint,
    )


def resolve_style_guide(
    tenant_id: str, project_id: Optional[str] = None
) -> CompiledStyleGuide:
    """Resolve and compile the style guide governing a lint run.

    Resolution order (GOV-1.4): a **project**-assigned guide wins over a **tenant**-assigned
    guide, which wins over the tenant's **default** guide (V159 seeds "Apiome Recommended"
    as the default). When nothing resolves — brand-new tenant, catalog item id passed as
    ``project_id`` (catalog items carry no project assignment), or any DB fault — the
    in-code :func:`builtin_fallback_guide` applies, so lint always runs and scores exactly
    as the shipped defaults. Strictly best-effort: this function never raises.

    Args:
        tenant_id: The tenant whose lint run this is.
        project_id: The owning project, when the entry point has one.

    Returns:
        The compiled guide to apply.
    """
    try:
        from .database import db  # Lazy: keeps the lint engine importable without a DB layer.

        guide = db.get_assigned_style_guide(tenant_id, project_id)
        # Shape-check before trusting: a misbehaving accessor (or a broadly-mocked db in
        # tests) must degrade to the defaults, never to a silently empty guide.
        if not isinstance(guide, dict) or not guide.get("id"):
            return builtin_fallback_guide()
        rows = db.get_style_guide_rules(str(guide["id"]), tenant_id)
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            return builtin_fallback_guide()
        return compile_style_guide(
            str(guide["id"]), str(guide["name"]), str(guide["source"]), rows
        )
    except Exception:  # noqa: BLE001 - guide resolution must never break a lint run
        logger.warning(
            "Style-guide resolution failed for tenant %s (project %s); "
            "falling back to built-in defaults",
            tenant_id,
            project_id,
            exc_info=True,
        )
        return builtin_fallback_guide()


def guided_lint_openapi_spec(
    spec: Mapping[str, Any],
    tenant_id: str,
    project_id: Optional[str] = None,
    extra_findings: Optional[List[LintFinding]] = None,
) -> Tuple[LintResult, CompiledStyleGuide]:
    """Lint an OpenAPI document under the tenant/project's resolved style guide.

    The one-call form every OpenAPI entry point uses (editor lint, catalog lint, import
    scoring, conversion scoring, publish check): resolve the guide, run the stock
    :func:`~app.schema_lint.lint_openapi_spec`, then re-score under the guide (including
    custom-rule evaluation against ``spec``).

    Args:
        spec: The reconstructed OpenAPI/JSON-Schema document.
        tenant_id: The tenant whose guide chain applies.
        project_id: The owning project, when known (enables project-level guides).
        extra_findings: Pre-built findings (e.g. compatibility) merged before scoring.

    Returns:
        ``(result, guide)`` — the guide-scored result and the guide that produced it.
    """
    guide = resolve_style_guide(tenant_id, project_id)
    result = lint_openapi_spec(spec, extra_findings=extra_findings)
    return guide.apply(result, document=spec), guide


def apply_style_guide_to_lint_report(report: Any, guide: CompiledStyleGuide) -> Any:
    """Re-score a canonical-import :class:`~app.import_source.LintReport` under a guide.

    The canonical import pipeline lints via adapters that return the SPI ``LintReport``
    (whose findings drop the ``category`` field). To re-score without changing the SPI,
    findings are lifted back into engine findings — category recovered from the GOV-1.2
    registry (falling back to the rule id's pack prefix) — the guide is applied (without a
    JSON document, so enable/disable + severity overrides only), and the result is adapted
    back through ``LintReport.from_lint_result``. Under the default guide this reproduces
    the adapter's report verbatim.

    Args:
        report: The adapter's ``LintReport`` (typed ``Any`` to avoid importing the heavy
            SPI module at import time).
        guide: The compiled guide to score under.

    Returns:
        A new ``LintReport`` scored under the guide; ``report`` unchanged when it carries
        no score (an adapter that declined to score has nothing to re-score).
    """
    from .import_source import LintReport  # Lazy: avoids the SPI module on the hot path.

    if report.score is None:
        return report

    categories = _builtin_category_by_rule()
    findings = [
        LintFinding(
            path=f.path,
            category=categories.get(f.rule, f.rule.split(".", 1)[0]),
            rule=f.rule,
            severity=f.severity,
            message=f.message,
        )
        for f in report.findings
    ]
    base = assemble_lint_result(findings)
    return LintReport.from_lint_result(guide.apply(base))
