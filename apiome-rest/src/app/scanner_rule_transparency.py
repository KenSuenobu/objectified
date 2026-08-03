"""Transparent blocking-rule metadata and evaluation corpus contract (CLX-4.3, #4861).

A claim to be a serious linter is not credible without stable ids, references, rationales,
fixtures, and remediation guidance for every rule that can fail a gate. This module is the
single registry of that metadata for **blocking** (``error``) rules across schema lint,
MCP surface lint, MCP conformance, and MCP trust posture.

Non-blocking rules keep their engine-local descriptors unchanged. Catalog serializers
:func:`enrich_rule_dict` onto payloads so fingerprints and finding shapes stay byte-stable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .axis_score import ALGORITHM_DOCS_PAGE
from .lint_rule_registry import docs_anchor_for
from .mcp_owasp import CATALOG_REFERENCE as OWASP_REFERENCE

#: Revision of this transparency catalog. Bump when remediation/fixture mappings change in a
#: way that consumers of published docs should re-interpret.
TRANSPARENCY_CATALOG_REVISION = "1"

#: Engine docs describing the scanner-evaluation program (corpus, differential gate, deprecation).
SCANNER_EVALUATION_DOCS_PAGE = "apiome-rest/docs/scanner_evaluation.md"

#: Product guide for style-guide / policy versions shown in the UI.
POLICY_DOCS_PAGE = "docs/guide/lint-and-quality.md"

#: Generated MCP posture rule reference (anchors = docs_anchor_for(rule_id)).
MCP_POSTURE_RULES_DOCS_PAGE = "docs/guide/mcp-trust-posture-rules.md"

#: Generated MCP conformance rule reference.
MCP_CONFORMANCE_RULES_DOCS_PAGE = "docs/guide/mcp-conformance-rules.md"

#: Generated MCP surface-lint rule reference.
MCP_SURFACE_RULES_DOCS_PAGE = "docs/guide/mcp-surface-lint-rules.md"

ENGINE_SCHEMA = "schema"
ENGINE_MCP_SURFACE = "mcp_surface"
ENGINE_MCP_CONFORMANCE = "mcp_conformance"
ENGINE_MCP_POSTURE = "mcp_posture"

ENGINES: Tuple[str, ...] = (
    ENGINE_SCHEMA,
    ENGINE_MCP_SURFACE,
    ENGINE_MCP_CONFORMANCE,
    ENGINE_MCP_POSTURE,
)


@dataclass(frozen=True)
class BlockingRuleMeta:
    """Transparency metadata for one gate-blocking (error) rule.

    Attributes:
        rule_id: Stable finding rule id — never renamed once shipped.
        engine: Which scanner registry owns the rule (:data:`ENGINES`).
        severity: Always ``error`` for entries in this catalog.
        rationale: Why the rule exists (what breaks when it is violated).
        reference: Resolvable URL for the rule's normative or advisory basis.
        remediation: What an author should change to clear the finding.
        false_positive_guidance: When a hit may be noise and how to triage it.
        scan_modes: Scanner modes / evidence requirements (human-readable tokens).
        fixture_id: Corpus fixture id under ``tests/fixtures/scanner_evaluation/``.
        docs_page: Repository-relative markdown page documenting the rule.
        docs_anchor: Anchor slug inside ``docs_page``.
    """

    rule_id: str
    engine: str
    severity: str
    rationale: str
    reference: str
    remediation: str
    false_positive_guidance: str
    scan_modes: Tuple[str, ...]
    fixture_id: str
    docs_page: str
    docs_anchor: str

    def __post_init__(self) -> None:
        if self.engine not in ENGINES:
            raise ValueError(f"unknown engine {self.engine!r} for rule {self.rule_id!r}")
        if self.severity != "error":
            raise ValueError(
                f"blocking catalog only accepts severity 'error' (got {self.severity!r} "
                f"for {self.rule_id!r})"
            )

    def as_dict(self) -> Dict[str, Any]:
        """Return a JSON-ready dict (camelCase aliases applied by API models)."""
        return {
            "rule_id": self.rule_id,
            "engine": self.engine,
            "severity": self.severity,
            "rationale": self.rationale,
            "reference": self.reference,
            "remediation": self.remediation,
            "false_positive_guidance": self.false_positive_guidance,
            "scan_modes": list(self.scan_modes),
            "fixture_id": self.fixture_id,
            "docs_page": self.docs_page,
            "docs_anchor": self.docs_anchor,
        }


def _meta(
    rule_id: str,
    engine: str,
    *,
    rationale: str,
    reference: str,
    remediation: str,
    false_positive_guidance: str,
    scan_modes: Sequence[str],
    fixture_id: str,
    docs_page: str,
) -> BlockingRuleMeta:
    return BlockingRuleMeta(
        rule_id=rule_id,
        engine=engine,
        severity="error",
        rationale=rationale,
        reference=reference,
        remediation=remediation,
        false_positive_guidance=false_positive_guidance,
        scan_modes=tuple(scan_modes),
        fixture_id=fixture_id,
        docs_page=docs_page,
        docs_anchor=docs_anchor_for(rule_id),
    )


_SCHEMA_REF = (
    "https://github.com/apiome/apiome/blob/main/docs/guide/lint-rules.md"
)
_MCP_SPEC = "https://modelcontextprotocol.io/specification/2025-06-18/"


#: Every blocking rule. Keyed by rule_id; must stay complete vs live error registries.
BLOCKING_RULES: Dict[str, BlockingRuleMeta] = {
    # --- Schema / format packs -----------------------------------------------------------------
    "arazzo.dangling-operation-id": _meta(
        "arazzo.dangling-operation-id",
        ENGINE_SCHEMA,
        rationale="Step operationId must resolve to an embedded sourceDescription.",
        reference=_SCHEMA_REF + "#arazzo-dangling-operation-id",
        remediation="Point the step's operationId at an operation declared in an embedded "
        "OpenAPI sourceDescription, or remove the step.",
        false_positive_guidance="Only false if the engine cannot see an operation that exists "
        "only in an external (non-embedded) source — embed the description or switch to operationRef.",
        scan_modes=("lint",),
        fixture_id="catalog/arazzo-dangling-operation-id",
        docs_page="docs/guide/lint-rules.md",
    ),
    "arzzo.unresolvable-operation-ref": _meta(
        "arzzo.unresolvable-operation-ref",
        ENGINE_SCHEMA,
        rationale="Step operationRef must point at a declared sourceDescription.",
        reference=_SCHEMA_REF + "#arzzo-unresolvable-operation-ref",
        remediation="Use a local JSON Pointer under #/sourceDescriptions/<name>/… for a "
        "declared source, or fix the sourceDescription name.",
        false_positive_guidance="External HTTP operationRef targets are out of scope for "
        "static resolution — prefer embedded sources for gateable workflows.",
        scan_modes=("lint",),
        fixture_id="catalog/arzzo-unresolvable-operation-ref",
        docs_page="docs/guide/lint-rules.md",
    ),
    "compatibility.breaking": _meta(
        "compatibility.breaking",
        ENGINE_SCHEMA,
        rationale="A change relative to the base revision breaks existing consumers.",
        reference=_SCHEMA_REF + "#compatibility-breaking",
        remediation="Restore the removed/changed contract surface, introduce a new path or "
        "version, or deliberately gate with a documented breaking-change process.",
        false_positive_guidance="Diff noise from reorder-only or documentation-only revisions "
        "should not appear; if it does, file a scanner bug with the base/head pair.",
        scan_modes=("breaking", "lint"),
        fixture_id="catalog/compatibility-breaking",
        docs_page="docs/guide/lint-rules.md",
    ),
    "graphql.composition-error": _meta(
        "graphql.composition-error",
        ENGINE_SCHEMA,
        rationale="`rover supergraph compose` reported the subgraph set does not compose.",
        reference=_SCHEMA_REF + "#graphql-composition-error",
        remediation="Fix the subgraph the finding names so the set composes (run "
        "`rover supergraph compose` locally for the full report), then re-import.",
        false_positive_guidance="The verdict is captured at import time; if the subgraphs "
        "changed since, re-import the set to refresh it.",
        scan_modes=("lint",),
        fixture_id="catalog/graphql-composition-error",
        docs_page="docs/guide/lint-rules.md",
    ),
    "graphql.composition-invalid-key": _meta(
        "graphql.composition-invalid-key",
        ENGINE_SCHEMA,
        rationale="A @key(fields:) selection must name fields its type declares in that subgraph.",
        reference=_SCHEMA_REF + "#graphql-composition-invalid-key",
        remediation="Make the @key selection reference fields the type declares in the named "
        "subgraph (declare the field, or fix the selection).",
        false_positive_guidance="Nested key selections are checked at the top level only; a "
        "top-level field reported missing is genuinely undeclared in that subgraph's file.",
        scan_modes=("lint",),
        fixture_id="catalog/graphql-composition-invalid-key",
        docs_page="docs/guide/lint-rules.md",
    ),
    "graphql.composition-non-shareable-field": _meta(
        "graphql.composition-non-shareable-field",
        ENGINE_SCHEMA,
        rationale="A field resolved by more than one subgraph must be @shareable in each.",
        reference=_SCHEMA_REF + "#graphql-composition-non-shareable-field",
        remediation="Mark the field @shareable in every subgraph that resolves it, mark the "
        "stub copies @external, or move the field to a single owning subgraph.",
        false_positive_guidance="Key fields and @external stubs are already exempt; a hit "
        "means two subgraphs genuinely both resolve the field.",
        scan_modes=("lint",),
        fixture_id="catalog/graphql-composition-non-shareable-field",
        docs_page="docs/guide/lint-rules.md",
    ),
    "graphql.composition-unresolvable-selection": _meta(
        "graphql.composition-unresolvable-selection",
        ENGINE_SCHEMA,
        rationale="@requires/@provides selections must reference fields some subgraph declares.",
        reference=_SCHEMA_REF + "#graphql-composition-unresolvable-selection",
        remediation="Point the @requires/@provides selection at fields declared on the target "
        "type in some subgraph (declare the field there, or fix the selection).",
        false_positive_guidance="The check unions declarations across the whole set; a hit "
        "means no subgraph declares the selected field at all.",
        scan_modes=("lint",),
        fixture_id="catalog/graphql-composition-unresolvable-selection",
        docs_page="docs/guide/lint-rules.md",
    ),
    "llm-tools.duplicate-tool-name": _meta(
        "llm-tools.duplicate-tool-name",
        ENGINE_SCHEMA,
        rationale="Colliding tool names in a function-calling bundle make agent routing ambiguous.",
        reference=_SCHEMA_REF + "#llm-tools-duplicate-tool-name",
        remediation="Give each tool a unique `name` within the bundle (rename or drop duplicates).",
        false_positive_guidance="Cross-dialect wrappers that intentionally alias the same tool "
        "should still expose a single canonical name to agents.",
        scan_modes=("lint",),
        fixture_id="catalog/llm-tools-duplicate-tool-name",
        docs_page="docs/guide/lint-rules.md",
    ),
    # --- MCP surface lint ----------------------------------------------------------------------
    "naming.item-name-missing": _meta(
        "naming.item-name-missing",
        ENGINE_MCP_SURFACE,
        rationale="Every capability item must carry a non-empty name so agents can address it.",
        reference="https://modelcontextprotocol.io/specification/2025-06-18/server/tools",
        remediation="Set a stable, non-empty `name` on the tool, resource, template, or prompt.",
        false_positive_guidance="Rare — only when a transport strips names the server actually sends.",
        scan_modes=("lint", "surface"),
        fixture_id="mcp/unsafe/surface/naming-item-name-missing",
        docs_page=MCP_SURFACE_RULES_DOCS_PAGE,
    ),
    "schema.resource-invalid-uri": _meta(
        "schema.resource-invalid-uri",
        ENGINE_MCP_SURFACE,
        rationale="Resources must advertise an absolute URI with a scheme.",
        reference="https://modelcontextprotocol.io/specification/2025-06-18/server/resources",
        remediation="Provide a scheme-qualified URI (e.g. `file:///…` or `https://…`).",
        false_positive_guidance="Custom schemes are allowed if they include a scheme delimiter.",
        scan_modes=("lint", "surface"),
        fixture_id="mcp/unsafe/surface/schema-resource-invalid-uri",
        docs_page=MCP_SURFACE_RULES_DOCS_PAGE,
    ),
    "schema.resource-template-invalid-uri-template": _meta(
        "schema.resource-template-invalid-uri-template",
        ENGINE_MCP_SURFACE,
        rationale="Resource templates must declare a well-formed URI template.",
        reference="https://modelcontextprotocol.io/specification/2025-06-18/server/resources",
        remediation="Set `uriTemplate` with balanced `{var}` placeholders and a URI scheme.",
        false_positive_guidance="RFC 6570 level differences are tolerated if braces balance.",
        scan_modes=("lint", "surface"),
        fixture_id="mcp/unsafe/surface/schema-resource-template-invalid-uri-template",
        docs_page=MCP_SURFACE_RULES_DOCS_PAGE,
    ),
    "schema.tool-input-schema-invalid": _meta(
        "schema.tool-input-schema-invalid",
        ENGINE_MCP_SURFACE,
        rationale="Tools must declare a JSON Schema object as inputSchema.",
        reference="https://modelcontextprotocol.io/specification/2025-06-18/server/tools",
        remediation="Set `inputSchema` to a JSON Schema with `\"type\": \"object\"` (and object properties).",
        false_positive_guidance="Empty-object schemas (`properties: {}`) are valid when the tool takes no args.",
        scan_modes=("lint", "surface"),
        fixture_id="mcp/unsafe/surface/schema-tool-input-schema-invalid",
        docs_page=MCP_SURFACE_RULES_DOCS_PAGE,
    ),
    # --- MCP conformance -----------------------------------------------------------------------
    "protocol.list-result-missing-items": _meta(
        "protocol.list-result-missing-items",
        ENGINE_MCP_CONFORMANCE,
        rationale="A list result MUST carry its item array, even when empty.",
        reference=_MCP_SPEC + "basic/transports",
        remediation="Include the method's items key (`tools`, `resources`, `prompts`, …) as an array.",
        false_positive_guidance="Skipped (never failed) when no transcript was captured.",
        scan_modes=("protocol", "requires_transcript"),
        fixture_id="mcp/unsafe/conformance/protocol-list-result-missing-items",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    "protocol.missing-protocol-version": _meta(
        "protocol.missing-protocol-version",
        ENGINE_MCP_CONFORMANCE,
        rationale="The initialize result MUST carry a protocolVersion.",
        reference=_MCP_SPEC + "basic/lifecycle",
        remediation="Return a supported `protocolVersion` string from initialize.",
        false_positive_guidance="Not a false positive when the field is present but empty — fix the server.",
        scan_modes=("protocol", "surface"),
        fixture_id="mcp/unsafe/conformance/protocol-missing-protocol-version",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    "protocol.missing-server-name": _meta(
        "protocol.missing-server-name",
        ENGINE_MCP_CONFORMANCE,
        rationale="serverInfo.name identifies the server to the host and MUST be present.",
        reference=_MCP_SPEC + "basic/lifecycle",
        remediation="Set a non-empty `serverInfo.name` on initialize.",
        false_positive_guidance="Whitespace-only names are treated as missing.",
        scan_modes=("protocol", "surface"),
        fixture_id="mcp/unsafe/conformance/protocol-missing-server-name",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    "protocol.response-id-not-echoed": _meta(
        "protocol.response-id-not-echoed",
        ENGINE_MCP_CONFORMANCE,
        rationale="A response MUST echo the id of the request it answers.",
        reference=_MCP_SPEC + "basic/transports",
        remediation="Echo the JSON-RPC request `id` on every successful or error response.",
        false_positive_guidance="Skipped when no transcript was captured; notifications (no id) are exempt.",
        scan_modes=("protocol", "requires_transcript"),
        fixture_id="mcp/unsafe/conformance/protocol-response-id-not-echoed",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    "protocol.undeclared-capability-listed": _meta(
        "protocol.undeclared-capability-listed",
        ENGINE_MCP_CONFORMANCE,
        rationale="A server MUST NOT serve a capability it did not declare during initialize.",
        reference=_MCP_SPEC + "basic/lifecycle",
        remediation="Declare the capability in initialize `capabilities`, or stop listing those items.",
        false_positive_guidance="Hosts that invent capability keys may need profile waivers — not silent skips.",
        scan_modes=("protocol", "surface"),
        fixture_id="mcp/unsafe/conformance/protocol-undeclared-capability-listed",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    "protocol.unsupported-protocol-version": _meta(
        "protocol.unsupported-protocol-version",
        ENGINE_MCP_CONFORMANCE,
        rationale="The negotiated protocol version MUST be a revision this client understands.",
        reference=_MCP_SPEC + "basic/lifecycle",
        remediation="Negotiate a supported protocolVersion from the client's offered set.",
        false_positive_guidance="Bump Apiome's supported-version set only via an intentional release.",
        scan_modes=("protocol", "surface"),
        fixture_id="mcp/unsafe/conformance/protocol-unsupported-protocol-version",
        docs_page=MCP_CONFORMANCE_RULES_DOCS_PAGE,
    ),
    # --- MCP trust posture ---------------------------------------------------------------------
    "metadata.credential-in-description": _meta(
        "metadata.credential-in-description",
        ENGINE_MCP_POSTURE,
        rationale="A credential in a tool description is handed to every agent that lists tools.",
        reference=OWASP_REFERENCE,
        remediation="Remove secrets from descriptions; pass credentials through host env / secret stores.",
        false_positive_guidance="Placeholder tokens (e.g. YOUR_API_KEY) may match — mark false_positive "
        "in the workspace after confirming they are not live credentials.",
        scan_modes=("metadata", "surface"),
        fixture_id="mcp/unsafe/owasp/mcp06-credential-in-description",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "metadata.exfiltration-directive": _meta(
        "metadata.exfiltration-directive",
        ENGINE_MCP_POSTURE,
        rationale="Metadata that directs the agent to exfiltrate conversation or local secrets is hostile.",
        reference=OWASP_REFERENCE,
        remediation="Remove exfiltration language from titles, descriptions, and nested schema text.",
        false_positive_guidance="Security-tooling docs that *discuss* exfiltration may match — "
        "narrow wording or waive with rationale.",
        scan_modes=("metadata", "surface"),
        fixture_id="mcp/unsafe/owasp/mcp02-exfiltration-directive",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "metadata.hidden-instruction": _meta(
        "metadata.hidden-instruction",
        ENGINE_MCP_POSTURE,
        rationale="A tool description that addresses the model as an authority is prompt injection.",
        reference=OWASP_REFERENCE,
        remediation="Rewrite descriptions to describe the tool for humans/agents without override directives.",
        false_positive_guidance="Benign phrases like 'always returns JSON' are filtered; if noise remains, "
        "mark false_positive with a note.",
        scan_modes=("metadata", "surface"),
        fixture_id="mcp/unsafe/owasp/mcp01-hidden-instruction",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "metadata.invisible-characters": _meta(
        "metadata.invisible-characters",
        ENGINE_MCP_POSTURE,
        rationale="Zero-width or bidirectional-override characters hide instructions from reviewers.",
        reference=OWASP_REFERENCE,
        remediation="Strip Cf / zero-width characters from titles, descriptions, and schema text.",
        false_positive_guidance="Some locales insert ZWJ in legitimate names — review before waiving.",
        scan_modes=("metadata", "surface"),
        fixture_id="mcp/unsafe/owasp/mcp01-invisible-characters",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "source.committed-private-key": _meta(
        "source.committed-private-key",
        ENGINE_MCP_POSTURE,
        rationale="A committed private key stays in git history after deletion.",
        reference=OWASP_REFERENCE,
        remediation="Rotate the key, purge it from history, and load secrets from a secret manager.",
        false_positive_guidance="Obviously fake PEM training fixtures may match — quarantine them "
        "outside scanned paths or mark false_positive.",
        scan_modes=("source", "requires_source"),
        fixture_id="mcp/unsafe/owasp/mcp06-committed-private-key",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "source.hardcoded-provider-credential": _meta(
        "source.hardcoded-provider-credential",
        ENGINE_MCP_POSTURE,
        rationale="A recognizable provider credential in source is ready to be stolen.",
        reference=OWASP_REFERENCE,
        remediation="Remove the credential, rotate it, and inject via environment / vault.",
        false_positive_guidance="Documented example keys (AKIAIOSFODNN7EXAMPLE) are intentional "
        "corpus fixtures; production repos should not contain them.",
        scan_modes=("source", "requires_source"),
        fixture_id="mcp/unsafe/owasp/mcp06-hardcoded-provider-credential",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "source.privileged-container": _meta(
        "source.privileged-container",
        ENGINE_MCP_POSTURE,
        rationale="A privileged container is not a boundary; compromise escapes the sandbox.",
        reference=OWASP_REFERENCE,
        remediation="Drop `privileged: true` and grant only the capabilities the workload needs.",
        false_positive_guidance="Lab-only compose files used solely in CI may be waived with expiry.",
        scan_modes=("source", "requires_source"),
        fixture_id="mcp/unsafe/owasp/mcp03-privileged-container",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "source.remote-script-execution": _meta(
        "source.remote-script-execution",
        ENGINE_MCP_POSTURE,
        rationale="Piping a downloaded script into a shell gives whoever hosts it code execution.",
        reference=OWASP_REFERENCE,
        remediation="Vendor scripts, pin digests, and install via package managers with checksums.",
        false_positive_guidance="Comments describing the anti-pattern may match — keep discussions out "
        "of scannable Dockerfile/`*.sh` files.",
        scan_modes=("source", "requires_source"),
        fixture_id="mcp/unsafe/owasp/mcp04-remote-script-execution",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "source.tls-verification-disabled": _meta(
        "source.tls-verification-disabled",
        ENGINE_MCP_POSTURE,
        rationale="Unverified TLS is encrypted but unauthenticated, enabling MITM.",
        reference=OWASP_REFERENCE,
        remediation="Enable certificate verification; remove `-k` / `verify=False` / reject-unauthorized=0.",
        false_positive_guidance="Local-dev overrides in non-production configs may be waived with "
        "environment scope.",
        scan_modes=("source", "requires_source"),
        fixture_id="mcp/unsafe/owasp/mcp07-tls-verification-disabled",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "protocol.proven-auth-bypass": _meta(
        "protocol.proven-auth-bypass",
        ENGINE_MCP_POSTURE,
        rationale="A dynamic probe obtained privileged data from the server without authorization.",
        reference=OWASP_REFERENCE,
        remediation="Enforce authorization on every method, including capability listings; serve no "
        "data to an unauthenticated or unauthorized caller.",
        false_positive_guidance="Only fires with exploit-tier probe evidence — never from static "
        "patterns. If a probe harness is mis-flagged, fix the probe before waiving.",
        scan_modes=("probe", "requires_probe"),
        fixture_id="mcp/unsafe/owasp/mcp07-proven-auth-bypass",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
    "protocol.proven-input-injection": _meta(
        "protocol.proven-input-injection",
        ENGINE_MCP_POSTURE,
        rationale="A dynamic probe demonstrated attacker-controlled input reaching tool output unescaped.",
        reference=OWASP_REFERENCE,
        remediation="Escape or reject untrusted input in tool output; never echo caller-supplied "
        "strings into model-visible content without sanitization.",
        false_positive_guidance="Requires consent-gated exploit probe evidence. Observed-only probes "
        "never upgrade to proven findings.",
        scan_modes=("probe", "requires_probe"),
        fixture_id="mcp/unsafe/owasp/mcp01-proven-input-injection",
        docs_page=MCP_POSTURE_RULES_DOCS_PAGE,
    ),
}


def get_blocking_meta(rule_id: str) -> Optional[BlockingRuleMeta]:
    """Return transparency metadata for ``rule_id``, or ``None`` if it is not blocking."""
    return BLOCKING_RULES.get(rule_id)


def blocking_rule_ids() -> Tuple[str, ...]:
    """Return every blocking rule id, sorted for deterministic payloads."""
    return tuple(sorted(BLOCKING_RULES))


def blocking_rules_for_engine(engine: str) -> List[BlockingRuleMeta]:
    """Return blocking metadata entries for one engine, sorted by rule id."""
    return sorted(
        (m for m in BLOCKING_RULES.values() if m.engine == engine),
        key=lambda m: m.rule_id,
    )


def enrich_rule_dict(payload: Mapping[str, Any], rule_id: Optional[str] = None) -> Dict[str, Any]:
    """Merge transparency fields onto a rule-catalog payload dict when the rule is blocking.

    Existing keys in ``payload`` win for identity fields; transparency fills remediation,
    reference (when absent), false-positive guidance, fixture id, and scan modes.
    """
    out = dict(payload)
    rid = rule_id or str(out.get("rule_id") or out.get("ruleId") or "")
    meta = BLOCKING_RULES.get(rid)
    if meta is None:
        return out
    out.setdefault("reference", meta.reference)
    out["remediation"] = meta.remediation
    out["false_positive_guidance"] = meta.false_positive_guidance
    out["fixture_id"] = meta.fixture_id
    out["scan_modes"] = list(meta.scan_modes)
    out.setdefault("docs_page", meta.docs_page)
    out.setdefault("docs_anchor", meta.docs_anchor)
    return out


def live_blocking_rule_ids() -> Set[str]:
    """Collect every rule id the live engines currently emit at error severity."""
    # Ensure probe→posture bridge rules are registered before reading RULE_REGISTRY.
    import app.mcp_probe  # noqa: F401
    from .lint_rule_registry import builtin_rule_descriptors
    from .mcp_conformance import RULE_REGISTRY as CONFORMANCE_RULES
    from .mcp_lint import RULE_CATALOGUE
    from .mcp_trust_posture import RULE_REGISTRY as POSTURE_RULES

    ids: Set[str] = set()
    for d in builtin_rule_descriptors():
        if d.default_severity == "error":
            ids.add(d.rule_id)
    for rule_id, (_cat, severity) in RULE_CATALOGUE.items():
        if severity == "error":
            ids.add(rule_id)
    for rule in CONFORMANCE_RULES.values():
        if rule.severity == "error":
            ids.add(rule.rule_id)
    for rule in POSTURE_RULES.values():
        if rule.severity == "error":
            ids.add(rule.rule_id)
    return ids


def assert_blocking_rules_complete(live_error_ids: Optional[Iterable[str]] = None) -> None:
    """Raise ``AssertionError`` if the transparency catalog drifts from live error rules.

    Args:
        live_error_ids: Optional override set (tests); defaults to :func:`live_blocking_rule_ids`.
    """
    live = set(live_error_ids) if live_error_ids is not None else live_blocking_rule_ids()
    catalog = set(BLOCKING_RULES)
    missing = live - catalog
    extra = catalog - live
    parts: List[str] = []
    if missing:
        parts.append(f"missing transparency for live error rules: {sorted(missing)}")
    if extra:
        parts.append(f"transparency entries with no live error rule: {sorted(extra)}")
    if parts:
        raise AssertionError("; ".join(parts))
