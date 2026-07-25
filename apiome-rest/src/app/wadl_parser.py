"""WADL parser — MFI-17.1.

Parses WADL REST service descriptions into a typed :class:`WadlDocument` AST using
the stdlib :mod:`xml.etree.ElementTree`. Syntax errors surface as
:class:`WadlParseError`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .secure_xml import SecureXmlError, parse_xml

__all__ = [
    "WadlParseError",
    "WadlField",
    "WadlComplexType",
    "WadlElementDecl",
    "WadlParameter",
    "WadlOperation",
    "WadlDocument",
    "is_wadl",
    "parse_wadl",
]

_WADL_NS_MARKERS = (
    "http://wadl.dev.java.net/2009/02",
    "http://wadl.dev.java.net/ns/wadl",
)


class WadlParseError(ValueError):
    """Raised when WADL text cannot be parsed."""


@dataclass(frozen=True)
class WadlField:
    name: str
    type_expr: str


@dataclass(frozen=True)
class WadlComplexType:
    name: str
    fields: Tuple[WadlField, ...]


@dataclass(frozen=True)
class WadlElementDecl:
    name: str
    type_expr: str


@dataclass(frozen=True)
class WadlParameter:
    name: str
    location: str
    type_expr: str
    required: bool = True


@dataclass(frozen=True)
class WadlOperation:
    path: str
    method: str
    operation_id: Optional[str]
    description: Optional[str]
    parameters: Tuple[WadlParameter, ...]
    request_type: Optional[str]
    response_types: Tuple[Tuple[str, Optional[str]], ...]


@dataclass(frozen=True)
class WadlDocument:
    name: str
    target_namespace: Optional[str]
    base_uri: Optional[str]
    complex_types: Tuple[WadlComplexType, ...]
    elements: Tuple[WadlElementDecl, ...]
    operations: Tuple[WadlOperation, ...]
    raw: str


def is_wadl(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a WADL document."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    lowered = trimmed.lower()
    if "<application" not in lowered:
        return False
    return any(marker in trimmed for marker in _WADL_NS_MARKERS)


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


def _join_path(parent: str, segment: str) -> str:
    if not segment:
        return parent or "/"
    if segment.startswith("/"):
        return segment
    base = parent.rstrip("/") if parent else ""
    if not base:
        return f"/{segment}"
    return f"{base}/{segment}"


def _parse_complex_types(grammars_el: Optional[ET.Element]) -> Tuple[WadlComplexType, ...]:
    if grammars_el is None:
        return ()
    complex_types: List[WadlComplexType] = []
    for schema in _find_descendants(grammars_el, "schema"):
        for complex_type in _children(schema, "complexType"):
            name = complex_type.get("name")
            if not name:
                continue
            fields: List[WadlField] = []
            for sequence in _find_descendants(complex_type, "sequence"):
                for field_el in _children(sequence, "element"):
                    field_name = field_el.get("name")
                    type_expr = field_el.get("type")
                    if field_name and type_expr:
                        fields.append(
                            WadlField(
                                name=field_name,
                                type_expr=_attr_local(type_expr) or type_expr,
                            )
                        )
            complex_types.append(WadlComplexType(name=name, fields=tuple(fields)))
    return tuple(complex_types)


def _parse_elements(grammars_el: Optional[ET.Element]) -> Tuple[WadlElementDecl, ...]:
    if grammars_el is None:
        return ()
    elements: List[WadlElementDecl] = []
    for schema in _find_descendants(grammars_el, "schema"):
        for element in _children(schema, "element"):
            name = element.get("name")
            type_expr = element.get("type")
            if name and type_expr:
                elements.append(
                    WadlElementDecl(
                        name=name,
                        type_expr=_attr_local(type_expr) or type_expr,
                    )
                )
    return tuple(elements)


def _param_location(style: Optional[str]) -> str:
    mapping = {
        "template": "path",
        "query": "query",
        "header": "header",
        "matrix": "path",
        "plain": "query",
    }
    return mapping.get((style or "template").lower(), "query")


def _parse_parameters(resource_el: ET.Element) -> Tuple[WadlParameter, ...]:
    params: List[WadlParameter] = []
    for param_el in _children(resource_el, "param"):
        name = param_el.get("name")
        if not name:
            continue
        type_expr = _attr_local(param_el.get("type")) or "string"
        required = param_el.get("required", "true").lower() != "false"
        params.append(
            WadlParameter(
                name=name,
                location=_param_location(param_el.get("style")),
                type_expr=type_expr,
                required=required,
            )
        )
    return tuple(params)


def _resolve_element_type(
    element_ref: Optional[str],
    *,
    element_to_type: dict[str, str],
    type_names: frozenset[str],
) -> Optional[str]:
    if not element_ref:
        return None
    local = _attr_local(element_ref) or element_ref
    mapped = element_to_type.get(local)
    if mapped:
        resolved = _attr_local(mapped) or mapped
        if resolved in type_names:
            return resolved
        return resolved
    if local in type_names:
        return local
    return local


def _extract_representation_type(
    container: Optional[ET.Element],
    *,
    element_to_type: dict[str, str],
    type_names: frozenset[str],
) -> Optional[str]:
    if container is None:
        return None
    for representation in _children(container, "representation"):
        element_ref = representation.get("element")
        resolved = _resolve_element_type(
            element_ref,
            element_to_type=element_to_type,
            type_names=type_names,
        )
        if resolved:
            return resolved
        type_name = _attr_local(representation.get("type"))
        if type_name:
            return type_name if type_name in type_names else type_name
    return None


def _collect_operations(
    resource_el: ET.Element,
    *,
    parent_path: str,
    inherited_params: Tuple[WadlParameter, ...],
    element_to_type: dict[str, str],
    type_names: frozenset[str],
) -> List[WadlOperation]:
    operations: List[WadlOperation] = []
    segment = resource_el.get("path") or ""
    current_path = _join_path(parent_path, segment)
    params = inherited_params + _parse_parameters(resource_el)

    for method_el in _children(resource_el, "method"):
        method_name = (method_el.get("name") or "GET").upper()
        operation_id = method_el.get("id")
        doc_el = next(iter(_children(method_el, "doc")), None)
        description = doc_el.text.strip() if doc_el is not None and doc_el.text else None
        request_el = next(iter(_children(method_el, "request")), None)
        request_type = _extract_representation_type(
            request_el,
            element_to_type=element_to_type,
            type_names=type_names,
        )
        responses: List[Tuple[str, Optional[str]]] = []
        for response_el in _children(method_el, "response"):
            status = response_el.get("status") or "200"
            response_type = _extract_representation_type(
                response_el,
                element_to_type=element_to_type,
                type_names=type_names,
            )
            responses.append((status, response_type))
        operations.append(
            WadlOperation(
                path=current_path,
                method=method_name,
                operation_id=operation_id,
                description=description,
                parameters=params,
                request_type=request_type,
                response_types=tuple(responses),
            )
        )

    for child in _children(resource_el, "resource"):
        operations.extend(
            _collect_operations(
                child,
                parent_path=current_path,
                inherited_params=params,
                element_to_type=element_to_type,
                type_names=type_names,
            )
        )
    return operations


def _document_name(root: ET.Element) -> str:
    doc_el = next(iter(_children(root, "doc")), None)
    if doc_el is not None and doc_el.text and doc_el.text.strip():
        return doc_el.text.strip()
    if root.get("id"):
        return root.get("id") or "WADL API"
    return "WADL API"


def parse_wadl(content: str, *, source_label: Optional[str] = None) -> WadlDocument:
    """Parse WADL XML into a :class:`WadlDocument`."""
    if not content or not content.strip():
        raise WadlParseError("Invalid or empty WADL document")
    if not is_wadl(content):
        raise WadlParseError("Content does not appear to be a WADL document")

    try:
        root = parse_xml(content, source_label=source_label)
    except SecureXmlError as exc:
        if exc.code == "INPUT_MALFORMED":
            raise WadlParseError(f"Malformed XML: {exc}") from exc
        raise

    if _local(root.tag) != "application":
        raise WadlParseError("WADL root element must be `application`")

    grammars_el = next(iter(_children(root, "grammars")), None)
    complex_types = _parse_complex_types(grammars_el)
    elements = _parse_elements(grammars_el)
    element_to_type = {element.name: element.type_expr for element in elements}
    type_names = frozenset(t.name for t in complex_types)

    operations: List[WadlOperation] = []
    base_uri: Optional[str] = None
    for resources_el in _children(root, "resources"):
        base_uri = resources_el.get("base") or base_uri
        for resource_el in _children(resources_el, "resource"):
            operations.extend(
                _collect_operations(
                    resource_el,
                    parent_path="",
                    inherited_params=(),
                    element_to_type=element_to_type,
                    type_names=type_names,
                )
            )

    target_namespace: Optional[str] = None
    if grammars_el is not None:
        for schema in _find_descendants(grammars_el, "schema"):
            target_namespace = schema.get("targetNamespace") or target_namespace

    if not complex_types and not operations:
        label = f" ({source_label})" if source_label else ""
        raise WadlParseError(f"No WADL types or resources found{label}")

    return WadlDocument(
        name=_document_name(root),
        target_namespace=target_namespace,
        base_uri=base_uri,
        complex_types=complex_types,
        elements=elements,
        operations=tuple(operations),
        raw=content,
    )
