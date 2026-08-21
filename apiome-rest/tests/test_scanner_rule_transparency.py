"""CLX-4.3 (#4861) — blocking-rule transparency catalog completeness."""

from pathlib import Path

from app.lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors
from app.scanner_rule_transparency import (
    BLOCKING_RULES,
    MCP_CONFORMANCE_RULES_DOCS_PAGE,
    MCP_POSTURE_RULES_DOCS_PAGE,
    MCP_SURFACE_RULES_DOCS_PAGE,
    assert_blocking_rules_complete,
    blocking_rule_ids,
    enrich_rule_dict,
    get_blocking_meta,
    live_blocking_rule_ids,
)

REPO_ROOT = Path(__file__).resolve().parents[1]  # apiome-rest
MONOREPO_ROOT = REPO_ROOT.parent


def test_transparency_catalog_matches_live_error_rules() -> None:
    assert_blocking_rules_complete()
    assert set(blocking_rule_ids()) == live_blocking_rule_ids()
    assert len(BLOCKING_RULES) == 30


def test_every_blocking_rule_has_required_transparency_fields() -> None:
    for rule_id, meta in BLOCKING_RULES.items():
        assert meta.rule_id == rule_id
        assert meta.severity == "error"
        assert meta.rationale.strip()
        assert meta.reference.startswith("http") or meta.reference.startswith("https")
        assert meta.remediation.strip()
        assert meta.false_positive_guidance.strip()
        assert meta.scan_modes
        assert meta.fixture_id.strip()
        assert meta.docs_page.strip()
        assert meta.docs_anchor.strip()
        fixture = REPO_ROOT / "tests" / "fixtures" / "scanner_evaluation" / meta.fixture_id
        assert (fixture / "fixture.json").is_file() or fixture.with_suffix(".json").is_file(), (
            f"missing fixture for {rule_id}: {meta.fixture_id}"
        )


def test_schema_descriptor_enrichment_for_blocking_rules() -> None:
    by_id = {d.rule_id: d for d in builtin_rule_descriptors()}
    for rule_id in ("arazzo.dangling-operation-id", "compatibility.breaking"):
        payload = by_id[rule_id].as_dict()
        assert payload["remediation"]
        assert payload["fixture_id"]
        assert payload["false_positive_guidance"]
        assert payload["scan_modes"]


def test_enrich_rule_dict_noop_for_non_blocking() -> None:
    out = enrich_rule_dict({"rule_id": "documentation.operation-missing-summary", "severity": "warning"})
    assert "remediation" not in out


def test_get_blocking_meta_known_and_unknown() -> None:
    assert get_blocking_meta("naming.item-name-missing") is not None
    assert get_blocking_meta("does.not-exist") is None


def test_generated_docs_pages_exist_with_blocking_anchors() -> None:
    """Docs pages (generated or hand-maintained companions) cover every blocking anchor."""
    pages = {
        LINT_RULE_DOCS_PAGE,
        MCP_SURFACE_RULES_DOCS_PAGE,
        MCP_CONFORMANCE_RULES_DOCS_PAGE,
        MCP_POSTURE_RULES_DOCS_PAGE,
    }
    for page in pages:
        found = MONOREPO_ROOT / page
        assert found.is_file(), f"missing docs page {page} at {found}"
        text = found.read_text(encoding="utf-8")
        for meta in BLOCKING_RULES.values():
            if meta.docs_page != page:
                continue
            assert f'id="{meta.docs_anchor}"' in text or f'<a id="{meta.docs_anchor}">' in text, (
                f"missing anchor {meta.docs_anchor} in {found}"
            )
