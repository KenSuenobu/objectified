"""Intake-stage lint rule catalogue — MFI-29.4 (#4391).

Most lint rules fire against a *model*: the canonical-model rule packs
(:mod:`app.lint_engine`) and the OpenAPI catalogue (:data:`app.schema_lint.OPENAPI_RULES`)
both read something the pipeline has already parsed. A few defects, though, are only
visible **during intake** — they describe the source document as it arrived, not the model
it produced. The remote ``$ref`` resolver (:mod:`app.remote_ref_resolver`) is the first:
an external ``$ref`` that was never fetched (resolution off, budget spent, guard refusal)
leaves a hole in the model that the model itself can no longer describe.

Those rules still have to be *attributable*: GOV-1.2 promises that every ``rule`` id a
finding carries is a registered, documented id
(:func:`app.lint_rule_registry.builtin_rule_descriptors`). This module is that registration
point — a plain catalogue in exactly the shape of ``OPENAPI_RULES``
(``rule_id → (category, default_severity, rationale)``) which the registry folds in as one
more source, and which the docs generator turns into anchors on
``docs/guide/lint-rules.md``.

**Default severities are warnings on purpose.** An unresolved external reference degrades
the imported model's completeness, but it does not make the document invalid, and a
document that legitimately points at an unreachable host should not fail its import. A
tenant that treats external references as a hard error promotes these rules to ``error``
through its style guide (GOV-1.2 severity overrides) rather than through a code change —
which also keeps them out of the CLX-4.3 blocking-rule catalogue, whose entries are the
rules that block delivery by default.
"""

from __future__ import annotations

from typing import Dict, Tuple

__all__ = [
    "INTAKE_PACK",
    "INTAKE_RULES",
    "RULE_BLOCKED_EXTERNAL_REF",
    "RULE_OVERLAY_ACTION_INVALID",
    "RULE_OVERLAY_UNMATCHED_TARGET",
    "RULE_UNRESOLVED_EXTERNAL_REF",
]

#: Pack label reported for these rules in the GOV-1.2 rule catalogue.
INTAKE_PACK = "intake"

#: An external ``$ref`` was left in place instead of being inlined — because remote
#: resolution is off, a budget stopped the walk, or the fetch/parse failed.
RULE_UNRESOLVED_EXTERNAL_REF = "intake.unresolved-external-ref"

#: An external ``$ref`` was refused by the SSRF guard: its URL names a non-public
#: address (loopback / RFC1918 / link-local incl. the cloud metadata IP) or a scheme
#: this service will not fetch.
RULE_BLOCKED_EXTERNAL_REF = "intake.blocked-external-ref"

#: An OpenAPI Overlay action's ``target`` JSONPath matched nothing in the base
#: document, so the action was not applied (IXH-7.7).
RULE_OVERLAY_UNMATCHED_TARGET = "intake.overlay-unmatched-target"

#: An OpenAPI Overlay action was structurally unusable — no ``target``, neither
#: ``update`` nor ``remove``, an unparsable JSONPath, or an ``update`` value whose
#: type does not fit the selected node (IXH-7.7).
RULE_OVERLAY_ACTION_INVALID = "intake.overlay-action-invalid"

#: ``rule_id → (category, default_severity, rationale)`` — the same shape as
#: :data:`app.schema_lint.OPENAPI_RULES`, so :mod:`app.lint_rule_registry` and the docs
#: generator consume it without a special case.
INTAKE_RULES: Dict[str, Tuple[str, str, str]] = {
    RULE_UNRESOLVED_EXTERNAL_REF: (
        "structure",
        "warning",
        "An external $ref that is never resolved leaves the imported model incomplete: the "
        "referenced messages, schemas, or types are missing from every downstream view "
        "(diff, lint, export) with no indication that anything was dropped. Enable remote "
        "$ref resolution for the import, bundle the referenced documents into the upload, "
        "or inline the definitions in the source document.",
    ),
    RULE_BLOCKED_EXTERNAL_REF: (
        "structure",
        "warning",
        "An external $ref pointing at a non-public address (loopback, RFC1918, link-local, "
        "or the cloud metadata endpoint) or at a non-HTTP scheme is refused by the SSRF "
        "guard and is never fetched. Publish the referenced document at a public HTTPS URL, "
        "or bundle it into the import instead of referencing it.",
    ),
    RULE_OVERLAY_UNMATCHED_TARGET: (
        "structure",
        "warning",
        "An OpenAPI Overlay action whose `target` JSONPath matches nothing in the base "
        "document has no effect: the modification the overlay describes was silently "
        "skipped everywhere the resolved document is used. Fix the target expression, or "
        "remove the action if the construct it targeted no longer exists in the base.",
    ),
    RULE_OVERLAY_ACTION_INVALID: (
        "structure",
        "warning",
        "An OpenAPI Overlay action that declares no target, neither `update` nor "
        "`remove: true`, an invalid JSONPath, or an `update` value whose type does not "
        "fit the selected node cannot be applied as written (Overlay 1.0). Fix the "
        "action so the modification it describes actually reaches the resolved document.",
    ),
}
