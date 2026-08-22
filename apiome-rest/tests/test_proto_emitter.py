"""Tests for the Protocol Buffers (proto3) emitter — MFX-12.1 (#3879).

Exercises the acceptance criteria: a typed **RPC** source emits compilable proto3 ``.proto`` with
**streaming preserved** — every :class:`~app.canonical_model.StreamingMode` restores the right
``stream`` keyword on the request/response — and the type system (messages, nested messages,
enums, ``map<K,V>``, ``oneof``, ``repeated``, proto3 ``optional``, ``reserved``, field numbers)
inverts :mod:`app.proto_normalizer` construct-for-construct. Constructs proto3 cannot carry (a
field's ``Constraints``, a proto2 ``default``, a ``UNION`` type, a source field with no number)
are recorded as :class:`~app.emitter.Loss`\\es. Emission is deterministic and provenance-tagged.

The structural tests assert the emitted text and run everywhere (no toolchain). The gated
``TestRealBuf`` class compiles the emitted document through the real bundled ``buf`` and normalizes
it back, proving the ``.proto`` is legal and that a proto source is a fixed point of
``normalize ∘ emit`` — but only when ``buf`` is resolvable (bundled in the image / ``APIOME_BUF_BIN``).
"""

from __future__ import annotations

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import Provenance, get_emitter
from app.proto_descriptor import BUF_TOOL_KEY
from app.proto_emitter import ProtoEmitOptions, ProtoEmitter, compile_emitted_descriptor_set
from app.proto_normalizer import ProtoNormalizer
from app.toolchain_packaging import probe_tool

_BUF_AVAILABLE = bool(getattr(probe_tool(BUF_TOOL_KEY), "available", False))


# ---------------------------------------------------------------------------
# Model builders
# ---------------------------------------------------------------------------
def _rpc_api() -> CanonicalApi:
    """A self-contained single-package RPC model exercising the full proto surface.

    One package (``acme.user``), a nested message, an enum, a ``map`` field, a ``oneof``, a
    ``repeated`` field, a proto3 ``optional`` field, ``reserved`` ranges/names, a well-known-type
    reference (``Timestamp``), and two rpcs (unary + bidi-streaming).
    """
    address = Type(
        key="acme.user.Address",
        name="Address",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="acme.user.Address.street",
                name="street",
                type=TypeRef(name="string"),
                field_number=1,
            )
        ],
    )
    role = Type(
        key="acme.user.Role",
        name="Role",
        kind=TypeKind.ENUM,
        description="Access role.",
        enum_values=[
            EnumValue(key="acme.user.Role.ROLE_UNSPECIFIED", name="ROLE_UNSPECIFIED", value=0),
            EnumValue(key="acme.user.Role.ROLE_MEMBER", name="ROLE_MEMBER", value=1),
            EnumValue(key="acme.user.Role.ROLE_ADMIN", name="ROLE_ADMIN", value=2),
        ],
    )
    labels_entry = Type(
        key="acme.user.User.LabelsEntry",
        name="LabelsEntry",
        kind=TypeKind.MAP,
        key_type=TypeRef(name="string"),
        value_type=TypeRef(name="int32"),
    )
    meta = Type(
        key="acme.user.User.Meta",
        name="Meta",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="acme.user.User.Meta.note",
                name="note",
                type=TypeRef(name="string"),
                field_number=1,
            )
        ],
    )
    user = Type(
        key="acme.user.User",
        name="User",
        kind=TypeKind.RECORD,
        description="A registered user.",
        fields=[
            CanonicalField(
                key="acme.user.User.id", name="id", type=TypeRef(name="string"), field_number=1
            ),
            CanonicalField(
                key="acme.user.User.address",
                name="address",
                type=TypeRef(name="acme.user.Address"),
                field_number=3,
            ),
            CanonicalField(
                key="acme.user.User.created_at",
                name="created_at",
                type=TypeRef(name="google.protobuf.Timestamp"),
                field_number=4,
            ),
            CanonicalField(
                key="acme.user.User.role",
                name="role",
                type=TypeRef(name="acme.user.Role"),
                field_number=5,
            ),
            CanonicalField(
                key="acme.user.User.tags",
                name="tags",
                type=TypeRef(item=TypeRef(name="string", nullable=False), nullable=False),
                field_number=6,
                extras={"label": "repeated"},
            ),
            CanonicalField(
                key="acme.user.User.labels",
                name="labels",
                type=TypeRef(name="acme.user.User.LabelsEntry", nullable=False),
                field_number=7,
            ),
            CanonicalField(
                key="acme.user.User.nick",
                name="nick",
                type=TypeRef(name="string"),
                field_number=8,
                extras={"proto3_optional": True},
            ),
            CanonicalField(
                key="acme.user.User.email",
                name="email",
                type=TypeRef(name="string"),
                field_number=9,
                extras={"oneof": "contact"},
            ),
            CanonicalField(
                key="acme.user.User.phone",
                name="phone",
                type=TypeRef(name="string"),
                field_number=10,
                extras={"oneof": "contact"},
            ),
            CanonicalField(
                key="acme.user.User.meta",
                name="meta",
                type=TypeRef(name="acme.user.User.Meta"),
                field_number=11,
            ),
        ],
        extras={
            "oneofs": ["contact"],
            "reserved_ranges": [[2, 3]],
            "reserved_names": ["old_name"],
        },
    )
    get_req = Type(
        key="acme.user.GetUserRequest",
        name="GetUserRequest",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="acme.user.GetUserRequest.id",
                name="id",
                type=TypeRef(name="string"),
                field_number=1,
            )
        ],
    )
    service = Service(
        key="acme.user.UserService",
        name="UserService",
        operations=[
            Operation(
                key="acme.user.UserService.GetUser",
                name="GetUser",
                kind=OperationKind.REQUEST_RESPONSE,
                streaming=StreamingMode.NONE,
                messages=[
                    Message(
                        key="acme.user.UserService.GetUser#request",
                        role=MessageRole.REQUEST,
                        payload=TypeRef(name="acme.user.GetUserRequest"),
                    ),
                    Message(
                        key="acme.user.UserService.GetUser#response",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="acme.user.User"),
                    ),
                ],
            ),
            Operation(
                key="acme.user.UserService.Chat",
                name="Chat",
                kind=OperationKind.REQUEST_RESPONSE,
                streaming=StreamingMode.BIDIRECTIONAL,
                extras={"idempotency_level": "no_side_effects"},
                messages=[
                    Message(
                        key="acme.user.UserService.Chat#request",
                        role=MessageRole.REQUEST,
                        payload=TypeRef(name="acme.user.GetUserRequest"),
                    ),
                    Message(
                        key="acme.user.UserService.Chat#response",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="acme.user.User"),
                    ),
                ],
            ),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        protocol="grpc",
        identity=ApiIdentity(name="acme.user", namespace="acme.user"),
        services=[service],
        types=[address, role, labels_entry, meta, user, get_req],
    )


def _emit(api: CanonicalApi, opts: ProtoEmitOptions | None = None) -> str:
    """Emit ``api`` and return the primary ``.proto`` text."""
    return str(ProtoEmitter().emit(api, opts=opts).files[0].content)


# ---------------------------------------------------------------------------
# Registration + descriptor
# ---------------------------------------------------------------------------
def test_registers_under_proto3_format() -> None:
    assert get_emitter("proto3") is ProtoEmitter


def test_descriptor_and_capability_profile() -> None:
    descriptor = ProtoEmitter.descriptor()
    assert descriptor.key == "protobuf"
    assert descriptor.format == "proto3"
    assert descriptor.paradigm == ApiParadigm.RPC
    assert descriptor.multi_file is True
    # Emit needs no toolchain (pure text); buf is only for the optional compile/validate.
    assert descriptor.needs_toolchain is False

    profile = ProtoEmitter.capability_profile()
    assert profile.operations is True
    assert profile.field_identity is True  # field numbers are protobuf's strength
    assert profile.unions is False  # no first-class union type
    assert profile.constraints is False  # no native validation facets


# ---------------------------------------------------------------------------
# Header / package / imports
# ---------------------------------------------------------------------------
def test_header_syntax_package_and_wkt_import() -> None:
    text = _emit(_rpc_api())
    assert text.startswith('syntax = "proto3";')
    assert "package acme.user;" in text
    # The Timestamp reference pulls in exactly its well-known-type import.
    assert 'import "google/protobuf/timestamp.proto";' in text


def test_package_option_overrides_identity_namespace() -> None:
    text = _emit(_rpc_api(), ProtoEmitOptions(package="other.pkg"))
    assert "package other.pkg;" in text


# ---------------------------------------------------------------------------
# Services / streaming (the acceptance criterion)
# ---------------------------------------------------------------------------
def test_service_and_rpc_unary_and_bidi_streaming() -> None:
    text = _emit(_rpc_api())
    assert "service UserService {" in text
    # Unary: no stream keyword either side.
    assert "rpc GetUser (.acme.user.GetUserRequest) returns (.acme.user.User);" in text
    # Bidi: stream on both request and response.
    assert "rpc Chat (stream .acme.user.GetUserRequest) returns (stream .acme.user.User)" in text
    # Method option restored from extras.
    assert "option idempotency_level = NO_SIDE_EFFECTS;" in text


@pytest.mark.parametrize(
    "mode, expected",
    [
        (StreamingMode.NONE, "rpc M (.p.Req) returns (.p.Resp);"),
        (StreamingMode.CLIENT, "rpc M (stream .p.Req) returns (.p.Resp);"),
        (StreamingMode.SERVER, "rpc M (.p.Req) returns (stream .p.Resp);"),
        (StreamingMode.BIDIRECTIONAL, "rpc M (stream .p.Req) returns (stream .p.Resp);"),
    ],
)
def test_all_four_streaming_modes_render(mode: StreamingMode, expected: str) -> None:
    """Each of the four streaming modes restores the exact ``stream`` placement."""
    req = Type(key="p.Req", name="Req", kind=TypeKind.RECORD)
    resp = Type(key="p.Resp", name="Resp", kind=TypeKind.RECORD)
    service = Service(
        key="p.S",
        name="S",
        operations=[
            Operation(
                key="p.S.M",
                name="M",
                kind=OperationKind.REQUEST_RESPONSE,
                streaming=mode,
                messages=[
                    Message(key="p.S.M#request", role=MessageRole.REQUEST, payload=TypeRef(name="p.Req")),
                    Message(key="p.S.M#response", role=MessageRole.RESPONSE, payload=TypeRef(name="p.Resp")),
                ],
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        services=[service],
        types=[req, resp],
    )
    assert expected in _emit(api)


def test_emit_services_disabled_omits_services_and_records_loss() -> None:
    result = ProtoEmitter().emit(_rpc_api(), opts=ProtoEmitOptions(emit_services=False))
    text = str(result.files[0].content)
    assert "service UserService" not in text
    assert "message User" in text  # types still emitted
    assert any(loss.subject == "emit-services-disabled" for loss in result.losses)


# ---------------------------------------------------------------------------
# Messages / fields / maps / oneof / nesting / reserved
# ---------------------------------------------------------------------------
def test_message_fields_numbers_and_type_references() -> None:
    text = _emit(_rpc_api())
    assert "message User {" in text
    assert "string id = 1;" in text
    # A message reference is emitted fully-qualified with a leading dot (unambiguous resolution).
    assert ".acme.user.Address address = 3;" in text
    assert ".google.protobuf.Timestamp created_at = 4;" in text
    assert ".acme.user.Role role = 5;" in text


def test_repeated_map_and_optional_fields() -> None:
    text = _emit(_rpc_api())
    assert "repeated string tags = 6;" in text
    # The MAP type is inlined as map<K,V>, never emitted as a standalone LabelsEntry message.
    assert "map<string, int32> labels = 7;" in text
    assert "message LabelsEntry" not in text
    assert "optional string nick = 8;" in text


def test_oneof_block_groups_members() -> None:
    text = _emit(_rpc_api())
    assert "oneof contact {" in text
    assert "string email = 9;" in text
    assert "string phone = 10;" in text


def test_nested_message_is_reconstructed_from_dotted_key() -> None:
    text = _emit(_rpc_api())
    # Meta is keyed acme.user.User.Meta → nested inside User, referenced by its full path.
    user_block = text.split("message User {", 1)[1]
    assert "message Meta {" in user_block
    assert ".acme.user.User.Meta meta = 11;" in text


def test_reserved_ranges_and_names() -> None:
    text = _emit(_rpc_api())
    # Message reserved range [2, 3) (half-open) → the single inclusive number 2.
    assert "reserved 2;" in text
    assert 'reserved "old_name";' in text


def test_reserved_range_inclusive_conversion_and_max() -> None:
    """A multi-number half-open message range renders inclusive; an open-ended one renders ``to max``."""
    record = Type(
        key="p.R",
        name="R",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="p.R.a", name="a", type=TypeRef(name="string"), field_number=1)],
        extras={"reserved_ranges": [[9, 12], [100, 536870912]]},
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[record],
    )
    text = _emit(api)
    assert "reserved 9 to 11, 100 to max;" in text


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
def test_enum_values_preserve_numbers_and_zero_first() -> None:
    text = _emit(_rpc_api())
    assert "enum Role {" in text
    assert "ROLE_UNSPECIFIED = 0;" in text
    assert "ROLE_MEMBER = 1;" in text
    assert "ROLE_ADMIN = 2;" in text


def test_enum_allow_alias_option() -> None:
    enum = Type(
        key="p.E",
        name="E",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="p.E.A", name="A", value=0),
            EnumValue(key="p.E.B", name="B", value=1),
            EnumValue(key="p.E.C", name="C", value=1),
        ],
        extras={"allow_alias": True},
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[enum],
    )
    assert "option allow_alias = true;" in _emit(api)


def test_enum_non_zero_first_is_reordered_zero_first() -> None:
    """proto3 requires the first enum value to be 0; a non-zero-first source is reordered."""
    enum = Type(
        key="p.E",
        name="E",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="p.E.A", name="A", value=1),
            EnumValue(key="p.E.Z", name="Z", value=0),
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[enum],
    )
    text = _emit(api)
    zero_pos = text.index("Z = 0;")
    one_pos = text.index("A = 1;")
    assert zero_pos < one_pos


def test_enum_without_zero_synthesizes_unspecified() -> None:
    enum = Type(
        key="p.Color",
        name="Color",
        kind=TypeKind.ENUM,
        enum_values=[EnumValue(key="p.Color.RED", name="RED", value=1)],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[enum],
    )
    result = ProtoEmitter().emit(api)
    text = str(result.files[0].content)
    assert "COLOR_UNSPECIFIED = 0;" in text
    assert any(loss.subject == "synthesized-enum-zero" for loss in result.losses)


def test_enum_without_numbers_assigns_zero_based_indices() -> None:
    enum = Type(
        key="p.Color",
        name="Color",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="p.Color.RED", name="RED"),
            EnumValue(key="p.Color.GREEN", name="GREEN"),
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[enum],
    )
    result = ProtoEmitter().emit(api)
    text = str(result.files[0].content)
    assert "RED = 0;" in text
    assert "GREEN = 1;" in text
    assert any(loss.subject == "synthesized-enum-number" for loss in result.losses)


# ---------------------------------------------------------------------------
# Determinism + provenance
# ---------------------------------------------------------------------------
def test_emission_is_deterministic() -> None:
    api = _rpc_api()
    assert _emit(api) == _emit(api)


def test_provenance_records_source_and_defaults() -> None:
    result = ProtoEmitter().emit(_rpc_api())
    by_pointer = {record.pointer: record for record in result.provenance}
    assert by_pointer["/syntax"].provenance == Provenance.DEFAULT
    assert by_pointer["/package"].provenance == Provenance.SOURCE
    assert by_pointer["/messages/acme.user.User"].provenance == Provenance.SOURCE


# ---------------------------------------------------------------------------
# Losses for constructs proto3 cannot carry
# ---------------------------------------------------------------------------
def test_field_constraints_and_default_are_losses() -> None:
    record = Type(
        key="p.M",
        name="M",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="p.M.n",
                name="n",
                type=TypeRef(name="int32"),
                field_number=1,
                constraints=Constraints(minimum=0, maximum=10),
                default=5,
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[record],
    )
    subjects = {loss.subject for loss in ProtoEmitter().emit(api).losses}
    assert "field-constraints" in subjects
    assert "proto3-default" in subjects


def test_missing_field_number_is_synthesized_with_loss() -> None:
    record = Type(
        key="p.M",
        name="M",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="p.M.a", name="a", type=TypeRef(name="string")),
            CanonicalField(key="p.M.b", name="b", type=TypeRef(name="string"), field_number=5),
            CanonicalField(key="p.M.c", name="c", type=TypeRef(name="string")),
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[record],
    )
    result = ProtoEmitter().emit(api)
    text = str(result.files[0].content)
    # Source number 5 is honoured; the numberless a/c fill the first free numbers (1, 2).
    assert "string a = 1;" in text
    assert "string b = 5;" in text
    assert "string c = 2;" in text
    assert any(loss.subject == "synthesized-field-number" for loss in result.losses)


def test_union_type_is_approximated_as_message_oneof() -> None:
    member_a = Type(key="p.A", name="A", kind=TypeKind.RECORD)
    member_b = Type(key="p.B", name="B", kind=TypeKind.RECORD)
    union = Type(
        key="p.Shape",
        name="Shape",
        kind=TypeKind.UNION,
        union_members=["p.A", "p.B"],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="p", namespace="p"),
        types=[member_a, member_b, union],
    )
    result = ProtoEmitter().emit(api)
    text = str(result.files[0].content)
    assert "message Shape {" in text
    assert "oneof value {" in text
    assert ".p.A a = 1;" in text
    assert ".p.B b = 2;" in text
    assert any(loss.subject == "union-as-oneof" for loss in result.losses)


def test_multi_package_emits_per_package_files_with_imports() -> None:
    """Types in distinct protobuf packages become separate ``.proto`` files linked by ``import``."""
    address = Type(
        key="acme.common.Address",
        name="Address",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="acme.common.Address.street",
                name="street",
                type=TypeRef(name="string"),
                field_number=1,
            )
        ],
    )
    user = Type(
        key="acme.user.User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="acme.user.User.address",
                name="address",
                type=TypeRef(name="acme.common.Address"),
                field_number=1,
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="acme.user", namespace="acme.user"),
        types=[address, user],
    )
    result = ProtoEmitter().emit(api)
    assert len(result.files) == 2
    paths = {f.path for f in result.files}
    assert paths == {"acme/common.proto", "acme/user.proto"}
    user_text = str(next(f for f in result.files if f.path == "acme/user.proto").content)
    common_text = str(next(f for f in result.files if f.path == "acme/common.proto").content)
    assert "package acme.common;" in common_text
    assert "message Address {" in common_text
    assert "package acme.user;" in user_text
    assert 'import "acme/common.proto";' in user_text
    assert ".acme.common.Address address = 1;" in user_text
    assert not any(loss.subject == "out-of-package-type" for loss in result.losses)


def test_single_package_api_emits_one_file() -> None:
    """A single-package source still yields one ``.proto`` file (not forced into a bundle)."""
    result = ProtoEmitter().emit(_rpc_api())
    assert len(result.files) == 1
    assert result.files[0].path == "acme/user.proto"


def test_event_operation_without_response_uses_empty_and_records_losses() -> None:
    event_type = Type(key="p.Ping", name="Ping", kind=TypeKind.RECORD)
    service = Service(
        key="p.Pinger",
        name="Pinger",
        operations=[
            Operation(
                key="p.Pinger.OnPing",
                name="OnPing",
                kind=OperationKind.PUBLISH,
                messages=[
                    Message(key="p.Pinger.OnPing#e", role=MessageRole.EVENT, payload=TypeRef(name="p.Ping"))
                ],
            )
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="p", namespace="p"),
        services=[service],
        types=[event_type],
    )
    result = ProtoEmitter().emit(api)
    text = str(result.files[0].content)
    # The event payload becomes the request; the missing response falls back to Empty.
    assert "rpc OnPing (.p.Ping) returns (.google.protobuf.Empty);" in text
    assert 'import "google/protobuf/empty.proto";' in text
    subjects = {loss.subject for loss in result.losses}
    assert "event-operation" in subjects
    assert "synthesized-response" in subjects


# ---------------------------------------------------------------------------
# Real buf: compile + round-trip (gated)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Protobuf Editions downgrade — FMT-3.7 (#5432)
# ---------------------------------------------------------------------------
# This emitter targets proto3, which has no `edition` and no way to say `required`. FMT-3.7
# asks it either to grow an edition mode or to declare the loss explicitly; it declares it —
# and, where proto3 *can* express the same thing, preserves rather than drops.


def _editions_api() -> CanonicalApi:
    """A model shaped like one the FMT-3.7 normalizer produces from an Editions document."""
    order = Type(
        key="acme.order.Order",
        name="Order",
        kind=TypeKind.RECORD,
        extras={"proto_features": {"json_format": "LEGACY_BEST_EFFORT"}},
        fields=[
            CanonicalField(
                key="acme.order.Order.explicit_id",
                name="explicit_id",
                type=TypeRef(name="string", nullable=True),
                field_number=1,
                extras={"label": "optional", "field_presence": "EXPLICIT"},
            ),
            CanonicalField(
                key="acme.order.Order.implicit_count",
                name="implicit_count",
                type=TypeRef(name="int64", nullable=False),
                field_number=2,
                extras={"label": "optional", "field_presence": "IMPLICIT"},
            ),
            CanonicalField(
                key="acme.order.Order.legacy_required_sku",
                name="legacy_required_sku",
                type=TypeRef(name="string", nullable=False),
                field_number=3,
                extras={"label": "optional", "field_presence": "LEGACY_REQUIRED"},
            ),
            CanonicalField(
                key="acme.order.Order.grouped",
                name="grouped",
                type=TypeRef(name="acme.order.Order", nullable=True),
                field_number=4,
                extras={
                    "label": "optional",
                    "field_presence": "EXPLICIT",
                    "proto_features": {"message_encoding": "DELIMITED"},
                },
            ),
        ],
    )
    status = Type(
        key="acme.order.Status",
        name="Status",
        kind=TypeKind.ENUM,
        extras={"enum_closed": True},
        enum_values=[
            EnumValue(key="acme.order.Status.STATUS_UNSPECIFIED", name="STATUS_UNSPECIFIED", value=0),
            EnumValue(key="acme.order.Status.STATUS_OPEN", name="STATUS_OPEN", value=1),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        protocol="grpc",
        identity=ApiIdentity(name="acme.order", namespace="acme.order"),
        types=[order, status],
        extras={
            "protobuf_editions": {
                "editions": ["2023"],
                "syntaxes": ["editions"],
                "files": [
                    {
                        "file": "order/order.proto",
                        "syntax": "editions",
                        "edition": "2023",
                        "features": {
                            "field_presence": "EXPLICIT",
                            "enum_type": "CLOSED",
                            "repeated_field_encoding": "EXPANDED",
                            "utf8_validation": "VERIFY",
                            "message_encoding": "LENGTH_PREFIXED",
                            "json_format": "LEGACY_BEST_EFFORT",
                        },
                    }
                ],
                "modelled_features": [],
                "unmodelled_features": [],
            }
        },
    )


def _loss_subjects(api: CanonicalApi) -> set[str]:
    return {loss.subject for loss in ProtoEmitter().emit(api).losses}


def test_editions_explicit_presence_survives_as_proto3_optional() -> None:
    """proto3 *can* express explicit presence, so this is preserved rather than lost."""
    text = _emit(_editions_api())
    assert "optional string explicit_id = 1;" in text
    # An implicit-presence field is written bare — the same semantics, the other way.
    assert "int64 implicit_count = 2;" in text
    assert "optional int64 implicit_count" not in text


def test_editions_legacy_required_is_emitted_bare_and_declared_as_a_loss() -> None:
    """proto3 removed `required`, so labelling it `optional` would state the opposite."""
    text = _emit(_editions_api())
    assert "string legacy_required_sku = 3;" in text
    assert "optional string legacy_required_sku" not in text
    assert "editions-legacy-required" in _loss_subjects(_editions_api())


def test_editions_dialect_loss_names_the_edition() -> None:
    losses = ProtoEmitter().emit(_editions_api()).losses
    dialect = next(loss for loss in losses if loss.subject == "editions-dialect")
    assert "2023" in dialect.detail
    assert "proto3" in dialect.detail


def test_editions_feature_losses_are_recorded_at_the_scope_that_set_them() -> None:
    """A file-level choice is stated once; a message's or a field's rides that construct."""
    subjects = _loss_subjects(_editions_api())
    # File level: proto3 forces PACKED and OPEN, so EXPANDED/CLOSED are gone.
    assert "editions-feature-repeated-field-encoding" in subjects
    assert "editions-feature-enum-type" in subjects
    assert "editions-feature-json-format" in subjects
    # Field level: DELIMITED was set on one field, not on the file.
    assert "editions-feature-message-encoding" in subjects

    losses = ProtoEmitter().emit(_editions_api()).losses
    delimited = next(
        loss
        for loss in losses
        if loss.subject == "editions-feature-message-encoding"
    )
    assert delimited.pointer == "acme.order.Order.grouped"


def test_editions_features_that_match_proto3_are_not_reported_as_losses() -> None:
    """Only a choice proto3 cannot carry is a loss; agreeing with proto3 is not."""
    api = _editions_api()
    api.extras["protobuf_editions"]["files"][0]["features"].update(
        {
            "enum_type": "OPEN",
            "repeated_field_encoding": "PACKED",
            "utf8_validation": "VERIFY",
            "json_format": "ALLOW",
        }
    )
    api.types[1].extras["enum_closed"] = False
    # ...including the one the *message* narrowed, which is reported at message scope.
    api.types[0].extras.pop("proto_features")
    subjects = _loss_subjects(api)
    assert "editions-feature-enum-type" not in subjects
    assert "editions-feature-repeated-field-encoding" not in subjects
    assert "editions-feature-json-format" not in subjects
    # The dialect itself is still gone, and the required field is still unrepresentable.
    assert "editions-dialect" in subjects
    assert "editions-legacy-required" in subjects


def test_a_proto3_model_records_no_editions_losses() -> None:
    """The gate: a model with no Editions provenance must emit exactly as it did before."""
    subjects = _loss_subjects(_rpc_api())
    assert not {subject for subject in subjects if subject.startswith("editions-")}


@pytest.mark.skipif(
    not _BUF_AVAILABLE,
    reason="buf tool is not resolvable in this environment "
    "(bundled only in the image / via APIOME_BUF_BIN)",
)
class TestRealBuf:
    """Compile the emitted ``.proto`` with the real ``buf`` and normalize it back (fixed point)."""

    async def test_emitted_proto_compiles(self) -> None:
        """The acceptance criterion: every emitted ``.proto`` compiles via ``buf build``."""
        compiled = await compile_emitted_descriptor_set(_rpc_api())
        names = {f.name for f in compiled.files}
        assert "acme/user.proto" in names
        # The well-known Timestamp import resolved into the descriptor set.
        assert "google/protobuf/timestamp.proto" in names

    async def test_multi_package_emitted_proto_compiles(self) -> None:
        """Cross-package imports compile as a single buf module (MFX-12.4)."""
        address = Type(
            key="acme.common.Address",
            name="Address",
            kind=TypeKind.RECORD,
            fields=[
                CanonicalField(
                    key="acme.common.Address.street",
                    name="street",
                    type=TypeRef(name="string"),
                    field_number=1,
                )
            ],
        )
        user = Type(
            key="acme.user.User",
            name="User",
            kind=TypeKind.RECORD,
            fields=[
                CanonicalField(
                    key="acme.user.User.address",
                    name="address",
                    type=TypeRef(name="acme.common.Address"),
                    field_number=1,
                )
            ],
        )
        api = CanonicalApi(
            paradigm=ApiParadigm.RPC,
            format="protobuf",
            identity=ApiIdentity(name="acme.user", namespace="acme.user"),
            types=[address, user],
        )
        compiled = await compile_emitted_descriptor_set(api)
        names = {f.name for f in compiled.files}
        assert "acme/common.proto" in names
        assert "acme/user.proto" in names

    async def test_round_trip_preserves_streaming_and_field_numbers(self) -> None:
        """Emit → compile → normalize reproduces the streaming modes and field numbers."""
        source = _rpc_api()
        compiled = await compile_emitted_descriptor_set(source)
        reimported = ProtoNormalizer().normalize(compiled)

        # Streaming preserved construct-for-construct (the MFX-12.1 acceptance criterion).
        ops = {op.key.rsplit(".", 1)[-1]: op for op in reimported.operations()}
        assert ops["GetUser"].streaming == StreamingMode.NONE
        assert ops["Chat"].streaming == StreamingMode.BIDIRECTIONAL

        # Field numbers survived the round trip.
        user = reimported.type_by_key("acme.user.User")
        assert user is not None
        numbers = {f.name: f.field_number for f in user.fields}
        assert numbers["id"] == 1
        assert numbers["role"] == 5
