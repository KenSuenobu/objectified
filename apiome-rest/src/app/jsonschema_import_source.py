"""JSON Schema import source — MFI-26.7 (#4102).

The :class:`~app.import_source.ImportSource` adapter that lets a **JSON Schema 2020-12
document (or a variant)** land in the catalog as a *schemas-only* source. It is the
"Import into Catalog" half of the MFI-26.7 disambiguation prompt: when the importer
detects JSON Schema it asks the user whether the document is a catalog artifact (for
later conversion) or a type/schema imported *as current* into Types/Projects — this
adapter is what the **Catalog** choice runs through.

Like the other catalog adapters (gRPC/Protobuf, GraphQL, AsyncAPI) it wraps the shared
pipeline rather than reimplementing it: it declares its descriptor, sniffs the format
cheaply in :meth:`detect`, parses the raw document to a mapping in :meth:`parse`, and
maps that mapping onto the paradigm-agnostic
:class:`~app.canonical_model.CanonicalApi` in :meth:`normalize`. Because it emits the
:class:`~app.canonical_model.ApiParadigm.DATA_SCHEMA` paradigm with no operations or
channels, the shared router (:func:`app.import_routing.decide_import_routing`) already
routes it to a **non-publishable, schemas-only catalog item**, and the persistence hook
(:func:`app.import_source_pipeline.persist_adapter_import`) keeps the *original source
verbatim* for later conversion — nothing is converted at import time.

**Why a direct normalizer.** JSON Schema is a pure data-schema language, not an API
description, so there is no separate paradigm normalizer to delegate to (unlike the
OpenAPI/GraphQL/AsyncAPI adapters). :meth:`normalize` builds the canonical model
directly from the document's ``$defs`` / ``definitions`` (and the root schema), which is
all the catalog needs — the raw bytes are what a later Convert flow reads.

Registering this adapter (``register=True``) is all the source list, the CLI, and the
``/v1/import/detect`` endpoint need: the source registry
(:mod:`app.import_sources_routes`) and auto-detection
(:func:`app.format_detection.detect_format`) are both data-driven off the registry, so a
JSON Schema document now auto-detects with ``importable: true`` and the ``data_schema``
paradigm with no other change. The **prompt** itself lives in the UI
(``CatalogImportDialog``): the client keeps JSON Schema out of its adapter map so it
routes to the choice step rather than storing silently, then runs *this* adapter only
when the user explicitly picks Catalog.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

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
    "JsonSchemaImportSource",
    "JSON_SCHEMA_FORMAT",
    "is_jsonschema",
    "is_jsonschema_document",
]

#: The emitted canonical format key for a JSON Schema import. It folds to the
#: ``json-schema`` family the UI routing (``catalog-import-formats.ts``) recognizes, so
#: the disambiguation prompt still fires regardless of the detected dialect.
JSON_SCHEMA_FORMAT = "json-schema"

#: Top-level keys that mark a document as *another* format the pipeline handles through
#: its own adapter/sniffer. An OpenAPI 3.1 document *is* JSON Schema, so this adapter
#: must decline anything carrying an API-description discriminator to avoid stealing it.
_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc", "avro")

#: Keys that never appear in JSON Schema but mark JSON Type Definition forms. Without
#: this, a JTD object schema's ``properties`` map is mistaken for a JSON Schema document
#: and format detection reports a false ambiguity (or wrong winner).
_JTD_EXCLUSIVE_KEYS = frozenset(
    {"optionalProperties", "elements", "values", "mapping"}
)

#: The ``type`` keyword values that are valid JSON Schema types. A structural sniff on
#: ``type`` matches only these, so an arbitrary JSON object with a domain ``type`` field
#: (e.g. ``{"type": "user"}``) is not mistaken for a schema.
_JSON_SCHEMA_TYPES = frozenset(
    {"string", "number", "integer", "boolean", "array", "object", "null"}
)

#: Keys that identify a mapping as (part of) a JSON Schema document when no ``$schema``
#: dialect marker is present. ``$defs`` / ``definitions`` / ``properties`` are the
#: strongest structural signals.
_SCHEMA_CONTAINER_KEYS = ("$defs", "definitions", "properties")


def _ref_name(ref: str) -> str:
    """Return the trailing name segment of a JSON Pointer / ``$ref`` string.

    ``#/$defs/User`` → ``User``; a bare fragment or empty ref falls back to the ref
    text itself so a reference is always nameable.
    """
    segment = ref.rstrip("/").rsplit("/", 1)[-1]
    return segment or ref


def _name_from_id(schema_id: Any) -> Optional[str]:
    """Derive a human name from a schema ``$id`` URI, or ``None`` when absent.

    Strips a trailing ``.json`` / ``.schema.json`` extension and any URL fragment so
    ``https://acme.test/user.schema.json`` yields ``user``.
    """
    if not isinstance(schema_id, str) or not schema_id.strip():
        return None
    tail = schema_id.split("#", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    for suffix in (".schema.json", ".json"):
        if tail.endswith(suffix):
            tail = tail[: -len(suffix)]
            break
    return tail or None


def _type_ref_for(schema: Any) -> TypeRef:
    """Best-effort map a JSON Schema property/value onto a canonical :class:`TypeRef`.

    Resolves ``$ref`` to the referenced type name, wraps ``type: array`` as a list ref
    over its ``items``, and folds a ``type`` list such as ``["string", "null"]`` to its
    primary type with ``nullable=True``. Anything unrecognized becomes an ``object``
    reference — the raw document, not this shallow ref, is the fidelity source.
    """
    if not isinstance(schema, dict):
        return TypeRef(name="object")

    ref = schema.get("$ref")
    if isinstance(ref, str) and ref:
        return TypeRef(name=_ref_name(ref))

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        nullable = "null" in schema_type
        primary = next((t for t in schema_type if t != "null"), None)
        if primary == "array":
            return TypeRef(item=_type_ref_for(schema.get("items") or {}), nullable=nullable)
        return TypeRef(name=str(primary) if primary else "object", nullable=nullable)

    if schema_type == "array":
        return TypeRef(item=_type_ref_for(schema.get("items") or {}))

    if isinstance(schema_type, str):
        return TypeRef(name=schema_type)

    return TypeRef(name="object")


def _enum_values(type_name: str, values: List[Any]) -> List[EnumValue]:
    """Build canonical :class:`EnumValue`s for a JSON Schema ``enum`` list."""
    out: List[EnumValue] = []
    for value in values:
        label = str(value)
        out.append(EnumValue(key=f"{type_name}.{label}", name=label, value=value))
    return out


def _record_fields(type_name: str, schema: Dict[str, Any]) -> List[CanonicalField]:
    """Build canonical fields from a schema's ``properties``, honoring ``required``.

    A property absent from ``required`` is nullable (optional). Nested schemas are
    referenced shallowly via :func:`_type_ref_for`; the raw document preserves full
    fidelity for the later Convert flow.
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return []
    required = schema.get("required")
    required_set = set(required) if isinstance(required, list) else set()

    fields: List[CanonicalField] = []
    for prop_name, prop_schema in properties.items():
        ref = _type_ref_for(prop_schema)
        # A `required` property is non-nullable at this use site; any other is optional. Set the
        # flag explicitly — `TypeRef` defaults to ``nullable=True``, so a required field must clear it.
        ref = ref.model_copy(update={"nullable": prop_name not in required_set})
        description = prop_schema.get("description") if isinstance(prop_schema, dict) else None
        fields.append(
            CanonicalField(
                key=f"{type_name}.{prop_name}",
                name=prop_name,
                type=ref,
                description=description if isinstance(description, str) else None,
            )
        )
    return fields


def _union_members(schema: Dict[str, Any]) -> List[str]:
    """Return the named members of a ``oneOf`` / ``anyOf`` composition, in order."""
    members: List[str] = []
    for keyword in ("oneOf", "anyOf"):
        branches = schema.get(keyword)
        if not isinstance(branches, list):
            continue
        for branch in branches:
            if isinstance(branch, dict) and isinstance(branch.get("$ref"), str):
                members.append(_ref_name(branch["$ref"]))
    return members


def _build_type(name: str, schema: Dict[str, Any]) -> Type:
    """Map one named JSON Schema (a ``$defs`` entry or the root) onto a canonical :class:`Type`.

    Chooses the structural family from the schema's keywords: an ``enum`` becomes an
    ENUM, a ``oneOf`` / ``anyOf`` a UNION, an ``object`` / ``properties`` schema a
    RECORD, a lone ``$ref`` an ALIAS, and anything else a SCALAR leaf.
    """
    description = schema.get("description")
    description = description if isinstance(description, str) else None

    enum = schema.get("enum")
    if isinstance(enum, list) and "properties" not in schema:
        return Type(
            key=name,
            name=name,
            kind=TypeKind.ENUM,
            description=description,
            enum_values=_enum_values(name, enum),
        )

    if isinstance(schema.get("oneOf"), list) or isinstance(schema.get("anyOf"), list):
        return Type(
            key=name,
            name=name,
            kind=TypeKind.UNION,
            description=description,
            union_members=_union_members(schema),
        )

    if schema.get("type") == "object" or "properties" in schema:
        return Type(
            key=name,
            name=name,
            kind=TypeKind.RECORD,
            description=description,
            fields=_record_fields(name, schema),
        )

    if isinstance(schema.get("$ref"), str):
        return Type(
            key=name,
            name=name,
            kind=TypeKind.ALIAS,
            description=description,
            aliased=_type_ref_for(schema),
        )

    return Type(key=name, name=name, kind=TypeKind.SCALAR, description=description)


def _has_schema_keywords(document: Dict[str, Any]) -> bool:
    """Whether the root mapping itself looks like a schema (not just a ``$defs`` box)."""
    if any(key in document for key in _SCHEMA_CONTAINER_KEYS):
        return True
    if any(key in document for key in ("$ref", "allOf", "oneOf", "anyOf", "enum", "items")):
        return True
    schema_type = document.get("type")
    if isinstance(schema_type, str):
        return schema_type in _JSON_SCHEMA_TYPES
    if isinstance(schema_type, list):
        return any(t in _JSON_SCHEMA_TYPES for t in schema_type)
    return False


def is_jsonschema_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like a JSON Schema document."""
    return JsonSchemaImportSource().detect(DetectionInput(document=document)).matched


def is_jsonschema(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a JSON Schema document."""
    if not content or not isinstance(content, str) or not content.strip():
        return False
    return JsonSchemaImportSource().detect(DetectionInput(text=content)).matched


class JsonSchemaImportSource(ImportSource, register=True):
    """Adapter for JSON Schema 2020-12 (and variants) → a schemas-only catalog item."""

    key = "json-schema"
    label = "JSON Schema"
    description = (
        "Import a JSON Schema (2020-12 and variants) into the catalog as a schemas-only "
        "source, kept verbatim for later conversion."
    )
    icon = "braces"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE)
    supports_live_discovery = False
    formats = (JSON_SCHEMA_FORMAT, "jsonschema", "json-schema-2020-12")
    file_extensions = (".schema.json", ".json")
    # A JSON Schema bundle commonly ``$ref``\s sibling schemas by URL; this adapter parses a
    # single mapping, so those definitions are missing from the model unless the import opts
    # into the MFI-29.4 remote resolver (which inlines them before parse).
    supports_remote_refs = True

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize a JSON Schema document (dialect marker or structural keywords).

        Reads the already-parsed ``document`` when present, else parses ``text`` cheaply with
        the YAML/JSON loader (a malformed document is simply not a match, never raised).
        Declines any document carrying an API-description discriminator
        (:data:`_API_MARKERS`) so an OpenAPI/Swagger/AsyncAPI/Arazzo document — which may
        *contain* JSON Schema — is left to its own adapter/sniffer. A ``$schema`` pointing
        at ``json-schema.org`` is the strongest signal; ``$defs`` / ``definitions`` /
        ``properties`` and a valid ``type`` keyword are the structural fallbacks. Never
        raises: an unrecognized input returns :data:`NO_MATCH`.
        """
        document = payload.document
        if document is None and payload.text:
            try:
                document = parse_document(payload.text, source_label=payload.filename)
            except IngestionError:
                return NO_MATCH
        if not isinstance(document, dict):
            return NO_MATCH
        if any(marker in document for marker in _API_MARKERS):
            return NO_MATCH
        # Leave JTD documents to the JTD adapter (structural ``properties`` is shared).
        if any(key in document for key in _JTD_EXCLUSIVE_KEYS):
            return NO_MATCH
        if "ref" in document and "$ref" not in document:
            return NO_MATCH

        schema_marker = document.get("$schema")
        if isinstance(schema_marker, str) and "json-schema.org" in schema_marker:
            fmt = "json-schema-2020-12" if "2020-12" in schema_marker else JSON_SCHEMA_FORMAT
            dialect = "2020-12" if "2020-12" in schema_marker else "dialect"
            return DetectionResult(
                confidence=0.95, format=fmt, reason=f"`$schema` JSON Schema {dialect} marker"
            )

        if isinstance(document.get("$defs"), dict) or isinstance(document.get("definitions"), dict):
            return DetectionResult(
                confidence=0.7,
                format=JSON_SCHEMA_FORMAT,
                reason="`$defs`/`definitions` schema container",
            )
        if isinstance(document.get("properties"), dict):
            return DetectionResult(
                confidence=0.7, format=JSON_SCHEMA_FORMAT, reason="`properties` object schema"
            )
        if _has_schema_keywords(document):
            return DetectionResult(
                confidence=0.55, format=JSON_SCHEMA_FORMAT, reason="JSON Schema structural keywords"
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Dict[str, Any]:
        """Parse the raw document (JSON or YAML) into the schema mapping.

        Returns:
            The parsed JSON Schema document as a mapping — the native AST
            :meth:`normalize` consumes.

        Raises:
            ImportSourceError: If the text is empty or not a JSON/YAML mapping.
        """
        try:
            return parse_document(raw, source_label=source_label)
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Map a JSON Schema document onto the canonical model (paradigm DATA_SCHEMA).

        Each ``$defs`` / ``definitions`` entry becomes a named canonical type; the root
        schema, when it carries schema keywords (or when there are no definitions),
        becomes one more named type derived from ``title`` / ``$id`` / ``"Schema"``. The
        emitted model carries only types (no operations/channels), so the shared router
        classifies it as a schemas-only, non-publishable catalog item.

        Raises:
            ImportSourceError: If ``native_ast`` is not a mapping (i.e. not a schema
                document).
        """
        if not isinstance(native_ast, dict):
            raise ImportSourceError("JSON Schema source must be a JSON/YAML object.")

        document: Dict[str, Any] = native_ast
        types: List[Type] = []
        seen: set[str] = set()

        defs = document.get("$defs")
        if not isinstance(defs, dict):
            defs = document.get("definitions")
        if isinstance(defs, dict):
            for def_name, def_schema in defs.items():
                if isinstance(def_schema, dict) and def_name not in seen:
                    types.append(_build_type(str(def_name), def_schema))
                    seen.add(str(def_name))

        # The root document is itself a schema when it carries schema keywords, or when
        # it declares no definitions at all (a bare single-type schema). Name it from
        # `title`/`$id`, avoiding a collision with a same-named definition.
        root_name = (
            document.get("title")
            if isinstance(document.get("title"), str) and document.get("title")
            else _name_from_id(document.get("$id")) or "Schema"
        )
        if (_has_schema_keywords(document) or not types) and root_name not in seen:
            types.append(_build_type(str(root_name), document))
            seen.add(str(root_name))

        title = document.get("title")
        description = document.get("description")
        identity_name = (
            title
            if isinstance(title, str) and title
            else _name_from_id(document.get("$id")) or "JSON Schema"
        )
        schema_id = document.get("$id")

        return CanonicalApi(
            paradigm=self.paradigm,
            format=JSON_SCHEMA_FORMAT,
            identity=ApiIdentity(
                name=identity_name,
                id=schema_id if isinstance(schema_id, str) and schema_id else None,
            ),
            title=title if isinstance(title, str) and title else None,
            description=description if isinstance(description, str) and description else None,
            types=types,
            raw={"source": document} if include_raw else None,
        )
