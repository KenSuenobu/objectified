"""End-to-end tests for the AsyncAPI emitter — MFX-11.1 (#3874), FMT-3.2 (#5427).

Exercises the acceptance criteria: a canonical **event** source emits a schema-valid
AsyncAPI 3.1 document (validated, when the bundled ``@asyncapi/parser`` toolchain is
present, by round-tripping it through :func:`app.asyncapi_parser.parse_asyncapi`), and
a **REST** source emits with documented reframing — its request/response operations
become AsyncAPI request/reply message exchanges and the HTTP method/path/status
semantics AsyncAPI cannot carry are enumerated as :class:`~app.emitter.Loss`\\es.
Emission is deterministic and every major construct carries a provenance tag. The
event case is additionally checked to be a *fixed point* of ``normalize ∘ emit`` — the
tightest statement that the emitter is the inverse of the reference normalizer.

FMT-3.2 adds the ``asyncapi_version`` option and its **2.6** downgrade target, so the
importer's 2.x support finally has a matching export. Its acceptance criteria are
proven here (with the projection's own unit tests in ``test_asyncapi_downgrade.py``):
a 2.6 document is emitted and validates with the bundled parser, a 2.6 source is a
fixed point of ``normalize ∘ emit-2.6`` — channels, operations, messages and bindings
all survive — and every 3.x-only construct the target cannot carry is a named loss.
"""

import asyncio

import pytest

from app.asyncapi_emitter import AsyncApiEmitOptions, AsyncApiEmitter
from app.asyncapi_normalizer import AsyncApiNormalizer
from app.asyncapi_parser import ASYNCAPI_PARSER_TOOL_KEY, parse_asyncapi
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    ServerVariable,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.diff import diff
from app.emitter import LossKind, Provenance
from app.toolchain_packaging import probe_tool

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _user_events_asyncapi() -> dict:
    """A small but representative AsyncAPI 3.0 document (native event source)."""
    return {
        "asyncapi": "3.0.0",
        "info": {
            "title": "User Events",
            "version": "1.2.0",
            "description": "User lifecycle events",
        },
        "servers": {
            "prod": {
                "host": "broker.example.com",
                "pathname": "/v1",
                "protocol": "kafka",
                "protocolVersion": "3.0",
            }
        },
        "channels": {
            "userSignedUp": {
                "address": "user/{region}/signedup",
                "parameters": {
                    "region": {
                        "default": "us",
                        "enum": ["us", "eu"],
                        "description": "deployment region",
                    }
                },
                "messages": {
                    "UserSignedUp": {
                        "name": "UserSignedUp",
                        "contentType": "application/json",
                        "payload": {
                            "type": "object",
                            "properties": {"id": {"type": "string"}},
                        },
                        "headers": {
                            "type": "object",
                            "properties": {"traceId": {"type": "string"}},
                            "required": ["traceId"],
                        },
                    }
                },
            }
        },
        "operations": {
            "onUserSignedUp": {
                "action": "receive",
                "channel": {"$ref": "#/channels/userSignedUp"},
                "messages": [
                    {"$ref": "#/channels/userSignedUp/messages/UserSignedUp"}
                ],
            }
        },
    }


def _streetlights_asyncapi_2() -> dict:
    """A representative AsyncAPI 2.6 document — the shape the 2.6 target emits back.

    Written with its messages inline (no ``$ref``\\s) so the normalizer can consume it
    directly, exactly as the ``@asyncapi/parser`` would hand it over dereferenced. It
    carries what the FMT-3.2 acceptance criterion names — channels, both operation
    slots, messages and bindings — plus a channel parameter whose ``schema`` a 3.x
    Parameter Object could not have held.
    """
    return {
        "asyncapi": "2.6.0",
        "id": "urn:com:example:streetlights",
        "defaultContentType": "application/json",
        "info": {
            "title": "Streetlights API",
            "version": "1.0.0",
            "description": "Street lighting telemetry.",
        },
        "servers": {
            "production": {
                "url": "mqtt://broker.example.com",
                "protocol": "mqtt",
                "protocolVersion": "5.0",
            }
        },
        "channels": {
            "light/{streetId}/measured": {
                "description": "Readings from one street's lights.",
                "parameters": {
                    "streetId": {
                        "description": "Street identifier.",
                        "schema": {"type": "string", "pattern": "^[a-z0-9-]+$"},
                    }
                },
                "bindings": {"mqtt": {"qos": 1}},
                "publish": {
                    "operationId": "onLightMeasured",
                    "message": {
                        "name": "LightMeasured",
                        "contentType": "application/json",
                        "payload": {
                            "type": "object",
                            "properties": {"lumens": {"type": "integer"}},
                        },
                    },
                },
                "subscribe": {
                    "operationId": "publishLightCommand",
                    "bindings": {"mqtt": {"qos": 2}},
                    "message": {
                        "name": "LightCommand",
                        "payload": {
                            "type": "object",
                            "properties": {"on": {"type": "boolean"}},
                        },
                    },
                },
            }
        },
    }


def _rest_model() -> CanonicalApi:
    """A canonical model as an OpenAPI/REST normalizer would produce."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Pet Store"),
        version="1.0.0",
        title="Pet Store",
        servers=[Server(url="https://api.example.com/v1", description="prod")],
        services=[
            Service(
                key="pets",
                name="pets",
                operations=[
                    Operation(
                        key="GET /pets/{id}",
                        name="getPet",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/pets/{id}",
                        tags=["pets"],
                        messages=[
                            Message(
                                key="GET /pets/{id}#request",
                                role=MessageRole.REQUEST,
                                payload=TypeRef(name="Pet", nullable=False),
                            ),
                            Message(
                                key="GET /pets/{id}#response.200",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                payload=TypeRef(name="Pet", nullable=False),
                            ),
                        ],
                    )
                ],
            )
        ],
        types=[
            Type(
                key="Pet",
                name="Pet",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="Pet.id",
                        name="id",
                        type=TypeRef(name="string", nullable=False),
                    )
                ],
            )
        ],
    )


def _data_schema_model() -> CanonicalApi:
    """A canonical model as a data-schema (Avro/JSON-Schema) normalizer would produce."""
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="avro",
        identity=ApiIdentity(name="User Record"),
        types=[
            Type(
                key="User",
                name="User",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="User.email",
                        name="email",
                        type=TypeRef(name="string", nullable=False),
                        constraints=Constraints(format="email"),
                    )
                ],
            )
        ],
    )


def _emit(model: CanonicalApi, opts=None):
    return AsyncApiEmitter().emit(model, opts=opts)


# ---------------------------------------------------------------------------
# Acceptance criterion: valid AsyncAPI 3 from an event source
# ---------------------------------------------------------------------------


def test_event_source_emits_structurally_valid_document() -> None:
    model = AsyncApiNormalizer().normalize(_user_events_asyncapi(), include_raw=False)
    doc = _emit(model).document

    assert doc["asyncapi"] == "3.1.0"
    assert doc["info"] == {
        "title": "User Events",
        "version": "1.2.0",
        "description": "User lifecycle events",
    }
    # Server: the v3 host/pathname split and protocol round-trip verbatim.
    assert doc["servers"]["prod"]["host"] == "broker.example.com"
    assert doc["servers"]["prod"]["pathname"] == "/v1"
    assert doc["servers"]["prod"]["protocol"] == "kafka"
    # Channel: address + address parameters preserved.
    channel = doc["channels"]["userSignedUp"]
    assert channel["address"] == "user/{region}/signedup"
    assert channel["parameters"]["region"] == {
        "default": "us",
        "enum": ["us", "eu"],
        "description": "deployment region",
    }
    # Message: payload + headers (rebuilt as an object schema) + contentType.
    message = channel["messages"]["UserSignedUp"]
    assert message["payload"] == {"type": "object", "properties": {"id": {"type": "string"}}}
    assert message["headers"] == {
        "type": "object",
        "properties": {"traceId": {"type": "string"}},
        "required": ["traceId"],
    }
    assert message["contentType"] == "application/json"
    # Operation: a SUBSCRIBE becomes `action: receive`, bound to its channel by $ref.
    operation = doc["operations"]["onUserSignedUp"]
    assert operation["action"] == "receive"
    assert operation["channel"] == {"$ref": "#/channels/userSignedUp"}
    assert operation["messages"] == [
        {"$ref": "#/channels/userSignedUp/messages/UserSignedUp"}
    ]


def test_publish_operation_emits_action_send() -> None:
    model = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="Emitter"),
        version="1",
        channels=[Channel(key="orders/placed", address="orders/placed")],
        services=[
            Service(
                key="default",
                name="default",
                operations=[
                    Operation(
                        key="publish orders/placed",
                        name="publishOrder",
                        kind=OperationKind.PUBLISH,
                        channel_ref="orders/placed",
                        messages=[
                            Message(
                                key="publish orders/placed#OrderPlaced",
                                role=MessageRole.EVENT,
                                name="OrderPlaced",
                                payload_schema={"type": "object"},
                            )
                        ],
                    )
                ],
            )
        ],
    )
    doc = _emit(model).document
    assert doc["operations"]["publishOrder"]["action"] == "send"
    # The event source incurs no reframing losses.
    assert _emit(model).losses == []


# ---------------------------------------------------------------------------
# Acceptance criterion: REST source emits with documented reframing
# ---------------------------------------------------------------------------


def test_rest_source_reframes_as_request_reply() -> None:
    result = _emit(_rest_model())
    doc = result.document

    # The operation is reframed as a `send` with a `reply` block.
    operation = doc["operations"]["getPet"]
    assert operation["action"] == "send"
    channel_ref = operation["channel"]["$ref"]
    channel_name = channel_ref.rsplit("/", 1)[-1]
    assert operation["messages"] == [
        {"$ref": f"#/channels/{channel_name}/messages/requestMessage"}
    ]
    assert operation["reply"]["messages"] == [
        {"$ref": f"#/channels/{channel_name}/messages/responseMessage"}
    ]
    # The synthesized channel carries the HTTP route as its readable address.
    assert doc["channels"][channel_name]["address"] == "/pets/{id}"
    # Component schemas still reach `components.schemas` faithfully.
    assert doc["components"]["schemas"]["Pet"] == {
        "type": "object",
        "properties": {"id": {"type": "string"}},
        "required": ["id"],
    }


def test_rest_reframing_documents_dropped_http_semantics() -> None:
    losses = _emit(_rest_model()).losses
    subjects = {loss.subject for loss in losses}
    # Reframing, the synthesized channel, the dropped HTTP binding, and the dropped
    # response status are each surfaced rather than silently discarded.
    assert "request-reply-reframe" in subjects
    assert "synthesized-channel" in subjects
    assert "http-binding" in subjects
    assert "http-status" in subjects
    # The HTTP binding and status are `n/a` (no AsyncAPI representation at all).
    na = {loss.subject for loss in losses if loss.kind is LossKind.NA}
    assert {"http-binding", "http-status"} <= na


def test_data_schema_source_emits_components_only_document() -> None:
    result = _emit(_data_schema_model())
    doc = result.document
    assert "channels" not in doc
    assert "operations" not in doc
    assert doc["components"]["schemas"]["User"] == {
        "type": "object",
        "properties": {"email": {"type": "string", "format": "email"}},
        "required": ["email"],
    }


# ---------------------------------------------------------------------------
# Determinism & round-trip fidelity
# ---------------------------------------------------------------------------


def test_emission_is_deterministic() -> None:
    model = AsyncApiNormalizer().normalize(_user_events_asyncapi(), include_raw=False)
    first = _emit(model)
    second = _emit(model)
    assert first.document == second.document
    assert first.model_dump() == second.model_dump()  # provenance + losses too


def test_event_conversion_is_a_fixed_point() -> None:
    # normalize(emit(normalize(doc))) == normalize(doc): the emitter is the inverse of
    # the reference normalizer on the load-bearing event fields.
    original = _user_events_asyncapi()
    once = AsyncApiNormalizer().normalize(original, include_raw=False)
    emitted = _emit(once).document
    twice = AsyncApiNormalizer().normalize(emitted, include_raw=False)
    assert once.model_dump() == twice.model_dump()


def test_shared_channel_messages_are_deduplicated() -> None:
    # Two operations on one channel referencing the same message emit it once.
    shared = Message(
        key="msg#Ping",
        role=MessageRole.EVENT,
        name="Ping",
        payload_schema={"type": "object"},
    )
    model = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="Dup"),
        version="1",
        channels=[Channel(key="ping", address="ping")],
        services=[
            Service(
                key="default",
                name="default",
                operations=[
                    Operation(
                        key="send ping",
                        name="sendPing",
                        kind=OperationKind.PUBLISH,
                        channel_ref="ping",
                        messages=[shared],
                    ),
                    Operation(
                        key="receive ping",
                        name="receivePing",
                        kind=OperationKind.SUBSCRIBE,
                        channel_ref="ping",
                        messages=[shared],
                    ),
                ],
            )
        ],
    )
    doc = _emit(model).document
    assert list(doc["channels"]["ping"]["messages"]) == ["Ping"]
    assert doc["operations"]["sendPing"]["messages"] == doc["operations"]["receivePing"]["messages"]


# ---------------------------------------------------------------------------
# info / servers defaults & provenance
# ---------------------------------------------------------------------------


def test_info_defaults_title_from_identity_and_version_fallback() -> None:
    model = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="Nameless"),
    )
    result = _emit(model)
    assert result.document["info"] == {"title": "Nameless", "version": "0.0.0"}
    by_pointer = {r.pointer: r for r in result.provenance}
    assert by_pointer["/info/title"].provenance is Provenance.INFERRED
    assert by_pointer["/info/version"].provenance is Provenance.DEFAULT
    assert by_pointer["/asyncapi"].provenance is Provenance.DEFAULT


def test_server_host_and_protocol_derived_from_url() -> None:
    model = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="S"),
        version="1",
        servers=[Server(url="https://api.example.com/base", name="prod")],
    )
    result = _emit(model)
    server = result.document["servers"]["prod"]
    assert server["host"] == "api.example.com"
    assert server["pathname"] == "/base"
    assert server["protocol"] == "https"
    host_prov = next(
        r for r in result.provenance if r.pointer == "/servers/prod/host"
    )
    assert host_prov.provenance is Provenance.INFERRED


def test_server_variables_round_trip() -> None:
    model = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="S"),
        version="1",
        servers=[
            Server(
                url="broker.example.com",
                name="prod",
                protocol="kafka",
                variables=[
                    ServerVariable(name="port", default="9092", enum=["9092", "9093"])
                ],
            )
        ],
    )
    server = _emit(model).document["servers"]["prod"]
    assert server["variables"] == {"port": {"default": "9092", "enum": ["9092", "9093"]}}


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------


def test_include_channels_false_yields_schemas_only() -> None:
    result = _emit(_rest_model(), opts=AsyncApiEmitOptions(include_channels=False))
    doc = result.document
    assert "channels" not in doc
    assert "operations" not in doc
    assert "Pet" in doc["components"]["schemas"]


def test_include_components_false_omits_schemas() -> None:
    result = _emit(_rest_model(), opts=AsyncApiEmitOptions(include_components=False))
    assert "components" not in result.document


# ---------------------------------------------------------------------------
# FMT-3.2: the asyncapi_version option and its 2.6 downgrade target
# ---------------------------------------------------------------------------


def _emit_2(model: CanonicalApi):
    """Emit ``model`` against the 2.6 downgrade target."""
    return _emit(model, opts=AsyncApiEmitOptions(asyncapi_version="2.6"))


def test_asyncapi_version_defaults_to_the_native_target() -> None:
    assert AsyncApiEmitOptions().asyncapi_version == "3.1"
    model = AsyncApiNormalizer().normalize(_user_events_asyncapi(), include_raw=False)
    assert _emit(model).document["asyncapi"] == "3.1.0"


def test_asyncapi_2_target_emits_a_2_6_document() -> None:
    model = AsyncApiNormalizer().normalize(
        _streetlights_asyncapi_2(), include_raw=False
    )
    doc = _emit_2(model).document

    assert doc["asyncapi"] == "2.6.0"
    # The 2.x object model: no top-level ``operations``, channels keyed by address.
    assert "operations" not in doc
    assert list(doc["channels"]) == ["light/{streetId}/measured"]
    assert doc["servers"]["production"]["url"] == "mqtt://broker.example.com"


def test_asyncapi_2_round_trip_preserves_channels_operations_messages_bindings() -> None:
    source = _streetlights_asyncapi_2()
    model = AsyncApiNormalizer().normalize(source, include_raw=False)
    channel = _emit_2(model).document["channels"]["light/{streetId}/measured"]
    source_channel = source["channels"]["light/{streetId}/measured"]

    assert channel["description"] == source_channel["description"]
    assert channel["bindings"] == source_channel["bindings"]
    assert channel["parameters"]["streetId"]["schema"] == (
        source_channel["parameters"]["streetId"]["schema"]
    )
    for action in ("publish", "subscribe"):
        emitted, original = channel[action], source_channel[action]
        assert emitted["operationId"] == original["operationId"]
        assert emitted["message"]["name"] == original["message"]["name"]
        assert emitted["message"]["payload"] == original["message"]["payload"]
        assert emitted.get("bindings") == original.get("bindings")


def test_asyncapi_2_conversion_is_a_fixed_point() -> None:
    # The tightest statement of "2.6 → canonical → 2.6 preserves the model": the
    # re-normalized emission is entity-for-entity the model it came from.
    model = AsyncApiNormalizer().normalize(
        _streetlights_asyncapi_2(), include_raw=False
    )
    reimported = AsyncApiNormalizer().normalize(
        _emit_2(model).document, include_raw=False
    )

    assert diff(model, reimported).is_empty()


def test_asyncapi_2_target_reports_no_loss_for_a_2_x_source() -> None:
    model = AsyncApiNormalizer().normalize(
        _streetlights_asyncapi_2(), include_raw=False
    )
    assert _emit_2(model).losses == []


def test_asyncapi_2_target_names_the_three_x_only_constructs_it_drops() -> None:
    # A 3.x source: its channel is named apart from its address, which 2.x — keying a
    # channel by its address — cannot keep.
    model = AsyncApiNormalizer().normalize(_user_events_asyncapi(), include_raw=False)
    losses = _emit_2(model).losses

    assert [loss.subject for loss in losses] == ["asyncapi2-channel-name"]
    assert losses[0].kind is LossKind.NA
    assert "userSignedUp" in losses[0].detail


def test_asyncapi_2_target_reports_the_reframed_reply_it_cannot_carry() -> None:
    # A REST source is reframed as a send + reply; 2.x has no request/reply pattern.
    subjects = {loss.subject for loss in _emit_2(_rest_model()).losses}

    assert "asyncapi2-operation-reply" in subjects
    # The 3.1 reframing losses still ride along — the downgrade adds to them.
    assert "request-reply-reframe" in subjects


def test_asyncapi_2_version_string_carries_downgrade_provenance() -> None:
    model = AsyncApiNormalizer().normalize(
        _streetlights_asyncapi_2(), include_raw=False
    )
    record = next(
        r for r in _emit_2(model).provenance if r.pointer == "/asyncapi"
    )

    assert record.provenance is Provenance.DEFAULT
    assert record.detail == "downgraded from AsyncAPI 3.1.0 to AsyncAPI 2.6.0"


def test_asyncapi_2_components_only_export_declares_an_empty_channels_map() -> None:
    # ``channels`` is required in 2.x but optional in 3.x.
    doc = _emit(
        _data_schema_model(),
        opts=AsyncApiEmitOptions(asyncapi_version="2.6", include_channels=False),
    ).document

    assert doc["channels"] == {}
    assert "User" in doc["components"]["schemas"]


def test_asyncapi_2_emission_is_deterministic() -> None:
    model = AsyncApiNormalizer().normalize(
        _streetlights_asyncapi_2(), include_raw=False
    )
    first, second = _emit_2(model), _emit_2(model)

    assert first.document == second.document
    assert first.losses == second.losses


# ---------------------------------------------------------------------------
# Registry / descriptor / capability profile
# ---------------------------------------------------------------------------


def test_emitter_is_registered_with_capability_profile() -> None:
    from app.emitter import available_emit_formats, get_emitter

    assert get_emitter("asyncapi-3") is AsyncApiEmitter
    assert "asyncapi-3" in available_emit_formats()
    descriptor = AsyncApiEmitter.descriptor()
    assert descriptor.key == "asyncapi"
    assert descriptor.format == "asyncapi-3"
    assert descriptor.paradigm is ApiParadigm.EVENT
    profile = AsyncApiEmitter.capability_profile()
    # AsyncAPI carries events natively but has no faithful REST-operation vocabulary.
    assert profile.events is True
    assert profile.operations is False
    assert profile.unions is True
    assert profile.constraints is True


# ---------------------------------------------------------------------------
# Integration: validate the emitted document with @asyncapi/parser (needs Node)
# ---------------------------------------------------------------------------

_PARSER_AVAILABLE = bool(
    getattr(probe_tool(ASYNCAPI_PARSER_TOOL_KEY), "available", False)
)


@pytest.mark.skipif(
    not _PARSER_AVAILABLE,
    reason="the bundled @asyncapi/parser toolchain is not installed in this runtime",
)
class TestAsyncApiParserValidation:
    """Feed the emitted document back through the real ``@asyncapi/parser``.

    The acceptance-criterion "emits valid AsyncAPI 3" check, exercised end to end with
    the authoritative validator when the Node toolchain is available.
    """

    def test_event_source_output_validates(self) -> None:
        import json

        model = AsyncApiNormalizer().normalize(
            _user_events_asyncapi(), include_raw=False
        )
        doc = _emit(model).document
        result = asyncio.run(parse_asyncapi(json.dumps(doc)))
        assert result.ok, [d.message for d in result.errors]
        assert result.asyncapi_version == "3.1.0"

    def test_rest_reframed_output_validates(self) -> None:
        import json

        doc = _emit(_rest_model()).document
        result = asyncio.run(parse_asyncapi(json.dumps(doc)))
        assert result.ok, [d.message for d in result.errors]

    def test_asyncapi_2_output_validates(self) -> None:
        # FMT-3.2's first acceptance criterion: the downgrade target emits a document
        # the bundled AsyncAPI parser accepts as legal 2.6.
        import json

        model = AsyncApiNormalizer().normalize(
            _streetlights_asyncapi_2(), include_raw=False
        )
        result = asyncio.run(parse_asyncapi(json.dumps(_emit_2(model).document)))
        assert result.ok, [d.message for d in result.errors]
        assert result.asyncapi_version == "2.6.0"

    def test_asyncapi_2_output_from_a_rest_source_validates(self) -> None:
        # The cross-paradigm case: a reframed REST model still emits legal 2.6, with
        # the reply it cannot carry recorded rather than emitted.
        import json

        result = asyncio.run(
            parse_asyncapi(json.dumps(_emit_2(_rest_model()).document))
        )
        assert result.ok, [d.message for d in result.errors]
