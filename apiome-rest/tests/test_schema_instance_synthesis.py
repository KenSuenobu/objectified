"""Tests for the sample-payload synthesizer — IXH-5.2 (#5114).

The suite is organised around the ticket's acceptance criteria, one section each:

* generation is deterministic for a schema and seed;
* the minimal and full instances validate cleanly under IXH-5.1;
* every mutant fails with exactly the intended keyword and nothing else;
* schema-provided ``examples`` / ``default`` values win, and provenance records which;
* recursive and cyclic schemas terminate inside the documented depth bound;
* everything returned is labelled synthetic.

The first three run over every ``json-schema`` corpus fixture as well as over hand-written
schemas, selected through :func:`tests.corpus_loader.load_corpus` rather than by path, so a
corpus change is felt here immediately.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest
from corpus_loader import EXAMPLES_DIR, CorpusEntry, ValidityClass, load_corpus
from jsonschema.validators import Draft202012Validator

from app.intake_error_taxonomy import INTAKE_ERROR_TAXONOMY
from app.schema_instance_synthesis import (
    DEFAULT_MAX_MUTANTS,
    MAX_PROVENANCE_ENTRIES,
    MAX_SYNTHESIS_DEPTH,
    MUTATION_ADDITIONAL_PROPERTIES,
    MUTATION_BOUND_EXCEEDED,
    MUTATION_DISCRIMINATOR_MISMATCHED,
    MUTATION_ENUM_OUT_OF_RANGE,
    MUTATION_KINDS,
    MUTATION_PATTERN_VIOLATED,
    MUTATION_REQUIRED_MISSING,
    MUTATION_TYPE_WRONG,
    RECURSION_TAIL_DEPTH,
    SYNTHETIC_EXTRA_PROPERTY,
    SynthesisResult,
    synthesize_instances,
)
from app.schema_instance_validation import validate_json_instance

# ===========================================================================
# Corpus selection and helpers
# ===========================================================================

#: Branch keywords a violation may legitimately be *reported* through: a constraint declared
#: inside a combinator is always reported as the combinator, never as itself.
_ENVELOPES = {"anyOf", "oneOf", "not"}


def _json_schema_entries() -> List[CorpusEntry]:
    """Every valid ``json-schema`` corpus entry, in manifest order."""
    return [
        entry
        for entry in load_corpus(format="json-schema", validity_class=ValidityClass.VALID)
        # A multi-file set is addressed through its root; a member alone is not a schema.
        if entry.fileset_role is None or entry.fileset_role.value == "root"
    ]


def _corpus_schema(entry: CorpusEntry) -> Dict[str, Any]:
    """Load one corpus fixture's schema document."""
    return json.loads((EXAMPLES_DIR / entry.path).read_text(encoding="utf-8"))


def _fingerprint(result: SynthesisResult) -> str:
    """Canonical JSON of everything a run produced, for byte-identity comparisons."""
    return json.dumps(
        {
            "instances": [instance.model_dump() for instance in result.instances],
            "diagnostics": [diagnostic.model_dump() for diagnostic in result.diagnostics],
            "seed": result.seed,
            "rejected": result.rejected_mutants,
        },
        sort_keys=True,
    )


def _top_level_errors(schema: Dict[str, Any], instance: Any) -> List[Any]:
    """Root-cause validation errors, without the branch sub-errors IXH-5.1 flattens in."""
    return list(Draft202012Validator(schema).iter_errors(instance))


def _pointer(parts: Any) -> str:
    """Render a ``jsonschema`` error path as an RFC 6901 pointer."""
    return "".join(
        "/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts
    )


# ===========================================================================
# Schemas exercising each construct the synthesizer must handle
# ===========================================================================

_PERSON: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "pattern": "^[A-Z]{2}-[0-9]{3}$"},
        "name": {"type": "string", "minLength": 1, "maxLength": 10},
        "age": {"type": "integer", "minimum": 0, "maximum": 120},
        "status": {"type": "string", "enum": ["active", "pending"]},
        "email": {"type": "string", "format": "email", "default": "ada@example.com"},
        "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3},
    },
    "required": ["id", "name"],
}

_DISCRIMINATED: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["shape"],
    "properties": {
        "shape": {
            "discriminator": {"propertyName": "kind"},
            "oneOf": [
                {
                    "type": "object",
                    "required": ["kind", "radius"],
                    "properties": {
                        "kind": {"const": "circle"},
                        "radius": {"type": "number"},
                    },
                },
                {
                    "type": "object",
                    "required": ["kind", "side"],
                    "properties": {
                        "kind": {"const": "square"},
                        "side": {"type": "number"},
                    },
                },
            ],
        }
    },
}

_CONDITIONAL: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {"country": {"type": "string", "enum": ["US", "CA"]}},
    "required": ["country"],
    "if": {"properties": {"country": {"const": "US"}}, "required": ["country"]},
    "then": {"required": ["zip"], "properties": {"zip": {"type": "string"}}},
    "else": {"required": ["postal"], "properties": {"postal": {"type": "string"}}},
}

_RECURSIVE: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$defs": {
        "Node": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string"},
                "child": {"$ref": "#/$defs/Node"},
                "children": {"type": "array", "items": {"$ref": "#/$defs/Node"}},
            },
        }
    },
    "$ref": "#/$defs/Node",
}


# ===========================================================================
# Determinism
# ===========================================================================


@pytest.mark.parametrize("entry", _json_schema_entries(), ids=lambda entry: entry.path)
def test_corpus_generation_is_byte_identical_for_one_seed(entry: CorpusEntry) -> None:
    """The same schema and seed produce byte-identical output, fixture by fixture."""
    schema = _corpus_schema(entry)
    assert _fingerprint(synthesize_instances(schema, seed=11)) == _fingerprint(
        synthesize_instances(schema, seed=11)
    )


def test_a_different_seed_changes_synthesized_values() -> None:
    """The seed is real: it changes invented values (and only those)."""
    first = synthesize_instances(_PERSON, seed=1).instances[1].instance
    second = synthesize_instances(_PERSON, seed=2).instances[1].instance
    assert first != second
    # An authored value is not a synthesized one, so it never moves with the seed.
    assert first["email"] == second["email"] == "ada@example.com"


def test_instance_ids_are_stable_across_runs() -> None:
    """Ids are reproducible, so a caller can pin one generated case in a test suite."""
    ids = [instance.id for instance in synthesize_instances(_PERSON, seed=5).instances]
    assert ids == [instance.id for instance in synthesize_instances(_PERSON, seed=5).instances]
    assert len(set(ids)) == len(ids), "instance ids must be unique within a result"


# ===========================================================================
# Valid instances
# ===========================================================================


@pytest.mark.parametrize("entry", _json_schema_entries(), ids=lambda entry: entry.path)
def test_corpus_valid_instances_satisfy_their_schema(entry: CorpusEntry) -> None:
    """Every instance the generator marks as valid really is, for every corpus fixture."""
    schema = _corpus_schema(entry)
    result = synthesize_instances(schema, seed=3)
    for instance in result.instances:
        if not instance.expected_valid:
            continue
        assert instance.valid is True, (
            f"{entry.path}: {instance.id} was generated as a valid instance but reports "
            f"{[(f.pointer, f.keyword) for f in instance.findings]}"
        )
        # Independently re-validated, so the assertion does not lean on the generator's own
        # bookkeeping.
        assert validate_json_instance(schema, instance.instance).valid is True


def test_minimal_carries_only_required_properties() -> None:
    """The minimal instance is genuinely minimal."""
    minimal = synthesize_instances(_PERSON, seed=1).instances[0]
    assert minimal.id == "minimal"
    assert sorted(minimal.instance) == ["id", "name"]


def test_full_carries_every_optional_property() -> None:
    """The full instance populates everything the schema declares."""
    full = synthesize_instances(_PERSON, seed=1).instances[1]
    assert full.id == "full"
    assert sorted(full.instance) == ["age", "email", "id", "name", "status", "tags"]


def test_generated_values_respect_their_constraints() -> None:
    """Bounds, patterns, and formats are honoured rather than validated away afterwards."""
    full = synthesize_instances(_PERSON, seed=4).instances[1].instance
    assert 0 <= full["age"] <= 120
    assert 1 <= len(full["name"]) <= 10
    assert 1 <= len(full["tags"]) <= 3
    assert full["id"][:2].isalpha() and full["id"][3:].isdigit()


def test_include_flags_select_what_is_generated() -> None:
    """A caller that wants only mutants gets only mutants."""
    result = synthesize_instances(
        _PERSON, seed=1, include_minimal=False, include_full=False, include_branches=False
    )
    assert {instance.kind for instance in result.instances} == {"mutant"}


# ===========================================================================
# Branch coverage
# ===========================================================================


def test_one_instance_per_oneof_branch() -> None:
    """Each ``oneOf`` alternative gets its own valid instance."""
    result = synthesize_instances(_DISCRIMINATED, seed=1)
    kinds = {
        instance.instance["shape"]["kind"]
        for instance in result.instances
        if instance.expected_valid
    }
    assert kinds == {"circle", "square"}
    branch = next(instance for instance in result.instances if instance.kind == "branch")
    assert branch.branch is not None
    assert branch.branch.keyword == "oneOf"
    assert branch.branch.label == "oneOf[1]"


def test_if_then_and_else_arms_are_both_covered() -> None:
    """``if``/``then``/``else`` yields an instance that takes the condition and one that does not."""
    result = synthesize_instances(_CONDITIONAL, seed=1)
    valid = [instance for instance in result.instances if instance.expected_valid]
    assert any("zip" in instance.instance for instance in valid), "the `then` arm is missing"
    assert any("postal" in instance.instance for instance in valid), "the `else` arm is missing"
    for instance in valid:
        assert instance.valid is True


def test_duplicate_branch_payloads_are_not_returned_twice() -> None:
    """Alternatives that generate the same payload add no coverage and are dropped."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "anyOf": [{"properties": {"a": {"type": "string"}}}, {"properties": {"a": {"type": "string"}}}],
    }
    payloads = [
        json.dumps(instance.instance, sort_keys=True)
        for instance in synthesize_instances(schema, seed=1).instances
        if instance.expected_valid
    ]
    assert len(payloads) == len(set(payloads))


def test_branch_instances_are_capped_and_the_cap_is_reported() -> None:
    """``max_branch_instances`` binds, and the truncation is not silent."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["value"],
        "properties": {
            "value": {"oneOf": [{"const": "a"}, {"const": "b"}, {"const": "c"}]},
        },
    }
    result = synthesize_instances(schema, seed=1, max_branch_instances=1)
    assert len([i for i in result.instances if i.kind == "branch"]) == 1
    assert result.branches_truncated is True


# ===========================================================================
# Mutants
# ===========================================================================


@pytest.mark.parametrize("entry", _json_schema_entries(), ids=lambda entry: entry.path)
def test_corpus_mutants_break_exactly_one_constraint(entry: CorpusEntry) -> None:
    """Each mutant fails, fails once, and fails at the constraint it claims to target."""
    schema = _corpus_schema(entry)
    result = synthesize_instances(schema, seed=3)
    for instance in result.instances:
        if instance.kind != "mutant":
            continue
        assert instance.expected_valid is False
        assert instance.valid is False, f"{entry.path}: {instance.id} did not fail at all"

        errors = _top_level_errors(schema, instance.instance)
        assert len(errors) == 1, (
            f"{entry.path}: {instance.id} provoked {len(errors)} independent violations; a "
            "mutant must isolate exactly one"
        )
        mutation = instance.mutation
        assert mutation is not None
        assert str(errors[0].validator) == mutation.reported_keyword
        assert _pointer(errors[0].absolute_path) == mutation.reported_pointer
        # The reported keyword is the targeted one, or the combinator that encloses it.
        assert (
            mutation.reported_keyword == mutation.keyword
            or mutation.reported_keyword in _ENVELOPES
        )


@pytest.mark.parametrize(
    ("kind", "schema"),
    [
        (MUTATION_REQUIRED_MISSING, _PERSON),
        (MUTATION_TYPE_WRONG, _PERSON),
        (MUTATION_ENUM_OUT_OF_RANGE, _PERSON),
        (MUTATION_PATTERN_VIOLATED, _PERSON),
        (MUTATION_BOUND_EXCEEDED, _PERSON),
        (MUTATION_ADDITIONAL_PROPERTIES, _PERSON),
        (MUTATION_DISCRIMINATOR_MISMATCHED, _DISCRIMINATED),
    ],
)
def test_every_mutation_kind_is_produced_where_the_schema_affords_it(
    kind: str, schema: Dict[str, Any]
) -> None:
    """All seven kinds the ticket names are implemented, not just declared."""
    result = synthesize_instances(schema, seed=1)
    produced = {
        instance.mutation.kind for instance in result.instances if instance.mutation is not None
    }
    assert kind in produced


def test_mutation_kinds_filter_restricts_the_set() -> None:
    """A caller can ask for one kind of negative test."""
    result = synthesize_instances(_PERSON, seed=1, mutation_kinds=[MUTATION_REQUIRED_MISSING])
    kinds = {i.mutation.kind for i in result.instances if i.mutation is not None}
    assert kinds == {MUTATION_REQUIRED_MISSING}


def test_the_mutant_cap_keeps_every_kind_represented() -> None:
    """A low cap selects round-robin, so it never collapses the set to one kind."""
    uncapped = synthesize_instances(_PERSON, seed=1)
    all_kinds = {i.mutation.kind for i in uncapped.instances if i.mutation is not None}
    capped = synthesize_instances(_PERSON, seed=1, max_mutants=len(all_kinds))
    capped_kinds = {i.mutation.kind for i in capped.instances if i.mutation is not None}
    assert capped_kinds == all_kinds
    assert capped.mutants_truncated is True


def test_additional_property_mutant_injects_a_namespaced_key() -> None:
    """The injected property is self-describing and cannot collide with a real one."""
    result = synthesize_instances(_PERSON, seed=1)
    mutant = next(
        instance
        for instance in result.instances
        if instance.mutation is not None
        and instance.mutation.kind == MUTATION_ADDITIONAL_PROPERTIES
    )
    assert SYNTHETIC_EXTRA_PROPERTY in mutant.instance
    assert mutant.mutation.keyword == "additionalProperties"


def test_discriminator_mutant_names_no_declared_variant() -> None:
    """A discriminator mutant fails through the combinator that declares the variants."""
    result = synthesize_instances(_DISCRIMINATED, seed=1)
    mutant = next(
        instance
        for instance in result.instances
        if instance.mutation is not None
        and instance.mutation.kind == MUTATION_DISCRIMINATOR_MISMATCHED
    )
    assert mutant.instance["shape"]["kind"] not in ("circle", "square")
    assert mutant.mutation.keyword == "oneOf"
    assert mutant.valid is False


def test_a_mutation_that_does_not_fail_is_dropped_and_counted() -> None:
    """A "negative" payload that the schema accepts is not a test; it is discarded."""
    # Removing the optional `country` makes the `if` not match, so the `else` arm applies and
    # the payload stays valid — the candidate must not be shipped as a mutant.
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"flag": {"type": "boolean"}, "extra": {"type": "string"}},
        "if": {"properties": {"flag": {"const": True}}, "required": ["flag"]},
        "then": {"required": ["extra"]},
    }
    result = synthesize_instances(schema, seed=1)
    assert result.rejected_mutants >= 1
    assert any(
        diagnostic.code == "SYNTHESIS_UNSUPPORTED_CONSTRUCT"
        for diagnostic in result.diagnostics
    )
    for instance in result.instances:
        if instance.kind == "mutant":
            assert instance.valid is False


def test_mutants_record_what_they_changed() -> None:
    """Every mutant explains itself: the constraint, the pointer, and both values."""
    result = synthesize_instances(_PERSON, seed=1)
    mutant = next(
        instance
        for instance in result.instances
        if instance.mutation is not None and instance.mutation.kind == MUTATION_BOUND_EXCEEDED
    )
    assert mutant.derived_from == "full"
    assert mutant.mutation.pointer.startswith("/")
    assert mutant.mutation.description
    assert mutant.mutation.original != mutant.mutation.mutated


# ===========================================================================
# Author intent and provenance
# ===========================================================================


def test_authored_values_are_preferred_and_recorded() -> None:
    """``const``, ``examples``, ``default``, and ``enum`` win, in that order, and are labelled."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["kind", "name", "size", "colour", "free"],
        "properties": {
            "kind": {"const": "widget"},
            "name": {"type": "string", "examples": ["Sprocket"], "default": "ignored"},
            "size": {"type": "integer", "default": 42},
            "colour": {"type": "string", "enum": ["red", "green"]},
            "free": {"type": "string"},
        },
    }
    result = synthesize_instances(schema, seed=1)
    minimal = result.instances[0]
    assert minimal.instance["kind"] == "widget"
    assert minimal.instance["name"] == "Sprocket"
    assert minimal.instance["size"] == 42
    assert minimal.instance["colour"] == "red"

    origins = {entry.pointer: entry for entry in minimal.provenance}
    assert origins["/kind"].origin == "const"
    assert origins["/name"].origin == "example"
    assert origins["/size"].origin == "default"
    assert origins["/colour"].origin == "enum"
    assert origins["/free"].origin == "synthesized"
    # Only invented values are synthetic; a value copied from the schema is the author's.
    assert [pointer for pointer, entry in origins.items() if entry.synthetic] == ["/free", ""]


def test_a_non_conforming_authored_example_is_rejected_not_propagated() -> None:
    """An example that contradicts its own schema is replaced, and the fact is reported.

    This is the IXH-5.4 ``examples.non-conforming-example`` condition seen from the other
    side: lint reports it on the schema, and synthesis must not bake it into every payload.
    """
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["count"],
        "properties": {"count": {"type": "integer", "minimum": 1, "examples": [0]}},
    }
    result = synthesize_instances(schema, seed=1)
    minimal = result.instances[0]
    assert minimal.instance["count"] >= 1
    assert minimal.valid is True
    assert any(
        diagnostic.code == "INPUT_SEMANTIC_INVALID"
        and "does not satisfy its own schema" in diagnostic.message
        for diagnostic in result.diagnostics
    )


def test_provenance_is_truncated_rather_than_unbounded() -> None:
    """A very wide schema reports its provenance as truncated instead of growing without limit."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {f"p{index}": {"type": "string"} for index in range(600)},
    }
    full = synthesize_instances(schema, seed=1, include_mutants=False).instances[1]
    assert len(full.provenance) == MAX_PROVENANCE_ENTRIES
    assert full.provenance_truncated is True


# ===========================================================================
# Synthetic labelling
# ===========================================================================


def test_every_instance_is_labelled_synthetic() -> None:
    """Nothing this module returns can be mistaken for captured data."""
    result = synthesize_instances(_PERSON, seed=1)
    assert result.instances
    assert all(instance.synthetic is True for instance in result.instances)


# ===========================================================================
# Recursion, cycles, and other bounds
# ===========================================================================


def test_a_recursive_schema_terminates_and_stays_valid() -> None:
    """Recursion through optional structure is dropped, not padded with placeholders."""
    result = synthesize_instances(_RECURSIVE, seed=1)
    for instance in result.instances:
        if instance.expected_valid:
            assert instance.valid is True
    full = result.instances[1].instance
    depth = 0
    node = full
    while isinstance(node, dict) and "child" in node:
        depth += 1
        node = node["child"]
    assert depth <= MAX_SYNTHESIS_DEPTH + RECURSION_TAIL_DEPTH


def test_a_required_cycle_terminates_and_says_why() -> None:
    """A schema no finite payload satisfies still returns, with the reason named."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": {
            "Node": {
                "type": "object",
                "required": ["child"],
                "properties": {"child": {"$ref": "#/$defs/Node"}},
            }
        },
        "$ref": "#/$defs/Node",
    }
    result = synthesize_instances(schema, seed=1)
    assert result.instances  # it returns rather than hanging or raising
    assert any(
        diagnostic.code == "INPUT_DEPTH_LIMIT" for diagnostic in result.diagnostics
    )


def test_a_self_merging_schema_terminates() -> None:
    """``{"allOf": [{"$ref": "#"}]}`` flattens forever unless the re-entry guard holds."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "allOf": [{"$ref": "#"}],
        "properties": {"a": {"type": "string"}},
    }
    result = synthesize_instances(schema, seed=1)
    # The schema is infinitely recursive for the validator too, so nothing can be verified —
    # which must be reported as "not checked", never as a pass.
    assert all(instance.valid is None for instance in result.instances)
    assert any(diagnostic.code == "INPUT_DEPTH_LIMIT" for diagnostic in result.diagnostics)


def test_an_unresolvable_reference_is_reported_not_swallowed() -> None:
    """Nothing is fetched, and a reference that cannot be satisfied is named."""
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"other": {"$ref": "https://example.invalid/other.json"}},
        "required": ["other"],
    }
    result = synthesize_instances(schema, seed=1)
    assert any(
        diagnostic.code == "INPUT_REFERENCE_UNRESOLVED" for diagnostic in result.diagnostics
    )


def test_an_external_reference_is_generated_through_the_injected_retriever() -> None:
    """A resolvable external ``$ref`` contributes its own constraints to the payload."""
    other = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["code"],
        "properties": {"code": {"type": "string", "enum": ["OK"]}},
    }
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["status"],
        "properties": {"status": {"$ref": "https://example.com/other.json"}},
    }
    result = synthesize_instances(
        schema,
        seed=1,
        base_uri="https://example.com/root.json",
        retrieve=lambda uri: other if uri == "https://example.com/other.json" else None,
    )
    assert result.instances[0].instance == {"status": {"code": "OK"}}
    assert result.instances[0].valid is True


# ===========================================================================
# Degenerate input
# ===========================================================================


@pytest.mark.parametrize("schema", [{}, {"$schema": "https://json-schema.org/draft/2020-12/schema"}])
def test_an_empty_schema_returns_a_diagnostic_rather_than_raising(
    schema: Dict[str, Any]
) -> None:
    """A schema with nothing to generate from is reported, not crashed on."""
    result = synthesize_instances(schema, seed=1)
    if not result.instances:
        assert any(
            diagnostic.code == "INPUT_SEMANTIC_INVALID" for diagnostic in result.diagnostics
        )


def test_an_unusable_schema_yields_unverified_instances() -> None:
    """A schema that is not a legal schema cannot verify anything — and says so."""
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": 17}
    result = synthesize_instances(schema, seed=1)
    assert all(instance.valid is None for instance in result.instances)


def test_an_unsupported_dialect_falls_back_with_a_diagnostic() -> None:
    """An unknown ``$schema`` is read as 2020-12, and the substitution is reported."""
    result = synthesize_instances({"type": "object"}, dialect="1999-09", seed=1)
    assert result.dialect == "2020-12"
    assert any(
        diagnostic.code == "FORMAT_VERSION_UNSUPPORTED" for diagnostic in result.diagnostics
    )


def test_verification_can_be_switched_off() -> None:
    """With ``verify`` off nothing is checked, and nothing pretends to have been."""
    result = synthesize_instances(_PERSON, seed=1, verify=False)
    assert result.verified is False
    assert all(instance.valid is None for instance in result.instances)


def test_seeds_and_caps_are_clamped_rather_than_trusted() -> None:
    """Out-of-range arguments are clamped, so no caller can ask for unbounded work."""
    result = synthesize_instances(_PERSON, seed=-5, max_mutants=10**6)
    assert result.seed == 0
    assert len([i for i in result.instances if i.kind == "mutant"]) <= 250


# ===========================================================================
# Contracts shared with the rest of the intake surface
# ===========================================================================


def test_every_diagnostic_code_is_in_the_intake_taxonomy() -> None:
    """Diagnostics speak the same stable vocabulary as every other intake surface."""
    schemas = [_PERSON, _DISCRIMINATED, _CONDITIONAL, _RECURSIVE] + [
        _corpus_schema(entry) for entry in _json_schema_entries()
    ]
    seen = set()
    for schema in schemas:
        for diagnostic in synthesize_instances(schema, seed=2).diagnostics:
            seen.add(diagnostic.code)
    assert seen, "the fixtures above must exercise at least one diagnostic"
    assert seen <= set(INTAKE_ERROR_TAXONOMY)


def test_mutation_kind_vocabulary_matches_the_ticket() -> None:
    """The seven kinds IXH-5.2 names, and no silent extras."""
    assert set(MUTATION_KINDS) == {
        MUTATION_REQUIRED_MISSING,
        MUTATION_TYPE_WRONG,
        MUTATION_ENUM_OUT_OF_RANGE,
        MUTATION_PATTERN_VIOLATED,
        MUTATION_BOUND_EXCEEDED,
        MUTATION_ADDITIONAL_PROPERTIES,
        MUTATION_DISCRIMINATOR_MISMATCHED,
    }
    assert DEFAULT_MAX_MUTANTS > 0
