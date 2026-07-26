"""The sample-payload synthesis service — IXH-5.2 (#5114).

Answers *give me payloads for this schema* for any schema Apiome holds, and composes exactly
the pieces IXH-5.1 already built:

* :mod:`app.schema_reference` turns the URL's reference into a schema (project version, catalog
  revision, or type-registry type) — the same grammar the validate endpoint uses, so a caller
  addresses one schema one way and can validate and generate against it interchangeably;
* :mod:`app.schema_instance_synthesis` generates the payloads, deterministically;
* :mod:`app.schema_instance_validation` verifies every one of them before it is returned.

**Failure shape** is the convention the rest of the intake surface uses: a schema that *cannot*
be generated from is a 200 carrying ``ok = false`` and a stable
:mod:`app.intake_error_taxonomy` code with remediation, never an HTTP 5xx. Only *addressing*
faults are HTTP errors, and those come out of :mod:`app.schema_reference` unchanged.

**Everything returned is labelled synthetic** — at the response level (``synthetic``,
``notice``), on every instance (``synthetic``), and per value (``ValueProvenance.synthetic``),
so the label survives a caller copying one payload out of the response.

Nothing here writes: no job, no revision, no audit row. XML schemas are out of scope — synthesis
generates JSON instances, and a reference that resolves only to an XML grammar is reported as a
``FORMAT_MISMATCH`` rather than answered with a payload no XSD would accept.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from .import_source_pipeline import build_job_error
from .models import SpecImportJobError
from .schema_instance_service import SchemaSourceInfo
from .schema_instance_synthesis import (
    DEFAULT_MAX_BRANCH_INSTANCES,
    DEFAULT_MAX_MUTANTS,
    MAX_BRANCH_INSTANCES_CEILING,
    MAX_MUTANTS_CEILING,
    MAX_SEED,
    MAX_SYNTHESIS_DEPTH,
    MUTATION_KINDS,
    SYNTHETIC_NOTICE,
    SynthesizedInstance,
    synthesize_instances,
)
from .schema_instance_validation import ValidationDiagnostic
from .schema_reference import (
    SchemaReferenceError,
    parse_schema_reference,
    resolve_schema_reference,
)

__all__ = [
    "SchemaSynthesisRequest",
    "SchemaSynthesisResponse",
    # Re-exported so a route can catch the addressing fault without a second import.
    "SchemaReferenceError",
    "synthesize_schema_payloads",
]


class SchemaSynthesisRequest(BaseModel):
    """What to generate for the schema named in the URL.

    Every field has a usable default: an empty body generates the whole set — minimal, full,
    every branch, and the mutants — under seed 0.
    """

    model_config = ConfigDict(extra="forbid")

    seed: int = Field(
        default=0,
        ge=0,
        le=MAX_SEED,
        description=(
            "Seed for the value generator. The same schema and seed always produce "
            "byte-identical payloads; change it to get a different sample of the same shapes."
        ),
    )
    include_minimal: bool = Field(
        default=True, description="Generate the required-properties-only instance."
    )
    include_full: bool = Field(
        default=True, description="Generate the every-optional-property instance."
    )
    include_branches: bool = Field(
        default=True,
        description=(
            "Generate one instance per `oneOf`/`anyOf` alternative and per `if`/`then`/`else` "
            "arm. Alternatives that produce a payload already returned are skipped."
        ),
    )
    include_mutants: bool = Field(
        default=True,
        description=(
            "Generate payloads that each violate exactly one constraint. Only mutants that "
            "provoke a single violation of the constraint they target are returned."
        ),
    )
    mutation_kinds: Optional[List[str]] = Field(
        default=None,
        description=(
            "Restrict mutants to these kinds. Omit for all of them. Known kinds: "
            + ", ".join(f"`{kind}`" for kind in MUTATION_KINDS)
            + "."
        ),
    )
    max_mutants: int = Field(
        default=DEFAULT_MAX_MUTANTS,
        ge=1,
        le=MAX_MUTANTS_CEILING,
        description=(
            "Cap on returned mutants. Selection is round-robin across the mutation kinds, so "
            "a low cap still covers every kind the schema affords."
        ),
    )
    max_branch_instances: int = Field(
        default=DEFAULT_MAX_BRANCH_INSTANCES,
        ge=1,
        le=MAX_BRANCH_INSTANCES_CEILING,
        description="Cap on returned branch instances.",
    )
    verify: bool = Field(
        default=True,
        description=(
            "Validate every generated payload back against the schema, and drop any mutant "
            "that does not break exactly the constraint it targets. Turning this off returns "
            "the payloads unchecked, with `valid` null on every one of them."
        ),
    )


class SchemaSynthesisResponse(BaseModel):
    """The generated payloads for one schema."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Whether the request was serviceable at all.")
    synthetic: bool = Field(
        default=True,
        description=(
            "Always true. Every payload in this response was generated from the schema and "
            "is not, and never was, real data."
        ),
    )
    notice: str = Field(
        default=SYNTHETIC_NOTICE,
        description="Human-readable statement of the above, for display next to the payloads.",
    )
    schema_ref: str = Field(description="The schema reference exactly as it was requested.")
    seed: int = Field(default=0, description="The seed used, echoed so a run can be reproduced.")
    dialect: Optional[str] = Field(
        default=None, description="The JSON Schema dialect the schema was read under."
    )
    depth_limit: int = Field(
        default=MAX_SYNTHESIS_DEPTH,
        description=(
            "Nesting depth at which generation stops descending into optional structure. A "
            "recursive schema terminates here; the omission is reported as a diagnostic."
        ),
    )
    verified: bool = Field(
        default=True, description="Whether generated payloads were validated back."
    )
    source: Optional[SchemaSourceInfo] = Field(
        default=None, description="What the reference resolved to."
    )
    instances: List[SynthesizedInstance] = Field(
        default_factory=list,
        description=(
            "The generated payloads, ordered minimal, full, branches, then mutants. Each "
            "carries its own `synthetic` label, what it is for, whether it is meant to be "
            "valid, and — for a mutant — the single constraint it breaks."
        ),
    )
    counts: Dict[str, int] = Field(
        default_factory=dict,
        description="How many instances of each kind were returned (`minimal`, `full`, …).",
    )
    rejected_mutants: int = Field(
        default=0,
        description=(
            "Mutation candidates dropped because they did not fail the schema with exactly "
            "the constraint they targeted — a negative test that fails for the wrong reason "
            "is worse than no test."
        ),
    )
    truncated: bool = Field(
        default=False,
        description="Whether `max_mutants` or `max_branch_instances` cut the set short.",
    )
    diagnostics: List[ValidationDiagnostic] = Field(
        default_factory=list,
        description=(
            "Conditions that limited generation — a construct with no generatable value, an "
            "unresolvable `$ref`, a recursion bound, an authored example that does not "
            "satisfy its own schema. Never a fault of the request."
        ),
    )
    error: Optional[SpecImportJobError] = Field(
        default=None,
        description="Populated when `ok` is false: stable taxonomy code plus remediation.",
    )


def synthesize_schema_payloads(
    schema_ref: str,
    request: SchemaSynthesisRequest,
    *,
    tenant_id: str,
) -> SchemaSynthesisResponse:
    """Generate sample payloads for the schema at ``schema_ref``.

    Args:
        schema_ref: The reference from the URL path (see :mod:`app.schema_reference`).
        request: What to generate.
        tenant_id: The caller's authenticated tenant; every schema lookup is scoped to it.

    Returns:
        The :class:`SchemaSynthesisResponse`.

    Raises:
        SchemaReferenceError: When the reference is malformed (400), names nothing visible
            (404), or resolves to material no schema can be derived from (422). Every *other*
            failure is a 200 with ``ok = false``.
    """
    reference = parse_schema_reference(schema_ref)
    resolved = resolve_schema_reference(reference, tenant_id=tenant_id)
    source = SchemaSourceInfo(
        kind=reference.kind,
        source_format=resolved.source_format,
        dialect=resolved.dialect,
        projected=reference.kind != "registry",
        coordinates=resolved.coordinates,
    )

    if resolved.document is None:
        return SchemaSynthesisResponse(
            ok=False,
            schema_ref=schema_ref,
            seed=request.seed,
            source=source,
            diagnostics=list(resolved.diagnostics),
            error=build_job_error(
                "FORMAT_MISMATCH",
                "This reference resolves to an XML grammar, which this endpoint cannot "
                "generate JSON payloads from. Reference a JSON-schema-backed type instead.",
            ),
        )

    unknown = [
        kind for kind in (request.mutation_kinds or []) if kind not in set(MUTATION_KINDS)
    ]
    if unknown:
        return SchemaSynthesisResponse(
            ok=False,
            schema_ref=schema_ref,
            seed=request.seed,
            source=source,
            error=build_job_error(
                "INPUT_SEMANTIC_INVALID",
                f"Unknown mutation kind(s): {', '.join(sorted(unknown))}. Supported kinds: "
                + ", ".join(MUTATION_KINDS)
                + ".",
            ),
        )

    result = synthesize_instances(
        resolved.document,
        dialect=resolved.dialect,
        seed=request.seed,
        base_uri=resolved.base_uri,
        retrieve=resolved.retrieve,
        include_minimal=request.include_minimal,
        include_full=request.include_full,
        include_branches=request.include_branches,
        include_mutants=request.include_mutants,
        mutation_kinds=request.mutation_kinds,
        max_mutants=request.max_mutants,
        max_branch_instances=request.max_branch_instances,
        verify=request.verify,
    )

    counts: Dict[str, int] = {}
    for instance in result.instances:
        counts[instance.kind] = counts.get(instance.kind, 0) + 1

    return SchemaSynthesisResponse(
        ok=True,
        schema_ref=schema_ref,
        seed=result.seed,
        dialect=result.dialect,
        depth_limit=result.depth_limit,
        verified=result.verified,
        source=source.model_copy(update={"dialect": result.dialect}),
        instances=result.instances,
        counts=counts,
        rejected_mutants=result.rejected_mutants,
        truncated=result.mutants_truncated or result.branches_truncated,
        diagnostics=[*resolved.diagnostics, *result.diagnostics],
    )
