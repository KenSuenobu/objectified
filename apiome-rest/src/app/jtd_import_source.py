"""JSON Type Definition (JTD, RFC 8927) import source.

The :class:`~app.import_source.ImportSource` adapter that lets a **JTD schema document**
land in the catalog as a schemas-only source. Like JSON Schema it builds the canonical
model directly — JTD is a pure data-schema language with no separate paradigm normalizer.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Type,
    TypeKind,
    TypeRef,
)
from .import_ingestion import IngestionError, parse_document
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)

__all__ = [
    "JtdImportSource",
    "JTD_FORMAT",
    "is_jtd",
    "is_jtd_document",
]

JTD_FORMAT = "jtd"

_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc", "avro")

_JTD_PRIMITIVES = frozenset(
    {
        "boolean",
        "string",
        "timestamp",
        "float32",
        "float64",
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
    }
)

_JSON_SCHEMA_TYPE_MARKERS = frozenset({"object", "array", "integer", "number", "null"})

_JTD_STRONG_KEYS = frozenset(
    {"optionalProperties", "elements", "discriminator", "mapping", "values", "ref"}
)


def _ref_name(ref: str) -> str:
    segment = ref.rstrip("/").rsplit("/", 1)[-1]
    return segment or ref


def _pascal_case(value: str) -> str:
    parts = re.split(r"[_\-\s]+", value.strip())
    return "".join(part[:1].upper() + part[1:] for part in parts if part)


def _inline_type_name(parent: str, field: str) -> str:
    return f"{parent}{_pascal_case(field)}"


def _metadata_description(schema: Dict[str, Any]) -> Optional[str]:
    metadata = schema.get("metadata")
    if isinstance(metadata, dict):
        description = metadata.get("description")
        if isinstance(description, str) and description.strip():
            return description
    return None


def _has_json_schema_markers(document: Dict[str, Any]) -> bool:
    if isinstance(document.get("$schema"), str):
        return True
    if "$defs" in document:
        return True
    if "items" in document:
        return True
    if "$ref" in document:
        return True
    if "oneOf" in document or "anyOf" in document or "allOf" in document:
        return True
    schema_type = document.get("type")
    if isinstance(schema_type, str) and schema_type in _JSON_SCHEMA_TYPE_MARKERS:
        return True
    if isinstance(schema_type, list):
        return any(token in _JSON_SCHEMA_TYPE_MARKERS for token in schema_type)
    defs = document.get("definitions")
    if isinstance(defs, dict):
        for definition in defs.values():
            if isinstance(definition, dict) and _has_json_schema_markers(definition):
                return True
    return False


def _is_jtd_schema_form(schema: Any) -> bool:
    if not isinstance(schema, dict):
        return False
    if any(key in schema for key in ("$schema", "$ref", "items", "oneOf", "anyOf", "allOf", "required")):
        return False
    if any(key in schema for key in _JTD_STRONG_KEYS):
        return True
    schema_type = schema.get("type")
    if isinstance(schema_type, str):
        if schema_type in _JTD_PRIMITIVES:
            return True
        if schema_type in _JSON_SCHEMA_TYPE_MARKERS:
            return False
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and all(isinstance(value, str) for value in enum):
        return True
    properties = schema.get("properties")
    if isinstance(properties, dict):
        if not properties:
            return "optionalProperties" in schema
        return all(_is_jtd_schema_form(value) for value in properties.values())
    return False


def _looks_like_jtd_document(document: Dict[str, Any]) -> bool:
    if any(marker in document for marker in _API_MARKERS):
        return False
    if _has_json_schema_markers(document):
        return False
    if "optionalProperties" in document:
        return True
    if _is_jtd_schema_form(document):
        return True
    definitions = document.get("definitions")
    if isinstance(definitions, dict) and definitions:
        return any(_is_jtd_schema_form(defn) for defn in definitions.values())
    return False


def is_jtd_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like a JTD schema document."""
    return JtdImportSource().detect(DetectionInput(document=document)).matched


def is_jtd(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a JTD schema document."""
    if not content or not isinstance(content, str) or not content.strip():
        return False
    return JtdImportSource().detect(DetectionInput(text=content)).matched


def _enum_values(type_name: str, values: List[Any]) -> List[EnumValue]:
    out: List[EnumValue] = []
    for value in values:
        label = str(value)
        out.append(EnumValue(key=f"{type_name}.{label}", name=label, value=value))
    return out


def _is_inline_record(schema: Dict[str, Any]) -> bool:
    return (
        isinstance(schema.get("properties"), dict) or isinstance(schema.get("optionalProperties"), dict)
    ) and "ref" not in schema and "discriminator" not in schema


def _is_enum_form(schema: Dict[str, Any]) -> bool:
    enum = schema.get("enum")
    return (
        isinstance(enum, list)
        and bool(enum)
        and "properties" not in schema
        and "optionalProperties" not in schema
        and "elements" not in schema
        and "discriminator" not in schema
    )


def _type_ref_for_field(
    parent: str,
    field_name: str,
    schema: Dict[str, Any],
    *,
    nullable: bool,
    inline_names: Dict[int, str],
) -> TypeRef:
    ref = schema.get("ref")
    if isinstance(ref, str) and ref:
        return TypeRef(name=_ref_name(ref), nullable=nullable)

    if _is_enum_form(schema):
        enum_name = inline_names.get(id(schema)) or _inline_type_name(parent, field_name)
        return TypeRef(name=enum_name, nullable=nullable)

    if _is_inline_record(schema):
        record_name = inline_names.get(id(schema)) or _inline_type_name(parent, field_name)
        return TypeRef(name=record_name, nullable=nullable)

    if "elements" in schema:
        elements = schema.get("elements")
        item_ref = (
            _type_ref_for_field(parent, field_name, elements, nullable=False, inline_names=inline_names)
            if isinstance(elements, dict)
            else TypeRef(name="string")
        )
        element_nullable = bool(schema.get("nullable")) or nullable
        return TypeRef(item=item_ref, nullable=element_nullable)

    if "discriminator" in schema and isinstance(schema.get("mapping"), dict):
        return TypeRef(name=_inline_type_name(parent, field_name), nullable=nullable)

    schema_type = schema.get("type")
    if isinstance(schema_type, str) and schema_type in _JTD_PRIMITIVES:
        field_nullable = bool(schema.get("nullable")) or nullable
        return TypeRef(name=schema_type, nullable=field_nullable)

    if "values" in schema:
        return TypeRef(name="object", nullable=nullable)

    return TypeRef(name="string", nullable=nullable)


def _record_fields(
    type_name: str,
    schema: Dict[str, Any],
    *,
    inline_names: Dict[int, str],
) -> List[CanonicalField]:
    fields: List[CanonicalField] = []
    for section, required in (("properties", True), ("optionalProperties", False)):
        properties = schema.get(section)
        if not isinstance(properties, dict):
            continue
        for field_name, field_schema in properties.items():
            if not isinstance(field_schema, dict):
                continue
            ref = _type_ref_for_field(
                type_name,
                str(field_name),
                field_schema,
                nullable=not required,
                inline_names=inline_names,
            )
            fields.append(
                CanonicalField(
                    key=f"{type_name}.{field_name}",
                    name=str(field_name),
                    type=ref,
                    description=_metadata_description(field_schema),
                )
            )
    return fields


def _union_members(schema: Dict[str, Any]) -> List[str]:
    mapping = schema.get("mapping")
    if not isinstance(mapping, dict):
        return []
    members: List[str] = []
    for branch in mapping.values():
        if isinstance(branch, dict) and isinstance(branch.get("ref"), str):
            members.append(_ref_name(branch["ref"]))
    return members


def _build_type(name: str, schema: Dict[str, Any], *, inline_names: Dict[int, str]) -> Type:
    description = _metadata_description(schema)

    if _is_enum_form(schema):
        enum = schema.get("enum")
        assert isinstance(enum, list)
        return Type(
            key=name,
            name=name,
            kind=TypeKind.ENUM,
            description=description,
            enum_values=_enum_values(name, enum),
        )

    if "discriminator" in schema and isinstance(schema.get("mapping"), dict):
        return Type(
            key=name,
            name=name,
            kind=TypeKind.UNION,
            description=description,
            union_members=_union_members(schema),
            extras={"jtd_discriminator": schema.get("discriminator")},
        )

    if isinstance(schema.get("properties"), dict) or isinstance(schema.get("optionalProperties"), dict):
        return Type(
            key=name,
            name=name,
            kind=TypeKind.RECORD,
            description=description,
            fields=_record_fields(name, schema, inline_names=inline_names),
        )

    schema_type = schema.get("type")
    if isinstance(schema_type, str) and schema_type in _JTD_PRIMITIVES:
        return Type(key=name, name=name, kind=TypeKind.SCALAR, description=description)

    return Type(key=name, name=name, kind=TypeKind.SCALAR, description=description)


class _JtdTypeCollector:
    def __init__(self, root_name: str) -> None:
        self._root_name = root_name
        self._types: Dict[str, Type] = {}
        self._seen: Set[str] = set()
        self._inline_names: Dict[int, str] = {}

    @property
    def types(self) -> List[Type]:
        return list(self._types.values())

    def collect(self, document: Dict[str, Any]) -> None:
        definitions = document.get("definitions")
        if isinstance(definitions, dict):
            for def_name, def_schema in definitions.items():
                if isinstance(def_schema, dict):
                    self._register_type(str(def_name), def_schema)

        if self._is_record_form(document) and self._root_name not in self._seen:
            self._register_type(self._root_name, document)

    def _is_record_form(self, schema: Dict[str, Any]) -> bool:
        return (
            isinstance(schema.get("properties"), dict)
            or isinstance(schema.get("optionalProperties"), dict)
            or ("discriminator" in schema and isinstance(schema.get("mapping"), dict))
        )

    def _register_type(self, name: str, schema: Dict[str, Any]) -> None:
        if name in self._seen:
            return
        self._collect_nested_types(name, schema)
        self._seen.add(name)
        self._types[name] = _build_type(name, schema, inline_names=self._inline_names)

    def _collect_nested_types(self, parent: str, schema: Dict[str, Any]) -> None:
        for section in ("properties", "optionalProperties"):
            properties = schema.get(section)
            if not isinstance(properties, dict):
                continue
            for field_name, field_schema in properties.items():
                if not isinstance(field_schema, dict):
                    continue
                if _is_inline_record(field_schema):
                    inline_name = _inline_type_name(parent, str(field_name))
                    self._inline_names[id(field_schema)] = inline_name
                    self._register_type(inline_name, field_schema)
                elif _is_enum_form(field_schema):
                    enum_name = _inline_type_name(parent, str(field_name))
                    self._inline_names[id(field_schema)] = enum_name
                    self._register_type(enum_name, field_schema)
                elif "discriminator" in field_schema and isinstance(field_schema.get("mapping"), dict):
                    union_name = _inline_type_name(parent, str(field_name))
                    self._inline_names[id(field_schema)] = union_name
                    self._register_type(union_name, field_schema)


def _root_name(document: Dict[str, Any], source_label: Optional[str]) -> str:
    metadata = document.get("metadata")
    if isinstance(metadata, dict):
        for key in ("name", "title"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(source_label, str) and source_label.strip():
        stem = source_label.rsplit("/", 1)[-1]
        for suffix in (".jtd.json", ".json"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        if stem:
            return _pascal_case(stem)
    return "Schema"


class JtdImportSource(ImportSource, register=True):
    """Adapter for JSON Type Definition (RFC 8927) → a schemas-only catalog item."""

    key = "jtd"
    label = "JSON Type Definition"
    description = (
        "Import a JSON Type Definition (JTD, RFC 8927) schema into the catalog as a "
        "schemas-only source, kept verbatim for later conversion."
    )
    icon = "braces"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE)
    supports_live_discovery = False
    formats = (JTD_FORMAT, "jsontypedefinition", "rfc8927")
    file_extensions = (".jtd.json", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        document = payload.document
        if document is None and payload.text:
            try:
                document = parse_document(payload.text, source_label=payload.filename)
            except IngestionError:
                return NO_MATCH
        if not isinstance(document, dict):
            return NO_MATCH

        filename = (payload.filename or "").lower()
        if filename.endswith(".jtd.json"):
            if _looks_like_jtd_document(document):
                return DetectionResult(
                    confidence=0.95,
                    format=JTD_FORMAT,
                    reason="`.jtd.json` JTD schema document",
                )
            return DetectionResult(confidence=0.8, format=JTD_FORMAT, reason="`.jtd.json` file extension")

        if not _looks_like_jtd_document(document):
            return NO_MATCH

        if "optionalProperties" in document:
            return DetectionResult(
                confidence=0.95,
                format=JTD_FORMAT,
                reason="`optionalProperties` JTD object schema",
            )
        if "elements" in document:
            return DetectionResult(
                confidence=0.95,
                format=JTD_FORMAT,
                reason="`elements` JTD array schema",
            )
        if "discriminator" in document and "mapping" in document:
            return DetectionResult(
                confidence=0.95,
                format=JTD_FORMAT,
                reason="`discriminator` / `mapping` JTD tagged union",
            )
        if isinstance(document.get("definitions"), dict):
            return DetectionResult(
                confidence=0.9,
                format=JTD_FORMAT,
                reason="`definitions` JTD schema container",
            )
        return DetectionResult(
            confidence=0.85,
            format=JTD_FORMAT,
            reason="JTD structural keywords",
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Dict[str, Any]:
        try:
            document = parse_document(raw, source_label=source_label)
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc
        if not isinstance(document, dict):
            raise ImportSourceError("JTD source must be a JSON/YAML object.")
        return document

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, dict):
            raise ImportSourceError("JTD source must be a JSON/YAML object.")

        document: Dict[str, Any] = native_ast
        root = _root_name(document, None)
        collector = _JtdTypeCollector(root)
        collector.collect(document)

        metadata = document.get("metadata")
        title = None
        description = None
        if isinstance(metadata, dict):
            title_value = metadata.get("title") or metadata.get("name")
            if isinstance(title_value, str) and title_value.strip():
                title = title_value.strip()
            desc_value = metadata.get("description")
            if isinstance(desc_value, str) and desc_value.strip():
                description = desc_value.strip()

        identity_name = title or root
        return CanonicalApi(
            paradigm=self.paradigm,
            format=JTD_FORMAT,
            identity=ApiIdentity(name=identity_name),
            title=title,
            description=description,
            types=collector.types,
            raw={"source": document} if include_raw else None,
        )
