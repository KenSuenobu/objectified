"""Kafka Connect schema reader — FMT-5.3 (#5441).

Loads a Connect schema document, a ``{schema, payload}`` converter envelope, or a
pipeline file set into the :mod:`app.kafka_connect_schema` AST. Detection lives here
too; the canonical projection is in :mod:`app.kafka_connect_normalizer`.

**Connect is JSON and only JSON.** Unlike the YAML-or-JSON formats this service reads,
a Connect schema is what a converter serializes, and that is always JSON. Parsing it
with a YAML loader would accept documents no Connect pipeline can produce and — worse —
would lose the exact byte offset ``json`` reports, which is the evidence truncation is
decided on.

**Error grounding.** A failure this reader can classify carries its taxonomy code; one
it cannot carries **none**, which hands classification to
:func:`app.import_source_pipeline._classify_parse_failure`. That is what makes a UTF-16
upload read as ``INPUT_ENCODING_INVALID`` and an Avro ``.avsc`` routed here read as
``FORMAT_MISMATCH`` — the Avro adapter claims it confidently, which is the evidence.
The codes this reader sets itself are:

``INPUT_TRUNCATED``
    The JSON stream ended while a construct was still open. A *parser state*, not a
    message heuristic: :class:`json.JSONDecodeError` reports the offset it gave up at,
    and an offset at the end of the input means the bytes ran out.
``INPUT_SEMANTIC_INVALID``
    Well-formed JSON in Connect's shape that describes no schema: a ``struct`` with no
    ``fields``, a field with no ``type`` or an unknown one, an ``array`` with no
    ``items``, a connector configuration imported without the schemas it carries.
``INPUT_DEPTH_LIMIT`` / ``INPUT_TOO_LARGE``
    The shared intake guards.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .intake_resource_guard import IntakeLimitError, guard_document_text, guard_parsed_document
from .kafka_connect_schema import (
    CONNECT_TYPES,
    ConnectConnectorConfig,
    ConnectDocument,
    ConnectField,
    ConnectParseError,
    ConnectSchema,
)

__all__ = [
    "CONNECT_SUFFIXES",
    "MAX_SCHEMA_DEPTH",
    "MAX_STRUCT_FIELDS",
    "is_kafka_connect",
    "is_kafka_connect_document",
    "is_connect_connector_config",
    "load_connect_document",
    "parse_kafka_connect",
    "parse_kafka_connect_fileset",
]

#: Filename suffixes that route a document here. ``.json`` is last and deliberately
#: broad: a Connect schema has no conventional extension of its own, so content is the
#: authority and the suffix only widens what a file picker offers.
CONNECT_SUFFIXES = (".connect.json", ".connect-schema.json", ".json")

#: How deeply a schema may nest inside another schema. The reader recurses one frame per
#: level, so this is what keeps a pathological document from raising an uncaught
#: ``RecursionError`` — which the import pipeline does not catch.
MAX_SCHEMA_DEPTH = 64

#: Upper bound on the members of a single ``struct``.
MAX_STRUCT_FIELDS = 5000

#: Connector-configuration keys that identify the document as a connector config rather
#: than as some other ``{name, config}``-shaped JSON. ``connector.class`` is required by
#: Connect itself; the converter and transform keys are what a configuration written by
#: a distributed worker always carries.
_CONNECTOR_MARKERS = ("connector.class", "key.converter", "value.converter", "transforms")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _is_truncation(exc: json.JSONDecodeError, text: str) -> bool:
    """Whether a JSON failure is the stream *ending* rather than being wrong.

    Args:
        exc: The raised decode error.
        text: The source text the error came from.

    Returns:
        ``True`` when the reported offset is at (or past) the end of the meaningful
        input, which means a construct was still open when the bytes ran out.
    """
    return exc.pos >= len(text.rstrip())


def load_connect_document(text: str, *, source_label: Optional[str] = None) -> Any:
    """Load one Connect JSON document, applying the shared intake guards.

    Args:
        text: The source text.
        source_label: The document's name, for error messages.

    Returns:
        The loaded value, of whatever type the document had.

    Raises:
        ConnectParseError: With the guard's code for an oversized or too-deep document,
            ``INPUT_TRUNCATED`` for a stream that ended mid-construct, and **no code**
            for any other JSON syntax error.
    """
    try:
        guard_document_text(text, source_label=source_label)
    except IntakeLimitError as exc:
        raise ConnectParseError(str(exc), code=exc.code) from exc
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        where = f" in {source_label}" if source_label else ""
        if _is_truncation(exc, text):
            raise ConnectParseError(
                f"Kafka Connect schema{where} ends while a value is still open — the "
                f"upload is truncated: {exc}",
                code="INPUT_TRUNCATED",
            ) from exc
        raise ConnectParseError(f"Invalid JSON{where}: {exc}") from exc
    try:
        guard_parsed_document(parsed, source_label=source_label)
    except IntakeLimitError as exc:
        raise ConnectParseError(str(exc), code=exc.code) from exc
    return parsed


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _is_schema_mapping(document: Any) -> bool:
    """Whether a loaded value is a Connect ``struct`` schema.

    The marker is narrow on purpose. ``"type": "struct"`` alone would claim a Kubernetes
    structural-schema fragment; requiring a ``fields[]`` array whose members are keyed
    ``field`` is what separates Connect from Avro, whose members are keyed ``name``.

    Args:
        document: The loaded value.

    Returns:
        ``True`` when the value carries Connect's struct marker.
    """
    if not isinstance(document, Mapping):
        return False
    if document.get("type") != "struct":
        return False
    fields = document.get("fields")
    if not isinstance(fields, list) or not fields:
        return False
    return any(isinstance(member, Mapping) and "field" in member for member in fields)


def _is_envelope_mapping(document: Any) -> bool:
    """Whether a loaded value is a ``{schema, payload}`` converter envelope."""
    if not isinstance(document, Mapping):
        return False
    return _is_schema_mapping(document.get("schema"))


def is_connect_connector_config(document: Any) -> bool:
    """Whether a loaded value is a Kafka Connect connector configuration.

    Args:
        document: The loaded value.

    Returns:
        ``True`` for a ``{name, config}`` document whose ``config`` carries at least one
        of the keys a running connector always has.
    """
    if not isinstance(document, Mapping):
        return False
    config = document.get("config")
    if not isinstance(config, Mapping):
        return False
    return any(marker in config for marker in _CONNECTOR_MARKERS)


def is_kafka_connect_document(document: Any) -> bool:
    """Whether a loaded value is any surface this reader claims."""
    return (
        _is_schema_mapping(document)
        or _is_envelope_mapping(document)
        or is_connect_connector_config(document)
    )


def is_kafka_connect(content: str) -> bool:
    """Whether ``content`` is a Kafka Connect document.

    Args:
        content: The candidate text.

    Returns:
        ``True`` when the text parses as JSON in one of the three shapes this reader
        claims. Never raises — a sniff that cannot parse simply does not claim.
    """
    if not content or not isinstance(content, str) or not content.strip():
        return False
    try:
        document = json.loads(content)
    except (json.JSONDecodeError, ValueError, RecursionError):
        return False
    return is_kafka_connect_document(document)


# ---------------------------------------------------------------------------
# Schema parsing
# ---------------------------------------------------------------------------


def _optional_int(value: Any) -> Optional[int]:
    """Return ``value`` when it is a real integer, else ``None`` (``bool`` is not one)."""
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) else None


def _parameters(node: Mapping[str, Any], *, where: str) -> Dict[str, Any]:
    """Read a schema's ``parameters`` map.

    Connect declares parameters as string-to-string, but connectors in the wild write
    numbers and booleans too. The values are carried verbatim either way; only a
    non-mapping ``parameters`` is an error, because there is no honest way to read it.

    Args:
        node: The schema mapping.
        where: The path used in an error message.

    Returns:
        The parameters, or an empty mapping when none were declared.

    Raises:
        ConnectParseError: When ``parameters`` is present but not a mapping.
    """
    parameters = node.get("parameters")
    if parameters is None:
        return {}
    if not isinstance(parameters, Mapping):
        raise ConnectParseError(
            f"`parameters` at {where} must be an object of names to values, "
            f"got {type(parameters).__name__}",
            code="INPUT_SEMANTIC_INVALID",
        )
    return {str(key): value for key, value in parameters.items()}


def _parse_schema(node: Any, *, where: str, depth: int) -> ConnectSchema:
    """Parse one schema node and everything below it.

    Args:
        node: The candidate schema mapping.
        where: A dotted path naming this node, used in error messages.
        depth: Current nesting depth, bounded by :data:`MAX_SCHEMA_DEPTH`.

    Returns:
        The parsed schema.

    Raises:
        ConnectParseError: For a node that is not a mapping, declares no ``type`` or an
            unknown one, or is missing the child a container type requires.
    """
    if depth > MAX_SCHEMA_DEPTH:
        raise ConnectParseError(
            f"Kafka Connect schema nests deeper than {MAX_SCHEMA_DEPTH} levels at {where}",
            code="INPUT_DEPTH_LIMIT",
        )
    if not isinstance(node, Mapping):
        raise ConnectParseError(
            f"Schema at {where} must be an object, got {type(node).__name__}",
            code="INPUT_SEMANTIC_INVALID",
        )

    schema_type = node.get("type")
    if not isinstance(schema_type, str) or not schema_type.strip():
        raise ConnectParseError(
            f"Schema at {where} declares no `type`. Every Kafka Connect schema names one "
            f"of {', '.join(sorted(CONNECT_TYPES))}.",
            code="INPUT_SEMANTIC_INVALID",
        )
    schema_type = schema_type.strip()
    if schema_type not in CONNECT_TYPES:
        raise ConnectParseError(
            f"Schema at {where} declares an unknown `type` {schema_type!r}. Kafka Connect "
            f"admits only {', '.join(sorted(CONNECT_TYPES))}; a semantic type such as a "
            f"timestamp is a logical-type `name` on one of them, not a type of its own.",
            code="INPUT_SEMANTIC_INVALID",
        )

    name = node.get("name")
    name = name.strip() if isinstance(name, str) and name.strip() else None
    doc = node.get("doc")
    doc = doc if isinstance(doc, str) and doc.strip() else None

    fields: Tuple[ConnectField, ...] = ()
    items: Optional[ConnectSchema] = None
    keys: Optional[ConnectSchema] = None
    values: Optional[ConnectSchema] = None

    if schema_type == "struct":
        fields = _parse_fields(node, where=where, depth=depth)
    elif schema_type == "array":
        if "items" not in node:
            raise ConnectParseError(
                f"`array` schema at {where} declares no `items`, so its element type is "
                f"unknown.",
                code="INPUT_SEMANTIC_INVALID",
            )
        items = _parse_schema(node["items"], where=f"{where}.items", depth=depth + 1)
    elif schema_type == "map":
        if "keys" not in node or "values" not in node:
            raise ConnectParseError(
                f"`map` schema at {where} must declare both `keys` and `values`.",
                code="INPUT_SEMANTIC_INVALID",
            )
        keys = _parse_schema(node["keys"], where=f"{where}.keys", depth=depth + 1)
        values = _parse_schema(node["values"], where=f"{where}.values", depth=depth + 1)

    return ConnectSchema(
        type=schema_type,
        optional=bool(node.get("optional", False)),
        name=name,
        version=_optional_int(node.get("version")),
        doc=doc,
        default=node.get("default"),
        has_default="default" in node,
        parameters=_parameters(node, where=where),
        fields=fields,
        items=items,
        keys=keys,
        values=values,
    )


def _parse_fields(node: Mapping[str, Any], *, where: str, depth: int) -> Tuple[ConnectField, ...]:
    """Parse a ``struct``'s members.

    Args:
        node: The struct schema mapping.
        where: A dotted path naming the struct.
        depth: The struct's own nesting depth.

    Returns:
        The parsed members, in declaration order.

    Raises:
        ConnectParseError: When ``fields`` is absent, empty, not a list, over the member
            ceiling, or holds a member with no ``field`` name.
    """
    fields = node.get("fields")
    if not isinstance(fields, list):
        raise ConnectParseError(
            f"`struct` schema at {where} declares no `fields` array, so it describes no "
            f"record. A Kafka Connect struct is defined by its members.",
            code="INPUT_SEMANTIC_INVALID",
        )
    if not fields:
        raise ConnectParseError(
            f"`struct` schema at {where} declares an empty `fields` array, so it "
            f"describes no record.",
            code="INPUT_SEMANTIC_INVALID",
        )
    if len(fields) > MAX_STRUCT_FIELDS:
        raise ConnectParseError(
            f"`struct` schema at {where} declares {len(fields)} fields, over the "
            f"{MAX_STRUCT_FIELDS} this reader accepts.",
            code="INPUT_TOO_LARGE",
        )

    parsed: List[ConnectField] = []
    seen: Dict[str, int] = {}
    for index, member in enumerate(fields):
        if not isinstance(member, Mapping):
            raise ConnectParseError(
                f"Field {index} of the struct at {where} must be an object, "
                f"got {type(member).__name__}",
                code="INPUT_SEMANTIC_INVALID",
            )
        field_name = member.get("field")
        if not isinstance(field_name, str) or not field_name.strip():
            raise ConnectParseError(
                f"Field {index} of the struct at {where} declares no `field` name. Kafka "
                f"Connect names a struct member with `field`; a member keyed `name` is "
                f"Avro's spelling, not Connect's.",
                code="INPUT_SEMANTIC_INVALID",
            )
        field_name = field_name.strip()
        if field_name in seen:
            raise ConnectParseError(
                f"The struct at {where} declares `{field_name}` twice (fields "
                f"{seen[field_name]} and {index}).",
                code="INPUT_SEMANTIC_INVALID",
            )
        seen[field_name] = index
        parsed.append(
            ConnectField(
                name=field_name,
                schema=_parse_schema(member, where=f"{where}.{field_name}", depth=depth + 1),
                index=index,
            )
        )
    return tuple(parsed)


def _parse_connector_config(
    document: Mapping[str, Any], *, source_file: Optional[str]
) -> ConnectConnectorConfig:
    """Read a connector configuration document into its carrier."""
    name = document.get("name")
    config = document.get("config")
    return ConnectConnectorConfig(
        name=name.strip() if isinstance(name, str) and name.strip() else None,
        config={str(key): value for key, value in dict(config or {}).items()},
        source_file=source_file,
    )


def _has_connect_root_type(document: Any) -> bool:
    """Whether a loaded value declares a root ``type`` this reader has standing over.

    The root ``type`` is what decides whether this reader may *judge* a document. An
    Avro schema's root is ``record``, which is in no Connect vocabulary, so the document
    is refused without a code and the pipeline reports ``FORMAT_MISMATCH`` on the
    strength of the Avro adapter claiming it. A root that says ``struct`` is Connect's
    even when the body is wrong, and its faults are this reader's to name.

    Args:
        document: The loaded value.

    Returns:
        ``True`` when the root declares one of :data:`CONNECT_TYPES`.
    """
    if not isinstance(document, Mapping):
        return False
    schema_type = document.get("type")
    return isinstance(schema_type, str) and schema_type.strip() in CONNECT_TYPES


def _refuse_non_connect(document: Any, *, source_label: Optional[str]) -> None:
    """Refuse a document that is not Connect at all, without claiming a code.

    A code-less refusal is what lets the pipeline notice that a *different* adapter
    claims the bytes confidently and report ``FORMAT_MISMATCH`` — which is the right
    answer for an Avro ``.avsc`` routed to this reader, and something this reader has no
    standing to decide on its own.

    Args:
        document: The loaded value.
        source_label: The document's name, for the message.

    Raises:
        ConnectParseError: Always, with no code.
    """
    where = f" ({source_label})" if source_label else ""
    hint = ""
    if isinstance(document, Mapping) and isinstance(document.get("fields"), list):
        if any(isinstance(m, Mapping) and "name" in m and "field" not in m for m in document["fields"]):
            hint = (
                " Its members are keyed `name`, which is Avro's spelling; Kafka Connect "
                "names a struct member with `field`."
            )
    raise ConnectParseError(
        f"Content{where} does not appear to be a Kafka Connect schema — no `type: struct` "
        f"with a `fields` array, no `{{schema, payload}}` envelope, and no connector "
        f"configuration.{hint}"
    )


def parse_kafka_connect(
    content: str, *, source_label: Optional[str] = None
) -> ConnectDocument:
    """Parse one Kafka Connect document.

    Args:
        content: The document text — a schema, or a ``{schema, payload}`` envelope.
        source_label: The document's name, for error messages.

    Returns:
        The parsed :class:`~app.kafka_connect_schema.ConnectDocument`.

    Raises:
        ConnectParseError: With this reader's taxonomy code when it can classify the
            failure, and without one when the pipeline should classify it.
    """
    if not content or not content.strip():
        raise ConnectParseError("Kafka Connect document is empty")
    document = load_connect_document(content, source_label=source_label)

    envelope = False
    payloads: Tuple[Any, ...] = ()
    node: Any = document
    if isinstance(document, Mapping) and "schema" in document and "payload" in document:
        envelope = True
        node = document.get("schema")
        payloads = (document.get("payload"),)
    elif is_connect_connector_config(document):
        raise ConnectParseError(
            "This is a Kafka Connect connector configuration, not a schema: it states how "
            "a pipeline runs, not what it carries. Import it together with the key and "
            "value schemas the pipeline uses.",
            code="INPUT_SEMANTIC_INVALID",
        )
    elif not _has_connect_root_type(document):
        _refuse_non_connect(document, source_label=source_label)

    label = source_label or "schema"
    if not _has_connect_root_type(node):
        _refuse_non_connect(node, source_label=source_label)
    root = _parse_schema(node, where=label, depth=0)
    if root.type != "struct":
        raise ConnectParseError(
            f"The root Kafka Connect schema in {label} is a `{root.type}`, not a `struct`. "
            f"A pipeline's key or value schema describes a record.",
            code="INPUT_SEMANTIC_INVALID",
        )
    return ConnectDocument(
        roots=(root,),
        raw=content,
        envelope=envelope,
        payloads=payloads,
        source_files=(source_label,) if source_label else (),
    )


def parse_kafka_connect_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> ConnectDocument:
    """Parse a pipeline file set — a connector configuration and the schemas it carries.

    Connect has no include directive, so a pipeline that spans files is composed by
    being imported *together*: the connector configuration contributes the pipeline's
    identity and its operational settings, and every schema member contributes a root
    record. A set of schemas with no configuration composes just as well.

    Args:
        members: Every set member keyed by its relative path.
        root: The path of the set's primary document.
        source_label: Fallback label when the set names no root.

    Returns:
        The composed document, its roots in member-path order with the root member first.

    Raises:
        ConnectParseError: When the set holds no schema at all, holds more than one
            connector configuration, or any member fails to parse.
    """
    if root not in members:
        raise ConnectParseError(
            f"Kafka Connect file set is missing its root document {root!r}",
            code="INPUT_SEMANTIC_INVALID",
        )

    connector: Optional[ConnectConnectorConfig] = None
    roots: List[ConnectSchema] = []
    files: List[str] = []
    payloads: List[Any] = []
    envelope = False
    # The root member is read first so it leads the composed document; the rest follow in
    # path order, which is what makes the composition deterministic.
    ordered = [root] + sorted(path for path in members if path != root)

    for path in ordered:
        text = members[path]
        if not text or not text.strip():
            continue
        document = load_connect_document(text, source_label=path)
        if is_connect_connector_config(document):
            if connector is not None:
                raise ConnectParseError(
                    f"Kafka Connect file set holds more than one connector configuration "
                    f"({connector.source_file} and {path}); a set describes one pipeline.",
                    code="INPUT_SEMANTIC_INVALID",
                )
            connector = _parse_connector_config(document, source_file=path)
            continue
        node: Any = document
        if isinstance(document, Mapping) and "schema" in document and "payload" in document:
            envelope = True
            node = document.get("schema")
            payloads.append(document.get("payload"))
        elif not _has_connect_root_type(document):
            _refuse_non_connect(document, source_label=path)
        if not _has_connect_root_type(node):
            _refuse_non_connect(node, source_label=path)
        member_root = _parse_schema(node, where=path, depth=0)
        if member_root.type != "struct":
            raise ConnectParseError(
                f"The root Kafka Connect schema in {path} is a `{member_root.type}`, not a "
                f"`struct`. A pipeline's key or value schema describes a record.",
                code="INPUT_SEMANTIC_INVALID",
            )
        roots.append(member_root)
        files.append(path)

    if not roots:
        where = f" ({source_label})" if source_label else ""
        raise ConnectParseError(
            f"Kafka Connect file set{where} carries no schema. A connector configuration "
            f"states how a pipeline runs; the key and value schemas beside it are what it "
            f"carries, and at least one of them is required.",
            code="INPUT_SEMANTIC_INVALID",
        )

    return ConnectDocument(
        roots=tuple(roots),
        raw=members[root],
        envelope=envelope,
        payloads=tuple(payloads),
        connector=connector,
        source_files=tuple(files),
    )
