"""Orchestrate compile → resolve → run → record for ECA-2.1 (#4732).

The HTTP contract runner's service layer sits between the REST route and three pure pieces:

* :mod:`app.contract_suite_service` compiles a version into a deterministic suite;
* :mod:`app.verification_target_store` resolves (and audits) the target;
* :mod:`app.contract_runner` executes cases and returns ECA-1.3 operation inputs;
* :mod:`app.verification_evidence_store` persists the run as immutable evidence.

Every successful execution records evidence. A compile that yields no cases, a target that
cannot be resolved, or an auth reference that cannot be materialised answers ``ok=false``
without inventing a green run.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from .contract_runner import (
    RUNNER_NAME,
    RUNNER_VERSION,
    AuthResolutionError,
    materialize_auth_headers,
    run_suite,
)
from .contract_suite import ContractSuiteOptions
from .contract_suite_service import (
    ContractSuiteCompileRequest,
    SchemaReferenceError,
    compile_version_contract_suite,
)
from .import_source_pipeline import build_job_error
from .mcp_credentials import load_endpoint_auth_headers
from .models import SpecImportJobError
from .verification_evidence import VerificationRunInput, VerificationRunRecord
from .verification_evidence_store import TargetActor, record_run
from .verification_target import AUTH_KIND_STORED
from .verification_target_store import resolve_target

__all__ = [
    "ContractRunRequest",
    "ContractRunResponse",
    "SchemaReferenceError",
    "run_version_contract_suite",
]


class ContractRunRequest(BaseModel):
    """What to execute against which target.

    Compiler options are optional and default to the same defaults as suite compilation, so a
    digest recorded in evidence matches ``POST …/suite`` with the same options.
    """

    model_config = ConfigDict(extra="forbid")

    target_ref: str = Field(
        description="Verification target slug or id (ECA-1.2).",
        min_length=1,
        max_length=200,
    )
    options: ContractSuiteOptions = Field(
        default_factory=ContractSuiteOptions,
        description="Compiler options; hashed into the suite digest recorded on the run.",
    )
    idempotency_key: Optional[str] = Field(
        default=None,
        description="Evidence upload retry key; forwarded to the verification-runs store.",
        max_length=200,
    )
    context: Dict[str, Any] = Field(
        default_factory=dict,
        description="Non-secret CI context (commit, branch, workflow URL).",
    )


class ContractRunResponse(BaseModel):
    """The outcome of one contract run attempt."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Whether the suite executed and evidence was recorded.")
    version_ref: str = Field(description="The version reference exactly as requested.")
    suite_digest: Optional[str] = Field(
        default=None, description="Digest of the suite that was executed, when compiled."
    )
    run: Optional[VerificationRunRecord] = Field(
        default=None, description="Immutable evidence record when `ok` is true."
    )
    created: Optional[bool] = Field(
        default=None,
        description="True when evidence was newly written; False on idempotent replay.",
    )
    error: Optional[SpecImportJobError] = Field(
        default=None,
        description="Populated when `ok` is false: stable taxonomy code plus remediation.",
    )


def run_version_contract_suite(
    version_ref: str,
    request: ContractRunRequest,
    *,
    tenant_id: str,
    actor: TargetActor,
) -> ContractRunResponse:
    """Compile, resolve, execute, and record evidence for one version against one target.

    Args:
        version_ref: ``project/{slug}/{version}`` or ``catalog/{item}/{version}``.
        request: Target reference, compiler options, and optional CI context.
        tenant_id: Authenticated tenant.
        actor: Who is running — used for target resolve audit and evidence actor fields.

    Returns:
        A :class:`ContractRunResponse`. Addressing faults raise
        :class:`~app.schema_reference.SchemaReferenceError`; target faults raise
        :class:`~app.verification_target.TargetValidationError`; evidence submission faults
        raise :class:`~app.verification_evidence.EvidenceValidationError`.
    """
    compiled = compile_version_contract_suite(
        version_ref,
        ContractSuiteCompileRequest(options=request.options),
        tenant_id=tenant_id,
    )
    if not compiled.ok or compiled.manifest is None:
        return ContractRunResponse(
            ok=False,
            version_ref=version_ref,
            error=compiled.error
            or build_job_error(
                "FORMAT_MISMATCH",
                "No contract suite could be compiled for this version.",
            ),
        )

    manifest = compiled.manifest
    if not manifest.cases:
        return ContractRunResponse(
            ok=False,
            version_ref=version_ref,
            suite_digest=manifest.digest,
            error=build_job_error(
                "FORMAT_MISMATCH",
                "The compiled suite has no executable cases. A run that never exercised a "
                "case cannot produce meaningful evidence — fix findings on the suite or "
                "widen compiler options, then retry.",
            ),
        )

    resolved = resolve_target(
        tenant_id,
        request.target_ref,
        actor=actor,
        suite_digest=manifest.digest,
    )

    stored_headers: Optional[Dict[str, str]] = None
    if resolved.auth.kind == AUTH_KIND_STORED and resolved.auth.ref:
        stored_headers = load_endpoint_auth_headers(resolved.auth.ref)

    try:
        auth_headers = materialize_auth_headers(
            resolved.auth, stored_headers=stored_headers
        )
    except AuthResolutionError as exc:
        return ContractRunResponse(
            ok=False,
            version_ref=version_ref,
            suite_digest=manifest.digest,
            error=build_job_error(
                "SOURCE_AUTH_REQUIRED",
                str(exc),
            ),
        )

    suite_result = run_suite(manifest, resolved, auth_headers=auth_headers)

    source: Dict[str, Any] = {}
    if manifest.source is not None:
        source = manifest.source.model_dump(mode="json", exclude_none=True)

    run_input = VerificationRunInput(
        target_ref=request.target_ref,
        suite_digest=manifest.digest,
        suite_schema_version=manifest.schema_version,
        suite_compiler_version=manifest.compiler_version,
        suite_case_count=len(manifest.cases),
        runner_name=RUNNER_NAME,
        runner_version=RUNNER_VERSION,
        started_at=suite_result.started_at,
        finished_at=suite_result.finished_at,
        source=source,
        context=dict(request.context or {}),
        idempotency_key=request.idempotency_key,
        operations=suite_result.operations,
    )

    recorded = record_run(tenant_id, run_input, actor=actor)
    return ContractRunResponse(
        ok=True,
        version_ref=version_ref,
        suite_digest=manifest.digest,
        run=recorded.record,
        created=recorded.created,
    )
