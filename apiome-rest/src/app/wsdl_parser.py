"""WSDL parser — MFI-15.1, WSDL 2.0 grammar added by FMT-3.3 (#5428).

Parses SOAP WSDL documents into a typed :class:`WsdlDocument` AST using the stdlib
:mod:`xml.etree.ElementTree` (no external WSDL toolchain). Syntax errors surface as
:class:`WsdlParseError`.

**Two grammars, one AST.** WSDL 1.1 describes a service with ``definitions`` / ``message``
/ ``portType`` / ``port``; WSDL 2.0 replaced that vocabulary with ``description`` /
``interface`` / ``endpoint``, dropped ``message`` entirely (an operation names its payload
*element* directly) and put the transmission primitive on the operation as a message
exchange pattern URI. Both are read into the same :class:`WsdlDocument`: a 2.0
``interface`` becomes a :class:`WsdlPortType`, a 2.0 ``endpoint`` becomes a
:class:`WsdlPort`, and everything downstream of this module — normalizer, lint, diff,
emit — sees one shape and never learns which grammar produced it. The version itself is
recorded on :attr:`WsdlDocument.version` so it can be reported as provenance.

The version is resolved from the root element's *namespace*
(:func:`~app.wsdl_versions.detect_wsdl_version`), never from the root's local name.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Set, Tuple

from .secure_xml import SecureXmlError, parse_xml
from .wsdl_versions import (
    VERSION_1_1,
    VERSION_2_0,
    WSDL_2_0_NAMESPACE,
    detect_wsdl_version,
    version_for_namespace,
)

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
    """Raised when WSDL text cannot be parsed.

    Attributes:
        code: The intake taxonomy code the adapter should report, or ``None`` to let the
            import pipeline classify the failure (which yields ``INPUT_MALFORMED``).
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


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
    """One operation of a ``portType`` (1.1) or ``interface`` (2.0).

    1.1 reaches its payloads through named ``message`` declarations
    (:attr:`input_message` / :attr:`output_message`); 2.0 has no ``message`` element and
    names the payload element directly (:attr:`input_element` / :attr:`output_element`).
    Exactly one of the two pairs is populated, and the normalizer resolves whichever it
    finds to the same canonical payload reference.

    Attributes:
        name: The operation name.
        input_message: 1.1 input ``message`` name (local part), if any.
        output_message: 1.1 output ``message`` name (local part), if any.
        pattern: 2.0 message exchange pattern URI, if any. 1.1 has no MEP vocabulary,
            so a 1.1 operation always leaves this ``None``.
        input_element: 2.0 input payload element name (local part), if any.
        output_element: 2.0 output payload element name (local part), if any.

    Faults are read past rather than recorded: the canonical model has no fault construct,
    and the 1.1 path has never carried ``wsdl:fault``, so keeping 2.0's ``outfault`` here
    would be state nothing downstream can use.
    """

    name: str
    input_message: Optional[str] = None
    output_message: Optional[str] = None
    pattern: Optional[str] = None
    input_element: Optional[str] = None
    output_element: Optional[str] = None


@dataclass(frozen=True)
class WsdlPortType:
    """A 1.1 ``portType`` or a 2.0 ``interface`` — a named set of operations."""

    name: str
    operations: Tuple[WsdlOperation, ...]


@dataclass(frozen=True)
class WsdlPort:
    """A 1.1 ``port`` or a 2.0 ``endpoint`` — a binding at a network address."""

    name: str
    binding: str
    location: Optional[str]


@dataclass(frozen=True)
class WsdlService:
    name: str
    ports: Tuple[WsdlPort, ...]


@dataclass(frozen=True)
class WsdlDocument:
    """A parsed WSDL document, in either grammar.

    Attributes:
        name: The document's ``name`` attribute (1.1 only; 2.0 has none).
        target_namespace: The document's ``targetNamespace``.
        complex_types: Named XSD complex types, including those synthesized for
            anonymous inline definitions.
        elements: Global XSD element declarations, mapped to their type expression.
        messages: 1.1 ``message`` declarations; always empty for 2.0.
        port_types: 1.1 ``portType`` / 2.0 ``interface`` declarations.
        services: Service declarations with their ports/endpoints.
        version: The WSDL grammar the document is written in
            (:data:`~app.wsdl_versions.VERSION_1_1` or
            :data:`~app.wsdl_versions.VERSION_2_0`).
        raw: The original document text.
    """

    name: Optional[str]
    target_namespace: Optional[str]
    complex_types: Tuple[WsdlComplexType, ...]
    elements: Tuple[WsdlElementDecl, ...]
    messages: Tuple[WsdlMessage, ...]
    port_types: Tuple[WsdlPortType, ...]
    services: Tuple[WsdlService, ...]
    raw: str
    version: str = VERSION_1_1


def is_wsdl(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a WSDL document (1.1 or 2.0).

    Args:
        content: Raw document text.

    Returns:
        Whether the text presents as WSDL. A bare ``<description>`` or ``<definitions>``
        root is never enough on its own — the matching WSDL namespace must also be
        present, so a plain XSD or another XML dialect is not claimed.
    """
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if "<wsdl:definitions" in trimmed:
        return True
    if "<definitions" in trimmed and "schemas.xmlsoap.org/wsdl" in trimmed:
        return True
    if "<description" in trimmed and WSDL_2_0_NAMESPACE in trimmed:
        return True
    if "<wsdl:description" in trimmed:
        return True
    return False


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _namespace(tag: str) -> Optional[str]:
    """Return the namespace URI of a qualified tag, or ``None`` when unqualified."""
    return tag[1:].rsplit("}", 1)[0] if tag.startswith("{") else None


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


# ---------------------------------------------------------------------------
# XSD reading (shared by both grammars)
# ---------------------------------------------------------------------------

#: XSD particle elements whose children are field declarations. A particle may nest another
#: particle (``<sequence><choice>...``), which is why they are walked recursively.
_PARTICLES = ("sequence", "all", "choice")

#: Wrappers that stand between a ``complexType`` and its particles when the type derives from
#: another (``<complexContent><extension base="..."><sequence>``). They carry no fields of
#: their own; they are walked through so a derived type still reports its declared fields.
_CONTENT_WRAPPERS = ("complexContent", "simpleContent", "extension", "restriction")


def _unique_type_name(base: str, taken: Set[str]) -> str:
    """Return a type name derived from ``base`` that is not already in ``taken``.

    Anonymous inline complex types are named after the element that declares them, which
    can collide with a named type of the same spelling. Rather than silently merging two
    unrelated shapes, the synthesized name gains a ``Type`` suffix (then ``Type2``, ...).

    Args:
        base: The preferred name.
        taken: Names already used in this document; the chosen name is added to it.

    Returns:
        The unique name.
    """
    candidate = base
    if candidate in taken:
        candidate = f"{base}Type"
        suffix = 2
        while candidate in taken:
            candidate = f"{base}Type{suffix}"
            suffix += 1
    taken.add(candidate)
    return candidate


def _nested_type_name(parent: str, child: str) -> str:
    """Name for an anonymous complex type nested inside ``parent`` under element ``child``.

    Args:
        parent: The owning type's name.
        child: The declaring element's name.

    Returns:
        The concatenated name, e.g. ``order`` + ``line`` -> ``orderLine``.
    """
    return f"{parent}{child[:1].upper()}{child[1:]}" if child else parent


def _content_particles(node: ET.Element) -> List[ET.Element]:
    """Return the particle groups a ``complexType`` declares its fields in.

    A type states its content directly (``<complexType><sequence>``) or through a
    derivation wrapper (``<complexType><complexContent><extension base="...">
    <sequence>``). Both spellings reach the same particles from here, so a derived type is
    not read as if it were empty.

    Args:
        node: The ``xs:complexType`` element.

    Returns:
        Its top-level particle elements, in document order.
    """
    particles: List[ET.Element] = []
    for child in node:
        local = _local(child.tag)
        if local in _PARTICLES:
            particles.append(child)
        elif local in _CONTENT_WRAPPERS:
            particles.extend(_content_particles(child))
    return particles


def _particle_fields(
    particle: ET.Element,
    *,
    owner: str,
    taken: Set[str],
    nested: List[Tuple[ET.Element, str]],
) -> List[WsdlField]:
    """Read the field declarations of one particle group, descending into nested groups.

    Args:
        particle: A ``sequence`` / ``all`` / ``choice`` element.
        owner: Name of the type these fields belong to, used to name anonymous children.
        taken: Names already used in this document; anonymous names are reserved in it.
        nested: Accumulator of ``(inline complexType element, chosen name)`` pairs the
            caller must still read.

    Returns:
        The fields, in document order. An element declaring an inline complex type
        contributes one field referring to a synthesized type rather than being skipped.
    """
    fields: List[WsdlField] = []
    for child in particle:
        local = _local(child.tag)
        if local in _PARTICLES:
            fields.extend(_particle_fields(child, owner=owner, taken=taken, nested=nested))
            continue
        if local != "element":
            continue
        field_name = child.get("name")
        if not field_name:
            continue
        type_expr = child.get("type")
        if type_expr:
            fields.append(WsdlField(name=field_name, type_expr=_attr_local(type_expr) or type_expr))
            continue
        inline = next(iter(_children(child, "complexType")), None)
        if inline is None:
            continue
        nested_name = _unique_type_name(_nested_type_name(owner, field_name), taken)
        fields.append(WsdlField(name=field_name, type_expr=nested_name))
        nested.append((inline, nested_name))
    return fields


def _read_complex_type(
    node: ET.Element,
    *,
    name: str,
    collected: List[WsdlComplexType],
    taken: Set[str],
) -> None:
    """Read one ``complexType`` into ``collected``, recursing into anonymous children.

    Only the type's *own* content is read: an element declaring a nested anonymous complex
    type contributes one field referring to a synthesized type, rather than having that
    type's fields flattened into its parent.

    Args:
        node: The ``xs:complexType`` element.
        name: The name this type is recorded under (already reserved in ``taken``).
        collected: Accumulator the type and any nested types are appended to.
        taken: Names already used in this document.
    """
    fields: List[WsdlField] = []
    nested: List[Tuple[ET.Element, str]] = []
    for particle in _content_particles(node):
        fields.extend(_particle_fields(particle, owner=name, taken=taken, nested=nested))
    collected.append(WsdlComplexType(name=name, fields=tuple(fields)))
    for inline, nested_name in nested:
        _read_complex_type(inline, name=nested_name, collected=collected, taken=taken)


def _read_schemas(
    schemas: List[ET.Element],
) -> Tuple[Tuple[WsdlComplexType, ...], Tuple[WsdlElementDecl, ...]]:
    """Read every named type and global element declaration out of ``schemas``.

    A global element either names its type (``type="tns:Order"``, the WSDL 1.1 idiom) or
    declares it inline (``<xs:element name="order"><xs:complexType>``, the idiom WSDL 2.0
    documents use because they reference elements directly instead of through messages).
    Both end up the same way: the element maps to a named complex type, synthesized from
    the element's own name in the inline case.

    Args:
        schemas: The ``xs:schema`` elements to read, in document order.

    Returns:
        ``(complex_types, elements)``.
    """
    complex_types: List[WsdlComplexType] = []
    elements: List[WsdlElementDecl] = []
    taken: Set[str] = set()

    for schema in schemas:
        for complex_type in _children(schema, "complexType"):
            name = complex_type.get("name")
            if name:
                taken.add(name)
    for schema in schemas:
        for complex_type in _children(schema, "complexType"):
            name = complex_type.get("name")
            if not name:
                continue
            _read_complex_type(complex_type, name=name, collected=complex_types, taken=taken)
        for element in _children(schema, "element"):
            name = element.get("name")
            if not name:
                continue
            type_expr = element.get("type")
            if type_expr:
                elements.append(
                    WsdlElementDecl(name=name, type_expr=_attr_local(type_expr) or type_expr)
                )
                continue
            inline = next(iter(_children(element, "complexType")), None)
            if inline is None:
                continue
            inline_name = _unique_type_name(name, taken)
            elements.append(WsdlElementDecl(name=name, type_expr=inline_name))
            _read_complex_type(inline, name=inline_name, collected=complex_types, taken=taken)

    return tuple(complex_types), tuple(elements)


def _resolve_member(location: str, members: Mapping[str, str]) -> Optional[str]:
    """Resolve an ``xs:import``/``xs:include`` ``schemaLocation`` against fileset members.

    Args:
        location: The declared location, which may be a bare filename or a relative path.
        members: Fileset member name -> text.

    Returns:
        The member's text, or ``None`` when nothing in the set matches.
    """
    if location in members:
        return members[location]
    tail = location.rsplit("/", 1)[-1]
    return members.get(tail)


def _collect_schemas(
    types_el: Optional[ET.Element],
    *,
    members: Optional[Mapping[str, str]],
    source_label: Optional[str],
) -> List[ET.Element]:
    """Return the inline schemas plus every schema a fileset member supplies.

    ``xs:import`` / ``xs:include`` name a sibling document by ``schemaLocation``. Parsed
    alone, a WSDL document has no way to read those; parsed as a fileset it does, which is
    what lets a service that keeps its types in a separate ``.xsd`` import as one API.
    Imports are followed transitively, and a location that resolves to nothing is skipped
    rather than failing the import — an unresolved *schema* leaves dangling type
    references, which lint reports, not an unparseable document.

    Args:
        types_el: The ``types`` element, or ``None`` when the document declares none.
        members: Fileset member name -> text, or ``None`` for a single-document parse.
        source_label: Label used in XML error messages.

    Returns:
        The ``xs:schema`` elements to read, inline ones first.
    """
    if types_el is None:
        return []
    schemas = _find_descendants(types_el, "schema")
    if not members:
        return schemas

    resolved: List[ET.Element] = list(schemas)
    seen: Set[str] = set()
    queue = list(schemas)
    while queue:
        schema = queue.pop(0)
        for ref in _children(schema, "import") + _children(schema, "include"):
            location = (ref.get("schemaLocation") or "").strip()
            if not location or location in seen:
                continue
            seen.add(location)
            text = _resolve_member(location, members)
            if text is None:
                continue
            try:
                member_root = parse_xml(text, source_label=location or source_label)
            except SecureXmlError:
                # A member that cannot be read leaves its types unresolved, exactly as an
                # absent member would; the root document is still importable.
                continue
            member_schemas = (
                [member_root]
                if _local(member_root.tag) == "schema"
                else _find_descendants(member_root, "schema")
            )
            resolved.extend(member_schemas)
            queue.extend(member_schemas)
    return resolved


# ---------------------------------------------------------------------------
# WSDL 1.1 grammar
# ---------------------------------------------------------------------------


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
            output_message = (
                _attr_local(output_el.get("message")) if output_el is not None else None
            )
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


# ---------------------------------------------------------------------------
# WSDL 2.0 grammar
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Interface:
    """A 2.0 ``interface`` before inheritance is flattened."""

    name: str
    extends: Tuple[str, ...]
    operations: Tuple[WsdlOperation, ...]


def _parse_interface_operations(interface_el: ET.Element) -> Tuple[WsdlOperation, ...]:
    """Read the operations declared directly on one ``interface``.

    Args:
        interface_el: The ``interface`` element.

    Returns:
        Its operations, in document order.
    """
    operations: List[WsdlOperation] = []
    for operation_el in _children(interface_el, "operation"):
        op_name = operation_el.get("name")
        if not op_name:
            continue
        input_el = next(iter(_children(operation_el, "input")), None)
        output_el = next(iter(_children(operation_el, "output")), None)
        operations.append(
            WsdlOperation(
                name=op_name,
                pattern=(operation_el.get("pattern") or "").strip() or None,
                input_element=_attr_local(input_el.get("element")) if input_el is not None else None,
                output_element=(
                    _attr_local(output_el.get("element")) if output_el is not None else None
                ),
            )
        )
    return tuple(operations)


def _flatten_interface(
    name: str,
    declared: Dict[str, _Interface],
    seen: Optional[Set[str]] = None,
) -> Tuple[WsdlOperation, ...]:
    """Return an interface's own operations plus everything it inherits.

    WSDL 2.0 interfaces compose by ``extends``, and an endpoint exposes the *whole*
    flattened set, so a reader that only looked at the derived interface would report a
    service with fewer operations than it has. An operation declared on the derived
    interface wins over an inherited one of the same name, and a cycle in ``extends``
    terminates instead of recursing forever.

    Args:
        name: The interface being flattened.
        declared: Every interface in the document, by name.
        seen: Interfaces already visited on this path (cycle guard).

    Returns:
        The flattened operations: inherited first, then the interface's own, deduplicated
        by name.
    """
    seen = set() if seen is None else seen
    interface = declared.get(name)
    if interface is None or name in seen:
        return ()
    seen.add(name)

    by_name: Dict[str, WsdlOperation] = {}
    for base in interface.extends:
        for operation in _flatten_interface(base, declared, seen):
            by_name[operation.name] = operation
    for operation in interface.operations:
        by_name[operation.name] = operation
    return tuple(by_name.values())


def _parse_interfaces(root: ET.Element) -> Tuple[WsdlPortType, ...]:
    """Read every 2.0 ``interface``, with inherited operations flattened in.

    Args:
        root: The ``description`` element.

    Returns:
        One :class:`WsdlPortType` per declared interface, in document order. A name declared
        twice is read once — the last declaration wins, rather than minting two services
        under one key.
    """
    declared: Dict[str, _Interface] = {}
    order: List[str] = []
    for interface_el in _children(root, "interface"):
        name = interface_el.get("name")
        if not name:
            continue
        if name not in declared:
            order.append(name)
        extends = tuple(
            base
            for raw in (interface_el.get("extends") or "").split()
            if (base := _attr_local(raw))
        )
        declared[name] = _Interface(
            name=name,
            extends=extends,
            operations=_parse_interface_operations(interface_el),
        )
    return tuple(
        WsdlPortType(name=name, operations=_flatten_interface(name, declared)) for name in order
    )


def _parse_endpoints(root: ET.Element) -> Tuple[WsdlService, ...]:
    """Read every 2.0 ``service`` and its ``endpoint`` children.

    Args:
        root: The ``description`` element.

    Returns:
        The services, each carrying its endpoints as :class:`WsdlPort` records.
    """
    services: List[WsdlService] = []
    for service_el in _children(root, "service"):
        name = service_el.get("name")
        if not name:
            continue
        ports: List[WsdlPort] = []
        for endpoint_el in _children(service_el, "endpoint"):
            endpoint_name = endpoint_el.get("name")
            binding = _attr_local(endpoint_el.get("binding"))
            if not endpoint_name or not binding:
                continue
            ports.append(
                WsdlPort(
                    name=endpoint_name,
                    binding=binding,
                    location=endpoint_el.get("address"),
                )
            )
        services.append(WsdlService(name=name, ports=tuple(ports)))
    return tuple(services)


def _check_interface_references(root: ET.Element, declared: Set[str]) -> None:
    """Fail the parse when a 2.0 ``binding`` or ``service`` names an absent interface.

    A dangling ``interface`` reference is the 2.0 analogue of a 1.1 binding pointing at a
    missing ``portType``: the document describes a service whose operations cannot be
    resolved, so importing it would put an empty service in the catalog rather than
    reporting the defect.

    Args:
        root: The ``description`` element.
        declared: Names of the interfaces the document declares.

    Raises:
        WsdlParseError: With ``INPUT_REFERENCE_UNRESOLVED`` when a reference is dangling.
    """
    for holder in _children(root, "binding") + _children(root, "service"):
        referenced = _attr_local(holder.get("interface"))
        if referenced is None or referenced in declared:
            continue
        raise WsdlParseError(
            f"WSDL 2.0 {_local(holder.tag)} {holder.get('name')!r} references interface "
            f"{referenced!r}, which the document does not declare",
            code="INPUT_REFERENCE_UNRESOLVED",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse_wsdl(
    content: str,
    *,
    source_label: Optional[str] = None,
    members: Optional[Mapping[str, str]] = None,
) -> WsdlDocument:
    """Parse WSDL XML into a :class:`WsdlDocument`.

    Args:
        content: The raw document text, in either grammar.
        source_label: Label used in error messages (usually the filename).
        members: Sibling documents of a multi-file set, keyed by member name. When given,
            ``xs:import`` / ``xs:include`` locations are resolved against them, so a
            service whose types live in a separate schema imports as one API.

    Returns:
        The parsed document.

    Raises:
        WsdlParseError: When the text is empty, is not WSDL, is malformed XML, has an
            unexpected root element, describes no operations, or (2.0) references an
            interface it does not declare.
    """
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

    # The parsed root's own namespace is authoritative; the text sniff is the fallback
    # for a root that declares none, and matches what detection reported.
    version = (
        version_for_namespace(_namespace(root.tag)) or detect_wsdl_version(content) or VERSION_1_1
    )
    root_name = _local(root.tag)
    expected_root = "description" if version == VERSION_2_0 else "definitions"
    if root_name != expected_root:
        raise WsdlParseError(
            f"WSDL {version} root element must be `{expected_root}`, found `{root_name}`"
        )

    types_el = next(iter(_children(root, "types")), None)
    complex_types, elements = _read_schemas(
        _collect_schemas(types_el, members=members, source_label=source_label)
    )

    if version == VERSION_2_0:
        port_types = _parse_interfaces(root)
        _check_interface_references(root, {port_type.name for port_type in port_types})
        if not port_types:
            label = f" ({source_label})" if source_label else ""
            raise WsdlParseError(
                f"WSDL 2.0 document declares no `interface`, so it describes no "
                f"operations to import{label}",
                code="INPUT_SEMANTIC_INVALID",
            )
        return WsdlDocument(
            name=None,
            target_namespace=root.get("targetNamespace"),
            complex_types=complex_types,
            elements=elements,
            messages=(),
            port_types=port_types,
            services=_parse_endpoints(root),
            raw=content,
            version=VERSION_2_0,
        )

    document = WsdlDocument(
        name=root.get("name"),
        target_namespace=root.get("targetNamespace"),
        complex_types=complex_types,
        elements=elements,
        messages=_parse_messages(root),
        port_types=_parse_port_types(root),
        services=_parse_services(root),
        raw=content,
        version=VERSION_1_1,
    )

    if not document.complex_types and not document.port_types:
        label = f" ({source_label})" if source_label else ""
        raise WsdlParseError(f"No WSDL types or port types found{label}")

    return document
