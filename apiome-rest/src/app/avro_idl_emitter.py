"""Avro IDL (``.avdl``) writer — FMT-3.5 (#5430).

The output half of Avro's authored surface. :class:`~app.avro_emitter.AvroEmitter` gained
an ``output_syntax`` option; when it is ``avdl`` the emit is routed here instead of to the
per-type ``.avsc`` writer.

**One canonical→Avro mapping, two spellings.** This module does not re-derive how a
canonical construct becomes Avro — it reuses :class:`~app.avro_emitter._AvroWriter` to
produce the very same schema dicts the ``.avsc`` target emits, then renders those dicts as
IDL text. So the two syntaxes can never disagree about what a model *means*; they differ
only in how it is written down.

What IDL adds over ``.avsc`` is the protocol layer. A model with operations is written as
a ``protocol`` whose RPC ``message`` declarations carry the operations; a model without
them is written in the schema-only form (``namespace a.b;`` followed by bare
declarations) that Avro 1.11.1 introduced. Constructs Avro cannot name at the top level —
maps, unions, and non-``fixed`` scalars — are inlined at their use sites, exactly as the
``.avsc`` writer inlines them.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Type,
    TypeKind,
)
from .emitter import EmittedFile, Provenance, ProvenanceTracker

# ``avro_emitter`` imports this module at module level (it needs :data:`IDL_MEDIA_TYPE`
# on the emitter class), so the few helpers borrowed back from it — the shared name
# sanitizer and the ``fixed`` size reader — are imported inside their callers rather
# than at the top of this file, which would close the cycle.

__all__ = ["IDL_MEDIA_TYPE", "render_avro_idl"]

#: Media type of an emitted ``.avdl`` bundle. Avro registers none, so this follows the
#: ``vnd.`` convention the rest of the emitters use for unregistered text formats.
IDL_MEDIA_TYPE = "text/vnd.apache.avro-idl"

#: Avro schema keywords. Anything else on a schema or field dict is a user-defined
#: property and is written back as an ``@annotation``.
_SCHEMA_KEYWORDS = frozenset(
    {
        "type",
        "name",
        "namespace",
        "doc",
        "aliases",
        "fields",
        "symbols",
        "size",
        "values",
        "items",
        "logicalType",
        "precision",
        "scale",
        "default",
        "order",
    }
)

#: Words the IDL grammar reserves. An identifier that collides with one is backtick-escaped.
_RESERVED_WORDS = frozenset(
    {
        "array",
        "boolean",
        "bytes",
        "date",
        "decimal",
        "double",
        "enum",
        "error",
        "false",
        "fixed",
        "float",
        "idl",
        "import",
        "int",
        "local_timestamp_ms",
        "long",
        "map",
        "namespace",
        "null",
        "oneway",
        "protocol",
        "record",
        "schema",
        "string",
        "throws",
        "time_ms",
        "timestamp_ms",
        "true",
        "union",
        "uuid",
        "void",
    }
)

#: Avro's primitive type names. In a *type* position these are the type, never an
#: identifier, so they are written through unescaped even though several are reserved.
_PRIMITIVE_NAMES = frozenset(
    {"null", "boolean", "int", "long", "float", "double", "bytes", "string"}
)

#: Two spaces per level, matching the indentation Avro's own IDL examples use.
_INDENT = "  "


def render_avro_idl(
    api: CanonicalApi,
    writer: Any,
    *,
    default_namespace: Optional[str],
    tracker: ProvenanceTracker,
) -> List[EmittedFile]:
    """Render one canonical model as a single ``.avdl`` file.

    Args:
        api: The canonical model to emit.
        writer: The :class:`~app.avro_emitter._AvroWriter` that owns the canonical →
            Avro-schema mapping; its schema dicts are what this renderer writes out.
        default_namespace: The namespace the document is written under.
        tracker: Provenance tracker to record emitted constructs against. It is the
            schema writer's own, so the two halves of an Avro emit share one trail.

    Returns:
        A one-entry file list — Avro IDL keeps a whole protocol in one document.
    """
    renderer = _IdlRenderer(
        api, writer, default_namespace=default_namespace, tracker=tracker
    )
    return [renderer.render()]


class _IdlRenderer:
    """One-shot Avro IDL renderer for a single :class:`CanonicalApi`."""

    def __init__(
        self,
        api: CanonicalApi,
        writer: Any,
        *,
        default_namespace: Optional[str],
        tracker: ProvenanceTracker,
    ) -> None:
        self._api = api
        self._writer = writer
        self._namespace = default_namespace
        self._tracker = tracker
        self._types_by_key: Dict[str, Type] = {t.key: t for t in api.types}
        self._operations: List[Operation] = api.operations()
        self._error_keys: Set[str] = _thrown_type_keys(self._operations)

    # --- document ---

    def render(self) -> EmittedFile:
        """Render the whole document and return it as one :class:`EmittedFile`."""
        protocol_name = self._protocol_name()
        is_protocol = bool(self._operations) or bool(self._api.extras.get("avro_protocol"))
        lines: List[str] = []
        lines.extend(_doc_lines(self._api.description, ""))

        if is_protocol:
            lines.extend(self._protocol_header(protocol_name))
            lines.extend(_trim_trailing_blanks(self._body(indent=_INDENT, protocol=True)))
            lines.append("}")
        else:
            if self._namespace:
                lines.append(f"namespace {self._namespace};")
                lines.append("")
            lines.extend(self._body(indent="", protocol=False))

        text = "\n".join(_trim_trailing_blanks(lines)) + "\n"
        return EmittedFile(
            path=_document_path(protocol_name, self._namespace),
            content=text,
            media_type=IDL_MEDIA_TYPE,
        )

    def _protocol_name(self) -> str:
        """Return the protocol/document name, preferring the source's own."""
        declared = self._api.extras.get("avro_protocol")
        if isinstance(declared, str) and declared.strip():
            return _sanitize(declared.strip().rsplit(".", 1)[-1])
        return _sanitize(self._api.identity.name or "Protocol")

    def _protocol_header(self, name: str) -> List[str]:
        """Return the ``@namespace`` / property annotations and the ``protocol`` line."""
        lines: List[str] = []
        if self._namespace:
            lines.append(f'@namespace("{self._namespace}")')
        properties = self._api.extras.get("avro_protocol_properties")
        if isinstance(properties, dict):
            lines.extend(_annotation_lines(properties, ""))
        lines.append(f"protocol {_identifier(name)} {{")
        lines.append("")
        return lines

    def _body(self, *, indent: str, protocol: bool) -> List[str]:
        """Render every declaration, then (for a protocol) every message."""
        lines: List[str] = []
        for type_ in self._declared_types():
            lines.extend(self._declaration(type_, indent))
            lines.append("")
        if protocol:
            for operation in self._operations:
                lines.extend(self._message(operation, indent))
                lines.append("")
        return lines

    def _declared_types(self) -> List[Type]:
        """Return the types that get a top-level IDL declaration, root first.

        Avro IDL can name records, enums, and ``fixed`` types. Maps, unions, and
        non-``fixed`` scalars have no named form and are inlined where they are used —
        the same set the ``.avsc`` writer inlines. The document's own root type is
        emitted first so a schema-only file re-imports with the identity it started with
        (the reader names a protocol-less document after its first declaration).
        """
        declarable = [
            type_
            for type_ in self._api.types
            if type_.kind in (TypeKind.RECORD, TypeKind.ENUM)
            or (type_.kind is TypeKind.SCALAR and _fixed_size(type_) is not None)
        ]
        ordered = sorted(declarable, key=lambda t: t.key)
        root = self._api.extras.get("avro_root")
        if isinstance(root, str) and root:
            for index, type_ in enumerate(ordered):
                if type_.key == root:
                    return [ordered.pop(index), *ordered]
        return ordered

    # --- declarations ---

    def _declaration(self, type_: Type, indent: str) -> List[str]:
        """Render one named type as an IDL declaration."""
        schema = self._writer._emit_named_type(type_)
        self._tracker.record(f"/schemas/{type_.key}", Provenance.SOURCE)
        if not isinstance(schema, dict):  # pragma: no cover - declarable types are dicts
            return []
        lines = _doc_lines(schema.get("doc"), indent)
        lines.extend(self._decoration_lines(schema, indent))
        name = _identifier(str(schema.get("name") or type_.name))
        kind = schema.get("type")
        if kind == "fixed":
            lines.append(f"{indent}fixed {name}({int(schema.get('size') or 0)});")
            return lines
        if kind == "enum":
            symbols = [str(symbol) for symbol in schema.get("symbols") or []]
            lines.append(f"{indent}enum {name} {{")
            for position, symbol in enumerate(symbols):
                comma = "," if position < len(symbols) - 1 else ""
                lines.append(f"{indent}{_INDENT}{symbol}{comma}")
            default_symbol = schema.get("default")
            suffix = f" = {default_symbol};" if isinstance(default_symbol, str) else ""
            lines.append(f"{indent}}}{suffix}")
            return lines
        keyword = "error" if self._is_error(type_) else "record"
        lines.append(f"{indent}{keyword} {name} {{")
        canonical = _fields_by_emitted_name(type_)
        for field in _in_declaration_order(schema.get("fields") or [], type_):
            lines.extend(
                self._field(field, indent + _INDENT, canonical.get(str(field.get("name"))))
            )
        lines.append(f"{indent}}}")
        return lines

    def _is_error(self, type_: Type) -> bool:
        """Whether a record is declared ``error`` — Avro's spelling of a fault type."""
        if type_.extras.get("avro_kind") == "error":
            return True
        return type_.key in self._error_keys

    def _field(
        self,
        field: Dict[str, Any],
        indent: str,
        canonical: Optional[CanonicalField] = None,
    ) -> List[str]:
        """Render one record field declaration.

        Args:
            field: The emitted Avro field dict.
            indent: Leading whitespace for this nesting level.
            canonical: The canonical field it came from, consulted only for decoration
                the Avro JSON form cannot carry (see :meth:`_named_ref_logical_type`).

        Returns:
            The field's IDL lines, doc comment first.
        """
        lines = _doc_lines(field.get("doc"), indent)
        decoration = _decoration(field, skip_aliases=False)
        rendered = self._type_expression(field.get("type"))
        logical = self._named_ref_logical_type(field.get("type"), canonical)
        if logical is not None:
            decoration = {"logicalType": logical, **decoration}
        annotations = _annotations(decoration)
        prefix = f"{' '.join(annotations)} " if annotations else ""
        name = _identifier(str(field.get("name") or ""))
        default = ""
        if "default" in field:
            default = f" = {_json(field['default'])}"
        lines.append(f"{indent}{prefix}{rendered} {name}{default};")
        return lines

    @staticmethod
    def _named_ref_logical_type(
        emitted: Any, canonical: Optional[CanonicalField]
    ) -> Optional[str]:
        """Return a logical type that only the IDL spelling can carry, or ``None``.

        Avro JSON names a type with a bare string, which leaves nowhere to hang a
        ``logicalType`` — so ``@logicalType("duration") Digest`` survives ``.avsc``
        emission only as canonical ``extras``. Avro IDL *can* write it, by annotating
        the reference, so it is recovered here rather than silently dropped.

        Args:
            emitted: The field's emitted Avro type expression.
            canonical: The canonical field, or ``None`` when it could not be paired.

        Returns:
            The logical type to annotate the reference with, or ``None``.
        """
        if canonical is None or not isinstance(emitted, str):
            return None
        if emitted in _PRIMITIVE_NAMES:
            return None
        logical = canonical.extras.get("logicalType")
        return logical if isinstance(logical, str) and logical else None

    def _decoration_lines(self, schema: Dict[str, Any], indent: str) -> List[str]:
        """Render a named type's annotations, one per line."""
        decoration = _decoration(schema, skip_aliases=False)
        namespace = schema.get("namespace")
        if isinstance(namespace, str) and namespace and namespace != self._namespace:
            decoration = {"namespace": namespace, **decoration}
        return _annotation_lines(decoration, indent)

    # --- messages ---

    def _message(self, operation: Operation, indent: str) -> List[str]:
        """Render one canonical operation as an IDL RPC ``message`` declaration."""
        self._tracker.record(f"/messages/{operation.key}", Provenance.SOURCE)
        lines = _doc_lines(operation.description, indent)
        properties = operation.extras.get("avro_properties")
        if isinstance(properties, dict):
            lines.extend(_annotation_lines(properties, indent))
        response = self._response_expression(operation)
        parameters = ", ".join(self._parameters(operation))
        suffix = " oneway" if operation.kind is OperationKind.ONE_WAY else ""
        errors = self._error_names(operation)
        throws = f" throws {', '.join(errors)}" if errors else ""
        name = _identifier(operation.name)
        lines.append(f"{indent}{response} {name}({parameters}){suffix}{throws};")
        return lines

    def _response_expression(self, operation: Operation) -> str:
        """Return the message's declared result type, or ``void``."""
        response = _message_of(operation, MessageRole.RESPONSE)
        if response is None or response.payload is None:
            return "void"
        return self._type_expression(
            self._writer._emit_type_ref(response.payload, namespace=self._namespace)
        )

    def _parameters(self, operation: Operation) -> List[str]:
        """Return the message's positional parameter declarations.

        An Avro-sourced model records the signature verbatim in the request message's
        ``avro_parameters`` extras, so it is written back exactly as declared. A model
        from any other paradigm has only a request payload, which becomes one parameter.
        """
        request = _message_of(operation, MessageRole.REQUEST)
        if request is None:
            return []
        declared = request.extras.get("avro_parameters")
        if isinstance(declared, list) and declared:
            rendered: List[str] = []
            for parameter in declared:
                if not isinstance(parameter, dict):
                    continue
                expression = self._type_expression(parameter.get("type"))
                name = _identifier(str(parameter.get("name") or "arg"))
                default = ""
                if parameter.get("has_default"):
                    default = f" = {_json(parameter.get('default'))}"
                rendered.append(f"{expression} {name}{default}")
            return rendered
        if request.payload is None:
            return []
        expression = self._type_expression(
            self._writer._emit_type_ref(request.payload, namespace=self._namespace)
        )
        return [f"{expression} {_identifier(request.name or 'request')}"]

    def _error_names(self, operation: Operation) -> List[str]:
        """Return the IDL names of the error types a message declares."""
        names: List[str] = []
        for message in operation.messages:
            if message.role is not MessageRole.ERROR or message.payload is None:
                continue
            key = message.payload.name
            if not key:
                continue
            # The *leaf* reference, never ``_emit_type_ref``: an error payload TypeRef is
            # nullable by canonical default, and a null-union is not a throwable type.
            # Written relative to the document namespace, which is how the source wrote it
            # and what keeps the error message key stable across a round trip.
            rendered = _type_name(_relative_name(key, self._namespace))
            if rendered not in names:
                names.append(rendered)
        return names

    # --- type expressions ---

    def _type_expression(self, schema: Any) -> str:
        """Render one Avro schema expression as IDL type syntax.

        Args:
            schema: A primitive name, a named-type reference, a schema dict, or a
                union list — the shapes a ``.avsc`` ``type`` position can hold.

        Returns:
            The IDL spelling of that type.
        """
        if isinstance(schema, str):
            return _type_name(schema)
        if isinstance(schema, list):
            branches = ", ".join(self._type_expression(branch) for branch in schema)
            return f"union {{ {branches} }}"
        if not isinstance(schema, dict):
            return "string"

        kind = schema.get("type")
        if kind == "array":
            return f"array<{self._type_expression(schema.get('items'))}>"
        if kind == "map":
            return f"map<{self._type_expression(schema.get('values'))}>"
        if kind in ("record", "error", "enum", "fixed") and schema.get("name"):
            # A use site never re-declares a named type; it references it.
            namespace = schema.get("namespace")
            name = str(schema.get("name"))
            qualified = f"{namespace}.{name}" if namespace else name
            return _type_name(qualified)

        logical = schema.get("logicalType")
        if logical == "decimal":
            precision = schema.get("precision")
            scale = schema.get("scale")
            if isinstance(precision, int) and isinstance(scale, int):
                return f"decimal({precision}, {scale})"
        base = self._type_expression(kind) if kind is not None else "string"
        annotations = _annotations(
            {
                **({"logicalType": logical} if isinstance(logical, str) and logical else {}),
                **_decoration(schema, skip_aliases=True),
            }
        )
        if not annotations:
            return base
        return f"{' '.join(annotations)} {base}"


# --- helpers ----------------------------------------------------------------------


def _fields_by_emitted_name(type_: Type) -> Dict[str, CanonicalField]:
    """Map a record's emitted (sanitized) field names to their canonical fields."""
    from .avro_emitter import _sanitize_name

    return {_sanitize_name(field.name): field for field in type_.fields}


def _in_declaration_order(
    fields: Sequence[Dict[str, Any]], type_: Type
) -> List[Dict[str, Any]]:
    """Return a record's emitted fields in the order the source declared them.

    Avro field order is semantic — it is the binary encoding order — but the canonical
    model sorts fields by name (``normalize_ordering``) and keeps the declared position
    on ``field_number``. Writing the fields back in that position is therefore both more
    faithful to Avro and what makes a ``.avdl`` round-trip preserve field identity.

    Args:
        fields: The emitted Avro field dicts, in canonical (name) order.
        type_: The canonical type they came from.

    Returns:
        The same dicts, ordered by their source position; ties and unmatched fields keep
        their canonical order.
    """
    from .avro_emitter import _sanitize_name

    positions = {
        _sanitize_name(field.name): field.field_number
        for field in type_.fields
        if field.field_number is not None
    }
    return sorted(
        fields,
        key=lambda entry: positions.get(str(entry.get("name")), len(positions) + 1),
    )


def _relative_name(key: str, namespace: Optional[str]) -> str:
    """Return a type key written relative to ``namespace`` when it sits inside it."""
    if namespace and key.startswith(f"{namespace}."):
        remainder = key[len(namespace) + 1 :]
        if "." not in remainder:
            return remainder
    return key


def _thrown_type_keys(operations: Sequence[Operation]) -> Set[str]:
    """Return the canonical keys of every type used as an operation's error payload.

    Avro requires a type named by ``throws`` to be declared ``error`` rather than
    ``record``, so a model whose fault types are plain records still emits valid IDL.
    """
    keys: Set[str] = set()
    for operation in operations:
        for message in operation.messages:
            if message.role is MessageRole.ERROR and message.payload is not None:
                if message.payload.name:
                    keys.add(message.payload.name)
    return keys


def _message_of(operation: Operation, role: MessageRole) -> Optional[Message]:
    """Return the first message of ``operation`` playing ``role``, or ``None``."""
    for message in operation.messages:
        if message.role is role:
            return message
    return None


def _fixed_size(type_: Type) -> Optional[int]:
    """Return a ``fixed`` byte size from a scalar's extras, or ``None``."""
    from .avro_emitter import _fixed_size as resolve

    return resolve(type_)


def _decoration(schema: Dict[str, Any], *, skip_aliases: bool) -> Dict[str, Any]:
    """Return the annotations a schema or field dict carries beyond the grammar.

    Args:
        schema: The Avro schema or field dict.
        skip_aliases: Whether to leave ``aliases`` out — true in a *type expression*,
            where the annotation would attach to a use site rather than a declaration.

    Returns:
        An ordered annotation map: ``aliases`` and ``order`` first (they are grammar
        keywords with dedicated annotations), then user-defined properties.
    """
    decoration: Dict[str, Any] = {}
    aliases = schema.get("aliases")
    if not skip_aliases and isinstance(aliases, list) and aliases:
        decoration["aliases"] = aliases
    order = schema.get("order")
    if isinstance(order, str) and order:
        decoration["order"] = order
    for key, value in schema.items():
        if key not in _SCHEMA_KEYWORDS:
            decoration[key] = value
    return decoration


def _annotations(decoration: Dict[str, Any]) -> List[str]:
    """Render an annotation map as ``@name(json)`` fragments.

    Annotation names are never backtick-escaped: ``@namespace`` is part of the grammar,
    not an identifier that could shadow a keyword.
    """
    return [f"@{_sanitize(key)}({_json(value)})" for key, value in decoration.items()]


def _annotation_lines(decoration: Dict[str, Any], indent: str) -> List[str]:
    """Render an annotation map one per line at ``indent``."""
    return [f"{indent}{annotation}" for annotation in _annotations(decoration)]


def _doc_lines(doc: Optional[str], indent: str) -> List[str]:
    """Render a doc comment block, or nothing when there is no doc.

    Avro IDL has no escape for ``*/`` inside a comment, so an embedded terminator is
    separated rather than left to close the comment early.
    """
    if not doc or not doc.strip():
        return []
    body = doc.strip().replace("*/", "* /")
    parts = body.splitlines()
    if len(parts) == 1:
        return [f"{indent}/** {parts[0]} */"]
    lines = [f"{indent}/**"]
    lines.extend(f"{indent} * {part}".rstrip() for part in parts)
    lines.append(f"{indent} */")
    return lines


def _json(value: Any) -> str:
    """Render a Python value as the JSON literal Avro IDL expects."""
    try:
        return json.dumps(value, separators=(", ", ": "))
    except (TypeError, ValueError):
        return json.dumps(str(value))


def _sanitize(name: str) -> str:
    """Coerce ``name`` to a legal Avro identifier."""
    from .avro_emitter import _sanitize_name

    return _sanitize_name(name)


def _identifier(name: str) -> str:
    """Return an identifier, backtick-escaped when it collides with a reserved word."""
    sanitized = _sanitize(name)
    return f"`{sanitized}`" if sanitized in _RESERVED_WORDS else sanitized


def _type_name(name: str) -> str:
    """Render a primitive keyword or a (possibly qualified) named-type reference.

    A primitive is the type itself and is written through as-is; a named reference is
    an identifier and is backtick-escaped when it collides with a reserved word, which
    is how a type legitimately named ``record`` stays readable.
    """
    if name in _PRIMITIVE_NAMES:
        return name
    if "." not in name:
        return _identifier(name)
    namespace, simple = name.rsplit(".", 1)
    return f"{namespace}.{_identifier(simple)}"


def _document_path(name: str, namespace: Optional[str]) -> str:
    """Return the deterministic ``.avdl`` path for a rendered document."""
    simple = _sanitize(name) or "protocol"
    if namespace:
        return f"{namespace.replace('.', '/')}/{simple}.avdl"
    return f"{simple}.avdl"


def _trim_trailing_blanks(lines: Iterable[str]) -> List[str]:
    """Drop the blank lines a section separator leaves at the end of a block."""
    out = list(lines)
    while out and not out[-1].strip():
        out.pop()
    return out
