"""Built-in rule-catalog registry tests — GOV-1.2 (#4428).

Covers the three acceptance criteria:

* every current rule (OpenAPI catalogue, common pack, every format pack) appears in the registry;
* lint output is attributable — every finding's ``rule`` is a registered id;
* the registry's metadata is complete (category, default severity, rationale, docs anchor) and
  the generated docs page carries an anchor for every rule.
"""

from pathlib import Path

from app.lint_engine import (
    available_lint_formats,
    get_rule_pack,
    lint_canonical_model,
    unconditional_rule_packs,
)
from app.lint_rule_registry import (
    LINT_RULE_DOCS_PAGE,
    LintRuleDescriptor,
    builtin_rule_descriptors,
    builtin_rule_ids,
    docs_anchor_for,
)
from app.schema_lint import OPENAPI_RULES, RULE_CATALOGUE, lint_openapi_spec

REPO_ROOT = Path(__file__).resolve().parents[2]

_VALID_SEVERITIES = {"error", "warning", "info"}


# ---------------------------------------------------------------------------
# Completeness: every engine rule appears in the registry
# ---------------------------------------------------------------------------


def _all_engine_rule_ids() -> set:
    """The union of rule ids across every lint engine the registry aggregates."""
    ids = set(OPENAPI_RULES)
    # Every pack the engine runs for all formats — the common pack and the IXH-5.4
    # example-conformance pack — taken from the engine itself rather than listed here.
    for pack in unconditional_rule_packs():
        ids.update(rule.rule_id for rule in pack.rules())
    for format_key in available_lint_formats():
        pack_cls = get_rule_pack(format_key)
        assert pack_cls is not None
        ids.update(rule.rule_id for rule in pack_cls().rules())
    return ids


def test_registry_covers_every_engine_rule_exactly():
    # The registry is the engines' rules — no missing rule, no phantom rule.
    assert set(builtin_rule_ids()) == _all_engine_rule_ids()


def test_registry_includes_known_rules_from_each_pack():
    ids = set(builtin_rule_ids())
    # One representative per pack, pinning the stable-id policy (ids are the engine ids).
    assert "documentation.operation-missing-summary" in ids  # openapi
    assert "common.type-missing-description" in ids  # common
    assert "asyncapi.message-missing-name" in ids  # asyncapi
    assert "graphql.naming-type-pascal-case" in ids  # graphql
    assert "protobuf.field-no-required" in ids  # protobuf
    assert "arazzo.missing-success-criteria" in ids  # arazzo
    assert "examples.non-conforming-example" in ids  # examples (IXH-5.4)


def test_openapi_rule_catalogue_derives_from_enriched_specs():
    # RULE_CATALOGUE (the engine's hot-path lookup) must stay in lockstep with OPENAPI_RULES.
    assert set(RULE_CATALOGUE) == set(OPENAPI_RULES)
    for rule_id, (category, severity) in RULE_CATALOGUE.items():
        spec_category, spec_severity, _rationale = OPENAPI_RULES[rule_id]
        assert (category, severity) == (spec_category, spec_severity)


# ---------------------------------------------------------------------------
# Metadata: every descriptor is fully populated and deterministic
# ---------------------------------------------------------------------------


def test_descriptors_are_fully_populated_and_sorted():
    descriptors = builtin_rule_descriptors()
    assert descriptors  # non-empty
    ids = [d.rule_id for d in descriptors]
    assert ids == sorted(ids)  # deterministic order
    assert len(ids) == len(set(ids))  # unique ids
    for d in descriptors:
        assert isinstance(d, LintRuleDescriptor)
        assert d.rule_id and d.pack and d.category
        assert d.default_severity in _VALID_SEVERITIES
        assert d.rationale.strip()
        assert d.docs_anchor == docs_anchor_for(d.rule_id)


def test_registry_is_deterministic_across_calls():
    assert builtin_rule_descriptors() == builtin_rule_descriptors()


def test_docs_anchor_slug_replaces_dots():
    assert docs_anchor_for("naming.schema-pascal-case") == "naming-schema-pascal-case"


# ---------------------------------------------------------------------------
# Docs: the generated reference page documents every rule
# ---------------------------------------------------------------------------


def test_docs_page_has_an_anchor_for_every_rule():
    # Guards against adding a rule without regenerating docs/guide/lint-rules.md
    # (scripts/generate_lint_rule_docs.py).
    docs_path = REPO_ROOT / LINT_RULE_DOCS_PAGE
    assert docs_path.is_file(), f"missing rule reference page: {docs_path}"
    content = docs_path.read_text(encoding="utf-8")
    for d in builtin_rule_descriptors():
        assert f'<a id="{d.docs_anchor}"></a>' in content, (
            f"rule {d.rule_id!r} has no anchor in {LINT_RULE_DOCS_PAGE}; "
            "regenerate with scripts/generate_lint_rule_docs.py"
        )
        assert d.rationale in content, f"rationale for {d.rule_id!r} missing from docs page"


# ---------------------------------------------------------------------------
# Attribution: lint output only ever emits registered rule ids
# ---------------------------------------------------------------------------


def test_openapi_lint_findings_all_carry_registered_rule_ids():
    spec = {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "1"},  # missing description
        "paths": {"/pets": {"get": {}}},  # missing summary
        "components": {
            "schemas": {
                "bad_name": {  # not PascalCase, missing description
                    "type": "object",
                    "properties": {
                        "items": {"type": "array"},  # unbounded array
                        "BadProp": {"type": "string"},  # bad property name, no example
                    },
                }
            }
        },
    }
    result = lint_openapi_spec(spec)
    assert result.findings  # the spec above trips several rules
    registered = set(builtin_rule_ids())
    for finding in result.findings:
        assert finding.rule in registered


def test_canonical_lint_findings_all_carry_registered_rule_ids():
    from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi

    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Orders"),
        version="1.0.0",
        # no description — trips common.api-missing-description
    )
    result = lint_canonical_model(api)
    assert result.findings
    registered = set(builtin_rule_ids())
    for finding in result.findings:
        assert finding.rule in registered
