"""XML-RPC parser.

Parses XML-RPC ``methodCall`` and ``methodResponse`` documents into a typed
:class:`XmlRpcDocument` AST using the stdlib :mod:`xml.etree.ElementTree`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Optional, Tuple

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "XmlRpcParseError",
    "XmlRpcMember",
    "XmlRpcValue",
    "XmlRpcDocument",
    "is_xmlrpc",
    "parse_xmlrpc",
]


class XmlRpcParseError(ValueError):
    """Raised when XML-RPC text cannot be parsed."""


@dataclass(frozen=True)
class XmlRpcMember:
    name: str
    value: "XmlRpcValue"


@dataclass(frozen=True)
class XmlRpcValue:
    """One XML-RPC ``<value>`` payload."""

    kind: str
    text: Optional[str] = None
    members: Tuple[XmlRpcMember, ...] = ()
    items: Tuple["XmlRpcValue", ...] = ()


@dataclass(frozen=True)
class XmlRpcDocument:
    kind: str
    method_name: Optional[str]
    params: Tuple[XmlRpcValue, ...]
    fault_code: Optional[int]
    fault_string: Optional[str]
    raw: str


def is_xmlrpc(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an XML-RPC message."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<wsdl:definitions" in trimmed or (
        "<definitions" in trimmed and "schemas.xmlsoap.org/wsdl" in trimmed
    ):
        return False
    lower = trimmed.lower()
    return "<methodcall" in lower or "<methodresponse" in lower


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _element_children(parent: ET.Element) -> list[ET.Element]:
    return [child for child in parent if isinstance(child.tag, str)]


def _child_by_local(parent: ET.Element, local_name: str) -> Optional[ET.Element]:
    for child in _element_children(parent):
        if _local(child.tag) == local_name:
            return child
    return None


def _children_by_local(parent: ET.Element, local_name: str) -> list[ET.Element]:
    return [child for child in _element_children(parent) if _local(child.tag) == local_name]


def _parse_scalar(kind: str, element: ET.Element) -> XmlRpcValue:
    text = (element.text or "").strip()
    if kind in {"int", "i4", "i8"}:
        return XmlRpcValue(kind="int", text=text)
    if kind == "boolean":
        return XmlRpcValue(kind="boolean", text=text or "0")
    if kind == "double":
        return XmlRpcValue(kind="double", text=text)
    if kind in {"base64", "dateTime.iso8601"}:
        return XmlRpcValue(kind=kind, text=text)
    if kind == "nil":
        return XmlRpcValue(kind="nil")
    return XmlRpcValue(kind="string", text=text)


def _parse_struct(element: ET.Element) -> XmlRpcValue:
    members: list[XmlRpcMember] = []
    for member_el in _children_by_local(element, "member"):
        name_el = _child_by_local(member_el, "name")
        value_el = _child_by_local(member_el, "value")
        if name_el is None or value_el is None:
            continue
        name = (name_el.text or "").strip()
        if not name:
            continue
        members.append(XmlRpcMember(name=name, value=_parse_value(value_el)))
    return XmlRpcValue(kind="struct", members=tuple(members))


def _parse_array(element: ET.Element) -> XmlRpcValue:
    data_el = _child_by_local(element, "data")
    if data_el is None:
        return XmlRpcValue(kind="array", items=())
    items = [_parse_value(value_el) for value_el in _children_by_local(data_el, "value")]
    return XmlRpcValue(kind="array", items=tuple(items))


def _parse_value(value_el: ET.Element) -> XmlRpcValue:
    children = _element_children(value_el)
    if not children:
        return XmlRpcValue(kind="string", text="")
    child = children[0]
    tag = _local(child.tag)
    if tag == "struct":
        return _parse_struct(child)
    if tag == "array":
        return _parse_array(child)
    return _parse_scalar(tag, child)


def _parse_params(parent: ET.Element) -> Tuple[XmlRpcValue, ...]:
    params_el = _child_by_local(parent, "params")
    if params_el is None:
        return ()
    values: list[XmlRpcValue] = []
    for param_el in _children_by_local(params_el, "param"):
        value_el = _child_by_local(param_el, "value")
        if value_el is not None:
            values.append(_parse_value(value_el))
    return tuple(values)


def _parse_fault(parent: ET.Element) -> tuple[Optional[int], Optional[str]]:
    fault_el = _child_by_local(parent, "fault")
    if fault_el is None:
        return None, None
    value_el = _child_by_local(fault_el, "value")
    if value_el is None:
        return None, None
    struct = _parse_value(value_el)
    if struct.kind != "struct":
        return None, None
    fault_code: Optional[int] = None
    fault_string: Optional[str] = None
    for member in struct.members:
        if member.name == "faultCode" and member.value.kind == "int" and member.value.text:
            try:
                fault_code = int(member.value.text)
            except ValueError:
                fault_code = None
        if member.name == "faultString" and member.value.kind == "string":
            fault_string = member.value.text
    return fault_code, fault_string


def parse_xmlrpc(content: str, *, source_label: Optional[str] = None) -> XmlRpcDocument:
    """Parse XML-RPC XML into an :class:`XmlRpcDocument`."""
    if not content or not content.strip():
        raise XmlRpcParseError("Invalid or empty XML-RPC document")
    try:
        root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise XmlRpcParseError(f"Malformed XML-RPC document: {exc}") from exc
        raise

    root_tag = _local(root.tag)
    if root_tag == "methodCall":
        method_el = _child_by_local(root, "methodName")
        method_name = (method_el.text or "").strip() if method_el is not None else None
        if not method_name:
            label = f" ({source_label})" if source_label else ""
            raise XmlRpcParseError(f"XML-RPC methodCall is missing methodName{label}")
        params = _parse_params(root)
        return XmlRpcDocument(
            kind="methodCall",
            method_name=method_name,
            params=params,
            fault_code=None,
            fault_string=None,
            raw=content,
        )

    if root_tag == "methodResponse":
        fault_code, fault_string = _parse_fault(root)
        if fault_code is not None or fault_string is not None:
            return XmlRpcDocument(
                kind="fault",
                method_name=None,
                params=(),
                fault_code=fault_code,
                fault_string=fault_string,
                raw=content,
            )
        params = _parse_params(root)
        return XmlRpcDocument(
            kind="methodResponse",
            method_name=None,
            params=params,
            fault_code=None,
            fault_string=None,
            raw=content,
        )

    label = f" ({source_label})" if source_label else ""
    raise XmlRpcParseError(f"Root element must be methodCall or methodResponse{label}")
