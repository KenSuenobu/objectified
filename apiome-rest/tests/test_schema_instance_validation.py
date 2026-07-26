"""Corpus-driven tests for the JSON instance-validation core — IXH-5.1 (#5113).

Every schema here comes from the shipped corpus (``apiome-ui/examples/json-schema/``), selected
through :func:`tests.corpus_loader.load_corpus` rather than by hard-coded path, so a corpus
change is felt here immediately. The suite covers the three things the acceptance criteria name:

* **valid instances** — a hand-authored payload per fixture that must validate cleanly;
* **each major failure keyword** — one targeted mutation per keyword, asserting the failing
  keyword, the JSON Pointer it is reported at, and the expected/actual pair;
* **malformed instances and schemas** — a schema that is not a schema, and payloads that trip
  the reference, ordering, and bounding contracts.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Callable, Dict, List, Tuple

import pytest
from corpus_loader import EXAMPLES_DIR, CorpusEntry, ValidityClass, load_corpus

from app.schema_instance_validation import (
    DEFAULT_MAX_FINDINGS,
    MAX_REF_DEPTH,
    MAX_REF_FANOUT,
    build_reference_registry,
    validate_json_instance,
)

# ===========================================================================
# Corpus selection
# ===========================================================================


def _json_schema_entries() -> List[CorpusEntry]:
    """Every valid ``json-schema`` corpus entry, in manifest order."""
    return [
        entry
        for entry in load_corpus(format="json-schema", validity_class=ValidityClass.VALID)
        # Multi-file sets address their members through the root; a member alone is not a
        # standalone schema, so it is not a validation subject.
        if entry.fileset_role is None or entry.fileset_role.value == "root"
    ]


def _load(filename: str) -> Dict[str, Any]:
    """Load one corpus fixture by filename, asserting the corpus still ships it."""
    matches = [entry for entry in _json_schema_entries() if entry.path.endswith(f"/{filename}")]
    assert matches, f"corpus no longer ships json-schema/{filename}"
    return json.loads((EXAMPLES_DIR / matches[0].path).read_text(encoding="utf-8"))


# ===========================================================================
# Valid instances, one per fixture the keyword table exercises
# ===========================================================================

_PERSON_INSTANCE: Dict[str, Any] = {
    "firstName": "Ada",
    "lastName": "Lovelace",
    "age": 36,
    "email": "ada@example.com",
}

_PRODUCT_INSTANCE: Dict[str, Any] = {
    "id": 7,
    "name": "Desk lamp",
    "price": 42.5,
    "inStock": True,
    "tags": ["home", "lighting"],
    "category": "other",
    "dimensions": {"length": 10.0, "width": 4.0, "height": 30.0, "unit": "cm"},
}

_ADDRESS_BOOK_INSTANCE: Dict[str, Any] = {
    "contacts": [
        {
            "id": "3f1d2a5e-9d64-4d1e-8c3a-2b8f6d1c4a90",
            "name": {"first": "Grace", "last": "Hopper", "prefix": "Dr."},
            "address": {
                "street1": "1 Navy Way",
                "city": "Arlington",
                "state": "VA",
                "postalCode": "22202",
            },
            "phones": [{"type": "work", "number": "+1 (555) 010-0100"}],
            "emails": ["grace@example.com"],
        }
    ]
}

_CONDITIONAL_INSTANCE: Dict[str, Any] = {
    "form": {
        "name": "Ada",
        "employmentStatus": "employed",
        "employer": "Analytical Engines Ltd",
        "jobTitle": "Mathematician",
    },
    "address": {
        "country": "US",
        "street": "1 Bridge St",
        "city": "London",
        "region": "NY",
        "postalCode": "10001",
    },
}

_ADVANCED_INSTANCE: Dict[str, Any] = {
    "tuples": {"coordinates": [51.5, -0.12], "rgb": [10, 20, 30]},
    "patterns": {"name": "widget", "attr_color": "red", "num_size": 3, "is_active": True},
    "contains": {
        "mixedArray": [{"type": "required"}, {"type": "optional"}],
        "numbers": [1, 250],
    },
    "dependent": {
        "creditCard": "4111111111111111",
        "cvv": "123",
        "billingAddress": {"street": "1 Main St", "city": "Springfield", "zip": "11111"},
    },
    "propertyNames": {"alpha": "one", "betaTwo": "two"},
    "constEnum": {
        "apiVersion": "v1",
        "kind": "Service",
        "status": "running",
        "priority": 3,
    },
    "recursive": {
        "id": "root",
        "name": "Root",
        "value": None,
        "children": [{"id": "leaf", "name": "Leaf"}],
    },
    "nullable": {
        "requiredString": "present",
        "nullableString": None,
        "nullableNumber": 1.5,
        "optionalOrNull": None,
    },
}

_COMMERCE_FIXTURE = "10-comprehensive-ecommerce.json"

#: ``fixture filename -> a payload that must validate cleanly against it``.
_VALID_INSTANCES: Dict[str, Any] = {
    "01-simple-person.json": _PERSON_INSTANCE,
    "02-product-types.json": _PRODUCT_INSTANCE,
    "03-multiple-defs.json": _ADDRESS_BOOK_INSTANCE,
    "08-if-then-else.json": _CONDITIONAL_INSTANCE,
    "09-advanced-features.json": _ADVANCED_INSTANCE,
}


Mutation = Callable[[Dict[str, Any]], None]

#: ``(case id, fixture, mutation, expected keyword, expected instance pointer)``.
#:
#: Each row breaks exactly one constraint, which is what makes the assertion on the *keyword*
#: meaningful: if a mutation broke two things, the report would name whichever the validator
#: reached first and the test would be asserting iteration order rather than behavior.
_KEYWORD_CASES: List[Tuple[str, str, Mutation, str, str]] = [
    (
        "required",
        "01-simple-person.json",
        lambda i: i.pop("lastName"),
        "required",
        "",
    ),
    (
        "type",
        "01-simple-person.json",
        lambda i: i.__setitem__("age", "thirty-six"),
        "type",
        "/age",
    ),
    (
        "minimum",
        "01-simple-person.json",
        lambda i: i.__setitem__("age", -1),
        "minimum",
        "/age",
    ),
    (
        "maximum",
        "01-simple-person.json",
        lambda i: i.__setitem__("age", 4000),
        "maximum",
        "/age",
    ),
    (
        "minLength",
        "01-simple-person.json",
        lambda i: i.__setitem__("firstName", ""),
        "minLength",
        "/firstName",
    ),
    (
        "maxLength",
        "01-simple-person.json",
        lambda i: i.__setitem__("firstName", "a" * 101),
        "maxLength",
        "/firstName",
    ),
    (
        "enum",
        "02-product-types.json",
        lambda i: i.__setitem__("category", "furniture"),
        "enum",
        "/category",
    ),
    (
        "exclusiveMinimum",
        "02-product-types.json",
        lambda i: i.__setitem__("price", 0),
        "exclusiveMinimum",
        "/price",
    ),
    (
        "maxItems",
        "02-product-types.json",
        lambda i: i.__setitem__("tags", [f"t{n}" for n in range(11)]),
        "maxItems",
        "/tags",
    ),
    (
        "uniqueItems",
        "02-product-types.json",
        lambda i: i.__setitem__("tags", ["home", "home"]),
        "uniqueItems",
        "/tags",
    ),
    (
        "nested-required",
        "02-product-types.json",
        lambda i: i["dimensions"].pop("height"),
        "required",
        "/dimensions",
    ),
    (
        "pattern",
        "03-multiple-defs.json",
        lambda i: i["contacts"][0]["address"].__setitem__("postalCode", "not-a-zip"),
        "pattern",
        "/contacts/0/address/postalCode",
    ),
    (
        "ref-target-required",
        "03-multiple-defs.json",
        lambda i: i["contacts"][0]["name"].pop("last"),
        "required",
        "/contacts/0/name",
    ),
    (
        "if-then",
        "08-if-then-else.json",
        lambda i: i["form"].pop("jobTitle"),
        "required",
        "/form",
    ),
    (
        "const",
        "09-advanced-features.json",
        lambda i: i["constEnum"].__setitem__("apiVersion", "v2"),
        "const",
        "/constEnum/apiVersion",
    ),
    (
        "additionalProperties",
        "09-advanced-features.json",
        lambda i: i["patterns"].__setitem__("unmatched", "x"),
        "additionalProperties",
        "/patterns",
    ),
    (
        "patternProperties",
        "09-advanced-features.json",
        lambda i: i["patterns"].__setitem__("num_size", "not-a-number"),
        "type",
        "/patterns/num_size",
    ),
    (
        "propertyNames",
        "09-advanced-features.json",
        lambda i: i["propertyNames"].__setitem__("Bad-Name", "x"),
        "pattern",
        "/propertyNames",
    ),
    (
        "dependentRequired",
        "09-advanced-features.json",
        lambda i: i["dependent"].pop("cvv"),
        "dependentRequired",
        "/dependent",
    ),
    (
        "contains",
        "09-advanced-features.json",
        lambda i: i["contains"].__setitem__("numbers", [1, 2, 3]),
        "contains",
        "/contains/numbers",
    ),
    (
        "prefixItems",
        "09-advanced-features.json",
        lambda i: i["tuples"].__setitem__("rgb", ["red", 20, 30]),
        "type",
        "/tuples/rgb/0",
    ),
    (
        "recursive-required",
        "09-advanced-features.json",
        lambda i: i["recursive"]["children"][0].pop("name"),
        "required",
        "/recursive/children/0",
    ),
]


# ===========================================================================
# Valid instances
# ===========================================================================


@pytest.mark.parametrize("filename", sorted(_VALID_INSTANCES))
def test_valid_corpus_instance_passes(filename: str) -> None:
    """A payload authored to satisfy a corpus schema validates with no findings."""
    result = validate_json_instance(_load(filename), _VALID_INSTANCES[filename])

    assert result.validated is True
    assert result.findings == []
    assert result.valid is True
    assert result.diagnostics == []


def test_every_valid_corpus_schema_is_usable() -> None:
    """Every valid ``json-schema`` corpus fixture can be validated against.

    Guards the whole family, not just the fixtures the keyword table names: a corpus schema that
    stopped being a legal schema (or whose dialect fell out of the supported set) would make the
    service unable to check anything addressed to it.
    """
    entries = _json_schema_entries()
    assert entries, "the corpus ships no valid json-schema fixtures"

    for entry in entries:
        document = json.loads((EXAMPLES_DIR / entry.path).read_text(encoding="utf-8"))
        result = validate_json_instance(document, {})
        assert result.validated is True, f"{entry.path}: {result.diagnostics}"
        assert result.valid is not None
        assert [d.code for d in result.diagnostics] == [], entry.path


def test_draft07_corpus_schema_validates_under_its_own_dialect() -> None:
    """A draft-07 fixture is validated as draft-07, not silently upgraded to 2020-12."""
    document = _load("04-draft07-definitions.json")

    result = validate_json_instance(document, {})

    assert result.dialect == "07"
    assert result.validator == "jsonschema/07"
    assert result.validated is True


# ===========================================================================
# One failure keyword per case
# ===========================================================================


@pytest.mark.parametrize(
    "case_id,filename,mutate,keyword,pointer",
    _KEYWORD_CASES,
    ids=[case[0] for case in _KEYWORD_CASES],
)
def test_mutated_instance_reports_its_keyword(
    case_id: str,
    filename: str,
    mutate: Mutation,
    keyword: str,
    pointer: str,
) -> None:
    """Breaking exactly one constraint reports exactly that keyword, at the right pointer."""
    instance = copy.deepcopy(_VALID_INSTANCES[filename])
    mutate(instance)

    result = validate_json_instance(_load(filename), instance)

    assert result.validated is True
    assert result.valid is False, case_id
    matches = [f for f in result.findings if f.keyword == keyword and f.pointer == pointer]
    assert matches, (
        f"{case_id}: expected a {keyword!r} finding at {pointer!r}; got "
        + repr([(f.keyword, f.pointer) for f in result.findings])
    )
    finding = matches[0]
    assert finding.message
    assert finding.schema_pointer.startswith("/")


def test_finding_carries_expected_and_actual() -> None:
    """The expected/actual pair reproduces the keyword's value and the offending value."""
    instance = copy.deepcopy(_PERSON_INSTANCE)
    instance["age"] = "thirty-six"

    result = validate_json_instance(_load("01-simple-person.json"), instance)

    finding = next(f for f in result.findings if f.pointer == "/age")
    assert finding.keyword == "type"
    assert finding.expected == "integer"
    assert finding.actual == "thirty-six"
    assert finding.truncated is False
    assert finding.schema_pointer == "/properties/age/type"


def test_branch_failure_reports_headline_and_branch_causes() -> None:
    """A ``oneOf`` miss reports the branch keyword *and* why each branch failed."""
    document = _load("06-oneof-polymorphism.json")
    result = validate_json_instance(document, {"payment": {"method": {"type": "carrier-pigeon"}}})

    assert result.valid is False
    keywords = {f.keyword for f in result.findings}
    assert "oneOf" in keywords, keywords
    # The headline alone is never actionable; the branch causes must come with it.
    assert len(result.findings) > 1


def test_large_values_are_summarized_not_reproduced() -> None:
    """An oversized instance value is summarized, and the finding says it was."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"blob": {"type": "integer"}},
    }
    result = validate_json_instance(schema, {"blob": {"k": "v" * 2000}})

    finding = next(f for f in result.findings if f.pointer == "/blob")
    assert finding.truncated is True
    assert finding.actual == {"summary": "object with 1 property", "truncated": True}


# ===========================================================================
# Ordering
# ===========================================================================


def test_findings_are_deterministically_ordered() -> None:
    """Two runs over the same input produce byte-identical findings."""
    instance = copy.deepcopy(_PRODUCT_INSTANCE)
    instance.pop("name")
    instance["price"] = -1
    instance["category"] = "furniture"
    instance["tags"] = ["a", "a"]
    document = _load("02-product-types.json")

    first = validate_json_instance(document, instance)
    second = validate_json_instance(document, instance)

    assert [f.model_dump() for f in first.findings] == [f.model_dump() for f in second.findings]
    assert len(first.findings) >= 4


def test_array_indices_sort_numerically_not_lexically() -> None:
    """``/items/10`` sorts after ``/items/2`` — pointers order like the document, not like text."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "array",
        "items": {"type": "string"},
    }

    result = validate_json_instance(schema, list(range(12)))

    assert [f.pointer for f in result.findings] == [f"/{n}" for n in range(12)]


def test_findings_are_capped_but_the_true_total_is_reported() -> None:
    """``max_findings`` truncates the list and says so; the real count is never hidden."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "array",
        "items": {"type": "string"},
    }

    result = validate_json_instance(schema, list(range(50)), max_findings=5)

    assert len(result.findings) == 5
    assert result.total_findings == 50
    assert result.truncated is True
    assert result.valid is False


def test_default_finding_cap_is_applied() -> None:
    """With no explicit cap the documented default bounds the response."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "array",
        "items": {"type": "string"},
    }

    result = validate_json_instance(schema, list(range(DEFAULT_MAX_FINDINGS + 25)))

    assert len(result.findings) == DEFAULT_MAX_FINDINGS
    assert result.total_findings == DEFAULT_MAX_FINDINGS + 25


# ===========================================================================
# References: bounded, cycle-safe, never fetched
# ===========================================================================


def _registry_store() -> Dict[str, Dict[str, Any]]:
    """Two registry documents that reference each other — the canonical cycle."""
    return {
        "https://reg.test/a.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://reg.test/a.json",
            "type": "object",
            "properties": {"next": {"$ref": "b.json"}},
            "required": ["next"],
        },
        "https://reg.test/b.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://reg.test/b.json",
            "type": "object",
            "properties": {"back": {"$ref": "a.json"}, "leaf": {"type": "integer"}},
        },
    }


def test_reference_cycle_terminates_and_each_document_is_fetched_once() -> None:
    """``a → b → a`` resolves without looping, and no document is retrieved twice."""
    store = _registry_store()
    calls: List[str] = []

    def retrieve(uri: str) -> Any:
        calls.append(uri)
        return store.get(uri)

    root = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://reg.test/root.json",
        "$ref": "a.json",
    }
    result = validate_json_instance(
        root,
        {"next": {"back": {"next": {"leaf": "not-an-integer"}}}},
        base_uri="https://reg.test/root.json",
        retrieve=retrieve,
    )

    assert calls == ["https://reg.test/a.json", "https://reg.test/b.json"]
    assert result.validated is True
    assert result.valid is False
    assert any(f.keyword == "type" for f in result.findings)


def test_unresolvable_reference_is_reported_not_swallowed() -> None:
    """A ``$ref`` nothing can satisfy yields a diagnostic and refuses to claim a verdict."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": "https://example.com/absent.json",
    }

    result = validate_json_instance(
        schema, {"anything": True}, base_uri="https://example.com/root.json"
    )

    assert result.valid is None
    assert result.validated is False
    codes = [d.code for d in result.diagnostics]
    assert codes.count("INPUT_REFERENCE_UNRESOLVED") == 1, codes
    assert "absent.json" in result.diagnostics[0].message
    assert result.diagnostics[0].pointer == "/$ref"


def test_no_retriever_means_nothing_external_resolves() -> None:
    """Without a retriever an external ref is unresolvable — never a silent network fetch."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {"x": {"$ref": "https://json-schema.org/draft/2020-12/schema"}},
    }

    registry, diagnostics = build_reference_registry(schema, base_uri="https://reg.test/r.json")

    assert [d.code for d in diagnostics] == ["INPUT_REFERENCE_UNRESOLVED"]
    assert registry is not None


def test_reference_depth_is_bounded() -> None:
    """A reference chain longer than the depth ceiling stops, and says which ref it stopped at."""
    chain_length = MAX_REF_DEPTH + 3
    store = {
        f"https://reg.test/n{n}.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://reg.test/n{n}.json",
            "$ref": f"n{n + 1}.json",
        }
        for n in range(chain_length)
    }

    _registry, diagnostics = build_reference_registry(
        {"$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": "n0.json"},
        base_uri="https://reg.test/root.json",
        retrieve=store.get,
    )

    depth_stops = [d for d in diagnostics if d.code == "INPUT_DEPTH_LIMIT"]
    assert depth_stops, [d.code for d in diagnostics]
    assert str(MAX_REF_DEPTH) in depth_stops[0].message


def test_reference_fanout_is_bounded() -> None:
    """A document referencing more schemas than the fan-out ceiling stops, and says so."""
    count = MAX_REF_FANOUT + 5
    store = {
        f"https://reg.test/f{n}.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://reg.test/f{n}.json",
            "type": "object",
        }
        for n in range(count)
    }
    root = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {f"p{n}": {"$ref": f"f{n}.json"} for n in range(count)},
    }

    _registry, diagnostics = build_reference_registry(
        root, base_uri="https://reg.test/root.json", retrieve=store.get
    )

    fanout_stops = [d for d in diagnostics if d.code == "INPUT_EXPANSION_LIMIT"]
    assert len(fanout_stops) == 5
    assert str(MAX_REF_FANOUT) in fanout_stops[0].message


# ===========================================================================
# Malformed schemas and unsupported dialects
# ===========================================================================


def test_unusable_schema_refuses_to_return_a_verdict() -> None:
    """A stored document that is not a legal schema yields ``valid = None``, never ``True``."""
    result = validate_json_instance({"type": 17}, {"anything": True})

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["INPUT_SEMANTIC_INVALID"]
    assert result.findings == []


def test_top_level_array_schema_from_the_negative_corpus_is_rejected() -> None:
    """The corpus' deliberately-invalid top-level-array document cannot validate anything."""
    negative = [
        entry
        for entry in load_corpus(format="json-schema", validity_class=ValidityClass.INVALID)
        if entry.path.endswith("02-semantic-top-level-array.json")
    ]
    assert negative, "corpus no longer ships the top-level-array negative fixture"
    document = json.loads((EXAMPLES_DIR / negative[0].path).read_text(encoding="utf-8"))

    result = validate_json_instance(document, {})

    assert result.valid is None
    assert result.validated is False
    assert [d.code for d in result.diagnostics] == ["INPUT_SEMANTIC_INVALID"]


def test_unsupported_dialect_falls_back_and_says_so() -> None:
    """An unknown ``$schema`` draft is validated under 2020-12, with a diagnostic naming it."""
    schema = {
        "$schema": "https://json-schema.org/draft/1999-01/schema",
        "type": "object",
        "required": ["a"],
    }

    result = validate_json_instance(schema, {})

    assert result.dialect == "2020-12"
    assert result.validated is True
    assert [d.code for d in result.diagnostics] == ["FORMAT_VERSION_UNSUPPORTED"]
    assert "1999-01" in result.diagnostics[0].message


def test_format_is_annotation_by_default_and_asserted_on_request() -> None:
    """``format`` never fails a payload unless the caller opts in."""
    schema = _load("01-simple-person.json")
    instance = copy.deepcopy(_PERSON_INSTANCE)
    instance["email"] = "definitely-not-an-email"

    annotated = validate_json_instance(schema, instance)
    asserted = validate_json_instance(schema, instance, assert_formats=True)

    assert annotated.valid is True
    # The asserted run may still pass when the optional checker dependency is absent; what it
    # must never do is disagree by *reporting a different keyword*.
    assert {f.keyword for f in asserted.findings} <= {"format"}
