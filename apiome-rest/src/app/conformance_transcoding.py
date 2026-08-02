"""Wire-format transcoding for cross-format instance conformance — IXH-5.6 (#5118).

The conformance checker (:mod:`app.cross_format_conformance`) takes instances synthesized
against the *source* schema's JSON projection (IXH-5.2) and validates them against an
*emitted* target schema. Two of the validatable targets do not speak JSON on the wire:

* **Avro** — :mod:`fastavro` validates Python object trees whose ``bytes``/``fixed`` values
  are real ``bytes``, while the JSON projection carries opaque binary as base64 text
  (:data:`app.canonical_json_schema.CANONICAL_SCALAR_SCHEMAS`). :func:`transcode_json_to_avro`
  decodes exactly that — nothing else is transformed, so a value the transcode leaves alone is
  judged by the validator, never silently repaired here.
* **XSD** — ``xmllint`` validates XML documents. :func:`transcode_json_to_xml` rebuilds the
  element tree the XSD emitter's grammar describes (element vs. attribute members, repeated
  elements for lists, text content for scalars), driven by the canonical model so the mapping
  is deterministic and inspectable.

The acceptance criterion this module exists for: *wire-format transcoding is explicit and its
own failures are distinguished from conformance failures*. Every transformation lives here,
and anything this module cannot represent raises :class:`TranscodeError` — which the checker
reports as a ``transcode`` failure, never as a schema-conformance verdict.

:func:`build_xsd_validation_harness` is the one deliberate schema-side addition: ``xmllint``
validates a document against a **global element declaration**, and the XSD emitter only
declares one when the source carried an ``xsd_root_element``. The harness appends a global
element per checked entity (referencing the emitted ``complexType`` verbatim) so instance
validation can run; it never alters the types themselves.

Everything here is pure: no I/O, no clock, no network.
"""

from __future__ import annotations

import base64
import binascii
import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

from .canonical_model import CanonicalApi, Type, TypeKind, TypeRef

__all__ = [
    "TranscodeError",
    "build_xsd_validation_harness",
    "transcode_json_to_avro",
    "transcode_json_to_xml",
]

#: W3C XML Schema namespace, mirrored from the XSD emitter.
_XSD_NS = "http://www.w3.org/2001/XMLSchema"

#: Maximum nesting depth a transcode walk descends before giving up. Synthesized instances
#: are bounded by the IXH-5.2 depth limit, so hitting this means a pathological input.
_MAX_TRANSCODE_DEPTH = 32


class TranscodeError(Exception):
    """A value could not be represented on the target's wire format.

    Distinct from a conformance failure by contract: raising this means the *transcoder*
    could not build a target-format payload at all, so the target schema never judged the
    instance.

    Attributes:
        constraint: Short identifier of the wire rule that failed (``base64``, ``xml-scalar``,
            ``xml-structure``, ``depth``).
        pointer: RFC 6901 JSON Pointer to the offending value in the source instance.
    """

    def __init__(self, message: str, *, constraint: str, pointer: str = "") -> None:
        super().__init__(message)
        self.constraint = constraint
        self.pointer = pointer


def _escape_pointer_token(token: str) -> str:
    """Escape one JSON Pointer reference token (RFC 6901)."""
    return token.replace("~", "~0").replace("/", "~1")


def _child_pointer(pointer: str, token: Any) -> str:
    """Extend a JSON Pointer by one token."""
    return f"{pointer}/{_escape_pointer_token(str(token))}"


# ===========================================================================
# JSON → Avro object tree
# ===========================================================================


def transcode_json_to_avro(
    value: Any,
    schema: Any,
    named_schemas: Dict[str, Any],
    *,
    _pointer: str = "",
    _depth: int = 0,
) -> Any:
    """Convert a JSON-projected instance into the object tree ``fastavro`` validates.

    The only transformation performed is decoding base64 text into ``bytes`` where the Avro
    schema demands ``bytes`` or ``fixed`` — the one spot where the JSON projection's wire
    spelling and Avro's object model disagree. Every other value passes through unchanged so
    that type mismatches are judged by the *validator* (a conformance failure), not silently
    absorbed by the transcode.

    Args:
        value: The instance value (or subtree) to convert.
        schema: The parsed Avro (sub)schema the value is aimed at — a ``fastavro``
            ``parse_schema`` product: dict, primitive name, named reference, or union list.
        named_schemas: Fully-qualified name → parsed schema, for resolving named references.

    Returns:
        The converted value.

    Raises:
        TranscodeError: When base64 text demanded as binary does not decode, or the walk
            exceeds :data:`_MAX_TRANSCODE_DEPTH`.
    """
    if _depth > _MAX_TRANSCODE_DEPTH:
        raise TranscodeError(
            "Instance nesting exceeds the transcode depth bound.",
            constraint="depth",
            pointer=_pointer,
        )

    # A named reference ("acme.Pet") or a primitive name ("bytes").
    if isinstance(schema, str):
        resolved = named_schemas.get(schema)
        if resolved is not None and not isinstance(resolved, str):
            return transcode_json_to_avro(
                value, resolved, named_schemas, _pointer=_pointer, _depth=_depth + 1
            )
        if schema in ("bytes", "fixed"):
            return _decode_base64(value, _pointer)
        return value

    # A union: convert against the first branch the value plausibly targets. Only the
    # base64 decode is at stake, so "no branch wants bytes" simply passes the value through.
    if isinstance(schema, list):
        for branch in schema:
            if _union_branch_wants_bytes(branch, named_schemas) and isinstance(value, str):
                return _decode_base64(value, _pointer)
        return value

    if not isinstance(schema, dict):
        return value

    schema_type = schema.get("type")
    if schema_type in ("bytes", "fixed"):
        return _decode_base64(value, _pointer)
    if schema_type == "record" and isinstance(value, dict):
        fields = {f.get("name"): f.get("type") for f in schema.get("fields", [])}
        return {
            key: (
                transcode_json_to_avro(
                    item,
                    fields[key],
                    named_schemas,
                    _pointer=_child_pointer(_pointer, key),
                    _depth=_depth + 1,
                )
                if key in fields
                else item
            )
            for key, item in value.items()
        }
    if schema_type == "array" and isinstance(value, list):
        items = schema.get("items")
        return [
            transcode_json_to_avro(
                item,
                items,
                named_schemas,
                _pointer=_child_pointer(_pointer, index),
                _depth=_depth + 1,
            )
            for index, item in enumerate(value)
        ]
    if schema_type == "map" and isinstance(value, dict):
        values = schema.get("values")
        return {
            key: transcode_json_to_avro(
                item,
                values,
                named_schemas,
                _pointer=_child_pointer(_pointer, key),
                _depth=_depth + 1,
            )
            for key, item in value.items()
        }
    return value


def _union_branch_wants_bytes(branch: Any, named_schemas: Dict[str, Any]) -> bool:
    """Whether one union branch is a ``bytes``/``fixed`` schema (resolving named refs)."""
    if isinstance(branch, str):
        resolved = named_schemas.get(branch)
        if resolved is not None and not isinstance(resolved, str):
            branch = resolved
        else:
            return branch in ("bytes", "fixed")
    if isinstance(branch, dict):
        return branch.get("type") in ("bytes", "fixed")
    return False


def _decode_base64(value: Any, pointer: str) -> Any:
    """Decode base64 text into ``bytes``; non-text values pass through for the validator."""
    if not isinstance(value, str):
        return value
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError) as exc:
        raise TranscodeError(
            f"Value is not valid base64, so it cannot be carried as Avro binary: {exc}",
            constraint="base64",
            pointer=pointer,
        ) from exc


# ===========================================================================
# JSON → XML document
# ===========================================================================


def transcode_json_to_xml(
    api: CanonicalApi,
    type_: Type,
    instance: Any,
    *,
    target_namespace: Optional[str] = None,
) -> str:
    """Render a JSON-projected record instance as the XML document the XSD emitter describes.

    The element tree mirrors the emitted grammar exactly: one root element named after the
    record type, one child element per member (in the emitter's ``field_number`` order),
    members flagged ``xsd_kind: attribute`` as XML attributes, list values as repeated
    elements, nested records recursed, scalars as text content. ``None`` values are omitted
    (the projection treats nullable as absent).

    Args:
        api: The canonical model, for resolving nested named types.
        type_: The RECORD type the instance was synthesized for.
        instance: The instance value; must be a JSON object.
        target_namespace: The schema's ``targetNamespace``, applied as the document's default
            namespace so qualified-element validation matches.

    Returns:
        The serialized XML document text.

    Raises:
        TranscodeError: When the instance holds a shape XML cannot carry under the emitted
            grammar (a non-object root, a structured value where text is required, a map or
            union member, or an attribute holding a non-scalar).
    """
    if not isinstance(instance, dict):
        raise TranscodeError(
            "Only object instances have an XML element mapping; the root value is "
            f"{type(instance).__name__}.",
            constraint="xml-structure",
            pointer="",
        )
    types_by_key = {t.key: t for t in api.types if t.key}
    types_by_name: Dict[str, List[Type]] = {}
    for candidate in api.types:
        if candidate.name:
            types_by_name.setdefault(candidate.name, []).append(candidate)

    root = ET.Element(type_.name)
    if target_namespace:
        root.set("xmlns", str(target_namespace))
    _populate_record_element(
        root, type_, instance, types_by_key, types_by_name, pointer="", depth=0
    )
    return ET.tostring(root, encoding="unicode")


def _populate_record_element(
    element: ET.Element,
    type_: Type,
    value: Dict[str, Any],
    types_by_key: Dict[str, Type],
    types_by_name: Dict[str, List[Type]],
    *,
    pointer: str,
    depth: int,
) -> None:
    """Fill one record element with attributes and child elements, in emitted order."""
    if depth > _MAX_TRANSCODE_DEPTH:
        raise TranscodeError(
            "Instance nesting exceeds the transcode depth bound.",
            constraint="depth",
            pointer=pointer,
        )
    fields_by_name = {member.name: member for member in type_.fields if member.name}

    # Attributes first (order among attributes is irrelevant to XSD validation).
    for member in type_.fields:
        if member.extras.get("xsd_kind") != "attribute" or member.name not in value:
            continue
        item = value[member.name]
        if item is None:
            continue
        member_pointer = _child_pointer(pointer, member.name)
        if isinstance(item, (dict, list)):
            raise TranscodeError(
                f"Member {member.name!r} is declared as an XML attribute but holds a "
                "structured value.",
                constraint="xml-structure",
                pointer=member_pointer,
            )
        element.set(member.name, _scalar_text(item, member_pointer))

    # Child elements in the same order the emitter writes the ``xs:sequence``.
    element_members = [
        member
        for member in type_.fields
        if member.name and member.extras.get("xsd_kind") != "attribute"
    ]
    for member in sorted(element_members, key=lambda item: item.field_number or 0):
        if member.name not in value:
            continue
        item = value[member.name]
        if item is None:
            continue
        member_pointer = _child_pointer(pointer, member.name)
        occurrences = item if isinstance(item, list) else [item]
        base_pointer = member_pointer
        for index, occurrence in enumerate(occurrences):
            occurrence_pointer = (
                _child_pointer(base_pointer, index) if isinstance(item, list) else base_pointer
            )
            child = ET.SubElement(element, member.name)
            _populate_value_element(
                child,
                member.type.item if member.type.is_list() else member.type,
                occurrence,
                types_by_key,
                types_by_name,
                pointer=occurrence_pointer,
                depth=depth + 1,
            )
    # Members present in the instance but unknown to the type are appended as trailing
    # elements so the *validator* reports them — dropping them would hide the very loss
    # this check exists to surface.
    for key, item in value.items():
        if key in fields_by_name or item is None:
            continue
        child = ET.SubElement(element, str(key))
        if isinstance(item, (dict, list)):
            child.text = ""
        else:
            child.text = _scalar_text(item, _child_pointer(pointer, key))


def _populate_value_element(
    element: ET.Element,
    ref: Optional[TypeRef],
    value: Any,
    types_by_key: Dict[str, Type],
    types_by_name: Dict[str, List[Type]],
    *,
    pointer: str,
    depth: int,
) -> None:
    """Render one occurrence of a member value into its element."""
    if depth > _MAX_TRANSCODE_DEPTH:
        raise TranscodeError(
            "Instance nesting exceeds the transcode depth bound.",
            constraint="depth",
            pointer=pointer,
        )
    target = _resolve_named_type(ref, types_by_key, types_by_name)
    if target is not None and target.kind is TypeKind.RECORD:
        if not isinstance(value, dict):
            raise TranscodeError(
                f"A {target.name!r} element requires an object value, got "
                f"{type(value).__name__}.",
                constraint="xml-structure",
                pointer=pointer,
            )
        _populate_record_element(
            element, target, value, types_by_key, types_by_name, pointer=pointer, depth=depth
        )
        return
    if target is not None and target.kind in (TypeKind.MAP, TypeKind.UNION):
        raise TranscodeError(
            f"Member type {target.name!r} ({target.kind.value}) has no XML wire mapping in "
            "the emitted grammar.",
            constraint="xml-structure",
            pointer=pointer,
        )
    if isinstance(value, dict) or isinstance(value, list):
        raise TranscodeError(
            "A structured value cannot be carried as XML text content.",
            constraint="xml-structure",
            pointer=pointer,
        )
    element.text = _scalar_text(value, pointer)


def _resolve_named_type(
    ref: Optional[TypeRef],
    types_by_key: Dict[str, Type],
    types_by_name: Dict[str, List[Type]],
) -> Optional[Type]:
    """Resolve a leaf reference to a named model type, when it unambiguously names one."""
    if ref is None or not ref.name:
        return None
    direct = types_by_key.get(ref.name)
    if direct is not None:
        return direct
    candidates = types_by_name.get(ref.name, [])
    if len(candidates) == 1:
        return candidates[0]
    return None


def _scalar_text(value: Any, pointer: str) -> str:
    """Render a scalar as XML text content (XSD lexical forms)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, str):
        return value
    raise TranscodeError(
        f"Value of type {type(value).__name__} has no XML text form.",
        constraint="xml-scalar",
        pointer=pointer,
    )


# ===========================================================================
# XSD validation harness
# ===========================================================================

#: Matches the closing tag of the schema element regardless of the bound prefix.
_SCHEMA_CLOSE_RE = re.compile(r"</(?:[A-Za-z_][\w.-]*:)?schema\s*>")


def build_xsd_validation_harness(
    schema_text: str, element_types: Dict[str, str]
) -> Optional[str]:
    """Append global element declarations so ``xmllint`` can validate entity documents.

    ``xmllint --schema`` matches a document's root element against the schema's **global
    element declarations**. The XSD emitter declares complex types for every record but a
    global element only when the source carried one, so most entities would be unvalidatable
    as documents. This adds one ``<xs:element name="T" type="tns:T"/>`` per requested entity
    — referencing the emitted type untouched — and only for names not already declared.

    Args:
        schema_text: The emitted XSD document text.
        element_types: Element name → emitted type name to declare globally.

    Returns:
        The harness schema text, or ``None`` when the schema element cannot be located (an
        empty or malformed emission — the caller reports the target as not validated).
    """
    try:
        root = ET.fromstring(schema_text)
    except ET.ParseError:
        return None
    if root.tag != f"{{{_XSD_NS}}}schema":
        return None

    declared = {
        child.get("name")
        for child in root
        if child.tag == f"{{{_XSD_NS}}}element" and child.get("name")
    }
    has_target_ns = bool(root.get("targetNamespace"))

    close_match = None
    for close_match in _SCHEMA_CLOSE_RE.finditer(schema_text):
        pass  # keep the last match: the document's closing schema tag
    if close_match is None:
        return None
    prefix_match = re.match(r"</([A-Za-z_][\w.-]*):schema", close_match.group(0))
    xs_prefix = prefix_match.group(1) if prefix_match else None

    declarations: List[str] = []
    for name in sorted(element_types):
        if name in declared:
            continue
        type_name = element_types[name]
        type_ref = f"tns:{type_name}" if has_target_ns else type_name
        tag = f"{xs_prefix}:element" if xs_prefix else "element"
        declarations.append(f'<{tag} name="{name}" type="{type_ref}"/>')
    if not declarations:
        return schema_text

    insertion = "".join(declarations)
    start = close_match.start()
    return schema_text[:start] + insertion + schema_text[start:]
