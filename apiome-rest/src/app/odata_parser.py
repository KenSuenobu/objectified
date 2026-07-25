"""OData v4 CSDL / EDMX parser — MFI-22.1.

Parses OData ``.edmx`` / CSDL XML into a typed :class:`ODataDocument` AST using the stdlib
:mod:`xml.etree.ElementTree` (no external OData toolchain). Syntax errors surface as
:class:`ODataParseError`.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional, Tuple

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
    "ODataEntityContainer",
    "ODataSchema",
    "ODataDocument",
    "is_odata",
    "parse_odata",
]


class ODataParseError(ValueError):
    """Raised when OData CSDL / EDMX text cannot be parsed."""


@dataclass(frozen=True)
class ODataProperty:
    name: str
    type_expr: str
    nullable: Optional[bool] = None


@dataclass(frozen=True)
class ODataNavigationProperty:
    name: str
    type_expr: str
    partner: Optional[str] = None


@dataclass(frozen=True)
class ODataEntityType:
    name: str
    namespace: str
    key_properties: Tuple[str, ...]
    properties: Tuple[ODataProperty, ...]
    navigation_properties: Tuple[ODataNavigationProperty, ...]


@dataclass(frozen=True)
class ODataEntitySet:
    name: str
    entity_type: str


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
    name: str
    namespace: str
    properties: Tuple[ODataProperty, ...]


@dataclass(frozen=True)
class ODataEntityContainer:
    name: str
    entity_sets: Tuple[ODataEntitySet, ...]


@dataclass(frozen=True)
class ODataSchema:
    namespace: str
    entity_types: Tuple[ODataEntityType, ...]
    complex_types: Tuple[ODataComplexType, ...]
    enum_types: Tuple[ODataEnumType, ...]
    entity_container: Optional[ODataEntityContainer]


@dataclass(frozen=True)
class ODataDocument:
    version: str
    schemas: Tuple[ODataSchema, ...]
    raw: str


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


def _parse_properties(parent: ET.Element) -> Tuple[ODataProperty, ...]:
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
            )
        )
    return tuple(properties)


def _parse_navigation_properties(parent: ET.Element) -> Tuple[ODataNavigationProperty, ...]:
    navigation: List[ODataNavigationProperty] = []
    for prop in _children(parent, "NavigationProperty"):
        name = prop.get("Name")
        type_expr = prop.get("Type")
        if not name or not type_expr:
            continue
        navigation.append(
            ODataNavigationProperty(
                name=name,
                type_expr=type_expr,
                partner=prop.get("Partner"),
            )
        )
    return tuple(navigation)


def _parse_entity_types(schema: ET.Element, namespace: str) -> Tuple[ODataEntityType, ...]:
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
                properties=_parse_properties(entity),
                navigation_properties=_parse_navigation_properties(entity),
            )
        )
    return tuple(entity_types)


def _parse_complex_types(schema: ET.Element, namespace: str) -> Tuple[ODataComplexType, ...]:
    complex_types: List[ODataComplexType] = []
    for complex_type in _children(schema, "ComplexType"):
        name = complex_type.get("Name")
        if not name:
            continue
        complex_types.append(
            ODataComplexType(
                name=name,
                namespace=namespace,
                properties=_parse_properties(complex_type),
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


def _parse_entity_container(schema: ET.Element) -> Optional[ODataEntityContainer]:
    for container in _children(schema, "EntityContainer"):
        name = container.get("Name")
        if not name:
            continue
        entity_sets: List[ODataEntitySet] = []
        for entity_set in _children(container, "EntitySet"):
            set_name = entity_set.get("Name")
            entity_type = entity_set.get("EntityType")
            if set_name and entity_type:
                entity_sets.append(ODataEntitySet(name=set_name, entity_type=entity_type))
        return ODataEntityContainer(name=name, entity_sets=tuple(entity_sets))
    return None


def _parse_schema(schema: ET.Element) -> Optional[ODataSchema]:
    namespace = schema.get("Namespace")
    if not namespace:
        return None
    return ODataSchema(
        namespace=namespace,
        entity_types=_parse_entity_types(schema, namespace),
        complex_types=_parse_complex_types(schema, namespace),
        enum_types=_parse_enum_types(schema, namespace),
        entity_container=_parse_entity_container(schema),
    )


def parse_odata(content: str, *, source_label: Optional[str] = None) -> ODataDocument:
    """Parse OData EDMX / CSDL XML into an :class:`ODataDocument`."""
    if not content or not content.strip():
        raise ODataParseError("Invalid or empty OData content")
    if not is_odata(content):
        raise ODataParseError("Content does not appear to be an OData EDMX / CSDL document")

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

    version = root.get("Version") or "4.0"
    schemas: List[ODataSchema] = []
    for data_services in _children(root, "DataServices"):
        for schema_el in _children(data_services, "Schema"):
            schema = _parse_schema(schema_el)
            if schema is not None:
                schemas.append(schema)

    if not schemas:
        label = f" ({source_label})" if source_label else ""
        raise ODataParseError(f"No OData Schema definitions found in EDMX document{label}")

    return ODataDocument(version=version, schemas=tuple(schemas), raw=content)
