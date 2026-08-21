"""OData CSDL / EDMX parser — MFI-22.1, v2/v3 support added by FMT-3.4 (#5429).

Parses OData ``.edmx`` / CSDL XML into a typed :class:`ODataDocument` AST using the stdlib
:mod:`xml.etree.ElementTree` (no external OData toolchain). Syntax errors surface as
:class:`ODataParseError`.

Three CSDL generations are read. The dialect is decided by namespace
(:mod:`app.odata_csdl_versions`), and below v4 the ``Association``/``AssociationSet``
relationship model is projected onto v4-shaped navigation properties
(:mod:`app.odata_associations`) so that everything downstream sees one relationship shape.
Constructs with no v4 analogue — customizable feeds (``m:FC_TargetPath``), ``m:HasStream``,
SAP's ``sap:*`` annotations, ``FunctionImport`` parameter lists, the association
declarations themselves — are carried in ``annotations`` and in the association model
rather than dropped.

**v4 documents parse exactly as they did before FMT-3.4.** Every construct added here is
reached only when :func:`~app.odata_csdl_versions.uses_association_model` says the document
predates v4, which is what keeps the v4 canonical goldens byte-identical.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, replace
from typing import Dict, List, Mapping, NoReturn, Optional, Sequence, Tuple

from .odata_associations import (
    ODataAssociation,
    ODataAssociationEnd,
    ODataAssociationSet,
    ODataAssociationSetEnd,
    ODataReferentialConstraint,
    ODataUnresolvedRelationshipError,
    association_index,
    navigation_type_expr,
    resolve_target_end,
)
from .odata_csdl_versions import (
    ODATA_METADATA_NS,
    ODataDialect,
    annotation_key,
    resolve_dialect,
    uses_association_model,
)
from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "ODataParseError",
    "ODataProperty",
    "ODataNavigationProperty",
    "ODataEntityType",
    "ODataEntitySet",
    "ODataEnumMember",
    "ODataEnumType",
    "ODataComplexType",
    "ODataFunctionImportParameter",
    "ODataFunctionImport",
    "ODataEntityContainer",
    "ODataReference",
    "ODataSchema",
    "ODataDocument",
    "is_odata",
    "parse_odata",
]

#: Attributes handled as structure rather than as annotations, per element local name.
#: Everything else that carries a namespace is preserved verbatim in ``annotations``.
_STRUCTURAL_ATTRIBUTES: Mapping[str, frozenset] = {
    "Property": frozenset({"Name", "Type", "Nullable"}),
    "NavigationProperty": frozenset(
        {"Name", "Type", "Partner", "Relationship", "FromRole", "ToRole"}
    ),
    "EntityType": frozenset({"Name"}),
    "ComplexType": frozenset({"Name"}),
    "EntitySet": frozenset({"Name", "EntityType"}),
    "EntityContainer": frozenset({"Name"}),
    "Association": frozenset({"Name"}),
    "AssociationSet": frozenset({"Name", "Association"}),
    "FunctionImport": frozenset({"Name", "ReturnType", "EntitySet"}),
    "Parameter": frozenset({"Name", "Type", "Mode", "Nullable"}),
    "Schema": frozenset({"Namespace", "Alias"}),
}


class ODataParseError(ValueError):
    """Raised when OData CSDL / EDMX text cannot be parsed.

    Attributes:
        code: The intake taxonomy code the adapter should report, or ``None`` to let the
            import pipeline classify the failure (which yields ``INPUT_MALFORMED``).
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ODataProperty:
    """A structural property of an entity or complex type.

    Attributes:
        name: The property name.
        type_expr: The declared EDM type expression, e.g. ``Edm.String``.
        nullable: The declared ``Nullable``, or ``None`` when unstated.
        annotations: Namespaced attributes with no canonical home — the v2/v3
            ``m:FC_TargetPath`` / ``m:FC_ContentKind`` / ``m:FC_KeepInContent`` customizable
            feed mapping and SAP's ``sap:label`` / ``sap:semantics`` / ``sap:unit``.
    """

    name: str
    type_expr: str
    nullable: Optional[bool] = None
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataNavigationProperty:
    """A relationship traversal declared on an entity type.

    v4 states the target directly (``type_expr``/``partner``). v2 and v3 instead name an
    association and the roles they travel between; those three fields are filled from the
    document and ``type_expr``/``partner``/``multiplicity`` are then derived from the
    association by :func:`~app.odata_associations.project_navigation_properties`, so both
    generations reach the normalizer in the same shape.
    """

    name: str
    type_expr: Optional[str] = None
    partner: Optional[str] = None
    relationship: Optional[str] = None
    from_role: Optional[str] = None
    to_role: Optional[str] = None
    multiplicity: Optional[str] = None
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataEntityType:
    """An addressable entity type: a key, structural properties, relationships."""

    name: str
    namespace: str
    key_properties: Tuple[str, ...]
    properties: Tuple[ODataProperty, ...]
    navigation_properties: Tuple[ODataNavigationProperty, ...]
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataEntitySet:
    """A container-level collection of one entity type."""

    name: str
    entity_type: str
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataEnumMember:
    name: str
    value: Optional[int] = None


@dataclass(frozen=True)
class ODataEnumType:
    name: str
    namespace: str
    members: Tuple[ODataEnumMember, ...]


@dataclass(frozen=True)
class ODataComplexType:
    """A structured type with no key, usable as a property type."""

    name: str
    namespace: str
    properties: Tuple[ODataProperty, ...]
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataFunctionImportParameter:
    """One ``<Parameter>`` of a v2/v3 ``<FunctionImport>``."""

    name: str
    type_expr: Optional[str] = None
    mode: Optional[str] = None
    nullable: Optional[bool] = None


@dataclass(frozen=True)
class ODataFunctionImport:
    """A v2/v3 service operation declared inside the entity container.

    v4 moved the signature onto a schema-level ``<Function>``/``<Action>`` and left only a
    binding in the container. The v2/v3 form carries its whole signature inline, which is
    why it is modelled here rather than reusing the v4 shape.
    """

    name: str
    return_type: Optional[str] = None
    entity_set: Optional[str] = None
    parameters: Tuple[ODataFunctionImportParameter, ...] = ()
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataEntityContainer:
    """The service surface: entity sets, plus the v2/v3 association sets and function imports."""

    name: str
    entity_sets: Tuple[ODataEntitySet, ...]
    association_sets: Tuple[ODataAssociationSet, ...] = ()
    function_imports: Tuple[ODataFunctionImport, ...] = ()
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataReference:
    """An ``<edmx:Reference>`` pulling schemas in from another document.

    Attributes:
        uri: The referenced document's URI as written.
        includes: ``(namespace, alias)`` pairs the reference brings into scope.
        resolved: Whether a fileset member answered ``uri`` and its schemas were merged.
    """

    uri: str
    includes: Tuple[Tuple[str, Optional[str]], ...] = ()
    resolved: bool = False


@dataclass(frozen=True)
class ODataSchema:
    """One ``<Schema>``: a namespace and everything declared in it."""

    namespace: str
    entity_types: Tuple[ODataEntityType, ...]
    complex_types: Tuple[ODataComplexType, ...]
    enum_types: Tuple[ODataEnumType, ...]
    entity_container: Optional[ODataEntityContainer]
    associations: Tuple[ODataAssociation, ...] = ()
    annotations: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ODataDocument:
    """A parsed CSDL/EDMX document.

    Attributes:
        version: The CSDL version resolved from the document's namespaces — ``"2.0"``,
            ``"3.0"``, ``"4.0"``. This is the version the canonical model records.
        schemas: The document's schemas, followed by any merged in through a reference.
        raw: The source text, kept for store-raw import.
        dialect: The full version evidence (namespaces, ``Version`` attribute,
            ``m:DataServiceVersion``) the version was resolved from.
        references: The ``<edmx:Reference>`` declarations and whether each resolved.
    """

    version: str
    schemas: Tuple[ODataSchema, ...]
    raw: str
    dialect: Optional[ODataDialect] = None
    references: Tuple[ODataReference, ...] = ()


def is_odata(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an OData EDMX / CSDL document."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<wsdl:definitions" in trimmed or "schemas.xmlsoap.org/wsdl" in trimmed:
        return False
    if "<edmx:Edmx" in trimmed:
        return True
    if "<Edmx" in trimmed and "docs.oasis-open.org/odata" in trimmed:
        return True
    return False


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _namespace_of(tag: str) -> Optional[str]:
    """The namespace URI of an ElementTree tag, or ``None`` when it carries none."""
    if not tag.startswith("{"):
        return None
    return tag[1:].partition("}")[0] or None


def _children(element: ET.Element, local_name: str) -> List[ET.Element]:
    return [child for child in element if _local(child.tag) == local_name]


def _nullable(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    return None


def _annotations(element: ET.Element) -> Tuple[Tuple[str, str], ...]:
    """Every attribute of ``element`` the AST has no structural home for.

    Namespaced attributes (``m:``, ``sap:``, ``xml:``) and unrecognized unprefixed ones are
    returned as ordered ``(key, value)`` pairs so they can be carried into the canonical
    model's ``extras`` rather than discarded — the FMT-3.4 requirement for constructs with
    no v4 analogue.

    Args:
        element: The CSDL element.

    Returns:
        The annotation pairs, in document order.
    """
    structural = _STRUCTURAL_ATTRIBUTES.get(_local(element.tag), frozenset())
    return tuple(
        (annotation_key(name), value)
        for name, value in element.attrib.items()
        if name not in structural
    )


def _parse_properties(parent: ET.Element, *, legacy: bool) -> Tuple[ODataProperty, ...]:
    """Parse ``<Property>`` children.

    Args:
        parent: The entity or complex type element.
        legacy: Whether the document predates v4, in which case namespaced attributes are
            captured as annotations.

    Returns:
        The properties, in document order. A property with no name or no type is skipped —
        it cannot be projected onto a canonical field.
    """
    properties: List[ODataProperty] = []
    for prop in _children(parent, "Property"):
        name = prop.get("Name")
        type_expr = prop.get("Type")
        if not name or not type_expr:
            continue
        properties.append(
            ODataProperty(
                name=name,
                type_expr=type_expr,
                nullable=_nullable(prop.get("Nullable")),
                annotations=_annotations(prop) if legacy else (),
            )
        )
    return tuple(properties)


def _parse_navigation_properties(
    parent: ET.Element, *, legacy: bool
) -> Tuple[ODataNavigationProperty, ...]:
    """Parse ``<NavigationProperty>`` children in whichever generation's spelling.

    A v4 property carries ``Type`` and is kept as-is. A v2/v3 property carries
    ``Relationship``/``FromRole``/``ToRole`` and no type; it is recorded unresolved here and
    filled in by :func:`~app.odata_associations.project_navigation_properties` once every
    association in the document is known.

    Args:
        parent: The entity type element.
        legacy: Whether the document predates v4.

    Returns:
        The navigation properties, in document order.
    """
    navigation: List[ODataNavigationProperty] = []
    for prop in _children(parent, "NavigationProperty"):
        name = prop.get("Name")
        if not name:
            continue
        type_expr = prop.get("Type")
        relationship = prop.get("Relationship")
        if not type_expr and not relationship:
            continue
        navigation.append(
            ODataNavigationProperty(
                name=name,
                type_expr=type_expr,
                partner=prop.get("Partner"),
                relationship=relationship,
                from_role=prop.get("FromRole"),
                to_role=prop.get("ToRole"),
                annotations=_annotations(prop) if legacy else (),
            )
        )
    return tuple(navigation)


def _parse_entity_types(
    schema: ET.Element, namespace: str, *, legacy: bool
) -> Tuple[ODataEntityType, ...]:
    entity_types: List[ODataEntityType] = []
    for entity in _children(schema, "EntityType"):
        name = entity.get("Name")
        if not name:
            continue
        key_properties: List[str] = []
        for key_el in _children(entity, "Key"):
            for prop_ref in _children(key_el, "PropertyRef"):
                ref_name = prop_ref.get("Name")
                if ref_name:
                    key_properties.append(ref_name)
        entity_types.append(
            ODataEntityType(
                name=name,
                namespace=namespace,
                key_properties=tuple(key_properties),
                properties=_parse_properties(entity, legacy=legacy),
                navigation_properties=_parse_navigation_properties(entity, legacy=legacy),
                annotations=_annotations(entity) if legacy else (),
            )
        )
    return tuple(entity_types)


def _parse_complex_types(
    schema: ET.Element, namespace: str, *, legacy: bool
) -> Tuple[ODataComplexType, ...]:
    complex_types: List[ODataComplexType] = []
    for complex_type in _children(schema, "ComplexType"):
        name = complex_type.get("Name")
        if not name:
            continue
        complex_types.append(
            ODataComplexType(
                name=name,
                namespace=namespace,
                properties=_parse_properties(complex_type, legacy=legacy),
                annotations=_annotations(complex_type) if legacy else (),
            )
        )
    return tuple(complex_types)


def _parse_enum_types(schema: ET.Element, namespace: str) -> Tuple[ODataEnumType, ...]:
    enum_types: List[ODataEnumType] = []
    for enum_type in _children(schema, "EnumType"):
        name = enum_type.get("Name")
        if not name:
            continue
        members: List[ODataEnumMember] = []
        for member in _children(enum_type, "Member"):
            member_name = member.get("Name")
            if not member_name:
                continue
            raw_value = member.get("Value")
            value: Optional[int] = None
            if raw_value is not None:
                try:
                    value = int(raw_value, 0)
                except ValueError:
                    value = None
            members.append(ODataEnumMember(name=member_name, value=value))
        enum_types.append(ODataEnumType(name=name, namespace=namespace, members=tuple(members)))
    return tuple(enum_types)


def _property_refs(parent: ET.Element, local_name: str) -> Tuple[str, Tuple[str, ...]]:
    """Read a ``<Principal>``/``<Dependent>`` element: its role and its property refs."""
    for element in _children(parent, local_name):
        names = tuple(
            ref.get("Name", "") for ref in _children(element, "PropertyRef") if ref.get("Name")
        )
        return element.get("Role", ""), names
    return "", ()


def _parse_associations(schema: ET.Element, namespace: str) -> Tuple[ODataAssociation, ...]:
    """Parse the v2/v3 ``<Association>`` declarations of one schema.

    An association with fewer than two ends is skipped: it names no traversable
    relationship, and keeping it would only let a navigation property resolve to nothing.
    """
    associations: List[ODataAssociation] = []
    for association in _children(schema, "Association"):
        name = association.get("Name")
        if not name:
            continue
        ends = tuple(
            ODataAssociationEnd(
                role=end.get("Role", ""),
                type_expr=end.get("Type", ""),
                multiplicity=end.get("Multiplicity"),
            )
            for end in _children(association, "End")
            if end.get("Type")
        )
        if len(ends) < 2:
            continue
        constraints: List[ODataReferentialConstraint] = []
        for constraint in _children(association, "ReferentialConstraint"):
            principal_role, principal_properties = _property_refs(constraint, "Principal")
            dependent_role, dependent_properties = _property_refs(constraint, "Dependent")
            constraints.append(
                ODataReferentialConstraint(
                    principal_role=principal_role,
                    principal_properties=principal_properties,
                    dependent_role=dependent_role,
                    dependent_properties=dependent_properties,
                )
            )
        associations.append(
            ODataAssociation(
                name=name,
                namespace=namespace,
                ends=ends,
                referential_constraints=tuple(constraints),
                annotations=_annotations(association),
            )
        )
    return tuple(associations)


def _parse_association_sets(container: ET.Element) -> Tuple[ODataAssociationSet, ...]:
    """Parse the v2/v3 ``<AssociationSet>`` bindings of one entity container."""
    association_sets: List[ODataAssociationSet] = []
    for association_set in _children(container, "AssociationSet"):
        name = association_set.get("Name")
        association = association_set.get("Association")
        if not name or not association:
            continue
        association_sets.append(
            ODataAssociationSet(
                name=name,
                association=association,
                ends=tuple(
                    ODataAssociationSetEnd(
                        role=end.get("Role", ""), entity_set=end.get("EntitySet", "")
                    )
                    for end in _children(association_set, "End")
                    if end.get("EntitySet")
                ),
                annotations=_annotations(association_set),
            )
        )
    return tuple(association_sets)


def _parse_function_imports(container: ET.Element) -> Tuple[ODataFunctionImport, ...]:
    """Parse the v2/v3 ``<FunctionImport>`` declarations of one entity container.

    Only reached for pre-v4 documents: a v4 ``<FunctionImport>`` is a binding onto a
    schema-level ``<Function>`` and carries no signature of its own, so parsing it here
    would record an empty shell and change what a v4 import produces.
    """
    function_imports: List[ODataFunctionImport] = []
    for function_import in _children(container, "FunctionImport"):
        name = function_import.get("Name")
        if not name:
            continue
        function_imports.append(
            ODataFunctionImport(
                name=name,
                return_type=function_import.get("ReturnType"),
                entity_set=function_import.get("EntitySet"),
                parameters=tuple(
                    ODataFunctionImportParameter(
                        name=parameter.get("Name", ""),
                        type_expr=parameter.get("Type"),
                        mode=parameter.get("Mode"),
                        nullable=_nullable(parameter.get("Nullable")),
                    )
                    for parameter in _children(function_import, "Parameter")
                    if parameter.get("Name")
                ),
                annotations=_annotations(function_import),
            )
        )
    return tuple(function_imports)


def _parse_entity_container(
    schema: ET.Element, *, legacy: bool
) -> Optional[ODataEntityContainer]:
    for container in _children(schema, "EntityContainer"):
        name = container.get("Name")
        if not name:
            continue
        entity_sets: List[ODataEntitySet] = []
        for entity_set in _children(container, "EntitySet"):
            set_name = entity_set.get("Name")
            entity_type = entity_set.get("EntityType")
            if set_name and entity_type:
                entity_sets.append(
                    ODataEntitySet(
                        name=set_name,
                        entity_type=entity_type,
                        annotations=_annotations(entity_set) if legacy else (),
                    )
                )
        return ODataEntityContainer(
            name=name,
            entity_sets=tuple(entity_sets),
            association_sets=_parse_association_sets(container) if legacy else (),
            function_imports=_parse_function_imports(container) if legacy else (),
            annotations=_annotations(container) if legacy else (),
        )
    return None


def _parse_schema(schema: ET.Element, *, legacy: bool) -> Optional[ODataSchema]:
    namespace = schema.get("Namespace")
    if not namespace:
        return None
    return ODataSchema(
        namespace=namespace,
        entity_types=_parse_entity_types(schema, namespace, legacy=legacy),
        complex_types=_parse_complex_types(schema, namespace, legacy=legacy),
        enum_types=_parse_enum_types(schema, namespace),
        entity_container=_parse_entity_container(schema, legacy=legacy),
        associations=_parse_associations(schema, namespace) if legacy else (),
        annotations=_annotations(schema) if legacy else (),
    )


def _parse_references(root: ET.Element) -> Tuple[Tuple[str, Tuple[Tuple[str, Optional[str]], ...]], ...]:
    """Read the ``<edmx:Reference>`` declarations of a document root."""
    references: List[Tuple[str, Tuple[Tuple[str, Optional[str]], ...]]] = []
    for reference in _children(root, "Reference"):
        uri = reference.get("Uri")
        if not uri:
            continue
        includes = tuple(
            (include.get("Namespace", ""), include.get("Alias"))
            for include in _children(reference, "Include")
            if include.get("Namespace")
        )
        references.append((uri, includes))
    return tuple(references)


def _data_service_version(root: ET.Element) -> Optional[str]:
    """The ``m:DataServiceVersion`` a pre-v4 service advertises on ``<edmx:DataServices>``."""
    for data_services in _children(root, "DataServices"):
        value = data_services.get(f"{{{ODATA_METADATA_NS}}}DataServiceVersion")
        if value:
            return value
    return None


def _schema_elements(root: ET.Element) -> List[ET.Element]:
    """Every ``<Schema>`` element under the document's ``<edmx:DataServices>``."""
    return [
        schema
        for data_services in _children(root, "DataServices")
        for schema in _children(data_services, "Schema")
    ]


def _parse_root(content: str, *, source_label: Optional[str]) -> ET.Element:
    """Securely parse ``content`` and assert it is an EDMX document root."""
    try:
        root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            label = f" ({source_label})" if source_label else ""
            raise ODataParseError(f"Malformed OData XML{label}: {exc}") from exc
        raise

    if _local(root.tag) != "Edmx":
        label = f" ({source_label})" if source_label else ""
        raise ODataParseError(f"Expected <Edmx> root element in OData document{label}")
    return root


def _resolve_member(uri: str, members: Mapping[str, str]) -> Optional[str]:
    """Find the fileset member a ``<edmx:Reference Uri=…>`` names.

    A reference in a committed fileset is written relative to its root, so the member is
    matched on the URI as written and then on its final path segment. Absolute URLs never
    match: the adapter does not fetch remote references (``supports_remote_refs`` is False),
    and a reference nothing answers is recorded unresolved rather than failing the import —
    v4 documents routinely reference vocabularies that are not shipped with the service.

    Args:
        uri: The reference URI as written.
        members: Fileset member name → text.

    Returns:
        The member's text, or ``None`` when nothing answers the URI.
    """
    if uri in members:
        return members[uri]
    tail = uri.rsplit("/", 1)[-1]
    return members.get(tail)


def _referenced_schemas(
    root: ET.Element,
    *,
    members: Mapping[str, str],
    source_label: Optional[str],
    seen: set,
) -> Tuple[List[ODataReference], List[ODataSchema]]:
    """Resolve a document's references against fileset members and parse what they name.

    References are followed one document at a time with a ``seen`` guard, so a pair of
    documents referencing each other terminates instead of recursing forever.

    Args:
        root: The referring document's root element.
        members: Fileset member name → text.
        source_label: Label used in error messages.
        seen: URIs already followed in this parse.

    Returns:
        The reference records (each flagged resolved or not) and the schemas they contributed.
    """
    records: List[ODataReference] = []
    schemas: List[ODataSchema] = []
    for uri, includes in _parse_references(root):
        if uri in seen:
            # Two documents in a set may reference the same third one. Its schemas are
            # already merged, so record the reference as resolved and do not merge twice.
            records.append(ODataReference(uri=uri, includes=includes, resolved=True))
            continue
        text = _resolve_member(uri, members)
        if text is None:
            records.append(ODataReference(uri=uri, includes=includes, resolved=False))
            continue
        seen.add(uri)
        referenced_root = _parse_root(text, source_label=uri or source_label)
        referenced_elements = _schema_elements(referenced_root)
        referenced_dialect = resolve_dialect(
            edmx_namespace=_namespace_of(referenced_root.tag),
            edmx_version=referenced_root.get("Version"),
            edm_namespaces=tuple(
                ns for ns in (_namespace_of(el.tag) for el in referenced_elements) if ns
            ),
            data_service_version=_data_service_version(referenced_root),
        )
        legacy = uses_association_model(referenced_dialect.version)
        for element in referenced_elements:
            schema = _parse_schema(element, legacy=legacy)
            if schema is not None:
                schemas.append(schema)
        nested_records, nested_schemas = _referenced_schemas(
            referenced_root, members=members, source_label=uri, seen=seen
        )
        records.append(ODataReference(uri=uri, includes=includes, resolved=True))
        records.extend(nested_records)
        schemas.extend(nested_schemas)
    return records, schemas


def _partner_of(
    navigation: ODataNavigationProperty,
    *,
    association: ODataAssociation,
    target_navigations: Sequence[ODataNavigationProperty],
    index: Mapping[str, ODataAssociation],
) -> Optional[str]:
    """The name of the navigation property pointing back along the same association.

    v4's ``Partner``. The inverse of a traversal ``F -> T`` is the target entity type's
    navigation property along the same association whose ``ToRole`` is ``F``. Relationships
    are compared through ``index`` rather than by string, so the qualified and bare
    spellings of one association are recognized as the same relationship.

    Args:
        navigation: The property whose partner is wanted.
        association: The association it travels.
        target_navigations: Navigation properties of the entity type it travels to.
        index: The document's association index.

    Returns:
        The partner property's name, or ``None`` when the target declares no inverse.
    """
    if not navigation.from_role:
        return None
    for candidate in target_navigations:
        if candidate.to_role == navigation.from_role and (
            index.get(candidate.relationship or "") is association
        ):
            return candidate.name
    return None


def _project_associations(
    schemas: Sequence[ODataSchema], *, source_label: Optional[str]
) -> Tuple[ODataSchema, ...]:
    """Rewrite every v2/v3 navigation property into the v4 shape.

    For each property that names an association but carries no ``Type``, resolves the
    association and the end it travels to, then fills in ``type_expr`` (the target, wrapped
    in ``Collection(...)`` for a to-many end, exactly as v4 spells it), ``partner`` (v4's
    ``Partner``) and ``multiplicity`` (kept for provenance). Everything downstream therefore
    sees one relationship shape and never learns which generation produced it.

    The pass is document-wide, not per-schema: an association may be declared in one
    namespace and travelled from another, and a partner lives on the target entity type
    wherever that is.

    Args:
        schemas: The document's schemas, references already merged in.
        source_label: Label used in the error message.

    Returns:
        The schemas with projected navigation properties. A document with nothing to project
        — every v4 document — is returned untouched.

    Raises:
        ODataParseError: ``INPUT_REFERENCE_UNRESOLVED`` when a navigation property names an
            association or a role the document does not declare.
    """
    entity_types = [entity for schema in schemas for entity in schema.entity_types]
    unresolved = [
        (entity, navigation)
        for entity in entity_types
        for navigation in entity.navigation_properties
        if navigation.relationship and not navigation.type_expr
    ]
    if not unresolved:
        return tuple(schemas)

    index = association_index(
        [association for schema in schemas for association in schema.associations]
    )
    navigations_by_type = {
        f"{entity.namespace}.{entity.name}": entity.navigation_properties
        for entity in entity_types
    }

    projected: Dict[Tuple[str, str], ODataNavigationProperty] = {}
    for entity, navigation in unresolved:
        association = index.get(navigation.relationship or "")
        if association is None:
            _unresolved(entity, navigation, source_label=source_label, detail=(
                f"names association {navigation.relationship!r}, which the document does not declare"
            ))
        try:
            end = resolve_target_end(
                association, from_role=navigation.from_role, to_role=navigation.to_role
            )
        except ODataUnresolvedRelationshipError as exc:
            _unresolved(entity, navigation, source_label=source_label, detail=str(exc), cause=exc)
        projected[(entity.namespace, f"{entity.name}.{navigation.name}")] = replace(
            navigation,
            type_expr=navigation_type_expr(end),
            partner=_partner_of(
                navigation,
                association=association,
                target_navigations=navigations_by_type.get(end.type_expr, ()),
                index=index,
            ),
            multiplicity=end.multiplicity,
        )

    def _rewrite(entity: ODataEntityType) -> ODataEntityType:
        navigations = tuple(
            projected.get((entity.namespace, f"{entity.name}.{navigation.name}"), navigation)
            for navigation in entity.navigation_properties
        )
        if navigations == entity.navigation_properties:
            return entity
        return replace(entity, navigation_properties=navigations)

    return tuple(
        replace(schema, entity_types=tuple(_rewrite(entity) for entity in schema.entity_types))
        for schema in schemas
    )


def _unresolved(
    entity: ODataEntityType,
    navigation: ODataNavigationProperty,
    *,
    source_label: Optional[str],
    detail: str,
    cause: Optional[BaseException] = None,
) -> "NoReturn":
    """Raise the intake error for a relationship that resolves to nothing.

    Args:
        entity: The entity type declaring the navigation property.
        navigation: The property that could not be resolved.
        source_label: Filename used in the message.
        detail: What specifically could not be resolved.
        cause: The originating lookup error, when there was one.

    Raises:
        ODataParseError: Always, coded ``INPUT_REFERENCE_UNRESOLVED``.
    """
    label = f" ({source_label})" if source_label else ""
    raise ODataParseError(
        f"Unresolved OData relationship{label}: navigation property "
        f"'{entity.name}.{navigation.name}' {detail}",
        code="INPUT_REFERENCE_UNRESOLVED",
    ) from cause


def parse_odata(
    content: str,
    *,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
) -> ODataDocument:
    """Parse OData EDMX / CSDL XML into an :class:`ODataDocument`.

    Args:
        content: The document text.
        source_label: Filename or member name used in error messages.
        members: Sibling documents of a multi-file set, keyed by member name. When given,
            ``<edmx:Reference>`` declarations are resolved against them and the referenced
            schemas are merged into this document, which is how a v3 service that keeps its
            shared complex types in a second file imports as one API.

    Returns:
        The parsed document, with its CSDL version resolved from namespaces and its v2/v3
        associations projected onto v4-shaped navigation properties.

    Raises:
        ODataParseError: On empty input, a non-OData document, malformed XML, a document
            with no schema, a document with no entity container
            (``INPUT_SEMANTIC_INVALID``), or an unresolvable relationship
            (``INPUT_REFERENCE_UNRESOLVED``).
    """
    if not content or not content.strip():
        raise ODataParseError("Invalid or empty OData content")
    if not is_odata(content):
        raise ODataParseError("Content does not appear to be an OData EDMX / CSDL document")

    root = _parse_root(content, source_label=source_label)
    schema_elements = _schema_elements(root)
    dialect = resolve_dialect(
        edmx_namespace=_namespace_of(root.tag),
        edmx_version=root.get("Version"),
        edm_namespaces=tuple(ns for ns in (_namespace_of(el.tag) for el in schema_elements) if ns),
        data_service_version=_data_service_version(root),
    )
    legacy = uses_association_model(dialect.version)

    schemas: List[ODataSchema] = []
    for element in schema_elements:
        schema = _parse_schema(element, legacy=legacy)
        if schema is not None:
            schemas.append(schema)

    references: Tuple[ODataReference, ...] = ()
    if members:
        reference_records, referenced_schemas = _referenced_schemas(
            root, members=members, source_label=source_label, seen=set()
        )
        references = tuple(reference_records)
        schemas.extend(referenced_schemas)

    if not schemas:
        label = f" ({source_label})" if source_label else ""
        raise ODataParseError(f"No OData Schema definitions found in EDMX document{label}")

    if not any(schema.entity_container is not None for schema in schemas):
        label = f" ({source_label})" if source_label else ""
        raise ODataParseError(
            f"OData document declares no EntityContainer{label}, so it describes no "
            f"addressable service surface",
            code="INPUT_SEMANTIC_INVALID",
        )

    return ODataDocument(
        version=dialect.version,
        schemas=_project_associations(schemas, source_label=source_label),
        raw=content,
        dialect=dialect,
        references=references,
    )
