"""Built-in lint-rule catalog registry — GOV-1.2 (#4428).

Before this module, the built-in lint rules were engine internals: the OpenAPI spec linter
(:mod:`app.schema_lint`) kept a private ``(category, severity)`` catalogue and the canonical
rule packs (:mod:`app.lint_engine` and the per-format packs) each carried their own
:class:`~app.lint_engine.LintRule` lists. Nothing enumerated them all in one place, so no
style guide could enable/disable a rule by id, no UI could list them, and no violation could
link to a rationale.

This registry gives every built-in rule one durable descriptor — a **stable id**, its
**category**, its **default severity**, a **one-line rationale**, and a **docs anchor** into
the rule reference page (``docs/guide/lint-rules.md``) — and is exposed over REST via
``GET /v1/lint/rules`` (see :mod:`app.lint_routes`).

Stable-id policy
----------------

The registry's stable id **is** the rule id the engines already emit in every finding's
``rule`` field (``documentation.operation-missing-summary``, ``common.type-missing-description``,
``asyncapi.message-missing-name``, …). Those ids are hashed into finding ids and the
``report_fingerprint``, and GOV-1.1 seeds the built-in "Apiome Recommended" guide so that
existing scores do not change on upgrade — so shipped ids are never renamed, and violations
are attributable to a registered rule with no mapping layer.

Sources aggregated (all derived from the live engines, so the registry cannot drift):

* the OpenAPI spec linter's :data:`app.schema_lint.OPENAPI_RULES` catalogue;
* every unconditional pack the engine runs for all formats
  (:func:`app.lint_engine.unconditional_rule_packs` — the cross-format ``common`` pack and the
  IXH-5.4 ``examples`` pack);
* every registered per-format :class:`app.lint_engine.RulePack` (AsyncAPI, GraphQL,
  protobuf, Arazzo, …), loaded through the same lazy loader the lint engine uses.

The MCP *surface* linter (:mod:`app.mcp_lint`, V2-MCP-21.x) is intentionally **not**
included: it lints an MCP capability surface, not a schema revision, and is not part of the
governance style-guide surface (GOV-1.4 evaluates guides in the revision lint paths).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from .lint_engine import (
    available_lint_formats,
    get_rule_pack,
    load_format_rule_packs,
    unconditional_rule_packs,
)
from .schema_lint import OPENAPI_RULES

__all__ = [
    "LINT_RULE_DOCS_PAGE",
    "LintRuleDescriptor",
    "builtin_rule_descriptors",
    "builtin_rule_ids",
    "docs_anchor_for",
]

#: Repository-relative path of the human-readable rule reference every descriptor's
#: ``docs_anchor`` points into.
LINT_RULE_DOCS_PAGE = "docs/guide/lint-rules.md"

#: Pack key recorded on descriptors sourced from the OpenAPI spec linter.
_OPENAPI_PACK = "openapi"


def docs_anchor_for(rule_id: str) -> str:
    """Return the docs anchor for ``rule_id`` inside :data:`LINT_RULE_DOCS_PAGE`.

    The anchor is the rule id with every ``.`` replaced by ``-`` (e.g.
    ``naming.schema-pascal-case`` -> ``naming-schema-pascal-case``). The reference page
    emits an explicit ``<a id="...">`` marker per rule with exactly this slug, so the
    anchor does not depend on any renderer's heading-slugification rules.

    :param rule_id: The rule's stable id.
    :returns: The anchor slug (without a leading ``#``).
    """
    return rule_id.replace(".", "-")


@dataclass(frozen=True)
class LintRuleDescriptor:
    """One registered built-in lint rule: identity, defaults, rationale, and docs pointer.

    Attributes:
        rule_id: Stable identifier — exactly the string the engine emits in a finding's
            ``rule`` field. Never renamed once shipped (it is hashed into finding ids and
            report fingerprints).
        pack: Which rule pack the rule belongs to (``openapi``, ``common``, ``asyncapi``,
            ``graphql``, ``protobuf``, ``arazzo``, …).
        category: The rule's group (``naming`` / ``documentation`` / ``structure`` /
            ``compatibility`` / …), used for grouping and per-category score rollups.
        default_severity: ``"error"`` | ``"warning"`` | ``"info"`` — the severity the rule
            carries when no style guide overrides it.
        rationale: One-line human explanation of why the rule exists.
        docs_anchor: Anchor slug into :data:`LINT_RULE_DOCS_PAGE` documenting the rule.
    """

    rule_id: str
    pack: str
    category: str
    default_severity: str
    rationale: str
    docs_anchor: str

    def as_dict(self) -> Dict[str, Any]:
        """Return the descriptor as a plain dict (snake_case keys).

        Blocking (error) rules additionally carry CLX-4.3 transparency fields from
        :mod:`app.scanner_rule_transparency`.
        """
        from .scanner_rule_transparency import enrich_rule_dict

        base: Dict[str, Any] = {
            "rule_id": self.rule_id,
            "pack": self.pack,
            "category": self.category,
            "default_severity": self.default_severity,
            "rationale": self.rationale,
            "docs_anchor": self.docs_anchor,
        }
        return enrich_rule_dict(base, self.rule_id)


def _descriptor(rule_id: str, pack: str, category: str, severity: str, rationale: str) -> LintRuleDescriptor:
    """Build one descriptor, deriving the docs anchor from the rule id."""
    return LintRuleDescriptor(
        rule_id=rule_id,
        pack=pack,
        category=category,
        default_severity=severity,
        rationale=rationale,
        docs_anchor=docs_anchor_for(rule_id),
    )


def builtin_rule_descriptors() -> Tuple[LintRuleDescriptor, ...]:
    """Enumerate every built-in lint rule as a :class:`LintRuleDescriptor`, sorted by id.

    The list is assembled from the live engines on every call (the underlying catalogues are
    module-level constants, so this is cheap): the OpenAPI catalogue, the common pack, and
    every registered format pack. A pack registered under multiple format keys (e.g. the
    AsyncAPI pack under ``asyncapi-2`` and ``asyncapi-3``) contributes each rule once.

    :returns: All built-in rule descriptors, sorted by ``rule_id`` for a deterministic payload.
    """
    by_id: Dict[str, LintRuleDescriptor] = {}

    # 1. The OpenAPI spec linter's catalogue (rationales live alongside it in schema_lint).
    for rule_id, (category, severity, rationale) in OPENAPI_RULES.items():
        by_id[rule_id] = _descriptor(rule_id, _OPENAPI_PACK, category, severity, rationale)

    # 2. Every unconditional pack (the cross-format common pack and the IXH-5.4
    #    example-conformance pack) — taken from the engine itself, so the catalogue lists
    #    exactly what runs on every canonical-model lint.
    for pack in unconditional_rule_packs():
        pack_label = pack.pack_id or type(pack).__name__
        for rule in pack.rules():
            by_id[rule.rule_id] = _descriptor(
                rule.rule_id, pack_label, rule.category, rule.severity, rule.description
            )

    # 3. Every registered per-format pack. Subclass registrations under extra format keys
    #    (same rules, different key) dedupe naturally through the by-id dict.
    load_format_rule_packs()
    for format_key in available_lint_formats():
        pack_cls = get_rule_pack(format_key)
        if pack_cls is None:  # pragma: no cover - registry keys always resolve
            continue
        pack_label = pack_cls.pack_id or pack_cls.__name__
        for rule in pack_cls().rules():
            by_id.setdefault(
                rule.rule_id,
                _descriptor(rule.rule_id, pack_label, rule.category, rule.severity, rule.description),
            )

    return tuple(by_id[rule_id] for rule_id in sorted(by_id))


def builtin_rule_ids() -> List[str]:
    """Return every registered built-in rule id, sorted — the ids findings may carry."""
    return [descriptor.rule_id for descriptor in builtin_rule_descriptors()]
