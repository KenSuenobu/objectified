"""Tests for the protobuf descriptor-set → canonical model normalizer (MFI-9.2, #3765).

Two tiers, mirroring ``test_proto_descriptor.py``:

* **Synthetic-descriptor tests** (always run, no ``buf``) hand-build
  ``google.protobuf.FileDescriptorSet``\\s with :mod:`google.protobuf.descriptor_pb2` and feed
  them to :class:`~app.proto_normalizer.ProtoNormalizer`. This is the exhaustive vehicle: it
  reaches shapes the on-disk fixtures do not (client/bidi streaming, ``oneof``, proto3
  ``optional``, ``map<K,V>``, ``reserved``, proto2 ``required``/defaults, enum aliases,
  nested types) and proves the acceptance criteria — *streaming flags + field numbers
  preserved, fingerprint stable, round-trips* — without needing the compiler.

* **End-to-end test** (gated, like the MFI-9.1 e2e) compiles the committed ``.proto`` fixtures
  with the *real* bundled ``buf`` and normalizes the result, but only when ``buf`` resolves in
  this environment.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

import pytest
from google.protobuf import descriptor_pb2

from app.canonical_model import (
    ApiParadigm,
    CanonicalApi,
    MessageRole,
    OperationKind,
    StreamingMode,
    TypeKind,
)
from app.fingerprint import canonical_fingerprint
from app.normalizer import get_normalizer
from app.proto_descriptor import (
    BUF_TOOL_KEY,
    ProtoFile,
    compile_proto_descriptor_set,
    read_file_descriptor_set,
)
from app.proto_normalizer import ProtoNormalizer
from app.toolchain_packaging import probe_tool

_FIXTURES = Path(__file__).parent / "fixtures" / "proto"

_FD = descriptor_pb2.FieldDescriptorProto


# ===========================================================================
# Synthetic descriptor builders (no buf)
# ===========================================================================


def _scalar_field(
    message: descriptor_pb2.DescriptorProto,
    name: str,
    number: int,
    *,
    type_: int = _FD.TYPE_STRING,
    label: int = _FD.LABEL_OPTIONAL,
) -> descriptor_pb2.FieldDescriptorProto:
    """Add a scalar field to ``message`` and return it (for further tweaking)."""
    field = message.field.add()
    field.name = name
    field.number = number
    field.type = type_
    field.label = label
    return field


def _message_field(
    message: descriptor_pb2.DescriptorProto,
    name: str,
    number: int,
    type_name: str,
    *,
    label: int = _FD.LABEL_OPTIONAL,
    type_: int = _FD.TYPE_MESSAGE,
) -> descriptor_pb2.FieldDescriptorProto:
    """Add a message/enum-typed field (``type_name`` fully qualified) to ``message``."""
    field = message.field.add()
    field.name = name
    field.number = number
    field.type = type_
    field.label = label
    field.type_name = type_name
    return field


def _sample_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """Build a representative proto3 descriptor set exercising most mapping paths.

    Package ``acme.user``: a ``User`` message (scalar, message-ref, enum-ref, repeated, oneof,
    proto3-optional, reserved), a ``Role`` enum, request messages, and a ``UserService`` with
    a unary and a server-streaming method. A sibling ``acme.common`` file (imported) is *not*
    a target, so its ``Address`` is referenced but not mapped.
    """
    fds = descriptor_pb2.FileDescriptorSet()

    # --- imported (non-target) file -------------------------------------
    common = fds.file.add()
    common.name = "common/types.proto"
    common.package = "acme.common"
    common.syntax = "proto3"
    address = common.message_type.add()
    address.name = "Address"
    _scalar_field(address, "street", 1)

    # --- target file ----------------------------------------------------
    f = fds.file.add()
    f.name = "user/user_service.proto"
    f.package = "acme.user"
    f.syntax = "proto3"
    f.dependency.append("common/types.proto")

    user = f.message_type.add()
    user.name = "User"
    _scalar_field(user, "id", 1)
    _message_field(user, "address", 2, ".acme.common.Address")
    _message_field(user, "role", 3, ".acme.user.Role", type_=_FD.TYPE_ENUM)
    _scalar_field(user, "tags", 4, label=_FD.LABEL_REPEATED)
    # A real oneof "contact" with two members.
    contact = user.oneof_decl.add()
    contact.name = "contact"
    email = _scalar_field(user, "email", 5)
    email.oneof_index = 0
    phone = _scalar_field(user, "phone", 6)
    phone.oneof_index = 0
    # A proto3 `optional` field → a *synthetic* oneof that must NOT surface as a real oneof.
    nickname_oneof = user.oneof_decl.add()
    nickname_oneof.name = "_nickname"
    nickname = _scalar_field(user, "nickname", 7)
    nickname.oneof_index = 1
    nickname.proto3_optional = True
    # Reserved field numbers + name.
    user.reserved_range.add(start=100, end=200)
    user.reserved_name.append("legacy_field")

    role = f.enum_type.add()
    role.name = "Role"
    role.value.add(name="ROLE_UNSPECIFIED", number=0)
    role.value.add(name="ROLE_MEMBER", number=1)
    role.value.add(name="ROLE_ADMIN", number=2)

    get_req = f.message_type.add()
    get_req.name = "GetUserRequest"
    _scalar_field(get_req, "id", 1)

    list_req = f.message_type.add()
    list_req.name = "ListUsersRequest"
    _scalar_field(list_req, "page_size", 1, type_=_FD.TYPE_INT32)

    svc = f.service.add()
    svc.name = "UserService"
    get_user = svc.method.add()
    get_user.name = "GetUser"
    get_user.input_type = ".acme.user.GetUserRequest"
    get_user.output_type = ".acme.user.User"
    list_users = svc.method.add()
    list_users.name = "ListUsers"
    list_users.input_type = ".acme.user.ListUsersRequest"
    list_users.output_type = ".acme.user.User"
    list_users.server_streaming = True

    return fds


def _normalize(
    fds: descriptor_pb2.FileDescriptorSet, *, include_raw: bool = True
) -> CanonicalApi:
    """Read ``fds`` (flagging ``common`` as an import) and normalize it."""
    compiled = read_file_descriptor_set(
        fds.SerializeToString(),
        target_files=[f.name for f in fds.file if f.package != "acme.common"],
    )
    return ProtoNormalizer().normalize(compiled, include_raw=include_raw)


def _sample() -> CanonicalApi:
    return _normalize(_sample_descriptor_set())


def _type(api: CanonicalApi, key: str):
    type_ = api.type_by_key(key)
    assert type_ is not None, f"missing type {key}"
    return type_


def _operation(api: CanonicalApi, key: str):
    for op in api.operations():
        if op.key == key:
            return op
    raise AssertionError(f"missing operation {key}")


def _field(api: CanonicalApi, type_key: str, name: str):
    for field in _type(api, type_key).fields:
        if field.name == name:
            return field
    raise AssertionError(f"missing field {type_key}.{name}")


# ===========================================================================
# Registration + artifact-level shape
# ===========================================================================


def test_registered_under_protobuf_format() -> None:
    assert get_normalizer("protobuf") is ProtoNormalizer


def test_artifact_paradigm_format_protocol() -> None:
    api = _sample()
    assert api.paradigm is ApiParadigm.RPC
    assert api.format == "protobuf"
    assert api.protocol == "grpc"


def test_identity_is_first_target_package() -> None:
    api = _sample()
    assert api.identity.name == "acme.user"
    assert api.identity.namespace == "acme.user"


def test_identity_falls_back_to_filename_then_label() -> None:
    # No package declared → file name; no files → generic label.
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "bare.proto"
    f.syntax = "proto3"
    f.message_type.add().name = "Thing"
    assert ProtoNormalizer().normalize(fds).identity.name == "bare.proto"

    empty = ProtoNormalizer().normalize(descriptor_pb2.FileDescriptorSet())
    assert empty.identity.name == "Protobuf API"


def test_raw_holds_descriptor_text_when_included_and_omitted_otherwise() -> None:
    assert "UserService" in _sample().raw["descriptor_set"]
    assert _normalize(_sample_descriptor_set(), include_raw=False).raw is None


# ===========================================================================
# Source coercion
# ===========================================================================


def test_accepts_bare_file_descriptor_set_treating_all_as_targets() -> None:
    fds = _sample_descriptor_set()
    api = ProtoNormalizer().normalize(fds)
    # With no import flags, the sibling Address *is* mapped.
    assert api.type_by_key("acme.common.Address") is not None


def test_accepts_serialized_bytes() -> None:
    api = ProtoNormalizer().normalize(_sample_descriptor_set().SerializeToString())
    assert api.type_by_key("acme.user.User") is not None


def test_compiled_descriptor_set_skips_imports() -> None:
    api = _sample()
    # `common` was flagged an import → referenced but not emitted as a local type.
    assert api.type_by_key("acme.common.Address") is None
    assert _field(api, "acme.user.User", "address").type.name == "acme.common.Address"


@pytest.mark.parametrize("bad", [{"not": "a descriptor"}, "string", 42, None])
def test_unrecognized_source_raises(bad: object) -> None:
    with pytest.raises(ValueError):
        ProtoNormalizer().normalize(bad)


# ===========================================================================
# Services / methods / streaming (acceptance: streaming flags preserved)
# ===========================================================================


def test_service_keyed_by_package_qualified_name() -> None:
    api = _sample()
    assert [s.key for s in api.services] == ["acme.user.UserService"]
    assert api.services[0].name == "UserService"


def test_method_operation_key_kind_and_messages() -> None:
    op = _operation(_sample(), "acme.user.UserService.GetUser")
    assert op.name == "GetUser"
    assert op.kind is OperationKind.REQUEST_RESPONSE
    roles = {m.role: m for m in op.messages}
    assert roles[MessageRole.REQUEST].key == "acme.user.UserService.GetUser#request"
    assert roles[MessageRole.REQUEST].payload.name == "acme.user.GetUserRequest"
    assert roles[MessageRole.RESPONSE].key == "acme.user.UserService.GetUser#response"
    assert roles[MessageRole.RESPONSE].payload.name == "acme.user.User"


def test_unary_is_streaming_none() -> None:
    assert (
        _operation(_sample(), "acme.user.UserService.GetUser").streaming
        is StreamingMode.NONE
    )


def test_server_streaming_flag_preserved() -> None:
    assert (
        _operation(_sample(), "acme.user.UserService.ListUsers").streaming
        is StreamingMode.SERVER
    )


@pytest.mark.parametrize(
    "client, server, expected",
    [
        (False, False, StreamingMode.NONE),
        (True, False, StreamingMode.CLIENT),
        (False, True, StreamingMode.SERVER),
        (True, True, StreamingMode.BIDIRECTIONAL),
    ],
)
def test_all_streaming_modes(
    client: bool, server: bool, expected: StreamingMode
) -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "s.proto"
    f.package = "p"
    f.syntax = "proto3"
    f.message_type.add().name = "M"
    svc = f.service.add()
    svc.name = "S"
    method = svc.method.add()
    method.name = "Do"
    method.input_type = ".p.M"
    method.output_type = ".p.M"
    method.client_streaming = client
    method.server_streaming = server
    assert _operation(ProtoNormalizer().normalize(fds), "p.S.Do").streaming is expected


def test_method_idempotency_level_in_extras() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "s.proto"
    f.package = "p"
    f.syntax = "proto3"
    f.message_type.add().name = "M"
    svc = f.service.add()
    svc.name = "S"
    method = svc.method.add()
    method.name = "Read"
    method.input_type = ".p.M"
    method.output_type = ".p.M"
    method.options.idempotency_level = descriptor_pb2.MethodOptions.NO_SIDE_EFFECTS
    op = _operation(ProtoNormalizer().normalize(fds), "p.S.Read")
    assert op.extras["idempotency_level"] == "no_side_effects"


# ===========================================================================
# Messages → types / fields (acceptance: field numbers preserved)
# ===========================================================================


def test_message_is_record_keyed_package_qualified() -> None:
    user = _type(_sample(), "acme.user.User")
    assert user.kind is TypeKind.RECORD
    assert user.name == "User"


def test_field_keys_and_numbers_preserved() -> None:
    api = _sample()
    id_field = _field(api, "acme.user.User", "id")
    assert id_field.key == "acme.user.User.id"
    assert id_field.field_number == 1
    assert _field(api, "acme.user.User", "phone").field_number == 6


def test_scalar_field_type_names() -> None:
    api = _sample()
    assert _field(api, "acme.user.User", "id").type.name == "string"
    assert _field(api, "acme.user.ListUsersRequest", "page_size").type.name == "int32"


def test_message_and_enum_refs_strip_leading_dot() -> None:
    api = _sample()
    assert _field(api, "acme.user.User", "address").type.name == "acme.common.Address"
    assert _field(api, "acme.user.User", "role").type.name == "acme.user.Role"


def test_repeated_field_is_list_typeref() -> None:
    tags = _field(_sample(), "acme.user.User", "tags").type
    assert tags.is_list()
    assert tags.nullable is False
    assert tags.item.name == "string"


# ===========================================================================
# oneof / proto3 optional / reserved (acceptance: + oneof, reserved)
# ===========================================================================


def test_real_oneof_recorded_on_type_and_members() -> None:
    api = _sample()
    user = _type(api, "acme.user.User")
    assert user.extras["oneofs"] == ["contact"]
    assert _field(api, "acme.user.User", "email").extras["oneof"] == "contact"
    assert _field(api, "acme.user.User", "phone").extras["oneof"] == "contact"


def test_synthetic_proto3_optional_oneof_not_surfaced_as_oneof() -> None:
    api = _sample()
    user = _type(api, "acme.user.User")
    # The synthetic "_nickname" wrapper is excluded from the real-oneof list...
    assert "_nickname" not in user.extras["oneofs"]
    nickname = _field(api, "acme.user.User", "nickname")
    # ...and the field is flagged proto3_optional, not given a oneof name.
    assert nickname.extras["proto3_optional"] is True
    assert "oneof" not in nickname.extras


def test_reserved_ranges_and_names_preserved() -> None:
    user = _type(_sample(), "acme.user.User")
    assert user.extras["reserved_ranges"] == [[100, 200]]
    assert user.extras["reserved_names"] == ["legacy_field"]


# ===========================================================================
# Enums
# ===========================================================================


def test_enum_is_enum_with_value_numbers_in_order() -> None:
    role = _type(_sample(), "acme.user.Role")
    assert role.kind is TypeKind.ENUM
    assert [(v.name, v.value) for v in role.enum_values] == [
        ("ROLE_UNSPECIFIED", 0),
        ("ROLE_MEMBER", 1),
        ("ROLE_ADMIN", 2),
    ]
    assert role.enum_values[0].key == "acme.user.Role.ROLE_UNSPECIFIED"


def test_enum_allow_alias_in_extras() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "e.proto"
    f.package = "p"
    f.syntax = "proto3"
    enum = f.enum_type.add()
    enum.name = "E"
    enum.options.allow_alias = True
    enum.value.add(name="A", number=0)
    enum.value.add(name="B", number=1)
    enum.value.add(name="B_ALIAS", number=1)
    assert _type(ProtoNormalizer().normalize(fds), "p.E").extras["allow_alias"] is True


# ===========================================================================
# Nested types
# ===========================================================================


def test_nested_message_and_enum_carry_parent_prefix() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "n.proto"
    f.package = "p"
    f.syntax = "proto3"
    outer = f.message_type.add()
    outer.name = "Outer"
    _scalar_field(outer, "id", 1)
    inner = outer.nested_type.add()
    inner.name = "Inner"
    _scalar_field(inner, "label", 1)
    nested_enum = outer.enum_type.add()
    nested_enum.name = "Kind"
    nested_enum.value.add(name="K0", number=0)

    api = ProtoNormalizer().normalize(fds)
    assert _type(api, "p.Outer.Inner").kind is TypeKind.RECORD
    assert _type(api, "p.Outer.Kind").kind is TypeKind.ENUM
    assert _field(api, "p.Outer.Inner", "label").key == "p.Outer.Inner.label"


# ===========================================================================
# Maps
# ===========================================================================


def _map_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """A message with a ``map<string, int64> attrs = 1;`` field (its synthetic entry)."""
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "m.proto"
    f.package = "p"
    f.syntax = "proto3"
    holder = f.message_type.add()
    holder.name = "Holder"
    # The synthetic nested entry the compiler generates for `map<string,int64>`.
    entry = holder.nested_type.add()
    entry.name = "AttrsEntry"
    entry.options.map_entry = True
    _scalar_field(entry, "key", 1)
    _scalar_field(entry, "value", 2, type_=_FD.TYPE_INT64)
    # The map field is a repeated reference to that entry.
    _message_field(holder, "attrs", 1, ".p.Holder.AttrsEntry", label=_FD.LABEL_REPEATED)
    return fds


def test_map_entry_becomes_map_type() -> None:
    map_type = _type(ProtoNormalizer().normalize(_map_descriptor_set()), "p.Holder.AttrsEntry")
    assert map_type.kind is TypeKind.MAP
    assert map_type.key_type.name == "string"
    assert map_type.value_type.name == "int64"


def test_map_field_references_map_type_not_a_list() -> None:
    field = _field(
        ProtoNormalizer().normalize(_map_descriptor_set()), "p.Holder", "attrs"
    )
    assert field.type.is_list() is False
    assert field.type.name == "p.Holder.AttrsEntry"
    assert field.field_number == 1


# ===========================================================================
# proto2 nuances (required + default)
# ===========================================================================


def test_proto2_required_is_non_nullable_and_default_preserved() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "p2.proto"
    f.package = "p"
    # proto2 is the default syntax (no `syntax` set).
    msg = f.message_type.add()
    msg.name = "M"
    _scalar_field(msg, "name", 1, label=_FD.LABEL_REQUIRED)
    opt = _scalar_field(msg, "tier", 2, label=_FD.LABEL_OPTIONAL)
    opt.default_value = "bronze"

    api = ProtoNormalizer().normalize(fds)
    name = _field(api, "p.M", "name")
    assert name.type.nullable is False
    assert name.extras["label"] == "required"
    tier = _field(api, "p.M", "tier")
    assert tier.default == "bronze"
    assert tier.type.nullable is True


# ===========================================================================
# Determinism, round-trip, fingerprint (acceptance: fingerprint stable, round-trips)
# ===========================================================================


def test_output_is_order_normalized_and_idempotent() -> None:
    api = _sample()
    # Services/types/fields sorted by key.
    assert [t.key for t in api.types] == sorted(t.key for t in api.types)
    assert [f.key for f in _type(api, "acme.user.User").fields] == sorted(
        f.key for f in _type(api, "acme.user.User").fields
    )
    # Re-normalizing the same source yields an equal model.
    assert _sample() == api


def test_json_round_trip_is_lossless() -> None:
    api = _sample()
    reloaded = CanonicalApi.model_validate(json.loads(json.dumps(api.model_dump())))
    assert reloaded == api


def test_fingerprint_stable_across_renormalization() -> None:
    assert canonical_fingerprint(_sample()) == canonical_fingerprint(_sample())


def test_fingerprint_invariant_to_declaration_order() -> None:
    fds = _sample_descriptor_set()
    shuffled = descriptor_pb2.FileDescriptorSet()
    shuffled.CopyFrom(fds)
    # Reverse service methods, message fields, and top-level messages.
    target = shuffled.file[1]
    methods = list(target.service[0].method)
    del target.service[0].method[:]
    target.service[0].method.extend(reversed(methods))
    user = target.message_type[0]
    fields = list(user.field)
    del user.field[:]
    user.field.extend(reversed(fields))

    fp_a = canonical_fingerprint(_normalize(fds))
    fp_b = canonical_fingerprint(_normalize(shuffled))
    assert fp_a == fp_b


def test_fingerprint_flips_on_streaming_change() -> None:
    base = _normalize(_sample_descriptor_set())
    changed_fds = _sample_descriptor_set()
    # Make ListUsers bidi instead of server-streaming.
    changed_fds.file[1].service[0].method[1].client_streaming = True
    assert canonical_fingerprint(base) != canonical_fingerprint(_normalize(changed_fds))


def test_fingerprint_flips_on_field_number_change() -> None:
    base = _normalize(_sample_descriptor_set())
    changed_fds = _sample_descriptor_set()
    changed_fds.file[1].message_type[0].field[0].number = 99  # User.id 1 → 99
    assert canonical_fingerprint(base) != canonical_fingerprint(_normalize(changed_fds))


def test_fingerprint_flips_on_reserved_change() -> None:
    base = _normalize(_sample_descriptor_set())
    changed_fds = _sample_descriptor_set()
    changed_fds.file[1].message_type[0].reserved_name.append("another")
    assert canonical_fingerprint(base) != canonical_fingerprint(_normalize(changed_fds))


def test_fingerprint_stable_against_description_only_change() -> None:
    # Comments live in source-locations, stripped before the descriptor set; a doc-only
    # edit therefore leaves the descriptor — and the fingerprint — identical. We assert the
    # weaker invariant the model can express: the raw bag does not enter the fingerprint.
    base = _sample()
    no_raw = _normalize(_sample_descriptor_set(), include_raw=False)
    assert canonical_fingerprint(base) == canonical_fingerprint(no_raw)


# ===========================================================================
# Protobuf Editions — FMT-3.7 (#5432)
# ===========================================================================
#
# The synthetic tier again: an Editions ``FileDescriptorProto`` needs no compiler, and these
# assert the three acceptance criteria that live in the normalizer — presence drives
# nullability, the resolved feature set is recorded in provenance, and proto2/proto3 models
# are untouched.


def _editions_descriptor_set(
    *, edition: int = descriptor_pb2.Edition.EDITION_2023
) -> descriptor_pb2.FileDescriptorSet:
    """Build an Editions file whose fields differ only in resolved ``field_presence``.

    ``Order.explicit_id`` and ``Order.implicit_count`` are the pair the acceptance criterion
    compares: same descriptor label (the compiler writes ``LABEL_OPTIONAL`` for both), different
    presence, and therefore different canonical nullability.
    """
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "orders/orders.proto"
    f.package = "acme.orders"
    f.syntax = "editions"
    f.edition = edition
    f.options.features.field_presence = descriptor_pb2.FeatureSet.EXPLICIT

    order = f.message_type.add()
    order.name = "Order"
    _scalar_field(order, "explicit_id", 1)
    implicit = _scalar_field(order, "implicit_count", 2, type_=_FD.TYPE_INT64)
    implicit.options.features.field_presence = descriptor_pb2.FeatureSet.IMPLICIT
    required = _scalar_field(order, "legacy_required_sku", 3)
    required.options.features.field_presence = descriptor_pb2.FeatureSet.LEGACY_REQUIRED
    delimited = _message_field(order, "grouped", 4, ".acme.orders.Order")
    delimited.options.features.message_encoding = descriptor_pb2.FeatureSet.DELIMITED

    status = f.enum_type.add()
    status.name = "Status"
    status.value.add(name="STATUS_UNSPECIFIED", number=0)
    status.options.features.enum_type = descriptor_pb2.FeatureSet.CLOSED

    open_status = f.enum_type.add()
    open_status.name = "OpenStatus"
    open_status.value.add(name="OPEN_STATUS_UNSPECIFIED", number=0)
    return fds


def test_editions_presence_drives_nullability() -> None:
    """FMT-3.7 acceptance: explicit and implicit presence normalize to different nullability."""
    api = ProtoNormalizer().normalize(_editions_descriptor_set(), include_raw=False)
    order = api.type_by_key("acme.orders.Order")
    assert order is not None
    by_name = {field.name: field for field in order.fields}

    # The descriptor cannot tell these apart — both are LABEL_OPTIONAL strings/ints.
    assert by_name["explicit_id"].extras["label"] == "optional"
    assert by_name["implicit_count"].extras["label"] == "optional"
    # ...but their resolved presence does, and that is what nullability follows.
    assert by_name["explicit_id"].type.nullable is True
    assert by_name["implicit_count"].type.nullable is False


def test_editions_legacy_required_is_not_nullable() -> None:
    """LEGACY_REQUIRED tracks presence yet may never be absent — the one case they differ."""
    api = ProtoNormalizer().normalize(_editions_descriptor_set(), include_raw=False)
    order = api.type_by_key("acme.orders.Order")
    assert order is not None
    field = {f.name: f for f in order.fields}["legacy_required_sku"]
    assert field.extras["field_presence"] == "LEGACY_REQUIRED"
    assert field.type.nullable is False


def test_editions_records_resolved_features_on_the_scope_that_set_them() -> None:
    """Only a scope's own narrowing is recorded; what it inherits is stated once in provenance."""
    api = ProtoNormalizer().normalize(_editions_descriptor_set(), include_raw=False)
    order = api.type_by_key("acme.orders.Order")
    assert order is not None
    by_name = {field.name: field for field in order.fields}

    # A field that agrees with its file records no feature bag at all.
    assert "proto_features" not in by_name["explicit_id"].extras
    # A field that narrows one records exactly that one.
    assert by_name["grouped"].extras["proto_features"] == {"message_encoding": "DELIMITED"}

    assert api.type_by_key("acme.orders.Status").extras["enum_closed"] is True
    assert api.type_by_key("acme.orders.OpenStatus").extras["enum_closed"] is False


def test_editions_provenance_records_edition_syntax_and_feature_set() -> None:
    """FMT-3.7 acceptance: edition, syntax and the resolved feature set reach provenance."""
    api = ProtoNormalizer().normalize(_editions_descriptor_set(), include_raw=False)
    record = api.extras["protobuf_editions"]

    assert record["editions"] == ["2023"]
    assert record["syntaxes"] == ["editions"]
    assert record["unmodelled_features"] == []  # 2024 introduced them; a 2023 file has none
    (entry,) = record["files"]
    assert entry["file"] == "orders/orders.proto"
    assert entry["syntax"] == "editions"
    assert entry["edition"] == "2023"
    assert entry["features"] == {
        "field_presence": "EXPLICIT",
        "enum_type": "OPEN",
        "repeated_field_encoding": "PACKED",
        "utf8_validation": "VERIFY",
        "message_encoding": "LENGTH_PREFIXED",
        "json_format": "ALLOW",
    }


def test_edition_2024_reports_the_features_it_does_not_model() -> None:
    """The two Edition 2024 additions are reported as unmodelled rather than silently dropped."""
    fds = _editions_descriptor_set(edition=descriptor_pb2.Edition.EDITION_2024)
    api = ProtoNormalizer().normalize(fds, include_raw=False)
    record = api.extras["protobuf_editions"]
    assert record["editions"] == ["2024"]
    assert record["unmodelled_features"] == [
        "default_symbol_visibility",
        "enforce_naming_style",
    ]
    # ...and they are reported in the file's resolved feature set too, at their 2024 defaults.
    features = record["files"][0]["features"]
    assert features["enforce_naming_style"] == "STYLE2024"
    assert features["default_symbol_visibility"] == "EXPORT_TOP_LEVEL"


def test_editions_presence_change_flips_the_fingerprint() -> None:
    """A presence change is a contract change, so it must not hash the same."""
    baseline = ProtoNormalizer().normalize(_editions_descriptor_set(), include_raw=False)

    flipped = _editions_descriptor_set()
    order = flipped.file[0].message_type[0]
    order.field[0].options.features.field_presence = descriptor_pb2.FeatureSet.IMPLICIT
    changed = ProtoNormalizer().normalize(flipped, include_raw=False)

    assert canonical_fingerprint(baseline) != canonical_fingerprint(changed)


def test_proto3_models_carry_no_editions_extras() -> None:
    """FMT-3.7 acceptance: proto2/proto3 normalization is untouched.

    The shipped goldens are the end-to-end form of this; this is the direct statement, so a
    future change that starts recording features for every syntax fails here first.
    """
    api = ProtoNormalizer().normalize(_sample_descriptor_set(), include_raw=False)
    assert "protobuf_editions" not in api.extras
    for type_ in api.types:
        assert "enum_closed" not in type_.extras
        assert "proto_features" not in type_.extras
        for field in type_.fields:
            assert "field_presence" not in field.extras
            assert "proto_features" not in field.extras


def test_repeated_fields_model_identically_in_editions_and_proto3() -> None:
    """A list element is never absent, so presence must not touch a repeated field.

    ``field_has_presence`` is correctly ``False`` for every repeated field, but that answers
    "does this field track presence", not "can an element be null". Letting it drive the
    override marked Editions list items non-nullable while the byte-identical proto3 document
    marked them nullable — so every repeated field read as *changed* when a service migrated
    syntax, which is exactly the false positive the canonical model exists to avoid.
    """

    def _build(syntax: str) -> descriptor_pb2.FileDescriptorSet:
        fds = descriptor_pb2.FileDescriptorSet()
        f = fds.file.add()
        f.name = "x/x.proto"
        f.package = "p"
        if syntax == "editions":
            f.syntax = "editions"
            f.edition = descriptor_pb2.Edition.EDITION_2023
        else:
            f.syntax = syntax
        m = f.message_type.add()
        m.name = "M"
        _scalar_field(m, "tags", 1, label=_FD.LABEL_REPEATED)
        return fds

    proto3 = ProtoNormalizer().normalize(_build("proto3"), include_raw=False)
    editions = ProtoNormalizer().normalize(_build("editions"), include_raw=False)
    proto3_tags = proto3.type_by_key("p.M").fields[0]
    editions_tags = editions.type_by_key("p.M").fields[0]

    assert editions_tags.type.item.nullable == proto3_tags.type.item.nullable
    assert editions_tags.type.nullable == proto3_tags.type.nullable
    # ...and the feature is not recorded on it either — a repeated field says nothing about
    # presence, so it inherits no claim about it.
    assert "field_presence" not in editions_tags.extras


def test_feature_sets_do_not_leak_from_an_importing_file() -> None:
    """Two target files with opposite presence defaults keep their own answers.

    The corpus fileset (protobuf-editions/03-imports-set) makes the same point through the
    adapter; this is the normalizer-level statement.
    """
    fds = descriptor_pb2.FileDescriptorSet()

    common = fds.file.add()
    common.name = "common/common.proto"
    common.package = "acme.common"
    common.syntax = "editions"
    common.edition = descriptor_pb2.Edition.EDITION_2023
    common.options.features.field_presence = descriptor_pb2.FeatureSet.IMPLICIT
    address = common.message_type.add()
    address.name = "Address"
    _scalar_field(address, "city", 1)

    shipping = fds.file.add()
    shipping.name = "shipping/shipping.proto"
    shipping.package = "acme.shipping"
    shipping.syntax = "editions"
    shipping.edition = descriptor_pb2.Edition.EDITION_2023
    shipping.dependency.append("common/common.proto")
    shipping.options.features.field_presence = descriptor_pb2.FeatureSet.EXPLICIT
    shipment = shipping.message_type.add()
    shipment.name = "Shipment"
    _scalar_field(shipment, "shipment_id", 1)

    api = ProtoNormalizer().normalize(fds, include_raw=False)
    assert api.type_by_key("acme.common.Address").fields[0].type.nullable is False
    assert api.type_by_key("acme.shipping.Shipment").fields[0].type.nullable is True
    # Provenance names both files, each with its own resolution.
    files = {entry["file"]: entry for entry in api.extras["protobuf_editions"]["files"]}
    assert files["common/common.proto"]["features"]["field_presence"] == "IMPLICIT"
    assert files["shipping/shipping.proto"]["features"]["field_presence"] == "EXPLICIT"


def test_editions_provenance_files_are_sorted_by_path() -> None:
    """The record must not depend on the order files arrived in.

    A fileset's member order comes from the uploaded archive, so leaving the record in
    descriptor order would make two uploads of the same set fingerprint differently — the one
    thing :func:`app.normalizer.normalize_ordering` exists to prevent.
    """
    forward = descriptor_pb2.FileDescriptorSet()
    reversed_ = descriptor_pb2.FileDescriptorSet()
    # One package across both files, so the comparison isolates member *order*: the artifact
    # identity is derived from the first file that declares a package, which is its own
    # order-dependence and not what this test is about.
    for order, fds in ((("a", "z"), forward), (("z", "a"), reversed_)):
        for name in order:
            f = fds.file.add()
            f.name = f"{name}/{name}.proto"
            f.package = "acme.shared"
            f.syntax = "editions"
            f.edition = descriptor_pb2.Edition.EDITION_2023
            message = f.message_type.add()
            message.name = name.upper()
            _scalar_field(message, "id", 1)

    forward_api = ProtoNormalizer().normalize(forward, include_raw=False)
    reversed_api = ProtoNormalizer().normalize(reversed_, include_raw=False)
    files = [entry["file"] for entry in forward_api.extras["protobuf_editions"]["files"]]
    assert files == ["a/a.proto", "z/z.proto"]
    assert forward_api.extras == reversed_api.extras
    assert canonical_fingerprint(forward_api) == canonical_fingerprint(reversed_api)


def test_a_mixed_set_records_each_file_and_still_leaves_proto3_fields_alone() -> None:
    """One Editions file in a set does not turn its proto3 sibling into an Editions model."""
    fds = _editions_descriptor_set()
    legacy = fds.file.add()
    legacy.name = "legacy/legacy.proto"
    legacy.package = "acme.legacy"
    legacy.syntax = "proto3"
    old = legacy.message_type.add()
    old.name = "Old"
    _scalar_field(old, "id", 1)

    api = ProtoNormalizer().normalize(fds, include_raw=False)
    record = api.extras["protobuf_editions"]
    assert record["syntaxes"] == ["editions", "proto3"]
    assert {entry["file"]: entry["edition"] for entry in record["files"]} == {
        "orders/orders.proto": "2023",
        "legacy/legacy.proto": None,
    }
    # The proto3 file's field keeps the label-derived nullability and gains no feature extras.
    old_field = api.type_by_key("acme.legacy.Old").fields[0]
    assert old_field.type.nullable is True
    assert "field_presence" not in old_field.extras


# ===========================================================================
# End-to-end: real bundled buf over the committed fixtures (gated)
# ===========================================================================

_BUF_AVAILABLE = bool(getattr(probe_tool(BUF_TOOL_KEY), "available", False))


def _load_fixture_files(*relpaths: str) -> List[ProtoFile]:
    return [
        ProtoFile(path=rel, content=(_FIXTURES / rel).read_text(encoding="utf-8"))
        for rel in relpaths
    ]


@pytest.mark.skipif(
    not _BUF_AVAILABLE,
    reason="buf tool is not resolvable in this environment "
    "(bundled only in the image / via APIOME_BUF_BIN)",
)
class TestRealBuf:
    """Compile the committed fixtures with real ``buf`` and normalize the result."""

    async def test_proto3_service_normalizes_with_streaming(self) -> None:
        compiled = await compile_proto_descriptor_set(
            _load_fixture_files("common/types.proto", "user/user_service.proto")
        )
        api = ProtoNormalizer().normalize(compiled)

        assert api.paradigm is ApiParadigm.RPC
        assert "acme.user.UserService" in {s.key for s in api.services}
        ops = {o.key: o for o in api.operations()}
        assert ops["acme.user.UserService.GetUser"].streaming is StreamingMode.NONE
        assert ops["acme.user.UserService.ListUsers"].streaming is StreamingMode.SERVER
        # The User message is mapped with package-qualified field keys + numbers.
        user = api.type_by_key("acme.user.User")
        assert user is not None
        by_name = {f.name: f for f in user.fields}
        assert by_name["id"].field_number == 1
        assert by_name["role"].type.name == "acme.user.Role"
        # The imported well-known Timestamp is referenced but not mapped locally.
        assert by_name["created_at"].type.name == "google.protobuf.Timestamp"
        assert api.type_by_key("google.protobuf.Timestamp") is None
        # Lossless JSONB round-trip.
        assert CanonicalApi.model_validate(api.model_dump()) == api

    async def test_editions_2023_service_normalizes(self) -> None:
        compiled = await compile_proto_descriptor_set(
            _load_fixture_files("common/types.proto", "editions/catalog.proto")
        )
        api = ProtoNormalizer().normalize(compiled)
        assert "acme.catalog.CatalogService" in {s.key for s in api.services}
        op = {o.key: o for o in api.operations()}["acme.catalog.CatalogService.GetProduct"]
        assert op.streaming is StreamingMode.NONE
        assert op.messages and {m.role for m in op.messages} == {
            MessageRole.REQUEST,
            MessageRole.RESPONSE,
        }

    async def test_editions_resolution_survives_the_real_compiler(self) -> None:
        """FMT-3.7: `buf build` leaves features raw, so the resolution must be ours.

        The synthetic tests build the descriptor by hand; this one proves the *compiler*
        produces the shape those tests assume — an editions file whose fields carry no
        presence in their labels and whose ``features`` options are unmerged.
        """
        compiled = await compile_proto_descriptor_set(
            _load_fixture_files("common/types.proto", "editions/catalog.proto")
        )
        target = next(
            f for f in compiled.proto.file if f.name == "editions/catalog.proto"
        )
        assert target.syntax == "editions"
        # Every singular field is LABEL_OPTIONAL regardless of presence — the reason a
        # label-only reading mis-modelled these documents.
        product = next(m for m in target.message_type if m.name == "Product")
        assert {f.label for f in product.field} == {_FD.LABEL_OPTIONAL}

        api = ProtoNormalizer().normalize(compiled, include_raw=False)
        record = api.extras["protobuf_editions"]
        assert record["editions"] == ["2023"]
        catalog = next(
            entry for entry in record["files"] if entry["file"] == "editions/catalog.proto"
        )
        # Edition 2023 defaults to EXPLICIT presence, so every scalar here is nullable.
        assert catalog["features"]["field_presence"] == "EXPLICIT"
        product_type = api.type_by_key("acme.catalog.Product")
        assert product_type is not None
        assert all(field.type.nullable for field in product_type.fields)
        assert {f.extras["field_presence"] for f in product_type.fields} == {"EXPLICIT"}
