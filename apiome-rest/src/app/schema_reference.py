"""Address a schema by stable reference and resolve it to a validatable document — IXH-5.1 (#5113).

``POST /v1/tenants/{slug}/schemas/{ref}/validate`` needs one addressing scheme that covers the
three places a schema can live in Apiome. This module defines that scheme and resolves it.

Reference grammar
-----------------
A reference is a ``/``-separated path whose **first segment names the kind**. It is carried in the
URL path, so it deliberately contains no ``#`` (a fragment never reaches the server) and no
percent-encoding requirements beyond ordinary path escaping::

    project/{project_slug}/{version}[/{type}]
    catalog/{item_slug_or_id}/{version}[/{type}]
    registry/{namespace}/…/{name}

* ``project`` — a **publishable** artifact (a Project). ``version`` is a source-declared version
  label (``1.0.0``), a revision UUID, or ``latest`` for the newest revision.
* ``catalog`` — a **non-publishable** artifact (a Catalog item), addressed by slug or id, with the
  same ``version`` rule. The Projects/Catalog split is enforced here, not merely echoed: a
  ``project/…`` reference will not resolve a catalog item and vice versa, so the two surfaces
  cannot be used to walk into each other's rows.
* ``registry`` — a type-registry primitive, addressed by everything after ``registry/``. That path
  is appended to :data:`app.schema_validation.REGISTRY_BASE_URL` to form the primitive's ``$id``,
  which is exactly how a relative ``$ref`` inside the registry resolves — so
  ``registry/std/v0/primitives/email`` is the same coordinate a schema would write as
  ``../primitives/email``.

``type`` is optional on ``project`` / ``catalog`` references. When given it names one canonical
type by its stable key (``acme.Pet``) or its source name (``Pet``). When omitted the reference
denotes the whole revision, which is what XML validation needs (an XSD grammar validates a
document, not a type) and which JSON validation accepts only when the revision defines exactly
one type — otherwise the caller is told which types it may name.

What a resolved reference carries
---------------------------------
For ``project`` / ``catalog`` the JSON schema is **projected from the canonical model**
(:mod:`app.canonical_json_schema`) rather than replayed from the captured source. That is the one
choice that behaves identically for all thirty-odd import formats — a Thrift revision and an
OpenAPI revision address their types the same way and validate under the same dialect. The price
is that a source constraint the canonical model does not carry is not enforced, and the price is
stated out loud: the projection's unmapped scalars and any ``$defs`` truncation come back as
diagnostics on the response.

For ``registry`` the primitive's stored JSON Schema is used **verbatim**, with its ``base_uri`` as
the resolution base and a tenant-scoped retriever wired for its relative ``$ref``s — so a registry
type composed of other registry types validates as its author wrote it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .canonical_json_schema import (
    CanonicalSchemaProjection,
    CanonicalTypeNotFoundError,
    build_type_json_schema,
    list_projectable_types,
)
from .canonical_model import CanonicalApi
from .catalog_conversion import build_conversion_source
from .conversion_job import ConversionError
from .database import db
from .export_source import ExportSourceError, resolve_revision_id
from .primitives_scope import resolve_registry_uri
from .revision_deprecation import is_uuid_string
from .schema_instance_validation import SchemaRetriever, ValidationDiagnostic
from .schema_validation import DRAFT_2020_12, REGISTRY_BASE_URL, derive_draft
from .xml_instance_validation import XML_SCHEMA_SOURCE_FORMATS

__all__ = [
    "KIND_CATALOG",
    "KIND_PROJECT",
    "KIND_REGISTRY",
    "SCHEMA_REFERENCE_KINDS",
    "LATEST_VERSION_TOKEN",
    "ResolvedSchema",
    "SchemaReference",
    "SchemaReferenceError",
    "parse_schema_reference",
    "resolve_schema_reference",
]

KIND_PROJECT = "project"
KIND_CATALOG = "catalog"
KIND_REGISTRY = "registry"

#: The three addressable kinds, in the order the API documentation lists them.
SCHEMA_REFERENCE_KINDS: Tuple[str, ...] = (KIND_PROJECT, KIND_CATALOG, KIND_REGISTRY)

#: ``version`` value meaning "the artifact's newest revision".
LATEST_VERSION_TOKEN = "latest"


class SchemaReferenceError(Exception):
    """A schema reference is malformed, or names something the caller cannot see.

    Attributes:
        status_code: HTTP status the route surfaces — ``400`` for a malformed reference,
            ``404`` for one that is well-formed but resolves to nothing visible, ``422`` for one
            that resolves to material no schema can be derived from.
        candidates: When a *type* segment missed, the type names the revision does offer, so the
            caller gets "did you mean" guidance instead of a bare miss.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 404,
        candidates: Optional[List[str]] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.candidates = candidates or []


@dataclass(frozen=True)
class SchemaReference:
    """A parsed, syntactically valid schema reference.

    Attributes:
        kind: One of :data:`SCHEMA_REFERENCE_KINDS`.
        artifact: Project/catalog slug or id (empty for a registry reference).
        version: Version label, revision UUID, or ``latest`` (empty for a registry reference).
        type_name: The named canonical type, or ``None`` for a whole-revision reference.
        registry_path: The registry path after ``registry/`` (empty for the other kinds).
        raw: The reference exactly as the caller wrote it, echoed back on the response.
    """

    kind: str
    raw: str
    artifact: str = ""
    version: str = ""
    type_name: Optional[str] = None
    registry_path: str = ""


@dataclass
class ResolvedSchema:
    """A schema reference resolved to something a validator can run against.

    Attributes:
        reference: The parsed reference.
        document: The JSON Schema to validate JSON instances against, or ``None`` when the
            reference resolves only to an XML grammar.
        dialect: JSON Schema dialect token the document is written in.
        base_uri: Absolute URI the document's relative ``$ref``s resolve against (``""`` when
            the document has no location).
        retrieve: Tenant-scoped resolver for external ``$ref``s, or ``None`` when the document
            is self-contained and nothing external should be resolvable.
        xml_schema_text: The XML-schema grammar backing this reference, when the source format
            is one, so XML instances can be validated. ``None`` otherwise.
        source_format: The import-source format key the schema derives from (``xsd``,
            ``openapi``, ``registry`` …), for display and for choosing the XML path.
        coordinates: Resolved coordinates echoed back to the caller (artifact id, revision id,
            version label, type key …), so a caller can confirm what was validated against.
        diagnostics: Conditions that limited the derivation — an unmapped canonical scalar, a
            truncated ``$defs`` set. Never failures of the instance.
    """

    reference: SchemaReference
    document: Optional[Dict[str, Any]] = None
    dialect: str = DRAFT_2020_12
    base_uri: str = ""
    retrieve: Optional[SchemaRetriever] = None
    xml_schema_text: Optional[str] = None
    source_format: Optional[str] = None
    coordinates: Dict[str, Any] = field(default_factory=dict)
    diagnostics: List[ValidationDiagnostic] = field(default_factory=list)


# ===========================================================================
# Parsing
# ===========================================================================


def parse_schema_reference(raw: str) -> SchemaReference:
    """Parse a reference string into a :class:`SchemaReference`.

    Args:
        raw: The reference exactly as it appeared in the URL path.

    Returns:
        The parsed reference.

    Raises:
        SchemaReferenceError: ``400`` when the reference names an unknown kind or has the
            wrong number of segments for its kind.
    """
    segments = [segment for segment in (raw or "").strip("/").split("/") if segment]
    if not segments:
        raise SchemaReferenceError(_grammar_help("A schema reference is required."), status_code=400)

    kind = segments[0]
    rest = segments[1:]
    if kind not in SCHEMA_REFERENCE_KINDS:
        raise SchemaReferenceError(
            _grammar_help(f"Unknown schema reference kind {kind!r}."), status_code=400
        )

    if kind == KIND_REGISTRY:
        if len(rest) < 2:
            raise SchemaReferenceError(
                _grammar_help(
                    "A registry reference needs at least a namespace and a type name, "
                    "for example `registry/std/v0/primitives/email`."
                ),
                status_code=400,
            )
        return SchemaReference(kind=kind, raw=raw, registry_path="/".join(rest))

    if len(rest) not in (2, 3):
        raise SchemaReferenceError(
            _grammar_help(
                f"A {kind} reference needs an artifact and a version, and may name a type, "
                f"for example `{kind}/petstore/1.0.0/Pet`."
            ),
            status_code=400,
        )
    return SchemaReference(
        kind=kind,
        raw=raw,
        artifact=rest[0],
        version=rest[1],
        type_name=rest[2] if len(rest) == 3 else None,
    )


def _grammar_help(problem: str) -> str:
    """Append the reference grammar to a parse complaint, so the caller can self-correct."""
    return (
        f"{problem} Supported forms: `project/{{project_slug}}/{{version}}[/{{type}}]`, "
        "`catalog/{item}/{version}[/{type}]`, `registry/{namespace}/{name}`. "
        "`{version}` is a version label, a revision id, or `latest`."
    )


# ===========================================================================
# Resolution
# ===========================================================================


def resolve_schema_reference(reference: SchemaReference, *, tenant_id: str) -> ResolvedSchema:
    """Resolve a parsed reference to a validatable schema, scoped to one tenant.

    Args:
        reference: The parsed reference.
        tenant_id: The caller's authenticated tenant. Every lookup is scoped by it, so a
            reference can never reach another tenant's artifact or private registry type.

    Returns:
        The :class:`ResolvedSchema`.

    Raises:
        SchemaReferenceError: When the reference names nothing visible (``404``), or names a
            revision from which no schema can be derived (``422``).
    """
    if reference.kind == KIND_REGISTRY:
        return _resolve_registry(reference, tenant_id=tenant_id)
    return _resolve_artifact(reference, tenant_id=tenant_id)


def _resolve_registry(reference: SchemaReference, *, tenant_id: str) -> ResolvedSchema:
    """Resolve a ``registry/…`` reference to a type-registry primitive's stored schema."""
    schema_id = REGISTRY_BASE_URL + reference.registry_path
    row = db.get_primitive_by_schema_id(schema_id, tenant_id)
    if not row:
        raise SchemaReferenceError(
            f"No registry type is visible at {reference.registry_path!r} "
            f"(resolved to {schema_id!r}).",
            status_code=404,
        )

    document = row.get("schema")
    if not isinstance(document, dict):
        raise SchemaReferenceError(
            f"Registry type {reference.registry_path!r} has no stored JSON Schema document.",
            status_code=422,
        )

    base_uri = row.get("base_uri") or schema_id
    return ResolvedSchema(
        reference=reference,
        document=document,
        dialect=row.get("draft") or derive_draft(document),
        base_uri=str(base_uri),
        retrieve=_registry_retriever(tenant_id),
        source_format="registry",
        coordinates={
            "kind": KIND_REGISTRY,
            "primitive_id": str(row.get("id")),
            "name": row.get("name"),
            "namespace": row.get("namespace"),
            "schema_id": schema_id,
        },
    )


def _registry_retriever(tenant_id: str) -> SchemaRetriever:
    """Build the tenant-scoped resolver for registry ``$ref`` targets.

    Only URIs under :data:`app.schema_validation.REGISTRY_BASE_URL` are looked up, and the
    lookup itself (:meth:`app.database.Database.get_primitive_by_schema_id`) is scoped to
    system-core ∪ this tenant. A ``$ref`` at any other host resolves to ``None`` and is reported
    as unresolvable — this function is the *only* way a document enters the validator's
    reference registry, so there is no path by which validation performs a network fetch.
    """

    def retrieve(uri: str) -> Optional[Dict[str, Any]]:
        if not resolve_registry_uri(uri, None):
            return None
        row = db.get_primitive_by_schema_id(uri, tenant_id)
        if not row:
            return None
        document = row.get("schema")
        return document if isinstance(document, dict) else None

    return retrieve


def _resolve_artifact(reference: SchemaReference, *, tenant_id: str) -> ResolvedSchema:
    """Resolve a ``project/…`` or ``catalog/…`` reference through the revision's captured source."""
    publishable = reference.kind == KIND_PROJECT
    artifact = _load_artifact(reference.artifact, tenant_id=tenant_id, publishable=publishable)
    artifact_id = str(artifact["id"])

    requested_version = (
        None if reference.version.strip().lower() == LATEST_VERSION_TOKEN else reference.version
    )
    try:
        revision_id = resolve_revision_id(tenant_id, artifact_id, requested_version)
    except ExportSourceError as exc:
        raise SchemaReferenceError(str(exc), status_code=exc.status_code) from exc

    projection = db.get_version_source_projection(revision_id, tenant_id)
    if projection is None or str(projection["id"]) != artifact_id:
        raise SchemaReferenceError(
            f"Version {reference.version!r} was not found for {reference.kind} "
            f"{reference.artifact!r}.",
            status_code=404,
        )

    item: Dict[str, Any] = {
        "id": artifact_id,
        "slug": projection.get("project_slug"),
        "source_format": projection.get("source_format"),
        "protocol": projection.get("protocol"),
        "format_metadata": projection.get("format_metadata"),
        "tool_versions": projection.get("tool_versions"),
        "metadata": projection.get("metadata"),
    }
    try:
        source = build_conversion_source(item, source_version_id=revision_id)
    except ConversionError as exc:
        raise SchemaReferenceError(str(exc), status_code=exc.status_code) from exc

    source_format = source.source_format or projection.get("source_format")
    coordinates: Dict[str, Any] = {
        "kind": reference.kind,
        "artifact_id": artifact_id,
        "artifact_slug": projection.get("project_slug") or artifact.get("slug"),
        "revision_id": revision_id,
        "version_label": projection.get("version_label"),
        "source_format": source_format,
    }

    xml_schema_text = (
        source.source_text
        if (source_format or "").lower() in XML_SCHEMA_SOURCE_FORMATS
        else None
    )

    document, dialect, diagnostics = _project_document(
        source.api, reference, coordinates, has_xml_grammar=xml_schema_text is not None
    )
    return ResolvedSchema(
        reference=reference,
        document=document,
        dialect=dialect,
        base_uri="",
        retrieve=None,
        xml_schema_text=xml_schema_text,
        source_format=source_format,
        coordinates=coordinates,
        diagnostics=diagnostics,
    )


def _load_artifact(
    identifier: str, *, tenant_id: str, publishable: bool
) -> Dict[str, Any]:
    """Load a project (``publishable``) or catalog item by slug or id, scoped to the tenant.

    Args:
        identifier: The artifact's slug or its UUID.
        tenant_id: The caller's tenant.
        publishable: ``True`` to accept only Projects, ``False`` to accept only Catalog items.
            The flag is checked rather than assumed, which is what keeps a ``project/…``
            reference from reaching a catalog row and vice versa.

    Returns:
        The artifact row.

    Raises:
        SchemaReferenceError: ``404`` when nothing visible matches.
    """
    kind = KIND_PROJECT if publishable else KIND_CATALOG
    row: Optional[Dict[str, Any]] = None
    # ``is_uuid_string`` first: the id lookups bind a ``uuid`` parameter, and handing them a
    # slug would raise a database error rather than simply missing.
    if is_uuid_string(identifier):
        row = (
            db.get_project_by_id(identifier, tenant_id)
            if publishable
            else db.get_catalog_item_by_id(identifier, tenant_id)
        )
    if row is None:
        row = db.get_project_by_slug(identifier, tenant_id)
    if row is None or bool(row.get("publishable")) is not publishable:
        raise SchemaReferenceError(
            f"No {kind} named {identifier!r} is visible in this tenant.", status_code=404
        )
    return row


def _project_document(
    api: CanonicalApi,
    reference: SchemaReference,
    coordinates: Dict[str, Any],
    *,
    has_xml_grammar: bool,
) -> Tuple[Optional[Dict[str, Any]], str, List[ValidationDiagnostic]]:
    """Project the revision's canonical model into the JSON Schema the reference denotes.

    Args:
        api: The rebuilt canonical model.
        reference: The parsed reference (its ``type_name`` selects the type).
        coordinates: Mutated in place with the resolved type key/name when one is selected.
        has_xml_grammar: Whether an XML grammar is also available. When it is, a
            whole-revision reference that cannot pick a single JSON root is *not* an error —
            the reference is still usable for XML instances.

    Returns:
        ``(document, dialect, diagnostics)``. ``document`` is ``None`` only when no JSON root
        could be chosen and an XML grammar covers the reference instead.

    Raises:
        SchemaReferenceError: ``404`` when a named type does not exist; ``422`` when a
            whole-revision reference is ambiguous and no XML grammar covers it.
    """
    type_name = reference.type_name
    if type_name is None:
        if len(api.types) == 1:
            type_name = api.types[0].key
        elif has_xml_grammar:
            # An XSD-backed reference validates whole documents; there is no JSON root to pick.
            return None, DRAFT_2020_12, []
        else:
            candidates = list_projectable_types(api)
            raise SchemaReferenceError(
                f"This revision defines {len(api.types)} types, so the reference must name "
                "one, for example "
                f"`{reference.kind}/{reference.artifact}/{reference.version}/"
                f"{candidates[0] if candidates else 'TypeName'}`.",
                status_code=422,
                candidates=candidates,
            )

    try:
        projection: CanonicalSchemaProjection = build_type_json_schema(api, type_name)
    except CanonicalTypeNotFoundError as exc:
        raise SchemaReferenceError(
            str(exc), status_code=404, candidates=exc.candidates
        ) from exc

    coordinates["type_key"] = projection.type_key
    coordinates["type_name"] = projection.type_name
    return projection.document, projection.dialect, _projection_diagnostics(projection)


def _projection_diagnostics(
    projection: CanonicalSchemaProjection,
) -> List[ValidationDiagnostic]:
    """Turn a projection's honesty metadata into diagnostics the API surfaces."""
    diagnostics: List[ValidationDiagnostic] = []
    if projection.unmapped_scalars:
        names = ", ".join(projection.unmapped_scalars)
        diagnostics.append(
            ValidationDiagnostic(
                code="INPUT_SEMANTIC_INVALID",
                message=(
                    "These source scalar types have no JSON Schema equivalent and therefore "
                    f"constrain nothing in this validation: {names}. Values at those positions "
                    "are accepted whatever they hold."
                ),
            )
        )
    if projection.truncated:
        diagnostics.append(
            ValidationDiagnostic(
                code="INPUT_EXPANSION_LIMIT",
                message=(
                    "This type reaches more referenced types than one validation document may "
                    "hold, so the deepest ones were left out and their references are reported "
                    "as unresolved rather than silently ignored."
                ),
            )
        )
    return diagnostics
