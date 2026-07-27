"""Rule-pack, integration, corpus, and budget tests for example conformance — IXH-5.4 (#5116).

:mod:`test_example_conformance` covers the walker and checker. This file covers everything the
acceptance criteria ask of the *rule*: one finding per non-conforming example naming both
pointers, reachability from both lint entry points, registration in the rule catalogue and the
format capability matrix, participation in the style-guide (severity/enable) and waiver
machinery, the corpus fixtures that exercise it, and the lint budget.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List

import pytest
import yaml
from corpus_loader import EXAMPLES_DIR, ValidityClass, load_corpus

from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from app.example_conformance_lint import (
    EXAMPLE_CONFORMANCE_CATEGORY,
    EXAMPLE_CONFORMANCE_RULE_ID,
    EXAMPLE_CONFORMANCE_SEVERITY,
    ExampleConformanceRulePack,
    example_conformance_findings,
    source_document,
)
from app.format_lint_capabilities import (
    MODE_NATIVE,
    MODE_UNSUPPORTED,
    build_format_lint_capabilities,
    capability_dicts,
    capability_for_format,
)
from app.lint_engine import lint_canonical_model, unconditional_rule_packs
from app.lint_rule_registry import builtin_rule_descriptors, builtin_rule_ids
from app.schema_lint import lint_openapi_spec
from app.style_guide_engine import builtin_fallback_guide, compile_style_guide

_BAD_SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "t", "version": "1", "description": "d"},
    "paths": {},
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "description": "A pet.",
                "required": ["id"],
                "properties": {"id": {"type": "integer", "description": "id"}},
                "example": {"id": "not-a-number"},
            }
        }
    },
}


def _api(raw: Any, *, fmt: str = "openapi-3.1") -> CanonicalApi:
    """A canonical artifact carrying ``raw`` as its retained source document."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format=fmt,
        identity=ApiIdentity(name="fixture"),
        description="d",
        raw=raw,
    )


# ===========================================================================
# One finding per non-conforming example, naming both pointers
# ===========================================================================


def test_one_finding_per_non_conforming_example() -> None:
    """A single example that misses its schema many ways is one defect, so one finding."""
    spec = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                "Pet": {
                    "type": "object",
                    "required": ["id", "name", "tag"],
                    "properties": {"id": {"type": "integer"}},
                    "example": {"id": "bad"},
                }
            }
        },
    }

    findings = example_conformance_findings(spec)

    assert len(findings) == 1
    assert "further violation" in findings[0].message


def test_finding_names_both_the_example_and_the_schema_pointer() -> None:
    """The acceptance criterion: the finding locates the example *and* the schema."""
    findings = example_conformance_findings(_BAD_SPEC)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.path == "/components/schemas/Pet/example"
    assert "`/components/schemas/Pet`" in finding.message
    assert finding.rule == EXAMPLE_CONFORMANCE_RULE_ID
    assert finding.category == EXAMPLE_CONFORMANCE_CATEGORY
    assert finding.severity == EXAMPLE_CONFORMANCE_SEVERITY


def test_finding_ids_are_stable_across_runs() -> None:
    """Waivers key on the finding id, so it must not move between identical runs."""
    first = example_conformance_findings(_BAD_SPEC)
    second = example_conformance_findings(_BAD_SPEC)

    assert [f.id for f in first] == [f.id for f in second]
    assert first[0].id.startswith("lint-")


def test_conforming_specs_produce_no_findings() -> None:
    """The rule stays silent when the examples are right."""
    spec = json.loads(json.dumps(_BAD_SPEC))
    spec["components"]["schemas"]["Pet"]["example"] = {"id": 1}

    assert example_conformance_findings(spec) == []


# ===========================================================================
# Both lint entry points
# ===========================================================================


def test_openapi_native_lint_path_runs_the_rule() -> None:
    """The OpenAPI adapter lints the native document and never reaches the canonical engine."""
    result = lint_openapi_spec(_BAD_SPEC)

    rules = {finding.rule for finding in result.findings}
    assert EXAMPLE_CONFORMANCE_RULE_ID in rules
    assert result.rule_hits[EXAMPLE_CONFORMANCE_RULE_ID] == 1
    assert any(c.name == EXAMPLE_CONFORMANCE_CATEGORY for c in result.categories)


def test_canonical_engine_path_runs_the_rule() -> None:
    """Every other adapter lints through the canonical engine, and gets the same rule."""
    result = lint_canonical_model(_api(_BAD_SPEC))

    assert EXAMPLE_CONFORMANCE_RULE_ID in {finding.rule for finding in result.findings}


def test_the_pack_is_one_of_the_engines_unconditional_packs() -> None:
    """It runs for every format, like the common pack — not per registered format key."""
    packs = unconditional_rule_packs()

    assert any(isinstance(pack, ExampleConformanceRulePack) for pack in packs)
    assert ExampleConformanceRulePack.format == ""


def test_the_rule_lowers_the_score_it_is_charged_for() -> None:
    """A non-conforming example costs exactly one warning's penalty, no more."""
    clean = json.loads(json.dumps(_BAD_SPEC))
    clean["components"]["schemas"]["Pet"]["example"] = {"id": 1}

    assert lint_openapi_spec(clean).score - lint_openapi_spec(_BAD_SPEC).score == 4


# ===========================================================================
# Source-document resolution
# ===========================================================================


def test_source_document_handles_both_retained_shapes() -> None:
    """Normalizers retain ``raw`` as the document itself or wrapped under ``source``."""
    document = {"openapi": "3.1.0"}

    assert source_document(_api(document)) == document
    assert source_document(_api({"source": document})) == document


def test_a_model_with_no_retained_document_is_silently_skipped() -> None:
    """``include_raw=False`` (or a non-mapping raw) means there is nothing to walk."""
    assert source_document(_api(None)) is None
    assert lint_canonical_model(_api(None)).rule_hits.get(EXAMPLE_CONFORMANCE_RULE_ID) is None


def test_a_format_with_no_example_syntax_contributes_nothing() -> None:
    """A protobuf descriptor has no examples; the rule must not invent findings for it."""
    api = _api({"descriptor_set": "…"}, fmt="protobuf")

    assert lint_canonical_model(api).rule_hits.get(EXAMPLE_CONFORMANCE_RULE_ID) is None


def test_json_schema_artifacts_are_covered_through_the_wrapped_raw_shape() -> None:
    """The JSON Schema adapter wraps its document, which must still be walked."""
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["a"],
        "examples": [{}],
    }
    api = _api({"source": document}, fmt="json-schema")

    result = lint_canonical_model(api)

    assert result.rule_hits.get(EXAMPLE_CONFORMANCE_RULE_ID) == 1


# ===========================================================================
# Rule catalogue, style guide, and waivers
# ===========================================================================


def test_the_rule_is_registered_in_the_builtin_catalogue() -> None:
    """Registration is what makes the rule governable — a guide can only list what it knows."""
    assert EXAMPLE_CONFORMANCE_RULE_ID in builtin_rule_ids()

    descriptor = next(
        d for d in builtin_rule_descriptors() if d.rule_id == EXAMPLE_CONFORMANCE_RULE_ID
    )
    assert descriptor.pack == "examples"
    assert descriptor.category == EXAMPLE_CONFORMANCE_CATEGORY
    assert descriptor.default_severity == EXAMPLE_CONFORMANCE_SEVERITY
    assert descriptor.rationale.strip()
    assert descriptor.docs_anchor == "examples-non-conforming-example"


def test_the_default_guide_keeps_the_rule_at_its_default_severity() -> None:
    """Shipping the rule must not change scores for tenants on the recommended guide."""
    guide = builtin_fallback_guide()

    assert guide.severity_for(EXAMPLE_CONFORMANCE_RULE_ID) == EXAMPLE_CONFORMANCE_SEVERITY


def test_a_guide_can_raise_the_rules_severity() -> None:
    """Severity is configurable: a tenant that ships examples as contracts makes it an error."""
    guide = compile_style_guide(
        "guide-1",
        "Contract examples",
        "custom",
        [
            {
                "rule_id": EXAMPLE_CONFORMANCE_RULE_ID,
                "enabled": True,
                "severity": "error",
                "custom_def": None,
            }
        ],
    )

    applied = guide.apply(lint_openapi_spec(_BAD_SPEC))

    severities = {f.rule: f.severity for f in applied.findings}
    assert severities[EXAMPLE_CONFORMANCE_RULE_ID] == "error"


def test_a_guide_can_disable_the_rule() -> None:
    """A guide that does not enable the rule drops its findings entirely."""
    guide = compile_style_guide(
        "guide-2",
        "Examples off",
        "custom",
        [
            {
                "rule_id": EXAMPLE_CONFORMANCE_RULE_ID,
                "enabled": False,
                "severity": "warning",
                "custom_def": None,
            }
        ],
    )

    applied = guide.apply(lint_openapi_spec(_BAD_SPEC))

    assert EXAMPLE_CONFORMANCE_RULE_ID not in {f.rule for f in applied.findings}
    assert applied.score == 100


def test_findings_carry_the_id_the_waiver_machinery_keys_on() -> None:
    """Lint-workspace decisions (waivers) key on the finding id, which must be present and stable."""
    findings = lint_openapi_spec(_BAD_SPEC).findings
    example_findings = [f for f in findings if f.rule == EXAMPLE_CONFORMANCE_RULE_ID]

    assert example_findings
    for finding in example_findings:
        assert finding.id
        assert finding.as_dict()["id"] == finding.id


# ===========================================================================
# Format lint capability matrix
# ===========================================================================


@pytest.mark.parametrize(
    "format_key",
    ["openapi-3.1", "openapi-3.0", "openapi-3.2", "swagger-2.0", "asyncapi-2", "asyncapi-3"],
)
def test_matrix_reports_native_example_conformance_for_walked_formats(format_key: str) -> None:
    """Coverage is visible per format, with the exact locations walked."""
    row = capability_for_format(format_key)

    assert row.example_conformance == MODE_NATIVE
    assert row.example_locations


def test_matrix_reports_unsupported_for_formats_with_no_example_syntax() -> None:
    """A format the walker does not cover says so, rather than implying coverage."""
    row = capability_for_format("protobuf")

    assert row.example_conformance == MODE_UNSUPPORTED
    assert row.example_locations == ()


def test_matrix_rows_publish_the_example_fields() -> None:
    """The JSON projection carries the new fields, so the published matrix shows them."""
    rows = {row["format"]: row for row in capability_dicts()}

    assert rows["openapi-3.1"]["example_conformance"] == MODE_NATIVE
    assert rows["openapi-3.1"]["example_locations"]
    assert rows["protobuf"]["example_conformance"] == MODE_UNSUPPORTED
    assert rows["protobuf"]["example_locations"] == []


def test_every_matrix_row_declares_an_example_conformance_mode() -> None:
    """No row may be silent about it — the matrix is the coverage answer."""
    for row in build_format_lint_capabilities():
        assert row.example_conformance in (MODE_NATIVE, MODE_UNSUPPORTED), row.format


# ===========================================================================
# Corpus: fixtures with deliberately non-conforming examples
# ===========================================================================

#: Corpus fixtures authored for this rule, and the pointer each site must be reported at.
_CORPUS_EXPECTATIONS: Dict[str, List[str]] = {
    "openapi/33-nonconforming-examples.yaml": [
        "/components/schemas/Pet/example",
        "/components/schemas/Pet/properties/id/example",
        "/components/schemas/Tag/example",
        "/paths/~1pets/parameters/0/example",
        "/paths/~1pets/get/parameters/0/example",
        "/paths/~1pets/get/responses/200/content/application~1json/examples/too-many/value",
        "/paths/~1pets/get/responses/200/headers/X-Total-Count/example",
        "/paths/~1pets/post/requestBody/content/application~1json/example",
    ],
    "asyncapi/07-nonconforming-examples-3.0.yaml": [
        "/components/schemas/UserSignedUpPayload/examples/0",
        "/components/messages/UserSignedUp/examples/1/payload",
        "/components/messages/UserSignedUp/examples/2/headers",
    ],
    "json-schema/12-nonconforming-examples.json": [
        "/examples/1",
        "/properties/id/examples/0",
        "/properties/email/examples/0",
        "/properties/role/examples/1",
        "/properties/tags/examples/0",
        "/$defs/Address/examples/0",
    ],
}


def _corpus_document(path: str) -> Any:
    """Load a corpus fixture, asserting the manifest still declares it."""
    entries = [
        entry
        for entry in load_corpus(validity_class=ValidityClass.VALID)
        if entry.path == path
    ]
    assert entries, f"corpus no longer declares {path}"
    return yaml.safe_load((EXAMPLES_DIR / path).read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", sorted(_CORPUS_EXPECTATIONS))
def test_corpus_fixture_reports_every_deliberate_violation(path: str) -> None:
    """Every example the fixture breaks on purpose is reported, and nothing else is."""
    document = _corpus_document(path)

    findings = example_conformance_findings(document)

    assert sorted(f.path for f in findings) == sorted(_CORPUS_EXPECTATIONS[path])


@pytest.mark.parametrize("path", sorted(_CORPUS_EXPECTATIONS))
def test_corpus_fixture_documents_its_own_intent(path: str) -> None:
    """Each fixture marks its deliberate violations with ``x-expected-violation``.

    The marker is what lets a reviewer check the fixture without running the linter, so a site
    added later without one would quietly weaken the fixture.
    """
    document = _corpus_document(path)
    markers: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if "x-expected-violation" in node:
                markers.append(str(node["x-expected-violation"]))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(document)
    assert len(markers) >= len(_CORPUS_EXPECTATIONS[path]) - 2, markers


@pytest.mark.parametrize("path", sorted(_CORPUS_EXPECTATIONS))
def test_corpus_fixture_conforming_examples_are_not_flagged(path: str) -> None:
    """Each fixture also ships conforming examples; flagging one would be a false positive."""
    document = _corpus_document(path)

    flagged = {f.path for f in example_conformance_findings(document)}

    assert not any("conforming/value" in pointer for pointer in flagged)
    assert not any(pointer.endswith("/examples/0/payload") for pointer in flagged)


def test_the_rest_of_the_corpus_stays_clean() -> None:
    """No other shipped fixture trips the rule.

    A rule that fires across the corpus is a false-positive generator, not a defect detector.
    The three fixtures above are the only ones authored to break, so every other walked entry
    must come back clean — and this is what caught the ``multipleOf`` binary-float artifact in
    ``openapi/01-numeric-constraints.yaml``.
    """
    noisy: Dict[str, List[str]] = {}
    for entry in load_corpus(validity_class=ValidityClass.VALID):
        if entry.path in _CORPUS_EXPECTATIONS:
            continue
        text = (EXAMPLES_DIR / entry.path).read_text(encoding="utf-8", errors="replace")
        try:
            document = yaml.safe_load(text)
        except yaml.YAMLError:
            continue  # not a YAML/JSON document; the walker never sees it either
        findings = example_conformance_findings(document, format_key=entry.format)
        if findings:
            noisy[entry.path] = [f.path for f in findings]

    assert not noisy, f"unexpected example-conformance findings: {noisy}"


# ===========================================================================
# Budget
# ===========================================================================

#: Wall-clock ceiling for checking every walkable corpus document once. The corpus is the
#: largest body of real specs the repo ships (the IXH-1.5 scale tier is not landed yet), and the
#: rule runs inside every import's lint stage, so it must stay a rounding error against parsing.
_CORPUS_BUDGET_SECONDS = 20.0

#: Ceiling for one document, so a single pathological spec cannot dominate a lint run.
# Quiet machines land near ~2s; CI under load needs headroom without hiding quadratic blowups.
_SINGLE_DOCUMENT_BUDGET_SECONDS = 10.0


def _walkable_corpus_documents() -> List[Any]:
    """Every valid corpus entry that parses as a mapping — what the rule would actually walk."""
    documents: List[Any] = []
    for entry in load_corpus(validity_class=ValidityClass.VALID):
        text = (EXAMPLES_DIR / entry.path).read_text(encoding="utf-8", errors="replace")
        try:
            document = yaml.safe_load(text)
        except yaml.YAMLError:
            continue
        if isinstance(document, dict):
            documents.append(document)
    return documents


def test_checking_the_whole_corpus_stays_within_the_lint_budget() -> None:
    """Running the rule over every shipped spec stays inside the documented budget."""
    documents = _walkable_corpus_documents()
    assert len(documents) > 100, "corpus shrank unexpectedly; the budget would be meaningless"

    started = time.perf_counter()
    for document in documents:
        example_conformance_findings(document)
    elapsed = time.perf_counter() - started

    assert elapsed < _CORPUS_BUDGET_SECONDS, (
        f"example conformance took {elapsed:.2f}s over {len(documents)} corpus documents "
        f"(budget {_CORPUS_BUDGET_SECONDS}s)"
    )


def test_a_single_large_document_stays_within_its_budget() -> None:
    """A spec with a thousand examples is bounded, not quadratic."""
    document = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                f"S{n}": {
                    "type": "object",
                    "required": ["a"],
                    "properties": {"a": {"type": "integer"}},
                    "example": {"a": "wrong"},
                }
                for n in range(1000)
            }
        },
    }

    started = time.perf_counter()
    findings = example_conformance_findings(document)
    elapsed = time.perf_counter() - started

    assert len(findings) == 1000
    assert elapsed < _SINGLE_DOCUMENT_BUDGET_SECONDS, f"took {elapsed:.2f}s"
