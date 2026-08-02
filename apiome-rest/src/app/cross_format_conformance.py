"""Cross-format instance conformance (canonical → target) — IXH-5.6 (#5118).

Structural fidelity (:mod:`app.lossiness`, :mod:`app.export_fidelity`) predicts which
constructs survive an emit. It does not answer the question that actually breaks a consumer
at runtime: *does a payload that is valid against the source schema remain valid against the
emitted target schema?* This module answers it empirically, per emit target and per entity:

1. every RECORD entity is projected to its validator-safe JSON Schema
   (:func:`app.canonical_json_schema.build_type_json_schema`) and the IXH-5.2 synthesizer
   generates its **source-valid** instances (minimal, full, branch — never mutants);
2. the target schema is emitted for real (no prediction) through the registered emitter;
3. each instance is transcoded to the target's wire format where it differs
   (:mod:`app.conformance_transcoding`) and validated against the emitted schema with the
   target's own validator.

**Validatable targets.** Only five emit formats have a schema language with an instance
validator this runtime can run: JSON Schema (:func:`app.schema_instance_validation.
validate_json_instance`), Avro (``fastavro``), protobuf (``buf`` compile +
``json_format.ParseDict``), GraphQL input types (``graphql-core`` input coercion), and XSD
(``xmllint`` through :func:`app.xml_instance_validation.validate_xml_instance`). Every other
registered target is reported **not applicable — never passing** (the IXH-5.6 acceptance
criterion), mirroring the honesty vocabulary of :mod:`app.export_validation`:
``applicable`` / ``validated`` / ``valid`` are three separate statements, and a missing
toolchain yields ``validated=False`` with a reason rather than a verdict.

**Failure taxonomy.** Every failure row carries ``kind``:

* ``conformance`` — the emitted schema's validator ran and rejected a source-valid instance;
  ``constraint`` names the target-side constraint that rejected it (the constraint whose
  source counterpart was lost or narrowed in translation).
* ``transcode`` — the instance could not be represented on the target's wire format at all,
  so the target schema never judged it. Kept apart by acceptance criterion: a transcode gap
  is a harness limitation, not proof of schema loss, and it must never masquerade as either
  a pass or a conformance failure.

**Determinism.** Entity order is the sorted canonical key order, instance synthesis is
seeded, and every list in the report is emitted in a stable order, so two runs over the same
revision produce identical reports.

Results feed the IXH-2.4 readiness rank through
:func:`app.export_preflight.apply_instance_conformance`, which attaches each
:class:`TargetConformance` beside the target's structural fidelity envelope and demotes a
``ready`` target to ``caution`` when its validator ran and rejected instances.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field

from .canonical_json_schema import (
    CanonicalTypeNotFoundError,
    build_type_json_schema,
)
from .canonical_model import CanonicalApi, Type, TypeKind
from .conformance_transcoding import (
    TranscodeError,
    build_xsd_validation_harness,
    transcode_json_to_avro,
    transcode_json_to_xml,
)
from .emitter import (
    EmitResult,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from .schema_instance_synthesis import SynthesizedInstance, synthesize_instances

__all__ = [
    "DEFAULT_MAX_ENTITIES",
    "DEFAULT_MAX_INSTANCES_PER_ENTITY",
    "MAX_ENTITIES_CEILING",
    "MAX_INSTANCES_CEILING",
    "VALIDATABLE_TARGET_FORMATS",
    "ConformanceFailure",
    "CrossFormatConformanceReport",
    "EntityTargetConformance",
    "TargetConformance",
    "check_cross_format_conformance",
]

#: Emit targets excluded from the default target set (internal no-op emitters).
_SAMPLE_EMIT_KEYS = frozenset({"sample", "sample-noop"})

#: How many RECORD entities one conformance run checks by default. Instance validation is
#: emit + synthesize + per-instance validator work (and a subprocess per instance for XSD),
#: so the default keeps a pre-flight interactive; the report says when it truncated.
DEFAULT_MAX_ENTITIES = 10
MAX_ENTITIES_CEILING = 50

#: How many source-valid instances are checked per entity (minimal and full first, then
#: branch instances in synthesis order).
DEFAULT_MAX_INSTANCES_PER_ENTITY = 5
MAX_INSTANCES_CEILING = 20

#: Findings cap handed to the JSON / XML instance validators per instance.
_MAX_FINDINGS_PER_INSTANCE = 25

#: Emit format key → one-line description of the explicit wire-format transcoding applied
#: before that target's validator judges an instance (the IXH-5.6 "transcoding is explicit"
#: criterion, stated per target in the report itself).
_WIRE_TRANSCODING: Dict[str, str] = {
    "json-schema": "None — instances are JSON already and are validated as-is.",
    "avro": (
        "Base64 text is decoded to bytes where the emitted schema demands Avro binary "
        "(bytes/fixed); every other value passes through unchanged."
    ),
    "proto3": (
        "The proto3 canonical JSON mapping, applied by "
        "google.protobuf.json_format.ParseDict over the compiled emitted schema."
    ),
    "graphql": "None — instances are coerced as GraphQL input values directly.",
    "xsd": (
        "Instances are rebuilt as XML documents mirroring the emitted grammar: one element "
        "per member in emitted order, attribute members as XML attributes, repeated "
        "elements for lists, scalar text content."
    ),
}


# ===========================================================================
# Report models
# ===========================================================================


class ConformanceFailure(BaseModel):
    """One instance check that failed against one emitted target schema.

    ``kind`` separates the two failure channels the acceptance criteria demand be kept
    apart: a ``conformance`` row means the target's validator ran and rejected the
    instance; a ``transcode`` row means the instance never reached the validator because
    it has no representation on the target's wire format.
    """

    model_config = ConfigDict(extra="forbid")

    instance_id: str = Field(
        description="Stable id of the synthesized instance (``minimal``, ``full``, "
        "``branch:…``), reproducible from the same revision and seed."
    )
    kind: Literal["transcode", "conformance"] = Field(
        description="``conformance`` — the emitted schema rejected the instance; "
        "``transcode`` — the instance could not be represented on the target wire format, "
        "so the schema never judged it."
    )
    constraint: str = Field(
        description="For ``conformance``: the target-side constraint that rejected the "
        "instance (a JSON Schema keyword, an Avro field path, a protobuf field, a GraphQL "
        "input coordinate, an XSD rule) — the constraint whose source counterpart was lost "
        "in translation. For ``transcode``: the wire rule that failed (``base64``, "
        "``xml-structure``, …)."
    )
    message: str = Field(description="Human-readable failure description.")
    pointer: Optional[str] = Field(
        default=None,
        description="JSON Pointer (or target-side path) to the offending value, when the "
        "validator reports one.",
    )


class EntityTargetConformance(BaseModel):
    """Instance-level conformance of one entity against one emitted target schema."""

    model_config = ConfigDict(extra="forbid")

    entity: str = Field(description="Canonical type key of the entity (``acme.Pet``).")
    status: Literal["pass", "fail", "transcode_failed", "missing", "skipped"] = Field(
        description="``pass`` — every checked instance validated; ``fail`` — the emitted "
        "schema rejected at least one source-valid instance; ``transcode_failed`` — no "
        "conformance failures, but at least one instance had no wire representation; "
        "``missing`` — the emitted schema does not define this entity at all; ``skipped`` — "
        "no source-valid instance could be checked (see ``reason``)."
    )
    reason: Optional[str] = Field(
        default=None,
        description="Why the entity was skipped or reported missing. ``None`` when checked.",
    )
    instances_checked: int = Field(
        default=0,
        description="How many source-valid instances actually reached this target's "
        "validator (transcode failures are excluded — those instances were never judged).",
    )
    failures: List[ConformanceFailure] = Field(
        default_factory=list,
        description="Every failed check, in instance order. Empty when the entity passed.",
    )


class TargetConformance(BaseModel):
    """The instance-conformance verdict for one emit target.

    Reads alongside :class:`app.export_fidelity.TargetFidelity` — the structural prediction
    says what should survive; this says what a real emitted schema actually accepted.
    ``applicable`` / ``validated`` / ``valid`` follow the same honesty contract as
    :class:`app.export_validation.EmittedArtifactValidation`: a target without a validatable
    schema language is *not applicable* (never passing), and a missing toolchain means the
    check *did not run* (never a verdict).
    """

    model_config = ConfigDict(extra="forbid")

    target: str = Field(description="The emit format key checked (``proto3``).")
    key: str = Field(description="The target's registry key (``protobuf``).")
    applicable: bool = Field(
        description="Whether this target's schema language has an instance validator this "
        "check can run (JSON Schema, Avro, protobuf, GraphQL input types, XSD). ``False`` "
        "targets are reported as not-applicable, never as passing."
    )
    validated: bool = Field(
        description="Whether instance validation actually ran. ``False`` when the target is "
        "not applicable, the emit failed, a required toolchain (``buf``, ``xmllint``) is "
        "unavailable, or the emitted schema itself could not be loaded — ``detail`` says "
        "which."
    )
    valid: Optional[bool] = Field(
        default=None,
        description="``True`` — every checked instance remained valid against the emitted "
        "schema; ``False`` — at least one conformance failure (or a missing entity); "
        "``None`` — no verdict, because validation did not run or no instance reached the "
        "validator.",
    )
    wire_transcoding: Optional[str] = Field(
        default=None,
        description="The explicit wire-format transcoding applied before validation, "
        "stated so a reader never has to guess what stood between the JSON instance and "
        "the target validator. ``None`` for not-applicable targets.",
    )
    detail: Optional[str] = Field(
        default=None,
        description="Why validation did not run, or why no verdict was reached. ``None`` "
        "when instances were checked.",
    )
    entities: List[EntityTargetConformance] = Field(
        default_factory=list,
        description="Per-entity results, sorted by entity key. Empty when validation did "
        "not run.",
    )
    instances_checked: int = Field(
        default=0, description="Total instances that reached this target's validator."
    )
    conformance_failures: int = Field(
        default=0,
        description="Total ``conformance`` failure rows across entities (missing entities "
        "contribute one row each).",
    )
    transcode_failures: int = Field(
        default=0, description="Total ``transcode`` failure rows across entities."
    )

    @property
    def failed(self) -> bool:
        """Whether a validator ran and rejected at least one source-valid instance."""
        return self.applicable and self.validated and self.valid is False


class CrossFormatConformanceReport(BaseModel):
    """The full canonical → target instance-conformance report for one revision."""

    model_config = ConfigDict(extra="forbid")

    seed: int = Field(description="The synthesis seed, echoed so a run can be reproduced.")
    entities: List[str] = Field(
        default_factory=list,
        description="Canonical keys of the RECORD entities checked, in sorted order.",
    )
    entities_truncated: bool = Field(
        default=False,
        description="Whether the entity list was cut at the entity cap — stated rather than "
        "silently sampled.",
    )
    targets: List[TargetConformance] = Field(
        default_factory=list, description="Per-target verdicts, sorted by emit format key."
    )


# ===========================================================================
# Entity sampling (shared across targets)
# ===========================================================================


@dataclass
class _EntitySamples:
    """One entity's source-valid instances, synthesized once and reused per target."""

    type_: Type
    instances: List[SynthesizedInstance]
    skip_reason: Optional[str] = None


def _collect_entity_samples(
    api: CanonicalApi,
    *,
    seed: int,
    max_entities: int,
    max_instances_per_entity: int,
) -> Tuple[List[_EntitySamples], bool]:
    """Synthesize the source-valid instance set for every checked RECORD entity.

    Only instances the IXH-5.2 verifier confirmed valid against the *source* projection are
    kept — an instance that does not satisfy the source schema proves nothing about the
    target. Mutants are never generated: cross-format conformance is about payloads that
    *should* survive.

    Returns:
        ``(samples, truncated)`` — samples in sorted canonical-key order, and whether the
        entity cap cut the list short.
    """
    records = sorted(
        (t for t in api.types if t.kind is TypeKind.RECORD and t.key),
        key=lambda t: t.key,
    )
    truncated = len(records) > max_entities
    samples: List[_EntitySamples] = []
    for type_ in records[:max_entities]:
        try:
            projection = build_type_json_schema(api, type_.key)
        except CanonicalTypeNotFoundError as exc:
            samples.append(
                _EntitySamples(type_=type_, instances=[], skip_reason=str(exc))
            )
            continue
        synthesis = synthesize_instances(
            projection.document,
            seed=seed,
            include_mutants=False,
            verify=True,
        )
        valid = [
            instance
            for instance in synthesis.instances
            if instance.expected_valid and instance.valid is not False
        ][:max_instances_per_entity]
        if not valid:
            samples.append(
                _EntitySamples(
                    type_=type_,
                    instances=[],
                    skip_reason="No source-valid instance could be synthesized for this "
                    "entity.",
                )
            )
            continue
        samples.append(_EntitySamples(type_=type_, instances=valid))
    return samples, truncated


# ===========================================================================
# Result assembly helpers
# ===========================================================================


def _skipped_entity(sample: _EntitySamples) -> EntityTargetConformance:
    """The uniform row for an entity no instance check could run on."""
    return EntityTargetConformance(
        entity=sample.type_.key, status="skipped", reason=sample.skip_reason
    )


def _missing_entity(sample: _EntitySamples, reason: str) -> EntityTargetConformance:
    """The row for an entity the emitted schema does not define — a conformance loss.

    The whole entity failing to survive the emit is the strongest possible instance-level
    loss, so it contributes a ``conformance`` failure row (and therefore fails the target)
    rather than reading as skipped.
    """
    return EntityTargetConformance(
        entity=sample.type_.key,
        status="missing",
        reason=reason,
        failures=[
            ConformanceFailure(
                instance_id="*",
                kind="conformance",
                constraint="entity",
                message=reason,
            )
        ],
    )


def _entity_from_failures(
    sample: _EntitySamples,
    failures: List[ConformanceFailure],
    *,
    instances_checked: int,
) -> EntityTargetConformance:
    """Fold one entity's failure rows into its status."""
    if any(f.kind == "conformance" for f in failures):
        status: str = "fail"
    elif failures:
        status = "transcode_failed"
    else:
        status = "pass"
    return EntityTargetConformance(
        entity=sample.type_.key,
        status=status,  # type: ignore[arg-type] — Literal narrowed above
        instances_checked=instances_checked,
        failures=failures,
    )


def _target_result(
    *,
    target_format: str,
    target_key: str,
    applicable: bool = True,
    validated: bool = True,
    detail: Optional[str] = None,
    entities: Optional[List[EntityTargetConformance]] = None,
) -> TargetConformance:
    """Assemble one target verdict from its entity rows, deriving counts and ``valid``."""
    rows = sorted(entities or [], key=lambda e: e.entity)
    instances_checked = sum(e.instances_checked for e in rows)
    conformance_failures = sum(
        1 for e in rows for f in e.failures if f.kind == "conformance"
    )
    transcode_failures = sum(1 for e in rows for f in e.failures if f.kind == "transcode")

    valid: Optional[bool] = None
    if applicable and validated:
        if conformance_failures:
            valid = False
        elif instances_checked:
            valid = True
        else:
            # Validation ran but nothing was actually judged (every entity skipped or
            # transcode-failed): no verdict, and the detail says why nothing counts as a pass.
            detail = detail or (
                "No source-valid instance reached this target's validator, so no "
                "conformance verdict was reached."
            )
    return TargetConformance(
        target=target_format,
        key=target_key,
        applicable=applicable,
        validated=validated,
        valid=valid,
        wire_transcoding=_WIRE_TRANSCODING.get(target_format) if applicable else None,
        detail=detail,
        entities=rows,
        instances_checked=instances_checked,
        conformance_failures=conformance_failures,
        transcode_failures=transcode_failures,
    )


def _not_applicable(target_format: str, target_key: str) -> TargetConformance:
    """A target whose schema language has no instance validator — never a pass."""
    return _target_result(
        target_format=target_format,
        target_key=target_key,
        applicable=False,
        validated=False,
        detail=(
            f"The {target_format!r} target has no validatable schema language for "
            "instance-level conformance; reported as not applicable, not as passing."
        ),
    )


def _not_validated(
    target_format: str, target_key: str, reason: str
) -> TargetConformance:
    """An applicable target whose check could not run (toolchain / emit / schema load)."""
    return _target_result(
        target_format=target_format,
        target_key=target_key,
        applicable=True,
        validated=False,
        detail=reason,
    )


# ===========================================================================
# Per-target validators
# ===========================================================================


def _check_jsonschema_target(
    target_key: str, emit_result: EmitResult, api: CanonicalApi, samples: List[_EntitySamples]
) -> TargetConformance:
    """Validate instances against the emitted JSON Schema document (pure Python)."""
    from .schema_instance_validation import validate_json_instance

    try:
        document = _first_file_json(emit_result)
    except ValueError as exc:
        return _not_validated("json-schema", target_key, f"Emitted document unusable: {exc}")

    entities: List[EntityTargetConformance] = []
    for sample in samples:
        if sample.skip_reason:
            entities.append(_skipped_entity(sample))
            continue
        entity_schema = _locate_jsonschema_entity(document, sample.type_.name)
        if entity_schema is None:
            entities.append(
                _missing_entity(
                    sample,
                    f"The emitted JSON Schema defines no schema named "
                    f"{sample.type_.name!r} (root title or $defs/definitions entry).",
                )
            )
            continue
        failures: List[ConformanceFailure] = []
        checked = 0
        for instance in sample.instances:
            result = validate_json_instance(
                entity_schema,
                instance.instance,
                max_findings=_MAX_FINDINGS_PER_INSTANCE,
            )
            checked += 1
            if result.valid is False:
                failures.extend(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="conformance",
                        constraint=finding.keyword,
                        message=finding.message,
                        pointer=finding.pointer,
                    )
                    for finding in result.findings
                )
        entities.append(
            _entity_from_failures(sample, failures, instances_checked=checked)
        )
    return _target_result(
        target_format="json-schema", target_key=target_key, entities=entities
    )


def _locate_jsonschema_entity(
    document: Dict[str, Any], name: str
) -> Optional[Dict[str, Any]]:
    """Find the emitted subschema for one entity and wrap it as a standalone document.

    The emitter writes one type as the document root (matched by ``title``) and the rest
    under ``$defs`` (or ``definitions`` when a raw source document was re-emitted). A
    ``$defs`` entry is wrapped as ``{"$ref": "#/$defs/<name>", "$defs": …}`` so its sibling
    references keep resolving.
    """
    if document.get("title") == name:
        return document
    for defs_key in ("$defs", "definitions"):
        defs = document.get(defs_key)
        if isinstance(defs, dict) and name in defs:
            token = name.replace("~", "~0").replace("/", "~1")
            wrapper: Dict[str, Any] = {}
            if "$schema" in document:
                wrapper["$schema"] = document["$schema"]
            wrapper[defs_key] = defs
            wrapper["$ref"] = f"#/{defs_key}/{quote(token, safe='~')}"
            return wrapper
    return None


def _check_avro_target(
    target_key: str, emit_result: EmitResult, api: CanonicalApi, samples: List[_EntitySamples]
) -> TargetConformance:
    """Validate instances against the emitted ``.avsc`` set with ``fastavro``."""
    from fastavro import parse_schema
    from fastavro.validation import ValidationError
    from fastavro.validation import validate as avro_validate

    from .avro_emitter import _sanitize_name  # the emitter's own name mapping

    # Parse the emitted bundle to a fixed point (files may reference each other by name in
    # any order — the same iteration export_validation uses for the schema-level check).
    parsed_by_name: Dict[str, Any] = {}
    named: Dict[str, Any] = {}
    pending = [f.content for f in emit_result.files if isinstance(f.content, dict)]
    while pending:
        unresolved: List[Any] = []
        progressed = False
        for content in pending:
            try:
                parsed = parse_schema(copy.deepcopy(content), named)
            except (ValueError, TypeError, KeyError):
                unresolved.append(content)
                continue
            name = content.get("name")
            if isinstance(name, str):
                parsed_by_name[name] = parsed
            progressed = True
        if not unresolved:
            break
        if not progressed:
            break  # the remainder are genuinely unparseable; entities will report missing
        pending = unresolved

    entities: List[EntityTargetConformance] = []
    for sample in samples:
        if sample.skip_reason:
            entities.append(_skipped_entity(sample))
            continue
        schema = parsed_by_name.get(_sanitize_name(sample.type_.name))
        if schema is None:
            entities.append(
                _missing_entity(
                    sample,
                    f"The emitted Avro bundle defines no parseable schema named "
                    f"{_sanitize_name(sample.type_.name)!r}.",
                )
            )
            continue
        resolver = schema.get("__named_schemas", named) if isinstance(schema, dict) else named
        failures: List[ConformanceFailure] = []
        checked = 0
        for instance in sample.instances:
            try:
                datum = transcode_json_to_avro(instance.instance, schema, resolver)
            except TranscodeError as exc:
                failures.append(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="transcode",
                        constraint=exc.constraint,
                        message=str(exc),
                        pointer=exc.pointer,
                    )
                )
                continue
            checked += 1
            try:
                avro_validate(datum, schema, raise_errors=True, strict=True)
            except ValidationError as exc:
                failures.extend(_avro_failures(instance.id, exc))
        entities.append(
            _entity_from_failures(sample, failures, instances_checked=checked)
        )
    return _target_result(target_format="avro", target_key=target_key, entities=entities)


def _avro_failures(instance_id: str, exc: Exception) -> List[ConformanceFailure]:
    """Convert one ``fastavro`` :class:`ValidationError` into ordered failure rows."""
    rows: List[ConformanceFailure] = []
    errors = getattr(exc, "errors", None) or [exc]
    for error in errors:
        field = getattr(error, "field", None)
        rows.append(
            ConformanceFailure(
                instance_id=instance_id,
                kind="conformance",
                constraint=str(field) if field else "schema",
                message=str(error),
            )
        )
    return rows


async def _check_proto_target(
    target_key: str, emit_result: EmitResult, api: CanonicalApi, samples: List[_EntitySamples]
) -> TargetConformance:
    """Compile the emitted ``.proto`` with ``buf`` and parse instances into its messages.

    ``json_format.ParseDict`` applies the proto3 canonical JSON mapping and rejects any
    value the compiled schema cannot carry — a dropped field, a narrowed type, a renamed
    enum symbol — which is exactly the conformance question. Needs the ``buf`` toolchain;
    when it is absent the target reports *not validated*, never a verdict.
    """
    from google.protobuf import descriptor_pool, json_format, message_factory

    from .proto_descriptor import (
        BUF_TOOL_KEY,
        ProtoCompileError,
        ProtoFile,
        compile_proto_descriptor_set,
    )
    from .proto_emitter import _sanitize_identifier  # the emitter's own name mapping
    from .toolchain_runner import is_tool_available

    if not is_tool_available(BUF_TOOL_KEY):
        return _not_validated(
            "proto3",
            target_key,
            f"The {BUF_TOOL_KEY!r} toolchain is unavailable in this runtime; emitted "
            "protobuf schemas cannot be compiled for instance validation.",
        )
    files = [ProtoFile(path=f.path, content=str(f.content)) for f in emit_result.files]
    try:
        compiled = await compile_proto_descriptor_set(files)
    except ProtoCompileError as exc:
        return _not_validated(
            "proto3", target_key, f"The emitted protobuf schema did not compile: {exc}"
        )

    pool = descriptor_pool.DescriptorPool()
    for file_proto in compiled.proto.file:
        pool.Add(file_proto)
    message_names: Dict[str, str] = {}
    for file_proto in compiled.proto.file:
        for message in file_proto.message_type:
            full = f"{file_proto.package}.{message.name}" if file_proto.package else message.name
            message_names.setdefault(message.name, full)

    entities: List[EntityTargetConformance] = []
    for sample in samples:
        if sample.skip_reason:
            entities.append(_skipped_entity(sample))
            continue
        wanted = _sanitize_identifier(sample.type_.name)
        full_name = message_names.get(wanted)
        if full_name is None:
            entities.append(
                _missing_entity(
                    sample,
                    f"The compiled protobuf schema defines no message named {wanted!r}.",
                )
            )
            continue
        message_cls = message_factory.GetMessageClass(
            pool.FindMessageTypeByName(full_name)
        )
        failures: List[ConformanceFailure] = []
        checked = 0
        for instance in sample.instances:
            if not isinstance(instance.instance, dict):
                failures.append(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="transcode",
                        constraint="json-object",
                        message="Only object instances have a protobuf message mapping.",
                    )
                )
                continue
            checked += 1
            try:
                json_format.ParseDict(
                    instance.instance, message_cls(), ignore_unknown_fields=False
                )
            except json_format.ParseError as exc:
                failures.append(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="conformance",
                        constraint=_proto_constraint(str(exc)),
                        message=str(exc),
                    )
                )
        entities.append(
            _entity_from_failures(sample, failures, instances_checked=checked)
        )
    return _target_result(target_format="proto3", target_key=target_key, entities=entities)


_PROTO_FIELD_NAMED_RE = re.compile(r'field named "([^"]+)"')
_PROTO_PARSE_FIELD_RE = re.compile(r"Failed to parse ([\w.-]+) field")
_PROTO_QUOTED_RE = re.compile(r'"([^"]+)"')


def _proto_constraint(message: str) -> str:
    """Extract the field/coordinate a ``ParseDict`` error names, or fall back to the mapping.

    The two common shapes are ``… has no field named "user-id" …`` (a field the compiled
    schema lost) and ``Failed to parse count field: …`` (a value the compiled type
    rejects); the fallback is the first quoted token, then the mapping itself.
    """
    named = _PROTO_FIELD_NAMED_RE.search(message)
    if named:
        return named.group(1)
    parsed = _PROTO_PARSE_FIELD_RE.search(message)
    if parsed:
        return parsed.group(1)
    quoted = _PROTO_QUOTED_RE.search(message)
    return quoted.group(1) if quoted else "proto3-json"


def _check_graphql_target(
    target_key: str, emit_result: EmitResult, api: CanonicalApi, samples: List[_EntitySamples]
) -> TargetConformance:
    """Coerce instances through the emitted SDL's input types (``graphql-core``).

    GraphQL validates values only on the *input* side, so each entity is checked against
    its emitted input type: the emitter's synthesized ``<Name>Input`` when present, the
    type itself when it is an input object, or a structural input mirror of the emitted
    output object type (same fields, same wrappers) when only the output shape exists. An
    entity whose emitted shape has no input representation (a union member, a field with
    arguments) is *skipped* with the reason — never counted as passing.
    """
    from graphql import build_schema
    from graphql.error import GraphQLError
    from graphql.utilities import coerce_input_value

    try:
        sdl = _first_file_text(emit_result)
        schema = build_schema(sdl)
    except (ValueError, GraphQLError, SyntaxError) as exc:
        return _not_validated(
            "graphql", target_key, f"The emitted GraphQL SDL did not build: {exc}"
        )

    shadow_cache: Dict[str, Any] = {}
    entities: List[EntityTargetConformance] = []
    for sample in samples:
        if sample.skip_reason:
            entities.append(_skipped_entity(sample))
            continue
        try:
            input_type = _graphql_input_for_entity(schema, sample.type_.name, shadow_cache)
        except _NoInputRepresentationError as exc:
            entities.append(
                EntityTargetConformance(
                    entity=sample.type_.key,
                    status="skipped",
                    reason=f"The emitted GraphQL shape has no input representation: {exc}",
                )
            )
            continue
        if input_type is None:
            entities.append(
                _missing_entity(
                    sample,
                    f"The emitted GraphQL SDL defines no type named "
                    f"{sample.type_.name!r} (or {sample.type_.name + 'Input'!r}).",
                )
            )
            continue
        failures: List[ConformanceFailure] = []
        checked = 0
        for instance in sample.instances:
            checked += 1
            collected = _coerce_collecting_errors(
                coerce_input_value, instance.instance, input_type
            )
            failures.extend(
                ConformanceFailure(
                    instance_id=instance.id,
                    kind="conformance",
                    constraint=str(path[-1]) if path else "input",
                    message=error.message,
                    pointer="/" + "/".join(str(token) for token in path) if path else "",
                )
                for path, error in collected
            )
        entities.append(
            _entity_from_failures(sample, failures, instances_checked=checked)
        )
    return _target_result(
        target_format="graphql", target_key=target_key, entities=entities
    )


class _NoInputRepresentationError(Exception):
    """An emitted GraphQL shape cannot be mirrored into an input type."""


def _coerce_collecting_errors(
    coerce_input_value: Any, value: Any, input_type: Any
) -> List[Tuple[List[Any], Any]]:
    """Run GraphQL input coercion, collecting every error instead of raising on the first."""
    collected: List[Tuple[List[Any], Any]] = []

    def on_error(path: List[Any], _value: Any, error: Any) -> None:
        collected.append((list(path), error))

    coerce_input_value(value, input_type, on_error)
    return collected


def _graphql_input_for_entity(
    schema: Any, name: str, shadow_cache: Dict[str, Any]
) -> Optional[Any]:
    """Resolve the input type an entity's instances are coerced against, or ``None``."""
    from graphql import GraphQLInputObjectType, GraphQLObjectType

    synthesized = schema.type_map.get(f"{name}Input")
    if isinstance(synthesized, GraphQLInputObjectType):
        return synthesized
    direct = schema.type_map.get(name)
    if isinstance(direct, GraphQLInputObjectType):
        return direct
    if isinstance(direct, GraphQLObjectType):
        return _shadow_input_type(direct, shadow_cache)
    return None


def _shadow_input_type(gql_type: Any, cache: Dict[str, Any]) -> Any:
    """Mirror an emitted output object type into an input type, structurally.

    Same field names, same list/non-null wrappers, scalars and enums untouched — so input
    coercion judges the instance against exactly the constraints the emitter wrote. Types
    GraphQL cannot accept as input (unions, interfaces) and fields that demand arguments
    raise :class:`_NoInputRepresentationError`; the caller reports the entity skipped.
    """
    from graphql import (
        GraphQLEnumType,
        GraphQLInputField,
        GraphQLInputObjectType,
        GraphQLInterfaceType,
        GraphQLList,
        GraphQLNonNull,
        GraphQLObjectType,
        GraphQLScalarType,
        GraphQLUnionType,
    )

    def convert(type_: Any) -> Any:
        if isinstance(type_, GraphQLNonNull):
            return GraphQLNonNull(convert(type_.of_type))
        if isinstance(type_, GraphQLList):
            return GraphQLList(convert(type_.of_type))
        if isinstance(type_, (GraphQLScalarType, GraphQLEnumType, GraphQLInputObjectType)):
            return type_
        if isinstance(type_, (GraphQLUnionType, GraphQLInterfaceType)):
            raise _NoInputRepresentationError(
                f"type {type_.name!r} is a {type_.__class__.__name__} and GraphQL accepts "
                "no union/interface input"
            )
        if isinstance(type_, GraphQLObjectType):
            cached = cache.get(type_.name)
            if cached is not None:
                return cached

            # Fields are built eagerly (graphql-core would wrap an exception raised from a
            # lazy thunk), but the shadow is cached *before* the walk so a type cycle
            # terminates on its second visit. A failed build is evicted so a later entity
            # never coerces against a half-built shadow.
            field_map: Dict[str, Any] = {}
            shadow = GraphQLInputObjectType(
                name=f"{type_.name}__ConformanceShadow", fields=lambda: field_map
            )
            cache[type_.name] = shadow
            try:
                for field_name, field in type_.fields.items():
                    if field.args:
                        raise _NoInputRepresentationError(
                            f"field {type_.name}.{field_name} takes arguments"
                        )
                    field_map[field_name] = GraphQLInputField(convert(field.type))
            except _NoInputRepresentationError:
                cache.pop(type_.name, None)
                raise
            return shadow
        raise _NoInputRepresentationError(f"unsupported emitted type {type_!r}")

    return convert(gql_type)


async def _check_xsd_target(
    target_key: str, emit_result: EmitResult, api: CanonicalApi, samples: List[_EntitySamples]
) -> TargetConformance:
    """Transcode instances to XML and validate them against the emitted XSD via ``xmllint``.

    The emitted document is extended with one global element declaration per checked entity
    (:func:`app.conformance_transcoding.build_xsd_validation_harness`) because ``xmllint``
    validates documents against global elements only; the emitted types are referenced
    untouched. A missing ``xmllint`` (or an uncompilable schema) reports *not validated*.
    """
    from .xml_instance_validation import validate_xml_instance

    try:
        schema_text = _first_file_text(emit_result)
    except ValueError as exc:
        return _not_validated("xsd", target_key, f"Emitted document unusable: {exc}")

    checked_samples = [s for s in samples if not s.skip_reason]
    harness = build_xsd_validation_harness(
        schema_text, {s.type_.name: s.type_.name for s in checked_samples if s.type_.name}
    )
    if harness is None:
        return _not_validated(
            "xsd",
            target_key,
            "The emitted XSD could not be parsed to attach validation element "
            "declarations.",
        )
    target_ns = api.identity.namespace or api.extras.get("xsd_target_namespace")

    entities: List[EntityTargetConformance] = []
    for sample in samples:
        if sample.skip_reason:
            entities.append(_skipped_entity(sample))
            continue
        failures: List[ConformanceFailure] = []
        checked = 0
        for instance in sample.instances:
            try:
                xml_text = transcode_json_to_xml(
                    api,
                    sample.type_,
                    instance.instance,
                    target_namespace=str(target_ns) if target_ns else None,
                )
            except TranscodeError as exc:
                failures.append(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="transcode",
                        constraint=exc.constraint,
                        message=str(exc),
                        pointer=exc.pointer,
                    )
                )
                continue
            result = await validate_xml_instance(
                harness, xml_text, max_findings=_MAX_FINDINGS_PER_INSTANCE
            )
            if not result.validated or result.valid is None:
                reasons = "; ".join(d.message for d in result.diagnostics) or (
                    "the XML validator did not run"
                )
                return _not_validated(
                    "xsd",
                    target_key,
                    f"Instance validation could not run against the emitted XSD: {reasons}",
                )
            checked += 1
            if result.valid is False:
                failures.extend(
                    ConformanceFailure(
                        instance_id=instance.id,
                        kind="conformance",
                        constraint=finding.keyword or "xsd",
                        message=finding.message,
                        pointer=finding.pointer,
                    )
                    for finding in result.findings
                )
        entities.append(
            _entity_from_failures(sample, failures, instances_checked=checked)
        )
    return _target_result(target_format="xsd", target_key=target_key, entities=entities)


# ===========================================================================
# Shared emit helpers
# ===========================================================================


def _first_file_text(emit_result: EmitResult) -> str:
    """Return the primary emitted file's content as text."""
    if not emit_result.files:
        raise ValueError("the emitter produced no files")
    content = emit_result.files[0].content
    if isinstance(content, str):
        return content
    if isinstance(content, (dict, list)):
        return json.dumps(content)
    return str(content)


def _first_file_json(emit_result: EmitResult) -> Dict[str, Any]:
    """Return the primary emitted file's content parsed as a JSON object."""
    if not emit_result.files:
        raise ValueError("the emitter produced no files")
    content = emit_result.files[0].content
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"not valid JSON ({exc})") from exc
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("the primary emitted file is not a JSON object")


# ===========================================================================
# Public entry point
# ===========================================================================

#: Emit format key → the coroutine-or-function that validates instances against it. The
#: key set *is* the definition of "target with a validatable schema language" (IXH-5.6).
VALIDATABLE_TARGET_FORMATS = frozenset(
    {"json-schema", "avro", "proto3", "graphql", "xsd"}
)


async def check_cross_format_conformance(
    api: CanonicalApi,
    *,
    targets: Optional[Sequence[str]] = None,
    seed: int = 0,
    max_entities: int = DEFAULT_MAX_ENTITIES,
    max_instances_per_entity: int = DEFAULT_MAX_INSTANCES_PER_ENTITY,
) -> CrossFormatConformanceReport:
    """Validate source-valid instances against every emit target's emitted schema.

    The IXH-5.6 core: synthesizes each RECORD entity's source-valid instances once, then
    per target emits the schema for real, transcodes where the wire format differs, and
    validates. Targets without a validatable schema language are reported not-applicable;
    a target whose toolchain is unavailable is reported not-validated. Nothing here
    persists or writes — the function is safe to run from a pre-flight.

    Args:
        api: The source canonical model.
        targets: Restrict to these emit format keys or registry keys (the pre-flight passes
            its ranked target formats). ``None`` checks every registered production target.
        seed: Synthesis seed; the same revision and seed reproduce the report exactly.
        max_entities: Cap on RECORD entities checked (clamped to
            :data:`MAX_ENTITIES_CEILING`); truncation is reported, never silent.
        max_instances_per_entity: Cap on instances checked per entity (clamped to
            :data:`MAX_INSTANCES_CEILING`).

    Returns:
        The :class:`CrossFormatConformanceReport`, deterministic for fixed inputs.
    """
    load_builtin_emitters()
    max_entities = max(1, min(int(max_entities), MAX_ENTITIES_CEILING))
    max_instances_per_entity = max(
        1, min(int(max_instances_per_entity), MAX_INSTANCES_CEILING)
    )
    wanted = (
        {token.strip().lower() for token in targets if token and token.strip()}
        if targets is not None
        else None
    )

    samples, truncated = _collect_entity_samples(
        api,
        seed=seed,
        max_entities=max_entities,
        max_instances_per_entity=max_instances_per_entity,
    )

    results: List[TargetConformance] = []
    for entry in describe_emit_targets():
        descriptor = entry.descriptor
        if descriptor.key in _SAMPLE_EMIT_KEYS or descriptor.format in _SAMPLE_EMIT_KEYS:
            continue
        if wanted is not None and (
            descriptor.key.lower() not in wanted and descriptor.format.lower() not in wanted
        ):
            continue
        if descriptor.format not in VALIDATABLE_TARGET_FORMATS:
            results.append(_not_applicable(descriptor.format, descriptor.key))
            continue
        if not descriptor.available:
            results.append(
                _not_validated(
                    descriptor.format,
                    descriptor.key,
                    descriptor.unavailable_reason
                    or "The emitter is unavailable in this runtime.",
                )
            )
            continue
        emitter_cls = get_emitter(descriptor.format)
        if emitter_cls is None:  # pragma: no cover — registry and describe stay in sync
            continue
        try:
            emit_result = emitter_cls().emit(api)
        except Exception as exc:  # noqa: BLE001 — an emit crash is a non-run, not a verdict
            results.append(
                _not_validated(
                    descriptor.format, descriptor.key, f"Emit failed: {exc}"
                )
            )
            continue
        results.append(
            await _dispatch_target(descriptor.format, descriptor.key, emit_result, api, samples)
        )

    results.sort(key=lambda target: target.target)
    return CrossFormatConformanceReport(
        seed=max(0, int(seed)),
        entities=[sample.type_.key for sample in samples],
        entities_truncated=truncated,
        targets=results,
    )


async def _dispatch_target(
    target_format: str,
    target_key: str,
    emit_result: EmitResult,
    api: CanonicalApi,
    samples: List[_EntitySamples],
) -> TargetConformance:
    """Route one emitted bundle to its format's instance validator."""
    if target_format == "json-schema":
        return _check_jsonschema_target(target_key, emit_result, api, samples)
    if target_format == "avro":
        return _check_avro_target(target_key, emit_result, api, samples)
    if target_format == "proto3":
        return await _check_proto_target(target_key, emit_result, api, samples)
    if target_format == "graphql":
        return _check_graphql_target(target_key, emit_result, api, samples)
    if target_format == "xsd":
        return await _check_xsd_target(target_key, emit_result, api, samples)
    # Unreachable while VALIDATABLE_TARGET_FORMATS and this dispatcher agree; stated so a
    # future format addition cannot silently pass.
    return _not_applicable(target_format, target_key)
