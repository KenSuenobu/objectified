"""OData CSDL / EDMX → canonical model normalizer — MFI-22.1, v2/v3 in FMT-3.4 (#5429).

Maps a parsed :class:`~app.odata_parser.ODataDocument` into a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.REST`.

All three CSDL generations produce the *same* canonical shape: the parser has already
projected v2/v3 associations onto v4-shaped navigation properties, so the entity types,
entity sets and operations built here do not know which version they came from. What
differs is provenance and the constructs v4 has no place for — the source CSDL version,
the association declarations, association sets, function-import signatures and the
``m:``/``sap:`` annotation bags — which are carried in ``extras``.

Those extras keys are **only emitted for a pre-v4 document**. A v4 import produces exactly
the bytes it produced before FMT-3.4, which is that ticket's third acceptance criterion and
what keeps the committed v4 corpus goldens valid.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from .normalizer import Keys, Normalizer, normalize_ordering
from .odata_associations import ODataAssociation, ODataAssociationSet
from .odata_parser import (
    ODataComplexType,
    ODataDocument,
    ODataEntityContainer,
    ODataEntitySet,
    ODataEntityType,
    ODataEnumType,
    ODataFunctionImport,
    ODataNavigationProperty,
    ODataProperty,
    ODataSchema,
)

__all__ = ["ODataNormalizer"]

_FORMAT_KEY = "odata"

_EDM_BASE_TO_CANONICAL: Dict[str, str] = {
    "Edm.String": "string",
    "Edm.Boolean": "bool",
    "Edm.Byte": "uint8",
    "Edm.SByte": "int8",
    "Edm.Int16": "i16",
    "Edm.Int32": "i32",
    "Edm.Int64": "i64",
    "Edm.Single": "float",
    "Edm.Double": "double",
    "Edm.Decimal": "double",
    "Edm.Guid": "string",
    "Edm.Date": "string",
    "Edm.DateTimeOffset": "string",
    "Edm.TimeOfDay": "string",
    "Edm.Binary": "bytes",
    "Edm.Stream": "bytes",
    # v2/v3-only primitives, dropped from the v4 vocabulary. Absent from this map they
    # would fall through to the named-type branch and mint a dangling `type:NS.DateTime`
    # reference for every SAP timestamp column.
    "Edm.DateTime": "string",
    "Edm.Time": "string",
}


def _type_key(name: str, namespace: Optional[str]) -> str:
    return Keys.type(name, namespace)


def _qualified_name(namespace: str, name: str) -> str:
    return f"{namespace}.{name}"


def _split_qualified(type_expr: str) -> tuple[Optional[str], str]:
    if "." in type_expr:
        namespace, name = type_expr.rsplit(".", 1)
        return namespace, name
    return None, type_expr


def _type_ref_from_expr(
    type_expr: str,
    *,
    namespace: Optional[str],
    type_names: frozenset[str],
    qualified_names: frozenset[str],
) -> TypeRef:
    collection_match = re.fullmatch(r"Collection\((.+)\)", type_expr.strip())
    if collection_match:
        inner = _type_ref_from_expr(
            collection_match.group(1).strip(),
            namespace=namespace,
            type_names=type_names,
            qualified_names=qualified_names,
        )
        return TypeRef(name=inner.name, item=inner, nullable=False)

    mapped = _EDM_BASE_TO_CANONICAL.get(type_expr)
    if mapped:
        return TypeRef(name=mapped, nullable=True)
    if type_expr in qualified_names:
        _, local = _split_qualified(type_expr)
        return TypeRef(name=_type_key(local, namespace), nullable=True)
    if type_expr in type_names:
        return TypeRef(name=_type_key(type_expr, namespace), nullable=True)
    local = type_expr.split(".")[-1]
    return TypeRef(name=_type_key(local, namespace), nullable=True)


def _constraints_for_property(prop: ODataProperty) -> Optional[Constraints]:
    return None


def _canonical_field(
    prop: ODataProperty,
    *,
    parent_key: str,
    namespace: Optional[str],
    type_names: frozenset[str],
    qualified_names: frozenset[str],
    field_number: int,
) -> CanonicalField:
    type_ref = _type_ref_from_expr(
        prop.type_expr,
        namespace=namespace,
        type_names=type_names,
        qualified_names=qualified_names,
    )
    if prop.nullable is not None:
        type_ref = type_ref.model_copy(update={"nullable": prop.nullable})
    return CanonicalField(
        key=Keys.field(parent_key, prop.name),
        name=prop.name,
        type=type_ref,
        field_number=field_number,
        constraints=_constraints_for_property(prop),
        extras=_annotated(
            {"odata_type": prop.type_expr}, prop.annotations, key="odata_annotations"
        ),
    )


def _entity_set_operations(
    entity_set: ODataEntitySet,
    *,
    namespace: Optional[str],
    entity_types_by_qualified: Dict[str, ODataEntityType],
) -> List[Operation]:
    entity_type = entity_types_by_qualified.get(entity_set.entity_type)
    if entity_type is None:
        _, local = _split_qualified(entity_set.entity_type)
        entity_type = entity_types_by_qualified.get(local)
    payload = TypeRef(name=_type_key(entity_type.name, namespace)) if entity_type else None
    service_key = Keys.type(entity_set.name, namespace)
    operations: List[Operation] = []

    list_key = Keys.operation_http("GET", f"/{entity_set.name}")
    operations.append(
        Operation(
            key=list_key,
            name=f"list{entity_set.name}",
            kind=OperationKind.REQUEST_RESPONSE,
            streaming=StreamingMode.NONE,
            http_method="GET",
            http_path=f"/{entity_set.name}",
            parameters=[
                Parameter(
                    key=Keys.parameter(list_key, "query", "$top"),
                    name="$top",
                    location=ParameterLocation.QUERY,
                    type=TypeRef(name="i32"),
                )
            ],
            messages=[
                Message(
                    key=f"{list_key}#response",
                    role=MessageRole.RESPONSE,
                    status_code="200",
                    content_types=["application/json"],
                    payload=payload,
                )
            ],
            extras={"odata_entity_set": entity_set.name, "odata_operation": "list"},
        )
    )

    get_key = Keys.operation_http("GET", f"/{entity_set.name}({{key}})")
    operations.append(
        Operation(
            key=get_key,
            name=f"get{entity_set.name.rstrip('s')}",
            kind=OperationKind.REQUEST_RESPONSE,
            streaming=StreamingMode.NONE,
            http_method="GET",
            http_path=f"/{entity_set.name}({{key}})",
            messages=[
                Message(
                    key=f"{get_key}#response",
                    role=MessageRole.RESPONSE,
                    status_code="200",
                    content_types=["application/json"],
                    payload=payload,
                )
            ],
            extras={"odata_entity_set": entity_set.name, "odata_operation": "get"},
        )
    )

    create_key = Keys.operation_http("POST", f"/{entity_set.name}")
    operations.append(
        Operation(
            key=create_key,
            name=f"create{entity_set.name.rstrip('s')}",
            kind=OperationKind.REQUEST_RESPONSE,
            streaming=StreamingMode.NONE,
            http_method="POST",
            http_path=f"/{entity_set.name}",
            messages=[
                Message(
                    key=f"{create_key}#request",
                    role=MessageRole.REQUEST,
                    content_types=["application/json"],
                    payload=payload,
                    required=True,
                ),
                Message(
                    key=f"{create_key}#response",
                    role=MessageRole.RESPONSE,
                    status_code="201",
                    content_types=["application/json"],
                    payload=payload,
                ),
            ],
            extras={"odata_entity_set": entity_set.name, "odata_operation": "create"},
        )
    )

    return operations


# ---------------------------------------------------------------------------
# extras projection (FMT-3.4)
#
# Every helper below omits its key when the source carried nothing for it. That is the
# mechanism keeping a v4 import byte-identical: the parser captures annotations,
# associations, association sets and function-import signatures only for pre-v4 documents,
# so for a v4 document each of these collapses to exactly the payload it produced before.
# ---------------------------------------------------------------------------


def _annotated(
    payload: Dict[str, Any], pairs: Sequence[Tuple[str, str]], *, key: str = "annotations"
) -> Dict[str, Any]:
    """Attach the source's unmodeled attributes to an extras payload.

    The bag holds everything a CSDL element declared that the canonical model has no field
    for: facets (``MaxLength``, ``Precision``, ``Scale``), the v2/v3 ``m:`` attributes
    (``FC_TargetPath``, ``HasStream``, ``HttpMethod``, ``IsDefaultEntityContainer``) and
    vendor annotations such as SAP's ``sap:label``/``sap:semantics``. Recording them is the
    FMT-3.4 requirement that a construct with no v4 analogue is kept rather than dropped.

    Args:
        payload: The extras payload being built.
        pairs: The parser's ordered ``(key, value)`` annotation pairs.
        key: The key the bag is stored under — ``odata_annotations`` inside a canonical
            ``extras`` bag (whose keys are format-namespaced), plain ``annotations`` inside
            the ``odata_schemas`` tree (whose keys mirror CSDL).

    Returns:
        ``payload``, with the bag added when ``pairs`` is non-empty and untouched when it is
        — which is what keeps a v4 import, parsed with annotation capture off, byte-identical.
    """
    if pairs:
        payload[key] = dict(pairs)
    return payload


def _navigation_extras(navigation: ODataNavigationProperty) -> Dict[str, Any]:
    """One navigation property as the canonical model records it.

    The ``name``/``type``/``partner`` triple is what every generation produces — the parser
    derived the last two from the association for a v2/v3 document. The relationship fields
    are the v2/v3 spelling itself, kept so an export or a diff can say which association a
    traversal came from.
    """
    payload: Dict[str, Any] = {
        "name": navigation.name,
        "type": navigation.type_expr,
        "partner": navigation.partner,
    }
    if navigation.relationship:
        payload["relationship"] = navigation.relationship
        payload["from_role"] = navigation.from_role
        payload["to_role"] = navigation.to_role
        payload["multiplicity"] = navigation.multiplicity
    return _annotated(payload, navigation.annotations)


def _association_extras(association: ODataAssociation) -> Dict[str, Any]:
    """One ``<Association>`` declaration, ends and referential constraints included."""
    return _annotated(
        {
            "name": association.name,
            "namespace": association.namespace,
            "ends": [
                {
                    "role": end.role,
                    "type": end.type_expr,
                    "multiplicity": end.multiplicity,
                }
                for end in association.ends
            ],
            "referential_constraints": [
                {
                    "principal_role": constraint.principal_role,
                    "principal_properties": list(constraint.principal_properties),
                    "dependent_role": constraint.dependent_role,
                    "dependent_properties": list(constraint.dependent_properties),
                }
                for constraint in association.referential_constraints
            ],
        },
        association.annotations,
    )


def _association_set_extras(association_set: ODataAssociationSet) -> Dict[str, Any]:
    """One ``<AssociationSet>``: an association bound onto two container entity sets."""
    return _annotated(
        {
            "name": association_set.name,
            "association": association_set.association,
            "ends": [
                {"role": end.role, "entity_set": end.entity_set}
                for end in association_set.ends
            ],
        },
        association_set.annotations,
    )


def _function_import_extras(function_import: ODataFunctionImport) -> Dict[str, Any]:
    """One v2/v3 ``<FunctionImport>`` with its inline parameter signature."""
    return _annotated(
        {
            "name": function_import.name,
            "return_type": function_import.return_type,
            "entity_set": function_import.entity_set,
            "parameters": [
                {
                    "name": parameter.name,
                    "type": parameter.type_expr,
                    "mode": parameter.mode,
                    "nullable": parameter.nullable,
                }
                for parameter in function_import.parameters
            ],
        },
        function_import.annotations,
    )


def _entity_set_extras(entity_set: ODataEntitySet) -> Dict[str, Any]:
    """One ``<EntitySet>`` as the container extras record it."""
    return _annotated(
        {"name": entity_set.name, "entity_type": entity_set.entity_type},
        entity_set.annotations,
    )


def _container_extras(container: ODataEntityContainer) -> Dict[str, Any]:
    """One ``<EntityContainer>``: its entity sets, plus the v2/v3 sets and function imports."""
    payload: Dict[str, Any] = {
        "name": container.name,
        "entity_sets": [_entity_set_extras(entity_set) for entity_set in container.entity_sets],
    }
    if container.association_sets:
        payload["association_sets"] = [
            _association_set_extras(association_set)
            for association_set in container.association_sets
        ]
    if container.function_imports:
        payload["function_imports"] = [
            _function_import_extras(function_import)
            for function_import in container.function_imports
        ]
    return _annotated(payload, container.annotations)


def _property_extras(prop: ODataProperty) -> Dict[str, Any]:
    """One structural property as the schema extras record it."""
    return _annotated(
        {"name": prop.name, "type": prop.type_expr, "nullable": prop.nullable},
        prop.annotations,
    )


def _schema_extras(schema: ODataSchema) -> Dict[str, Any]:
    """One ``<Schema>`` in full — the store-raw view the OData emitter re-renders from."""
    payload: Dict[str, Any] = {
        "namespace": schema.namespace,
        "entity_container": (
            _container_extras(schema.entity_container)
            if schema.entity_container is not None
            else None
        ),
        "entity_types": [
            _annotated(
                {
                    "name": entity.name,
                    "key_properties": list(entity.key_properties),
                    "properties": [_property_extras(prop) for prop in entity.properties],
                    "navigation_properties": [
                        _navigation_extras(navigation)
                        for navigation in entity.navigation_properties
                    ],
                },
                entity.annotations,
            )
            for entity in schema.entity_types
        ],
        "complex_types": [
            _annotated(
                {
                    "name": complex_type.name,
                    "properties": [
                        _property_extras(prop) for prop in complex_type.properties
                    ],
                },
                complex_type.annotations,
            )
            for complex_type in schema.complex_types
        ],
        "enum_types": [
            {
                "name": enum_type.name,
                "members": [
                    {"name": member.name, "value": member.value}
                    for member in enum_type.members
                ],
            }
            for enum_type in schema.enum_types
        ],
    }
    if schema.associations:
        payload["associations"] = [
            _association_extras(association) for association in schema.associations
        ]
    return _annotated(payload, schema.annotations)


def _source_version_extras(source: ODataDocument) -> Dict[str, Any]:
    """Provenance for the CSDL generation a document was written in.

    Only a pre-v4 document contributes keys. v4 already states its version in
    ``version``/``odata_version`` and adding namespace evidence to it would change the
    committed v4 goldens for no gain — FMT-3.4's third acceptance criterion.

    Args:
        source: The parsed document.

    Returns:
        The provenance keys, empty for a v4 document or one parsed without dialect evidence.
    """
    dialect = source.dialect
    if dialect is None or dialect.is_v4:
        return {}
    provenance: Dict[str, Any] = {"odata_csdl_version": dialect.version}
    if dialect.edm_namespace:
        provenance["odata_edm_namespace"] = dialect.edm_namespace
    if dialect.edmx_namespace:
        provenance["odata_edmx_namespace"] = dialect.edmx_namespace
    if dialect.edmx_version:
        provenance["odata_edmx_version"] = dialect.edmx_version
    if dialect.data_service_version:
        provenance["odata_data_service_version"] = dialect.data_service_version
    return provenance


def _reference_extras(source: ODataDocument) -> Dict[str, Any]:
    """The ``<edmx:Reference>`` declarations a multi-file set resolved, when there are any."""
    if not source.references:
        return {}
    return {
        "odata_references": [
            {
                "uri": reference.uri,
                "namespaces": [namespace for namespace, _ in reference.includes],
                "resolved": reference.resolved,
            }
            for reference in source.references
        ]
    }


class ODataNormalizer(Normalizer, register=True):
    """Normalize a parsed OData document into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, ODataDocument):
            raise ValueError(
                "OData source must be an ODataDocument (see app.odata_parser.parse_odata)"
            )

        primary_schema = source.schemas[0]
        namespace = primary_schema.namespace
        type_names = frozenset(
            entity.name for schema in source.schemas for entity in schema.entity_types
        ) | frozenset(
            complex_type.name for schema in source.schemas for complex_type in schema.complex_types
        ) | frozenset(enum_type.name for schema in source.schemas for enum_type in schema.enum_types)
        qualified_names = frozenset(
            _qualified_name(schema.namespace, entity.name)
            for schema in source.schemas
            for entity in schema.entity_types
        ) | frozenset(
            _qualified_name(schema.namespace, complex_type.name)
            for schema in source.schemas
            for complex_type in schema.complex_types
        ) | frozenset(
            _qualified_name(schema.namespace, enum_type.name)
            for schema in source.schemas
            for enum_type in schema.enum_types
        )

        types: List[Type] = []
        entity_types_by_qualified: Dict[str, ODataEntityType] = {}

        for schema in source.schemas:
            for enum_type in schema.enum_types:
                type_key = _type_key(enum_type.name, namespace)
                types.append(self._enum_type(enum_type, type_key=type_key))

            for complex_type in schema.complex_types:
                type_key = _type_key(complex_type.name, namespace)
                types.append(
                    self._record_type(
                        complex_type,
                        type_key=type_key,
                        namespace=namespace,
                        type_names=type_names,
                        qualified_names=qualified_names,
                        kind="complex",
                    )
                )

            for entity_type in schema.entity_types:
                qualified = _qualified_name(schema.namespace, entity_type.name)
                entity_types_by_qualified[qualified] = entity_type
                entity_types_by_qualified[entity_type.name] = entity_type
                type_key = _type_key(entity_type.name, namespace)
                nav_extras = [
                    _navigation_extras(navigation)
                    for navigation in entity_type.navigation_properties
                ]
                types.append(
                    Type(
                        key=type_key,
                        name=entity_type.name,
                        kind=TypeKind.RECORD,
                        namespace=namespace,
                        fields=tuple(
                            _canonical_field(
                                prop,
                                parent_key=type_key,
                                namespace=namespace,
                                type_names=type_names,
                                qualified_names=qualified_names,
                                field_number=index,
                            )
                            for index, prop in enumerate(entity_type.properties, start=1)
                        ),
                        extras=_annotated(
                            {
                                "odata_kind": "entity",
                                "odata_key_properties": list(entity_type.key_properties),
                                "odata_navigation_properties": nav_extras,
                            },
                            entity_type.annotations,
                            key="odata_annotations",
                        ),
                    )
                )

        services: List[Service] = []
        entity_sets: List[Dict[str, Any]] = []
        for schema in source.schemas:
            container = schema.entity_container
            if container is None:
                continue
            for entity_set in container.entity_sets:
                entity_sets.append(_entity_set_extras(entity_set))
                service_key = Keys.type(entity_set.name, namespace)
                services.append(
                    Service(
                        key=service_key,
                        name=entity_set.name,
                        operations=_entity_set_operations(
                            entity_set,
                            namespace=namespace,
                            entity_types_by_qualified=entity_types_by_qualified,
                        ),
                    )
                )

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=namespace, namespace=namespace),
            version=source.version,
            services=services,
            types=types,
            raw={"odata": source.raw} if include_raw else None,
            extras={
                "odata_version": source.version,
                "odata_schemas": [_schema_extras(schema) for schema in source.schemas],
                "odata_entity_sets": entity_sets,
                **_source_version_extras(source),
                **_reference_extras(source),
            },
        )
        return normalize_ordering(api)

    def _enum_type(self, enum_type: ODataEnumType, *, type_key: str) -> Type:
        return Type(
            key=type_key,
            name=enum_type.name,
            kind=TypeKind.ENUM,
            enum_values=tuple(
                EnumValue(
                    key=Keys.enum_value(type_key, member.name),
                    name=member.name,
                    value=member.value if member.value is not None else index,
                )
                for index, member in enumerate(enum_type.members)
            ),
            extras={"odata_kind": "enum"},
        )

    def _record_type(
        self,
        complex_type: ODataComplexType,
        *,
        type_key: str,
        namespace: Optional[str],
        type_names: frozenset[str],
        qualified_names: frozenset[str],
        kind: str,
    ) -> Type:
        return Type(
            key=type_key,
            name=complex_type.name,
            kind=TypeKind.RECORD,
            namespace=namespace,
            fields=tuple(
                _canonical_field(
                    prop,
                    parent_key=type_key,
                    namespace=namespace,
                    type_names=type_names,
                    qualified_names=qualified_names,
                    field_number=index,
                )
                for index, prop in enumerate(complex_type.properties, start=1)
            ),
            extras=_annotated(
                {"odata_kind": kind},
                complex_type.annotations,
                key="odata_annotations",
            ),
        )
