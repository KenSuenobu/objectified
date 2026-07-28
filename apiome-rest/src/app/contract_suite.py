"""Compile a published canonical version into a deterministic contract suite — ECA-1.1 (#4729).

A published specification is passive. Until somebody hand-writes verification cases, "the API
matches its contract" is an opinion, and the cases that do get written are inconsistent between
teams and impossible to reproduce a month later. This module turns the specification itself into
the suite: one canonical model plus one set of compiler options in, one **versioned manifest** of
executable request cases out.

What a case is
--------------
Each :class:`ContractCase` is a complete, concrete HTTP exchange description — method, resolved
path, parameter values, body, and the outcome the contract promises — plus the provenance that
makes it reviewable:

* ``source`` says where the case came from, and the compiler works in that order of preference:
  a **declared example** the author wrote, then **schema-valid generated values** (the
  required-only payload, the every-field payload, one payload per polymorphic branch), then the
  **negative cases** a contract needs to be worth running (a required body omitted, a required
  query parameter dropped, a parameter given the wrong type, and bodies that each violate
  exactly one schema constraint).
* ``expect`` says what should happen — the declared status codes and, for a success case, the
  schema the response must satisfy — and whether those codes were declared or defaulted.
* ``synthetic`` is ``False`` only when the request body is an author's own example. Everything
  this module invents says so, on every case.

Three guarantees, because the rest of Executable Contract Assurance is built on them
------------------------------------------------------------------------------------
* **Deterministic.** The same canonical model and the same options produce a **byte-identical**
  manifest — :func:`canonical_manifest_bytes` is that artifact, and :attr:`
  ContractSuiteManifest.digest` is its SHA-256. Nothing here reads the clock, the network, or an
  unseeded PRNG; generated values come from :mod:`app.schema_instance_synthesis` under a seed
  derived from the operation key, cases are emitted in a fixed order, and every mapping is
  written sorted. A gate that says "this deploy is covered by suite ``sha256:ab12…``" is only
  meaningful because of this.
* **Attributed.** Every case names its operation, its source, and its expected outcome. There is
  no anonymous case, and no case whose expectation was guessed without saying so.
* **Honest.** What the compiler cannot express, it **reports**. A gRPC stream, a GraphQL field,
  an operation with no route, a body that is only offered as ``application/xml``, a parameter
  shape the path grammar cannot carry, an example that does not satisfy its own schema, a
  response with no declared status — each becomes a :class:`SuiteFinding`. A suite that silently
  skipped half a specification would be worse than no suite, because it would read as coverage.

Scope
-----
HTTP request/response operations. That is what a contract runner (ECA-2.1) can execute today.
Event, RPC-streaming, and GraphQL paradigms are recognized and reported as unsupported rather
than half-compiled. Authentication is deliberately **not** compiled: a suite carries no
credentials, so a specification with security requirements gets a finding telling the runner it
must supply them (targets and their secrets are ECA-1.2's job).

This module is pure — a canonical model in, a manifest out. Resolution of a version reference,
tenant scoping, and persistence live in :mod:`app.contract_suite_service` and above.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field

from .canonical_json_schema import (
    MAX_PROJECTED_DEFS,
    CanonicalSchemaProjection,
    build_ref_json_schema,
    build_type_json_schema,
)
from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    Parameter,
    ParameterLocation,
    Service,
    StreamingMode,
    TypeRef,
)
from .contract_suite_examples import (
    SITE_PARAMETER,
    SITE_REQUEST_BODY,
    DeclaredExample,
    DeclaredExampleHarvest,
    harvest_declared_examples,
)
from .example_conformance import SPEC_BASE_URI, resolve_example_family
from .schema_instance_synthesis import (
    INSTANCE_BRANCH,
    INSTANCE_FULL,
    INSTANCE_MINIMAL,
    INSTANCE_MUTANT,
    MAX_SEED,
    SynthesizedInstance,
    synthesize_instances,
)
from .schema_validation import DRAFT_2020_12

__all__ = [
    "CASE_SOURCES",
    "CASE_SOURCE_DECLARED_EXAMPLE",
    "CASE_SOURCE_GENERATED_BRANCH",
    "CASE_SOURCE_GENERATED_FULL",
    "CASE_SOURCE_GENERATED_MINIMAL",
    "CASE_SOURCE_NEGATIVE_BODY_MUTATION",
    "CASE_SOURCE_NEGATIVE_MISSING_BODY",
    "CASE_SOURCE_NEGATIVE_MISSING_PARAMETER",
    "CASE_SOURCE_NEGATIVE_PARAMETER_TYPE",
    "CONTRACT_SUITE_COMPILER_VERSION",
    "CONTRACT_SUITE_SCHEMA_VERSION",
    "FINDING_LEVELS",
    "MAX_OPERATIONS_CEILING",
    "OUTCOME_CLIENT_ERROR",
    "OUTCOME_SUCCESS",
    "SUITE_DIGEST_ALGORITHM",
    "SUITE_FINDING_CODES",
    "ContractCase",
    "ContractCaseExpectation",
    "ContractCaseRequest",
    "ContractRequestParameter",
    "ContractSuiteManifest",
    "ContractSuiteOptions",
    "SuiteApiInfo",
    "SuiteFinding",
    "SuiteOperation",
    "SuiteSourceInfo",
    "canonical_manifest_bytes",
    "compile_contract_suite",
    "manifest_digest",
]

# ===========================================================================
# Vocabulary and bounds
# ===========================================================================

#: Envelope version of the manifest shape. Bumped when a field is added, removed, or given a
#: new meaning, so a stored manifest can be read by the version of the code that wrote it.
CONTRACT_SUITE_SCHEMA_VERSION = 1

#: Version of the *compilation rules*. Bumped whenever the compiler would produce different
#: cases for the same input — which changes the digest, and must, because a gate pinned to an
#: old digest is no longer pinned to the same suite.
CONTRACT_SUITE_COMPILER_VERSION = 1

#: Hash the suite digest is computed with.
SUITE_DIGEST_ALGORITHM = "sha256"

#: A case whose request body an author wrote by hand.
CASE_SOURCE_DECLARED_EXAMPLE = "declared_example"
#: A generated body carrying required properties only.
CASE_SOURCE_GENERATED_MINIMAL = "generated_minimal"
#: A generated body carrying every optional property as well.
CASE_SOURCE_GENERATED_FULL = "generated_full"
#: A generated body covering one alternative of a polymorphic body schema.
CASE_SOURCE_GENERATED_BRANCH = "generated_branch"
#: A generated body that violates exactly one schema constraint.
CASE_SOURCE_NEGATIVE_BODY_MUTATION = "negative_body_mutation"
#: A request that omits a body the contract declares required.
CASE_SOURCE_NEGATIVE_MISSING_BODY = "negative_missing_body"
#: A request that omits a required query parameter.
CASE_SOURCE_NEGATIVE_MISSING_PARAMETER = "negative_missing_parameter"
#: A request that carries a parameter value of the wrong type.
CASE_SOURCE_NEGATIVE_PARAMETER_TYPE = "negative_parameter_type"

#: Every case source, in the order cases are emitted within one operation.
CASE_SOURCES: Tuple[str, ...] = (
    CASE_SOURCE_DECLARED_EXAMPLE,
    CASE_SOURCE_GENERATED_MINIMAL,
    CASE_SOURCE_GENERATED_FULL,
    CASE_SOURCE_GENERATED_BRANCH,
    CASE_SOURCE_NEGATIVE_MISSING_BODY,
    CASE_SOURCE_NEGATIVE_MISSING_PARAMETER,
    CASE_SOURCE_NEGATIVE_PARAMETER_TYPE,
    CASE_SOURCE_NEGATIVE_BODY_MUTATION,
)

#: The sources whose cases are expected to be rejected by a conforming implementation.
_NEGATIVE_SOURCES = frozenset(
    {
        CASE_SOURCE_NEGATIVE_BODY_MUTATION,
        CASE_SOURCE_NEGATIVE_MISSING_BODY,
        CASE_SOURCE_NEGATIVE_MISSING_PARAMETER,
        CASE_SOURCE_NEGATIVE_PARAMETER_TYPE,
    }
)

#: The expected outcome of a case: the implementation accepts it, or rejects it as a client error.
OUTCOME_SUCCESS = "success"
OUTCOME_CLIENT_ERROR = "client_error"

#: How much a finding costs the suite. ``unsupported`` means something was not compiled at all;
#: ``degraded`` means it was compiled with a weaker expectation than the contract deserves;
#: ``info`` is context a runner or reviewer should know.
FINDING_UNSUPPORTED = "unsupported"
FINDING_DEGRADED = "degraded"
FINDING_INFO = "info"
FINDING_LEVELS: Tuple[str, ...] = (FINDING_UNSUPPORTED, FINDING_DEGRADED, FINDING_INFO)

#: Stable finding codes. Machine-readable, so a CI gate can allow "no cases for webhooks" while
#: still failing on "we could not compile your only POST".
CODE_UNSUPPORTED_PARADIGM = "UNSUPPORTED_PARADIGM"
CODE_UNSUPPORTED_OPERATION_KIND = "UNSUPPORTED_OPERATION_KIND"
CODE_UNSUPPORTED_STREAMING = "UNSUPPORTED_STREAMING"
CODE_MISSING_HTTP_BINDING = "MISSING_HTTP_BINDING"
CODE_UNDECLARED_PATH_PARAMETER = "UNDECLARED_PATH_PARAMETER"
CODE_UNSUPPORTED_PARAMETER_SHAPE = "UNSUPPORTED_PARAMETER_SHAPE"
CODE_UNSUPPORTED_PARAMETER_LOCATION = "UNSUPPORTED_PARAMETER_LOCATION"
CODE_UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"
CODE_UNRESOLVED_PAYLOAD_TYPE = "UNRESOLVED_PAYLOAD_TYPE"
CODE_UNMAPPED_SCALAR = "UNMAPPED_SCALAR"
CODE_SCHEMA_TRUNCATED = "SCHEMA_TRUNCATED"
CODE_EXAMPLE_SCHEMA_MISMATCH = "EXAMPLE_SCHEMA_MISMATCH"
CODE_EXAMPLE_UNATTRIBUTED = "EXAMPLE_UNATTRIBUTED"
CODE_EXAMPLES_TRUNCATED = "EXAMPLES_TRUNCATED"
CODE_EXAMPLES_NOT_READ = "EXAMPLES_NOT_READ"
CODE_STATUS_UNDECLARED = "STATUS_UNDECLARED"
CODE_ERROR_STATUS_UNDECLARED = "ERROR_STATUS_UNDECLARED"
CODE_RESPONSE_SCHEMA_ABSENT = "RESPONSE_SCHEMA_ABSENT"
CODE_NO_NEGATIVE_CASES = "NO_NEGATIVE_CASES"
CODE_NO_CASES_COMPILED = "NO_CASES_COMPILED"
CODE_CASE_LIMIT_REACHED = "CASE_LIMIT_REACHED"
CODE_OPERATION_LIMIT_REACHED = "OPERATION_LIMIT_REACHED"
CODE_GENERATION_LIMITED = "GENERATION_LIMITED"
CODE_AUTHENTICATION_REQUIRED = "AUTHENTICATION_REQUIRED"
CODE_SERVER_TEMPLATED = "SERVER_TEMPLATED"
CODE_NO_SERVER = "NO_SERVER"
CODE_OPERATION_NOT_SELECTED = "OPERATION_NOT_SELECTED"

#: Every code this module can emit, sorted — the contract a consumer keys off.
SUITE_FINDING_CODES: Tuple[str, ...] = tuple(
    sorted(
        {
            CODE_UNSUPPORTED_PARADIGM,
            CODE_UNSUPPORTED_OPERATION_KIND,
            CODE_UNSUPPORTED_STREAMING,
            CODE_MISSING_HTTP_BINDING,
            CODE_UNDECLARED_PATH_PARAMETER,
            CODE_UNSUPPORTED_PARAMETER_SHAPE,
            CODE_UNSUPPORTED_PARAMETER_LOCATION,
            CODE_UNSUPPORTED_MEDIA_TYPE,
            CODE_UNRESOLVED_PAYLOAD_TYPE,
            CODE_UNMAPPED_SCALAR,
            CODE_SCHEMA_TRUNCATED,
            CODE_EXAMPLE_SCHEMA_MISMATCH,
            CODE_EXAMPLE_UNATTRIBUTED,
            CODE_EXAMPLES_TRUNCATED,
            CODE_EXAMPLES_NOT_READ,
            CODE_STATUS_UNDECLARED,
            CODE_ERROR_STATUS_UNDECLARED,
            CODE_RESPONSE_SCHEMA_ABSENT,
            CODE_NO_NEGATIVE_CASES,
            CODE_NO_CASES_COMPILED,
            CODE_CASE_LIMIT_REACHED,
            CODE_OPERATION_LIMIT_REACHED,
            CODE_GENERATION_LIMITED,
            CODE_AUTHENTICATION_REQUIRED,
            CODE_SERVER_TEMPLATED,
            CODE_NO_SERVER,
            CODE_OPERATION_NOT_SELECTED,
        }
    )
)

#: Hard ceiling on compiled operations, whatever the options ask for. A suite past this size is
#: not run by a human; the cap is a runaway backstop and its truncation is always reported.
MAX_OPERATIONS_CEILING = 2000

#: Ceilings on the per-operation case budgets.
MAX_EXAMPLE_CASES_CEILING = 50
MAX_GENERATED_CASES_CEILING = 50
MAX_NEGATIVE_CASES_CEILING = 50

#: Media type used when a body is declared with no ``content`` at all.
DEFAULT_MEDIA_TYPE = "application/json"

#: Value handed to a parameter to break its declared type. Deliberately not a number, not a
#: boolean, and not empty, so it violates ``integer``/``number``/``boolean`` and nothing else.
WRONG_TYPE_PARAMETER_VALUE = "not-a-valid-value"

#: Route-template placeholder, e.g. the ``petId`` of ``/pets/{petId}``.
_PLACEHOLDER = re.compile(r"\{([^{}/]+)\}")

#: Parameter locations a compiled request can carry. Cookies are reported, never sent: a
#: contract suite that set cookies would be exercising session state, not the contract.
_SENDABLE_LOCATIONS = (
    ParameterLocation.PATH,
    ParameterLocation.QUERY,
    ParameterLocation.HEADER,
)

#: Where a parameter or body value came from, mirroring the synthesis vocabulary.
ORIGIN_DECLARED_EXAMPLE = "declared_example"
ORIGIN_DEFAULT = "default"
ORIGIN_ENUM = "enum"
ORIGIN_GENERATED = "generated"


# ===========================================================================
# Options
# ===========================================================================


class ContractSuiteOptions(BaseModel):
    """What to compile, and how much of it.

    Every field is part of the suite's identity: the options are echoed in the manifest and
    hashed into its digest, so "the same version compiled the same way" is a checkable claim
    rather than a hope. Defaults compile the whole suite.
    """

    model_config = ConfigDict(extra="forbid")

    seed: int = Field(
        default=0,
        ge=0,
        le=MAX_SEED,
        description=(
            "Seed for generated values. The same version and seed always produce the same "
            "payloads; change it to sample different values of the same shapes."
        ),
    )
    include_declared_examples: bool = Field(
        default=True,
        description="Compile the examples declared in the source document into request cases.",
    )
    include_generated: bool = Field(
        default=True,
        description="Compile schema-valid generated bodies (minimal, full, and branches).",
    )
    include_branches: bool = Field(
        default=True,
        description=(
            "Include one generated body per polymorphic (`oneOf`/`anyOf`/`if`) alternative of "
            "a request body. Ignored when generated cases are off."
        ),
    )
    include_negative: bool = Field(
        default=True,
        description=(
            "Compile the negative cases: a missing required body, a missing required query "
            "parameter, a wrong-typed parameter, and single-constraint body violations."
        ),
    )
    verify_examples: bool = Field(
        default=True,
        description=(
            "Check every declared example against the schema governing it, and compile only "
            "the conforming ones. A non-conforming example is reported, never compiled: it "
            "would fail a correct implementation."
        ),
    )
    include_response_schemas: bool = Field(
        default=True,
        description=(
            "Carry the response schema each success case must satisfy in the manifest, so a "
            "runner validates responses without resolving the version again."
        ),
    )
    max_example_cases_per_operation: int = Field(
        default=10,
        ge=1,
        le=MAX_EXAMPLE_CASES_CEILING,
        description="Cap on declared-example cases per operation.",
    )
    max_generated_cases_per_operation: int = Field(
        default=4,
        ge=1,
        le=MAX_GENERATED_CASES_CEILING,
        description=(
            "Cap on generated valid bodies per operation. The minimal and full bodies come "
            "first; the remainder of the budget goes to polymorphic branches."
        ),
    )
    max_negative_cases_per_operation: int = Field(
        default=6,
        ge=1,
        le=MAX_NEGATIVE_CASES_CEILING,
        description=(
            "Cap on negative cases per operation. Structural negatives (missing body, missing "
            "parameter, wrong-typed parameter) are compiled first; the remainder of the budget "
            "goes to single-constraint body violations."
        ),
    )
    max_operations: int = Field(
        default=500,
        ge=1,
        le=MAX_OPERATIONS_CEILING,
        description="Cap on compiled operations. Truncation is always reported as a finding.",
    )
    operations: Optional[List[str]] = Field(
        default=None,
        description=(
            "Restrict compilation to these operation keys (`GET /pets/{petId}`). Omit for "
            "every operation. A key that matches nothing is reported as a finding."
        ),
    )

    def normalized(self) -> "ContractSuiteOptions":
        """Return an equal-meaning copy whose fields are in canonical form.

        The ``operations`` filter is a *set* semantically, so it is sorted and de-duplicated
        before it reaches the manifest — otherwise two callers asking for the same two
        operations in different orders would get two different digests for the same suite.

        Returns:
            The normalized options.
        """
        if self.operations is None:
            return self.model_copy(deep=True)
        return self.model_copy(update={"operations": sorted(set(self.operations))}, deep=True)


# ===========================================================================
# Manifest shape
# ===========================================================================


class SuiteApiInfo(BaseModel):
    """Identity of the API the suite was compiled from, as the canonical model states it."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Source name of the API.")
    namespace: Optional[str] = Field(default=None, description="Package/group/target namespace.")
    title: Optional[str] = Field(default=None, description="Human title, when declared.")
    version: Optional[str] = Field(
        default=None, description="Source-declared API version (`1.4.0`), when declared."
    )
    format: str = Field(description="Source format key (`openapi-3.1`, `swagger-2` …).")
    paradigm: str = Field(description="Canonical paradigm (`rest`, `graph`, `event` …).")
    protocol: Optional[str] = Field(default=None, description="Primary transport protocol.")
    servers: List[str] = Field(
        default_factory=list,
        description=(
            "Server URLs the document declares, in declaration order. A suite carries no "
            "target of its own — the runner selects one — so these are context, not a choice."
        ),
    )


class SuiteSourceInfo(BaseModel):
    """Where the compiled version came from, as the caller resolved it.

    The compiler never looks anything up; whatever a caller knows about the artifact is passed
    in and echoed here so a manifest identifies its own provenance.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Optional[str] = Field(
        default=None, description="`project` or `catalog` — which surface the artifact lives on."
    )
    reference: Optional[str] = Field(
        default=None, description="The reference the caller resolved (`project/petstore/1.0.0`)."
    )
    artifact_id: Optional[str] = Field(default=None, description="Artifact (project/item) id.")
    artifact_slug: Optional[str] = Field(default=None, description="Artifact slug.")
    revision_id: Optional[str] = Field(default=None, description="Resolved revision id.")
    version_label: Optional[str] = Field(
        default=None, description="Version label of the resolved revision (`1.0.0`)."
    )
    source_format: Optional[str] = Field(
        default=None, description="Import-source format key the revision derives from."
    )
    published: Optional[bool] = Field(
        default=None,
        description=(
            "Whether the resolved revision is published. `null` when the caller did not "
            "establish it — never assumed. A suite compiled from an unpublished revision is "
            "valid, but it is not a contract anyone has agreed to."
        ),
    )


class SuiteOperation(BaseModel):
    """One operation the suite covers, and how much of it was compiled."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Stable canonical operation key (`GET /pets/{petId}`).")
    name: str = Field(description="Source operation name.")
    service_key: Optional[str] = Field(
        default=None, description="Key of the service/tag grouping the operation."
    )
    http_method: str = Field(description="HTTP verb, upper-cased.")
    http_path: str = Field(description="Route template, exactly as declared.")
    deprecated: bool = Field(default=False, description="Whether the operation is deprecated.")
    tags: List[str] = Field(default_factory=list, description="Declared tags, in source order.")
    case_count: int = Field(description="How many cases were compiled for this operation.")
    request_media_type: Optional[str] = Field(
        default=None, description="Media type compiled request bodies are sent as."
    )


class ContractRequestParameter(BaseModel):
    """One parameter value a case sends, with the evidence behind it."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Source parameter name.")
    location: str = Field(description="`path`, `query`, or `header`.")
    value: str = Field(description="Wire value, already serialized as a string.")
    origin: str = Field(
        description=(
            "Where the value came from: `declared_example`, `default`, `enum`, or `generated`."
        )
    )
    required: bool = Field(default=False, description="Whether the contract requires it.")


class ContractCaseRequest(BaseModel):
    """The request a case sends, complete enough to execute against a chosen target."""

    model_config = ConfigDict(extra="forbid")

    method: str = Field(description="HTTP verb, upper-cased.")
    path_template: str = Field(description="Route template (`/pets/{petId}`).")
    path: str = Field(
        description=(
            "The template with every path parameter substituted and percent-encoded — append "
            "it to the target's base URL to get the request URL."
        )
    )
    parameters: List[ContractRequestParameter] = Field(
        default_factory=list,
        description="Parameter values, sorted by location then name.",
    )
    has_body: bool = Field(
        default=False,
        description=(
            "Whether the case sends a body at all. Distinguishes 'no body' from 'a body whose "
            "value is null', which are different requests."
        ),
    )
    body: Optional[Any] = Field(default=None, description="The request body, when there is one.")
    media_type: Optional[str] = Field(
        default=None, description="Media type the body is sent as."
    )


class ContractCaseExpectation(BaseModel):
    """What a conforming implementation must do with the case's request."""

    model_config = ConfigDict(extra="forbid")

    outcome: str = Field(description="`success` or `client_error`.")
    status_codes: List[str] = Field(
        description=(
            "Acceptable status codes, from the contract's own declarations. A wildcard "
            "(`2XX`, `4XX`) means the range is acceptable."
        )
    )
    status_declared: bool = Field(
        description=(
            "Whether `status_codes` came from the document. `false` means the compiler fell "
            "back to a range because the contract declared none — a weaker assertion, and one "
            "the suite states rather than hides."
        )
    )
    response_schema_id: Optional[str] = Field(
        default=None,
        description=(
            "Key into the manifest's `schemas` map for the schema the response body must "
            "satisfy. Null when the contract declares no response schema."
        ),
    )
    reason: str = Field(description="One sentence explaining why this outcome is expected.")


class ContractCase(BaseModel):
    """One executable case: a request, its provenance, and its expected outcome."""

    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(
        description=(
            "Stable identifier, derived from the operation, the source, and what distinguishes "
            "this case from its siblings. The same version and options always yield the same id."
        )
    )
    operation_key: str = Field(description="Stable canonical operation key.")
    operation_name: str = Field(description="Source operation name.")
    source: str = Field(description="One of the case sources — where this case came from.")
    source_detail: Optional[str] = Field(
        default=None,
        description=(
            "What distinguishes this case within its source — an example name, a mutation "
            "kind, or the parameter a negative case targets."
        ),
    )
    source_pointer: Optional[str] = Field(
        default=None,
        description=(
            "JSON Pointer to the case's origin: into the source document for a declared "
            "example, into the body for a generated violation."
        ),
    )
    title: str = Field(description="Short human-readable name, unique within the operation.")
    description: str = Field(description="What the case exercises.")
    synthetic: bool = Field(
        description=(
            "False only when the request body is an example the author wrote. True for every "
            "generated payload, so the label travels with the case."
        )
    )
    request: ContractCaseRequest = Field(description="The request to send.")
    expect: ContractCaseExpectation = Field(description="What must come back.")
    tags: List[str] = Field(
        default_factory=list, description="The operation's tags, for filtered runs."
    )


class SuiteFinding(BaseModel):
    """Something the compiler could not express, or expressed more weakly than the contract."""

    model_config = ConfigDict(extra="forbid")

    code: str = Field(description="Stable code from `SUITE_FINDING_CODES`.")
    level: str = Field(description="`unsupported`, `degraded`, or `info`.")
    message: str = Field(description="What was not compiled, and why.")
    operation_key: Optional[str] = Field(
        default=None, description="The operation concerned, when the finding has one."
    )
    pointer: Optional[str] = Field(
        default=None, description="JSON Pointer into the source document, when known."
    )


class ContractSuiteManifest(BaseModel):
    """The compiled suite: everything a runner needs, and everything a reviewer should know."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(
        default=CONTRACT_SUITE_SCHEMA_VERSION, description="Manifest envelope version."
    )
    compiler_version: int = Field(
        default=CONTRACT_SUITE_COMPILER_VERSION, description="Version of the compilation rules."
    )
    digest: str = Field(
        default="",
        description=(
            "`sha256:<hex>` over the canonical bytes of this manifest with `digest` itself "
            "removed. Two suites with the same digest are the same suite."
        ),
    )
    digest_algorithm: str = Field(
        default=SUITE_DIGEST_ALGORITHM, description="Hash used for `digest`."
    )
    options: ContractSuiteOptions = Field(
        description="The options this suite was compiled with, normalized."
    )
    api: SuiteApiInfo = Field(description="Identity of the compiled API.")
    source: Optional[SuiteSourceInfo] = Field(
        default=None, description="Where the compiled version came from."
    )
    operations: List[SuiteOperation] = Field(
        default_factory=list, description="Covered operations, sorted by key."
    )
    cases: List[ContractCase] = Field(
        default_factory=list,
        description="Every case, grouped by operation (sorted by key) then by source order.",
    )
    schemas: Dict[str, Dict[str, Any]] = Field(
        default_factory=dict,
        description=(
            "Response schemas referenced by `expect.response_schema_id`, keyed so identical "
            "types are carried once."
        ),
    )
    findings: List[SuiteFinding] = Field(
        default_factory=list,
        description=(
            "What was not compiled, and what was compiled weakly — sorted by code, operation, "
            "then message. Never empty merely because the suite is large."
        ),
    )
    counts: Dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Case counts by source, plus `cases`, `operations_compiled`, "
            "`operations_skipped`, and `findings`."
        ),
    )


# ===========================================================================
# Compilation
# ===========================================================================


@dataclass
class _BodyPlan:
    """How one operation's request body is compiled, resolved once and reused by every case.

    Attributes:
        schema: The JSON Schema a body must satisfy, or ``None`` when the operation takes none.
        dialect: Dialect the schema is read and verified under.
        base_uri: Resolution base for the schema's ``$ref``s.
        retrieve: Resolver serving the source document, for an inline schema that refs into it.
        media_type: Media type the body is sent as.
        required: Whether the contract requires the body.
        declared: Whether the operation declares a request body at all. Distinct from
            ``schema is None``: a body offered only as XML is *declared* but not compilable,
            and a case that omitted it would fail for a reason the suite invented.
    """

    schema: Optional[Dict[str, Any]] = None
    dialect: str = DRAFT_2020_12
    base_uri: str = ""
    retrieve: Optional[Any] = None
    media_type: Optional[str] = None
    required: bool = False
    declared: bool = False


@dataclass
class _Compilation:
    """Mutable state shared by one compile run.

    Attributes:
        api: The canonical model being compiled.
        options: The normalized options.
        examples: Declared examples, indexed by ``(path, method)`` with ``None`` for
            path-level parameter examples.
        harvest: The raw harvest, for the document-level findings it carries.
        document_dialect: Dialect inline source schemas are read under.
        cases: Compiled cases, in emission order.
        operations: Per-operation summaries.
        findings: Everything not compiled, or compiled weakly.
        schemas: Response schemas, keyed by schema id.
        skipped: Keys of operations that produced no cases, so the count of what was left out
            is a fact rather than a tally of findings.
    """

    api: CanonicalApi
    options: ContractSuiteOptions
    examples: Dict[Tuple[str, Optional[str]], List[DeclaredExample]]
    harvest: DeclaredExampleHarvest
    document_dialect: str = DRAFT_2020_12
    cases: List[ContractCase] = field(default_factory=list)
    operations: List[SuiteOperation] = field(default_factory=list)
    findings: List[SuiteFinding] = field(default_factory=list)
    schemas: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    skipped: List[str] = field(default_factory=list)

    def report(
        self,
        code: str,
        level: str,
        message: str,
        *,
        operation_key: Optional[str] = None,
        pointer: Optional[str] = None,
    ) -> None:
        """Record a finding. Every "we did not compile that" path in this module goes here."""
        self.findings.append(
            SuiteFinding(
                code=code,
                level=level,
                message=message,
                operation_key=operation_key,
                pointer=pointer,
            )
        )


def compile_contract_suite(
    api: CanonicalApi,
    *,
    options: Optional[ContractSuiteOptions] = None,
    source: Optional[SuiteSourceInfo] = None,
) -> ContractSuiteManifest:
    """Compile a canonical model into a deterministic contract-suite manifest.

    Args:
        api: The published version's canonical model.
        options: What to compile. ``None`` uses the defaults, which compile everything.
        source: Provenance of the version, echoed into the manifest. The compiler does not
            resolve anything itself; a caller that knows the coordinates supplies them.

    Returns:
        The :class:`ContractSuiteManifest`, with its digest computed over its own canonical
        bytes. Compilation never raises for a model it cannot fully express: what cannot be
        compiled becomes a finding.
    """
    resolved_options = (options or ContractSuiteOptions()).normalized()
    harvest = _harvest(api, resolved_options)
    compilation = _Compilation(
        api=api,
        options=resolved_options,
        examples=_index_examples(harvest),
        harvest=harvest,
        document_dialect=_document_dialect(api),
    )

    _report_document_findings(compilation)

    selected, skipped = _select_operations(compilation)
    for service, operation in selected:
        _compile_operation(compilation, service, operation)

    manifest = ContractSuiteManifest(
        options=resolved_options,
        api=_api_info(api),
        source=source,
        operations=compilation.operations,
        cases=compilation.cases,
        schemas={key: compilation.schemas[key] for key in sorted(compilation.schemas)},
        findings=_sorted_findings(compilation.findings),
        counts=_counts(compilation, skipped=skipped),
    )
    return manifest.model_copy(update={"digest": manifest_digest(manifest)})


def canonical_manifest_bytes(manifest: ContractSuiteManifest) -> bytes:
    """Serialize a manifest to the exact bytes its digest is taken over.

    Keys are sorted at every level and separators are tight, so the encoding depends on the
    manifest's *content* and never on field declaration order or a JSON library's whitespace
    defaults. This is the artifact to write to disk, commit, and compare.

    Args:
        manifest: The manifest to serialize. Its own ``digest`` is included when set — call
            this after :func:`compile_contract_suite` to get the bytes of the finished suite.

    Returns:
        UTF-8 encoded canonical JSON, with a trailing newline so the file is a well-formed
        text file and a diff of two suites lines up.
    """
    payload = manifest.model_dump(mode="json")
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return (text + "\n").encode("utf-8")


def manifest_digest(manifest: ContractSuiteManifest) -> str:
    """Compute a manifest's ``sha256:<hex>`` digest.

    The digest is taken over the canonical bytes of the manifest **with ``digest`` blanked**, so
    it can be recomputed from a stored manifest and compared without stripping fields by hand.

    Args:
        manifest: The manifest to digest.

    Returns:
        The digest, prefixed with its algorithm.
    """
    blanked = manifest.model_copy(update={"digest": ""})
    hashed = hashlib.sha256(canonical_manifest_bytes(blanked)).hexdigest()
    return f"{SUITE_DIGEST_ALGORITHM}:{hashed}"


# ===========================================================================
# Document-level preparation
# ===========================================================================


def _harvest(api: CanonicalApi, options: ContractSuiteOptions) -> DeclaredExampleHarvest:
    """Read the source document's declared examples, or nothing when they are not wanted."""
    if not options.include_declared_examples or not isinstance(api.raw, dict):
        return DeclaredExampleHarvest()
    return harvest_declared_examples(
        api.raw, format_key=api.format, verify=options.verify_examples
    )


def _index_examples(
    harvest: DeclaredExampleHarvest,
) -> Dict[Tuple[str, Optional[str]], List[DeclaredExample]]:
    """Group harvested examples by ``(path, method)``; path-level ones keep ``None`` as method."""
    grouped: Dict[Tuple[str, Optional[str]], List[DeclaredExample]] = {}
    for example in harvest.examples:
        grouped.setdefault((example.http_path, example.http_method), []).append(example)
    return grouped


def _document_dialect(api: CanonicalApi) -> str:
    """Return the JSON Schema dialect the source document's inline schemas are written in.

    An OpenAPI 3.0 or Swagger 2 schema spells ``exclusiveMinimum`` as a boolean, which draft
    2020-12 reads as a number and rejects — so reading an inline schema under the wrong dialect
    does not merely lose a constraint, it makes the whole schema unusable. The family table in
    :mod:`app.example_conformance` already states the dialect per format; this reuses it.
    """
    family = resolve_example_family(api.raw, api.format)
    return family.dialect if family is not None else DRAFT_2020_12


def _report_document_findings(compilation: _Compilation) -> None:
    """Report everything about the document as a whole, before any operation is compiled."""
    api = compilation.api
    harvest = compilation.harvest

    if api.paradigm is not ApiParadigm.REST:
        compilation.report(
            CODE_UNSUPPORTED_PARADIGM,
            FINDING_INFO,
            f"This version is a {api.paradigm.value} API. A contract suite compiles HTTP "
            "request/response operations; operations of other paradigms are reported per "
            "operation and not compiled.",
        )

    if compilation.options.include_declared_examples:
        if harvest.family is None and isinstance(api.raw, dict):
            compilation.report(
                CODE_EXAMPLES_NOT_READ,
                FINDING_DEGRADED,
                f"Declared examples were not read: format {api.format!r} is not one this "
                "compiler knows the example locations for. Cases come from generated values "
                "only.",
            )
        if harvest.unattributed:
            compilation.report(
                CODE_EXAMPLE_UNATTRIBUTED,
                FINDING_INFO,
                f"{harvest.unattributed} declared example(s) belong to no operation — a "
                "component schema, a webhook, or a response header. They are not compiled "
                "into request cases.",
            )
        if harvest.truncated:
            compilation.report(
                CODE_EXAMPLES_TRUNCATED,
                FINDING_DEGRADED,
                "The document declares more examples than the walker collects; the remainder "
                "were not read and are not compiled.",
            )

    for server in api.servers:
        if _PLACEHOLDER.search(server.url):
            compilation.report(
                CODE_SERVER_TEMPLATED,
                FINDING_INFO,
                f"Server URL {server.url!r} is a template. The suite carries no target; the "
                "runner must supply a resolved base URL.",
            )
    if not api.servers:
        compilation.report(
            CODE_NO_SERVER,
            FINDING_INFO,
            "The document declares no server. Every case's path is relative; the runner must "
            "supply a base URL.",
        )

    if _declares_authentication(api.raw):
        compilation.report(
            CODE_AUTHENTICATION_REQUIRED,
            FINDING_INFO,
            "This API declares security requirements. A contract suite never carries "
            "credentials — the runner must supply them, or every case will fail on "
            "authentication rather than on the contract.",
        )


def _declares_authentication(raw: Optional[Dict[str, Any]]) -> bool:
    """Return whether the source document declares any security scheme or requirement."""
    if not isinstance(raw, dict):
        return False
    if raw.get("security"):
        return True
    components = raw.get("components")
    if isinstance(components, dict) and components.get("securitySchemes"):
        return True
    return bool(raw.get("securityDefinitions"))  # Swagger 2


def _api_info(api: CanonicalApi) -> SuiteApiInfo:
    """Project the model's identity into the manifest's API block."""
    return SuiteApiInfo(
        name=api.identity.name,
        namespace=api.identity.namespace,
        title=api.title,
        version=api.version,
        format=api.format,
        paradigm=api.paradigm.value,
        protocol=api.protocol,
        servers=[server.url for server in api.servers],
    )


def _select_operations(
    compilation: _Compilation,
) -> Tuple[List[Tuple[Service, Operation]], int]:
    """Choose which operations to compile, reporting every one that is left out.

    Operations are ordered by canonical key so the manifest's case order is a property of the
    contract rather than of the normalizer's traversal.

    Args:
        compilation: The run state.

    Returns:
        ``(selected, skipped)`` — the operations to compile, and how many were left out for any
        reason (filtered, over the cap, or unsupported at selection time).
    """
    wanted = set(compilation.options.operations or ())
    pairs: List[Tuple[Service, Operation]] = [
        (service, operation)
        for service in compilation.api.services
        for operation in service.operations
    ]
    pairs.sort(key=lambda pair: (pair[1].key, pair[0].key))

    if wanted:
        missing = sorted(wanted - {operation.key for _, operation in pairs})
        for key in missing:
            compilation.report(
                CODE_OPERATION_NOT_SELECTED,
                FINDING_DEGRADED,
                f"Operation {key!r} was requested but this version does not declare it.",
                operation_key=key,
            )
        pairs = [pair for pair in pairs if pair[1].key in wanted]

    limit = compilation.options.max_operations
    if len(pairs) > limit:
        compilation.report(
            CODE_OPERATION_LIMIT_REACHED,
            FINDING_DEGRADED,
            f"This version declares {len(pairs)} operations; only the first {limit} (by key) "
            "were compiled. Raise `max_operations` or narrow `operations` to cover the rest.",
        )
        dropped = len(pairs) - limit
        return pairs[:limit], dropped
    return pairs, 0


# ===========================================================================
# Per-operation compilation
# ===========================================================================


def _compile_operation(
    compilation: _Compilation, service: Service, operation: Operation
) -> None:
    """Compile one operation's cases, or report why none could be compiled.

    Args:
        compilation: The run state, mutated in place.
        service: The service the operation belongs to.
        operation: The operation to compile.
    """
    if not _is_compilable(compilation, operation):
        compilation.skipped.append(operation.key)
        return

    method = (operation.http_method or "").upper()
    template = operation.http_path or ""

    parameters, blocked = _parameter_values(compilation, operation, method, template)
    if blocked:
        compilation.skipped.append(operation.key)
        return

    body = _body_plan(compilation, operation)
    success = _success_expectation(compilation, operation)
    client_error = _error_expectation(compilation, operation)

    before = len(compilation.cases)
    _emit_example_cases(compilation, operation, method, template, parameters, body, success)
    _emit_generated_cases(compilation, operation, method, template, parameters, body, success)
    positives = len(compilation.cases) - before

    if positives == 0 and not body.declared and compilation.options.include_generated:
        # An operation with no request body still deserves its "call it and check the
        # response" case — for a GET, that *is* the whole contract, and the negative cases
        # below prove nothing on their own if nobody ever calls the operation correctly.
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=parameters,
                source=CASE_SOURCE_GENERATED_MINIMAL,
                source_detail=None,
                source_pointer=None,
                title="request with declared parameter values",
                description=(
                    "Calls the operation with values derived from its declared parameters. "
                    "The operation takes no request body."
                ),
                synthetic=True,
                body=None,
                has_body=False,
                media_type=None,
                expectation=success,
            )
        )

    _emit_negative_cases(
        compilation, operation, method, template, parameters, body, client_error
    )
    emitted = len(compilation.cases) - before

    if emitted == 0:
        compilation.report(
            CODE_NO_CASES_COMPILED,
            FINDING_UNSUPPORTED,
            f"No case could be compiled for {operation.key!r} under these options, so the "
            "suite does not cover it.",
            operation_key=operation.key,
        )
        compilation.skipped.append(operation.key)
        return

    compilation.operations.append(
        SuiteOperation(
            key=operation.key,
            name=operation.name,
            service_key=service.key or None,
            http_method=method,
            http_path=template,
            deprecated=operation.deprecated,
            tags=list(operation.tags),
            case_count=emitted,
            request_media_type=body.media_type,
        )
    )


def _is_compilable(compilation: _Compilation, operation: Operation) -> bool:
    """Return whether an operation is an HTTP exchange this compiler can express.

    Everything rejected here is reported first: a suite that quietly omitted an operation would
    read as coverage of it.
    """
    if operation.streaming is not StreamingMode.NONE:
        compilation.report(
            CODE_UNSUPPORTED_STREAMING,
            FINDING_UNSUPPORTED,
            f"Operation {operation.key!r} is {operation.streaming.value}-streaming. A "
            "request/response case cannot express a stream, so it was not compiled.",
            operation_key=operation.key,
        )
        return False

    if not operation.http_method or not operation.http_path:
        compilation.report(
            CODE_MISSING_HTTP_BINDING,
            FINDING_UNSUPPORTED,
            f"Operation {operation.key!r} declares no HTTP method and route, so there is no "
            "request to send. Operations of non-HTTP paradigms are not compiled.",
            operation_key=operation.key,
        )
        return False

    if operation.kind.value not in {"request_response"}:
        compilation.report(
            CODE_UNSUPPORTED_OPERATION_KIND,
            FINDING_UNSUPPORTED,
            f"Operation {operation.key!r} is a {operation.kind.value} operation. Only "
            "request/response operations compile into contract cases.",
            operation_key=operation.key,
        )
        return False

    return True


def _parameter_values(
    compilation: _Compilation, operation: Operation, method: str, template: str
) -> Tuple[List[ContractRequestParameter], bool]:
    """Derive one concrete value per sendable parameter.

    Values are taken from the author's own evidence first — a declared example, then a declared
    default, then the first enum member — and only invented when the contract offers none.

    Args:
        compilation: The run state.
        operation: The operation whose parameters to resolve.
        method: Upper-cased HTTP verb.
        template: The route template.

    Returns:
        ``(parameters, blocked)``. ``blocked`` is ``True`` when the operation cannot be compiled
        at all — a path parameter with no expressible value, or a route placeholder the contract
        never declares — in which case a finding has already been recorded.
    """
    declared = _parameter_examples(compilation, operation, method, template)
    values: List[ContractRequestParameter] = []
    cookies: List[str] = []

    for parameter in operation.parameters:
        if parameter.location not in _SENDABLE_LOCATIONS:
            cookies.append(parameter.name)
            continue
        value, origin = _parameter_value(compilation, operation, parameter, declared)
        if value is None:
            required = parameter.required
            compilation.report(
                CODE_UNSUPPORTED_PARAMETER_SHAPE,
                FINDING_UNSUPPORTED if required else FINDING_DEGRADED,
                f"Parameter {parameter.name!r} of {operation.key!r} is declared as a "
                "structured value (an array or object), which this compiler does not know how "
                "to serialize into a URL without the source's style/explode rules."
                + (
                    " It is required, so no case for this operation could be built."
                    if required
                    else " It is optional, so cases omit it."
                ),
                operation_key=operation.key,
            )
            if required:
                # A "positive" case missing a required input is a failure the suite invented,
                # not one the implementation earned. Compiling nothing is the honest answer.
                return [], True
            continue
        values.append(
            ContractRequestParameter(
                name=parameter.name,
                location=parameter.location.value,
                value=value,
                origin=origin,
                required=parameter.required,
            )
        )

    if cookies:
        compilation.report(
            CODE_UNSUPPORTED_PARAMETER_LOCATION,
            FINDING_DEGRADED,
            f"Cookie parameter(s) {', '.join(sorted(cookies))} of {operation.key!r} are not "
            "sent: a contract suite exercises the contract, not session state.",
            operation_key=operation.key,
        )

    supplied = {value.name for value in values if value.location == ParameterLocation.PATH.value}
    undeclared = sorted(set(_PLACEHOLDER.findall(template)) - supplied)
    if undeclared:
        compilation.report(
            CODE_UNDECLARED_PATH_PARAMETER,
            FINDING_UNSUPPORTED,
            f"Route {template!r} contains placeholder(s) {', '.join(undeclared)} that "
            f"{operation.key!r} never declares as parameters, so no request URL can be built.",
            operation_key=operation.key,
        )
        return [], True

    values.sort(key=lambda item: (item.location, item.name))
    return values, False


def _parameter_examples(
    compilation: _Compilation, operation: Operation, method: str, template: str
) -> Dict[Tuple[str, str], DeclaredExample]:
    """Index the declared parameter examples that apply to one operation.

    Operation-level examples win over path-level ones, which apply to every method on the path.

    Args:
        compilation: The run state.
        operation: The operation being compiled.
        method: Upper-cased HTTP verb.
        template: The route template.

    Returns:
        ``(location, name)`` → the example to use.
    """
    indexed: Dict[Tuple[str, str], DeclaredExample] = {}
    for scope in (None, method):
        for example in compilation.examples.get((template, scope), ()):
            if example.site != SITE_PARAMETER or not example.parameter_name:
                continue
            if example.pointer in compilation.harvest.nonconforming:
                compilation.report(
                    CODE_EXAMPLE_SCHEMA_MISMATCH,
                    FINDING_DEGRADED,
                    f"Declared example for parameter {example.parameter_name!r} of "
                    f"{operation.key!r} does not satisfy its own schema and was not used.",
                    operation_key=operation.key,
                    pointer=example.pointer,
                )
                continue
            indexed[(example.parameter_location or "", example.parameter_name)] = example
    return indexed


def _parameter_value(
    compilation: _Compilation,
    operation: Operation,
    parameter: Parameter,
    declared: Dict[Tuple[str, str], DeclaredExample],
) -> Tuple[Optional[str], str]:
    """Resolve one parameter to a wire value and the origin of that value.

    Args:
        compilation: The run state.
        operation: The owning operation (for seeding and findings).
        parameter: The parameter to resolve.
        declared: Declared parameter examples for this operation.

    Returns:
        ``(value, origin)``, or ``(None, origin)`` when the parameter's declared shape cannot be
        carried in a URL — the caller decides whether that blocks the operation.
    """
    example = declared.get((parameter.location.value, parameter.name))
    if example is not None:
        wire = _wire_value(example.value)
        if wire is not None:
            return wire, ORIGIN_DECLARED_EXAMPLE

    if parameter.default is not None:
        wire = _wire_value(parameter.default)
        if wire is not None:
            return wire, ORIGIN_DEFAULT

    if parameter.constraints is not None and parameter.constraints.enum:
        wire = _wire_value(parameter.constraints.enum[0])
        if wire is not None:
            return wire, ORIGIN_ENUM

    projection = build_ref_json_schema(
        compilation.api, parameter.type, constraints=parameter.constraints
    )
    _report_projection(compilation, projection, operation.key, f"parameter {parameter.name!r}")
    result = synthesize_instances(
        projection.document,
        seed=_seed_for(compilation.options.seed, f"{operation.key}#{parameter.key}"),
        include_full=False,
        include_branches=False,
        include_mutants=False,
        verify=False,
    )
    if not result.instances:
        return None, ORIGIN_GENERATED
    return _wire_value(result.instances[0].instance), ORIGIN_GENERATED


def _wire_value(value: Any) -> Optional[str]:
    """Serialize a scalar into the string a URL or header carries.

    Args:
        value: The value to serialize.

    Returns:
        The wire form, or ``None`` for a value with no unambiguous single-string encoding —
        an array, an object, or a null. Those need the source's style/explode rules, which the
        canonical model does not carry.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return None


def _resolve_path(template: str, parameters: Sequence[ContractRequestParameter]) -> str:
    """Substitute path parameters into a route template, percent-encoding each value.

    Args:
        template: The route template (``/pets/{petId}``).
        parameters: The case's parameter values.

    Returns:
        The concrete path. A placeholder with no value is left in place — the caller has
        already reported that as :data:`CODE_UNDECLARED_PATH_PARAMETER`.
    """
    resolved = template
    for parameter in parameters:
        if parameter.location != ParameterLocation.PATH.value:
            continue
        resolved = resolved.replace(
            "{" + parameter.name + "}", quote(parameter.value, safe="")
        )
    return resolved


# ===========================================================================
# Bodies and expectations
# ===========================================================================


def _body_plan(compilation: _Compilation, operation: Operation) -> _BodyPlan:
    """Resolve the schema, media type, and requiredness of an operation's request body."""
    message = _message(operation, MessageRole.REQUEST)
    if message is None:
        return _BodyPlan()

    media_type = _json_media_type(message.content_types)
    if media_type is None:
        compilation.report(
            CODE_UNSUPPORTED_MEDIA_TYPE,
            FINDING_UNSUPPORTED,
            f"The request body of {operation.key!r} is offered only as "
            f"{', '.join(message.content_types)}. This compiler builds JSON bodies, so no body "
            "cases were compiled for it.",
            operation_key=operation.key,
        )
        return _BodyPlan(required=message.required, declared=True)

    schema = _message_schema(compilation, operation, message)
    if schema is None:
        return _BodyPlan(media_type=media_type, required=message.required, declared=True)

    inline = message.payload_schema is not None
    return _BodyPlan(
        schema=schema,
        dialect=compilation.document_dialect if inline else DRAFT_2020_12,
        base_uri=SPEC_BASE_URI if inline else "",
        retrieve=_document_retriever(compilation.api) if inline else None,
        media_type=media_type,
        required=message.required,
        declared=True,
    )


def _message_schema(
    compilation: _Compilation, operation: Operation, message: Message
) -> Optional[Dict[str, Any]]:
    """Return the JSON Schema for a message's payload, or ``None`` when it declares none."""
    if message.payload_schema is not None:
        return dict(message.payload_schema)
    if message.payload is None:
        return None

    projection = _project_payload(compilation, message.payload)
    _report_projection(compilation, projection, operation.key, f"message {message.key!r}")
    if not _names_a_type(compilation.api, message.payload) and not projection.document.get(
        "type"
    ):
        compilation.report(
            CODE_UNRESOLVED_PAYLOAD_TYPE,
            FINDING_DEGRADED,
            f"The payload of {message.key!r} references a type this version does not define, "
            "so nothing constrains it. Cases are compiled, but the payload is unchecked.",
            operation_key=operation.key,
        )
    return projection.document


def _project_payload(compilation: _Compilation, payload: TypeRef) -> CanonicalSchemaProjection:
    """Project a payload reference into a standalone schema, list wrappers included."""
    if payload.item is None and payload.name and _names_a_type(compilation.api, payload):
        return build_type_json_schema(
            compilation.api, payload.name, max_defs=MAX_PROJECTED_DEFS
        )
    return build_ref_json_schema(compilation.api, payload)


def _names_a_type(api: CanonicalApi, ref: TypeRef) -> bool:
    """Return whether a reference resolves to a type the model defines, by key or unique name."""
    leaf = ref
    while leaf.item is not None:
        leaf = leaf.item
    name = leaf.name or ""
    if not name:
        return False
    if any(type_.key == name for type_ in api.types):
        return True
    return sum(1 for type_ in api.types if type_.name == name) == 1


def _document_retriever(api: CanonicalApi):
    """Build a resolver serving the source document, and nothing else.

    An inline body schema copied out of an OpenAPI document keeps its
    ``$ref: "#/components/schemas/Pet"``. Registering the whole document under
    :data:`app.example_conformance.SPEC_BASE_URI` makes that reference resolve exactly as its
    author intended, while every other URI stays unresolvable — there is no code path here that
    opens a socket.
    """
    document = dict(api.raw) if isinstance(api.raw, dict) else {}

    def retrieve(uri: str) -> Optional[Dict[str, Any]]:
        """Serve the source document for its own base URI, and nothing for anything else."""
        return dict(document) if uri == SPEC_BASE_URI else None

    return retrieve


def _json_media_type(content_types: Sequence[str]) -> Optional[str]:
    """Choose the JSON media type a body should be sent as.

    Args:
        content_types: The media types the message declares, in any order.

    Returns:
        ``application/json`` when offered, else the alphabetically-first JSON-ish media type
        (``application/merge-patch+json``, …), else :data:`DEFAULT_MEDIA_TYPE` when the message
        declares no media type at all, else ``None`` when it offers only non-JSON encodings.
    """
    if not content_types:
        return DEFAULT_MEDIA_TYPE
    ordered = sorted(content_types)
    for candidate in ordered:
        if candidate.lower() == DEFAULT_MEDIA_TYPE:
            return candidate
    for candidate in ordered:
        if "json" in candidate.lower():
            return candidate
    return None


def _message(operation: Operation, role: MessageRole) -> Optional[Message]:
    """Return the first message of a role, in declaration order."""
    for message in operation.messages:
        if message.role is role:
            return message
    return None


def _success_expectation(
    compilation: _Compilation, operation: Operation
) -> ContractCaseExpectation:
    """Build the expectation a positive case asserts.

    The declared 2xx codes are the assertion. When the contract declares none, the expectation
    falls back to the ``2XX`` range and says so through ``status_declared`` — a weaker check
    that is visible rather than implied.
    """
    codes: List[str] = []
    schema_id: Optional[str] = None
    chosen: Optional[Message] = None
    for message in operation.messages:
        if message.role is not MessageRole.RESPONSE:
            continue
        code = (message.status_code or "").strip()
        if code and code[:1] in {"2", "3"}:
            codes.append(code)
            if chosen is None:
                chosen = message

    if not codes:
        compilation.report(
            CODE_STATUS_UNDECLARED,
            FINDING_DEGRADED,
            f"Operation {operation.key!r} declares no success status code, so cases assert the "
            "2XX range instead of an exact code.",
            operation_key=operation.key,
        )
        codes = ["2XX"]
        declared = False
    else:
        codes = sorted(set(codes))
        declared = True

    if chosen is not None and compilation.options.include_response_schemas:
        schema_id = _register_response_schema(compilation, operation, chosen)

    return ContractCaseExpectation(
        outcome=OUTCOME_SUCCESS,
        status_codes=codes,
        status_declared=declared,
        response_schema_id=schema_id,
        reason=(
            "The contract declares this operation succeeds with "
            f"{', '.join(codes)}."
            if declared
            else "The contract declares no success status, so any 2XX is accepted."
        ),
    )


def _error_expectation(
    compilation: _Compilation, operation: Operation
) -> ContractCaseExpectation:
    """Build the expectation a negative case asserts: the request must be rejected."""
    codes = sorted(
        {
            (message.status_code or "").strip()
            for message in operation.messages
            if message.role is MessageRole.ERROR
            and (message.status_code or "").strip()[:1] == "4"
        }
    )
    declared = bool(codes)
    if not declared:
        compilation.report(
            CODE_ERROR_STATUS_UNDECLARED,
            FINDING_INFO,
            f"Operation {operation.key!r} declares no 4xx response, so negative cases assert "
            "the 4XX range. Declaring the rejection status would make the contract testable "
            "exactly.",
            operation_key=operation.key,
        )
        codes = ["4XX"]

    return ContractCaseExpectation(
        outcome=OUTCOME_CLIENT_ERROR,
        status_codes=codes,
        status_declared=declared,
        response_schema_id=None,
        reason=(
            "The request violates the contract, so a conforming implementation rejects it with "
            f"{', '.join(codes)}."
        ),
    )


def _register_response_schema(
    compilation: _Compilation, operation: Operation, message: Message
) -> Optional[str]:
    """Store the schema a success response must satisfy and return its manifest key.

    Named types are stored once under ``type:<key>`` however many operations return them;
    an inline body is stored under its own message key.
    """
    if message.payload_schema is not None:
        schema_id = f"message:{message.key}"
        compilation.schemas.setdefault(schema_id, dict(message.payload_schema))
        return schema_id

    if message.payload is None:
        compilation.report(
            CODE_RESPONSE_SCHEMA_ABSENT,
            FINDING_INFO,
            f"Response {message.key!r} declares no body schema, so a success case checks the "
            "status code only.",
            operation_key=operation.key,
        )
        return None

    projection = _project_payload(compilation, message.payload)
    _report_projection(compilation, projection, operation.key, f"response {message.key!r}")
    if message.payload.item is None and projection.type_key:
        schema_id = f"type:{projection.type_key}"
    else:
        schema_id = f"message:{message.key}"
    compilation.schemas.setdefault(schema_id, projection.document)
    return schema_id


def _report_projection(
    compilation: _Compilation,
    projection: CanonicalSchemaProjection,
    operation_key: str,
    site: str,
) -> None:
    """Surface a projection's own honesty metadata as suite findings."""
    if projection.unmapped_scalars:
        compilation.report(
            CODE_UNMAPPED_SCALAR,
            FINDING_DEGRADED,
            f"The {site} of {operation_key!r} uses scalar(s) "
            f"{', '.join(projection.unmapped_scalars)} with no JSON Schema analogue; values at "
            "those positions are generated unconstrained and validated against nothing.",
            operation_key=operation_key,
        )
    if projection.truncated:
        compilation.report(
            CODE_SCHEMA_TRUNCATED,
            FINDING_DEGRADED,
            f"The {site} of {operation_key!r} reaches more types than one schema document "
            "carries; the remainder were left out and are not validated.",
            operation_key=operation_key,
        )


# ===========================================================================
# Case emission
# ===========================================================================


def _emit_example_cases(
    compilation: _Compilation,
    operation: Operation,
    method: str,
    template: str,
    parameters: List[ContractRequestParameter],
    body: _BodyPlan,
    expectation: ContractCaseExpectation,
) -> None:
    """Emit one case per declared request-body example — the author's own evidence, first."""
    if not compilation.options.include_declared_examples:
        return

    examples = [
        example
        for example in compilation.examples.get((template, method), ())
        if example.site == SITE_REQUEST_BODY
    ]
    if not examples:
        return

    emitted = 0
    for example in examples:
        if example.pointer in compilation.harvest.nonconforming:
            compilation.report(
                CODE_EXAMPLE_SCHEMA_MISMATCH,
                FINDING_DEGRADED,
                f"The declared request-body example at {example.pointer} for "
                f"{operation.key!r} does not satisfy its own schema, so it was not compiled: "
                "it would fail a conforming implementation.",
                operation_key=operation.key,
                pointer=example.pointer,
            )
            continue
        if example.media_type is not None and "json" not in example.media_type.lower():
            compilation.report(
                CODE_UNSUPPORTED_MEDIA_TYPE,
                FINDING_DEGRADED,
                f"The declared request-body example at {example.pointer} for "
                f"{operation.key!r} is written for {example.media_type}, which this compiler "
                "does not send. It was not compiled.",
                operation_key=operation.key,
                pointer=example.pointer,
            )
            continue
        if emitted >= compilation.options.max_example_cases_per_operation:
            compilation.report(
                CODE_CASE_LIMIT_REACHED,
                FINDING_DEGRADED,
                f"Operation {operation.key!r} declares more request-body examples than "
                f"`max_example_cases_per_operation` ({emitted}); the rest were not compiled.",
                operation_key=operation.key,
            )
            break

        named = f" '{example.name}'" if example.name else ""
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=parameters,
                source=CASE_SOURCE_DECLARED_EXAMPLE,
                source_detail=example.name,
                source_pointer=example.pointer,
                title=f"declared example{named}",
                description=(
                    f"Sends the request body the contract declares at {example.pointer}. "
                    "An example the author wrote is the strongest evidence of intent."
                ),
                synthetic=False,
                body=example.value,
                has_body=True,
                media_type=example.media_type or body.media_type or DEFAULT_MEDIA_TYPE,
                expectation=expectation,
            )
        )
        emitted += 1


def _emit_generated_cases(
    compilation: _Compilation,
    operation: Operation,
    method: str,
    template: str,
    parameters: List[ContractRequestParameter],
    body: _BodyPlan,
    expectation: ContractCaseExpectation,
) -> None:
    """Emit the schema-valid generated bodies: required-only, everything, and each branch."""
    if not compilation.options.include_generated or body.schema is None:
        return

    budget = compilation.options.max_generated_cases_per_operation
    branch_budget = max(1, budget - 2)
    result = _synthesize(
        compilation,
        operation,
        body,
        include_minimal=True,
        include_full=True,
        include_branches=compilation.options.include_branches,
        include_mutants=False,
        max_branches=branch_budget,
    )

    emitted = 0
    for instance in result:
        source = _GENERATED_SOURCES.get(instance.kind)
        if source is None:
            continue
        if emitted >= budget:
            compilation.report(
                CODE_CASE_LIMIT_REACHED,
                FINDING_DEGRADED,
                f"The request body of {operation.key!r} affords more generated shapes than "
                f"`max_generated_cases_per_operation` ({budget}); the rest were not compiled.",
                operation_key=operation.key,
            )
            break
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=parameters,
                source=source,
                source_detail=instance.branch.label if instance.branch else None,
                source_pointer=instance.branch.schema_pointer if instance.branch else None,
                title=instance.title,
                description=instance.description,
                synthetic=True,
                body=instance.instance,
                has_body=True,
                media_type=body.media_type or DEFAULT_MEDIA_TYPE,
                expectation=expectation,
            )
        )
        emitted += 1


def _emit_negative_cases(
    compilation: _Compilation,
    operation: Operation,
    method: str,
    template: str,
    parameters: List[ContractRequestParameter],
    body: _BodyPlan,
    expectation: ContractCaseExpectation,
) -> None:
    """Emit the cases a contract needs to be worth running: requests that must be rejected.

    Structural negatives come first because they hold for every API — a required body omitted, a
    required query parameter dropped, a parameter given the wrong type. The remaining budget goes
    to bodies that each violate exactly one schema constraint, which is where a schema's real
    strictness is proven.
    """
    if not compilation.options.include_negative:
        return

    budget = compilation.options.max_negative_cases_per_operation
    emitted = 0
    # Generated at most once, and only when a parameter case actually needs it: a negative
    # *parameter* case must isolate one fault, so every one of them carries the same known-good
    # body rather than a second violation.
    cached: List[Any] = []

    def valid_body() -> Optional[Any]:
        """The minimal valid body for this operation, synthesized on first use."""
        if not cached:
            cached.append(_valid_body(compilation, operation, body))
        return cached[0]

    if body.required and body.media_type is not None:
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=parameters,
                source=CASE_SOURCE_NEGATIVE_MISSING_BODY,
                source_detail=None,
                source_pointer=None,
                title="request body omitted",
                description=(
                    "Sends no body although the contract declares one required. A conforming "
                    "implementation rejects the request."
                ),
                synthetic=True,
                body=None,
                has_body=False,
                media_type=None,
                expectation=expectation,
            )
        )
        emitted += 1

    for parameter in parameters:
        if emitted >= budget:
            break
        if not parameter.required or parameter.location != ParameterLocation.QUERY.value:
            continue
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=[item for item in parameters if item is not parameter],
                source=CASE_SOURCE_NEGATIVE_MISSING_PARAMETER,
                source_detail=parameter.name,
                source_pointer=None,
                title=f"required query parameter '{parameter.name}' omitted",
                description=(
                    f"Omits the required query parameter {parameter.name!r}. A conforming "
                    "implementation rejects the request rather than defaulting it."
                ),
                synthetic=True,
                body=valid_body(),
                has_body=body.schema is not None,
                media_type=body.media_type if body.schema is not None else None,
                expectation=expectation,
            )
        )
        emitted += 1

    typed = _wrong_type_parameter(compilation, operation, parameters)
    if typed is not None and emitted < budget:
        mutated = [
            item.model_copy(update={"value": WRONG_TYPE_PARAMETER_VALUE})
            if item.name == typed.name and item.location == typed.location
            else item
            for item in parameters
        ]
        compilation.cases.append(
            _build_case(
                operation=operation,
                method=method,
                template=template,
                parameters=mutated,
                source=CASE_SOURCE_NEGATIVE_PARAMETER_TYPE,
                source_detail=typed.name,
                source_pointer=None,
                title=f"parameter '{typed.name}' with a wrong-typed value",
                description=(
                    f"Sends {WRONG_TYPE_PARAMETER_VALUE!r} for {typed.name!r}, which the "
                    "contract declares as a non-string type. A conforming implementation "
                    "rejects it."
                ),
                synthetic=True,
                body=valid_body(),
                has_body=body.schema is not None,
                media_type=body.media_type if body.schema is not None else None,
                expectation=expectation,
            )
        )
        emitted += 1

    if body.schema is not None and emitted < budget:
        mutants = _synthesize(
            compilation,
            operation,
            body,
            include_minimal=False,
            include_full=False,
            include_branches=False,
            include_mutants=True,
            max_mutants=budget - emitted,
        )
        for instance in mutants:
            if instance.kind != INSTANCE_MUTANT or instance.mutation is None:
                continue
            if emitted >= budget:
                break
            compilation.cases.append(
                _build_case(
                    operation=operation,
                    method=method,
                    template=template,
                    parameters=parameters,
                    source=CASE_SOURCE_NEGATIVE_BODY_MUTATION,
                    source_detail=instance.mutation.kind,
                    source_pointer=instance.mutation.pointer,
                    title=f"body violating {instance.mutation.keyword}"
                    f" at {instance.mutation.pointer or '/'}",
                    description=instance.mutation.description,
                    synthetic=True,
                    body=instance.instance,
                    has_body=True,
                    media_type=body.media_type or DEFAULT_MEDIA_TYPE,
                    expectation=expectation,
                )
            )
            emitted += 1

    if emitted == 0:
        compilation.report(
            CODE_NO_NEGATIVE_CASES,
            FINDING_DEGRADED,
            f"No negative case could be compiled for {operation.key!r}: it declares no "
            "required body, no required query parameter, and no constrained body schema, so "
            "there is nothing a request can violate.",
            operation_key=operation.key,
        )


#: Synthesis instance kind → the case source it becomes.
_GENERATED_SOURCES: Dict[str, str] = {
    INSTANCE_MINIMAL: CASE_SOURCE_GENERATED_MINIMAL,
    INSTANCE_FULL: CASE_SOURCE_GENERATED_FULL,
    INSTANCE_BRANCH: CASE_SOURCE_GENERATED_BRANCH,
}


def _valid_body(
    compilation: _Compilation, operation: Operation, body: _BodyPlan
) -> Optional[Any]:
    """Return a schema-valid body for a case whose *parameters* are what should be rejected.

    A negative parameter case must isolate one fault: if its body were also invalid, a rejection
    would prove nothing about the parameter.

    Args:
        compilation: The run state.
        operation: The operation being compiled.
        body: The operation's body plan.

    Returns:
        The minimal valid body, or ``None`` when the operation takes no body.
    """
    if body.schema is None:
        return None
    instances = _synthesize(
        compilation,
        operation,
        body,
        include_minimal=True,
        include_full=False,
        include_branches=False,
        include_mutants=False,
    )
    return instances[0].instance if instances else None


def _wrong_type_parameter(
    compilation: _Compilation,
    operation: Operation,
    parameters: Sequence[ContractRequestParameter],
) -> Optional[ContractRequestParameter]:
    """Pick the parameter a wrong-typed value would violate, or ``None`` when none would.

    Only a parameter whose declared type rejects an arbitrary string is usable: sending
    ``"not-a-valid-value"`` for a ``string`` parameter is a perfectly valid request, and a case
    asserting it must be rejected would be wrong.
    """
    declared = {
        (parameter.location.value, parameter.name): parameter
        for parameter in operation.parameters
    }
    for candidate in parameters:
        parameter = declared.get((candidate.location, candidate.name))
        if parameter is None or not candidate.required:
            continue
        projection = build_ref_json_schema(
            compilation.api, parameter.type, constraints=parameter.constraints
        )
        if projection.document.get("type") in {"integer", "number", "boolean"}:
            return candidate
    return None


def _synthesize(
    compilation: _Compilation,
    operation: Operation,
    body: _BodyPlan,
    *,
    include_minimal: bool,
    include_full: bool,
    include_branches: bool,
    include_mutants: bool,
    max_branches: int = 2,
    max_mutants: int = 4,
) -> List[SynthesizedInstance]:
    """Generate body instances for one operation, reporting whatever limited generation.

    Args:
        compilation: The run state.
        operation: The operation the body belongs to (seeds the generator, scopes findings).
        body: The resolved body plan.
        include_minimal: Generate the required-properties-only body.
        include_full: Generate the every-property body.
        include_branches: Generate one body per polymorphic alternative.
        include_mutants: Generate single-constraint violations.
        max_branches: Cap on branch instances.
        max_mutants: Cap on mutants.

    Returns:
        The generated instances, in the generator's own deterministic order. Empty when the
        operation takes no body.
    """
    if body.schema is None:
        return []
    result = synthesize_instances(
        body.schema,
        dialect=body.dialect,
        seed=_seed_for(compilation.options.seed, operation.key),
        base_uri=body.base_uri,
        retrieve=body.retrieve,
        include_minimal=include_minimal,
        include_full=include_full,
        include_branches=include_branches,
        include_mutants=include_mutants,
        max_mutants=max(1, max_mutants),
        max_branch_instances=max(1, max_branches),
        verify=True,
    )
    for diagnostic in result.diagnostics:
        compilation.report(
            CODE_GENERATION_LIMITED,
            FINDING_DEGRADED,
            f"Generating a body for {operation.key!r} was limited: {diagnostic.message}",
            operation_key=operation.key,
            pointer=diagnostic.pointer,
        )
    return result.instances


def _build_case(
    *,
    operation: Operation,
    method: str,
    template: str,
    parameters: Sequence[ContractRequestParameter],
    source: str,
    source_detail: Optional[str],
    source_pointer: Optional[str],
    title: str,
    description: str,
    synthetic: bool,
    body: Optional[Any],
    has_body: bool,
    media_type: Optional[str],
    expectation: ContractCaseExpectation,
) -> ContractCase:
    """Assemble one case, deriving its stable id from what makes it distinct.

    Args:
        operation: The operation the case exercises.
        method: Upper-cased HTTP verb.
        template: The route template.
        parameters: Parameter values this case sends.
        source: The case source.
        source_detail: What distinguishes the case within its source.
        source_pointer: Pointer to the case's origin, when it has one.
        title: Short human-readable name.
        description: What the case exercises.
        synthetic: ``False`` only for an author-written body.
        body: The request body.
        has_body: Whether a body is sent at all.
        media_type: Media type the body is sent as.
        expectation: What must come back.

    Returns:
        The assembled :class:`ContractCase`.
    """
    values = list(parameters)
    return ContractCase(
        case_id=_case_id(operation.key, source, source_detail, source_pointer, title),
        operation_key=operation.key,
        operation_name=operation.name,
        source=source,
        source_detail=source_detail,
        source_pointer=source_pointer,
        title=title,
        description=description,
        synthetic=synthetic,
        request=ContractCaseRequest(
            method=method,
            path_template=template,
            path=_resolve_path(template, values),
            parameters=values,
            has_body=has_body,
            body=body if has_body else None,
            media_type=media_type if has_body else None,
        ),
        expect=expectation,
        tags=list(operation.tags),
    )


def _case_id(
    operation_key: str,
    source: str,
    source_detail: Optional[str],
    source_pointer: Optional[str],
    title: str,
) -> str:
    """Derive a case's stable id.

    The id is a hash of the coordinates that make a case distinct, so it survives a case moving
    within the suite (its position is not an input) but changes when the case itself changes.
    ``title`` participates because two mutants of the same kind at the same pointer differ only
    by the constraint they name.

    Args:
        operation_key: The operation's canonical key.
        source: The case source.
        source_detail: Source-specific discriminator, when there is one.
        source_pointer: Pointer to the case's origin, when there is one.
        title: The case title.

    Returns:
        A ``case_`` prefixed 16-hex-character id.
    """
    material = "\x1f".join(
        (operation_key, source, source_detail or "", source_pointer or "", title)
    )
    return "case_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _seed_for(seed: int, key: str) -> int:
    """Derive a per-site generator seed from the suite seed and a stable key.

    Deriving rather than reusing the suite seed keeps two operations with identical schemas from
    getting identical payloads, while keeping the whole suite reproducible from one number.

    Args:
        seed: The suite-wide seed.
        key: A stable coordinate (operation key, parameter key).

    Returns:
        A seed in ``[0, MAX_SEED]``.
    """
    digest = hashlib.sha256(f"{seed}\x1f{key}".encode("utf-8")).hexdigest()[:8]
    return int(digest, 16) % (MAX_SEED + 1)


# ===========================================================================
# Assembly
# ===========================================================================


def _sorted_findings(findings: Sequence[SuiteFinding]) -> List[SuiteFinding]:
    """Order findings deterministically, and drop exact duplicates.

    Two operations can hit the same document-level condition; reporting it twice adds noise
    without adding information.
    """
    seen: set = set()
    unique: List[SuiteFinding] = []
    for finding in findings:
        identity = (finding.code, finding.operation_key or "", finding.pointer or "", finding.message)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(finding)
    unique.sort(
        key=lambda item: (item.code, item.operation_key or "", item.pointer or "", item.message)
    )
    return unique


def _counts(compilation: _Compilation, *, skipped: int) -> Dict[str, int]:
    """Summarize the suite: one count per case source, plus the totals a reader looks at first."""
    counts: Dict[str, int] = {source: 0 for source in CASE_SOURCES}
    for case in compilation.cases:
        counts[case.source] = counts.get(case.source, 0) + 1
    counts["cases"] = len(compilation.cases)
    counts["negative_cases"] = sum(
        count for source, count in counts.items() if source in _NEGATIVE_SOURCES
    )
    counts["operations_compiled"] = len(compilation.operations)
    counts["operations_skipped"] = skipped + len(set(compilation.skipped))
    counts["findings"] = len(compilation.findings)
    return {key: counts[key] for key in sorted(counts)}
