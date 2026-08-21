"""Avro schema parser — MFI-19.1.

Parses Apache Avro ``.avsc`` JSON schemas into a typed :class:`AvroDocument` AST.
Syntax errors surface as :class:`AvroParseError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Mapping, Optional, Tuple

from .import_ingestion import IngestionError, parse_document

if TYPE_CHECKING:  # pragma: no cover - import cycle broken for runtime
    from .avro_idl_parser import AvroProtocol

__all__ = [
    "AvroParseError",
    "AvroNamedSchema",
    "AvroDocument",
    "is_avro",
    "is_avro_document",
    "parse_avro",
]

_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc")
_AVRO_ROOT_TYPES = frozenset({"record", "enum", "fixed"})
_AVRO_PRIMITIVES = frozenset(
    {"null", "boolean", "int", "long", "float", "double", "bytes", "string"}
)


class AvroParseError(ValueError):
    """Raised when Avro schema text cannot be parsed."""


@dataclass(frozen=True)
class AvroNamedSchema:
    name: str
    namespace: Optional[str]
    schema: Dict[str, Any]


@dataclass(frozen=True)
class AvroDocument:
    """One parsed Avro document, from either of Avro's two surfaces.

    ``root``/``types``/``raw`` are what the ``.avsc`` path has always produced. The
    remaining fields are contributed by the Avro IDL reader (FMT-3.5,
    :mod:`app.avro_idl_parser`) and keep their ``.avsc`` defaults otherwise, so a
    JSON-schema import is bit-for-bit the document it always was.

    Attributes:
        root: The document's root named type.
        types: Every named type the document declares, sorted by qualified name.
        raw: The source text.
        protocol: The IDL protocol layer (name, namespace, RPC messages) when the
            source declared one; ``None`` for ``.avsc`` and schema-only IDL.
        doc: A file-level doc comment, which only IDL can carry.
        syntax: Which surface produced this document — ``avsc`` or ``avdl``.
    """

    root: AvroNamedSchema
    types: Tuple[AvroNamedSchema, ...]
    raw: str
    protocol: Optional["AvroProtocol"] = None
    doc: Optional[str] = None
    syntax: str = "avsc"


def _qualified_name(name: str, namespace: Optional[str]) -> str:
    return f"{namespace}.{name}" if namespace else name


def _is_avro_mapping(document: Any) -> bool:
    if not isinstance(document, Mapping):
        return False
    if any(marker in document for marker in _API_MARKERS):
        return False
    schema_type = document.get("type")
    if schema_type == "record" and isinstance(document.get("fields"), list):
        return True
    if schema_type == "enum" and isinstance(document.get("symbols"), list):
        return True
    if schema_type == "fixed" and isinstance(document.get("size"), int):
        return True
    return False


def is_avro_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like an Avro schema."""
    return _is_avro_mapping(document)


def is_avro(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an Avro schema document."""
    if not content or not isinstance(content, str):
        return False
    if not content.strip():
        return False
    try:
        document = parse_document(content)
    except IngestionError:
        return False
    return _is_avro_mapping(document)


def _collect_named_types(
    schema: Any,
    *,
    enclosing_namespace: Optional[str],
    store: Dict[str, Dict[str, Any]],
) -> None:
    if isinstance(schema, list):
        for branch in schema:
            _collect_named_types(branch, enclosing_namespace=enclosing_namespace, store=store)
        return
    if isinstance(schema, str):
        return
    if not isinstance(schema, dict):
        return

    schema_type = schema.get("type")
    namespace = schema.get("namespace") or enclosing_namespace
    name = schema.get("name")

    if schema_type in {"record", "enum", "fixed"} and isinstance(name, str) and name:
        qualified = _qualified_name(name, namespace)
        if qualified not in store:
            store[qualified] = schema
        if schema_type == "record":
            for field in schema.get("fields") or []:
                if isinstance(field, dict):
                    _collect_named_types(field.get("type"), enclosing_namespace=namespace, store=store)
        return

    if schema_type == "array":
        _collect_named_types(schema.get("items"), enclosing_namespace=enclosing_namespace, store=store)
    elif schema_type == "map":
        _collect_named_types(schema.get("values"), enclosing_namespace=enclosing_namespace, store=store)


def parse_avro(content: str, *, source_label: Optional[str] = None) -> AvroDocument:
    """Parse Avro schema JSON into an :class:`AvroDocument`."""
    if not content or not content.strip():
        raise AvroParseError("Invalid or empty Avro schema document")
    try:
        root_schema = parse_document(content, source_label=source_label)
    except IngestionError as exc:
        raise AvroParseError(str(exc)) from exc

    if not _is_avro_mapping(root_schema):
        raise AvroParseError("Content does not appear to be an Avro schema document")

    root_type = root_schema.get("type")
    root_name = root_schema.get("name")
    if not isinstance(root_name, str) or not root_name.strip():
        raise AvroParseError("Avro schema is missing a `name`")
    if root_type not in _AVRO_ROOT_TYPES:
        raise AvroParseError(f"Unsupported Avro root type `{root_type!r}`")

    root_namespace = root_schema.get("namespace") if isinstance(root_schema.get("namespace"), str) else None
    collected: Dict[str, Dict[str, Any]] = {}
    _collect_named_types(root_schema, enclosing_namespace=root_namespace, store=collected)
    if not collected:
        label = f" ({source_label})" if source_label else ""
        raise AvroParseError(f"No Avro named types found{label}")

    types = tuple(
        AvroNamedSchema(
            name=qualified.rsplit(".", 1)[-1],
            namespace=qualified.rsplit(".", 1)[0] if "." in qualified else None,
            schema=schema,
        )
        for qualified, schema in sorted(collected.items())
    )
    root_qualified = _qualified_name(root_name.strip(), root_namespace)
    root = next((t for t in types if _qualified_name(t.name, t.namespace) == root_qualified), types[0])

    return AvroDocument(root=root, types=types, raw=content)
