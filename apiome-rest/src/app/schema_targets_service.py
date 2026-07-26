"""List the schemas a revision offers for testing — IXH-5.3 (#5115).

The Schema Test Bench UI lets a user pick a schema from a catalog item or project version and
validate payloads against it (IXH-5.1) or generate payloads from it (IXH-5.2). Both of those
endpoints *address* one schema; neither *enumerates* what a revision offers. This module answers
that question for a whole revision:

* **types** — every named canonical type, addressable as ``{ref}/{type_key}`` (or source name);
* **operation_bodies** — every operation request/response message whose payload resolves to a
  named type, so "the request body of ``POST /orders``" can be picked and validated against the
  very type it references.

The reference grammar is the IXH-5.1 one *without* the trailing type segment —
``project/{slug}/{version}`` or ``catalog/{item}/{version}`` — because the targets of a revision
are exactly what the trailing segment selects from. A ``registry/…`` reference is rejected: a
registry type is a single stored schema, already enumerated by the type-registry API.

Everything here is a read: nothing is persisted, and the listing is deterministic (types sorted
by key; operation bodies by operation key, then role, then status code) so two calls over the
same revision are byte-identical.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi, MessageRole, Operation, Type, TypeRef
from .schema_instance_service import SchemaSourceInfo
from .schema_instance_validation import ValidationDiagnostic
from .schema_reference import (
    SchemaReferenceError,
    parse_schema_reference,
    resolve_revision_model,
)

__all__ = [
    "SchemaOperationBodyTarget",
    "SchemaTargetType",
    "SchemaTargetsResponse",
    "list_schema_targets",
]

#: The message roles that count as an "operation body" a payload can be tested against.
#: Errors/events are payloads too, but the Test Bench scope (IXH-5.3) is request/response.
_BODY_ROLES = (MessageRole.REQUEST, MessageRole.RESPONSE)


class SchemaTargetType(BaseModel):
    """One named type a revision defines, addressable as a validation target."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="Stable canonical key (``acme.Pet``) — the preferred address.")
    name: str = Field(description="Source type name (``Pet``).")
    kind: str = Field(description="Structural family — ``object``, ``enum``, ``union`` …")


class SchemaOperationBodyTarget(BaseModel):
    """One operation request/response body that resolves to a named, addressable type."""

    model_config = ConfigDict(extra="forbid")

    operation_key: str = Field(description="Stable operation key (``GET /pets/{id}``).")
    operation_name: str = Field(description="Source operation name.")
    http_method: Optional[str] = Field(
        default=None, description="HTTP verb, when the paradigm has one."
    )
    http_path: Optional[str] = Field(
        default=None, description="Route template, when the paradigm has one."
    )
    role: str = Field(description="``request`` or ``response``.")
    status_code: Optional[str] = Field(
        default=None, description="Response status code (``200``, ``4XX``), when declared."
    )
    type_key: str = Field(description="Canonical key of the type the body resolves to.")
    type_name: str = Field(description="Source name of the type the body resolves to.")
    list_wrapped: bool = Field(
        default=False,
        description=(
            "Whether the body is a *list of* the named type. The addressable schema is the "
            "element type; a payload for the operation itself would be an array of it."
        ),
    )


class SchemaTargetsResponse(BaseModel):
    """Everything one revision offers the Test Bench to validate against."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Always ``true``: a resolvable revision always enumerates.")
    schema_ref: str = Field(description="The reference exactly as it was requested.")
    source: SchemaSourceInfo = Field(description="What the reference resolved to.")
    types: List[SchemaTargetType] = Field(
        default_factory=list, description="Named types, sorted by key."
    )
    operation_bodies: List[SchemaOperationBodyTarget] = Field(
        default_factory=list,
        description=(
            "Request/response bodies that resolve to a named type, sorted by operation key, "
            "role, then status code."
        ),
    )
    xml_document: bool = Field(
        default=False,
        description=(
            "Whether the revision is backed by an XML grammar, so the bare (type-less) "
            "reference validates whole XML documents."
        ),
    )
    diagnostics: List[ValidationDiagnostic] = Field(
        default_factory=list,
        description=(
            "Conditions that limited the listing — e.g. bodies defined inline rather than as "
            "named types, which the reference grammar cannot address. Never an error."
        ),
    )


def _leaf_ref(ref: Optional[TypeRef]) -> tuple[Optional[str], bool]:
    """Unwrap list nesting on a payload reference to its leaf type name.

    Args:
        ref: The payload reference, possibly ``None`` or list-wrapped (``[Pet]``).

    Returns:
        ``(leaf_name, list_wrapped)`` — the referenced name (``None`` when the ref is absent
        or nameless) and whether any list wrapper was unwrapped on the way.
    """
    wrapped = False
    while ref is not None and ref.item is not None:
        wrapped = True
        ref = ref.item
    if ref is None or not ref.name:
        return None, wrapped
    return ref.name, wrapped


def _type_lookup(api: CanonicalApi) -> Dict[str, Type]:
    """Index a model's types by stable key and by *unambiguous* source name.

    A payload ``TypeRef`` may carry either coordinate. Keys are authoritative; a source name
    is only usable when exactly one type bears it — an ambiguous name is left out, matching
    how ``build_type_json_schema`` refuses to resolve one arbitrarily.
    """
    by_key: Dict[str, Type] = {t.key: t for t in api.types if t.key}
    name_counts: Dict[str, int] = {}
    for type_ in api.types:
        if type_.name:
            name_counts[type_.name] = name_counts.get(type_.name, 0) + 1
    lookup = dict(by_key)
    for type_ in api.types:
        if type_.name and name_counts[type_.name] == 1 and type_.name not in lookup:
            lookup[type_.name] = type_
    return lookup


def _operation_bodies(
    operations: List[Operation], lookup: Dict[str, Type]
) -> tuple[List[SchemaOperationBodyTarget], int]:
    """Collect the request/response bodies that resolve to a named type.

    Args:
        operations: Every operation of the revision, in declaration order.
        lookup: The key/unambiguous-name type index from :func:`_type_lookup`.

    Returns:
        ``(targets, unaddressable)`` — the resolvable body targets, and how many bodies were
        skipped because their payload is inline, primitive, or ambiguous by name (reported as
        a diagnostic, never silently dropped).
    """
    targets: List[SchemaOperationBodyTarget] = []
    unaddressable = 0
    for operation in operations:
        for message in operation.messages:
            if message.role not in _BODY_ROLES:
                continue
            leaf, list_wrapped = _leaf_ref(message.payload)
            resolved = lookup.get(leaf) if leaf else None
            if resolved is None:
                # Inline payload_schema-only bodies and primitive/ambiguous refs cannot be
                # addressed by the {ref}/{type} grammar; counted, not invented.
                if message.payload is not None or message.payload_schema is not None:
                    unaddressable += 1
                continue
            targets.append(
                SchemaOperationBodyTarget(
                    operation_key=operation.key,
                    operation_name=operation.name,
                    http_method=operation.http_method,
                    http_path=operation.http_path,
                    role=message.role.value,
                    status_code=message.status_code,
                    type_key=resolved.key,
                    type_name=resolved.name,
                    list_wrapped=list_wrapped,
                )
            )
    targets.sort(key=lambda t: (t.operation_key, t.role, t.status_code or ""))
    return targets, unaddressable


def list_schema_targets(schema_ref: str, *, tenant_id: str) -> SchemaTargetsResponse:
    """List every schema target a revision offers.

    Args:
        schema_ref: A ``project/{slug}/{version}`` or ``catalog/{item}/{version}`` reference —
            the IXH-5.1 grammar without a type segment.
        tenant_id: The caller's authenticated tenant.

    Returns:
        The deterministic targets listing.

    Raises:
        SchemaReferenceError: ``400`` for a malformed, ``registry/…``, or type-qualified
            reference; ``404``/``422`` exactly as revision resolution reports them.
    """
    reference = parse_schema_reference(schema_ref)
    if reference.type_name is not None:
        raise SchemaReferenceError(
            "A targets listing enumerates a whole revision; drop the trailing type segment "
            f"(use `{reference.kind}/{reference.artifact}/{reference.version}`).",
            status_code=400,
        )

    revision = resolve_revision_model(reference, tenant_id=tenant_id)
    api = revision.api

    types = sorted(
        (
            SchemaTargetType(key=t.key, name=t.name, kind=t.kind.value)
            for t in api.types
            if t.key
        ),
        key=lambda t: t.key,
    )

    operations = api.operations()
    bodies, unaddressable = _operation_bodies(operations, _type_lookup(api))

    diagnostics: List[ValidationDiagnostic] = []
    if unaddressable:
        diagnostics.append(
            ValidationDiagnostic(
                code="INPUT_SEMANTIC_INVALID",
                message=(
                    f"{unaddressable} operation bod"
                    f"{'y is' if unaddressable == 1 else 'ies are'} defined inline or "
                    "reference no single named type, so they cannot be addressed as a "
                    "validation target. Validate against the named component types instead."
                ),
            )
        )

    return SchemaTargetsResponse(
        ok=True,
        schema_ref=schema_ref,
        source=SchemaSourceInfo(
            kind=reference.kind,
            source_format=revision.source_format,
            dialect=None,
            projected=True,
            coordinates=revision.coordinates,
        ),
        types=types,
        operation_bodies=bodies,
        xml_document=revision.xml_schema_text is not None,
        diagnostics=diagnostics,
    )
