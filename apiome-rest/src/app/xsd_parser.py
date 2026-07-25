"""XML Schema (XSD) parser.

Parses W3C XML Schema documents into a typed :class:`XsdDocument` AST using the
stdlib :mod:`xml.etree.ElementTree`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "XsdParseError",
    "XsdField",
    "XsdComplexType",
    "XsdSimpleType",
    "XsdElementDecl",
    "XsdDocument",
    "is_xsd",
    "parse_xsd",
]

_XSD_NS = "http://www.w3.org/2001/XMLSchema"


class XsdParseError(ValueError):
    """Raised when XSD text cannot be parsed."""


@dataclass(frozen=True)
class XsdField:
    name: str
    type_expr: str
    kind: str = "element"
    max_occurs: Optional[str] = None
    min_occurs: Optional[str] = None


@dataclass(frozen=True)
class XsdComplexType:
    name: str
    fields: Tuple[XsdField, ...]


@dataclass(frozen=True)
class XsdSimpleType:
    name: str
    base: Optional[str]
    enum_values: Tuple[str, ...]


@dataclass(frozen=True)
class XsdElementDecl:
    name: str
    type_expr: str


@dataclass(frozen=True)
class XsdDocument:
    target_namespace: Optional[str]
    root_element: Optional[str]
    complex_types: Tuple[XsdComplexType, ...]
    simple_types: Tuple[XsdSimpleType, ...]
    elements: Tuple[XsdElementDecl, ...]
    raw: str


def is_xsd(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a standalone XSD schema."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<wsdl:definitions" in trimmed or (
        "<definitions" in trimmed and "schemas.xmlsoap.org/wsdl" in trimmed
    ):
        return False
    if "<application" in trimmed and "wadl.dev.java.net" in trimmed:
        return False
    if "<xs:schema" in trimmed or "<xsd:schema" in trimmed:
        return True
    try:
        root = parse_xml(trimmed)
    except SecureXmlError:
        # Sniffers must never raise: an unsafe or malformed document is simply
        # not a recognized XSD (the parse phase reports the real reason).
        return False
    return _local(root.tag) == "schema" and _XSD_NS in root.tag


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _attr_local(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if ":" in value:
        return value.split(":", 1)[1]
    return value


def _children(element: ET.Element, local_name: str) -> List[ET.Element]:
    return [child for child in element if isinstance(child.tag, str) and _local(child.tag) == local_name]


def _find_descendants(element: ET.Element, local_name: str) -> List[ET.Element]:
    return [node for node in element.iter() if isinstance(node.tag, str) and _local(node.tag) == local_name]


def _parse_complex_types(schema_el: ET.Element) -> Tuple[XsdComplexType, ...]:
    complex_types: List[XsdComplexType] = []
    for complex_type in _children(schema_el, "complexType"):
        name = complex_type.get("name")
        if not name:
            continue
        fields: List[XsdField] = []
        for sequence in _find_descendants(complex_type, "sequence"):
            for field_el in _children(sequence, "element"):
                field_name = field_el.get("name")
                type_expr = field_el.get("type")
                if field_name and type_expr:
                    fields.append(
                        XsdField(
                            name=field_name,
                            type_expr=_attr_local(type_expr) or type_expr,
                            kind="element",
                            max_occurs=field_el.get("maxOccurs"),
                            min_occurs=field_el.get("minOccurs"),
                        )
                    )
        for attr_el in _children(complex_type, "attribute"):
            attr_name = attr_el.get("name")
            type_expr = attr_el.get("type")
            if attr_name and type_expr:
                fields.append(
                    XsdField(
                        name=attr_name,
                        type_expr=_attr_local(type_expr) or type_expr,
                        kind="attribute",
                    )
                )
        complex_types.append(XsdComplexType(name=name, fields=tuple(fields)))
    return tuple(complex_types)


def _parse_simple_types(schema_el: ET.Element) -> Tuple[XsdSimpleType, ...]:
    simple_types: List[XsdSimpleType] = []
    for simple_type in _children(schema_el, "simpleType"):
        name = simple_type.get("name")
        if not name:
            continue
        restriction = next(iter(_children(simple_type, "restriction")), None)
        base = _attr_local(restriction.get("base")) if restriction is not None else None
        enum_values: List[str] = []
        if restriction is not None:
            for enum_el in _children(restriction, "enumeration"):
                value = enum_el.get("value")
                if isinstance(value, str) and value:
                    enum_values.append(value)
        simple_types.append(
            XsdSimpleType(name=name, base=base, enum_values=tuple(enum_values))
        )
    return tuple(simple_types)


def _parse_elements(schema_el: ET.Element) -> Tuple[XsdElementDecl, ...]:
    elements: List[XsdElementDecl] = []
    for element in _children(schema_el, "element"):
        name = element.get("name")
        type_expr = element.get("type")
        if name and type_expr:
            elements.append(
                XsdElementDecl(name=name, type_expr=_attr_local(type_expr) or type_expr)
            )
    return tuple(elements)


def parse_xsd(content: str, *, source_label: Optional[str] = None) -> XsdDocument:
    """Parse XSD XML into an :class:`XsdDocument`."""
    if not content or not content.strip():
        raise XsdParseError("Invalid or empty XSD document")
    if not is_xsd(content):
        label = f" ({source_label})" if source_label else ""
        raise XsdParseError(f"Content does not appear to be an XSD schema{label}")
    try:
        root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise XsdParseError(f"Malformed XSD document: {exc}") from exc
        raise

    if _local(root.tag) != "schema":
        raise XsdParseError("XSD root element must be `schema`")

    complex_types = _parse_complex_types(root)
    simple_types = _parse_simple_types(root)
    elements = _parse_elements(root)
    if not complex_types and not simple_types and not elements:
        label = f" ({source_label})" if source_label else ""
        raise XsdParseError(f"No XSD types or elements found{label}")

    root_element = elements[0].name if elements else None
    return XsdDocument(
        target_namespace=root.get("targetNamespace"),
        root_element=root_element,
        complex_types=complex_types,
        simple_types=simple_types,
        elements=elements,
        raw=content,
    )
