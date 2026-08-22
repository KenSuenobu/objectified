"""Protobuf **Editions** feature resolution — FMT-3.7 (#5432).

MFI-9.1 compiles ``.proto`` source to a ``FileDescriptorSet`` and MFI-9.2 maps that onto the
canonical model. Neither of them *resolves edition features*, and the compiler does not do it
for us: ``buf build`` writes each scope's **raw** ``features`` override into
``options.features`` and leaves the merge to the reader. So an Editions file arrived at the
normalizer looking like proto3 — every singular field ``LABEL_OPTIONAL``, no presence
information anywhere — and normalized as if it were, silently mis-modelling optionality.

This module is the resolver that was missing. It is **pure** (no I/O, no compiler) and does
three things:

* **Edition defaults** (:func:`edition_defaults`) — for one ``Edition`` enum value, the
  resolved default of every feature. The table is *derived* from the shipped
  ``descriptor.proto`` rather than transcribed: every ``FeatureSet`` field carries
  ``edition_defaults`` entries and a ``feature_support.edition_introduced`` marker, and the
  resolution rule is "take the entry with the largest edition ``<=`` this one". Deriving it
  means a protobuf-runtime upgrade that adds Edition 2025 needs no change here, and no
  hand-copied table can drift from the specification.
* **Scope merge** (:func:`merge_features`) — features resolve down the *lexical* scope chain
  (file → message → nested message → field, file → enum → value, message → oneof → field),
  each scope inheriting its parent's resolved set and overriding only what it names.
* **Legacy inference** (:func:`infer_legacy_field_features`) — proto2/proto3 files have no
  ``features`` syntax, so their semantics are inferred from the descriptor the same way
  ``protoc`` does (``required`` → ``LEGACY_REQUIRED``, a ``group`` → ``DELIMITED``, an explicit
  ``packed`` option → ``PACKED``/``EXPANDED``). That makes one resolver correct for every
  syntax, which is what lets the grounding test compare our answer to the protobuf runtime's
  own ``has_presence``/``is_closed`` for proto2, proto3 **and** editions files.

**The two derived facts the canonical model actually needs** are
:func:`field_has_presence` — whether a field tracks presence, which is canonical nullability —
and :func:`enum_is_closed`. Both are more than a feature lookup: a message-typed field, an
extension, and any ``oneof`` member track presence regardless of ``field_presence``, and a
``repeated`` field never does. Those rules are the compiler's, restated here so the canonical
model agrees with the wire format rather than with the source text.

**Modelled versus not.** :data:`MODELLED_FEATURES` are the six features whose resolved values
the normalizer records; :data:`UNMODELLED_FEATURES` are the Edition 2024 additions
(``enforce_naming_style``, ``default_symbol_visibility``) which govern *compiler* behaviour,
not the wire or JSON contract, and are therefore resolved and reported but never mapped onto a
canonical construct. The capability registry publishes exactly this split.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from google.protobuf import descriptor_pb2

__all__ = [
    "MODELLED_FEATURES",
    "UNMODELLED_FEATURES",
    "FEATURE_NAMES",
    "FIELD_PRESENCE_EXPLICIT",
    "FIELD_PRESENCE_IMPLICIT",
    "FIELD_PRESENCE_LEGACY_REQUIRED",
    "ENUM_TYPE_CLOSED",
    "ENUM_TYPE_OPEN",
    "MESSAGE_ENCODING_DELIMITED",
    "REPEATED_FIELD_ENCODING_EXPANDED",
    "UTF8_VALIDATION_NONE",
    "JSON_FORMAT_LEGACY_BEST_EFFORT",
    "SYNTAX_EDITIONS",
    "EDITIONS_PROVENANCE_EXTRA_KEY",
    "FIELD_PRESENCE_EXTRA_KEY",
    "ENUM_CLOSED_EXTRA_KEY",
    "FEATURES_EXTRA_KEY",
    "edition_defaults",
    "available_feature_names",
    "edition_value_for_file",
    "feature_overrides",
    "merge_features",
    "infer_legacy_field_features",
    "field_has_presence",
    "enum_is_closed",
    "FileFeatureContext",
]


# ===========================================================================
# Vocabulary
# ===========================================================================

#: ``CanonicalApi.extras`` key carrying the Editions provenance record — the per-file edition,
#: syntax and resolved feature set. It lives here rather than on either side because the
#: normalizer writes it and the emitter and lint pack read it; a shared name in the shared
#: vocabulary module keeps the emitter from importing the normalizer to interpret its output.
#: Registered in :data:`app.import_preview_manifest.PROVENANCE_EXTRA_KEYS`.
EDITIONS_PROVENANCE_EXTRA_KEY = "protobuf_editions"

#: ``CanonicalField.extras`` key carrying an Editions field's *resolved* ``field_presence``.
#: It gets a dedicated key rather than riding in :data:`FEATURES_EXTRA_KEY` because it is the
#: one feature that drives a canonical attribute (nullability), and because ``IMPLICIT`` and
#: ``LEGACY_REQUIRED`` both map to non-nullable — the value is what tells them apart.
FIELD_PRESENCE_EXTRA_KEY = "field_presence"

#: ``Type.extras`` key carrying whether an Editions enum is closed (an unrecognised value fails
#: to parse into it) — the ``enum_type`` feature, stated as the fact a reader needs.
ENUM_CLOSED_EXTRA_KEY = "enum_closed"

#: ``extras`` key carrying the remaining modelled features, recorded at the scope that owns
#: each one and only where the resolved value deviates from its file's.
FEATURES_EXTRA_KEY = "proto_features"

#: ``FileDescriptorProto.syntax`` value an Editions file carries. proto2 files omit ``syntax``
#: entirely and proto3 files set ``"proto3"``, so this is the one positive Editions marker on a
#: compiled descriptor.
SYNTAX_EDITIONS = "editions"

#: The six features whose resolved values the normalizer records and maps. They are the ones
#: that change the *wire* or *JSON* contract of a document, so a change to any of them is a
#: semantic change the fingerprint must see.
MODELLED_FEATURES: Tuple[str, ...] = (
    "field_presence",
    "enum_type",
    "repeated_field_encoding",
    "utf8_validation",
    "message_encoding",
    "json_format",
)

#: Features that are resolved and reported in provenance but deliberately **not** mapped onto
#: any canonical construct: they constrain the *compiler* (naming lint, generated-symbol
#: visibility), not the bytes on the wire or the JSON mapping, so there is nothing in a
#: language-neutral API model for them to become. The capability registry publishes this list.
UNMODELLED_FEATURES: Tuple[str, ...] = (
    "enforce_naming_style",
    "default_symbol_visibility",
)

#: Every feature this module knows about, modelled first, in a stable order.
FEATURE_NAMES: Tuple[str, ...] = MODELLED_FEATURES + UNMODELLED_FEATURES

# --- the feature values referenced by name elsewhere (normalizer, lint, emitter) -----------

FIELD_PRESENCE_EXPLICIT = "EXPLICIT"
FIELD_PRESENCE_IMPLICIT = "IMPLICIT"
FIELD_PRESENCE_LEGACY_REQUIRED = "LEGACY_REQUIRED"

ENUM_TYPE_OPEN = "OPEN"
ENUM_TYPE_CLOSED = "CLOSED"

MESSAGE_ENCODING_DELIMITED = "DELIMITED"

REPEATED_FIELD_ENCODING_EXPANDED = "EXPANDED"

UTF8_VALIDATION_NONE = "NONE"

JSON_FORMAT_LEGACY_BEST_EFFORT = "LEGACY_BEST_EFFORT"


# ===========================================================================
# Edition defaults, derived from the shipped descriptor.proto
# ===========================================================================


@lru_cache(maxsize=1)
def _feature_field_descriptors() -> Tuple[Tuple[str, Any], ...]:
    """The ``FeatureSet`` fields this module knows about, in :data:`FEATURE_NAMES` order.

    A feature named here but absent from the installed runtime's ``FeatureSet`` (an older
    protobuf release that predates Edition 2024) is skipped rather than raising, so the module
    imports on any runtime.

    Returns:
        ``(feature_name, FieldDescriptor)`` pairs for the features that exist here.
    """
    fields = {field.name: field for field in descriptor_pb2.FeatureSet.DESCRIPTOR.fields}
    return tuple((name, fields[name]) for name in FEATURE_NAMES if name in fields)


def _edition_introduced(field_descriptor: object) -> int:
    """The Edition enum value a feature became available in.

    Read from the feature field's ``feature_support.edition_introduced`` option. A feature with
    no such marker is treated as always available (``EDITION_LEGACY``), which is the
    conservative reading — it can only ever *add* a default, never withhold one.
    """
    options = field_descriptor.GetOptions()  # type: ignore[attr-defined]
    support = options.feature_support
    if support.edition_introduced:
        return int(support.edition_introduced)
    return int(descriptor_pb2.Edition.EDITION_LEGACY)


def _edition_removed(field_descriptor: object) -> Optional[int]:
    """The Edition enum value a feature was removed in, or ``None`` while it is still current."""
    options = field_descriptor.GetOptions()  # type: ignore[attr-defined]
    support = options.feature_support
    if support.edition_removed:
        return int(support.edition_removed)
    return None


def _default_for(field_descriptor: object, edition_value: int) -> Optional[str]:
    """Resolve one feature's default for ``edition_value`` from its ``edition_defaults``.

    The specification's rule: take the ``edition_defaults`` entry whose edition is the largest
    one **not greater than** the target edition. The ``Edition`` enum is numbered in release
    order (``EDITION_LEGACY`` 900 < ``EDITION_PROTO2`` 998 < ``EDITION_PROTO3`` 999 <
    ``EDITION_2023`` 1000 < …), so the comparison is a plain integer one — and an edition newer
    than anything the runtime knows about simply inherits the newest declared default rather
    than failing.

    Returns:
        The default's enum **value name** (``"EXPLICIT"``, ``"OPEN"``, …), or ``None`` when the
        feature declares no default at or below this edition.
    """
    best_edition: Optional[int] = None
    best_value: Optional[str] = None
    for entry in field_descriptor.GetOptions().edition_defaults:  # type: ignore[attr-defined]
        entry_edition = int(entry.edition)
        if entry_edition > edition_value:
            continue
        if best_edition is None or entry_edition > best_edition:
            best_edition = entry_edition
            best_value = entry.value
    return best_value


@lru_cache(maxsize=None)
def _edition_defaults_cached(edition_value: int) -> Tuple[Tuple[str, str], ...]:
    """Memoized backing store for :func:`edition_defaults` (the walk asks once per file)."""
    resolved: Dict[str, str] = {}
    for name, field_descriptor in _feature_field_descriptors():
        removed = _edition_removed(field_descriptor)
        if removed is not None and edition_value >= removed:
            continue
        default = _default_for(field_descriptor, edition_value)
        if default is not None:
            resolved[name] = default
    return tuple(resolved.items())


def edition_defaults(edition_value: int) -> Dict[str, str]:
    """Return the resolved default feature set for one ``Edition`` enum value.

    This is the root of every resolution chain: a file with no ``option features.*`` at all
    resolves exactly to this. It is deliberately **specification-exact** rather than filtered —
    every feature with a default at or below this edition is resolved, including the ones the
    edition's own syntax cannot set (a proto2 file resolves ``field_presence = EXPLICIT`` even
    though it has no way to write that). Filtering for *what a document could have controlled*
    is a reporting concern and lives in :func:`available_feature_names`.

    Args:
        edition_value: A ``google.protobuf.Edition`` enum value —
            ``EDITION_PROTO2`` / ``EDITION_PROTO3`` for the legacy syntaxes,
            ``EDITION_2023`` / ``EDITION_2024`` for an Editions file.

    Returns:
        A fresh dict of feature name → default enum value name, in :data:`FEATURE_NAMES`
        order. Fresh because callers merge onto it; the memoized form is immutable.
    """
    return dict(_edition_defaults_cached(edition_value))


@lru_cache(maxsize=None)
def available_feature_names(edition_value: int) -> Tuple[str, ...]:
    """The features an ``edition_value`` document can actually *set*, in a stable order.

    Every ``FeatureSet`` field declares the edition it was introduced in (and, eventually, the
    one it was removed in). Edition 2024's ``enforce_naming_style`` resolves to a value in an
    Edition 2023 file — ``protoc`` computes it — but a 2023 document has no syntax to change it,
    so reporting it as part of that file's feature set would overstate what the source said.
    Provenance therefore reports the resolved set narrowed to these names.

    Args:
        edition_value: A ``google.protobuf.Edition`` enum value.

    Returns:
        The available feature names, in :data:`FEATURE_NAMES` order.
    """
    names: List[str] = []
    for name, field_descriptor in _feature_field_descriptors():
        if edition_value < _edition_introduced(field_descriptor):
            continue
        removed = _edition_removed(field_descriptor)
        if removed is not None and edition_value >= removed:
            continue
        names.append(name)
    return tuple(names)


def edition_value_for_file(file_proto: descriptor_pb2.FileDescriptorProto) -> int:
    """Return the ``Edition`` enum value that governs ``file_proto``'s feature resolution.

    An Editions file states its edition directly. proto2/proto3 files have no edition, but the
    defaults table covers them through the ``EDITION_PROTO2`` / ``EDITION_PROTO3`` sentinels —
    which is exactly how ``protoc`` gives editions logic one code path for every syntax.

    Args:
        file_proto: The compiled file descriptor.

    Returns:
        The governing ``Edition`` enum value.
    """
    if file_proto.syntax == SYNTAX_EDITIONS:
        # A descriptor that says "editions" but carries no edition is malformed input from a
        # compiler; fall back to the first edition rather than to a proto2 reading, which would
        # invert every presence answer.
        return int(file_proto.edition) or int(descriptor_pb2.Edition.EDITION_2023)
    if file_proto.syntax == "proto3":
        return int(descriptor_pb2.Edition.EDITION_PROTO3)
    return int(descriptor_pb2.Edition.EDITION_PROTO2)


# ===========================================================================
# Scope merge
# ===========================================================================


def feature_overrides(options: object) -> Dict[str, str]:
    """Extract the features one scope *explicitly sets*, ignoring everything it inherits.

    A ``FeatureSet`` is a normal protobuf message, so an unset feature is indistinguishable
    from its default by value — ``HasField`` is the only way to tell "this scope said
    ``EXPLICIT``" from "this scope said nothing". Reading the presence bit is what makes the
    merge chain honest.

    Args:
        options: Any descriptor's options message (``FileOptions``, ``MessageOptions``,
            ``FieldOptions``, ``EnumOptions``, ``OneofOptions``, …), or ``None``.

    Returns:
        Feature name → enum value name for the features this scope set, in
        :data:`FEATURE_NAMES` order. Empty when the scope sets none.
    """
    if options is None:
        return {}
    features = getattr(options, "features", None)
    if features is None:
        return {}
    overrides: Dict[str, str] = {}
    for name, field_descriptor in _feature_field_descriptors():
        if not features.HasField(name):
            continue
        value = getattr(features, name)
        overrides[name] = field_descriptor.enum_type.values_by_number[value].name  # type: ignore[attr-defined]
    return overrides


def merge_features(
    parent: Mapping[str, str], *overrides: Mapping[str, str]
) -> Dict[str, str]:
    """Merge a scope's overrides onto its parent's resolved feature set.

    Features resolve down the lexical scope chain — file → message → nested message → field,
    file → enum → value, message → oneof → field — with each scope inheriting everything it
    does not name. Later ``overrides`` win, so a caller can layer inferred legacy features
    beneath an explicit override by passing them in that order.

    Args:
        parent: The enclosing scope's already-resolved feature set.
        *overrides: Zero or more override maps, applied left to right.

    Returns:
        A new resolved feature set; neither ``parent`` nor any override is mutated.
    """
    resolved = dict(parent)
    for override in overrides:
        resolved.update(override)
    return resolved


# ===========================================================================
# Legacy (proto2 / proto3) inference
# ===========================================================================


def infer_legacy_field_features(
    file_proto: descriptor_pb2.FileDescriptorProto,
    field: descriptor_pb2.FieldDescriptorProto,
) -> Dict[str, str]:
    """Infer the editions features a proto2/proto3 field's *descriptor shape* implies.

    proto2 and proto3 have no ``features`` syntax, but they do express the same semantics
    through other descriptor fields. Restating them as features — exactly as ``protoc``'s own
    ``InferLegacyProtoFeatures`` does — is what lets one resolver serve every syntax, so the
    canonical model asks the same question of an editions file and a proto2 file.

    The three inferences:

    * ``label == LABEL_REQUIRED`` (proto2 only) → ``field_presence = LEGACY_REQUIRED``;
    * ``type == TYPE_GROUP`` (proto2 only) → ``message_encoding = DELIMITED``;
    * an explicit ``[packed = …]`` option → ``repeated_field_encoding = PACKED``/``EXPANDED``.

    Args:
        file_proto: The field's file, for its syntax.
        field: The field descriptor.

    Returns:
        The inferred features; empty for a field whose shape implies nothing. Applied *beneath*
        any explicit override.
    """
    if file_proto.syntax == SYNTAX_EDITIONS:
        return {}

    inferred: Dict[str, str] = {}
    if field.label == descriptor_pb2.FieldDescriptorProto.LABEL_REQUIRED:
        inferred["field_presence"] = FIELD_PRESENCE_LEGACY_REQUIRED
    if field.type == descriptor_pb2.FieldDescriptorProto.TYPE_GROUP:
        inferred["message_encoding"] = MESSAGE_ENCODING_DELIMITED
    if field.options.HasField("packed"):
        inferred["repeated_field_encoding"] = (
            "PACKED" if field.options.packed else REPEATED_FIELD_ENCODING_EXPANDED
        )
    return inferred


# ===========================================================================
# The two derived facts the canonical model needs
# ===========================================================================


def field_has_presence(
    field: descriptor_pb2.FieldDescriptorProto,
    resolved: Mapping[str, str],
    *,
    is_extension: bool = False,
) -> bool:
    """Whether ``field`` tracks presence — the fact canonical nullability is derived from.

    This is deliberately more than a ``field_presence`` lookup, because four descriptor shapes
    outrank the feature (the same precedence the runtimes implement):

    * a ``repeated`` field (a ``map`` included) never tracks presence — there is no "absent"
      distinct from "empty";
    * a singular **message**-typed field always does, in every syntax, because the wire format
      carries the submessage or does not;
    * a ``oneof`` member always does — presence is the whole point of a oneof;
    * an **extension** always does.

    Only when none of those apply does the resolved ``field_presence`` decide it: ``EXPLICIT``
    and ``LEGACY_REQUIRED`` track presence, ``IMPLICIT`` does not.

    Args:
        field: The field descriptor.
        resolved: The field's fully resolved feature set.
        is_extension: ``True`` when the field is an ``extend`` member rather than a declared
            field of its message.

    Returns:
        ``True`` when the field distinguishes "unset" from "set to the zero value".
    """
    if field.label == descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED:
        return False
    if field.type in (
        descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE,
        descriptor_pb2.FieldDescriptorProto.TYPE_GROUP,
    ):
        return True
    if is_extension or field.HasField("oneof_index"):
        return True
    return resolved.get("field_presence", FIELD_PRESENCE_EXPLICIT) != FIELD_PRESENCE_IMPLICIT


def enum_is_closed(resolved: Mapping[str, str]) -> bool:
    """Whether an enum is *closed* — an unrecognised value fails to parse into it.

    A ``CLOSED`` enum (proto2's behaviour, and the editions ``enum_type = CLOSED`` spelling)
    rejects numbers it does not declare, so a peer that adds a value breaks older readers; an
    ``OPEN`` enum (proto3's behaviour) preserves the unknown number. The distinction is a
    forward-compatibility fact about the contract, which is why the canonical model records it
    rather than leaving it to the source text.

    Args:
        resolved: The enum's fully resolved feature set.

    Returns:
        ``True`` for a closed enum.
    """
    return resolved.get("enum_type", ENUM_TYPE_OPEN) == ENUM_TYPE_CLOSED


# ===========================================================================
# Per-file resolution context
# ===========================================================================


class FileFeatureContext:
    """Feature resolution scoped to one file — the object a descriptor walk carries down.

    Feature sets **never cross a file boundary**: an imported file resolves against its own
    edition and its own file-level options, never against the importing file's. Binding the
    context to a single ``FileDescriptorProto`` is what makes that structural rather than a
    rule the walk has to remember.

    Attributes:
        file_proto: The file this context resolves for.
        edition_value: The governing ``Edition`` enum value.
        syntax: ``proto2`` / ``proto3`` / ``editions``.
        is_editions: ``True`` when the file declares an ``edition``.
        defaults: The edition's default feature set — the root of every chain in this file.
        file_features: The file's own resolved feature set (``defaults`` + file options).
    """

    __slots__ = (
        "file_proto",
        "edition_value",
        "syntax",
        "is_editions",
        "defaults",
        "file_features",
    )

    def __init__(self, file_proto: descriptor_pb2.FileDescriptorProto) -> None:
        """Build the context for ``file_proto``, resolving its edition and file-level features."""
        self.file_proto = file_proto
        self.edition_value = edition_value_for_file(file_proto)
        self.syntax = file_proto.syntax or "proto2"
        self.is_editions = self.syntax == SYNTAX_EDITIONS
        self.defaults = edition_defaults(self.edition_value)
        self.file_features = merge_features(
            self.defaults, feature_overrides(file_proto.options)
        )

    @property
    def edition(self) -> Optional[str]:
        """The short edition label (``"2023"``/``"2024"``), or ``None`` for proto2/proto3.

        Reuses :func:`app.proto_descriptor._edition_label`'s mapping via the same enum, so the
        label a provenance record carries matches the one
        :class:`~app.proto_descriptor.ProtoFileDescriptor` reports for the same file.
        """
        from .proto_descriptor import _edition_label

        return _edition_label(self.edition_value) if self.is_editions else None

    def scope(self, parent: Mapping[str, str], options: object) -> Dict[str, str]:
        """Resolve a nested scope's features from its parent's set and its own options.

        Args:
            parent: The enclosing scope's resolved feature set.
            options: The nested scope's options message (message/enum/oneof/service/method).

        Returns:
            The nested scope's resolved feature set.
        """
        return merge_features(parent, feature_overrides(options))

    def field_scope(
        self,
        parent: Mapping[str, str],
        field: descriptor_pb2.FieldDescriptorProto,
    ) -> Dict[str, str]:
        """Resolve one field's features: parent set, legacy inference, then explicit overrides.

        The order matters. Legacy inference describes what the field's *shape* implies, so an
        explicit ``[features.field_presence = …]`` — which only an editions file can carry —
        must win over it; and both must win over the enclosing message or oneof.

        Args:
            parent: The enclosing message's (or oneof's) resolved feature set.
            field: The field descriptor.

        Returns:
            The field's fully resolved feature set.
        """
        return merge_features(
            parent,
            infer_legacy_field_features(self.file_proto, field),
            feature_overrides(field.options),
        )

    def deviations(
        self, resolved: Mapping[str, str], names: Iterable[str] = MODELLED_FEATURES
    ) -> Dict[str, str]:
        """The features of ``resolved`` that differ from this **file's** resolved set.

        The canonical model records deviations rather than whole resolved sets, for two
        reasons. It keeps ``extras`` readable — a typical entity deviates in nothing, and a
        six-key bag on every field of every message would drown the entities that matter. And
        it is lossless: the file's own resolved set is recorded in provenance, so
        "resolved = file features + this deviation set" reconstructs the whole answer, and any
        change to an entity's effective semantics necessarily changes either its deviation set
        or the recorded file-level set — so the fingerprint sees every one of them.

        The comparison baseline is the **file**, not the edition defaults, precisely so an
        inherited file-level choice is stated once in provenance instead of being echoed onto
        every entity that inherits it.

        Args:
            resolved: A fully resolved feature set.
            names: The features to consider. Callers pass the subset a given scope can set —
                a field's features are not an enum's — so each feature is recorded exactly
                once, at the scope that owns it.

        Returns:
            Feature name → value for the considered features that differ from the file's
            resolved value, in ``names`` order. Empty when nothing deviates.
        """
        return {
            name: resolved[name]
            for name in names
            if name in resolved and resolved[name] != self.file_features.get(name)
        }
