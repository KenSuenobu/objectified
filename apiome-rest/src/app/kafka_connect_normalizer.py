"""Kafka Connect → canonical model normalizer — FMT-5.3 (#5441).

Maps a parsed :class:`~app.kafka_connect_schema.ConnectDocument` onto the canonical
data-schema model — deliberately onto the *same* shape the Avro reader produces, because
that is what makes an Avro ↔ Connect transcode a projection rather than a translation.

**The one design decision everything follows from: a logical type is a constraint, not a
string.** ``org.apache.kafka.connect.data.Timestamp`` is an ``int64`` in the wire form
and an instant in meaning. Reading it as "an int64 with a label" would lose the only
thing worth reading; reading the *label* as the type would lose the wire form. So the
name selects a canonical scalar and a
:class:`~app.canonical_model.Constraints` facet — ``format: date-time`` — exactly as
the Avro reader does for ``logicalType: timestamp-millis``, and the Connect spelling is
carried beside it so the writer can restore it byte for byte.

**Structure.** Each ``struct`` becomes one canonical ``RECORD`` keyed by its schema
``name``; a nested struct is a record of its own, so two fields that name the same
struct share one canonical type (which is exactly what a change-event envelope's
``before``/``after`` pair does). An ``array`` becomes a list ``TypeRef``, a ``map``
becomes a canonical ``MAP`` type, ``optional`` becomes nullability, and ``default``
becomes the field's default.

**The ``connect_*`` extras namespace.** What the canonical model has no facet for is
carried verbatim, on the node that declared it, under these keys — and the emitter
writes every one of them back, which is what makes ``kafka-connect -> kafka-connect`` a
round-trip rather than a re-derivation:

===============================  ======  =====================================================
Extras key                       Node    Carries
===============================  ======  =====================================================
``kafka_connect``                root    The reader's own projection record: the root schema
                                         names, whether the intake was enveloped, the source
                                         files, and the declared ``capability_limits``.
``kafka_connect_connector``      root    A connector configuration's ``name`` and ``config``.
``kafka_connect_payload``        root    The sample record(s) beside an enveloped schema.
``connect_kind``                 type    ``struct`` or ``map`` — which Connect construct the
                                         canonical type came from.
``connect_optional``             type    A root schema's own ``optional`` flag, which has no
                                         field to carry it.
``connect_anonymous``            type    That the source declared no ``name`` and the key was
                                         derived from the type's position.
``connect_version``              both    A schema's integer registry revision.
``connect_parameters``           both    The ``parameters`` a recognized logical type did not
                                         consume.
``connect_type``                 field   The exact Connect ``type`` keyword, so ``int8`` is
                                         restored as ``int8`` and not as its canonical width.
``connect_logical_type``         field   The logical-type ``name``.
``precision`` / ``scale``        field   A ``Decimal``'s digits — the spelling the Avro writer
                                         already reads, so the transcode needs no adapter.
``has_default``                  field   That a default was declared, which ``default: null``
                                         on an optional field cannot express on its own.
===============================  ======  =====================================================

Only ``kafka_connect`` is the reader's own bookkeeping; it is therefore the single key
listed in :data:`app.import_preview_manifest.PROVENANCE_EXTRA_KEYS`. Every other key is a
*source* construct the canonical model does not hold, so it is reported as
partially-mapped coverage — which is what "carried but not modelled" should look like to
somebody reading the catalog detail view.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from .kafka_connect_schema import (
    CONNECT_TO_CANONICAL_SCALAR,
    DECIMAL_PRECISION_PARAMETER,
    DECIMAL_SCALE_PARAMETER,
    ENUM_ALLOWED_PARAMETER,
    ENUM_LOGICAL_TYPE,
    LOGICAL_TYPES,
    ConnectDocument,
    ConnectSchema,
    LimitRecorder,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = [
    "KAFKA_CONNECT_EXTRAS_KEY",
    "KafkaConnectNormalizer",
]

_FORMAT_KEY = "kafka-connect"

#: The root extras key holding the reader's own projection record.
KAFKA_CONNECT_EXTRAS_KEY = "kafka_connect"

#: Root extras key carrying a connector configuration verbatim.
CONNECTOR_EXTRAS_KEY = "kafka_connect_connector"

#: Root extras key carrying an envelope's sample record(s) verbatim.
PAYLOAD_EXTRAS_KEY = "kafka_connect_payload"


def _split_qualified(name: str) -> Tuple[str, Optional[str]]:
    """Split a Connect schema name into its simple name and namespace.

    Args:
        name: The schema name, dotted or bare.

    Returns:
        ``(simple_name, namespace)``; the namespace is ``None`` for a bare name.
    """
    if "." in name:
        namespace, _, simple = name.rpartition(".")
        return simple, namespace or None
    return name, None


def _decimal_digits(schema: ConnectSchema) -> Tuple[Optional[int], Optional[int], Dict[str, Any]]:
    """Read a ``Decimal``'s scale and precision out of its ``parameters``.

    Connect writes both as strings. A value that is not a whole number is left where it
    was rather than coerced, because a scale this reader cannot understand is a fact
    about the document, not a reason to invent one.

    Args:
        schema: The ``Decimal``-typed schema node.

    Returns:
        ``(precision, scale, leftover_parameters)``.
    """
    leftover = dict(schema.parameters)
    precision: Optional[int] = None
    scale: Optional[int] = None
    for key, target in (
        (DECIMAL_PRECISION_PARAMETER, "precision"),
        (DECIMAL_SCALE_PARAMETER, "scale"),
    ):
        raw = leftover.get(key)
        if raw is None:
            continue
        value: Optional[int] = None
        if isinstance(raw, bool):
            value = None
        elif isinstance(raw, int):
            value = raw
        elif isinstance(raw, str):
            try:
                value = int(raw.strip())
            except ValueError:
                value = None
        if value is None:
            continue
        leftover.pop(key, None)
        if target == "precision":
            precision = value
        else:
            scale = value
    return precision, scale, leftover


def _enum_values(schema: ConnectSchema) -> Tuple[Optional[List[str]], Dict[str, Any]]:
    """Read an ``io.debezium.data.Enum``'s permitted values out of its ``parameters``.

    Args:
        schema: The enum-typed schema node.

    Returns:
        ``(values, leftover_parameters)``; ``values`` is ``None`` when the ``allowed``
        parameter is absent or not a string.
    """
    leftover = dict(schema.parameters)
    allowed = leftover.get(ENUM_ALLOWED_PARAMETER)
    if not isinstance(allowed, str):
        return None, leftover
    leftover.pop(ENUM_ALLOWED_PARAMETER, None)
    values = [token.strip() for token in allowed.split(",") if token.strip()]
    return (values or None), leftover


class _Walker:
    """One-shot walk of a parsed document into canonical types.

    Held as an object rather than threaded through free functions because the walk
    accumulates three things at once — the declared types, the synthesized map types,
    and the limit recorder — and every recursion needs all three.
    """

    def __init__(self) -> None:
        self.types: Dict[str, Type] = {}
        self.recorder = LimitRecorder()
        self._active: List[str] = []

    # -- type identity ----------------------------------------------------

    def _record_key(self, schema: ConnectSchema, *, path: str) -> Tuple[str, str, Optional[str]]:
        """Return the canonical key, simple name and namespace of a ``struct``.

        Args:
            schema: The struct schema.
            path: Where the struct sits, used to derive a key when it is anonymous.

        Returns:
            ``(key, name, namespace)``.
        """
        if schema.name:
            name, namespace = _split_qualified(schema.name)
            return Keys.type(name, namespace), name, namespace
        name, namespace = _split_qualified(path)
        return Keys.type(name, namespace), name, namespace

    # -- the walk ---------------------------------------------------------

    def type_ref(self, schema: ConnectSchema, *, path: str, owner: Optional[str]) -> TypeRef:
        """Map one schema node to the reference a use site holds.

        Args:
            schema: The schema node.
            path: A dotted path naming this node, used for anonymous identity.
            owner: The canonical key of the type the node sits under, for limit
                locations.

        Returns:
            The type reference, carrying this level's nullability.
        """
        if schema.type == "struct":
            key = self.record(schema, path=path, owner=owner)
            return TypeRef(name=key, nullable=schema.optional)
        if schema.type == "array":
            item = schema.items
            inner = (
                self.type_ref(item, path=f"{path}.items", owner=owner)
                if item is not None
                else TypeRef(name="string", nullable=False)
            )
            return TypeRef(item=inner, nullable=schema.optional)
        if schema.type == "map":
            key = self.map_type(schema, path=path, owner=owner)
            return TypeRef(name=key, nullable=schema.optional)
        return TypeRef(name=self.scalar_name(schema), nullable=schema.optional)

    def scalar_name(self, schema: ConnectSchema) -> str:
        """Return the canonical scalar a primitive schema is modelled as.

        A recognized logical type may override the base type's scalar — a ``Timestamp``
        is an ``int64`` on the wire and a ``string`` in the canonical model, which is
        exactly what the Avro reader does with ``timestamp-millis``.

        Args:
            schema: The primitive schema node.

        Returns:
            The canonical scalar name.
        """
        base = CONNECT_TO_CANONICAL_SCALAR.get(schema.type, "string")
        logical = LOGICAL_TYPES.get(schema.logical_type or "")
        if logical is not None and logical.canonical_scalar:
            return logical.canonical_scalar
        return base

    def map_type(self, schema: ConnectSchema, *, path: str, owner: Optional[str]) -> str:
        """Declare (once) the canonical ``MAP`` type a Connect ``map`` becomes.

        Args:
            schema: The map schema node.
            path: A dotted path naming this node.
            owner: The canonical key of the type the node sits under.

        Returns:
            The map type's canonical key.
        """
        keys_ref = (
            self.type_ref(schema.keys, path=f"{path}.keys", owner=owner)
            if schema.keys is not None
            else TypeRef(name="string", nullable=False)
        )
        values_ref = (
            self.type_ref(schema.values, path=f"{path}.values", owner=owner)
            if schema.values is not None
            else TypeRef(name="string", nullable=True)
        )
        simple, namespace = _split_qualified(path)
        key = Keys.type(f"Map_{simple}", namespace)
        if key not in self.types:
            self.types[key] = Type(
                key=key,
                name=key.rsplit(".", 1)[-1],
                kind=TypeKind.MAP,
                namespace=namespace,
                key_type=keys_ref,
                value_type=values_ref,
                extras={"connect_kind": "map"},
            )
        return key

    def record(self, schema: ConnectSchema, *, path: str, owner: Optional[str]) -> str:
        """Declare (once) the canonical ``RECORD`` a Connect ``struct`` becomes.

        Two fields that name the same struct share one canonical type: the first
        declaration wins, which is what makes a change-event envelope's ``before`` and
        ``after`` one record rather than two identical ones.

        Args:
            schema: The struct schema node.
            path: A dotted path naming this node, used when the struct is anonymous.
            owner: The canonical key of the type the node sits under.

        Returns:
            The record's canonical key.
        """
        key, name, namespace = self._record_key(schema, path=path)
        if key in self.types or key in self._active:
            return key

        if not schema.name:
            self.recorder.record("kafka-connect.anonymous_struct", location=key)

        # Registered before the members are walked so a struct that (however indirectly)
        # names itself terminates instead of recursing forever.
        self._active.append(key)
        try:
            fields = [
                self._field(member.name, member.schema, type_key=key, index=member.index)
                for member in schema.fields
            ]
        finally:
            self._active.pop()

        extras: Dict[str, Any] = {"connect_kind": "struct"}
        if schema.optional:
            extras["connect_optional"] = True
        if not schema.name:
            extras["connect_anonymous"] = True
        if schema.version is not None:
            extras["connect_version"] = schema.version
            self.recorder.record("kafka-connect.schema_version", location=key)
        if schema.parameters:
            extras["connect_parameters"] = dict(schema.parameters)
            self.recorder.record("kafka-connect.schema_parameters", location=key)

        self.types[key] = Type(
            key=key,
            name=name,
            kind=TypeKind.RECORD,
            namespace=namespace,
            description=schema.doc,
            fields=fields,
            extras=extras,
        )
        return key

    def _field(
        self, name: str, schema: ConnectSchema, *, type_key: str, index: int
    ) -> CanonicalField:
        """Map one struct member to a canonical field.

        Args:
            name: The member's ``field`` name.
            schema: The member's schema node.
            type_key: The owning record's canonical key.
            index: Zero-based declaration order.

        Returns:
            The canonical field, with its logical type resolved into constraints and its
            Connect spelling carried in extras.
        """
        type_ref = self.type_ref(schema, path=f"{type_key}.{name}", owner=type_key)
        constraints, extras = self._decoration(schema, owner=type_key)
        if schema.has_default:
            extras["has_default"] = True
        return CanonicalField(
            key=Keys.field(type_key, name),
            name=name,
            type=type_ref,
            field_number=index + 1,
            default=schema.default if schema.has_default else None,
            constraints=constraints,
            description=schema.doc,
            extras=extras,
        )

    def _decoration(
        self, schema: ConnectSchema, *, owner: str
    ) -> Tuple[Optional[Constraints], Dict[str, Any]]:
        """Resolve a schema node's logical type, parameters and version.

        Args:
            schema: The schema node.
            owner: The canonical key of the type the node sits under, for limit
                locations.

        Returns:
            ``(constraints, extras)``; ``constraints`` is ``None`` when the node
            constrains nothing.
        """
        extras: Dict[str, Any] = {"connect_type": schema.type}
        leftover: Dict[str, Any] = dict(schema.parameters)
        facets: Dict[str, Any] = {}

        logical_name = schema.logical_type
        if logical_name:
            extras["connect_logical_type"] = logical_name
            logical = LOGICAL_TYPES.get(logical_name)
            if logical is None:
                self.recorder.record("kafka-connect.unknown_logical_type", location=owner)
            else:
                if logical.canonical_format:
                    facets["format"] = logical.canonical_format
                if logical_name == ENUM_LOGICAL_TYPE:
                    values, leftover = _enum_values(schema)
                    if values:
                        facets["enum"] = values
                elif logical.canonical_format == "decimal":
                    precision, scale, leftover = _decimal_digits(schema)
                    if precision is not None:
                        extras["precision"] = precision
                    if scale is not None:
                        extras["scale"] = scale
                    if precision is not None or scale is not None:
                        self.recorder.record(
                            "kafka-connect.decimal_precision", location=owner
                        )

        if schema.version is not None:
            extras["connect_version"] = schema.version
            self.recorder.record("kafka-connect.schema_version", location=owner)
        if leftover:
            extras["connect_parameters"] = leftover
            self.recorder.record("kafka-connect.schema_parameters", location=owner)

        return (Constraints(**facets) if facets else None), extras


class KafkaConnectNormalizer(Normalizer, register=True):
    """Normalize a parsed Kafka Connect document into a :class:`CanonicalApi`.

    Registered under ``kafka-connect``. A Connect schema describes a value, never a call,
    so the paradigm is always :attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA` — a
    connector configuration in the same file set names topics and transforms, but a topic
    is where a record travels, not an operation the catalog can describe.
    """

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Map a parsed Connect document to the canonical model.

        Args:
            source: The :class:`~app.kafka_connect_schema.ConnectDocument` the reader
                produced.
            include_raw: Whether to keep the source text on ``raw``.

        Returns:
            The canonical model — always ``data_schema``.

        Raises:
            ValueError: When ``source`` is not a
                :class:`~app.kafka_connect_schema.ConnectDocument`.
        """
        if not isinstance(source, ConnectDocument):
            raise ValueError(
                "Kafka Connect source must be a ConnectDocument "
                "(see app.kafka_connect_parser.parse_kafka_connect)"
            )

        walker = _Walker()
        root_keys = [
            walker.record(root, path=f"Schema{index + 1}" if index else "Schema", owner=None)
            for index, root in enumerate(source.roots)
        ]

        if source.envelope:
            walker.recorder.record("kafka-connect.envelope_payload")
        if source.connector is not None:
            walker.recorder.record("kafka-connect.connector_config")

        report: Dict[str, Any] = {
            "roots": root_keys,
            "envelope": source.envelope,
            "capability_limits": [
                {
                    "construct": limit.construct,
                    "detail": limit.detail,
                    "count": limit.count,
                    "locations": list(limit.locations),
                }
                for limit in walker.recorder.limits()
            ],
        }
        if source.source_files:
            report["source_files"] = list(source.source_files)

        extras: Dict[str, Any] = {KAFKA_CONNECT_EXTRAS_KEY: report}
        if source.connector is not None:
            connector: Dict[str, Any] = {"config": dict(source.connector.config)}
            if source.connector.name:
                connector["name"] = source.connector.name
            if source.connector.source_file:
                connector["source_file"] = source.connector.source_file
            extras[CONNECTOR_EXTRAS_KEY] = connector
        if source.payloads:
            extras[PAYLOAD_EXTRAS_KEY] = list(source.payloads)

        identity = self._identity(source, root_keys)
        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=identity,
            title=identity.name,
            description=source.root.doc,
            types=sorted(walker.types.values(), key=lambda type_: type_.key),
            raw={"kafka-connect": source.raw} if include_raw else None,
            extras=extras,
        )
        return normalize_ordering(api)

    @staticmethod
    def _identity(source: ConnectDocument, root_keys: List[str]) -> ApiIdentity:
        """Derive the artifact's identity.

        A pipeline names itself through its connector configuration; a bare schema names
        itself through its own schema name. Nothing is invented: a document that names
        neither falls back to the canonical key the walk already derived.

        Args:
            source: The parsed document.
            root_keys: The canonical keys of the document's root records.

        Returns:
            The identity.
        """
        if source.connector is not None and source.connector.name:
            name, namespace = _split_qualified(source.connector.name)
            return ApiIdentity(name=name, namespace=namespace)
        primary = root_keys[0] if root_keys else "Schema"
        name, namespace = _split_qualified(primary)
        return ApiIdentity(name=name, namespace=namespace)
