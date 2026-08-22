"""Protocol Buffers (proto3) emitter: canonical model → ``.proto`` — MFX-12.1 (#3879).

The inverse of :class:`app.proto_normalizer.ProtoNormalizer` and an implementation of the
:class:`app.emitter.Emitter` SPI. It walks a :class:`~app.canonical_model.CanonicalApi` and
produces **proto3** source text:

* identity ``namespace`` → ``package``; referenced well-known types → ``import`` statements;
* :class:`~app.canonical_model.Service`\\s → ``service`` blocks, their
  :class:`~app.canonical_model.Operation`\\s → ``rpc`` methods whose
  :class:`~app.canonical_model.StreamingMode` restores the ``stream`` keyword on the request
  and/or response (unary / client- / server- / bidi-streaming — the acceptance criterion);
* ``RECORD`` :class:`~app.canonical_model.Type`\\s → ``message`` blocks (nesting reconstructed
  from the dotted type keys), their :class:`~app.canonical_model.CanonicalField`\\s → typed,
  numbered fields (``repeated`` for a list, ``map<K,V>`` for a ``MAP``-type reference, proto3
  ``optional`` for explicit presence, ``oneof`` blocks rebuilt from the field/type ``extras``);
* ``ENUM`` :class:`~app.canonical_model.Type`\\s → ``enum`` blocks preserving value numbers;
* ``reserved`` ranges/names, ``deprecated`` options, and method ``idempotency_level`` are
  restored from the same ``extras`` keys :class:`ProtoNormalizer` wrote.

The mapping inverts :mod:`app.proto_normalizer` construct-for-construct, so a protobuf source
round-trips (the MFX-12.3 round-trip ticket automates this): the normalizer keeps a field's
number on :attr:`~app.canonical_model.CanonicalField.field_number`, an enum value's number on
:attr:`~app.canonical_model.EnumValue.value`, ``oneof`` membership in field/type ``extras``, and
``map<K,V>`` as a standalone :attr:`~app.canonical_model.TypeKind.MAP` type — and this emitter
reads each back.

**Best-effort for non-RPC sources.** Protobuf is an RPC/type vocabulary: it has no validation
facets, no first-class union type, and no pub/sub. A construct a proto3 document cannot carry
faithfully (a field ``Constraints``, a ``UNION`` type, a proto2 ``default``, an event operation,
a source field with no number) is emitted with the closest proto stand-in and recorded as a
:class:`~app.emitter.Loss` on the result rather than silently dropped — the material the gRPC
fidelity pack (MFX-12.3) turns into per-construct ``APPROX``/``DROP``/``SYNTH`` verdicts.

Two properties make the output trustworthy:

* **Deterministic.** Types, fields, services, and methods are emitted in the model's
  (already order-normalized) order, so re-emitting the same model yields byte-identical text.
* **Provenance-tracked.** Each emitted construct is tagged :attr:`~app.emitter.Provenance.SOURCE`
  (from the model), :attr:`~app.emitter.Provenance.INFERRED` (synthesized — a field number the
  source lacked, a ``oneof`` wrapping a union), or :attr:`~app.emitter.Provenance.DEFAULT`
  (a fixed emitter choice — the ``syntax`` line).

The emitter is pure (no I/O) and self-registers under the ``proto3`` format key. Types are
packaged **one ``.proto`` per protobuf ``package``** with cross-package ``import`` lines (MFX-12.4);
a single-package source still yields one file. The acceptance-criterion validation ("emits
compilable ``.proto`` via ``buf build``") is confirmed by feeding every emitted file through
:func:`app.proto_descriptor.compile_proto_descriptor_set`; the convenience
:func:`compile_emitted_descriptor_set` pairs emit + compile for the optional ``FileDescriptorSet``
output, and the round-trip ticket (MFX-12.3) automates the full loop.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from pydantic import Field

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict, _has_any_constraint
from .lossiness import LossinessSeverity
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .field_identity_store import FieldNumberAllocator
from .proto_editions import (
    EDITIONS_PROVENANCE_EXTRA_KEY,
    ENUM_CLOSED_EXTRA_KEY,
    FEATURES_EXTRA_KEY,
    FIELD_PRESENCE_EXPLICIT,
    FIELD_PRESENCE_EXTRA_KEY,
    FIELD_PRESENCE_LEGACY_REQUIRED,
)

__all__ = [
    "ProtoEmitOptions",
    "ProtoEmitter",
    "ProtoFidelityRulePack",
    "compile_emitted_descriptor_set",
]

# The 15 protobuf scalar keywords. A leaf :class:`TypeRef.name` that is one of these is a proto
# scalar; any other name is a package-qualified reference to a named (or imported) type. This is
# exactly the value set of :data:`app.proto_normalizer._SCALAR_TYPE_NAMES`, inverted.
_PROTO_SCALARS = frozenset(
    {
        "double",
        "float",
        "int32",
        "int64",
        "uint32",
        "uint64",
        "sint32",
        "sint64",
        "fixed32",
        "fixed64",
        "sfixed32",
        "sfixed64",
        "bool",
        "string",
        "bytes",
    }
)

# The streaming modes that put a ``stream`` keyword on the request / on the response. The inverse
# of :func:`app.proto_normalizer._streaming_mode`.
_STREAM_REQUEST = frozenset({StreamingMode.CLIENT, StreamingMode.BIDIRECTIONAL})
_STREAM_RESPONSE = frozenset({StreamingMode.SERVER, StreamingMode.BIDIRECTIONAL})

# Well-known protobuf type key → the ``import`` path that declares it. A referenced dotted type
# with no local :class:`Type` that is one of these is a WKT and needs its import; the normalizer
# drops the import path (only the type name survives), so the emitter reconstructs it here.
_WKT_IMPORTS: Dict[str, str] = {
    "google.protobuf.Any": "google/protobuf/any.proto",
    "google.protobuf.Api": "google/protobuf/api.proto",
    "google.protobuf.BoolValue": "google/protobuf/wrappers.proto",
    "google.protobuf.BytesValue": "google/protobuf/wrappers.proto",
    "google.protobuf.DoubleValue": "google/protobuf/wrappers.proto",
    "google.protobuf.Duration": "google/protobuf/duration.proto",
    "google.protobuf.Empty": "google/protobuf/empty.proto",
    "google.protobuf.Enum": "google/protobuf/type.proto",
    "google.protobuf.FieldMask": "google/protobuf/field_mask.proto",
    "google.protobuf.FloatValue": "google/protobuf/wrappers.proto",
    "google.protobuf.Int32Value": "google/protobuf/wrappers.proto",
    "google.protobuf.Int64Value": "google/protobuf/wrappers.proto",
    "google.protobuf.ListValue": "google/protobuf/struct.proto",
    "google.protobuf.Method": "google/protobuf/api.proto",
    "google.protobuf.NullValue": "google/protobuf/struct.proto",
    "google.protobuf.StringValue": "google/protobuf/wrappers.proto",
    "google.protobuf.Struct": "google/protobuf/struct.proto",
    "google.protobuf.Timestamp": "google/protobuf/timestamp.proto",
    "google.protobuf.Type": "google/protobuf/type.proto",
    "google.protobuf.UInt32Value": "google/protobuf/wrappers.proto",
    "google.protobuf.UInt64Value": "google/protobuf/wrappers.proto",
    "google.protobuf.Value": "google/protobuf/struct.proto",
}

# The type protobuf substitutes for a missing rpc response (an event/one-way source operation).
_EMPTY_TYPE = "google.protobuf.Empty"

# Method idempotency labels the normalizer stored (``extras["idempotency_level"]``) → the proto
# enum constant emitted as an ``option idempotency_level = …;``.
_IDEMPOTENCY_OPTIONS: Dict[str, str] = {
    "no_side_effects": "NO_SIDE_EFFECTS",
    "idempotent": "IDEMPOTENT",
}

# The largest legal proto field number; a reserved range ending at-or-above it renders ``to max``.
_PROTO_MAX_FIELD_NUMBER = 536870911

# Characters not allowed in a protobuf identifier — replaced with ``_`` so a name carried in from
# a non-proto source (an OpenAPI schema name with ``-``/``.``) still compiles. A proto-native name
# is already valid, so sanitizing is a no-op for a round-tripped source.
_NON_IDENT_RE = re.compile(r"[^A-Za-z0-9_]")

# One indent level in emitted proto text (two spaces, matching the fixtures).
_INDENT = "  "


def _package_for_type(type_: Type, types_by_key: Dict[str, Type]) -> str:
    """Return the protobuf ``package`` a canonical type belongs to."""
    parent_key = _parent_key_for_type(type_.key, types_by_key)
    if parent_key is not None:
        return _package_for_type(types_by_key[parent_key], types_by_key)
    if "." in type_.key:
        return type_.key.rsplit(".", 1)[0]
    return ""


def _parent_key_for_type(key: str, types_by_key: Dict[str, Type]) -> Optional[str]:
    """Return the enclosing ``RECORD`` type's key for ``key``, or ``None`` when top-level."""
    if "." not in key:
        return None
    prefix = key.rsplit(".", 1)[0]
    parent = types_by_key.get(prefix)
    if parent is not None and parent.kind == TypeKind.RECORD:
        return prefix
    return None


def _package_for_service(service: Service) -> str:
    """Return the protobuf ``package`` a service belongs to."""
    if "." in service.key:
        return service.key.rsplit(".", 1)[0]
    return ""


def _apply_package_override(
    package: str, api: CanonicalApi, options: ProtoEmitOptions
) -> str:
    """Apply :attr:`ProtoEmitOptions.package` when it overrides the model identity namespace."""
    override = (options.package or "").strip()
    identity = (api.identity.namespace or "").strip()
    if override and package == identity:
        return override
    return package


def _proto_path_for_package(package: str) -> str:
    """Map a proto ``package`` to a deterministic module-relative ``.proto`` path."""
    if not package:
        return "api.proto"
    segments = [_sanitize_identifier(part) or "pkg" for part in package.split(".")]
    stem = segments[-1] or "api"
    if len(segments) == 1:
        return f"{stem}.proto"
    return "/".join(segments[:-1] + [stem]) + ".proto"


def _package_for_type_name(type_name: str, types_by_key: Dict[str, Type]) -> str:
    """Resolve the protobuf ``package`` for a referenced type name."""
    type_ = types_by_key.get(type_name)
    if type_ is not None:
        return _package_for_type(type_, types_by_key)
    if "." in type_name:
        return type_name.rsplit(".", 1)[0]
    return ""


class ProtoEmitOptions(EmitOptions):
    """Per-target options for :class:`ProtoEmitter` (MFX-1.4)."""

    package: Optional[str] = Field(
        default=None,
        description="Override the emitted ``package``. Defaults to the model's identity "
        "namespace; useful for a non-proto source whose model carries none.",
    )
    emit_services: bool = Field(
        default=True,
        description="Emit ``service``/``rpc`` blocks. Disable for a types-only ``.proto``.",
    )
    persisted_field_numbers: Dict[str, int] = Field(
        default_factory=dict,
        description="Pre-loaded stable field numbers keyed by canonical field key (MFX-12.2).",
    )


# Well-known types the emitter uses when a source construct has no faithful proto shape.
_WKT_STRUCT = "google.protobuf.Struct"
_WKT_ANY = "google.protobuf.Any"

# Pub/sub operation kinds the emitter reframes as unary ``rpc`` methods rather than dropping.
_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})


def _union_oneof_eligible(type_: Type) -> bool:
    """Return ``True`` when a ``UNION``'s members are named type refs suitable for a ``oneof``."""
    if not type_.union_members:
        return False
    return all(isinstance(member, str) and member for member in type_.union_members)


def _record_has_inheritance(type_: Type) -> bool:
    """Return ``True`` when a ``RECORD`` carried composition/inheritance the emitter flattens."""
    all_of = type_.extras.get("allOf")
    if isinstance(all_of, list) and all_of:
        return True
    interfaces = type_.extras.get("interfaces")
    return isinstance(interfaces, list) and bool(interfaces)


def _is_arbitrary_json_ref(ref: TypeRef) -> bool:
    """Return ``True`` for a typeless leaf ref (arbitrary JSON) the emitter maps to ``Struct``."""
    return not ref.is_list() and ref.name is None


#: How proto3 itself resolves each Editions feature — the value the emitted document forces.
#: An Editions source that resolved a feature to anything else has made a choice this emitter
#: cannot carry, which is what :meth:`ProtoEmitter._record_editions_downgrade` and
#: :meth:`ProtoEmitter._record_feature_losses` declare.
_PROTO3_FEATURE_VALUES: Dict[str, str] = {
    "field_presence": "IMPLICIT",
    "enum_type": "OPEN",
    "repeated_field_encoding": "PACKED",
    "utf8_validation": "VERIFY",
    "message_encoding": "LENGTH_PREFIXED",
    "json_format": "ALLOW",
}


def _feature_loss_subject(feature_name: str) -> str:
    """The stable ``Loss.subject`` slug for one Editions feature (``editions-feature-…``)."""
    return f"editions-feature-{feature_name.replace('_', '-')}"


def _editions_record(api: CanonicalApi) -> Optional[Dict[str, Any]]:
    """Return the FMT-3.7 Editions provenance record on ``api``, or ``None``.

    Only a model normalized from an ``edition = `` document carries one, so its presence is
    what tells this proto3 emitter that it is *downgrading* a dialect rather than round-tripping
    the one it targets.
    """
    record = api.extras.get(EDITIONS_PROVENANCE_EXTRA_KEY)
    return record if isinstance(record, dict) else None


def _emits_proto3_optional(field: CanonicalField) -> bool:
    """Whether a field should be written with the proto3 ``optional`` label.

    Two sources answer this, and they mean the same thing. A model normalized from proto3
    carries ``extras['proto3_optional']``. A model normalized from an Editions document
    carries ``extras['field_presence']`` instead (FMT-3.7), and its ``EXPLICIT`` fields have
    exactly the presence proto3 spells ``optional`` — so writing them bare would drop presence
    tracking that the source document had, which is a silent semantic downgrade rather than a
    stylistic one.

    ``LEGACY_REQUIRED`` is deliberately **not** emitted as ``optional``: proto3 cannot enforce
    requiredness at all, and labelling a required field ``optional`` would state the opposite of
    the source. :meth:`ProtoEmitter` records that as a loss instead.

    Args:
        field: The canonical field being written.

    Returns:
        ``True`` when the declaration takes the ``optional`` prefix.
    """
    if field.extras.get("proto3_optional"):
        return True
    return field.extras.get(FIELD_PRESENCE_EXTRA_KEY) == FIELD_PRESENCE_EXPLICIT


class ProtoFidelityRulePack(CapabilityRulePack):
    """Reference fidelity rule pack for the proto3 target — MFX-12.3 (#3881).

    The predictive counterpart to :class:`ProtoEmitter`: refines the profile-derived
    default wherever protobuf's six-axis :class:`~app.emitter.CapabilityProfile` is too
    coarse to describe how a construct actually degrades. It runs against the source
    :class:`~app.canonical_model.CanonicalApi` alone (never the emitted ``.proto``), so
    the fidelity advisory can predict an OpenAPI/GraphQL → protobuf export's losses
    without emitting, and its verdicts line up construct-for-construct with the
    :class:`~app.emitter.Loss`\\es :class:`ProtoEmitter` records at emit time.

    Protobuf's profile advertises ``unions=False`` and ``nullability=True``, which hides
    several honest losses the emitter still incurs:

    * **discriminated unions** — emitted as a message wrapping a ``oneof`` when member
      shapes allow, otherwise approximated as :data:`_WKT_ANY` (``APPROX``, not a silent
      ``DROP``);
    * **nullability / requiredness** — proto3 ``optional`` carries presence, not JSON Schema
      nullability or ``required`` enforcement (``APPROX``);
    * **validation constraints** — demoted to doc comments (``APPROX``);
    * **inheritance / ``allOf`` / GraphQL interfaces** — flattened into one message (
      ``APPROX``);
    * **arbitrary JSON** — mapped to :data:`_WKT_STRUCT` (``APPROX``);
    * **field numbers** — synthesized when the source lacks them (``SYNTH``, MFX-12.2).

    Native pub/sub operations are reframed as unary ``rpc`` methods (``APPROX``), not the
    capability default's critical ``DROP``.
    """

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Reframe pub/sub operations the emitter carries as unary ``rpc`` methods."""
        if operation.kind in _EVENT_OPERATION_KINDS:
            return FidelityVerdict.approx(
                message=f"{self.target_label} has no pub/sub semantics; the "
                f"{operation.kind.value!r} operation is reframed as a unary rpc",
                target_mapping="pub/sub action → unary rpc",
            )
        return super().operation_verdict(operation)

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Dispatch named types, refining unions and flattened inheritance."""
        if type_.kind is TypeKind.UNION:
            return self._union_verdict(type_)
        if type_.kind is TypeKind.RECORD and _record_has_inheritance(type_):
            return FidelityVerdict.approx(
                message=f"{self.target_label} has no inheritance; "
                f"{type_.key!r} is flattened into a single message",
                target_mapping="inheritance/allOf → flattened message fields",
            )
        return super().type_verdict(type_)

    def _union_verdict(self, type_: Type) -> FidelityVerdict:
        """``APPROX`` a union as ``oneof`` when eligible, otherwise as ``google.protobuf.Any``."""
        if _union_oneof_eligible(type_):
            return FidelityVerdict.approx(
                message=f"{self.target_label} has no first-class union type; "
                f"{type_.key!r} is emitted as a message wrapping a oneof",
                target_mapping="union/oneOf → message wrapping oneof",
            )
        return FidelityVerdict.approx(
            message=f"{self.target_label} cannot represent the union shape; "
            f"{type_.key!r} is approximated as google.protobuf.Any with notes",
            target_mapping=f"union → {_WKT_ANY}",
        )

    def field_verdicts(self, field: CanonicalField) -> List[FidelityVerdict]:
        """Collect every independent loss one record field incurs."""
        verdicts = super().field_verdicts(field)
        arbitrary = self._arbitrary_json_verdict(field)
        if arbitrary is not None:
            verdicts.append(arbitrary)
        return verdicts

    def _nullability_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """Report nullability/requiredness losses proto3 ``optional`` cannot enforce."""
        if field.extras.get("proto3_optional"):
            return None
        if field.type.nullable is False:
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot enforce a non-null/required guarantee; "
                "the field is emitted without proto3 ``required`` semantics",
                target_mapping="required/non-null → proto3 field (presence not enforced)",
            )
        return FidelityVerdict.approx(
            message=f"{self.target_label} maps nullable fields to proto3 ``optional`` "
            "presence, not JSON nullability",
            target_mapping="nullable → proto3 optional",
        )

    def _constraints_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """Demote validation constraints to documentation comments."""
        if not _has_any_constraint(field.constraints):
            return None
        return FidelityVerdict.approx(
            message=f"{self.target_label} cannot enforce validation constraints; "
            "they are demoted to documentation comments",
            target_mapping="constraints → doc comment",
        )

    def _scalar_verdict(self, type_: Type) -> FidelityVerdict:
        """Demote a scalar type's constraints to documentation comments."""
        if _has_any_constraint(type_.constraints):
            return FidelityVerdict.approx(
                message=f"{self.target_label} cannot enforce validation constraints; "
                "they are demoted to documentation comments",
                target_mapping="constraints → doc comment",
            )
        return FidelityVerdict.ok(message=f"scalar carried to {self.target_label}")

    def _arbitrary_json_verdict(
        self, field: CanonicalField
    ) -> Optional[FidelityVerdict]:
        """Approximate a typeless JSON value as ``google.protobuf.Struct``."""
        if not _is_arbitrary_json_ref(field.type):
            return None
        return FidelityVerdict.approx(
            message=f"{self.target_label} has no arbitrary JSON type; "
            f"{field.key!r} is approximated as {_WKT_STRUCT}",
            target_mapping=f"arbitrary JSON → {_WKT_STRUCT}",
        )


class ProtoEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as proto3 ``.proto`` source with provenance.

    Self-registers under ``proto3``. Primarily targets the RPC paradigm (a protobuf source is an
    exact fixed point of ``normalize ∘ emit``); a non-RPC model is emitted best-effort with the
    constructs proto3 cannot carry recorded as :class:`~app.emitter.Loss`\\es.
    """

    key = "protobuf"
    format = "proto3"
    label = "Protocol Buffers (proto3)"
    description = "Export as a Protocol Buffers 3 .proto (gRPC services + messages)."
    icon = "binary"
    paradigm = ApiParadigm.RPC
    multi_file = True
    options_model = ProtoEmitOptions

    #: Primary bundle media type for ``.proto`` source text.
    OUTPUT_MEDIA_TYPE = "text/x-protobuf"
    #: The syntax this emitter targets (proto3 ``optional`` presence is the acceptance criterion).
    SYNTAX = "proto3"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Protobuf carries RPC operations, typed messages/enums, presence, and field identity.

        ``unions`` is ``False`` (proto has no first-class union type — a ``UNION`` is approximated
        as a message wrapping a ``oneof``) and ``constraints`` is ``False`` (proto has no native
        validation facets). ``field_identity`` is ``True`` — stable field numbers are protobuf's
        signature strength. The gRPC fidelity pack (MFX-12.3) refines these predictions.
        """
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=False,
            nullability=True,
            constraints=False,
            field_identity=True,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[ProtoFidelityRulePack]:
        """Return the reference protobuf fidelity rule pack (MFX-12.3)."""
        return ProtoFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[ProtoEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as a proto3 ``.proto`` document with per-construct provenance.

        Args:
            api: The canonical model to convert.
            opts: Optional emit options. Defaults apply when omitted.

        Returns:
            An :class:`~app.emitter.EmitResult` whose primary file is proto3 source text, whose
            ``provenance`` records where each construct came from, and whose ``losses`` enumerate
            the constructs proto3 could not carry faithfully. The output is deterministic for a
            given ``api``.
        """
        options = (
            opts
            if isinstance(opts, ProtoEmitOptions)
            else ProtoEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        return _ProtoBundleWriter(api, options).emit()


class _ProtoBundleWriter:
    """Orchestrates one ``.proto`` file per protobuf ``package`` (MFX-12.4)."""

    def __init__(self, api: CanonicalApi, options: ProtoEmitOptions) -> None:
        self._api = api
        self._options = options
        self._types_by_key: Dict[str, Type] = {t.key: t for t in api.types}
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self.field_identity_assignments: Dict[str, int] = {}

    def _collect_packages(self) -> List[str]:
        packages: Dict[str, None] = {}
        for type_ in self._api.types:
            if type_.kind in (TypeKind.RECORD, TypeKind.ENUM, TypeKind.UNION):
                pkg = _apply_package_override(
                    _package_for_type(type_, self._types_by_key), self._api, self._options
                )
                packages[pkg] = None
        if self._options.emit_services:
            for service in self._api.services:
                pkg = _apply_package_override(
                    _package_for_service(service), self._api, self._options
                )
                packages[pkg] = None
        if not packages:
            primary = _apply_package_override(
                (self._options.package or self._api.identity.namespace or "").strip(),
                self._api,
                self._options,
            )
            packages[primary] = None
        return sorted(packages.keys())

    def emit(self) -> EmitResult:
        packages = self._collect_packages()
        package_paths = {pkg: _proto_path_for_package(pkg) for pkg in packages}
        files: List[EmittedFile] = []
        for pkg in packages:
            writer = _ProtoWriter(
                self._api,
                self._options,
                package=pkg,
                package_paths=package_paths,
                tracker=self.tracker,
                losses=self.losses,
            )
            files.append(
                EmittedFile(
                    path=package_paths[pkg],
                    content=writer.render(),
                    media_type=ProtoEmitter.OUTPUT_MEDIA_TYPE,
                )
            )
            self.field_identity_assignments.update(writer.field_identity_assignments)
        return EmitResult(
            files=files,
            media_type=ProtoEmitter.OUTPUT_MEDIA_TYPE,
            provenance=self.tracker.records(),
            losses=self.losses.records(),
            field_identity_assignments=self.field_identity_assignments,
        )


class _ProtoWriter:
    """One-shot proto3 renderer for a single :class:`CanonicalApi` (internal to the emitter).

    Holds the per-emission state — the type index, the reconstructed nesting tree, the set of
    imports discovered while rendering references, and the provenance/loss trackers — so the
    emitter's :meth:`ProtoEmitter.emit` stays a thin, stateless entry point.
    """

    def __init__(
        self,
        api: CanonicalApi,
        options: ProtoEmitOptions,
        *,
        package: str,
        package_paths: Dict[str, str],
        tracker: ProvenanceTracker,
        losses: LossTracker,
    ) -> None:
        self._api = api
        self._options = options
        self.tracker = tracker
        self.losses = losses

        self._package = package
        self._package_paths = package_paths
        self._types_by_key: Dict[str, Type] = {t.key: t for t in api.types}
        self._local_keys = {
            t.key
            for t in api.types
            if _apply_package_override(
                _package_for_type(t, self._types_by_key), api, options
            )
            == self._package
        }
        # Types that become their own top-level/nested declaration: RECORD, ENUM, and (best-effort)
        # UNION. MAP types are inlined at the referencing field as ``map<K,V>`` and never emitted
        # standalone; SCALAR/ALIAS types have no proto declaration.
        self._emittable = [
            t
            for t in api.types
            if t.kind in (TypeKind.RECORD, TypeKind.ENUM, TypeKind.UNION)
            and t.key in self._local_keys
        ]
        self._emittable_keys = {t.key for t in self._emittable}
        self._children = self._build_nesting()
        self._imports: set[str] = set()
        self.field_identity_assignments: Dict[str, int] = {}

    def _is_local(self, key: str) -> bool:
        """True when ``key`` is defined in this file's package."""
        return key in self._local_keys

    @property
    def output_path(self) -> str:
        """The emitted filename for this writer's package."""
        return self._package_paths[self._package]

    # --- nesting reconstruction --------------------------------------------

    def _build_nesting(self) -> Dict[Optional[str], List[Type]]:
        """Group emittable types by their parent's key, reconstructing message nesting.

        A type keyed ``pkg.Outer.Inner`` nests inside ``pkg.Outer`` when that parent is itself an
        emitted ``RECORD``; otherwise it is top-level (its parent prefix is the package, or the
        parent is not a message). Returns ``{parent_key_or_None: [child types in model order]}``.
        """
        children: Dict[Optional[str], List[Type]] = {}
        for type_ in self._emittable:
            parent = self._parent_key(type_.key)
            children.setdefault(parent, []).append(type_)
        return children

    def _parent_key(self, key: str) -> Optional[str]:
        """Return the enclosing RECORD type's key for ``key``, or ``None`` when top-level."""
        return _parent_key_for_type(key, self._types_by_key)

    # --- top-level render ---------------------------------------------------

    def render(self) -> str:
        """Render the whole ``.proto`` document as text."""
        body: List[str] = []

        for type_ in self._children.get(None, []):
            body.extend(self._render_type(type_, level=0))
            body.append("")

        if self._options.emit_services:
            for service in self._api.services:
                service_pkg = _apply_package_override(
                    _package_for_service(service), self._api, self._options
                )
                if service_pkg != self._package:
                    continue
                body.extend(self._render_service(service))
                body.append("")
        elif self._api.services:
            self.losses.record(
                LossKind.NA,
                "emit-services-disabled",
                "Service/rpc emission was disabled by options; the source's services were omitted.",
            )

        # The header (syntax/package/imports) is assembled last: imports are only known once every
        # reference has been rendered.
        header = self._render_header()
        lines = header + [""] + body
        # Trim a trailing run of blank lines to a single terminating newline (determinism).
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines) + "\n"

    def _render_header(self) -> List[str]:
        """Render ``syntax``, ``package``, and the discovered ``import`` lines."""
        lines = [f'syntax = "{ProtoEmitter.SYNTAX}";']
        self.tracker.record("/syntax", Provenance.DEFAULT, "emitter targets proto3")
        self._record_editions_downgrade()
        if self._package:
            lines.append("")
            lines.append(f"package {self._package};")
            self.tracker.record("/package", Provenance.SOURCE)
        for path in sorted(self._imports):
            # The first import gets a preceding blank line for readability.
            if lines[-1] != "":
                lines.append("")
            lines.append(f'import "{path}";')
        return lines

    def _record_editions_downgrade(self) -> None:
        """Declare, as explicit losses, what writing proto3 costs an Editions source.

        FMT-3.7 asks the emitter either to grow an edition output mode or to *declare the loss
        explicitly*. This is that declaration. A proto3 document cannot say ``edition``, so the
        dialect is gone the moment the header is written; what matters is that every feature the
        source resolved away from the value proto3 forces is named, once, rather than
        disappearing quietly.

        Losses are recorded at the scope the choice was made at, so a reader can act on them.
        This method covers the **file-level** settings; a message, enum or field that narrowed
        a feature further reports its own through :meth:`_record_feature_losses`, and
        ``field_presence = LEGACY_REQUIRED`` reports on the field that carries it (see
        :meth:`_render_field`).

        Presence itself is otherwise **not** a loss: an ``EXPLICIT`` field is emitted with the
        proto3 ``optional`` label and an ``IMPLICIT`` one bare, which preserves the source's
        presence semantics exactly (see :func:`_emits_proto3_optional`).
        """
        record = _editions_record(self._api)
        if record is None:
            return

        editions = record.get("editions")
        editions_label = ", ".join(editions) if isinstance(editions, list) and editions else "?"
        self.losses.record(
            LossKind.NA,
            "editions-dialect",
            f"The source is a Protobuf Editions document (edition {editions_label}); this "
            "emitter writes proto3, so the `edition` declaration and the per-scope `features` "
            "options are not reproduced.",
        )

        files = record.get("files")
        if not isinstance(files, list):
            return
        # Reported once per (feature, value) across the whole set, sorted, so a fileset does not
        # produce one identical loss per member.
        overridden: Dict[str, set] = {}
        for entry in files:
            if not isinstance(entry, dict) or entry.get("syntax") != "editions":
                continue
            features = entry.get("features")
            if not isinstance(features, dict):
                continue
            for name, value in features.items():
                forced = _PROTO3_FEATURE_VALUES.get(name)
                # ``field_presence`` is carried per field, not lost at document scope.
                if name == "field_presence" or forced is None or value == forced:
                    continue
                overridden.setdefault(name, set()).add(value)

        for name in sorted(overridden):
            for value in sorted(overridden[name]):
                self.losses.record(
                    LossKind.NA,
                    _feature_loss_subject(name),
                    f"The source resolved '{name} = {value}'; proto3 fixes it at "
                    f"'{_PROTO3_FEATURE_VALUES[name]}', so that choice is not reproduced.",
                )

    def _record_feature_losses(self, extras: Dict[str, Any], pointer: str, subject: str) -> None:
        """Declare the Editions features one entity narrowed that proto3 cannot express.

        The normalizer records a feature at the scope that set it and only where the value
        deviates from its file's (FMT-3.7), so this reads exactly the choices the entity made
        for itself — a message that opted into ``json_format = LEGACY_BEST_EFFORT``, a field
        that opted into ``message_encoding = DELIMITED``. Anything already covered by the
        file-level statement is not repeated here.

        Args:
            extras: The entity's ``extras`` bag.
            pointer: The entity's canonical key, recorded on each loss.
            subject: Human label for the entity kind, used in the message.
        """
        features = extras.get(FEATURES_EXTRA_KEY)
        if not isinstance(features, dict):
            return
        for name in sorted(features):
            value = features[name]
            forced = _PROTO3_FEATURE_VALUES.get(name)
            if forced is None or value == forced:
                continue
            self.losses.record(
                LossKind.NA,
                _feature_loss_subject(name),
                f"{subject} {pointer!r} resolved '{name} = {value}'; proto3 fixes it at "
                f"'{forced}', so that choice is not reproduced.",
                pointer=pointer,
            )

    # --- types --------------------------------------------------------------

    def _render_type(self, type_: Type, *, level: int) -> List[str]:
        """Render one emittable type (message / enum / union) at ``level`` indentation."""
        if type_.kind == TypeKind.ENUM:
            return self._render_enum(type_, level=level)
        if type_.kind == TypeKind.UNION:
            return self._render_union(type_, level=level)
        return self._render_message(type_, level=level)

    def _render_message(self, type_: Type, *, level: int) -> List[str]:
        """Render a ``RECORD`` type as a ``message`` block, recursing into nested types."""
        pad = _INDENT * level
        name = _sanitize_identifier(type_.name)
        lines = _comment(type_.description, pad)
        lines.append(f"{pad}message {name} {{")
        self.tracker.record(ProvenanceTracker.child("/messages", type_.key), Provenance.SOURCE)

        self._record_feature_losses(type_.extras, type_.key, "Message")

        inner = _INDENT * (level + 1)
        if type_.deprecated:
            lines.append(f"{inner}option deprecated = true;")

        lines.extend(self._render_reserved(type_, inner, enum=False))

        # Nested messages/enums come first (matches protoc's textual convention), then fields.
        for child in self._children.get(type_.key, []):
            lines.extend(self._render_type(child, level=level + 1))

        lines.extend(self._render_fields(type_, inner))
        lines.append(f"{pad}}}")
        return lines

    def _render_fields(self, type_: Type, pad: str) -> List[str]:
        """Render a record's fields, grouping ``oneof`` members and synthesizing missing numbers."""
        lines: List[str] = []
        counter = FieldNumberAllocator(
            type_, persisted=self._options.persisted_field_numbers
        )
        declared_oneofs: List[str] = [
            _sanitize_identifier(name) for name in type_.extras.get("oneofs", [])
        ]
        emitted_oneofs: set[str] = set()

        for field in type_.fields:
            oneof = field.extras.get("oneof")
            if isinstance(oneof, str) and oneof:
                safe = _sanitize_identifier(oneof)
                if safe in emitted_oneofs:
                    continue  # already rendered with the group at its first member's position
                emitted_oneofs.add(safe)
                lines.extend(self._render_oneof(type_, safe, oneof, pad, counter))
                continue
            lines.append(self._render_field(type_, field, pad, counter))

        # A declared oneof whose members somehow never appeared still deserves an empty block so the
        # declaration survives; in practice every declared oneof has members.
        for name in declared_oneofs:
            if name not in emitted_oneofs:
                lines.append(f"{pad}oneof {name} {{")
                lines.append(f"{pad}}}")
        self.field_identity_assignments.update(counter.new_assignments)
        return lines

    def _render_oneof(
        self,
        type_: Type,
        safe_name: str,
        source_name: str,
        pad: str,
        counter: FieldNumberAllocator,
    ) -> List[str]:
        """Render a ``oneof`` block with every member field of ``source_name``."""
        inner = pad + _INDENT
        lines = [f"{pad}oneof {safe_name} {{"]
        for field in type_.fields:
            if field.extras.get("oneof") == source_name:
                lines.append(self._render_field(type_, field, inner, counter, in_oneof=True))
        lines.append(f"{pad}}}")
        return lines

    def _render_field(
        self,
        type_: Type,
        field: CanonicalField,
        pad: str,
        counter: FieldNumberAllocator,
        *,
        in_oneof: bool = False,
    ) -> str:
        """Render one message field: ``[repeated|optional] <type> name = N [options];``.

        Returns a single string that may span multiple lines when the field carries a description
        comment.
        """
        pointer = ProvenanceTracker.child("/messages", type_.key, "fields", field.name)
        name = _sanitize_identifier(field.name)
        number, synthesized = counter.allocate(field)
        if synthesized:
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-field-number",
                f"Field {field.key!r} had no source field number; assigned {number}.",
                pointer=field.key,
            )
            self.tracker.record(pointer, Provenance.INFERRED, "synthesized field number")
        else:
            self.tracker.record(pointer, Provenance.SOURCE)

        if field.constraints is not None:
            self.losses.record(
                LossKind.NA,
                "field-constraints",
                f"Protobuf has no validation facets; {field.key!r} constraints were dropped.",
                pointer=field.key,
            )
        if field.default is not None:
            self.losses.record(
                LossKind.NA,
                "proto3-default",
                f"proto3 has no field defaults; the default on {field.key!r} was dropped.",
                pointer=field.key,
            )

        type_expr, prefix = self._field_type_expr(field, pointer)
        # A ``oneof`` member cannot carry ``repeated``/``optional``/``map`` labels; those shapes are
        # not expressible inside a oneof, so the label is dropped (the type stays).
        if in_oneof and prefix:
            self.losses.record(
                LossKind.NA,
                "oneof-member-label",
                f"A oneof member cannot be {prefix.strip()!r}; the label on {field.key!r} was dropped.",
                pointer=field.key,
            )
            prefix = ""

        if field.extras.get(FIELD_PRESENCE_EXTRA_KEY) == FIELD_PRESENCE_LEGACY_REQUIRED:
            # proto3 removed ``required`` outright, so the one presence mode this emitter
            # cannot express is the one that changes what a *reader* must accept. Emitting the
            # field bare is the only legal output; saying so is what keeps it from being silent.
            self.losses.record(
                LossKind.NA,
                "editions-legacy-required",
                f"proto3 has no 'required'; the Editions 'field_presence = LEGACY_REQUIRED' "
                f"on {field.key!r} was dropped and the field is emitted as singular.",
                pointer=field.key,
            )
        self._record_feature_losses(field.extras, field.key, "Field")

        options = " [deprecated = true]" if field.deprecated else ""
        decl = f"{pad}{prefix}{type_expr} {name} = {number}{options};"
        comment = _comment(field.description, pad)
        return "\n".join([*comment, decl]) if comment else decl

    def _field_type_expr(
        self, field: CanonicalField, pointer: str
    ) -> Tuple[str, str]:
        """Return ``(type_expression, label_prefix)`` for a field's type.

        The prefix is ``"repeated "``, ``"optional "``, or ``""``. A ``map<K,V>`` field's whole
        shape lives in the type expression, so its prefix is empty.
        """
        ref = field.type
        # A reference to a MAP type becomes a ``map<K,V>`` (the entry message is never emitted).
        if not ref.is_list() and ref.name is not None:
            target = self._types_by_key.get(ref.name)
            if target is not None and target.kind == TypeKind.MAP:
                return self._map_expr(target, pointer), ""

        if ref.is_list():
            element = ref.item
            # proto has no nested-list type; a list-of-lists is flattened to a single ``repeated``
            # of the innermost element and recorded as a loss.
            depth = 0
            while element is not None and element.is_list():
                element = element.item
                depth += 1
            if depth:
                self.losses.record(
                    LossKind.INFERRED,
                    "nested-list",
                    f"Protobuf has no nested-list type; {field.key!r} was flattened to one "
                    "``repeated`` level.",
                    pointer=field.key,
                )
            expr = self._leaf_expr(element) if element is not None else "bytes"
            return expr, "repeated "

        prefix = "optional " if _emits_proto3_optional(field) else ""
        return self._leaf_expr(ref), prefix

    def _map_expr(self, map_type: Type, pointer: str) -> str:
        """Render a ``MAP`` type as ``map<key, value>`` from its key/value refs."""
        key_expr = self._leaf_expr(map_type.key_type) if map_type.key_type else "string"
        value_expr = self._leaf_expr(map_type.value_type) if map_type.value_type else "string"
        return f"map<{key_expr}, {value_expr}>"

    def _leaf_expr(self, ref: Optional[TypeRef]) -> str:
        """Render a leaf (non-list) type reference: a proto scalar or a qualified type name."""
        if ref is None or not ref.name:
            return "bytes"
        name = ref.name
        if name in _PROTO_SCALARS:
            return name
        # A named type: local (emitted in this file) or imported from a sibling package / WKT.
        if name not in self._emittable_keys:
            self._note_import(name)
        return f".{name}"

    def _note_import(self, type_name: str) -> None:
        """Add the ``import`` for a referenced non-local type, or record an unresolved-import loss."""
        path = _WKT_IMPORTS.get(type_name)
        if path is not None:
            self._imports.add(path)
            return
        sibling_pkg = _package_for_type_name(type_name, self._types_by_key)
        if sibling_pkg and sibling_pkg != self._package:
            sibling_path = self._package_paths.get(sibling_pkg)
            if sibling_path is not None:
                self._imports.add(sibling_path)
                return
        self.losses.record(
            LossKind.NA,
            "unresolved-import",
            f"Referenced type {type_name!r} has no local definition and no known import path; "
            "the emitted document is not self-contained for it.",
            pointer=type_name,
        )

    def _render_reserved(self, type_: Type, pad: str, *, enum: bool) -> List[str]:
        """Render ``reserved`` number ranges and names from a type's ``extras``.

        Message reserved ranges are stored half-open ``[start, end)`` and rendered inclusive
        (``start to end-1``); enum ranges are already inclusive (``start to end``).
        """
        lines: List[str] = []
        ranges = type_.extras.get("reserved_ranges") or []
        tokens: List[str] = []
        for pair in ranges:
            try:
                start, end = int(pair[0]), int(pair[1])
            except (TypeError, ValueError, IndexError):
                continue
            last = end if enum else end - 1
            if last >= _PROTO_MAX_FIELD_NUMBER and not enum:
                tokens.append(f"{start} to max")
            elif last <= start:
                tokens.append(str(start))
            else:
                tokens.append(f"{start} to {last}")
        if tokens:
            lines.append(f"{pad}reserved {', '.join(tokens)};")
        names = type_.extras.get("reserved_names") or []
        if names:
            quoted = ", ".join(f'"{n}"' for n in names)
            lines.append(f"{pad}reserved {quoted};")
        return lines

    # --- enums --------------------------------------------------------------

    def _render_enum(self, type_: Type, *, level: int) -> List[str]:
        """Render an ``ENUM`` type, guaranteeing a proto3-legal zero value first."""
        pad = _INDENT * level
        inner = _INDENT * (level + 1)
        name = _sanitize_identifier(type_.name)
        lines = _comment(type_.description, pad)
        lines.append(f"{pad}enum {name} {{")
        self.tracker.record(ProvenanceTracker.child("/enums", type_.key), Provenance.SOURCE)
        self._record_feature_losses(type_.extras, type_.key, "Enum")
        if type_.extras.get(ENUM_CLOSED_EXTRA_KEY) is True:
            # proto3 enums are always open, so a closed enum's defining property — that an
            # unrecognised number does not parse into it — is gone from the emitted document.
            self.losses.record(
                LossKind.NA,
                _feature_loss_subject("enum_type"),
                f"Enum {type_.key!r} is closed; proto3 enums are always open, so the "
                "rejection of unrecognised values is not reproduced.",
                pointer=type_.key,
            )

        if type_.deprecated:
            lines.append(f"{inner}option deprecated = true;")
        if type_.extras.get("allow_alias"):
            lines.append(f"{inner}option allow_alias = true;")
        lines.extend(self._render_reserved(type_, inner, enum=True))

        for value_line in self._enum_value_lines(type_, inner):
            lines.append(value_line)
        lines.append(f"{pad}}}")
        return lines

    def _enum_value_lines(self, type_: Type, pad: str) -> List[str]:
        """Render enum value lines, ordering/synthesizing so the first value is ``0`` (proto3)."""
        numbers = _resolved_enum_numbers(type_.enum_values)
        if numbers is None:
            # One or more values lacked a wire number: assign 0-based indices in declaration order.
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-enum-number",
                f"Enum {type_.key!r} had values without wire numbers; assigned 0-based indices.",
                pointer=type_.key,
            )
            ordered = list(enumerate(type_.enum_values))
        else:
            ordered = list(zip(numbers, type_.enum_values))
            # proto3 requires the first listed value to be zero: float a zero-numbered value to the
            # front, or synthesize one when the source has none.
            zero_index = next((i for i, (n, _) in enumerate(ordered) if n == 0), None)
            if zero_index is None:
                unspecified = f"{_screaming_snake(type_.name)}_UNSPECIFIED"
                self.losses.record(
                    LossKind.INFERRED,
                    "synthesized-enum-zero",
                    f"Enum {type_.key!r} had no zero value; a proto3-required {unspecified} = 0 "
                    "was synthesized.",
                    pointer=type_.key,
                )
                return [
                    f"{pad}{unspecified} = 0;",
                    *[f"{pad}{_sanitize_identifier(v.name)} = {n};" for n, v in ordered],
                ]
            if zero_index != 0:
                ordered.insert(0, ordered.pop(zero_index))

        return [f"{pad}{_sanitize_identifier(v.name)} = {n};" for n, v in ordered]

    # --- unions (best-effort) ----------------------------------------------

    def _render_union(self, type_: Type, *, level: int) -> List[str]:
        """Render a ``UNION`` type best-effort as a message wrapping a single ``oneof``.

        Protobuf has no first-class union, so this is an approximation the loss records.
        """
        pad = _INDENT * level
        inner = _INDENT * (level + 1)
        member_pad = inner + _INDENT
        name = _sanitize_identifier(type_.name)
        self.losses.record(
            LossKind.INFERRED,
            "union-as-oneof",
            f"Protobuf has no union type; {type_.key!r} was emitted as a message wrapping a oneof.",
            pointer=type_.key,
        )
        self.tracker.record(
            ProvenanceTracker.child("/messages", type_.key),
            Provenance.INFERRED,
            "union approximated as a oneof-bearing message",
        )
        lines = _comment(type_.description, pad)
        lines.append(f"{pad}message {name} {{")
        lines.append(f"{inner}oneof value {{")
        for number, member_key in enumerate(type_.union_members, start=1):
            member = self._types_by_key.get(member_key)
            member_name = member.name if member is not None else member_key.rsplit(".", 1)[-1]
            field_name = _snake_case(member_name) or f"option_{number}"
            lines.append(f"{member_pad}.{member_key} {field_name} = {number};")
        lines.append(f"{inner}}}")
        lines.append(f"{pad}}}")
        return lines

    # --- services / rpc -----------------------------------------------------

    def _render_service(self, service: Service) -> List[str]:
        """Render a ``service`` block with one ``rpc`` per operation."""
        name = _sanitize_identifier(service.name)
        lines = _comment(service.description, "")
        lines.append(f"service {name} {{")
        self.tracker.record(ProvenanceTracker.child("/services", service.key), Provenance.SOURCE)
        for operation in service.operations:
            lines.extend(self._render_rpc(service, operation))
        lines.append("}")
        return lines

    def _render_rpc(self, service: Service, operation: Operation) -> List[str]:
        """Render one ``rpc`` method, restoring streaming, idempotency, and deprecation."""
        pointer = ProvenanceTracker.child("/services", service.key, "methods", operation.name)
        name = _sanitize_identifier(operation.name)
        request_type, response_type = self._rpc_message_types(operation)

        req_stream = "stream " if operation.streaming in _STREAM_REQUEST else ""
        resp_stream = "stream " if operation.streaming in _STREAM_RESPONSE else ""
        self.tracker.record(pointer, Provenance.SOURCE)

        signature = (
            f"{_INDENT}rpc {name} ({req_stream}.{request_type}) "
            f"returns ({resp_stream}.{response_type})"
        )

        method_options = self._rpc_options(operation)
        comment = _comment(operation.description, _INDENT)
        if method_options:
            body = [f"{signature} {{", *method_options, f"{_INDENT}}}"]
        else:
            body = [f"{signature};"]
        return [*comment, *body]

    def _rpc_message_types(self, operation: Operation) -> Tuple[str, str]:
        """Resolve an operation's request/response message type keys (proto needs both).

        Reads the request payload from a REQUEST/EVENT message and the response payload from a
        RESPONSE message; a source with no response (a one-way/event operation) gets
        ``google.protobuf.Empty`` and a recorded loss, since every proto ``rpc`` returns a message.
        """
        request_type: Optional[str] = None
        response_type: Optional[str] = None
        for message in operation.messages:
            payload = message.payload.name if message.payload else None
            if payload is None:
                continue
            role = message.role.value
            if role in ("request", "event") and request_type is None:
                request_type = payload
            elif role in ("response", "error") and response_type is None:
                response_type = payload

        if operation.kind.value in ("publish", "subscribe"):
            self.losses.record(
                LossKind.NA,
                "event-operation",
                f"Protobuf has no pub/sub; event operation {operation.key!r} was emitted as a "
                "unary rpc.",
                pointer=operation.key,
            )

        if request_type is None:
            request_type = _EMPTY_TYPE
            self._note_import(_EMPTY_TYPE)
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-request",
                f"Operation {operation.key!r} had no request message; used {_EMPTY_TYPE}.",
                pointer=operation.key,
            )
        else:
            self._register_reference(request_type)
        if response_type is None:
            response_type = _EMPTY_TYPE
            self._note_import(_EMPTY_TYPE)
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-response",
                f"Operation {operation.key!r} had no response message; used {_EMPTY_TYPE}.",
                pointer=operation.key,
            )
        else:
            self._register_reference(response_type)
        return request_type, response_type

    def _register_reference(self, type_name: str) -> None:
        """Note the import for an rpc request/response type when it is not local to this file."""
        if type_name in _PROTO_SCALARS or type_name in self._emittable_keys:
            return
        self._note_import(type_name)

    def _rpc_options(self, operation: Operation) -> List[str]:
        """Render an rpc's method options (``idempotency_level``, ``deprecated``)."""
        inner = _INDENT * 2
        options: List[str] = []
        idempotency = operation.extras.get("idempotency_level")
        constant = _IDEMPOTENCY_OPTIONS.get(idempotency) if isinstance(idempotency, str) else None
        if constant is not None:
            options.append(f"{inner}option idempotency_level = {constant};")
        if operation.deprecated:
            options.append(f"{inner}option deprecated = true;")
        return options


# ===========================================================================
# Module-level helpers (pure)
# ===========================================================================


def _resolved_enum_numbers(values: Sequence[EnumValue]) -> Optional[List[int]]:
    """Return each value's integer wire number, or ``None`` when any value lacks one.

    A protobuf enum always has integer numbers; a value with a non-integer (or absent) ``value``
    signals a non-proto source, for which the caller assigns 0-based indices instead.
    """
    numbers: List[int] = []
    for value in values:
        if isinstance(value.value, bool) or not isinstance(value.value, int):
            return None
        numbers.append(value.value)
    return numbers


def _comment(text: Optional[str], pad: str) -> List[str]:
    """Render an optional description as ``//`` comment lines at ``pad`` indentation."""
    if not text:
        return []
    return [f"{pad}// {line}" for line in text.splitlines()]


def _sanitize_identifier(name: str) -> str:
    """Coerce ``name`` to a legal protobuf identifier (``[A-Za-z_][A-Za-z0-9_]*``).

    Invalid characters become ``_`` and a leading digit is prefixed with ``_``. A proto-native
    name is already valid, so this is a no-op for a round-tripped source.
    """
    if not name:
        return "_"
    sanitized = _NON_IDENT_RE.sub("_", name)
    if sanitized[0].isdigit():
        sanitized = f"_{sanitized}"
    return sanitized


def _snake_case(name: str) -> str:
    """Lower-snake-case a type name for use as a synthesized field name (``UserId`` → ``user_id``)."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    return _sanitize_identifier(spaced.lower())


def _screaming_snake(name: str) -> str:
    """Upper-snake-case a name for a synthesized enum constant (``Role`` → ``ROLE``)."""
    return _snake_case(name).upper()


async def compile_emitted_descriptor_set(
    api: CanonicalApi,
    *,
    opts: Optional[ProtoEmitOptions] = None,
):
    """Emit ``api`` to proto3 and compile it to a ``FileDescriptorSet`` via ``buf`` (optional).

    The Emitter SPI's :meth:`ProtoEmitter.emit` is pure text (no I/O); this convenience pairs it
    with :func:`app.proto_descriptor.compile_proto_descriptor_set` to produce the optional binary
    ``FileDescriptorSet`` the ticket calls out — proving the emitted ``.proto`` compiles and
    yielding the descriptor a packaging step (MFX-12.3) can serve.

    Args:
        api: The canonical model to emit and compile.
        opts: Optional emit options forwarded to :meth:`ProtoEmitter.emit`.

    Returns:
        The :class:`~app.proto_descriptor.CompiledDescriptorSet` ``buf`` produced.

    Raises:
        app.proto_descriptor.ProtoCompileError: When ``buf`` is unavailable or the emitted
            document does not compile (its diagnostics carry the compiler errors).
    """
    from .proto_descriptor import ProtoFile, compile_proto_descriptor_set

    result = ProtoEmitter().emit(api, opts=opts)
    proto_files = [
        ProtoFile(path=f.path, content=str(f.content)) for f in result.files
    ]
    return await compile_proto_descriptor_set(proto_files)
