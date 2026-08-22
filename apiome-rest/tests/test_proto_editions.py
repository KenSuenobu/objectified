"""Tests for Protobuf **Editions** feature resolution — FMT-3.7 (#5432).

Three tiers, all of which run without ``buf``:

* **Table tests** assert the edition-defaults derivation against the values ``descriptor.proto``
  itself publishes, and the availability gate that separates "resolves to a value" from "this
  document could have set it".
* **Resolution tests** drive the scope chain (file → message → field, file → enum, message →
  oneof → field), legacy proto2/proto3 inference, and the four descriptor shapes that outrank
  the ``field_presence`` feature.
* **A grounding test** builds descriptors and hands them to the protobuf runtime's own
  :class:`~google.protobuf.descriptor_pool.DescriptorPool`, then asserts our answers match its
  ``has_presence`` / ``is_closed``. That is the check that matters: the resolver is a restatement
  of the compiler's rules, so the compiler is the oracle. The runtime resolves a hand-built
  Editions ``FileDescriptorProto``, so this needs no compiler toolchain.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import pytest
from google.protobuf import descriptor_pb2, descriptor_pool

from app.proto_editions import (
    ENUM_TYPE_CLOSED,
    ENUM_TYPE_OPEN,
    FIELD_PRESENCE_EXPLICIT,
    FIELD_PRESENCE_IMPLICIT,
    FIELD_PRESENCE_LEGACY_REQUIRED,
    MESSAGE_ENCODING_DELIMITED,
    MODELLED_FEATURES,
    UNMODELLED_FEATURES,
    FileFeatureContext,
    available_feature_names,
    edition_defaults,
    edition_value_for_file,
    enum_is_closed,
    feature_overrides,
    field_has_presence,
    infer_legacy_field_features,
    merge_features,
)

_FD = descriptor_pb2.FieldDescriptorProto
_FS = descriptor_pb2.FeatureSet
_ED = descriptor_pb2.Edition


# ===========================================================================
# Builders
# ===========================================================================


def _file(
    *,
    syntax: str = "editions",
    edition: int = _ED.EDITION_2023,
    package: str = "acme.v1",
    name: str = "acme/v1/api.proto",
) -> descriptor_pb2.FileDescriptorProto:
    """Build an empty file descriptor of the requested syntax/edition."""
    file_proto = descriptor_pb2.FileDescriptorProto()
    file_proto.name = name
    file_proto.package = package
    if syntax != "proto2":
        file_proto.syntax = syntax
    if syntax == "editions":
        file_proto.edition = edition
    return file_proto


def _field(
    message: descriptor_pb2.DescriptorProto,
    name: str,
    number: int,
    *,
    type_: int = _FD.TYPE_STRING,
    label: int = _FD.LABEL_OPTIONAL,
    type_name: str = "",
) -> descriptor_pb2.FieldDescriptorProto:
    """Add a field to ``message`` and return it for further tweaking."""
    field = message.field.add()
    field.name = name
    field.number = number
    field.type = type_
    field.label = label
    if type_name:
        field.type_name = type_name
    return field


# ===========================================================================
# Edition defaults, derived from descriptor.proto
# ===========================================================================


def test_edition_defaults_match_the_published_table() -> None:
    """The derivation reproduces descriptor.proto's own ``edition_defaults`` exactly."""
    assert edition_defaults(_ED.EDITION_PROTO2) == {
        "field_presence": "EXPLICIT",
        "enum_type": "CLOSED",
        "repeated_field_encoding": "EXPANDED",
        "utf8_validation": "NONE",
        "message_encoding": "LENGTH_PREFIXED",
        "json_format": "LEGACY_BEST_EFFORT",
        "enforce_naming_style": "STYLE_LEGACY",
        "default_symbol_visibility": "EXPORT_ALL",
    }
    proto3 = edition_defaults(_ED.EDITION_PROTO3)
    assert proto3["field_presence"] == "IMPLICIT"
    assert proto3["enum_type"] == "OPEN"
    assert proto3["repeated_field_encoding"] == "PACKED"
    assert proto3["utf8_validation"] == "VERIFY"
    assert proto3["json_format"] == "ALLOW"


def test_edition_defaults_returns_a_fresh_dict_the_caller_may_merge_onto() -> None:
    """The table is memoized, so a caller mutating its answer must not poison the cache."""
    first = edition_defaults(_ED.EDITION_2023)
    first["field_presence"] = "TAMPERED"
    assert edition_defaults(_ED.EDITION_2023)["field_presence"] == FIELD_PRESENCE_EXPLICIT


def test_edition_2023_flips_presence_back_to_explicit() -> None:
    """The headline Editions change: 2023 restores EXPLICIT presence over proto3's IMPLICIT."""
    assert edition_defaults(_ED.EDITION_PROTO3)["field_presence"] == FIELD_PRESENCE_IMPLICIT
    assert edition_defaults(_ED.EDITION_2023)["field_presence"] == FIELD_PRESENCE_EXPLICIT


def test_edition_2024_keeps_2023_wire_defaults_and_adds_its_own() -> None:
    """2024 changes only the two compiler-facing features; the six wire features are 2023's."""
    y2023 = edition_defaults(_ED.EDITION_2023)
    y2024 = edition_defaults(_ED.EDITION_2024)
    for name in MODELLED_FEATURES:
        assert y2024[name] == y2023[name], name
    assert y2024["enforce_naming_style"] == "STYLE2024"
    assert y2024["default_symbol_visibility"] == "EXPORT_TOP_LEVEL"


def test_an_edition_newer_than_the_runtime_knows_inherits_the_newest_defaults() -> None:
    """A future edition degrades to the newest declared default rather than failing.

    The resolution rule is "largest declared edition <= this one", so a hypothetical 2025
    resolves to 2024's table until the runtime ships a 2025 entry.
    """
    future = int(_ED.EDITION_2024) + 1
    assert edition_defaults(future) == edition_defaults(_ED.EDITION_2024)


def test_available_features_gate_on_the_edition_that_introduced_them() -> None:
    """A 2023 document cannot set the two features Edition 2024 introduced."""
    available_2023 = available_feature_names(_ED.EDITION_2023)
    assert set(available_2023) == set(MODELLED_FEATURES)
    for name in UNMODELLED_FEATURES:
        assert name not in available_2023
        # ...even though it *resolves* to a value, which is what protoc computes.
        assert name in edition_defaults(_ED.EDITION_2023)

    available_2024 = available_feature_names(_ED.EDITION_2024)
    assert set(available_2024) == set(MODELLED_FEATURES) | set(UNMODELLED_FEATURES)


def test_legacy_syntaxes_expose_no_settable_features() -> None:
    """proto2/proto3 have no `features` syntax at all, so nothing is available to set."""
    assert available_feature_names(_ED.EDITION_PROTO2) == ()
    assert available_feature_names(_ED.EDITION_PROTO3) == ()


# ===========================================================================
# Edition resolution off a file descriptor
# ===========================================================================


@pytest.mark.parametrize(
    ("syntax", "expected"),
    [
        ("proto2", _ED.EDITION_PROTO2),
        ("proto3", _ED.EDITION_PROTO3),
        ("editions", _ED.EDITION_2023),
    ],
)
def test_edition_value_for_file_covers_every_syntax(syntax: str, expected: int) -> None:
    assert edition_value_for_file(_file(syntax=syntax)) == expected


def test_editions_file_without_an_edition_falls_back_to_2023_not_proto2() -> None:
    """A malformed descriptor must not silently invert every presence answer.

    ``syntax = "editions"`` with no ``edition`` is not something a compiler emits, but reading
    it as proto2 would resolve enums CLOSED and repeated fields EXPANDED — the opposite of every
    real edition. The fallback is the first edition instead.
    """
    file_proto = _file(syntax="editions")
    file_proto.ClearField("edition")
    assert edition_value_for_file(file_proto) == _ED.EDITION_2023


def test_context_reports_syntax_and_edition_label() -> None:
    editions = FileFeatureContext(_file(syntax="editions", edition=_ED.EDITION_2024))
    assert editions.is_editions is True
    assert editions.syntax == "editions"
    assert editions.edition == "2024"

    proto3 = FileFeatureContext(_file(syntax="proto3"))
    assert proto3.is_editions is False
    assert proto3.syntax == "proto3"
    assert proto3.edition is None

    proto2 = FileFeatureContext(_file(syntax="proto2"))
    assert proto2.syntax == "proto2"
    assert proto2.edition is None


# ===========================================================================
# Scope merge
# ===========================================================================


def test_feature_overrides_reads_presence_not_value() -> None:
    """An unset feature is indistinguishable from its default by value; ``HasField`` is the test."""
    message = descriptor_pb2.DescriptorProto()
    assert feature_overrides(message.options) == {}
    # EXPLICIT happens to be the 2023 default, so a value check would miss that it was *set*.
    field = _field(message, "a", 1)
    field.options.features.field_presence = _FS.EXPLICIT
    assert feature_overrides(field.options) == {"field_presence": FIELD_PRESENCE_EXPLICIT}


def test_feature_overrides_tolerates_options_without_features() -> None:
    assert feature_overrides(None) == {}
    assert feature_overrides(object()) == {}


def test_merge_applies_overrides_left_to_right_without_mutating() -> None:
    parent = {"field_presence": FIELD_PRESENCE_EXPLICIT, "enum_type": ENUM_TYPE_OPEN}
    merged = merge_features(
        parent, {"field_presence": FIELD_PRESENCE_IMPLICIT}, {"enum_type": ENUM_TYPE_CLOSED}
    )
    assert merged == {
        "field_presence": FIELD_PRESENCE_IMPLICIT,
        "enum_type": ENUM_TYPE_CLOSED,
    }
    assert parent["field_presence"] == FIELD_PRESENCE_EXPLICIT


def test_file_then_field_override_resolves_in_that_order() -> None:
    """The chain the fixtures exercise: a file default, narrowed by one field."""
    file_proto = _file()
    file_proto.options.features.field_presence = _FS.IMPLICIT
    message = file_proto.message_type.add()
    message.name = "M"
    inherits = _field(message, "inherits", 1)
    overrides = _field(message, "overrides", 2)
    overrides.options.features.field_presence = _FS.EXPLICIT

    context = FileFeatureContext(file_proto)
    message_features = context.scope(context.file_features, message.options)
    assert context.field_scope(message_features, inherits)["field_presence"] == (
        FIELD_PRESENCE_IMPLICIT
    )
    assert context.field_scope(message_features, overrides)["field_presence"] == (
        FIELD_PRESENCE_EXPLICIT
    )


def test_message_scope_sits_between_file_and_field() -> None:
    """``json_format`` is the one modelled feature a message may set, so it proves the middle."""
    file_proto = _file()
    file_proto.options.features.json_format = _FS.LEGACY_BEST_EFFORT
    outer = file_proto.message_type.add()
    outer.name = "Outer"
    outer.options.features.json_format = _FS.ALLOW
    inner = outer.nested_type.add()
    inner.name = "Inner"

    context = FileFeatureContext(file_proto)
    outer_features = context.scope(context.file_features, outer.options)
    inner_features = context.scope(outer_features, inner.options)
    assert context.file_features["json_format"] == "LEGACY_BEST_EFFORT"
    assert outer_features["json_format"] == "ALLOW"
    # A nested message with no statement of its own inherits its parent's, not the file's.
    assert inner_features["json_format"] == "ALLOW"


def test_deviations_compare_against_the_file_and_honour_the_name_subset() -> None:
    """Deviations are relative to the file so an inherited choice is stated once, not echoed."""
    file_proto = _file()
    file_proto.options.features.utf8_validation = _FS.NONE
    message = file_proto.message_type.add()
    message.name = "M"
    inherits = _field(message, "inherits", 1)
    verified = _field(message, "verified", 2)
    verified.options.features.utf8_validation = _FS.VERIFY

    context = FileFeatureContext(file_proto)
    message_features = context.scope(context.file_features, message.options)

    # Inherits the file's NONE — no deviation, even though NONE is not the edition default.
    assert context.deviations(context.field_scope(message_features, inherits)) == {}
    assert context.deviations(context.field_scope(message_features, verified)) == {
        "utf8_validation": "VERIFY"
    }
    # A caller narrowing to the features its scope can set sees only those.
    assert (
        context.deviations(
            context.field_scope(message_features, verified), ("json_format",)
        )
        == {}
    )


# ===========================================================================
# Legacy (proto2 / proto3) inference
# ===========================================================================


def test_proto2_required_infers_legacy_required() -> None:
    file_proto = _file(syntax="proto2")
    message = file_proto.message_type.add()
    message.name = "M"
    field = _field(message, "a", 1, label=_FD.LABEL_REQUIRED)
    assert infer_legacy_field_features(file_proto, field) == {
        "field_presence": FIELD_PRESENCE_LEGACY_REQUIRED
    }


def test_proto2_group_infers_delimited_encoding() -> None:
    file_proto = _file(syntax="proto2")
    message = file_proto.message_type.add()
    message.name = "M"
    field = _field(message, "g", 1, type_=_FD.TYPE_GROUP, type_name=".acme.v1.G")
    assert infer_legacy_field_features(file_proto, field)["message_encoding"] == (
        MESSAGE_ENCODING_DELIMITED
    )


@pytest.mark.parametrize(("packed", "expected"), [(True, "PACKED"), (False, "EXPANDED")])
def test_explicit_packed_option_infers_repeated_encoding(packed: bool, expected: str) -> None:
    file_proto = _file(syntax="proto3")
    message = file_proto.message_type.add()
    message.name = "M"
    field = _field(message, "n", 1, type_=_FD.TYPE_INT32, label=_FD.LABEL_REPEATED)
    field.options.packed = packed
    assert infer_legacy_field_features(file_proto, field)["repeated_field_encoding"] == expected


def test_editions_files_infer_nothing() -> None:
    """An Editions file says what it means in features; nothing is read off its shape."""
    file_proto = _file(syntax="editions")
    message = file_proto.message_type.add()
    message.name = "M"
    field = _field(message, "g", 1, type_=_FD.TYPE_GROUP, type_name=".acme.v1.G")
    assert infer_legacy_field_features(file_proto, field) == {}


# ===========================================================================
# The two derived facts
# ===========================================================================


def test_repeated_fields_never_track_presence() -> None:
    message = descriptor_pb2.DescriptorProto()
    message.name = "M"
    field = _field(message, "tags", 1, label=_FD.LABEL_REPEATED)
    assert field_has_presence(field, {"field_presence": FIELD_PRESENCE_EXPLICIT}) is False


def test_message_typed_fields_always_track_presence() -> None:
    """The wire format carries the submessage or does not, whatever the feature says."""
    message = descriptor_pb2.DescriptorProto()
    message.name = "M"
    field = _field(message, "addr", 1, type_=_FD.TYPE_MESSAGE, type_name=".acme.v1.Address")
    assert field_has_presence(field, {"field_presence": FIELD_PRESENCE_IMPLICIT}) is True


def test_oneof_members_and_extensions_always_track_presence() -> None:
    message = descriptor_pb2.DescriptorProto()
    message.name = "M"
    message.oneof_decl.add().name = "choice"
    member = _field(message, "text", 1)
    member.oneof_index = 0
    assert field_has_presence(member, {"field_presence": FIELD_PRESENCE_IMPLICIT}) is True

    extension = descriptor_pb2.FieldDescriptorProto(
        name="annotation", number=1000, type=_FD.TYPE_STRING, label=_FD.LABEL_OPTIONAL
    )
    assert (
        field_has_presence(
            extension, {"field_presence": FIELD_PRESENCE_IMPLICIT}, is_extension=True
        )
        is True
    )


@pytest.mark.parametrize(
    ("presence", "expected"),
    [
        (FIELD_PRESENCE_EXPLICIT, True),
        (FIELD_PRESENCE_LEGACY_REQUIRED, True),
        (FIELD_PRESENCE_IMPLICIT, False),
    ],
)
def test_scalar_presence_follows_the_resolved_feature(presence: str, expected: bool) -> None:
    message = descriptor_pb2.DescriptorProto()
    message.name = "M"
    field = _field(message, "a", 1)
    assert field_has_presence(field, {"field_presence": presence}) is expected


def test_enum_is_closed_reads_the_resolved_feature() -> None:
    assert enum_is_closed({"enum_type": ENUM_TYPE_CLOSED}) is True
    assert enum_is_closed({"enum_type": ENUM_TYPE_OPEN}) is False
    # An unresolved set defaults to open — the safer forward-compatibility reading.
    assert enum_is_closed({}) is False


# ===========================================================================
# Grounding: our answers vs the protobuf runtime's own
# ===========================================================================


def _runtime_answers(
    file_protos: List[descriptor_pb2.FileDescriptorProto], package: str
) -> Tuple[Dict[str, bool], Dict[str, bool]]:
    """Return the runtime's ``has_presence`` / ``is_closed`` for a set of file descriptors.

    Built in a *fresh* :class:`DescriptorPool` so nothing leaks between tests and no symbol can
    collide with the process-wide default pool.
    """
    pool = descriptor_pool.DescriptorPool()
    for file_proto in file_protos:
        pool.Add(file_proto)
    presence: Dict[str, bool] = {}
    closed: Dict[str, bool] = {}

    def walk(descriptor) -> None:
        for field in descriptor.fields:
            presence[field.full_name] = field.has_presence
        for enum in descriptor.enum_types:
            closed[enum.full_name] = enum.is_closed
        for nested in descriptor.nested_types:
            walk(nested)

    for file_proto in file_protos:
        pkg = file_proto.package or package
        for message in file_proto.message_type:
            walk(pool.FindMessageTypeByName(f"{pkg}.{message.name}"))
        for enum in file_proto.enum_type:
            enum_descriptor = pool.FindEnumTypeByName(f"{pkg}.{enum.name}")
            closed[enum_descriptor.full_name] = enum_descriptor.is_closed
    return presence, closed


def _our_answers(
    file_proto: descriptor_pb2.FileDescriptorProto,
) -> Tuple[Dict[str, bool], Dict[str, bool]]:
    """Return :mod:`app.proto_editions`'s ``has_presence`` / ``is_closed`` for one file."""
    context = FileFeatureContext(file_proto)
    package = file_proto.package
    presence: Dict[str, bool] = {}
    closed: Dict[str, bool] = {}

    def walk(message, parent_features, prefix) -> None:
        features = context.scope(parent_features, message.options)
        oneof_features = [
            context.scope(features, oneof.options) for oneof in message.oneof_decl
        ]
        for field in message.field:
            scope = (
                oneof_features[field.oneof_index]
                if field.HasField("oneof_index")
                else features
            )
            resolved = context.field_scope(scope, field)
            presence[f"{prefix}.{field.name}"] = field_has_presence(field, resolved)
        for enum in message.enum_type:
            closed[f"{prefix}.{enum.name}"] = enum_is_closed(
                context.scope(features, enum.options)
            )
        for nested in message.nested_type:
            walk(nested, features, f"{prefix}.{nested.name}")

    for message in file_proto.message_type:
        walk(message, context.file_features, f"{package}.{message.name}")
    for enum in file_proto.enum_type:
        closed[f"{package}.{enum.name}"] = enum_is_closed(
            context.scope(context.file_features, enum.options)
        )
    return presence, closed


def _grounding_file(
    *, syntax: str, edition: int = _ED.EDITION_2023
) -> descriptor_pb2.FileDescriptorProto:
    """Build one file exercising every presence/enum shape the resolver has a rule for."""
    file_proto = _file(syntax=syntax, edition=edition, package="ground.v1")
    if syntax == "editions":
        file_proto.options.features.field_presence = _FS.IMPLICIT
        file_proto.options.features.enum_type = _FS.CLOSED

    open_enum = file_proto.enum_type.add()
    open_enum.name = "OpenEnum"
    open_enum.value.add(name="OPEN_ENUM_UNSPECIFIED", number=0)
    if syntax == "editions":
        open_enum.options.features.enum_type = _FS.OPEN

    file_enum = file_proto.enum_type.add()
    file_enum.name = "FileEnum"
    file_enum.value.add(name="FILE_ENUM_UNSPECIFIED", number=0)

    message = file_proto.message_type.add()
    message.name = "Shapes"
    nested = message.nested_type.add()
    nested.name = "Nested"
    _field(nested, "label", 1)

    _field(message, "inherits", 1)
    _field(message, "tags", 2, label=_FD.LABEL_REPEATED)
    _field(message, "nested", 3, type_=_FD.TYPE_MESSAGE, type_name=".ground.v1.Shapes.Nested")
    _field(message, "colour", 4, type_=_FD.TYPE_ENUM, type_name=".ground.v1.FileEnum")
    message.oneof_decl.add().name = "choice"
    member = _field(message, "text", 5)
    member.oneof_index = 0

    if syntax == "editions":
        explicit = _field(message, "explicit", 6)
        explicit.options.features.field_presence = _FS.EXPLICIT
        required = _field(message, "legacy_required", 7)
        required.options.features.field_presence = _FS.LEGACY_REQUIRED
    elif syntax == "proto2":
        _field(message, "legacy_required", 7, label=_FD.LABEL_REQUIRED)
    else:  # proto3
        message.oneof_decl.add().name = "_explicit"
        explicit = _field(message, "explicit", 6)
        explicit.oneof_index = 1
        explicit.proto3_optional = True

    return file_proto


@pytest.mark.parametrize(
    ("syntax", "edition"),
    [
        ("editions", _ED.EDITION_2023),
        ("editions", _ED.EDITION_2024),
        ("proto3", _ED.EDITION_PROTO3),
        ("proto2", _ED.EDITION_PROTO2),
    ],
)
def test_resolution_matches_the_protobuf_runtime(syntax: str, edition: int) -> None:
    """Our presence/closed answers equal the runtime's, for every syntax.

    This is the acceptance check for the resolver as a whole: it exists to restate the
    compiler's rules, so the compiler's own runtime is the oracle rather than a table we wrote.
    """
    file_proto = _grounding_file(syntax=syntax, edition=edition)
    theirs_presence, theirs_closed = _runtime_answers([file_proto], "ground.v1")
    ours_presence, ours_closed = _our_answers(file_proto)

    assert ours_presence == theirs_presence
    assert ours_closed == theirs_closed
    # The fixture must actually exercise both answers, or the equality above is vacuous.
    assert set(ours_presence.values()) == {True, False}


def test_editions_grounding_fixture_distinguishes_explicit_from_implicit() -> None:
    """The FMT-3.7 headline, asserted directly on the resolver."""
    file_proto = _grounding_file(syntax="editions")
    presence, _closed = _our_answers(file_proto)
    assert presence["ground.v1.Shapes.inherits"] is False  # file default IMPLICIT
    assert presence["ground.v1.Shapes.explicit"] is True  # field override EXPLICIT
    assert presence["ground.v1.Shapes.legacy_required"] is True


def test_feature_sets_do_not_cross_a_file_boundary() -> None:
    """An imported file resolves against its own edition and options, never the importer's.

    The corpus fileset makes the same point end to end; this is the unit-level statement, and
    the reason :class:`FileFeatureContext` is constructed per file rather than per document.
    """
    imported = _file(package="common.v1", name="common/v1/common.proto")
    imported.options.features.field_presence = _FS.IMPLICIT
    address = imported.message_type.add()
    address.name = "Address"
    _field(address, "city", 1)

    importer = _file(package="shipping.v1", name="shipping/v1/shipping.proto")
    importer.options.features.field_presence = _FS.EXPLICIT
    importer.dependency.append("common/v1/common.proto")
    shipment = importer.message_type.add()
    shipment.name = "Shipment"
    _field(shipment, "shipment_id", 1)

    ours_imported, _ = _our_answers(imported)
    ours_importer, _ = _our_answers(importer)
    assert ours_imported["common.v1.Address.city"] is False
    assert ours_importer["shipping.v1.Shipment.shipment_id"] is True

    theirs, _ = _runtime_answers([imported, importer], "")
    assert theirs["common.v1.Address.city"] is False
    assert theirs["shipping.v1.Shipment.shipment_id"] is True
