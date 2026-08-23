#!/usr/bin/env python3
"""
Generate / refresh CLX-4.3 rule transparency docs.

Writes:
  - docs/guide/lint-rules.md (schema packs, with blocking transparency fields)
  - docs/guide/mcp-surface-lint-rules.md
  - docs/guide/mcp-conformance-rules.md
  - docs/guide/mcp-trust-posture-rules.md

Run from apiome-rest:
    uv run python scripts/generate_lint_rule_docs.py
"""

from __future__ import annotations

import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
src = project_root / "src"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))

from app.lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors  # noqa: E402
from app.mcp_conformance import RULE_REGISTRY as CONFORMANCE_RULES  # noqa: E402
from app.mcp_lint import RULE_CATALOGUE  # noqa: E402
import app.mcp_probe  # noqa: E402,F401  — registers proven posture bridge rules
from app.mcp_trust_posture import RULE_REGISTRY as POSTURE_RULES  # noqa: E402
from app.scanner_rule_transparency import (  # noqa: E402
    MCP_CONFORMANCE_RULES_DOCS_PAGE,
    MCP_POSTURE_RULES_DOCS_PAGE,
    MCP_SURFACE_RULES_DOCS_PAGE,
    get_blocking_meta,
)

MONOREPO = project_root.parent


HEADER_SCHEMA = """\
# Built-in lint rules

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: cd apiome-rest && uv run python scripts/generate_lint_rule_docs.py -->

Reference for every built-in lint rule in the rule-catalog registry (GOV-1.2). Each rule's
**id is stable** — it is exactly the string lint findings carry in their `rule` field, so a
violation always links back to the rule documented here. The **default severity** is what the
rule applies when no style guide overrides it.

Blocking (`error`) rules additionally publish reference, remediation, false-positive guidance,
fixture id, and scan-mode requirements (CLX-4.3 / #4861). See
[scanner evaluation](../../apiome-rest/docs/scanner_evaluation.md).

Fetch this catalog programmatically with `GET /v1/lint/rules` (see
[lint-and-quality.md](lint-and-quality.md)).
"""


def _blocking_section(rule_id: str) -> list[str]:
    meta = get_blocking_meta(rule_id)
    if meta is None:
        return []
    return [
        f"- **Reference:** {meta.reference}",
        f"- **Remediation:** {meta.remediation}",
        f"- **False-positive guidance:** {meta.false_positive_guidance}",
        f"- **Fixture:** `{meta.fixture_id}`",
        f"- **Scan modes:** {', '.join(f'`{m}`' for m in meta.scan_modes)}",
        "",
    ]


def _transparency_section(descriptor) -> list[str]:
    """Render the transparency block for one catalogued schema rule, blocking or not.

    A blocking rule's block comes from the CLX-4.3 catalogue. A non-blocking rule whose pack
    publishes its own remediation and fixture (FMT-5.5) gets the same treatment from the
    enriched catalog payload, so the reference page does not tell a reader how to fix a rule
    only when that rule can fail a gate.
    """
    blocking = _blocking_section(descriptor.rule_id)
    if blocking:
        return blocking
    payload = descriptor.as_dict()
    if not payload.get("remediation"):
        return []
    lines = [f"- **Remediation:** {payload['remediation']}"]
    if payload.get("fixture_id"):
        lines.append(f"- **Fixture:** `{payload['fixture_id']}`")
    lines.append("")
    return lines


def render_schema(descriptors) -> str:
    lines = [HEADER_SCHEMA]
    by_pack: dict = {}
    for d in descriptors:
        by_pack.setdefault(d.pack, []).append(d)
    for pack in sorted(by_pack):
        lines.append(f"\n## Pack: `{pack}`\n")
        for d in by_pack[pack]:
            lines.append(f'<a id="{d.docs_anchor}"></a>')
            lines.append(f"### `{d.rule_id}`\n")
            lines.append(f"- **Category:** {d.category}")
            lines.append(f"- **Default severity:** {d.default_severity}")
            lines.append(f"- **Rationale:** {d.rationale}")
            section = _transparency_section(d)
            lines.extend(section)
            if not section:
                lines.append("")
    return "\n".join(lines)


def _mcp_header(title: str, body: str) -> str:
    return (
        f"# {title}\n\n"
        "<!-- GENERATED FILE — do not edit by hand.\n"
        "     Regenerate with: cd apiome-rest && uv run python scripts/generate_lint_rule_docs.py -->\n\n"
        f"{body}\n"
    )


def render_surface() -> str:
    lines = [
        _mcp_header(
            "MCP surface lint rules",
            "Catalog for :mod:`app.mcp_lint`. Blocking rules include CLX-4.3 transparency "
            "fields. Fetch via `GET /v1/mcp/lint/rules`.",
        )
    ]
    for rule_id in sorted(RULE_CATALOGUE):
        category, severity = RULE_CATALOGUE[rule_id]
        meta = get_blocking_meta(rule_id)
        anchor = rule_id.replace(".", "-")
        lines.append(f'<a id="{anchor}"></a>')
        lines.append(f"### `{rule_id}`\n")
        lines.append(f"- **Category:** {category}")
        lines.append(f"- **Severity:** {severity}")
        if meta:
            lines.append(f"- **Rationale:** {meta.rationale}")
            lines.extend(_blocking_section(rule_id))
        else:
            lines.append("")
    return "\n".join(lines)


def render_conformance() -> str:
    lines = [
        _mcp_header(
            "MCP conformance rules",
            "Catalog for :mod:`app.mcp_conformance`. Every rule cites an MCP specification "
            "reference. Blocking rules include CLX-4.3 transparency fields. "
            "Fetch via `GET /v1/mcp/conformance/rules`.",
        )
    ]
    for rule in sorted(CONFORMANCE_RULES.values(), key=lambda r: r.rule_id):
        anchor = rule.rule_id.replace(".", "-")
        lines.append(f'<a id="{anchor}"></a>')
        lines.append(f"### `{rule.rule_id}`\n")
        lines.append(f"- **Category:** {rule.category}")
        lines.append(f"- **Severity:** {rule.severity}")
        lines.append(f"- **Spec version:** {rule.spec_version}")
        lines.append(f"- **Spec reference:** {rule.spec_reference}")
        lines.append(f"- **Rationale:** {rule.rationale}")
        lines.append(f"- **Requires transcript:** {rule.requires_transcript}")
        lines.extend(_blocking_section(rule.rule_id))
        if get_blocking_meta(rule.rule_id) is None:
            lines.append("")
    return "\n".join(lines)


def render_posture() -> str:
    lines = [
        _mcp_header(
            "MCP trust-posture rules",
            "Catalog for :mod:`app.mcp_trust_posture`, mapped to the OWASP MCP Top 10. "
            "Blocking rules include CLX-4.3 transparency fields. "
            "Fetch via `GET /v1/mcp/trust-posture/rules`.",
        )
    ]
    for rule in sorted(POSTURE_RULES.values(), key=lambda r: r.rule_id):
        anchor = rule.rule_id.replace(".", "-")
        lines.append(f'<a id="{anchor}"></a>')
        lines.append(f"### `{rule.rule_id}`\n")
        lines.append(f"- **Origin:** {rule.origin}")
        lines.append(f"- **Severity:** {rule.severity}")
        lines.append(f"- **OWASP:** {', '.join(rule.owasp_ids)}")
        lines.append(f"- **Reference:** {rule.reference}")
        lines.append(f"- **Requires:** {rule.requires}")
        lines.append(f"- **Rationale:** {rule.rationale}")
        lines.extend(_blocking_section(rule.rule_id))
        if get_blocking_meta(rule.rule_id) is None:
            lines.append("")
    return "\n".join(lines)


def main() -> None:
    out_schema = MONOREPO / LINT_RULE_DOCS_PAGE
    out_schema.write_text(render_schema(builtin_rule_descriptors()), encoding="utf-8")
    print(f"Wrote {out_schema}")

    mapping = {
        MCP_SURFACE_RULES_DOCS_PAGE: render_surface(),
        MCP_CONFORMANCE_RULES_DOCS_PAGE: render_conformance(),
        MCP_POSTURE_RULES_DOCS_PAGE: render_posture(),
    }
    for page, body in mapping.items():
        path = MONOREPO / page
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
