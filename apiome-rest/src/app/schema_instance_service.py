"""The schema instance-validation service — IXH-5.1 (#5113).

Orchestrates the one question the endpoint exists to answer: *does this payload satisfy the
schema at this reference?* Everything hard lives in the pieces this module composes —

* :mod:`app.schema_reference` turns the URL's reference into a schema (project version, catalog
  revision, or type-registry type);
* :mod:`app.intake_resource_guard` bounds the submitted payload before anything parses it;
* :mod:`app.schema_instance_validation` validates JSON with deterministic, ordered findings and
  bounded, cycle-safe ``$ref`` resolution;
* :mod:`app.xml_instance_validation` dispatches XML through the external-linter adapter seam.

— and this module owns the request/response contract that stitches them together.

**Failure shape.** A payload the service *cannot* check is not an HTTP error: the response is a
200 carrying ``ok = false``, ``valid = null``, and a stable
:mod:`app.intake_error_taxonomy` code with remediation — the same convention the IXH-2.1
pre-flight and IXH-3.1 preview manifest use, so a caller keys off the code rather than parsing
exception strings. Only *addressing* faults are HTTP errors: an unparseable reference is a 400,
a reference to something the tenant cannot see is a 404, a reference that resolves to material no
schema can be derived from is a 422.

**``valid`` is never guessed.** It is ``true`` only when a validator ran and found nothing,
``false`` only when a validator ran and found something, and ``null`` whenever no validator ran.
A deployment without ``xmllint`` therefore reports "not checked", never "fine".

Nothing here writes: no job, no revision, no audit row. The service is a pure read plus a
sandboxed subprocess for the XML path.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .import_source_pipeline import build_job_error
from .intake_resource_guard import (
    IntakeLimitError,
    guard_document_size,
    guard_document_text,
    guard_parsed_document,
)
from .models import SpecImportJobError
from .schema_instance_validation import (
    DEFAULT_MAX_FINDINGS,
    MAX_FINDINGS_CEILING,
    InstanceFinding,
    ValidationDiagnostic,
    validate_json_instance,
)
from .schema_reference import (
    ResolvedSchema,
    SchemaReferenceError,
    parse_schema_reference,
    resolve_schema_reference,
)
from .xml_instance_validation import validate_xml_instance

__all__ = [
    "MEDIA_TYPE_JSON",
    "MEDIA_TYPE_XML",
    # Re-exported so a route can catch the addressing fault without a second import.
    "SchemaReferenceError",
    "SchemaInstanceValidationRequest",
    "SchemaInstanceValidationResponse",
    "SchemaSourceInfo",
    "validate_schema_instance",
]

MEDIA_TYPE_JSON = "application/json"
MEDIA_TYPE_XML = "application/xml"


class SchemaInstanceValidationRequest(BaseModel):
    """A payload to check against the schema named in the URL.

    Exactly one of ``instance`` and ``instance_text`` must be supplied. ``instance`` is the
    convenient form for a JSON payload a caller already holds as a value; ``instance_text`` is
    the exact-bytes form, and the only form an XML payload can take.
    """

    model_config = ConfigDict(extra="forbid")

    instance: Optional[Any] = Field(
        default=None,
        description=(
            "The payload as an already-parsed JSON value. Mutually exclusive with "
            "``instance_text``. Sending an explicit ``null`` here validates the JSON value "
            "``null``, which is a legitimate instance."
        ),
    )
    instance_text: Optional[str] = Field(
        default=None,
        description=(
            "The payload as raw text — JSON or XML, per ``media_type``. Mutually exclusive "
            "with ``instance``, and required for XML."
        ),
    )
    media_type: Literal["application/json", "application/xml"] = Field(
        default=MEDIA_TYPE_JSON,
        description="How ``instance_text`` should be read. XML requires ``instance_text``.",
    )
    max_findings: int = Field(
        default=DEFAULT_MAX_FINDINGS,
        ge=1,
        le=MAX_FINDINGS_CEILING,
        description="Cap on returned findings; the true total is always reported separately.",
    )
    assert_formats: bool = Field(
        default=False,
        description=(
            "Assert JSON Schema ``format`` rather than treating it as an annotation. Off by "
            "default: ``format`` is an annotation in every modern draft, and checkers whose "
            "optional dependency is absent are skipped silently, so an asserted-format pass is "
            "weaker evidence than a keyword pass."
        ),
    )


class SchemaSourceInfo(BaseModel):
    """What the reference actually resolved to, echoed back so a caller can confirm it."""

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(description="``project``, ``catalog``, or ``registry``.")
    source_format: Optional[str] = Field(
        default=None, description="Import-source format key the schema derives from."
    )
    dialect: Optional[str] = Field(
        default=None, description="JSON Schema dialect the schema was validated under."
    )
    projected: bool = Field(
        description=(
            "Whether the schema was projected from the canonical model (project/catalog "
            "references) rather than used verbatim (registry references)."
        )
    )
    coordinates: Dict[str, Any] = Field(
        default_factory=dict,
        description="Resolved coordinates — artifact id, revision id, version label, type key.",
    )


class SchemaInstanceValidationResponse(BaseModel):
    """The verdict on one payload."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Whether the request was serviceable at all.")
    valid: Optional[bool] = Field(
        default=None,
        description=(
            "``true`` when a validator ran and found nothing, ``false`` when it ran and found "
            "something, ``null`` when no validator ran — never a stand-in for a pass."
        ),
    )
    validated: bool = Field(
        description="Whether a validator actually executed over the instance."
    )
    validator: Optional[str] = Field(
        default=None,
        description="Which validator ran (``jsonschema/2020-12``, ``xmllint.validate``).",
    )
    schema_ref: str = Field(description="The schema reference exactly as it was requested.")
    media_type: str = Field(description="How the instance was read.")
    source: Optional[SchemaSourceInfo] = Field(
        default=None, description="What the reference resolved to."
    )
    findings: List[InstanceFinding] = Field(
        default_factory=list,
        description=(
            "Ways the instance failed the schema, in a deterministic order: by instance "
            "pointer (array indices numerically), then schema pointer, keyword, and message."
        ),
    )
    total_findings: int = Field(
        default=0,
        description="How many findings existed before ``max_findings`` truncation.",
    )
    truncated: bool = Field(
        default=False, description="Whether ``findings`` was cut short by ``max_findings``."
    )
    diagnostics: List[ValidationDiagnostic] = Field(
        default_factory=list,
        description=(
            "Conditions that limited the check — an unresolvable ``$ref``, a bound that "
            "tripped, a source scalar with no JSON Schema equivalent, a missing toolchain. "
            "Never failures of the instance itself."
        ),
    )
    # ``SpecImportJobError`` is the shared carrier for an intake-taxonomy code, not an
    # import-only shape: reusing it keeps one error contract (and one builder) across every
    # surface that speaks the taxonomy, rather than minting a lookalike per endpoint.
    error: Optional[SpecImportJobError] = Field(
        default=None,
        description="Populated when ``ok`` is false: stable taxonomy code plus remediation.",
    )


async def validate_schema_instance(
    schema_ref: str,
    request: SchemaInstanceValidationRequest,
    *,
    tenant_id: str,
) -> SchemaInstanceValidationResponse:
    """Validate one payload against the schema at ``schema_ref``.

    Args:
        schema_ref: The reference from the URL path (see :mod:`app.schema_reference`).
        request: The payload and options.
        tenant_id: The caller's authenticated tenant; every schema lookup is scoped to it.

    Returns:
        The :class:`SchemaInstanceValidationResponse`.

    Raises:
        SchemaReferenceError: When the reference is malformed (400), names nothing visible
            (404), or resolves to material no schema can be derived from (422). The route maps
            its ``status_code`` straight through; every *other* failure is a 200 with
            ``ok = false``.
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

    if request.media_type == MEDIA_TYPE_XML:
        return await _validate_xml(schema_ref, request, resolved, source)
    return _validate_json(schema_ref, request, resolved, source)


# ===========================================================================
# Per-media-type paths
# ===========================================================================


def _validate_json(
    schema_ref: str,
    request: SchemaInstanceValidationRequest,
    resolved: ResolvedSchema,
    source: SchemaSourceInfo,
) -> SchemaInstanceValidationResponse:
    """Run the JSON path: guard, parse if needed, validate, and shape the response."""
    try:
        instance = _json_instance(request)
    except _RequestFaultError as fault:
        return _not_serviceable(schema_ref, request, source, fault.code, str(fault))

    if resolved.document is None:
        return _not_serviceable(
            schema_ref,
            request,
            source,
            "FORMAT_MISMATCH",
            "This reference resolves to an XML schema, which cannot validate a JSON payload. "
            "Send the instance as XML (`media_type: application/xml`), or reference a "
            "JSON-schema-backed type.",
        )

    result = validate_json_instance(
        resolved.document,
        instance,
        dialect=resolved.dialect,
        base_uri=resolved.base_uri,
        retrieve=resolved.retrieve,
        max_findings=request.max_findings,
        assert_formats=request.assert_formats,
    )
    return SchemaInstanceValidationResponse(
        ok=True,
        valid=result.valid,
        validated=result.validated,
        validator=result.validator,
        schema_ref=schema_ref,
        media_type=request.media_type,
        source=source.model_copy(update={"dialect": result.dialect}),
        findings=result.findings,
        total_findings=result.total_findings,
        truncated=result.truncated,
        diagnostics=[*resolved.diagnostics, *result.diagnostics],
    )


async def _validate_xml(
    schema_ref: str,
    request: SchemaInstanceValidationRequest,
    resolved: ResolvedSchema,
    source: SchemaSourceInfo,
) -> SchemaInstanceValidationResponse:
    """Run the XML path: guard, then dispatch through the external-linter adapter seam."""
    text = request.instance_text
    if not isinstance(text, str) or not text.strip():
        return _not_serviceable(
            schema_ref,
            request,
            source,
            "INPUT_EMPTY",
            "An XML instance must be sent as `instance_text`, and must not be empty.",
        )
    try:
        _guard_text(text)
    except _RequestFaultError as fault:
        return _not_serviceable(schema_ref, request, source, fault.code, str(fault))

    if not resolved.xml_schema_text:
        return _not_serviceable(
            schema_ref,
            request,
            source,
            "FORMAT_MISMATCH",
            "This reference does not resolve to an XML schema, so an XML payload cannot be "
            "checked against it. Send the instance as JSON (`media_type: application/json`), "
            "or reference an XSD- or WSDL-backed revision.",
        )

    result = await validate_xml_instance(
        resolved.xml_schema_text, text, max_findings=request.max_findings
    )
    return SchemaInstanceValidationResponse(
        ok=True,
        valid=result.valid,
        validated=result.validated,
        validator=result.validator,
        schema_ref=schema_ref,
        media_type=request.media_type,
        source=source.model_copy(update={"dialect": None}),
        findings=result.findings,
        total_findings=result.total_findings,
        truncated=result.truncated,
        diagnostics=[*resolved.diagnostics, *result.diagnostics],
    )


# ===========================================================================
# Instance intake
# ===========================================================================


class _RequestFaultError(Exception):
    """A payload-level fault that becomes a 200 with ``ok = false``, not an HTTP error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _json_instance(request: SchemaInstanceValidationRequest) -> Any:
    """Return the JSON value to validate, applying the intake guards on the way.

    Args:
        request: The incoming request.

    Returns:
        The parsed JSON instance.

    Raises:
        _RequestFaultError: When neither or both instance forms were supplied, when the text is not
            JSON, or when an intake guard trips.
    """
    supplied = request.model_fields_set
    has_value = "instance" in supplied
    has_text = "instance_text" in supplied and request.instance_text is not None
    if has_value and has_text:
        raise _RequestFaultError(
            "INPUT_SEMANTIC_INVALID",
            "Send either `instance` or `instance_text`, not both.",
        )
    if not has_value and not has_text:
        raise _RequestFaultError(
            "INPUT_EMPTY",
            "Send the payload to validate as either `instance` or `instance_text`.",
        )

    if has_value:
        # An already-parsed value skipped the text guards, so it is bounded here. Only *size*
        # needs the text form (serializing is the only way to measure what was really sent);
        # the alias-expansion guard has nothing to do — a value decoded from JSON carries no
        # aliases — and depth is checked exactly on the value itself just below.
        try:
            serialized = json.dumps(request.instance, default=str)
        except (TypeError, ValueError) as exc:
            raise _RequestFaultError(
                "INPUT_MALFORMED", f"The instance is not JSON-serializable: {exc}"
            ) from exc
        try:
            guard_document_size(serialized, source_label="instance")
        except IntakeLimitError as exc:
            raise _RequestFaultError(exc.code, str(exc)) from exc
        _guard_value(request.instance)
        return request.instance

    text = request.instance_text or ""
    _guard_text(text)
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise _RequestFaultError(
            "INPUT_MALFORMED", f"The instance text is not valid JSON: {exc}"
        ) from exc
    _guard_value(parsed)
    return parsed


def _guard_text(text: str) -> None:
    """Apply the pre-parse intake guards (size, alias expansion, depth) to raw payload text."""
    try:
        guard_document_text(text, source_label="instance")
    except IntakeLimitError as exc:
        raise _RequestFaultError(exc.code, str(exc)) from exc


def _guard_value(parsed: Any) -> None:
    """Apply the exact post-parse depth and cycle guard to a parsed payload."""
    try:
        guard_parsed_document(parsed, source_label="instance")
    except IntakeLimitError as exc:
        raise _RequestFaultError(exc.code, str(exc)) from exc


def _not_serviceable(
    schema_ref: str,
    request: SchemaInstanceValidationRequest,
    source: SchemaSourceInfo,
    code: str,
    message: str,
) -> SchemaInstanceValidationResponse:
    """Build the ``ok = false`` response: nothing was checked, and the code says why."""
    return SchemaInstanceValidationResponse(
        ok=False,
        valid=None,
        validated=False,
        validator=None,
        schema_ref=schema_ref,
        media_type=request.media_type,
        source=source,
        error=build_job_error(code, message),
    )
