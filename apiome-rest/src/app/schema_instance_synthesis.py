"""Deterministic sample-payload synthesis from a JSON Schema — IXH-5.2 (#5114).

IXH-5.1 answered *does this payload satisfy this schema?* — but it left the caller to write the
payload. For a schema with forty fields that is tedious, and the *interesting* payloads are the
negative ones: the instance that violates exactly one constraint, which is what proves a
consumer rejects what it should. This module produces both, deterministically:

* a **minimal** valid instance — required properties only, nothing else;
* a **full** valid instance — every optional property and every populatable branch;
* **branch** instances — one per ``oneOf`` / ``anyOf`` alternative and per ``if``/``then``/
  ``else`` arm, so a polymorphic schema is covered rather than sampled;
* **mutants** — each a copy of the full instance with exactly one constraint broken
  (a required property removed, a type swapped, an ``enum`` left, a ``pattern`` violated, a
  bound exceeded, an extra property injected where ``additionalProperties`` is ``false``, a
  discriminator pointed at no branch).

**Determinism is a contract, not an accident.** Every synthesized scalar comes from a PRNG
seeded with ``(seed, instance pointer)`` — never from module state, the clock, or traversal
order — so the same schema and seed produce byte-identical output, and a field keeps its value
across the minimal, full, branch, and mutant instances of one run. Iteration follows schema
declaration order throughout; no set or dict is iterated for its ordering.

**Author intent wins.** A value is taken from the schema's own ``const``, ``examples`` /
``example``, ``default``, or ``enum`` before anything is synthesized, and every value records
where it came from in :class:`ValueProvenance`. An authored value that does *not* satisfy its
own subschema (IXH-5.4 found 24 of those in Apiome's own OpenAPI document) is rejected in favour
of a synthesized one, with a diagnostic saying so — a sample payload that fails the schema it
was generated from would be worse than useless.

**Nothing here is real data.** Every instance carries ``synthetic = True``, and every value's
provenance carries its own ``synthetic`` flag (``False`` only when the value was copied verbatim
from the schema). The label travels with the payload so a caller — API or UI — can never mistake
a generated payload for a captured one.

**Everything is verified, not asserted.** When ``verify`` is on (the default), each valid
instance is validated against the schema through IXH-5.1 and each mutant must provoke *exactly
one* top-level violation, of exactly the constraint it targeted. A mutant that fails that check
is dropped rather than shipped: a "negative" payload that fails for the wrong reason is a
broken test. See :func:`_accepts_mutation` for the precise rule.

**Recursion terminates.** A location already on the current path is a cycle and stops there; a
path longer than :data:`MAX_SYNTHESIS_DEPTH` degrades to required-only and then, at
:data:`MAX_SYNTHESIS_DEPTH` + :data:`RECURSION_TAIL_DEPTH`, to an empty value of the right JSON
type. Both bounds are reported as ``INPUT_DEPTH_LIMIT`` diagnostics rather than silently applied.

This module is pure: schema in, instances out. No I/O, no clock, no network — external ``$ref``
targets arrive only through the injected retriever that :mod:`app.schema_instance_validation`
already defines.

(:mod:`apiome_mock.schema_synthesizer` is a deliberately separate sibling: it synthesizes *mock
responses* from a frozen OpenAPI document with name-based realism heuristics — "looks like real
data" — which is the opposite of this module's "must be labelled synthetic and must break
exactly one rule" contract. They share no requirements and are versioned independently.)
"""

from __future__ import annotations

import copy
import hashlib
import json
import random
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.parse import urldefrag, urljoin

from pydantic import BaseModel, ConfigDict, Field
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

from .schema_instance_validation import (
    SUPPORTED_DIALECTS,
    InstanceFinding,
    JsonValidationResult,
    SchemaRetriever,
    ValidationDiagnostic,
    build_reference_registry,
    validate_json_instance,
)
from .schema_validation import DRAFT_2020_12, derive_draft

try:  # Python 3.11 moved the regex parser; importing the old shim raises DeprecationWarning.
    from re import _parser as _regex_parser  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - only on interpreters older than 3.11
    import sre_parse as _regex_parser  # type: ignore[no-redef]

__all__ = [
    "DEFAULT_MAX_BRANCH_INSTANCES",
    "DEFAULT_MAX_MUTANTS",
    "INSTANCE_KINDS",
    "MAX_ARRAY_ITEMS",
    "MAX_BRANCH_INSTANCES_CEILING",
    "MAX_MUTANTS_CEILING",
    "MAX_PROVENANCE_ENTRIES",
    "MAX_SEED",
    "MAX_SYNTHESIS_DEPTH",
    "MUTATION_KINDS",
    "RECURSION_TAIL_DEPTH",
    "SYNTHETIC_EXTRA_PROPERTY",
    "SYNTHETIC_NOTICE",
    "BranchDetail",
    "MutationDetail",
    "SynthesisResult",
    "SynthesizedInstance",
    "ValueProvenance",
    "synthesize_instances",
]

# ===========================================================================
# Bounds and vocabulary
# ===========================================================================

#: How deep generation descends before it degrades to required-properties-only. Six levels
#: covers every real payload shape; past it a schema is either recursive or pathological.
MAX_SYNTHESIS_DEPTH = 6

#: Extra levels allowed past :data:`MAX_SYNTHESIS_DEPTH` for a chain of *required* properties
#: that keeps recursing. Beyond this an empty value of the right JSON type is emitted, so
#: generation always terminates even when no finite instance satisfies the schema.
RECURSION_TAIL_DEPTH = 4

#: Items generated for an unbounded array in the ``full`` instance (``minItems`` still wins).
MAX_ARRAY_ITEMS = 2

#: Provenance entries kept per instance; a payload with more values than this is being read by
#: a machine, and the truncation is reported on the instance.
MAX_PROVENANCE_ENTRIES = 500

#: Default and ceiling for the number of mutants produced.
DEFAULT_MAX_MUTANTS = 40
MAX_MUTANTS_CEILING = 250

#: Default and ceiling for the number of branch instances produced.
DEFAULT_MAX_BRANCH_INSTANCES = 12
MAX_BRANCH_INSTANCES_CEILING = 100

#: Largest accepted seed. Bounded so the value round-trips through JSON and a URL unchanged.
MAX_SEED = 2**31 - 1

#: Internal keyword the generator uses to carry "do not produce these values" down to a
#: subschema. It exists only inside the flattened view — it is never read from a user's schema
#: and never appears in a generated payload — and is what lets the ``else`` arm of an
#: ``if``/``then``/``else`` be generated: the arm is reached by *not* satisfying the condition,
#: which for the usual ``if: {properties: {kind: {const: "a"}}}` shape means avoiding one value.
_EXCLUDE_KEYWORD = "x-apiome-synthesis-exclude"

#: Property name injected by the ``additional-properties-injected`` mutant. Namespaced so it
#: cannot collide with a real property, and self-describing in a failure report.
SYNTHETIC_EXTRA_PROPERTY = "x-apiome-synthetic-extra"

#: Human-readable statement attached to every synthesis response.
SYNTHETIC_NOTICE = (
    "Synthetic sample data generated from the schema. It is not real data, has never been "
    "captured from a production system, and must not be treated as an example of one."
)

#: The kinds of instance this module produces.
INSTANCE_MINIMAL = "minimal"
INSTANCE_FULL = "full"
INSTANCE_BRANCH = "branch"
INSTANCE_MUTANT = "mutant"
INSTANCE_KINDS: Tuple[str, ...] = (INSTANCE_MINIMAL, INSTANCE_FULL, INSTANCE_BRANCH, INSTANCE_MUTANT)

#: The mutation kinds, in the order mutants are selected when ``max_mutants`` binds. The order
#: is round-robin across kinds, so a cap never silently reduces the set to one kind.
MUTATION_REQUIRED_MISSING = "required-missing"
MUTATION_TYPE_WRONG = "type-wrong"
MUTATION_ENUM_OUT_OF_RANGE = "enum-out-of-range"
MUTATION_PATTERN_VIOLATED = "pattern-violated"
MUTATION_BOUND_EXCEEDED = "bound-exceeded"
MUTATION_ADDITIONAL_PROPERTIES = "additional-properties-injected"
MUTATION_DISCRIMINATOR_MISMATCHED = "discriminator-mismatched"
MUTATION_KINDS: Tuple[str, ...] = (
    MUTATION_REQUIRED_MISSING,
    MUTATION_TYPE_WRONG,
    MUTATION_ENUM_OUT_OF_RANGE,
    MUTATION_PATTERN_VIOLATED,
    MUTATION_BOUND_EXCEEDED,
    MUTATION_ADDITIONAL_PROPERTIES,
    MUTATION_DISCRIMINATOR_MISMATCHED,
)

#: Origins a value can have. Only ``synthesized`` is invented by this module; the rest are the
#: schema author's own words, copied verbatim.
ORIGIN_CONST = "const"
ORIGIN_EXAMPLE = "example"
ORIGIN_DEFAULT = "default"
ORIGIN_ENUM = "enum"
ORIGIN_SYNTHESIZED = "synthesized"

#: Keywords whose failure ``jsonschema`` reports as an envelope around the real cause. A mutant
#: inside one of these is reported at the combinator, not at the constraint it broke.
_ENVELOPE_KEYWORDS = frozenset({"anyOf", "oneOf", "not"})

#: Keywords that carry subschemas and are therefore merged rather than copied.
_COMBINATOR_KEYWORDS = ("allOf", "oneOf", "anyOf", "if", "then", "else")

#: Canonical values for the ``format`` vocabulary. Constants, not generated: a format's whole
#: point is a fixed lexical shape, and a "random but valid" e-mail address helps nobody.
_FORMAT_VALUES: Dict[str, str] = {
    "date-time": "2020-01-02T03:04:05Z",
    "date": "2020-01-02",
    "time": "03:04:05Z",
    "duration": "P1DT2H",
    "email": "sample@example.com",
    "idn-email": "sample@example.com",
    "hostname": "sample.example.com",
    "idn-hostname": "sample.example.com",
    "ipv4": "192.0.2.1",
    "ipv6": "2001:db8::1",
    "uri": "https://example.com/sample",
    "iri": "https://example.com/sample",
    "uri-reference": "/sample",
    "iri-reference": "/sample",
    "uri-template": "/sample/{id}",
    "uuid": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "json-pointer": "/sample",
    "relative-json-pointer": "0/sample",
    "regex": "^sample$",
    "byte": "c2FtcGxl",
    "binary": "sample",
    "password": "sample-passphrase",
}

#: Word pool the seeded PRNG draws from for a string with no other guidance. Neutral by design:
#: nothing here can be mistaken for a real name, address, or identifier.
_WORDS: Tuple[str, ...] = (
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
)

#: Candidate values for the ``type-wrong`` mutation, in preference order, with the JSON type
#: family each one belongs to. ``integer`` and ``number`` share a family because every integer
#: is a valid ``number`` instance.
_WRONG_TYPE_CANDIDATES: Tuple[Tuple[str, Any], ...] = (
    ("string", "apiome-synthetic-wrong-type"),
    ("number", 424242),
    ("boolean", True),
    ("array", []),
    ("object", {}),
    ("null", None),
)

#: URI the root schema is registered under so a *subschema* can be validated in the context of
#: the whole document: ``{"$ref": "<urn>#/properties/x"}`` resolves intra-document references
#: normally while making nothing else reachable (the technique IXH-5.4 established).
_ROOT_URN = "urn:apiome:synthesis:root"


# ===========================================================================
# Public models
# ===========================================================================


class ValueProvenance(BaseModel):
    """Where one value in a synthesized instance came from.

    Attributes:
        pointer: RFC 6901 JSON Pointer to the value **in the instance** (``""`` for the root).
        origin: ``const``, ``example``, ``default``, or ``enum`` when the value is the schema
            author's own, ``synthesized`` when this module invented it.
        schema_pointer: Where in the schema the value (or the constraint it was built from)
            came from. Written ``<uri>#<pointer>`` when the subschema lives in a referenced
            document, and as a bare pointer when it lives in the schema itself.
        synthetic: ``False`` only when the value was copied verbatim out of the schema.
            ``True`` for everything this module generated.
    """

    model_config = ConfigDict(extra="forbid")

    pointer: str = Field(description="JSON Pointer to the value in the instance.")
    origin: str = Field(description="const | example | default | enum | synthesized.")
    schema_pointer: str = Field(
        default="", description="Where in the schema the value came from."
    )
    synthetic: bool = Field(
        description="False only when the value was copied verbatim from the schema."
    )


class MutationDetail(BaseModel):
    """The single constraint a mutant breaks, and how it breaks it.

    Attributes:
        kind: One of :data:`MUTATION_KINDS`.
        keyword: The schema keyword the mutation targets (``required``, ``type``, ``enum``,
            ``pattern``, ``maximum``, ``additionalProperties``, ``oneOf`` …).
        pointer: JSON Pointer to the value the mutation removed, replaced, or added.
        schema_pointer: Where the broken constraint is declared.
        reported_keyword: The keyword the validator actually reported at the top level. Equal
            to :attr:`keyword` except when the constraint sits inside a combinator, where the
            validator reports the combinator and the targeted keyword appears beneath it.
        reported_pointer: The instance pointer the validator reported the failure at.
        description: One sentence describing the mutation, for a test report or a UI row.
        original: The value before the mutation (``None`` for an injected property).
        mutated: The value after the mutation (``None`` for a removed property).
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(description="Which mutation was applied.")
    keyword: str = Field(description="The schema keyword the mutation targets.")
    pointer: str = Field(description="JSON Pointer to the mutated value.")
    schema_pointer: str = Field(default="", description="Where the broken constraint lives.")
    reported_keyword: str = Field(
        default="", description="The keyword the validator reported at the top level."
    )
    reported_pointer: str = Field(
        default="", description="The instance pointer the validator reported."
    )
    description: str = Field(description="One-sentence description of the mutation.")
    original: Optional[Any] = Field(default=None, description="Value before the mutation.")
    mutated: Optional[Any] = Field(default=None, description="Value after the mutation.")


class BranchDetail(BaseModel):
    """Which alternative of a polymorphic schema an instance was generated for.

    Attributes:
        keyword: ``oneOf``, ``anyOf``, or ``if`` (for the ``if``/``then``/``else`` triple).
        schema_pointer: Where the combinator is declared.
        selector: ``"0"``, ``"1"``, … for ``oneOf``/``anyOf``; ``"then"`` or ``"else"`` for
            an ``if``/``then``/``else`` arm.
        label: Human-readable name of the alternative (``oneOf[1]``, ``if/else``).
    """

    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(description="oneOf | anyOf | if.")
    schema_pointer: str = Field(description="Where the combinator is declared.")
    selector: str = Field(description="Branch index, or `then` / `else`.")
    label: str = Field(description="Human-readable name of the alternative.")


class SynthesizedInstance(BaseModel):
    """One generated payload, with everything a caller needs to use it as a test case.

    Attributes:
        id: Stable identifier, unique within one result and reproducible across runs with the
            same schema and seed (``minimal``, ``mutant:type-wrong:type:/age`` …).
        kind: One of :data:`INSTANCE_KINDS`.
        title: Short human-readable name.
        description: What the instance is for.
        instance: The payload itself.
        synthetic: Always ``True``. Present on every instance so the label survives being
            copied out of the response.
        expected_valid: Whether the instance is *meant* to satisfy the schema.
        valid: Whether it actually does, when ``verify`` ran; ``None`` when it did not.
        findings: The violations the instance provoked — the point of a mutant, and a bug
            report for a valid instance that did not come out valid.
        derived_from: The id of the instance a mutant was derived from.
        mutation: For a mutant, the single constraint it breaks.
        branch: For a branch instance, the alternative it covers.
        provenance: Where each value came from (valid instances only; a mutant's values are
            its parent's, plus the one the mutation changed).
        provenance_truncated: Whether ``provenance`` was cut at
            :data:`MAX_PROVENANCE_ENTRIES`.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Stable, reproducible identifier for this instance.")
    kind: str = Field(description="minimal | full | branch | mutant.")
    title: str = Field(description="Short human-readable name.")
    description: str = Field(description="What this instance is for.")
    instance: Optional[Any] = Field(default=None, description="The synthetic payload itself.")
    synthetic: bool = Field(
        default=True,
        description="Always true: this payload was generated, never captured.",
    )
    expected_valid: bool = Field(description="Whether the payload should satisfy the schema.")
    valid: Optional[bool] = Field(
        default=None,
        description="Whether it does, when verification ran; null when it did not run.",
    )
    findings: List[InstanceFinding] = Field(
        default_factory=list, description="Violations the payload provoked."
    )
    derived_from: Optional[str] = Field(
        default=None, description="Id of the instance a mutant was derived from."
    )
    mutation: Optional[MutationDetail] = Field(
        default=None, description="The single constraint a mutant breaks."
    )
    branch: Optional[BranchDetail] = Field(
        default=None, description="The alternative a branch instance covers."
    )
    provenance: List[ValueProvenance] = Field(
        default_factory=list, description="Where each value came from."
    )
    provenance_truncated: bool = Field(
        default=False, description="Whether provenance was truncated."
    )


@dataclass
class SynthesisResult:
    """Everything one synthesis run produced.

    Attributes:
        instances: The generated payloads, ordered minimal → full → branches → mutants.
        diagnostics: Conditions that limited generation — a construct with no generatable
            value, an unresolvable reference, a depth bound, a mutant that could not be made
            to fail cleanly. Never a failure of the caller's request.
        seed: The seed the run used, echoed so a result can be reproduced.
        dialect: The dialect the schema was read and verified under.
        depth_limit: :data:`MAX_SYNTHESIS_DEPTH`, echoed so a caller can explain a truncation.
        verified: Whether generated instances were validated back against the schema.
        rejected_mutants: Mutation candidates dropped because they did not fail the schema
            with exactly the constraint they targeted.
        mutants_truncated: Whether the mutant set was cut short by ``max_mutants``.
        branches_truncated: Whether the branch set was cut short by ``max_branch_instances``.
    """

    instances: List[SynthesizedInstance] = field(default_factory=list)
    diagnostics: List[ValidationDiagnostic] = field(default_factory=list)
    seed: int = 0
    dialect: str = DRAFT_2020_12
    depth_limit: int = MAX_SYNTHESIS_DEPTH
    verified: bool = True
    rejected_mutants: int = 0
    mutants_truncated: bool = False
    branches_truncated: bool = False


# ===========================================================================
# Public entry point
# ===========================================================================


def synthesize_instances(
    schema: Dict[str, Any],
    *,
    dialect: Optional[str] = None,
    seed: int = 0,
    base_uri: str = "",
    retrieve: Optional[SchemaRetriever] = None,
    include_minimal: bool = True,
    include_full: bool = True,
    include_branches: bool = True,
    include_mutants: bool = True,
    mutation_kinds: Optional[Sequence[str]] = None,
    max_mutants: int = DEFAULT_MAX_MUTANTS,
    max_branch_instances: int = DEFAULT_MAX_BRANCH_INSTANCES,
    verify: bool = True,
) -> SynthesisResult:
    """Generate valid instances and single-constraint mutants for one JSON Schema.

    Args:
        schema: The schema document to generate from.
        dialect: Dialect token to read and verify under. ``None`` derives it from the schema's
            ``$schema``; an unsupported token falls back to draft 2020-12 with a diagnostic.
        seed: Seed for the value PRNG. The same schema and seed always produce byte-identical
            output; a different seed produces different values for the same shape.
        base_uri: Absolute URI the schema's relative ``$ref``s resolve against.
        retrieve: Resolver for external ``$ref`` targets. ``None`` means nothing external is
            resolvable — this module never fetches anything itself.
        include_minimal: Generate the required-properties-only instance.
        include_full: Generate the every-optional-property instance.
        include_branches: Generate one instance per ``oneOf``/``anyOf`` alternative and per
            ``if``/``then``/``else`` arm.
        include_mutants: Generate the single-constraint violations.
        mutation_kinds: Restrict mutants to these kinds (see :data:`MUTATION_KINDS`).
            ``None`` means all of them.
        max_mutants: Cap on mutants, clamped to :data:`MAX_MUTANTS_CEILING`. Selection is
            round-robin across kinds, so a cap never collapses the set to one kind.
        max_branch_instances: Cap on branch instances, clamped to
            :data:`MAX_BRANCH_INSTANCES_CEILING`.
        verify: Validate every generated instance back against the schema, and drop any mutant
            that does not break exactly the constraint it targeted. Leaving this on is what
            makes the output trustworthy; turning it off is for callers that only want the
            shapes.

    Returns:
        The :class:`SynthesisResult`. Generation never raises for a schema it cannot handle:
        an unusable schema, an unresolvable reference, or a construct with no generatable value
        becomes a diagnostic on the result.
    """
    synthesizer = _Synthesizer(
        schema=schema,
        dialect=dialect,
        seed=max(0, min(int(seed), MAX_SEED)),
        base_uri=base_uri,
        retrieve=retrieve,
        verify=verify,
    )
    return synthesizer.run(
        include_minimal=include_minimal,
        include_full=include_full,
        include_branches=include_branches,
        include_mutants=include_mutants,
        mutation_kinds=mutation_kinds,
        max_mutants=max(1, min(int(max_mutants), MAX_MUTANTS_CEILING)),
        max_branch_instances=max(
            1, min(int(max_branch_instances), MAX_BRANCH_INSTANCES_CEILING)
        ),
    )


# ===========================================================================
# Internal state
# ===========================================================================

#: A schema location: ``(document uri, json pointer)``. ``""`` as the document uri means the
#: root document, which has no URI of its own when the schema was projected rather than fetched.
_Location = Tuple[str, str]

#: Root of every traversal.
_ROOT_LOCATION: _Location = ("", "")


@dataclass
class _Mutation:
    """One candidate mutation, described as an edit rather than a mutated copy.

    Storing the *edit* keeps every mutant derivable from one baseline by a pure function, which
    is what makes a mutant reproducible and its ``original``/``mutated`` pair exact.

    Attributes:
        kind: One of :data:`MUTATION_KINDS`.
        keyword: The schema keyword targeted.
        container: JSON Pointer to the object or array being edited (``""`` for the root).
        key: Property name or array index inside ``container``; ``None`` replaces the
            container itself (only used when the root is retyped).
        action: ``remove``, ``set``, ``append``, or ``truncate``.
        value: The new value for ``set``/``append``, or the new length for ``truncate``.
        target_pointer: JSON Pointer to the value the mutation is about.
        schema_pointer: Where the broken constraint is declared.
        description: One sentence describing the mutation.
        original: The value before the mutation.
    """

    kind: str
    keyword: str
    container: str
    key: Optional[Any]
    action: str
    value: Any
    target_pointer: str
    schema_pointer: str
    description: str
    original: Any = None


@dataclass
class _BranchSite:
    """One combinator in the schema that branch instances should cover.

    Attributes:
        location: Location of the schema node that declares the combinator.
        keyword: ``oneOf``, ``anyOf``, or ``if``.
        selectors: The alternatives to pin, in declaration order.
    """

    location: _Location
    keyword: str
    selectors: Tuple[str, ...]


class _Synthesizer:
    """One synthesis run: holds the documents, the PRNG seed, and the verification validator."""

    def __init__(
        self,
        *,
        schema: Dict[str, Any],
        dialect: Optional[str],
        seed: int,
        base_uri: str,
        retrieve: Optional[SchemaRetriever],
        verify: bool,
    ) -> None:
        self._schema = schema if isinstance(schema, dict) else {}
        self._seed = seed
        self._base_uri = urldefrag(base_uri or "").url
        self._retrieve = retrieve
        self._verify = verify
        self._diagnostics: List[ValidationDiagnostic] = []
        self._diagnostic_keys: Set[Tuple[str, str]] = set()

        token = (dialect or derive_draft(self._schema) or DRAFT_2020_12).strip()
        if token not in SUPPORTED_DIALECTS:
            self._diagnose(
                "FORMAT_VERSION_UNSUPPORTED",
                f"JSON Schema dialect {token!r} is not supported; the schema was read and "
                f"verified as draft {DRAFT_2020_12}.",
            )
            token = DRAFT_2020_12
        self._dialect = token
        self._validator_cls = SUPPORTED_DIALECTS[token][0]

        # Documents reachable from the root, keyed by the URI they were loaded from. The root
        # lives under "" so a pointer into it needs no URI; external documents are pulled in
        # lazily through the injected retriever and never over the network.
        self._documents: Dict[str, Any] = {"": self._schema}
        self._unresolvable: Set[str] = set()

        # Per-instance generation state, reset by _generate_instance.
        self._provenance: List[ValueProvenance] = []
        self._provenance_truncated = False
        self._pins: Dict[str, str] = {}
        # Flattening is pure for a fixed set of pins and is asked for the same location once
        # per contributing source, so its result is memoised and dropped whenever a branch is
        # pinned differently. `_flattening` is the re-entry guard for a self-merging schema.
        self._flatten_cache: Dict[Tuple[_Location, str], "_FlatSchema"] = {}
        self._flattening: List[_Location] = []

        self._verifier = _build_verifier(
            self._schema, self._validator_cls, self._base_uri, retrieve
        ) if verify else None

    # -- diagnostics --------------------------------------------------------

    def _diagnose(self, code: str, message: str, pointer: Optional[str] = None) -> None:
        """Record a diagnostic once per ``(code, message)`` pair.

        Generation revisits the same construct for every instance it produces, so the same
        limitation would otherwise be reported a dozen times over.
        """
        key = (code, message)
        if key in self._diagnostic_keys:
            return
        self._diagnostic_keys.add(key)
        self._diagnostics.append(
            ValidationDiagnostic(code=code, message=message, pointer=pointer)
        )

    # -- orchestration ------------------------------------------------------

    def run(
        self,
        *,
        include_minimal: bool,
        include_full: bool,
        include_branches: bool,
        include_mutants: bool,
        mutation_kinds: Optional[Sequence[str]],
        max_mutants: int,
        max_branch_instances: int,
    ) -> SynthesisResult:
        """Generate every requested instance. See :func:`synthesize_instances` for the contract."""
        result = SynthesisResult(
            seed=self._seed,
            dialect=self._dialect,
            depth_limit=MAX_SYNTHESIS_DEPTH,
            verified=self._verify,
        )
        if not isinstance(self._schema, dict) or not self._schema:
            self._diagnose(
                "INPUT_SEMANTIC_INVALID",
                "The schema is empty or is not a JSON Schema object, so no payload can be "
                "generated from it.",
            )
            result.diagnostics = list(self._diagnostics)
            return result

        # Branch instances and every mutant are derived from the `full` baseline, so it is
        # generated whenever any of them is wanted — even if the caller did not ask to see it.
        needs_full = include_full or include_branches or include_mutants
        full_value, full_provenance, full_truncated = (
            self._generate_instance("full") if needs_full else (None, [], False)
        )
        seen_payloads: Set[str] = set()

        if include_minimal:
            minimal_value, minimal_provenance, minimal_truncated = self._generate_instance(
                "minimal"
            )
            result.instances.append(
                self._valid_instance(
                    identifier=INSTANCE_MINIMAL,
                    kind=INSTANCE_MINIMAL,
                    title="Minimal valid instance",
                    description=(
                        "Required properties only — the smallest payload the schema accepts."
                    ),
                    value=minimal_value,
                    provenance=minimal_provenance,
                    provenance_truncated=minimal_truncated,
                )
            )
            seen_payloads.add(_canonical(minimal_value))

        if include_full:
            result.instances.append(
                self._valid_instance(
                    identifier=INSTANCE_FULL,
                    kind=INSTANCE_FULL,
                    title="Full valid instance",
                    description=(
                        "Every optional property populated and every populatable branch taken."
                    ),
                    value=full_value,
                    provenance=full_provenance,
                    provenance_truncated=full_truncated,
                )
            )
            seen_payloads.add(_canonical(full_value))

        if include_branches:
            branch_instances, branches_truncated = self._branch_instances(
                max_branch_instances, seen_payloads
            )
            result.instances.extend(branch_instances)
            result.branches_truncated = branches_truncated

        if include_mutants and self._baseline_is_usable(full_value):
            mutants, rejected, truncated = self._mutant_instances(
                full_value, mutation_kinds, max_mutants
            )
            result.instances.extend(mutants)
            result.rejected_mutants = rejected
            result.mutants_truncated = truncated

        result.diagnostics = list(self._diagnostics)
        return result

    def _baseline_is_usable(self, baseline: Any) -> bool:
        """Whether mutants can be derived from this baseline at all.

        A mutant's whole claim is "this payload fails *only* because of the one constraint I
        broke", which is only meaningful when the payload it was derived from passes. Deriving
        mutants from an invalid baseline would produce a pile of candidates that all get
        rejected, and a diagnostic blaming the wrong thing.
        """
        if self._verifier is None:
            return True
        errors = self._top_level_errors(baseline)
        if errors is None:
            return False
        if not errors:
            return True
        self._diagnose(
            "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
            "No mutants were generated: the valid instance this generator produced for the "
            "schema does not itself satisfy the schema, so a payload that breaks exactly one "
            "constraint cannot be derived from it. The diagnostics above name the construct "
            "that defeated generation.",
        )
        return False

    # -- valid instances ----------------------------------------------------

    def _generate_instance(self, mode: str) -> Tuple[Any, List[ValueProvenance], bool]:
        """Generate one whole instance in ``mode`` (``minimal`` or ``full``).

        Args:
            mode: ``minimal`` emits required properties only; ``full`` emits every property.

        Returns:
            ``(value, provenance, provenance_truncated)``.
        """
        self._provenance = []
        self._provenance_truncated = False
        value = self._generate(
            self._flatten(_ROOT_LOCATION, mode=mode), "", mode=mode, depth=0, path=()
        )
        return value, list(self._provenance), self._provenance_truncated

    def _valid_instance(
        self,
        *,
        identifier: str,
        kind: str,
        title: str,
        description: str,
        value: Any,
        provenance: List[ValueProvenance],
        provenance_truncated: bool,
        branch: Optional[BranchDetail] = None,
    ) -> SynthesizedInstance:
        """Wrap a generated payload that is *meant* to be valid, verifying it when asked."""
        instance = SynthesizedInstance(
            id=identifier,
            kind=kind,
            title=title,
            description=description,
            instance=value,
            expected_valid=True,
            provenance=provenance,
            provenance_truncated=provenance_truncated,
            branch=branch,
        )
        if not self._verify:
            return instance

        report = self._validate(value)
        instance.valid = report.valid
        instance.findings = report.findings[:10]
        if report.valid is False:
            self._diagnose(
                "INPUT_SEMANTIC_INVALID",
                f"The generated {title.lower()} does not satisfy the schema "
                f"({report.total_findings} violation(s), first at "
                f"{report.findings[0].pointer or '/'!r}: {report.findings[0].keyword}). This is "
                "a limitation of the generator for this schema, not a property of your data; "
                "the payload is returned so the gap is visible rather than hidden.",
            )
        return instance

    def _branch_instances(
        self, limit: int, seen_payloads: Set[str]
    ) -> Tuple[List[SynthesizedInstance], bool]:
        """Generate one instance per combinator alternative, skipping duplicates.

        A pinned alternative that produces a payload already emitted (an ``else`` arm whose
        instance happens to satisfy the ``if``, two ``anyOf`` branches with the same shape)
        adds no coverage, so it is dropped rather than shipped as a distinct case.

        Args:
            limit: Maximum number of branch instances to emit.
            seen_payloads: Canonical JSON of the payloads already emitted; updated in place.

        Returns:
            ``(instances, truncated)``.
        """
        instances: List[SynthesizedInstance] = []
        truncated = False
        for site in self._branch_sites():
            for selector in site.selectors:
                if len(instances) >= limit:
                    truncated = True
                    return instances, truncated
                key = _pin_key(site.location, site.keyword)
                self._set_pins({key: selector})
                try:
                    value, provenance, provenance_truncated = self._generate_instance("full")
                finally:
                    self._set_pins({})
                payload = _canonical(value)
                if payload in seen_payloads:
                    continue
                seen_payloads.add(payload)
                label = (
                    f"{site.keyword}[{selector}]"
                    if site.keyword in ("oneOf", "anyOf")
                    else f"if/{selector}"
                )
                schema_pointer = _render_location(site.location)
                instances.append(
                    self._valid_instance(
                        identifier=f"branch:{schema_pointer or '/'}:{site.keyword}:{selector}",
                        kind=INSTANCE_BRANCH,
                        title=f"Branch instance — {label}",
                        description=(
                            f"A valid payload that takes the {label} alternative declared at "
                            f"{schema_pointer or '/'}."
                        ),
                        value=value,
                        provenance=provenance,
                        provenance_truncated=provenance_truncated,
                        branch=BranchDetail(
                            keyword=site.keyword,
                            schema_pointer=schema_pointer,
                            selector=selector,
                            label=label,
                        ),
                    )
                )
        return instances, truncated

    def _set_pins(self, pins: Dict[str, str]) -> None:
        """Pin (or unpin) branch selections, dropping the flatten cache they invalidate."""
        self._pins = pins
        self._flatten_cache = {}

    def _branch_sites(self) -> List[_BranchSite]:
        """Find every combinator worth generating per-branch instances for.

        Walks the schema in declaration order, following ``$ref``s once per location and
        stopping at :data:`MAX_SYNTHESIS_DEPTH`, so a recursive schema yields a finite site
        list. Only alternatives that could produce a *different* payload are listed: a
        one-branch ``oneOf`` is the same as no combinator at all.
        """
        sites: List[_BranchSite] = []
        visited: Set[_Location] = set()
        queue: List[Tuple[_Location, int]] = [(_ROOT_LOCATION, 0)]
        while queue:
            location, depth = queue.pop(0)
            if location in visited or depth > MAX_SYNTHESIS_DEPTH:
                continue
            visited.add(location)
            node = self._node_at(location)
            if not isinstance(node, dict):
                continue
            resolved_location = self._follow_ref(location)
            if resolved_location != location:
                queue.append((resolved_location, depth))
                continue

            for keyword in ("oneOf", "anyOf"):
                options = node.get(keyword)
                if isinstance(options, list) and len(options) > 1:
                    sites.append(
                        _BranchSite(
                            location=location,
                            keyword=keyword,
                            selectors=tuple(str(index) for index in range(len(options))),
                        )
                    )
            if isinstance(node.get("if"), dict) and (
                isinstance(node.get("then"), dict) or isinstance(node.get("else"), dict)
            ):
                selectors = tuple(
                    arm for arm in ("then", "else") if isinstance(node.get(arm), dict)
                )
                sites.append(
                    _BranchSite(location=location, keyword="if", selectors=selectors)
                )

            for child in self._child_locations(location, node):
                queue.append((child, depth + 1))
        return sites

    def _child_locations(self, location: _Location, node: Dict[str, Any]) -> List[_Location]:
        """Locations of every subschema directly under ``node``, in declaration order."""
        document_uri, pointer = location
        children: List[_Location] = []
        for keyword in ("properties", "patternProperties", "$defs", "definitions"):
            container = node.get(keyword)
            if isinstance(container, dict):
                children.extend(
                    (document_uri, f"{pointer}/{_escape(keyword)}/{_escape(name)}")
                    for name in container
                )
        for keyword in ("items", "contains", "additionalProperties", "not", "propertyNames"):
            if isinstance(node.get(keyword), dict):
                children.append((document_uri, f"{pointer}/{_escape(keyword)}"))
        for keyword in _COMBINATOR_KEYWORDS:
            member = node.get(keyword)
            if isinstance(member, list):
                children.extend(
                    (document_uri, f"{pointer}/{_escape(keyword)}/{index}")
                    for index in range(len(member))
                )
            elif isinstance(member, dict):
                children.append((document_uri, f"{pointer}/{_escape(keyword)}"))
        if isinstance(node.get("prefixItems"), list):
            children.extend(
                (document_uri, f"{pointer}/prefixItems/{index}")
                for index in range(len(node["prefixItems"]))
            )
        return children

    # -- mutants ------------------------------------------------------------

    def _mutant_instances(
        self,
        baseline: Any,
        mutation_kinds: Optional[Sequence[str]],
        limit: int,
    ) -> Tuple[List[SynthesizedInstance], int, bool]:
        """Derive single-constraint mutants from the full instance.

        Args:
            baseline: The full valid instance every mutant is derived from.
            mutation_kinds: Restrict to these kinds, or ``None`` for all of them.
            limit: Maximum number of mutants to emit.

        Returns:
            ``(instances, rejected, truncated)`` — the accepted mutants, how many candidates
            were dropped for not failing cleanly, and whether ``limit`` bound.
        """
        allowed = (
            tuple(kind for kind in MUTATION_KINDS if kind in set(mutation_kinds))
            if mutation_kinds is not None
            else MUTATION_KINDS
        )
        if not allowed:
            return [], 0, False

        # The baseline is the `full` instance, so the schema is walked the way it was built.
        candidates = self._collect_mutations(
            self._flatten(_ROOT_LOCATION, mode="full"), "", baseline, depth=0, path=()
        )
        ordered = _round_robin(
            [
                [candidate for candidate in candidates if candidate.kind == kind]
                for kind in allowed
            ]
        )

        instances: List[SynthesizedInstance] = []
        rejected = 0
        truncated = False
        for candidate in ordered:
            if len(instances) >= limit:
                truncated = True
                break
            mutated = _apply_mutation(baseline, candidate)
            if mutated is _UNAPPLIED:
                continue
            reported = self._accepted_report(candidate, mutated)
            if reported is None:
                rejected += 1
                continue
            reported_keyword, reported_pointer = reported
            findings: List[InstanceFinding] = []
            valid: Optional[bool] = None
            if self._verify:
                report = self._validate(mutated)
                findings = report.findings[:10]
                valid = report.valid
            instances.append(
                SynthesizedInstance(
                    id=(
                        f"mutant:{candidate.kind}:{candidate.keyword}:"
                        f"{candidate.target_pointer or '/'}"
                    ),
                    kind=INSTANCE_MUTANT,
                    title=f"{candidate.kind} at {candidate.target_pointer or '/'}",
                    description=candidate.description,
                    instance=mutated,
                    expected_valid=False,
                    valid=valid,
                    findings=findings,
                    derived_from=INSTANCE_FULL,
                    mutation=MutationDetail(
                        kind=candidate.kind,
                        keyword=candidate.keyword,
                        pointer=candidate.target_pointer,
                        schema_pointer=candidate.schema_pointer,
                        reported_keyword=reported_keyword,
                        reported_pointer=reported_pointer,
                        description=candidate.description,
                        original=candidate.original,
                        mutated=None if candidate.action == "remove" else candidate.value,
                    ),
                )
            )
        if rejected:
            self._diagnose(
                "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                f"{rejected} mutation candidate(s) were dropped because they did not make the "
                "schema fail with exactly the constraint they targeted — the constraint is "
                "unreachable, redundant, or entangled with another one. Only mutants that "
                "isolate a single violation are returned.",
            )
        return instances, rejected, truncated

    def _accepted_report(
        self, candidate: _Mutation, mutated: Any
    ) -> Optional[Tuple[str, str]]:
        """Decide whether a mutant breaks exactly the constraint it targeted.

        A mutant is accepted when the schema reports **exactly one** top-level violation and
        that violation is either the targeted ``(pointer, keyword)`` itself, or a combinator
        (:data:`_ENVELOPE_KEYWORDS`) enclosing it — a constraint declared inside a ``oneOf`` is
        always reported as the ``oneOf``, and rejecting those would leave polymorphic schemas
        with no mutants at all. Anything else means the edit broke more than one rule, or the
        wrong one, and the mutant is not a usable negative test.

        Args:
            candidate: The mutation that was applied.
            mutated: The mutated payload.

        Returns:
            ``(reported keyword, reported pointer)`` when accepted, ``None`` when not. With
            verification off, the targeted keyword and pointer are returned unchecked.
        """
        if self._verifier is None:
            return candidate.keyword, candidate.target_pointer

        errors = self._top_level_errors(mutated)
        if errors is None or len(errors) != 1:
            return None
        error = errors[0]
        reported_keyword = str(error.validator) if error.validator is not None else "schema"
        reported_pointer = "".join(f"/{_escape(part)}" for part in error.absolute_path)

        if reported_keyword == candidate.keyword and reported_pointer == _reported_site(
            candidate
        ):
            return reported_keyword, reported_pointer
        if reported_keyword in _ENVELOPE_KEYWORDS and _is_ancestor_pointer(
            reported_pointer, candidate.target_pointer
        ):
            return reported_keyword, reported_pointer
        return None

    def _collect_mutations(
        self,
        resolved: Optional["_FlatSchema"],
        pointer: str,
        value: Any,
        *,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> List[_Mutation]:
        """Walk schema and payload together, collecting every mutation the pair affords.

        Args:
            resolved: The flattened subschema that governs ``value``, or ``None`` when the
                payload holds a value the schema never describes.
            pointer: JSON Pointer to ``value`` in the instance.
            value: The baseline value at ``pointer``.
            depth: Current nesting depth.
            path: Locations already on this branch of the walk, for cycle detection.

        Returns:
            Candidate mutations in schema declaration order. Nothing is applied or verified
            here; :meth:`_accepted_report` decides which ones survive.
        """
        if resolved is None or depth > MAX_SYNTHESIS_DEPTH or resolved.location in path:
            return []
        node = resolved.schema
        if not node:
            return []
        mutations: List[_Mutation] = []
        next_path = path + (resolved.location,)

        if isinstance(value, dict):
            mutations.extend(self._object_mutations(node, resolved, pointer, value))
        mutations.extend(self._value_mutations(node, resolved, pointer, value))

        # Recurse into the children the payload actually has, so a mutation is only ever
        # proposed for a value that exists in the baseline.
        if isinstance(value, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                for name, child_schema in properties.items():
                    if name not in value or not isinstance(child_schema, dict):
                        continue
                    mutations.extend(
                        self._collect_mutations(
                            self._flatten_child(resolved, ("properties", name), mode="full"),
                            f"{pointer}/{_escape(name)}",
                            value[name],
                            depth=depth + 1,
                            path=next_path,
                        )
                    )
        elif isinstance(value, list):
            prefix_items = node.get("prefixItems")
            items = node.get("items")
            for index, entry in enumerate(value):
                if isinstance(prefix_items, list) and index < len(prefix_items):
                    child_location = self._flatten_child(
                        resolved, ("prefixItems", index), mode="full"
                    )
                elif isinstance(items, dict):
                    child_location = self._flatten_child(resolved, ("items",), mode="full")
                else:
                    continue
                mutations.extend(
                    self._collect_mutations(
                        child_location,
                        f"{pointer}/{index}",
                        entry,
                        depth=depth + 1,
                        path=next_path,
                    )
                )
        return mutations

    def _object_mutations(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        pointer: str,
        value: Dict[str, Any],
    ) -> List[_Mutation]:
        """Mutations that only an object affords: a missing requirement, an extra property."""
        mutations: List[_Mutation] = []
        schema_pointer = _render_location(resolved.location)

        required = node.get("required")
        if isinstance(required, list):
            for name in required:
                if not isinstance(name, str) or name not in value:
                    continue
                mutations.append(
                    _Mutation(
                        kind=MUTATION_REQUIRED_MISSING,
                        keyword="required",
                        container=pointer,
                        key=name,
                        action="remove",
                        value=None,
                        target_pointer=f"{pointer}/{_escape(name)}",
                        schema_pointer=schema_pointer,
                        description=(
                            f"Removes the required property {name!r} from "
                            f"{pointer or 'the root object'}."
                        ),
                        original=value.get(name),
                    )
                )

        closed_keyword = None
        if node.get("additionalProperties") is False:
            closed_keyword = "additionalProperties"
        elif node.get("unevaluatedProperties") is False:
            closed_keyword = "unevaluatedProperties"
        patterns = node.get("patternProperties")
        matches_pattern = isinstance(patterns, dict) and any(
            _matches(pattern, SYNTHETIC_EXTRA_PROPERTY) for pattern in patterns
        )
        if closed_keyword and not matches_pattern and SYNTHETIC_EXTRA_PROPERTY not in value:
            mutations.append(
                _Mutation(
                    kind=MUTATION_ADDITIONAL_PROPERTIES,
                    keyword=closed_keyword,
                    container=pointer,
                    key=SYNTHETIC_EXTRA_PROPERTY,
                    action="set",
                    value="unexpected",
                    target_pointer=f"{pointer}/{_escape(SYNTHETIC_EXTRA_PROPERTY)}",
                    schema_pointer=schema_pointer,
                    description=(
                        f"Injects the undeclared property {SYNTHETIC_EXTRA_PROPERTY!r} into "
                        f"{pointer or 'the root object'}, which the schema closes with "
                        f"`{closed_keyword}: false`."
                    ),
                )
            )

        mutations.extend(self._discriminator_mutations(resolved, pointer, value))
        return mutations

    def _discriminator_mutations(
        self, resolved: "_FlatSchema", pointer: str, value: Dict[str, Any]
    ) -> List[_Mutation]:
        """Point a discriminator at a variant no branch declares.

        The discriminator itself is an OpenAPI annotation that no JSON Schema validator reads;
        what makes the mutant fail is that every branch constrains the discriminating property
        (with ``const`` or ``enum``), so an unknown value matches none of them. A schema whose
        branches do *not* constrain it produces no failure at all, and the mutant is dropped by
        :meth:`_accepted_report` rather than shipped as a test that always passes.
        """
        node = resolved.raw
        discriminator = node.get("discriminator")
        if not isinstance(discriminator, dict):
            return []
        property_name = discriminator.get("propertyName")
        if not isinstance(property_name, str) or property_name not in value:
            return []
        keyword = next(
            (name for name in ("oneOf", "anyOf") if isinstance(node.get(name), list)), None
        )
        if keyword is None:
            return []
        return [
            _Mutation(
                kind=MUTATION_DISCRIMINATOR_MISMATCHED,
                keyword=keyword,
                container=pointer,
                key=property_name,
                action="set",
                value="apiome-synthetic-unknown-variant",
                target_pointer=f"{pointer}/{_escape(property_name)}",
                schema_pointer=_render_location(resolved.location),
                description=(
                    f"Sets the discriminating property {property_name!r} to a variant no "
                    f"`{keyword}` branch declares."
                ),
                original=value.get(property_name),
            )
        ]

    def _value_mutations(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        pointer: str,
        value: Any,
    ) -> List[_Mutation]:
        """Mutations that rewrite one value: wrong type, out-of-enum, off-pattern, out-of-bounds.

        Applies to any JSON value, not only scalars — an array can be pushed past ``maxItems``
        and an object can be given the wrong ``type`` just as a string can.
        """
        container, key = _split_pointer(pointer)
        schema_pointer = _render_location(resolved.location)
        mutations: List[_Mutation] = []

        def add(kind: str, keyword: str, replacement: Any, description: str) -> None:
            mutations.append(
                _Mutation(
                    kind=kind,
                    keyword=keyword,
                    container=container,
                    key=key,
                    action="set",
                    value=replacement,
                    target_pointer=pointer,
                    schema_pointer=schema_pointer,
                    description=description,
                    original=value,
                )
            )

        has_choice = "enum" in node or "const" in node
        declared_types = _declared_types(node)
        if declared_types and not has_choice:
            wrong = _wrong_type_value(declared_types)
            if wrong is not None:
                add(
                    MUTATION_TYPE_WRONG,
                    "type",
                    wrong[1],
                    f"Replaces {pointer or 'the root value'} with a {wrong[0]}, which the "
                    f"schema's `type` forbids.",
                )

        enum = node.get("enum")
        if isinstance(enum, list) and enum:
            outside = _value_outside_enum(enum)
            if outside is not None:
                add(
                    MUTATION_ENUM_OUT_OF_RANGE,
                    "enum",
                    outside,
                    f"Sets {pointer or 'the root value'} to a value the `enum` does not list.",
                )

        pattern = node.get("pattern")
        if isinstance(value, str) and isinstance(pattern, str):
            off_pattern = _string_violating_pattern(pattern, node)
            if off_pattern is not None:
                add(
                    MUTATION_PATTERN_VIOLATED,
                    "pattern",
                    off_pattern,
                    f"Sets {pointer or 'the root value'} to a string the `pattern` rejects.",
                )

        bound = _bound_violation(node, value)
        if bound is not None:
            keyword, replacement, wording = bound
            if keyword in ("maxItems", "minItems"):
                mutations.append(
                    _Mutation(
                        kind=MUTATION_BOUND_EXCEEDED,
                        keyword=keyword,
                        container=pointer,
                        key=None,
                        action="append" if keyword == "maxItems" else "truncate",
                        value=replacement,
                        target_pointer=pointer,
                        schema_pointer=schema_pointer,
                        description=wording.format(pointer=pointer or "the root value"),
                        original=value,
                    )
                )
            else:
                add(
                    MUTATION_BOUND_EXCEEDED,
                    keyword,
                    replacement,
                    wording.format(pointer=pointer or "the root value"),
                )
        return mutations

    # -- generation ---------------------------------------------------------

    def _generate(
        self,
        resolved: Optional["_FlatSchema"],
        pointer: str,
        *,
        mode: str,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> Any:
        """Generate the value for one already-flattened subschema.

        Args:
            resolved: The flattened subschema, or ``None`` when the schema names a value it
                never describes (a ``required`` property with no ``properties`` entry).
            pointer: JSON Pointer the value will occupy in the instance — the PRNG key, so a
                field's value is stable across instances of one run.
            mode: ``minimal`` (required properties only) or ``full``.
            depth: Current nesting depth.
            path: Locations already on this branch, so a cycle stops at its second visit.

        Returns:
            The generated value. Never raises: a construct with no generatable value produces
            a diagnostic and the closest empty value of the right JSON type.
        """
        if resolved is None:
            # A property the schema requires but never describes: any value satisfies it.
            return _rng(self._seed, pointer).choice(_WORDS)

        if resolved.location in path:
            self._diagnose(
                "INPUT_DEPTH_LIMIT",
                f"The schema at {_render_location(resolved.location) or '/'} refers back to "
                "itself through a required property, so no finite payload satisfies it; "
                "generation stopped at the cycle and emitted an empty value.",
                pointer=_render_location(resolved.location),
            )
            return self._empty_value(resolved)
        if depth >= MAX_SYNTHESIS_DEPTH + RECURSION_TAIL_DEPTH:
            self._diagnose(
                "INPUT_DEPTH_LIMIT",
                f"Generation stopped at {MAX_SYNTHESIS_DEPTH + RECURSION_TAIL_DEPTH} levels of "
                "nesting; deeper values were emitted empty.",
                pointer=_render_location(resolved.location),
            )
            return self._empty_value(resolved)
        # Past the documented depth, only required properties are emitted: that is what makes
        # a deeply — but finitely — recursive schema terminate with a still-valid payload.
        effective_mode = "minimal" if depth >= MAX_SYNTHESIS_DEPTH else mode

        node = resolved.schema
        if not node:
            # `true`, `{}`, or an unresolvable reference: anything is acceptable, so the least
            # surprising payload is an empty object.
            return {}

        authored = self._authored_value(node, resolved, pointer)
        if authored is not None:
            return authored[0]

        json_type = _select_type(node)
        value = self._synthesize_typed(
            node,
            resolved,
            pointer,
            json_type,
            mode=effective_mode,
            depth=depth,
            path=path + (resolved.location,),
        )
        if json_type not in ("object", "array"):
            self._record(pointer, ORIGIN_SYNTHESIZED, resolved.location, synthetic=True)
        return value

    def _authored_value(
        self, node: Dict[str, Any], resolved: "_FlatSchema", pointer: str
    ) -> Optional[Tuple[Any]]:
        """Return the schema author's own value for this subschema, when there is a usable one.

        Precedence is ``const`` → ``examples``/``example`` → ``default`` → ``enum``: a
        ``const`` is the only value that can be right, and an author who wrote an example meant
        it to be the sample. An authored value that does not satisfy its own subschema is
        rejected here (with a diagnostic) rather than shipped — synthesis would otherwise
        propagate a schema's own broken examples into every generated payload.

        Args:
            node: The flattened subschema.
            resolved: The flattened schema's location and raw node.
            pointer: JSON Pointer the value will occupy, for provenance.

        Returns:
            A one-tuple holding the value, or ``None`` when nothing authored is usable. The
            tuple wrapper distinguishes "the author's value is ``None``" from "there is none".
        """
        for origin, candidate in self._authored_candidates(node):
            if not self._authored_is_usable(candidate, resolved):
                self._diagnose(
                    "INPUT_SEMANTIC_INVALID",
                    f"The `{origin}` value declared at "
                    f"{_render_location(resolved.location) or '/'} does not satisfy its own "
                    "schema, so it was not used; a conforming value was synthesized instead. "
                    "(The `examples.non-conforming-example` lint rule reports this on the "
                    "schema itself.)",
                    pointer=_render_location(resolved.location),
                )
                continue
            self._record(pointer, origin, resolved.location, synthetic=False)
            return (copy.deepcopy(candidate),)
        return None

    @staticmethod
    def _authored_candidates(node: Dict[str, Any]) -> List[Tuple[str, Any]]:
        """List the author-declared values for a subschema, in precedence order.

        Values the enclosing context excluded (see :data:`_EXCLUDE_KEYWORD`) are filtered out,
        which is how the ``else`` arm of a conditional avoids the value its ``if`` pins.
        """
        candidates: List[Tuple[str, Any]] = []
        if "const" in node:
            candidates.append((ORIGIN_CONST, node["const"]))
        examples = node.get("examples")
        if isinstance(examples, list) and examples:
            candidates.append((ORIGIN_EXAMPLE, examples[0]))
        elif isinstance(examples, dict) and examples:
            # OpenAPI's named-examples map: `{"name": {"value": ...}}`, first entry wins.
            first = next(iter(examples.values()))
            candidates.append(
                (ORIGIN_EXAMPLE, first["value"] if isinstance(first, dict) and "value" in first else first)
            )
        if "example" in node:
            candidates.append((ORIGIN_EXAMPLE, node["example"]))
        if "default" in node:
            candidates.append((ORIGIN_DEFAULT, node["default"]))
        enum = node.get("enum")
        if isinstance(enum, list) and enum:
            candidates.extend((ORIGIN_ENUM, entry) for entry in enum)
        excluded = _excluded_values(node)
        return [
            candidate for candidate in candidates if not _is_excluded(candidate[1], excluded)
        ]

    def _authored_is_usable(self, candidate: Any, resolved: "_FlatSchema") -> bool:
        """Whether an author-declared value satisfies the subschema that declares it.

        Validating a *fragment* of a document in isolation would break its intra-document
        ``$ref``s, so the check runs as ``{"$ref": "<root urn>#<pointer>"}`` against the whole
        document — the technique IXH-5.4 established. A subschema reached through an external
        reference, or reached only by flattening an ``allOf``, has no addressable pointer of
        its own; there the author's intent is trusted, and the final verification pass over the
        whole instance is what catches a mistake.
        """
        if self._verifier is None or resolved.location[0] != "" or not resolved.addressable:
            return True
        try:
            checker = self._validator_cls(
                {"$ref": f"{_ROOT_URN}#{resolved.location[1]}"},
                registry=self._verifier.registry,
            )
            return next(checker.iter_errors(candidate), None) is None
        except (Exception, RecursionError):  # noqa: BLE001 - unresolvable/unbounded: cannot check
            return True

    def _synthesize_typed(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        pointer: str,
        json_type: str,
        *,
        mode: str,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> Any:
        """Generate a value of ``json_type`` honouring the subschema's own constraints."""
        if json_type == "object":
            return self._generate_object(node, resolved, pointer, mode=mode, depth=depth, path=path)
        if json_type == "array":
            return self._generate_array(node, resolved, pointer, mode=mode, depth=depth, path=path)
        excluded = _excluded_values(node)
        if json_type == "boolean":
            value = _rng(self._seed, pointer).choice((True, False))
            return (not value) if _is_excluded(value, excluded) else value
        if json_type in ("integer", "number"):
            number = _number_value(node, _rng(self._seed, pointer), integer=json_type == "integer")
            return (number + 1) if _is_excluded(number, excluded) else number
        if json_type == "null":
            return None
        text = self._string_value(node, pointer)
        return f"{text}-alt" if _is_excluded(text, excluded) else text

    def _generate_object(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        pointer: str,
        *,
        mode: str,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> Dict[str, Any]:
        """Build an object: required properties always, every other property only in ``full``."""
        properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
        required = [name for name in node.get("required", []) if isinstance(name, str)]
        result: Dict[str, Any] = {}

        # Declaration order, so the payload reads the way the schema does.
        for name in properties:
            if mode != "full" and name not in required:
                continue
            child = self._flatten_child(resolved, ("properties", name), mode=mode)
            if name not in required and self._is_exhausted(child, depth + 1, path):
                # An optional property that would recurse or breach the depth bound is simply
                # left out: that is a valid payload, where a placeholder would not be.
                continue
            result[name] = self._generate(
                child,
                f"{pointer}/{_escape(name)}",
                mode=mode,
                depth=depth + 1,
                path=path,
            )
        # A schema may require a property it never declares. It is still required, so a value
        # has to exist; with no subschema to generate from, a plain string is the safe choice.
        for name in required:
            if name in result:
                continue
            result[name] = _rng(self._seed, f"{pointer}/{_escape(name)}").choice(_WORDS)

        if mode == "full":
            patterns = node.get("patternProperties")
            if isinstance(patterns, dict):
                for pattern in patterns:
                    key = _string_from_pattern(pattern, _rng(self._seed, f"{pointer}#{pattern}"))
                    if key is None or key in result:
                        continue
                    result[key] = self._generate(
                        self._flatten_child(resolved, ("patternProperties", pattern), mode=mode),
                        f"{pointer}/{_escape(key)}",
                        mode=mode,
                        depth=depth + 1,
                        path=path,
                    )

        result = self._apply_property_counts(node, resolved, result, pointer, mode, depth, path)
        self._record(pointer, ORIGIN_SYNTHESIZED, resolved.location, synthetic=True)
        return result

    def _apply_property_counts(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        result: Dict[str, Any],
        pointer: str,
        mode: str,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> Dict[str, Any]:
        """Bring an object inside ``minProperties`` / ``maxProperties``.

        Trimming keeps required properties, which is the only way an object can be both small
        enough and still valid; padding uses ``additionalProperties`` when the schema allows it.
        """
        required = {name for name in node.get("required", []) if isinstance(name, str)}
        maximum = node.get("maxProperties")
        if isinstance(maximum, int) and len(result) > maximum:
            kept = [name for name in result if name in required][:maximum]
            for name in result:
                if len(kept) >= maximum:
                    break
                if name not in kept:
                    kept.append(name)
            result = {name: result[name] for name in result if name in set(kept)}

        minimum = node.get("minProperties")
        if isinstance(minimum, int) and len(result) < minimum:
            additional = node.get("additionalProperties")
            index = 0
            while len(result) < minimum and index < minimum:
                name = f"extra{index}"
                index += 1
                if name in result:
                    continue
                if isinstance(additional, dict):
                    result[name] = self._generate(
                        self._flatten_child(resolved, ("additionalProperties",), mode=mode),
                        f"{pointer}/{_escape(name)}",
                        mode=mode,
                        depth=depth + 1,
                        path=path,
                    )
                elif additional is False:
                    self._diagnose(
                        "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                        f"The object at {_render_location(resolved.location) or '/'} requires "
                        f"at least {minimum} properties but declares fewer and forbids "
                        "additional ones, so no conforming payload exists.",
                        pointer=_render_location(resolved.location),
                    )
                    break
                else:
                    result[name] = _rng(self._seed, f"{pointer}/{name}").choice(_WORDS)
        return result

    def _generate_array(
        self,
        node: Dict[str, Any],
        resolved: "_FlatSchema",
        pointer: str,
        *,
        mode: str,
        depth: int,
        path: Tuple[_Location, ...],
    ) -> List[Any]:
        """Build an array: ``minItems`` entries when minimal, a couple more when full."""
        prefix_items = node.get("prefixItems")
        items = node.get("items")
        minimum = node.get("minItems") if isinstance(node.get("minItems"), int) else 0
        maximum = node.get("maxItems") if isinstance(node.get("maxItems"), int) else None

        result: List[Any] = []
        if isinstance(prefix_items, list):
            for index in range(len(prefix_items)):
                if maximum is not None and len(result) >= maximum:
                    break
                result.append(
                    self._generate(
                        self._flatten_child(resolved, ("prefixItems", index), mode=mode),
                        f"{pointer}/{index}",
                        mode=mode,
                        depth=depth + 1,
                        path=path,
                    )
                )

        item_schema = (
            self._flatten_child(resolved, ("items",), mode=mode) if isinstance(items, dict) else None
        )
        wanted = max(minimum, MAX_ARRAY_ITEMS if mode == "full" else minimum)
        if self._is_exhausted(item_schema, depth + 1, path):
            # A recursive item schema (`children: {items: {$ref: self}}`) must not be padded
            # out: only the items the schema actually requires are emitted, which for the usual
            # `minItems`-less recursive array means an empty one.
            wanted = minimum
        if isinstance(node.get("contains"), dict):
            wanted = max(wanted, 1)
        if maximum is not None:
            wanted = min(wanted, maximum)
        if isinstance(items, dict):
            while len(result) < wanted:
                result.append(
                    self._generate(
                        item_schema,
                        f"{pointer}/{len(result)}",
                        mode=mode,
                        depth=depth + 1,
                        path=path,
                    )
                )
        elif isinstance(node.get("contains"), dict) and len(result) < wanted:
            result.append(
                self._generate(
                    self._flatten_child(resolved, ("contains",), mode=mode),
                    f"{pointer}/{len(result)}",
                    mode=mode,
                    depth=depth + 1,
                    path=path,
                )
            )

        if node.get("uniqueItems") is True:
            deduped: List[Any] = []
            seen: Set[str] = set()
            for entry in result:
                key = _canonical(entry)
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(entry)
            if len(deduped) < minimum:
                self._diagnose(
                    "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                    f"The array at {_render_location(resolved.location) or '/'} needs "
                    f"{minimum} unique items but its item schema admits only "
                    f"{len(deduped)} distinct value(s).",
                    pointer=_render_location(resolved.location),
                )
            result = deduped

        self._record(pointer, ORIGIN_SYNTHESIZED, resolved.location, synthetic=True)
        return result

    def _string_value(self, node: Dict[str, Any], pointer: str) -> str:
        """Build a string from ``pattern``, then ``format``, then the seeded word pool."""
        rng = _rng(self._seed, pointer)
        pattern = node.get("pattern")
        if isinstance(pattern, str):
            from_pattern = _string_from_pattern(pattern, rng)
            if from_pattern is not None:
                return _clamp_string(from_pattern, node, rng, respect_pattern=True)
            self._diagnose(
                "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                f"No string could be generated for the pattern {pattern!r}; a placeholder was "
                "used instead. Declare an `examples` or `default` value to control it.",
            )
        fmt = node.get("format")
        if isinstance(fmt, str) and fmt in _FORMAT_VALUES:
            return _clamp_string(_FORMAT_VALUES[fmt], node, rng, respect_pattern=False)
        return _clamp_string(f"{rng.choice(_WORDS)}-{rng.choice(_WORDS)}", node, rng, False)

    @staticmethod
    def _empty_value(resolved: "_FlatSchema") -> Any:
        """The emptiest value of the right JSON type, for a cycle or a depth breach."""
        node = resolved.schema
        json_type = _select_type(node) if node else "object"
        return {"object": {}, "array": [], "string": "", "integer": 0, "number": 0, "boolean": False}.get(
            json_type
        )

    def _record(
        self, pointer: str, origin: str, location: _Location, *, synthetic: bool
    ) -> None:
        """Record where one value came from, up to :data:`MAX_PROVENANCE_ENTRIES`."""
        if len(self._provenance) >= MAX_PROVENANCE_ENTRIES:
            self._provenance_truncated = True
            return
        self._provenance.append(
            ValueProvenance(
                pointer=pointer,
                origin=origin,
                schema_pointer=_render_location(location),
                synthetic=synthetic,
            )
        )

    # -- schema access ------------------------------------------------------

    def _document(self, uri: str) -> Any:
        """Return the document at ``uri``, loading it through the retriever exactly once."""
        if uri in self._documents:
            return self._documents[uri]
        if uri in self._unresolvable:
            return None
        loaded = self._retrieve(uri) if self._retrieve is not None else None
        if not isinstance(loaded, dict):
            self._unresolvable.add(uri)
            self._diagnose(
                "INPUT_REFERENCE_UNRESOLVED",
                f"Reference target {uri!r} could not be resolved, so no value could be "
                "generated for the subschema that points at it. Nothing was fetched over the "
                "network.",
            )
            return None
        self._documents[uri] = loaded
        return loaded

    def _node_at(self, location: _Location) -> Any:
        """Return the schema node at ``location``, or ``None`` when the pointer misses."""
        document = self._document(location[0]) if location[0] else self._schema
        if document is None:
            return None
        node: Any = document
        for token in location[1].split("/")[1:]:
            key = token.replace("~1", "/").replace("~0", "~")
            if isinstance(node, dict):
                if key not in node:
                    return None
                node = node[key]
            elif isinstance(node, list):
                if not key.isdigit() or int(key) >= len(node):
                    return None
                node = node[int(key)]
            else:
                return None
        return node

    def _follow_ref(self, location: _Location) -> _Location:
        """Follow a ``$ref`` chain from ``location`` to the location it ultimately names.

        Bounded by the number of hops, so a ``$ref`` cycle between two documents terminates.
        """
        current = location
        for _ in range(MAX_SYNTHESIS_DEPTH + RECURSION_TAIL_DEPTH):
            node = self._node_at(current)
            if not isinstance(node, dict):
                return current
            ref = node.get("$ref")
            if not isinstance(ref, str) or not ref:
                return current
            target = self._ref_location(ref, current[0])
            if target is None or target == current:
                return current
            current = target
        return current

    def _ref_location(self, ref: str, document_uri: str) -> Optional[_Location]:
        """Resolve a ``$ref`` string to a :data:`_Location`, or ``None`` when it cannot be."""
        if ref.startswith("#"):
            fragment = ref[1:]
            if fragment and not fragment.startswith("/"):
                # A plain-name anchor (`#Address`). Anchors are not addressable by pointer, so
                # generation cannot follow them; the verifier still resolves them normally.
                self._diagnose(
                    "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
                    f"Reference {ref!r} names an anchor rather than a JSON Pointer; no value "
                    "could be generated for it.",
                )
                return None
            return (document_uri, fragment)
        absolute = urljoin(document_uri or self._base_uri, ref)
        target_uri, fragment = urldefrag(absolute)
        if fragment and not fragment.startswith("/"):
            return None
        if self._document(target_uri) is None:
            return None
        return (target_uri, fragment)

    def _flatten(self, location: _Location, *, mode: str = "full") -> "_FlatSchema":
        """Resolve, merge, and branch-select the subschema at ``location``.

        ``$ref`` is followed; ``allOf`` members, the pinned (or first) alternative of
        ``oneOf``/``anyOf``, the applicable ``dependentSchemas`` groups, and the selected
        ``if``/``then``/``else`` arm are all merged in — so the caller sees one flat set of
        constraints to generate from, and one list of the locations they came from.

        Args:
            location: Where the subschema lives.
            mode: ``minimal`` or ``full``. It decides only whether a ``dependentSchemas`` /
                ``dependentRequired`` group applies: its trigger property is always present in
                the full instance, and present in the minimal one only when required.

        Returns:
            The :class:`_FlatSchema`. ``schema`` is empty when the location resolves to
            nothing, to ``true``, or to a reference that could not be resolved.
        """
        cached = self._flatten_cache.get((location, mode))
        if cached is not None:
            return cached
        resolved_location = self._follow_ref(location)
        node = self._node_at(resolved_location)
        if not isinstance(node, dict):
            # `true`, `false`, or an unresolvable reference — no constraints to generate from.
            return _FlatSchema({}, {}, resolved_location, (), addressable=False)
        if resolved_location in self._flattening:
            # A schema that merges itself (`{"allOf": [{"$ref": "#"}]}`) would otherwise flatten
            # forever. Its own keywords are already in the enclosing merge, so contributing
            # nothing here is both terminating and correct.
            return _FlatSchema({}, node, resolved_location, (), addressable=False)

        merged = {key: value for key, value in node.items() if key not in _COMBINATOR_KEYWORDS}
        # Every location whose keywords ended up in `merged`, base first. Child subschemas are
        # looked up through this list (see :meth:`_flatten_child`), because a property merged
        # in from an `allOf` member or a `oneOf` branch does not exist under the base location.
        sources: List[_Location] = [resolved_location]
        addressable = True

        def absorb(pointer_tokens: str) -> None:
            """Merge the subschema at ``<resolved_location><pointer_tokens>`` into the result."""
            nonlocal merged, addressable
            member = self._flatten(
                (resolved_location[0], f"{resolved_location[1]}{pointer_tokens}"), mode=mode
            )
            merged = _merge_schema(merged, member.schema)
            sources.extend(member.sources)
            addressable = False

        self._flattening.append(resolved_location)
        try:
            all_of = node.get("allOf")
            if isinstance(all_of, list):
                for index in range(len(all_of)):
                    absorb(f"/allOf/{index}")

            for keyword in ("oneOf", "anyOf"):
                options = node.get(keyword)
                if not isinstance(options, list) or not options:
                    continue
                selector = self._pins.get(_pin_key(resolved_location, keyword), "0")
                index = (
                    int(selector) if selector.isdigit() and int(selector) < len(options) else 0
                )
                absorb(f"/{keyword}/{index}")

            # Dependent constraints apply once their trigger property is present, which — in
            # the `full` instance — is every declared property. Folding them in here is what
            # keeps a `dependentSchemas` group (`sameAsShipping` present ⇒ it must be `true`)
            # from being generated into a payload that contradicts itself.
            dependent_required = node.get("dependentRequired")
            if isinstance(dependent_required, dict):
                for trigger, names in dependent_required.items():
                    if isinstance(names, list) and self._dependency_applies(
                        node, merged, trigger, mode
                    ):
                        merged = _merge_schema(
                            merged,
                            {"required": [name for name in names if isinstance(name, str)]},
                        )
            dependent_schemas = node.get("dependentSchemas")
            if isinstance(dependent_schemas, dict):
                for trigger in dependent_schemas:
                    if self._dependency_applies(node, merged, trigger, mode):
                        absorb(f"/dependentSchemas/{_escape(trigger)}")

            if isinstance(node.get("if"), dict):
                arm = self._pins.get(_pin_key(resolved_location, "if"), "then")
                if arm == "then" and isinstance(node.get("then"), dict):
                    # Satisfying the condition is what makes the `then` arm reachable at all.
                    absorb("/if")
                    absorb("/then")
                elif arm == "else" and isinstance(node.get("else"), dict):
                    # The `else` arm is reached by *not* satisfying the condition. Negating an
                    # arbitrary schema is not something a generator can do, but the shape that
                    # actually occurs — a condition pinning one property to a `const` or
                    # `enum` — is negated exactly by refusing to generate those values.
                    merged = _merge_schema(merged, _exclusions_for(node["if"]))
                    absorb("/else")
        finally:
            self._flattening.pop()

        flat = _FlatSchema(
            merged, node, resolved_location, tuple(sources), addressable=addressable
        )
        self._flatten_cache[(location, mode)] = flat
        return flat

    def _flatten_child(
        self, resolved: "_FlatSchema", tokens: Sequence[Any], *, mode: str
    ) -> Optional["_FlatSchema"]:
        """Flatten the subschema under ``tokens``, across *every* source that declares it.

        ``resolved.schema`` is a merged view, and so is each of its children: a property can be
        declared by the base *and* constrained further by an ``allOf`` member, a selected
        ``oneOf`` branch, or a ``dependentSchemas`` group. Reading the child from a single
        location would silently drop the other contributions — that is how a ``const`` added by
        a dependent group gets generated as a free boolean, and how every property of a
        polymorphic schema comes out as ``{}``.

        Args:
            resolved: The flattened schema whose child is wanted.
            tokens: Pointer tokens below the schema node, e.g. ``("properties", "id")``.
            mode: ``minimal`` or ``full``, threaded through to the child's own flattening.

        Returns:
            The child's flattened schema, or ``None`` when no contributing source declares it.
        """
        suffix = "".join(f"/{_escape(token)}" for token in tokens)
        combined: Optional[_FlatSchema] = None
        for document_uri, pointer in resolved.sources:
            candidate = (document_uri, f"{pointer}{suffix}")
            if self._node_at(candidate) is None:
                continue
            flat = self._flatten(candidate, mode=mode)
            combined = flat if combined is None else _combine_flat(combined, flat)

        # Value exclusions live only in the parent's merged view (no document declares them),
        # so they are carried across explicitly.
        exclusions = _exclusions_at(resolved.schema, tokens)
        if combined is not None and exclusions:
            combined = _FlatSchema(
                schema=_merge_schema(combined.schema, exclusions),
                raw=combined.raw,
                location=combined.location,
                sources=combined.sources,
                addressable=False,
            )
        return combined

    @staticmethod
    def _dependency_applies(
        node: Dict[str, Any], merged: Dict[str, Any], trigger: Any, mode: str
    ) -> bool:
        """Whether a dependent group's trigger property will actually be in the payload.

        Args:
            node: The subschema as written.
            merged: The constraints accumulated so far, read for ``required``.
            trigger: The property name the dependency keys off.
            mode: ``minimal`` or ``full``.

        Returns:
            ``True`` when the trigger is required (so it is present in either mode), or when
            the full instance will emit it because the schema declares it.
        """
        if not isinstance(trigger, str):
            return False
        required = merged.get("required")
        if isinstance(required, list) and trigger in required:
            return True
        properties = node.get("properties")
        return mode == "full" and isinstance(properties, dict) and trigger in properties

    @staticmethod
    def _is_exhausted(
        flat: Optional["_FlatSchema"], depth: int, path: Tuple[_Location, ...]
    ) -> bool:
        """Whether generating ``flat`` here would hit a cycle or the depth bound.

        Used to *skip* optional properties and surplus array items rather than emit empty
        placeholders for them: a schema's recursion is almost always through an optional
        property or an unbounded array, and omitting it is both valid and what a hand-written
        sample would do.
        """
        if flat is None:
            return False
        return depth >= MAX_SYNTHESIS_DEPTH or flat.location in path

    # -- verification -------------------------------------------------------

    def _validate(self, instance: Any) -> JsonValidationResult:
        """Validate a generated payload against the schema through the IXH-5.1 core.

        An infinitely recursive schema (``{"allOf": [{"$ref": "#"}]}``) exhausts the
        interpreter stack inside the validator itself — for any instance, including one a user
        submitted. Generation terminates regardless (see :data:`MAX_SYNTHESIS_DEPTH`), so the
        honest outcome is "not checked" with a diagnostic, never a 500.
        """
        try:
            return validate_json_instance(
                self._schema,
                instance,
                dialect=self._dialect,
                base_uri=self._base_uri,
                retrieve=self._retrieve,
            )
        except RecursionError:
            self._diagnose(
                "INPUT_DEPTH_LIMIT",
                "The schema is infinitely recursive: validating any instance against it "
                "exhausts the validator. Generated payloads are returned unverified.",
            )
            return JsonValidationResult(
                valid=None,
                validated=False,
                validator=f"jsonschema/{self._dialect}",
                dialect=self._dialect,
            )

    def _top_level_errors(self, instance: Any) -> Optional[List[Any]]:
        """Top-level (un-flattened) validation errors, or ``None`` when they cannot be counted.

        Mutant acceptance counts *root causes*, which the IXH-5.1 report deliberately flattens
        together with their branch sub-errors — so this goes to the validator directly.
        """
        if self._verifier is None:
            return None
        try:
            return list(self._verifier.validator.iter_errors(instance))
        except (RecursionError, Unresolvable):
            # An infinitely recursive schema, or one whose `$ref` the closed registry cannot
            # satisfy. Either way nothing can be counted, and "unknown" is the honest answer.
            return None


@dataclass(frozen=True)
class _FlatSchema:
    """A subschema with its combinators merged in.

    Attributes:
        schema: The merged constraints to generate from.
        raw: The node as written, before merging — the only place keywords the merge drops
            (``discriminator``'s enclosing ``oneOf``, for instance) can still be read.
        location: Where the node lives after ``$ref`` resolution.
        sources: Every location that contributed keywords to :attr:`schema`, base first.
            :meth:`_Synthesizer._flatten_child` merges the children of all of them.
        addressable: Whether :attr:`schema` is exactly the document node at :attr:`location`.
            ``False`` once anything was merged in, which is what makes pointer-addressed
            subschema validation unsafe for it.
    """

    schema: Dict[str, Any]
    raw: Dict[str, Any]
    location: _Location
    sources: Tuple[_Location, ...] = ()
    addressable: bool = True


# ===========================================================================
# Verification helpers
# ===========================================================================


def _combine_flat(first: _FlatSchema, second: _FlatSchema) -> _FlatSchema:
    """Merge two flattened views of the *same* subschema into one.

    Produced when more than one contributing source declares the same child — a property the
    base schema declares and an ``allOf`` member or ``dependentSchemas`` group constrains
    further. The first source keeps its identity (location, and the raw node the discriminator
    is read from, unless only the second declares one), while the constraints are merged.

    Args:
        first: The view from the earlier source.
        second: The view from the later source.

    Returns:
        The combined view. It is never :attr:`_FlatSchema.addressable`: it corresponds to no
        single node in any document, so it cannot be validated by pointer.
    """
    raw = first.raw
    if "discriminator" not in raw and "discriminator" in second.raw:
        raw = second.raw
    return _FlatSchema(
        schema=_merge_schema(first.schema, second.schema),
        raw=raw,
        location=first.location,
        sources=first.sources + second.sources,
        addressable=False,
    )


@dataclass(frozen=True)
class _Verifier:
    """The validator a run verifies with, and the registry it resolves references through.

    The registry is kept alongside the validator because subschema checks build *their own*
    validator (``{"$ref": "<root urn>#<pointer>"}``) and must resolve against the same closed
    set of documents — ``jsonschema`` does not expose a validator's registry as public API.

    Attributes:
        validator: Validator bound to the whole schema, used for top-level error counting.
        registry: The reference registry, with the root document also reachable under
            :data:`_ROOT_URN`.
    """

    validator: Any
    registry: Registry


def _build_verifier(
    schema: Dict[str, Any],
    validator_cls: Any,
    base_uri: str,
    retrieve: Optional[SchemaRetriever],
) -> Optional[_Verifier]:
    """Build the validator used for mutant acceptance and authored-value checks.

    One validator is built per run and reused: mutant acceptance needs *top-level* errors
    (:meth:`_Synthesizer._accepted_report` counts them), which the IXH-5.1 report flattens away,
    and building a reference registry per mutant would be wasteful.

    Args:
        schema: The root schema.
        validator_cls: The ``jsonschema`` validator class for the resolved dialect.
        base_uri: Absolute URI the schema's relative refs resolve against.
        retrieve: Resolver for external references.

    Returns:
        The validator, or ``None`` when the schema is not a usable schema — in which case
        nothing can be verified and every generated instance reports ``valid = None``.
    """
    try:
        validator_cls.check_schema(schema)
    except Exception:  # noqa: BLE001 - an unusable schema is reported by the validation pass
        return None
    registry, _diagnostics = build_reference_registry(
        schema, base_uri=base_uri, retrieve=retrieve
    )
    try:
        resource = Resource.from_contents(schema)
    except Exception:  # noqa: BLE001 - no `$schema`: default to the dialect the run resolved
        resource = DRAFT202012.create_resource(schema)
    registry = registry.with_resource(uri=_ROOT_URN, resource=resource)
    return _Verifier(validator=validator_cls(schema, registry=registry), registry=registry)


def _reported_site(candidate: _Mutation) -> str:
    """The instance pointer a validator reports the candidate's violation at.

    Most keywords are reported at the value they constrain, but the object-scoped ones
    (``required``, ``additionalProperties``, and a discriminator's enclosing combinator) are
    reported at the *container*, not at the property the mutation touched.
    """
    if candidate.kind in (
        MUTATION_REQUIRED_MISSING,
        MUTATION_ADDITIONAL_PROPERTIES,
        MUTATION_DISCRIMINATOR_MISMATCHED,
    ):
        return candidate.container
    return candidate.target_pointer


def _is_ancestor_pointer(ancestor: str, pointer: str) -> bool:
    """Whether ``ancestor`` is ``pointer`` itself or one of its parents."""
    return pointer == ancestor or pointer.startswith(f"{ancestor}/")


# ===========================================================================
# Mutation application
# ===========================================================================

#: Sentinel for a mutation whose target vanished — never returned to a caller.
_UNAPPLIED = object()


def _apply_mutation(baseline: Any, mutation: _Mutation) -> Any:
    """Apply one mutation to a deep copy of the baseline instance.

    Args:
        baseline: The valid instance to derive from; never modified.
        mutation: The edit to apply.

    Returns:
        The mutated payload, or :data:`_UNAPPLIED` when the target is not present (which can
        only happen if the baseline changed shape under a caller's feet).
    """
    mutated = copy.deepcopy(baseline)
    if mutation.key is None and not mutation.container and mutation.action == "set":
        return mutation.value

    container = _navigate(mutated, mutation.container)
    if container is None:
        return _UNAPPLIED

    if mutation.action == "truncate":
        if not isinstance(container, list):
            return _UNAPPLIED
        del container[mutation.value :]
        return mutated
    if mutation.action == "append":
        if not isinstance(container, list):
            return _UNAPPLIED
        container.append(mutation.value)
        return mutated

    key = mutation.key
    if isinstance(container, list):
        if not isinstance(key, int) or key >= len(container):
            return _UNAPPLIED
        if mutation.action == "remove":
            del container[key]
        else:
            container[key] = mutation.value
        return mutated
    if not isinstance(container, dict):
        return _UNAPPLIED
    if mutation.action == "remove":
        if key not in container:
            return _UNAPPLIED
        del container[key]
    else:
        container[key] = mutation.value
    return mutated


def _navigate(document: Any, pointer: str) -> Any:
    """Return the container a JSON Pointer addresses, or ``None`` when the pointer misses."""
    node = document
    for token in pointer.split("/")[1:]:
        key = token.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict):
            if key not in node:
                return None
            node = node[key]
        elif isinstance(node, list):
            if not key.isdigit() or int(key) >= len(node):
                return None
            node = node[int(key)]
        else:
            return None
    return node


def _split_pointer(pointer: str) -> Tuple[str, Optional[Any]]:
    """Split ``/a/b`` into the container pointer ``/a`` and the key ``b`` (index if numeric)."""
    if not pointer:
        return "", None
    head, _, last = pointer.rpartition("/")
    key = last.replace("~1", "/").replace("~0", "~")
    return head, int(key) if key.isdigit() else key


# ===========================================================================
# Mutation value construction
# ===========================================================================


def _declared_types(node: Dict[str, Any]) -> Tuple[str, ...]:
    """The JSON types a subschema declares, as a tuple (empty when it declares none)."""
    declared = node.get("type")
    if isinstance(declared, str):
        return (declared,)
    if isinstance(declared, list):
        return tuple(entry for entry in declared if isinstance(entry, str))
    return ()


def _wrong_type_value(declared: Sequence[str]) -> Optional[Tuple[str, Any]]:
    """A value of a type the schema forbids, or ``None`` when every type is allowed.

    ``integer`` and ``number`` are treated as one family: every integer is a valid ``number``
    instance, so an integer cannot be used to violate ``type: number``.
    """
    allowed = set(declared)
    if "number" in allowed or "integer" in allowed:
        allowed |= {"number", "integer"}
    for family, value in _WRONG_TYPE_CANDIDATES:
        if family not in allowed:
            return family, value
    return None


def _value_outside_enum(enum: Sequence[Any]) -> Optional[Any]:
    """A value of the enum's own JSON type that the enum does not list.

    Matching the type matters: a string enum violated by an integer would fail ``type`` *and*
    ``enum``, which is two failures, and the mutant would be rejected.
    """
    first = enum[0]
    if isinstance(first, bool):
        return None  # a boolean enum of both values has no outside; of one value, `not` it
    if isinstance(first, str):
        candidate = "apiome-synthetic-not-in-enum"
        return candidate if candidate not in enum else f"{candidate}-2"
    if isinstance(first, (int, float)):
        numbers = [entry for entry in enum if isinstance(entry, (int, float))]
        return (max(numbers) + 1) if numbers else None
    return None


def _string_violating_pattern(pattern: str, node: Dict[str, Any]) -> Optional[str]:
    """A string that fails ``pattern`` while still respecting the subschema's length bounds.

    Args:
        pattern: The regular expression the value must fail.
        node: The subschema, read for ``minLength`` / ``maxLength``.

    Returns:
        The violating string, or ``None`` when no candidate both fails the pattern and fits
        the length bounds (in which case no single-keyword mutant exists here).
    """
    minimum = node.get("minLength") if isinstance(node.get("minLength"), int) else 1
    maximum = node.get("maxLength") if isinstance(node.get("maxLength"), int) else None
    length = max(1, minimum)
    if maximum is not None:
        if maximum < length:
            return None
        length = min(length, maximum)
    for filler in ("~", "!", "§", "0", "Z"):
        candidate = filler * length
        if not _matches(pattern, candidate):
            return candidate
    return None


def _bound_violation(node: Dict[str, Any], value: Any) -> Optional[Tuple[str, Any, str]]:
    """The first bound this value can be pushed outside of, as ``(keyword, value, wording)``.

    One bound per value keeps the mutant single-keyword. Numeric bounds are stepped by
    ``multipleOf`` when one is declared, so the mutated value still satisfies it and only the
    bound fails. String-length bounds are skipped when a ``pattern`` is present, because
    changing the length would almost always break the pattern as well.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        step = node.get("multipleOf")
        step = step if isinstance(step, (int, float)) and step > 0 else 1
        integer = isinstance(value, int) and "integer" in (_declared_types(node) or ("integer",))
        if isinstance(node.get("maximum"), (int, float)):
            new = node["maximum"] + step
            return ("maximum", int(new) if integer and float(new).is_integer() else new,
                    "Pushes {pointer} above its `maximum`.")
        if isinstance(node.get("exclusiveMaximum"), (int, float)):
            return ("exclusiveMaximum", node["exclusiveMaximum"],
                    "Sets {pointer} exactly to its `exclusiveMaximum`, which is excluded.")
        if isinstance(node.get("minimum"), (int, float)):
            new = node["minimum"] - step
            return ("minimum", int(new) if integer and float(new).is_integer() else new,
                    "Pushes {pointer} below its `minimum`.")
        if isinstance(node.get("exclusiveMinimum"), (int, float)):
            return ("exclusiveMinimum", node["exclusiveMinimum"],
                    "Sets {pointer} exactly to its `exclusiveMinimum`, which is excluded.")
        return None
    if isinstance(value, str) and not isinstance(node.get("pattern"), str):
        maximum = node.get("maxLength")
        if isinstance(maximum, int):
            return ("maxLength", "x" * (maximum + 1), "Makes {pointer} longer than `maxLength`.")
        minimum = node.get("minLength")
        if isinstance(minimum, int) and minimum > 0:
            return ("minLength", "x" * (minimum - 1), "Makes {pointer} shorter than `minLength`.")
        return None
    if isinstance(value, list):
        unique = node.get("uniqueItems") is True
        maximum = node.get("maxItems")
        if isinstance(maximum, int) and len(value) >= maximum and not unique:
            # Appending a copy of an existing item cannot break the item schema, so `maxItems`
            # is the only keyword that fails — unless the array is `uniqueItems`, where the
            # copy would break that too, which is why the case is excluded.
            filler = copy.deepcopy(value[-1]) if value else "apiome-synthetic-overflow"
            return ("maxItems", filler, "Appends an item past `maxItems` to {pointer}.")
        minimum = node.get("minItems")
        if (
            isinstance(minimum, int)
            and minimum > 0
            and len(value) >= minimum
            and not isinstance(node.get("contains"), dict)
        ):
            return ("minItems", minimum - 1, "Truncates {pointer} below `minItems`.")
    return None


# ===========================================================================
# Value synthesis helpers
# ===========================================================================


def _rng(seed: int, pointer: str) -> random.Random:
    """A PRNG keyed by ``(seed, instance pointer)``.

    Keying on the pointer rather than on call order is what makes generation independent of
    traversal: the same field gets the same value in the minimal, full, branch, and mutant
    instances of one run, and reordering the generator's internals cannot change the output.
    """
    digest = hashlib.blake2b(f"{seed}\x00{pointer}".encode("utf-8"), digest_size=8).digest()
    return random.Random(int.from_bytes(digest, "big"))


def _select_type(node: Dict[str, Any]) -> str:
    """Choose the JSON type to generate for a subschema.

    An explicit ``type`` wins (the first entry of a union, preferring a non-``null`` one, since
    a payload of ``null`` demonstrates nothing). Otherwise the type is inferred from the
    keywords present, and ``string`` is the last resort.
    """
    declared = _declared_types(node)
    if declared:
        return next((entry for entry in declared if entry != "null"), declared[0])
    if any(key in node for key in ("properties", "required", "patternProperties", "propertyNames")):
        return "object"
    if any(key in node for key in ("items", "prefixItems", "contains", "minItems", "maxItems")):
        return "array"
    if any(key in node for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")):
        return "number"
    if any(key in node for key in ("additionalProperties", "unevaluatedProperties")):
        return "object"
    return "string"


def _number_value(node: Dict[str, Any], rng: random.Random, *, integer: bool) -> Any:
    """A number inside every bound the subschema declares.

    Bounds are applied before ``multipleOf`` snapping, and the snap moves *inwards* (up from a
    minimum, down from a maximum) so the result stays inside the range it was clamped to.
    """
    low = node.get("minimum")
    if not isinstance(low, (int, float)):
        exclusive_low = node.get("exclusiveMinimum")
        low = exclusive_low + (1 if integer else 0.5) if isinstance(exclusive_low, (int, float)) else None
    high = node.get("maximum")
    if not isinstance(high, (int, float)):
        exclusive_high = node.get("exclusiveMaximum")
        high = exclusive_high - (1 if integer else 0.5) if isinstance(exclusive_high, (int, float)) else None

    if low is None and high is None:
        value: float = rng.randint(1, 999) if integer else round(rng.uniform(1, 999), 2)
    elif low is None:
        value = high - rng.randint(0, 9)
    elif high is None:
        value = low + rng.randint(0, 9)
    elif high <= low:
        value = low
    else:
        value = low + (rng.randint(0, 999) / 1000) * (high - low)

    multiple = node.get("multipleOf")
    if isinstance(multiple, (int, float)) and multiple > 0:
        steps = int(value / multiple)
        value = steps * multiple
        if low is not None and value < low:
            value = (int(low / multiple) + 1) * multiple
        if high is not None and value > high:
            value = int(high / multiple) * multiple

    if integer:
        value = int(round(value))
        if low is not None and value < low:
            value = int(low if float(low).is_integer() else low + 1)
        if high is not None and value > high:
            value = int(high)
        return value
    return round(float(value), 4)


def _clamp_string(
    value: str, node: Dict[str, Any], rng: random.Random, respect_pattern: bool
) -> str:
    """Bring a string inside ``minLength`` / ``maxLength``.

    Args:
        value: The candidate string.
        node: The subschema.
        rng: The pointer-keyed PRNG, so padding is deterministic.
        respect_pattern: When the value was generated *from* a ``pattern``, padding or
            trimming it would break the pattern, so the length bounds are left to the
            verification pass to report instead.

    Returns:
        The adjusted string.
    """
    minimum = node.get("minLength")
    maximum = node.get("maxLength")
    if respect_pattern:
        return value
    if isinstance(maximum, int) and len(value) > maximum:
        value = value[:maximum]
    if isinstance(minimum, int) and len(value) < minimum:
        filler = rng.choice(_WORDS)
        while len(value) < minimum:
            value = f"{value}{filler}"
        value = value[:minimum] if not isinstance(maximum, int) else value[: min(minimum, maximum)]
    return value


def _matches(pattern: str, value: str) -> bool:
    """Whether ``pattern`` matches anywhere in ``value`` (JSON Schema ``pattern`` semantics)."""
    try:
        return re.search(pattern, value) is not None
    except re.error:
        return False


def _string_from_pattern(pattern: str, rng: random.Random) -> Optional[str]:
    """Build a string that satisfies a regular expression, or ``None`` when it cannot.

    Handles the constructs that appear in real schema patterns — literals, character classes
    and ranges, the digit/word/space categories, repetition, alternation, groups, and anchors —
    and gives up on anything else (back-references, look-around) rather than guessing. The
    result is always re-checked against the pattern before it is returned, so a construct this
    sampler mishandles produces ``None`` instead of an invalid value.

    Args:
        pattern: The regular expression, as written in the schema.
        rng: The pointer-keyed PRNG, so the same pattern at the same pointer yields the same
            string.

    Returns:
        A matching string, or ``None``.
    """
    try:
        parsed = _regex_parser.parse(pattern)
    except Exception:  # noqa: BLE001 - an invalid pattern is the schema's problem, not ours
        return None
    built = _emit_regex(parsed, rng)
    if built is None:
        return None
    return built if _matches(pattern, built) else None


def _emit_regex(tokens: Iterable[Any], rng: random.Random) -> Optional[str]:
    """Emit a string for a parsed regular-expression subpattern (see :func:`_string_from_pattern`)."""
    out: List[str] = []
    for opcode, argument in tokens:
        name = getattr(opcode, "name", str(opcode))
        if name == "LITERAL":
            out.append(chr(argument))
        elif name == "NOT_LITERAL":
            out.append("a" if argument != ord("a") else "b")
        elif name == "ANY":
            out.append("a")
        elif name == "IN":
            emitted = _emit_regex_class(argument, rng)
            if emitted is None:
                return None
            out.append(emitted)
        elif name in ("MAX_REPEAT", "MIN_REPEAT"):
            low, high, subpattern = argument
            # One repetition past the minimum keeps `{2,}` and `+` non-degenerate without
            # producing an unbounded string for `*`.
            count = low if low > 0 else min(1, high if isinstance(high, int) else 1)
            count = max(count, 1) if low == 0 and name == "MAX_REPEAT" else count
            for _ in range(min(count, 32)):
                emitted = _emit_regex(subpattern, rng)
                if emitted is None:
                    return None
                out.append(emitted)
        elif name == "SUBPATTERN":
            emitted = _emit_regex(argument[-1], rng)
            if emitted is None:
                return None
            out.append(emitted)
        elif name == "BRANCH":
            branches = argument[1]
            if not branches:
                return None
            emitted = _emit_regex(branches[0], rng)
            if emitted is None:
                return None
            out.append(emitted)
        elif name == "AT":
            continue  # anchors constrain position, not content
        elif name == "ATOMIC_GROUP":
            emitted = _emit_regex(argument, rng)
            if emitted is None:
                return None
            out.append(emitted)
        else:
            return None
    return "".join(out)


def _emit_regex_class(members: Sequence[Any], rng: random.Random) -> Optional[str]:
    """Emit one character for a parsed character class, or ``None`` for a negated/odd one."""
    for opcode, argument in members:
        name = getattr(opcode, "name", str(opcode))
        if name == "NEGATE":
            return None
        if name == "LITERAL":
            return chr(argument)
        if name == "RANGE":
            low, high = argument
            return chr(rng.randint(low, min(high, low + 25)))
        if name == "CATEGORY":
            category = getattr(argument, "name", str(argument))
            if category == "CATEGORY_DIGIT":
                return str(rng.randint(0, 9))
            if category == "CATEGORY_WORD":
                return rng.choice("abcdefghijklmnopqrstuvwxyz")
            if category == "CATEGORY_SPACE":
                return " "
            return None
    return None


# ===========================================================================
# Small shared helpers
# ===========================================================================


def _merge_schema(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    """Merge one subschema's constraints into another, tightening rather than overwriting.

    Used to flatten ``allOf`` and to fold a selected branch into its parent. Numeric and
    cardinality bounds take the stricter of the two, ``required`` is a union, ``properties``
    are merged per property, ``enum`` is intersected, and a ``false``
    ``additionalProperties`` wins — all of which reproduce what a validator would enforce for
    the two schemas together. Any other keyword the base already declares is left alone.

    Args:
        base: The schema being built up (never modified).
        extra: The schema to merge in.

    Returns:
        The merged schema.
    """
    if not extra:
        return dict(base)
    merged = dict(base)
    for key, value in extra.items():
        if key in _COMBINATOR_KEYWORDS:
            continue
        if key == "properties" and isinstance(value, dict):
            properties = dict(merged.get("properties") or {})
            for name, subschema in value.items():
                existing = properties.get(name)
                properties[name] = (
                    _merge_schema(existing, subschema)
                    if isinstance(existing, dict) and isinstance(subschema, dict)
                    else subschema
                )
            merged["properties"] = properties
        elif key == "required" and isinstance(value, list):
            required = list(merged.get("required") or [])
            required.extend(name for name in value if name not in required)
            merged["required"] = required
        elif key == "enum" and isinstance(value, list) and isinstance(merged.get("enum"), list):
            intersection = [entry for entry in merged["enum"] if entry in value]
            merged["enum"] = intersection or merged["enum"]
        elif key in ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"):
            merged[key] = max(value, merged[key]) if key in merged else value
        elif key in ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"):
            merged[key] = min(value, merged[key]) if key in merged else value
        elif key == _EXCLUDE_KEYWORD and isinstance(value, list):
            existing = merged.get(key)
            merged[key] = (list(existing) if isinstance(existing, list) else []) + [
                entry for entry in value if entry not in (existing or [])
            ]
        elif key == "additionalProperties":
            merged[key] = False if value is False or merged.get(key) is False else value
        elif key not in merged:
            merged[key] = value
    return merged


def _round_robin(groups: Sequence[Sequence[_Mutation]]) -> List[_Mutation]:
    """Interleave groups so a cap on the total keeps every group represented.

    Taking the first N of a flat list would give a schema with forty required properties forty
    ``required-missing`` mutants and nothing else.
    """
    ordered: List[_Mutation] = []
    index = 0
    while True:
        added = False
        for group in groups:
            if index < len(group):
                ordered.append(group[index])
                added = True
        if not added:
            return ordered
        index += 1


def _exclusions_for(condition: Any) -> Dict[str, Any]:
    """Turn an ``if`` condition into the values its ``else`` arm must avoid.

    Only the shape that a generator can honestly negate is handled: a ``const`` or ``enum``
    pinned on the condition itself or on one of its properties. Anything else contributes no
    exclusions, and the verification pass reports an ``else`` instance that satisfies its
    condition anyway rather than pretending it covers the arm.

    Args:
        condition: The ``if`` subschema.

    Returns:
        A schema fragment carrying :data:`_EXCLUDE_KEYWORD` entries, ready to merge.
    """
    if not isinstance(condition, dict):
        return {}
    fragment: Dict[str, Any] = {}
    own = _pinned_values(condition)
    if own:
        fragment[_EXCLUDE_KEYWORD] = own
    properties = condition.get("properties")
    if isinstance(properties, dict):
        excluded_properties = {
            name: {_EXCLUDE_KEYWORD: _pinned_values(subschema)}
            for name, subschema in properties.items()
            if isinstance(subschema, dict) and _pinned_values(subschema)
        }
        if excluded_properties:
            fragment["properties"] = excluded_properties
    return fragment


def _pinned_values(subschema: Dict[str, Any]) -> List[Any]:
    """The exact values a subschema pins through ``const`` or ``enum`` (empty when it pins none)."""
    if "const" in subschema:
        return [subschema["const"]]
    enum = subschema.get("enum")
    return list(enum) if isinstance(enum, list) else []


def _exclusions_at(merged: Dict[str, Any], tokens: Sequence[Any]) -> Dict[str, Any]:
    """Read the exclusions the parent's merged view records for one of its children."""
    node: Any = merged
    for token in tokens:
        if not isinstance(node, dict):
            return {}
        node = node.get(str(token))
    if isinstance(node, dict) and node.get(_EXCLUDE_KEYWORD):
        return {_EXCLUDE_KEYWORD: list(node[_EXCLUDE_KEYWORD])}
    return {}


def _excluded_values(node: Dict[str, Any]) -> List[Any]:
    """The values a subschema has been told not to produce."""
    values = node.get(_EXCLUDE_KEYWORD)
    return list(values) if isinstance(values, list) else []


def _is_excluded(value: Any, excluded: Sequence[Any]) -> bool:
    """Whether ``value`` is one of the excluded values, comparing JSON-equal, not identical."""
    return any(value == entry and type(value) is type(entry) for entry in excluded)


def _pin_key(location: _Location, keyword: str) -> str:
    """Key identifying one combinator site, for the branch-pinning map."""
    return f"{_render_location(location)}|{keyword}"


def _render_location(location: _Location) -> str:
    """Render a location as a pointer (``/properties/id``) or ``<uri>#<pointer>``."""
    document_uri, pointer = location
    return f"{document_uri}#{pointer}" if document_uri else pointer


def _escape(token: Any) -> str:
    """Escape one JSON Pointer reference token per RFC 6901 (``~`` → ``~0``, ``/`` → ``~1``)."""
    return str(token).replace("~", "~0").replace("/", "~1")


def _canonical(value: Any) -> str:
    """Canonical JSON for a payload, used to recognise a duplicate branch instance."""
    try:
        return json.dumps(value, sort_keys=True, default=str)
    except (TypeError, ValueError):  # pragma: no cover - generated values are always JSON
        return repr(value)
