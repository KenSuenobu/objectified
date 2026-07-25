"""ISO 20022 XML message parser — MFI-22.5.

Parses ISO 20022 financial XML messages into a typed :class:`Iso20022Document` AST using
:mod:`xml.etree.ElementTree`. Syntax errors surface as :class:`Iso20022ParseError`.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "Iso20022ParseError",
    "Iso20022Element",
    "Iso20022Document",
    "is_iso20022",
    "parse_iso20022",
]

_ISO20022_NS_RE = re.compile(r"urn:iso:std:iso:20022:tech:xsd:([\w.]+)", re.IGNORECASE)


class Iso20022ParseError(ValueError):
    """Raised when ISO 20022 XML cannot be parsed."""


@dataclass(frozen=True)
class Iso20022Element:
    tag: str
    text: Optional[str]
    attributes: Tuple[Tuple[str, str], ...]
    children: Tuple["Iso20022Element", ...]


@dataclass(frozen=True)
class Iso20022Document:
    message_id: str
    namespace: str
    root: Iso20022Element
    raw: str


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _namespace_uri(tag: str) -> Optional[str]:
    if tag.startswith("{") and "}" in tag:
        return tag[1:].split("}", 1)[0]
    return None


def is_iso20022(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an ISO 20022 XML message."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<xs:schema" in trimmed or "<xsd:schema" in trimmed:
        return False
    if "schemas.xmlsoap.org/wsdl" in trimmed and "<definitions" in trimmed:
        return False
    if "docs.oasis-open.org/odata" in trimmed and "Edmx" in trimmed:
        return False
    if not _ISO20022_NS_RE.search(trimmed):
        return False
    try:
        root = parse_xml(trimmed)
    except SecureXmlError:
        return False
    if _local(root.tag) != "Document":
        return False
    namespace = _namespace_uri(root.tag)
    if namespace is None:
        xmlns = root.attrib.get("xmlns")
        namespace = xmlns
    return bool(namespace and _ISO20022_NS_RE.search(namespace))


def _element_text(element: ET.Element) -> Optional[str]:
    if element.text and element.text.strip():
        return element.text.strip()
    if not list(element) and element.text is not None:
        stripped = element.text.strip()
        return stripped or None
    return None


def _parse_element(element: ET.Element) -> Iso20022Element:
    children = tuple(_parse_element(child) for child in element)
    return Iso20022Element(
        tag=_local(element.tag),
        text=_element_text(element) if not children else None,
        attributes=tuple(sorted((key, value) for key, value in element.attrib.items())),
        children=children,
    )


def _message_id_from_namespace(namespace: str) -> str:
    match = _ISO20022_NS_RE.search(namespace)
    if match:
        return match.group(1)
    return namespace.rsplit(":", 1)[-1]


def parse_iso20022(content: str, *, source_label: Optional[str] = None) -> Iso20022Document:
    """Parse ISO 20022 XML into an :class:`Iso20022Document`."""
    if not content or not content.strip():
        raise Iso20022ParseError("Invalid or empty ISO 20022 content")

    # Parse before the shape check: ``is_iso20022`` needs a *successful* secure parse
    # to inspect the root tag, so asking it first would report a hostile document
    # (DTD, entity, external reference, over-deep nesting) as merely "not ISO 20022"
    # and lose the security code (IXH-1.4).
    try:
        xml_root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise Iso20022ParseError(f"Invalid XML: {exc}") from exc
        raise

    if not is_iso20022(content):
        raise Iso20022ParseError("Content does not appear to be an ISO 20022 XML message")

    namespace = _namespace_uri(xml_root.tag) or xml_root.attrib.get("xmlns")
    if not namespace or not _ISO20022_NS_RE.search(namespace):
        label = f" ({source_label})" if source_label else ""
        raise Iso20022ParseError(f"Missing ISO 20022 namespace on <Document>{label}")

    root = _parse_element(xml_root)
    if not root.children:
        label = f" ({source_label})" if source_label else ""
        raise Iso20022ParseError(f"No business payload found under <Document>{label}")

    return Iso20022Document(
        message_id=_message_id_from_namespace(namespace),
        namespace=namespace,
        root=root,
        raw=content,
    )


def element_template(element: Iso20022Element) -> Dict[str, object]:
    """Serialize an :class:`Iso20022Element` for round-trip extras."""
    return {
        "tag": element.tag,
        "text": element.text,
        "attributes": [[key, value] for key, value in element.attributes],
        "children": [element_template(child) for child in element.children],
    }
