"""Kafka Connect emitter: canonical model → Connect schema JSON — FMT-5.3 (#5441).

The inverse of :class:`app.kafka_connect_normalizer.KafkaConnectNormalizer` and an
implementation of the :class:`app.emitter.Emitter` SPI. Writes the
``{type, optional, name, version, doc, fields, parameters}`` form a Connect pipeline
carries — one self-contained document per top-level record.

**Two callers, one writer, and why the difference matters.** A model imported *from*
Connect carries the source's own spellings in ``extras``: which primitive width a field
was declared with, which logical type named it, which parameters rode beside it, which
registry revision the schema had. A model imported from anywhere else carries none of
them, and its canonical constraints are the only thing there is to write. The writer
therefore has two modes, decided per field by :meth:`_ConnectWriter._native_logical`:

* **native** — the Connect spelling is written back from the extras that recorded it, so
  an ``int8`` returns as ``int8`` rather than as its canonical width and
  ``io.debezium.data.Enum`` returns with its ``allowed`` parameter intact;
* **projected** — the canonical scalar picks a Connect primitive, a canonical ``format``
  picks a bundled logical type where Connect has one, and everything Connect cannot
  carry is recorded as a loss.

That split is what makes ``kafka-connect -> kafka-connect`` a round-trip rather than a
re-derivation, and it is the same technique the CDDL and WIT emitters use for the same
reason.

**Connect has no reference construct.** Avro can name a record once and refer to it;
Connect inlines everything. Two fields that share a canonical record therefore emit two
identical structs — correct, and what a Connect consumer expects — and a record that
(however indirectly) contains itself cannot be written at all, so the cycle is cut at
the repeat and reported as a loss rather than expanded forever.

**Types only.** A Connect schema describes a value. Operations, services and channels
have no Connect representation and are dropped with a stated loss, exactly as they are
for Avro.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from pydantic import Field

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
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
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict
from .kafka_connect_normalizer import (
    CONNECTOR_EXTRAS_KEY,
    KAFKA_CONNECT_EXTRAS_KEY,
    PAYLOAD_EXTRAS_KEY,
)
from .kafka_connect_parser import parse_kafka_connect
from .kafka_connect_schema import (
    CONNECT_TYPES,
    DECIMAL_LOGICAL_TYPE,
    DECIMAL_PRECISION_PARAMETER,
    DECIMAL_SCALE_PARAMETER,
    ENUM_ALLOWED_PARAMETER,
    ENUM_LOGICAL_TYPE,
    LOGICAL_TYPES,
    ConnectParseError,
    logical_type_for_format,
)

__all__ = [
    "KafkaConnectEmitOptions",
    "KafkaConnectEmitter",
    "KafkaConnectFidelityRulePack",
    "validate_connect_schema",
]

#: The message every types-only drop quotes, so one sentence explains the whole family.
_TYPES_ONLY_DROP = "only data schemas are exported"

#: Characters that may not reach a bundle path. A canonical type name is source text, and
#: it is about to become a filename.
_PATH_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

#: Written when a canonical scalar has no Connect analogue at all.
_FALLBACK_TYPE = "string"

#: Canonical scalar name → Connect primitive. Every alias the canonical vocabulary uses
#: for the same width is listed, so a model from any reader lands on the same Connect
#: type. Unsigned names widen to the next signed width that holds them; ``uint64``
#: cannot, and is the one entry that reports a loss.
_CANONICAL_TO_CONNECT: Dict[str, str] = {
    "bool": "boolean",
    "boolean": "boolean",
    "byte": "int8",
    "sbyte": "int8",
    "i8": "int8",
    "int8": "int8",
    "uint8": "int16",
    "short": "int16",
    "i16": "int16",
    "int16": "int16",
    "uint16": "int32",
    "int": "int32",
    "integer": "int32",
    "i32": "int32",
    "int32": "int32",
    "fixed32": "int32",
    "sfixed32": "int32",
    "sint32": "int32",
    "uint32": "int64",
    "i64": "int64",
    "int64": "int64",
    "long": "int64",
    "fixed64": "int64",
    "sfixed64": "int64",
    "sint64": "int64",
    "uint64": "int64",
    "bigint": "int64",
    "float": "float32",
    "f32": "float32",
    "float32": "float32",
    "double": "float64",
    "f64": "float64",
    "float64": "float64",
    "number": "float64",
    "string": "string",
    "bytes": "bytes",
    "binary": "bytes",
    "blob": "bytes",
}

#: Canonical scalars whose Connect projection cannot hold the whole value space.
_WIDENED_SCALARS = frozenset({"uint64"})

#: Canonical scalar names that mean "any value". Connect has no such type, so they are
#: written as a string and reported rather than silently becoming one.
_ANY_SCALARS = frozenset({"any", "object", "json", "map", "value", "unknown", "variant"})

#: Canonical scalars that name a semantic type Connect spells as a logical type. Kept
#: apart from :data:`_CANONICAL_TO_CONNECT` because the base type is only half the
#: answer — the logical name is the other half.
_SCALAR_LOGICAL_FORMATS: Dict[str, str] = {
    "date": "date",
    "time": "time",
    "date-time": "date-time",
    "datetime": "date-time",
    "timestamp": "date-time",
    "instant": "date-time",
}

#: Canonical constraint fields Connect has no schema keyword for. Connect validates
#: nothing: a schema states a type, not a value range.
_UNSUPPORTED_CONSTRAINTS = (
    "minimum",
    "maximum",
    "exclusive_minimum",
    "exclusive_maximum",
    "multiple_of",
    "min_length",
    "max_length",
    "pattern",
    "min_items",
    "max_items",
    "unique_items",
)


def validate_connect_schema(document: Any, *, source_label: str = "emitted") -> List[str]:
    """Check that an emitted document reads back as a Kafka Connect schema.

    Connect publishes no schema for its own schema form, so the authority available here
    is this repository's own reader: a document the reader refuses is one no Connect
    consumer would accept either. Running it makes an emitter bug a loud failure at emit
    time rather than a puzzling one at re-import time.

    Args:
        document: The emitted schema, as a plain JSON-compatible structure.
        source_label: Label used in the returned messages.

    Returns:
        A list of error messages; empty when the document reads back cleanly.
    """
    try:
        parse_kafka_connect(json.dumps(document), source_label=source_label)
    except ConnectParseError as exc:
        return [f"Emitted Kafka Connect schema is not readable: {exc}"]
    return []


class KafkaConnectFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for the Kafka Connect target.

    The predictive counterpart to :class:`KafkaConnectEmitter`: it runs against the
    source model alone, never against an emitted document, so an export's losses can be
    previewed without emitting. Connect is types-only and validates nothing, which is
    what the two overridden hooks state.
    """

    target_label = "Kafka Connect"

    def operation_verdict(self, operation) -> FidelityVerdict:
        """Every operation is a critical ``DROP`` on a types-only Connect export."""
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP}; "
            f"the {operation.kind.value} operation is dropped",
            target_mapping="operation → dropped (types-only export)",
        )

    def channel_verdict(self, channel) -> FidelityVerdict:
        """Every event channel is a critical ``DROP`` on a types-only Connect export."""
        return FidelityVerdict.drop(
            message=f"{self.target_label} is types-only — {_TYPES_ONLY_DROP}; "
            "the event channel is dropped",
            target_mapping="channel → dropped (types-only export)",
        )

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Grade an ``ENUM`` as a ``DROP``; every other kind keeps the profile verdict.

        The six-axis :class:`~app.emitter.CapabilityProfile` has no enum axis, so the
        default verdict carries an enumeration to any target that can name a type — and
        Kafka Connect cannot. Its nine primitives have no enumeration among them, and the
        connector-specific logical types that carry one are a *connector's* vocabulary,
        not the format's, so this export writes the base type and says so.

        Args:
            type_: The named type being graded.

        Returns:
            The verdict for ``type_``.
        """
        if type_.kind is TypeKind.ENUM:
            return FidelityVerdict.drop(
                message=f"{self.target_label} has no enumeration type; the members are "
                "dropped and the value is carried as its base type",
                target_mapping="enum → string",
            )
        return super().type_verdict(type_)


class KafkaConnectEmitOptions(EmitOptions):
    """Per-target options for :class:`KafkaConnectEmitter`."""

    namespace: Optional[str] = Field(
        default=None,
        description=(
            "Namespace prefixed to a record whose canonical key carries none, so the "
            "emitted schema names are qualified the way a schema registry subject is. "
            "Defaults to the model's own identity namespace."
        ),
    )
    emit_version: bool = Field(
        default=True,
        description=(
            "Write back the integer `version` a source schema declared. Turning it off "
            "produces schemas with no registry revision, which is what a pipeline that "
            "assigns its own versions wants."
        ),
    )


class KafkaConnectEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as one Kafka Connect schema per top-level record.

    Self-registers under ``kafka-connect``. Targets the data-schema paradigm;
    operation-bearing APIs export **types only**.
    """

    key = "kafka-connect"
    format = "kafka-connect"
    label = "Kafka Connect Schema"
    description = (
        "Export data schemas as Kafka Connect schemas (structs, arrays, maps, logical "
        "types and parameters) — the form a Connect pipeline carries between systems."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    multi_file = True
    options_model = KafkaConnectEmitOptions

    OUTPUT_MEDIA_TYPE = "application/json"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Connect is types-only, has no union, and validates nothing."""
        return CapabilityProfile(
            operations=False,
            events=False,
            unions=False,
            nullability=True,
            constraints=False,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[KafkaConnectFidelityRulePack]:
        """Return the Kafka Connect fidelity rule pack."""
        return KafkaConnectFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[KafkaConnectEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one Connect schema document per top-level record.

        Args:
            api: The canonical model to export.
            opts: Per-target options.

        Returns:
            The emitted bundle, with provenance and loss records.

        Raises:
            ValueError: When the model holds no record type, so there is no Connect
                schema to write.
        """
        options = (
            opts
            if isinstance(opts, KafkaConnectEmitOptions)
            else KafkaConnectEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        writer = _ConnectWriter(api, options)
        files = writer.render()
        return EmitResult(
            files=files,
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


class _ConnectWriter:
    """One-shot Kafka Connect renderer for a single :class:`CanonicalApi`."""

    def __init__(self, api: CanonicalApi, options: KafkaConnectEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self._default_namespace = (
            (options.namespace or api.identity.namespace or "").strip() or None
        )
        self._types_by_key: Dict[str, Type] = {type_.key: type_ for type_ in api.types}
        self._records = [t for t in api.types if t.kind is TypeKind.RECORD]

    # -- rendering --------------------------------------------------------

    def render(self) -> List[EmittedFile]:
        """Render every top-level record to one self-contained Connect schema.

        Returns:
            The emitted files, sorted by path.

        Raises:
            ValueError: When the model holds no record type.
        """
        if not self._records:
            raise ValueError(
                "Kafka Connect export requires at least one record type — a Connect "
                "schema describes a struct, and this model declares none."
            )
        roots = self._root_records()
        files: List[EmittedFile] = []
        taken: Set[str] = {"connector.json"}
        for type_ in roots:
            pointer = f"/{type_.key}"
            document = self._emit_record(type_, pointer=pointer, stack=set(), root=True)
            errors = validate_connect_schema(document, source_label=type_.key)
            if errors:
                raise ValueError(errors[0])
            self.tracker.record(pointer, Provenance.SOURCE)
            files.append(
                EmittedFile(
                    path=self._file_path(type_, taken),
                    content=document,
                    media_type=KafkaConnectEmitter.OUTPUT_MEDIA_TYPE,
                )
            )
        files.extend(self._connector_files())
        self._report_carried_payload()
        return sorted(files, key=lambda emitted: emitted.path)

    def _file_path(self, type_: Type, taken: Set[str]) -> str:
        """Return a safe, unique bundle path for one emitted schema.

        A canonical type name is source text — it can hold a path separator, a ``..``, or
        nothing usable at all — and it is about to become a filename inside an export
        bundle. Every character outside the portable set collapses to ``_``, and a name
        that collides with one already written is suffixed rather than overwriting it.

        Args:
            type_: The record being written.
            taken: Paths already used by this bundle; mutated in place.

        Returns:
            The path.
        """
        stem = _PATH_UNSAFE.sub("_", self._schema_name(type_)).strip("._") or "schema"
        candidate = f"{stem}.json"
        index = 2
        while candidate in taken:
            candidate = f"{stem}-{index}.json"
            index += 1
        taken.add(candidate)
        return candidate

    def _connector_files(self) -> List[EmittedFile]:
        """Write back the connector configuration a pipeline import carried, if any.

        The reader parks a connector configuration verbatim because it is operational
        rather than structural; the writer returns it to the file set beside the schemas
        it belongs to. Nothing is derived — a model that carried no configuration gets no
        file, because a fabricated ``connector.class`` would be a claim about how a
        pipeline runs that nobody made.

        Returns:
            One file, or an empty list.
        """
        carried = self._api.extras.get(CONNECTOR_EXTRAS_KEY)
        if not isinstance(carried, dict) or not isinstance(carried.get("config"), dict):
            return []
        document: Dict[str, Any] = {}
        if carried.get("name"):
            document["name"] = carried["name"]
        document["config"] = dict(carried["config"])
        self.tracker.record("/connector", Provenance.SOURCE)
        return [
            EmittedFile(
                path="connector.json",
                content=document,
                media_type=KafkaConnectEmitter.OUTPUT_MEDIA_TYPE,
            )
        ]

    def _report_carried_payload(self) -> None:
        """Report a carried sample record rather than guessing which schema it belongs to.

        A ``{schema, payload}`` envelope pairs one schema with one record. The canonical
        model records the records it carried but not which root each belongs to, and a
        wrong pairing would attach a sample to a schema it does not validate against — so
        the export writes schemas and says what it left behind.
        """
        carried = self._api.extras.get(PAYLOAD_EXTRAS_KEY)
        if not carried:
            return
        self.losses.record(
            LossKind.NA,
            "envelope-payload-dropped",
            "The sample record(s) carried beside an enveloped schema are data, not "
            "structure; this export writes schemas, and the model does not record which "
            "schema each record belongs to",
        )

    def _root_records(self) -> List[Type]:
        """Choose which records become documents of their own.

        A model this reader produced names its roots, so they are honoured exactly. Any
        other model is read structurally: a record no other emittable type refers to is a
        top-level schema. A model whose records all refer to one another (a cycle) has no
        structural root, so every record is written.

        Returns:
            The records to emit, sorted by key.
        """
        declared = self._declared_roots()
        if declared:
            return declared
        referenced: Set[str] = set()
        for type_ in self._api.types:
            for ref in self._referenced_keys(type_):
                if ref != type_.key:
                    referenced.add(ref)
        roots = [type_ for type_ in self._records if type_.key not in referenced]
        return sorted(roots or self._records, key=lambda type_: type_.key)

    def _declared_roots(self) -> List[Type]:
        """Return the roots the Connect reader recorded, when every one resolves."""
        report = self._api.extras.get(KAFKA_CONNECT_EXTRAS_KEY)
        if not isinstance(report, dict):
            return []
        keys = report.get("roots")
        if not isinstance(keys, list) or not keys:
            return []
        resolved: List[Type] = []
        for key in keys:
            type_ = self._types_by_key.get(key) if isinstance(key, str) else None
            if type_ is None or type_.kind is not TypeKind.RECORD:
                return []
            resolved.append(type_)
        return sorted(resolved, key=lambda type_: type_.key)

    def _referenced_keys(self, type_: Type) -> Set[str]:
        """Return every named type key ``type_`` refers to, at any nesting depth."""
        keys: Set[str] = set()

        def walk(ref: Optional[TypeRef]) -> None:
            if ref is None:
                return
            if ref.name:
                keys.add(ref.name)
            walk(ref.item)

        for field in type_.fields:
            walk(field.type)
        walk(type_.key_type)
        walk(type_.value_type)
        walk(type_.aliased)
        keys.update(member for member in type_.union_members if isinstance(member, str))
        return keys

    # -- names ------------------------------------------------------------

    def _schema_name(self, type_: Type) -> str:
        """Return the qualified Connect schema name for a canonical type."""
        if type_.namespace:
            return f"{type_.namespace}.{type_.name}"
        if self._default_namespace:
            return f"{self._default_namespace}.{type_.name}"
        return type_.name

    # -- structures -------------------------------------------------------

    def _emit_record(
        self, type_: Type, *, pointer: str, stack: Set[str], root: bool = False
    ) -> Dict[str, Any]:
        """Emit one canonical RECORD as a Connect ``struct`` schema.

        Args:
            type_: The record.
            pointer: JSON Pointer of the emitted node, for provenance.
            stack: Record keys currently being inlined, so a cycle can be cut.
            root: Whether this struct is the document's root, which is the only place a
                schema's own ``optional`` flag has to come from ``extras``.

        Returns:
            The Connect schema dict.
        """
        schema: Dict[str, Any] = {"type": "struct"}
        if not type_.extras.get("connect_anonymous"):
            # A struct the source did not name is written back unnamed: the canonical key
            # was *derived* from where the struct sits, and writing it out would present a
            # name nobody declared as one the document carries.
            schema["name"] = self._schema_name(type_)
            self.tracker.record(f"{pointer}/name", Provenance.SOURCE)
        schema["optional"] = (
            bool(type_.extras.get("connect_optional", False)) if root else False
        )
        version = type_.extras.get("connect_version")
        if self._options.emit_version and isinstance(version, int) and not isinstance(version, bool):
            schema["version"] = version
            self.tracker.record(f"{pointer}/version", Provenance.SOURCE)
        if type_.description:
            schema["doc"] = type_.description
            self.tracker.record(f"{pointer}/doc", Provenance.SOURCE)

        inner = stack | {type_.key}
        schema["fields"] = [
            self._emit_field(field, pointer=f"{pointer}/fields/{index}", stack=inner)
            for index, field in enumerate(self._ordered_fields(type_))
        ]
        if not schema["fields"]:
            self.losses.record(
                LossKind.NA,
                "empty-struct",
                f"Record {type_.key!r} declares no members; a Kafka Connect struct with no "
                f"fields describes no record",
                pointer=type_.key,
            )
        parameters = self._parameters(type_.extras)
        if parameters:
            schema["parameters"] = parameters
            self.tracker.record(f"{pointer}/parameters", Provenance.SOURCE)
        return schema

    @staticmethod
    def _ordered_fields(type_: Type) -> List[CanonicalField]:
        """Return a record's members in their source declaration order.

        The canonical model sorts a type's fields by key so that a diff is invariant to
        declaration order; ``field_number`` is what preserves the order the source wrote,
        and a Connect struct's field order is part of what it describes.

        Args:
            type_: The record.

        Returns:
            The members, ordered by ``field_number`` then name.
        """
        return sorted(
            type_.fields,
            key=lambda field: (
                field.field_number if isinstance(field.field_number, int) else 1 << 30,
                field.name,
            ),
        )

    def _emit_field(
        self, field: CanonicalField, *, pointer: str, stack: Set[str]
    ) -> Dict[str, Any]:
        """Emit one canonical field as a Connect struct member.

        Args:
            field: The canonical field.
            pointer: JSON Pointer of the emitted node, for provenance.
            stack: Record keys currently being inlined.

        Returns:
            The member schema, carrying Connect's ``field`` name key.
        """
        schema = self._emit_type_ref(field.type, field=field, pointer=pointer, stack=stack)
        schema["field"] = field.name
        self.tracker.record(f"{pointer}/field", Provenance.SOURCE)
        if field.description:
            schema.setdefault("doc", field.description)
            self.tracker.record(f"{pointer}/doc", Provenance.SOURCE)
        if field.extras.get("has_default") or field.default is not None:
            schema["default"] = field.default
            self.tracker.record(f"{pointer}/default", Provenance.SOURCE)
        version = field.extras.get("connect_version")
        if self._options.emit_version and isinstance(version, int) and not isinstance(version, bool):
            schema["version"] = version
        self._report_dropped_constraints(field)
        # ``field`` is written last above, so the keys are re-ordered here into the
        # spelling a Connect converter writes: what the member is called, then its type.
        return {
            key: schema[key]
            for key in ("field", "type", "name", "version", "optional", "doc", "default",
                        "parameters", "fields", "items", "keys", "values")
            if key in schema
        }

    def _emit_type_ref(
        self,
        ref: TypeRef,
        *,
        field: Optional[CanonicalField],
        pointer: str,
        stack: Set[str],
    ) -> Dict[str, Any]:
        """Emit a use-site reference as a Connect schema node.

        Args:
            ref: The reference.
            field: The field the reference sits on, when there is one; its ``extras``
                are what make a native re-emission exact.
            pointer: JSON Pointer of the emitted node, for provenance.
            stack: Record keys currently being inlined.

        Returns:
            The Connect schema dict for this level.
        """
        if ref.is_list():
            item = ref.item
            items = (
                self._emit_type_ref(item, field=field, pointer=f"{pointer}/items", stack=stack)
                if item is not None
                else {"type": _FALLBACK_TYPE, "optional": True}
            )
            return {"type": "array", "optional": bool(ref.nullable), "items": items}

        target = self._types_by_key.get(ref.name or "")
        if target is not None:
            return self._emit_named(target, ref=ref, pointer=pointer, stack=stack)
        return self._emit_scalar(ref, field=field, pointer=pointer)

    def _emit_named(
        self, target: Type, *, ref: TypeRef, pointer: str, stack: Set[str]
    ) -> Dict[str, Any]:
        """Emit a reference to a named canonical type by inlining it.

        Args:
            target: The referenced type.
            ref: The reference, whose ``nullable`` is this level's optionality.
            pointer: JSON Pointer of the emitted node, for provenance.
            stack: Record keys currently being inlined.

        Returns:
            The inlined Connect schema dict.
        """
        optional = bool(ref.nullable)
        if target.key in stack:
            self.losses.record(
                LossKind.NA,
                "recursive-type-cut",
                f"Type {target.key!r} contains itself; Kafka Connect has no reference "
                f"construct, so the repeat is cut and written as `{_FALLBACK_TYPE}`",
                pointer=target.key,
            )
            return {"type": _FALLBACK_TYPE, "optional": True}

        if target.kind is TypeKind.RECORD:
            schema = self._emit_record(target, pointer=pointer, stack=stack)
            schema["optional"] = optional
            return schema
        if target.kind is TypeKind.MAP:
            keys = (
                self._emit_type_ref(
                    target.key_type, field=None, pointer=f"{pointer}/keys", stack=stack
                )
                if target.key_type is not None
                else {"type": "string", "optional": False}
            )
            values = (
                self._emit_type_ref(
                    target.value_type, field=None, pointer=f"{pointer}/values", stack=stack
                )
                if target.value_type is not None
                else {"type": _FALLBACK_TYPE, "optional": True}
            )
            return {"type": "map", "optional": optional, "keys": keys, "values": values}
        if target.kind is TypeKind.ALIAS and target.aliased is not None:
            aliased = self._emit_type_ref(
                target.aliased, field=None, pointer=pointer, stack=stack
            )
            aliased["optional"] = optional
            return aliased
        if target.kind is TypeKind.ENUM:
            self.losses.record(
                LossKind.INFERRED,
                "enum-flattened",
                f"Enum {target.key!r} is written as a string; Kafka Connect has no "
                f"enumeration type, and the connector-specific logical types that carry "
                f"one are not invented here",
                pointer=target.key,
            )
            return {"type": "string", "optional": optional}
        if target.kind is TypeKind.UNION:
            return self._emit_union(target, optional=optional, pointer=pointer, stack=stack)
        return self._emit_named_scalar(target, optional=optional)

    def _emit_union(
        self, target: Type, *, optional: bool, pointer: str, stack: Set[str]
    ) -> Dict[str, Any]:
        """Emit a canonical UNION, which Connect can express only when it is nullability.

        Args:
            target: The union type.
            optional: Whether this use site is nullable.
            pointer: JSON Pointer of the emitted node, for provenance.
            stack: Record keys currently being inlined.

        Returns:
            The single non-null member made optional, or a string when there is no such
            single member.
        """
        members = [member for member in target.union_members if member != "null"]
        nullable = optional or len(members) < len(target.union_members)
        if len(members) == 1:
            schema = self._emit_type_ref(
                TypeRef(name=members[0], nullable=nullable),
                field=None,
                pointer=pointer,
                stack=stack,
            )
            schema["optional"] = True
            return schema
        self.losses.record(
            LossKind.NA,
            "union-flattened",
            f"Union {target.key!r} has {len(members)} non-null members; Kafka Connect has "
            f"no union type — optionality is a flag, not a choice — so it is written as an "
            f"optional `{_FALLBACK_TYPE}`",
            pointer=target.key,
        )
        return {"type": _FALLBACK_TYPE, "optional": True}

    def _emit_named_scalar(self, target: Type, *, optional: bool) -> Dict[str, Any]:
        """Emit a named SCALAR type by resolving it to a Connect primitive."""
        constraints = target.constraints
        fmt = (constraints.format or "").strip().lower() if constraints else ""
        base = _CANONICAL_TO_CONNECT.get(target.name.strip().lower())
        if base is None and fmt in _SCALAR_LOGICAL_FORMATS:
            logical = logical_type_for_format(_SCALAR_LOGICAL_FORMATS[fmt], "string")
            if logical is not None:
                return {
                    "type": logical.base_type,
                    "name": logical.name,
                    "optional": optional,
                }
        if base is None:
            self.losses.record(
                LossKind.INFERRED,
                "scalar-approximated",
                f"Scalar {target.key!r} has no Kafka Connect analogue; Connect declares nine "
                f"primitives and no way to name a tenth, so it is written as "
                f"`{_FALLBACK_TYPE}`",
                pointer=target.key,
            )
            base = _FALLBACK_TYPE
        return {"type": base, "optional": optional}

    # -- scalars ----------------------------------------------------------

    def _emit_scalar(
        self, ref: TypeRef, *, field: Optional[CanonicalField], pointer: str
    ) -> Dict[str, Any]:
        """Emit a primitive reference, native spelling first.

        Args:
            ref: The reference, naming a canonical scalar.
            field: The field the reference sits on, when there is one.
            pointer: JSON Pointer of the emitted node, for provenance.

        Returns:
            The Connect schema dict for the primitive.
        """
        extras = field.extras if field is not None else {}
        constraints = field.constraints if field is not None else None
        optional = bool(ref.nullable)

        native = self._native_logical(extras)
        if native is not None:
            schema = dict(native)
            schema["optional"] = optional
            parameters = self._native_parameters(extras, constraints)
            if parameters:
                schema["parameters"] = parameters
            return schema

        scalar = (ref.name or "").strip().lower()
        base = extras.get("connect_type")
        if isinstance(base, str) and base in CONNECT_TYPES and base not in {"struct", "array", "map"}:
            # The source was Connect and named its own width; honour it exactly.
            self.tracker.record(f"{pointer}/type", Provenance.SOURCE)
            return {"type": base, "optional": optional}

        projected, parameters = self._projected_scalar(scalar, constraints, extras, pointer=pointer)
        projected["optional"] = optional
        if parameters:
            projected["parameters"] = parameters
        return projected

    @staticmethod
    def _native_logical(extras: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Return the exact Connect spelling a Connect-sourced field recorded, if any.

        Args:
            extras: The field's canonical extras bag.

        Returns:
            ``{"type": …, "name": …}`` when the field carries both a Connect type and a
            logical-type name, else ``None``.
        """
        logical = extras.get("connect_logical_type")
        base = extras.get("connect_type")
        if not isinstance(logical, str) or not logical:
            return None
        if not isinstance(base, str) or base not in CONNECT_TYPES:
            known = LOGICAL_TYPES.get(logical)
            if known is None:
                return None
            base = known.base_type
        return {"type": base, "name": logical}

    @staticmethod
    def _native_parameters(
        extras: Dict[str, Any], constraints: Optional[Constraints]
    ) -> Dict[str, str]:
        """Rebuild the ``parameters`` map a recognized logical type consumed on the way in.

        Args:
            extras: The field's canonical extras bag.
            constraints: The field's constraints, which hold an enum's permitted values.

        Returns:
            The parameters to write, Connect's string-valued spelling restored.
        """
        parameters: Dict[str, str] = {}
        logical = extras.get("connect_logical_type")
        if logical == DECIMAL_LOGICAL_TYPE:
            scale = extras.get("scale")
            precision = extras.get("precision")
            if isinstance(scale, int) and not isinstance(scale, bool):
                parameters[DECIMAL_SCALE_PARAMETER] = str(scale)
            if isinstance(precision, int) and not isinstance(precision, bool):
                parameters[DECIMAL_PRECISION_PARAMETER] = str(precision)
        elif logical == ENUM_LOGICAL_TYPE and constraints is not None and constraints.enum:
            parameters[ENUM_ALLOWED_PARAMETER] = ",".join(
                str(value) for value in constraints.enum
            )
        carried = extras.get("connect_parameters")
        if isinstance(carried, dict):
            for key, value in carried.items():
                parameters[str(key)] = value
        return parameters

    def _projected_scalar(
        self,
        scalar: str,
        constraints: Optional[Constraints],
        extras: Dict[str, Any],
        *,
        pointer: str,
    ) -> Tuple[Dict[str, Any], Dict[str, str]]:
        """Project a canonical scalar that did **not** come from Connect.

        Args:
            scalar: The canonical scalar name.
            constraints: The field's constraints.
            extras: The field's extras, read only for a decimal's digits.
            pointer: JSON Pointer of the emitted node, for provenance.

        Returns:
            ``(schema, parameters)`` — the schema without its ``optional`` flag, and the
            parameters a projected logical type needs.
        """
        fmt = (constraints.format or "").strip().lower() if constraints else ""
        base = _CANONICAL_TO_CONNECT.get(scalar)

        logical = logical_type_for_format(fmt, scalar) if fmt else None
        if logical is None and scalar in _SCALAR_LOGICAL_FORMATS:
            logical = logical_type_for_format(_SCALAR_LOGICAL_FORMATS[scalar], scalar)
        if logical is not None:
            self.tracker.record(f"{pointer}/name", Provenance.INFERRED)
            parameters: Dict[str, str] = {}
            if logical.name == DECIMAL_LOGICAL_TYPE:
                parameters = self._decimal_parameters(extras, constraints, pointer=pointer)
            return {"type": logical.base_type, "name": logical.name}, parameters

        if base is None:
            if scalar in _ANY_SCALARS:
                self.losses.record(
                    LossKind.NA,
                    "any-scalar-approximated",
                    f"Canonical scalar {scalar!r} means 'any value'; Kafka Connect has no "
                    f"such type — every schema names one of its nine primitives — so it is "
                    f"written as `{_FALLBACK_TYPE}`",
                    pointer=pointer,
                )
            else:
                self.losses.record(
                    LossKind.INFERRED,
                    "scalar-approximated",
                    f"Canonical scalar {scalar!r} has no Kafka Connect primitive; it is "
                    f"written as `{_FALLBACK_TYPE}`",
                    pointer=pointer,
                )
            base = _FALLBACK_TYPE
            self.tracker.record(f"{pointer}/type", Provenance.DEFAULT)
        else:
            self.tracker.record(f"{pointer}/type", Provenance.INFERRED)
            if scalar in _WIDENED_SCALARS:
                self.losses.record(
                    LossKind.INFERRED,
                    "unsigned-widened",
                    f"Canonical scalar {scalar!r} is unsigned and Kafka Connect has only "
                    f"signed integers; it is written as `{base}`, whose upper half of the "
                    f"range wraps negative",
                    pointer=pointer,
                )
        return {"type": base}, {}

    def _decimal_parameters(
        self,
        extras: Dict[str, Any],
        constraints: Optional[Constraints],
        *,
        pointer: str,
    ) -> Dict[str, str]:
        """Build a projected ``Decimal``'s parameters from whatever the model recorded.

        Connect's ``Decimal`` is meaningless without a scale — the bytes are an unscaled
        integer — so a model that states none has one *derived* (``0``, an integral
        decimal) and the derivation is reported rather than presented as a source fact.

        Args:
            extras: The field's extras, where a reader may have parked the digits.
            constraints: The field's constraints, whose own extras are the second place
                a reader may have parked them.
            pointer: JSON Pointer of the emitted node, for provenance.

        Returns:
            The parameters map.
        """
        sources: List[Dict[str, Any]] = [extras]
        if constraints is not None and constraints.extras:
            sources.append(constraints.extras)
        parameters: Dict[str, str] = {}
        for key, parameter in (
            ("scale", DECIMAL_SCALE_PARAMETER),
            ("precision", DECIMAL_PRECISION_PARAMETER),
        ):
            for source in sources:
                value = source.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    parameters[parameter] = str(value)
                    break
        if DECIMAL_SCALE_PARAMETER not in parameters:
            parameters[DECIMAL_SCALE_PARAMETER] = "0"
            self.tracker.record(f"{pointer}/parameters/scale", Provenance.DEFAULT)
            self.losses.record(
                LossKind.INFERRED,
                "decimal-scale-derived",
                "Kafka Connect's Decimal carries an unscaled integer, so a scale is "
                "required to read it; the model states none, so `scale: 0` — an integral "
                "decimal — is derived",
                pointer=pointer,
            )
        return parameters

    # -- reporting --------------------------------------------------------

    @staticmethod
    def _parameters(extras: Dict[str, Any]) -> Dict[str, Any]:
        """Return the ``parameters`` map an extras bag carried, if any."""
        carried = extras.get("connect_parameters")
        return dict(carried) if isinstance(carried, dict) and carried else {}

    def _report_dropped_constraints(self, field: CanonicalField) -> None:
        """Record every canonical constraint Kafka Connect has no keyword for.

        Args:
            field: The canonical field being emitted.
        """
        constraints = field.constraints
        if constraints is None:
            return
        dropped = [
            name
            for name in _UNSUPPORTED_CONSTRAINTS
            if getattr(constraints, name, None) is not None
        ]
        if constraints.enum and field.extras.get("connect_logical_type") != ENUM_LOGICAL_TYPE:
            dropped.append("enum")
        if not dropped:
            return
        self.losses.record(
            LossKind.NA,
            "constraints-dropped",
            f"Kafka Connect validates nothing — a schema states a type, not a value range "
            f"— so {', '.join(sorted(dropped))} "
            f"{'are' if len(dropped) > 1 else 'is'} dropped",
            pointer=field.key,
        )
