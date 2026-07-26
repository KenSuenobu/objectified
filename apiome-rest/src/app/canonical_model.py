"""Canonical (paradigm-agnostic) internal API model — MFI-2.1 (#3738).

Every importable API description format (REST/OpenAPI, RPC/gRPC, event/AsyncAPI,
graph/GraphQL, data-schema/Avro, …) is normalized into the single shape defined
here so that versioning, fingerprinting, diff, lint, and browse are written
*once* and work uniformly across paradigms.

The model is a tree rooted at :class:`CanonicalApi` (the "artifact"):

    CanonicalApi  (format, protocol, identity, version, servers)
      ├─ services[]            named groups of operations
      │    └─ operations[]     request/response · query/mutation/subscription ·
      │         │              unary/streaming · pub/sub  (+ verb/route)
      │         ├─ parameters[]   path/query/header/cookie inputs (REST-ish)
      │         └─ messages[]     in/out payloads (+ headers, status, media type)
      ├─ channels[]            event addresses / bindings (event-driven)
      └─ types[]               records · enums · unions · scalars · aliases · maps
           └─ fields[]         typed, nullable, defaulted, constrained members

Two design rules make the model durable:

* **Stable keys.** Every entity carries a ``key`` that a normalizer assigns
  deterministically from the source so that diffs between two versions line up
  by identity, not by position. The convention mirrors each paradigm's own
  coordinate system — GraphQL Schema Coordinates (``User``, ``User.email``,
  ``Query.user``), protobuf package-qualified names + field numbers
  (``acme.PetService``, field ``3``), and XSD/WSDL QNames. See
  ``docs/canonical_model.md`` for the full key grammar.

* **Fidelity escape hatches.** No fixed schema can capture every nuance of
  every format, so each entity has an ``extras`` bag for format-specific
  attributes, and the artifact has a top-level ``raw`` bag for the native AST.
  Lossy normalization is therefore never *destructive*: anything the canonical
  fields cannot hold is preserved verbatim for round-tripping and per-format
  lint rules.

The whole tree is plain Pydantic v2, so it serializes to/from JSONB losslessly
(``model_dump()`` / ``model_validate()``), which is exactly what the persistence
tables in MFI-2.2 store per artifact version.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

# Envelope version for a persisted canonical model. Bumped by MFI-2.4 (or later)
# when the canonical shape changes so readers can migrate older JSONB rows
# forward, the same way ``REPOSITORY_IMPORT_SPEC_SCHEMA_VERSION`` does in
# ``models.py``.
CANONICAL_API_SCHEMA_VERSION = 1


class ApiParadigm(str, Enum):
    """The high-level interaction style a format belongs to.

    A format declares exactly one paradigm; it selects which canonical fields
    are load-bearing (for example ``channels`` matter for ``EVENT`` but not for
    ``REST``) and drives browse/search facets.
    """

    REST = "rest"  # OpenAPI, Swagger, RAML, OData, API Blueprint, SOAP/WSDL
    RPC = "rpc"  # gRPC/Protobuf, Smithy, Thrift
    EVENT = "event"  # AsyncAPI, CloudEvents, Kafka/AMQP/MQTT topologies
    GRAPH = "graph"  # GraphQL
    DATA_SCHEMA = "data_schema"  # Avro, JSON Schema, Protobuf messages, XSD
    AGENT = "agent"  # LLM tool / function-calling bundles, agent descriptors (IXH-7.3)


class OperationKind(str, Enum):
    """What an operation *does*, normalized across paradigms.

    These are the message-exchange semantics. Orthogonal physical details —
    whether either side streams — live on :class:`StreamingMode`, and the
    HTTP verb/route (when the paradigm has one) lives on the operation itself.
    """

    REQUEST_RESPONSE = "request_response"  # REST call, gRPC unary, SOAP op
    ONE_WAY = "one_way"  # fire-and-forget RPC / send with no reply
    PUBLISH = "publish"  # producer emits to a channel (event)
    SUBSCRIBE = "subscribe"  # consumer receives from a channel (event)
    QUERY = "query"  # GraphQL read
    MUTATION = "mutation"  # GraphQL write
    SUBSCRIPTION = "subscription"  # GraphQL live stream


class StreamingMode(str, Enum):
    """Streaming cardinality of an operation (the gRPC unary/streaming axis)."""

    NONE = "none"  # unary — one request, one response
    CLIENT = "client"  # client-streaming
    SERVER = "server"  # server-streaming
    BIDIRECTIONAL = "bidirectional"  # bidi-streaming


class MessageRole(str, Enum):
    """The role a message plays within its operation."""

    REQUEST = "request"  # request body / input message
    RESPONSE = "response"  # success response / output message
    ERROR = "error"  # declared error / fault response
    EVENT = "event"  # pub/sub payload carried over a channel


class ParameterLocation(str, Enum):
    """Where a REST-ish operation parameter is carried."""

    PATH = "path"
    QUERY = "query"
    HEADER = "header"
    COOKIE = "cookie"


class TypeKind(str, Enum):
    """The structural family of a named type."""

    RECORD = "record"  # object / struct / message / GraphQL object|input
    ENUM = "enum"  # enumeration of named values
    UNION = "union"  # oneOf / GraphQL union / protobuf oneof
    SCALAR = "scalar"  # primitive or custom scalar (leaf)
    ALIAS = "alias"  # typedef / GraphQL interface alias / named ref
    MAP = "map"  # dictionary / associative array


class CanonicalBase(BaseModel):
    """Shared base: strict fields plus a format-specific ``extras`` escape hatch.

    ``extra="forbid"`` keeps the structural schema honest — a typo or a stray
    key fails fast instead of silently vanishing — while ``extras`` gives every
    entity a documented place to carry attributes the canonical fields do not
    model, so normalization stays lossless.
    """

    model_config = ConfigDict(extra="forbid")

    extras: Dict[str, Any] = Field(
        default_factory=dict,
        description="Format-specific attributes the canonical fields do not model.",
    )


class TypeRef(CanonicalBase):
    """A reference to a type at a use site, carrying nullability and list nesting.

    A leaf reference names a type (``name`` set, ``item`` absent). A list
    reference wraps an inner :class:`TypeRef` (``item`` set, ``name`` absent),
    which may itself be a list, so arbitrarily nested collections are
    expressible. ``nullable`` applies to *this* level only, which is what makes
    GraphQL wrapper fidelity exact:

    * ``String``    -> ``TypeRef(name="String")``
    * ``String!``   -> ``TypeRef(name="String", nullable=False)``
    * ``[String!]`` -> ``TypeRef(item=TypeRef(name="String", nullable=False))``
    * ``[String!]!``-> ``TypeRef(item=TypeRef(name="String", nullable=False),
      nullable=False)``
    """

    name: Optional[str] = Field(
        default=None,
        description="Key of the referenced named type, or a primitive name; "
        "absent when this level is a list (see ``item``).",
    )
    item: Optional["TypeRef"] = Field(
        default=None,
        description="Element type when this level is a list/array; absent for a leaf.",
    )
    nullable: bool = Field(
        default=True,
        description="Whether this level may be null/absent (the GraphQL ``!`` is "
        "``nullable=False``).",
    )

    def is_list(self) -> bool:
        """Return True when this reference is a list/array wrapper."""
        return self.item is not None


class Constraints(CanonicalBase):
    """Validation facets on a field or type, drawn from the JSON-Schema vocabulary.

    Reuses the JSON-Schema constraint names because OpenAPI 3.1 schemas *are*
    JSON Schema and most other formats' constraints map onto the same vocabulary.
    The inherited ``extras`` bag holds constraints with no JSON-Schema analogue
    (for example an Avro ``logicalType`` or a protobuf custom option).
    """

    minimum: Optional[float] = None
    maximum: Optional[float] = None
    exclusive_minimum: Optional[float] = None
    exclusive_maximum: Optional[float] = None
    multiple_of: Optional[float] = None
    min_length: Optional[int] = None
    max_length: Optional[int] = None
    pattern: Optional[str] = None
    min_items: Optional[int] = None
    max_items: Optional[int] = None
    unique_items: Optional[bool] = None
    enum: Optional[List[Any]] = Field(
        default=None,
        description="Permitted literal values, when the source constrains them inline.",
    )
    format: Optional[str] = Field(
        default=None,
        description="Semantic format hint (for example date-time, uuid, int64).",
    )


class EnumValue(CanonicalBase):
    """One member of an enum type."""

    key: str = Field(description="Stable key, for example ``Status.ACTIVE``.")
    name: str = Field(description="Source name of the value.")
    value: Optional[Any] = Field(
        default=None,
        description="Wire value when it differs from the name (for example a "
        "protobuf number or an explicit integer).",
    )
    description: Optional[str] = None
    deprecated: bool = False


class CanonicalField(CanonicalBase):
    """A member of a record/struct/object type.

    ``key`` is the stable coordinate (``User.email``); ``field_number`` preserves
    protobuf/Thrift positional identity so that a rename does not read as an
    add+remove in a diff.
    """

    key: str = Field(description="Stable key, for example ``User.email``.")
    name: str = Field(description="Source field name.")
    type: TypeRef = Field(description="The field's type at this use site.")
    field_number: Optional[int] = Field(
        default=None,
        description="Positional identity for protobuf/Thrift; stable across renames.",
    )
    default: Optional[Any] = Field(
        default=None,
        description="Declared default value, when the source provides one.",
    )
    constraints: Optional[Constraints] = None
    description: Optional[str] = None
    deprecated: bool = False


class Type(CanonicalBase):
    """A named type defined by the artifact.

    Which child collection is populated depends on ``kind``: ``RECORD`` uses
    ``fields``, ``ENUM`` uses ``enum_values``, ``UNION`` uses ``union_members``
    (keys of the member types), ``ALIAS`` uses ``aliased`` (the aliased ref),
    ``MAP`` uses ``key_type``/``value_type``, and ``SCALAR`` uses none of them.
    """

    key: str = Field(
        description="Stable key — the type coordinate (``User``), package-qualified "
        "name (``acme.Pet``), or QName.",
    )
    name: str = Field(description="Source type name.")
    kind: TypeKind
    namespace: Optional[str] = Field(
        default=None,
        description="Package / namespace / XSD target namespace, when applicable.",
    )
    description: Optional[str] = None
    deprecated: bool = False

    fields: List[CanonicalField] = Field(default_factory=list, description="RECORD members.")
    enum_values: List[EnumValue] = Field(
        default_factory=list, description="ENUM members."
    )
    union_members: List[str] = Field(
        default_factory=list,
        description="UNION variant type keys, in declaration order.",
    )
    aliased: Optional[TypeRef] = Field(
        default=None, description="ALIAS target reference."
    )
    key_type: Optional[TypeRef] = Field(
        default=None, description="MAP key type."
    )
    value_type: Optional[TypeRef] = Field(
        default=None, description="MAP value type."
    )
    constraints: Optional[Constraints] = Field(
        default=None,
        description="Type-level constraints (for example a SCALAR's pattern/format).",
    )


class Message(CanonicalBase):
    """An in/out payload of an operation.

    A message references its payload type (``payload``) and/or carries an inline
    schema (``payload_schema``) for sources that define request/response bodies
    inline rather than as named types. REST responses keep their ``status_code``;
    every paradigm keeps its ``content_types``.
    """

    key: str = Field(
        description="Stable key, for example ``GET /pets/{id}#response.200``.",
    )
    role: MessageRole
    name: Optional[str] = None
    payload: Optional[TypeRef] = Field(
        default=None,
        description="Reference to the payload type, when it is a named type.",
    )
    payload_schema: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Inline payload schema (JSON-Schema dict) when the body is "
        "defined inline rather than as a named type.",
    )
    headers: List[CanonicalField] = Field(
        default_factory=list,
        description="Message headers (HTTP/AMQP/Kafka), modeled as fields.",
    )
    content_types: List[str] = Field(
        default_factory=list,
        description="Media types this message is encoded as (for example "
        "application/json).",
    )
    required: bool = Field(
        default=False,
        description="Whether this message is required (e.g. requestBody.required in OpenAPI).",
    )
    status_code: Optional[str] = Field(
        default=None,
        description="Response status code for REST (for example 200, 4XX, default).",
    )
    description: Optional[str] = None


class Parameter(CanonicalBase):
    """A non-body operation input — path/query/header/cookie (REST-ish)."""

    key: str = Field(description="Stable key, for example ``GET /pets/{id}#path.id``.")
    name: str
    location: ParameterLocation
    type: TypeRef
    required: bool = False
    default: Optional[Any] = None
    constraints: Optional[Constraints] = None
    description: Optional[str] = None
    deprecated: bool = False


class Operation(CanonicalBase):
    """A single callable/subscribable unit within a service.

    ``kind`` + ``streaming`` together express every paradigm's operation shape:
    a REST GET is ``REQUEST_RESPONSE`` + ``NONE``; a gRPC bidi method is
    ``REQUEST_RESPONSE`` + ``BIDIRECTIONAL``; a GraphQL field is
    ``QUERY``/``MUTATION``/``SUBSCRIPTION``; an AsyncAPI receive is
    ``SUBSCRIBE`` bound to a ``channel_ref``.
    """

    key: str = Field(
        description="Stable key — ``Query.user``, ``acme.PetService.GetPet``, "
        "or ``GET /pets/{id}``.",
    )
    name: str
    kind: OperationKind
    streaming: StreamingMode = StreamingMode.NONE
    description: Optional[str] = None
    deprecated: bool = False

    http_method: Optional[str] = Field(
        default=None,
        description="HTTP verb (GET/POST/…) when the paradigm has one.",
    )
    http_path: Optional[str] = Field(
        default=None,
        description="Route template (``/pets/{id}``) when the paradigm has one.",
    )
    channel_ref: Optional[str] = Field(
        default=None,
        description="Key of the :class:`Channel` this operation publishes to / "
        "subscribes from (event-driven).",
    )

    parameters: List[Parameter] = Field(default_factory=list)
    messages: List[Message] = Field(
        default_factory=list,
        description="Request/response/error/event payloads for this operation.",
    )
    tags: List[str] = Field(default_factory=list)


class Service(CanonicalBase):
    """A named group of operations.

    Maps to an OpenAPI tag, a gRPC/Smithy service, a GraphQL root type
    (Query/Mutation/Subscription), or an AsyncAPI application grouping.
    """

    key: str = Field(description="Stable key, for example ``acme.PetService``.")
    name: str
    description: Optional[str] = None
    operations: List[Operation] = Field(default_factory=list)


class Channel(CanonicalBase):
    """An event address/binding (event-driven paradigm).

    Holds the address/topic, protocol bindings, and any address parameters
    (for example ``{userId}`` in ``user/{userId}/signedup``).
    """

    key: str = Field(description="Stable key, for example ``user/signedup``.")
    address: str = Field(
        description="The wire address — topic, routing key, subject, or path.",
    )
    name: Optional[str] = None
    description: Optional[str] = None
    protocol: Optional[str] = Field(
        default=None,
        description="Transport protocol for this channel (kafka/amqp/mqtt/ws).",
    )
    parameters: List[CanonicalField] = Field(
        default_factory=list,
        description="Address template parameters, modeled as fields.",
    )
    bindings: Dict[str, Any] = Field(
        default_factory=dict,
        description="Protocol-specific binding settings (partitions, qos, …).",
    )


class ServerVariable(CanonicalBase):
    """A substitutable variable in a server URL template."""

    name: str
    default: Optional[str] = None
    enum: Optional[List[str]] = None
    description: Optional[str] = None


class Server(CanonicalBase):
    """A host/endpoint the artifact is served from."""

    url: str = Field(description="URL or URL template (may contain ``{variables}``).")
    name: Optional[str] = None
    description: Optional[str] = None
    protocol: Optional[str] = None
    variables: List[ServerVariable] = Field(default_factory=list)


class ApiIdentity(CanonicalBase):
    """Stable identity of the artifact, independent of its version."""

    name: str = Field(description="Human/source name of the API.")
    namespace: Optional[str] = Field(
        default=None,
        description="Package/group/target namespace (for example ``com.acme.pets``).",
    )
    id: Optional[str] = Field(
        default=None,
        description="A globally stable id when the source provides one (URN, "
        "package path, $id).",
    )


class CanonicalApi(CanonicalBase):
    """The root artifact: one normalized API description at one version.

    This is what normalizers (MFI-2.3) produce and what the persistence tables
    (MFI-2.2) store per ``version_id``. It is fully self-contained: every
    ``*_ref``/``TypeRef.name`` resolves to a ``key`` somewhere in this tree.
    """

    schema_version: int = Field(
        default=CANONICAL_API_SCHEMA_VERSION,
        description="Envelope version of this canonical model (see "
        "``CANONICAL_API_SCHEMA_VERSION``).",
    )
    paradigm: ApiParadigm
    format: str = Field(
        description="Source format key, for example ``openapi-3.1``, ``asyncapi-3``, "
        "``grpc``, ``graphql``, ``avro``.",
    )
    protocol: Optional[str] = Field(
        default=None,
        description="Primary transport protocol (http, grpc, kafka, graphql-over-http).",
    )
    identity: ApiIdentity
    version: Optional[str] = Field(
        default=None,
        description="Source-declared version of the API (for example ``1.4.0``).",
    )
    title: Optional[str] = None
    description: Optional[str] = None

    servers: List[Server] = Field(default_factory=list)
    services: List[Service] = Field(default_factory=list)
    channels: List[Channel] = Field(default_factory=list)
    types: List[Type] = Field(default_factory=list)

    raw: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Native AST / source document for full-fidelity round-tripping "
        "and per-format lint rules.",
    )

    def type_by_key(self, key: str) -> Optional[Type]:
        """Return the named :class:`Type` with ``key``, or ``None`` if absent."""
        for type_ in self.types:
            if type_.key == key:
                return type_
        return None

    def operations(self) -> List[Operation]:
        """Return every operation across all services, in declaration order."""
        return [op for service in self.services for op in service.operations]
