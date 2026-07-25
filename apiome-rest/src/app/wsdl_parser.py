"""WSDL 1.1 parser — MFI-15.1.

Parses SOAP WSDL documents into a typed :class:`WsdlDocument` AST using the stdlib
:mod:`xml.etree.ElementTree` (no external WSDL toolchain). Syntax errors surface as
:class:`WsdlParseError`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "WsdlParseError",
    "WsdlField",
    "WsdlComplexType",
    "WsdlElementDecl",
    "WsdlMessagePart",
    "WsdlMessage",
    "WsdlOperation",
    "WsdlPortType",
    "WsdlPort",
    "WsdlService",
    "WsdlDocument",
    "is_wsdl",
    "parse_wsdl",
]


class WsdlParseError(ValueError):
    """Raised when WSDL text cannot be parsed."""


@dataclass(frozen=True)
class WsdlField:
    name: str
    type_expr: str


@dataclass(frozen=True)
class WsdlComplexType:
    name: str
    fields: Tuple[WsdlField, ...]


@dataclass(frozen=True)
class WsdlElementDecl:
    name: str
    type_expr: str


@dataclass(frozen=True)
class WsdlMessagePart:
    name: str
    element: Optional[str]
    type_name: Optional[str]


@dataclass(frozen=True)
class WsdlMessage:
    name: str
    parts: Tuple[WsdlMessagePart, ...]


@dataclass(frozen=True)
class WsdlOperation:
    name: str
    input_message: Optional[str]
    output_message: Optional[str]


@dataclass(frozen=True)
class WsdlPortType:
    name: str
    operations: Tuple[WsdlOperation, ...]


@dataclass(frozen=True)
class WsdlPort:
    name: str
    binding: str
    location: Optional[str]


@dataclass(frozen=True)
class WsdlService:
    name: str
    ports: Tuple[WsdlPort, ...]


@dataclass(frozen=True)
class WsdlDocument:
    name: Optional[str]
    target_namespace: Optional[str]
    complex_types: Tuple[WsdlComplexType, ...]
    elements: Tuple[WsdlElementDecl, ...]
    messages: Tuple[WsdlMessage, ...]
    port_types: Tuple[WsdlPortType, ...]
    services: Tuple[WsdlService, ...]
    raw: str


def is_wsdl(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a WSDL document."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<wsdl:definitions" in trimmed:
        return True
    if "<definitions" in trimmed and "schemas.xmlsoap.org/wsdl" in trimmed:
        return True
    return False


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _attr_local(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if ":" in value:
        return value.split(":", 1)[1]
    return value


def _children(element: ET.Element, local_name: str) -> List[ET.Element]:
    return [child for child in element if _local(child.tag) == local_name]


def _find_descendants(element: ET.Element, local_name: str) -> List[ET.Element]:
    return [node for node in element.iter() if _local(node.tag) == local_name]


def _parse_complex_types(types_el: Optional[ET.Element]) -> Tuple[WsdlComplexType, ...]:
    if types_el is None:
        return ()
    complex_types: List[WsdlComplexType] = []
    for schema in _find_descendants(types_el, "schema"):
        for complex_type in _children(schema, "complexType"):
            name = complex_type.get("name")
            if not name:
                continue
            fields: List[WsdlField] = []
            for sequence in _find_descendants(complex_type, "sequence"):
                for field_el in _children(sequence, "element"):
                    field_name = field_el.get("name")
                    type_expr = field_el.get("type")
                    if field_name and type_expr:
                        fields.append(WsdlField(name=field_name, type_expr=_attr_local(type_expr) or type_expr))
            complex_types.append(WsdlComplexType(name=name, fields=tuple(fields)))
    return tuple(complex_types)


def _parse_elements(types_el: Optional[ET.Element]) -> Tuple[WsdlElementDecl, ...]:
    if types_el is None:
        return ()
    elements: List[WsdlElementDecl] = []
    for schema in _find_descendants(types_el, "schema"):
        for element in _children(schema, "element"):
            name = element.get("name")
            type_expr = element.get("type")
            if name and type_expr:
                elements.append(
                    WsdlElementDecl(name=name, type_expr=_attr_local(type_expr) or type_expr)
                )
    return tuple(elements)


def _parse_messages(root: ET.Element) -> Tuple[WsdlMessage, ...]:
    messages: List[WsdlMessage] = []
    for message_el in _children(root, "message"):
        name = message_el.get("name")
        if not name:
            continue
        parts: List[WsdlMessagePart] = []
        for part in _children(message_el, "part"):
            part_name = part.get("name")
            if not part_name:
                continue
            parts.append(
                WsdlMessagePart(
                    name=part_name,
                    element=_attr_local(part.get("element")),
                    type_name=_attr_local(part.get("type")),
                )
            )
        messages.append(WsdlMessage(name=name, parts=tuple(parts)))
    return tuple(messages)


def _parse_port_types(root: ET.Element) -> Tuple[WsdlPortType, ...]:
    port_types: List[WsdlPortType] = []
    for port_type_el in _children(root, "portType"):
        name = port_type_el.get("name")
        if not name:
            continue
        operations: List[WsdlOperation] = []
        for operation_el in _children(port_type_el, "operation"):
            op_name = operation_el.get("name")
            if not op_name:
                continue
            input_el = next(iter(_children(operation_el, "input")), None)
            output_el = next(iter(_children(operation_el, "output")), None)
            input_message = _attr_local(input_el.get("message")) if input_el is not None else None
            output_message = _attr_local(output_el.get("message")) if output_el is not None else None
            operations.append(
                WsdlOperation(
                    name=op_name,
                    input_message=input_message,
                    output_message=output_message,
                )
            )
        port_types.append(WsdlPortType(name=name, operations=tuple(operations)))
    return tuple(port_types)


def _parse_services(root: ET.Element) -> Tuple[WsdlService, ...]:
    services: List[WsdlService] = []
    for service_el in _children(root, "service"):
        name = service_el.get("name")
        if not name:
            continue
        ports: List[WsdlPort] = []
        for port_el in _children(service_el, "port"):
            port_name = port_el.get("name")
            binding = _attr_local(port_el.get("binding"))
            if not port_name or not binding:
                continue
            location: Optional[str] = None
            for address in _find_descendants(port_el, "address"):
                location = address.get("location")
                if location:
                    break
            ports.append(WsdlPort(name=port_name, binding=binding, location=location))
        services.append(WsdlService(name=name, ports=tuple(ports)))
    return tuple(services)


def parse_wsdl(content: str, *, source_label: Optional[str] = None) -> WsdlDocument:
    """Parse WSDL XML into a :class:`WsdlDocument`."""
    if not content or not content.strip():
        raise WsdlParseError("Invalid or empty WSDL document")
    if not is_wsdl(content):
        raise WsdlParseError("Content does not appear to be a WSDL document")

    try:
        root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise WsdlParseError(f"Malformed XML: {exc}") from exc
        raise

    if _local(root.tag) != "definitions":
        raise WsdlParseError("WSDL root element must be `definitions`")

    types_el = next(iter(_children(root, "types")), None)
    document = WsdlDocument(
        name=root.get("name"),
        target_namespace=root.get("targetNamespace"),
        complex_types=_parse_complex_types(types_el),
        elements=_parse_elements(types_el),
        messages=_parse_messages(root),
        port_types=_parse_port_types(root),
        services=_parse_services(root),
        raw=content,
    )

    if not document.complex_types and not document.port_types:
        label = f" ({source_label})" if source_label else ""
        raise WsdlParseError(f"No WSDL types or port types found{label}")

    return document
