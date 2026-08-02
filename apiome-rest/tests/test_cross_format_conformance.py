"""Cross-format instance conformance tests — IXH-5.6 (#5118).

Covers the acceptance criteria at the engine level:

* source-valid instances are validated against the **actually emitted** schema for every
  target with a validatable schema language (JSON Schema, Avro, protobuf, GraphQL input
  types, XSD);
* conformance failures are reported **per entity** with the target-side constraint that
  rejected the instance;
* wire-format transcoding is explicit and its failures are **distinguished** from
  conformance failures (and never fake a pass or a fail);
* targets without a validatable schema language are **not applicable — never passing**;
* results **feed the IXH-2.4 readiness rank** (attachment, demotion, re-rank, fingerprint);
* the whole report is deterministic for a fixed model and seed.

The corpus grid sweep that covers the IXH-1.7 round-trip matrix axis lives at the bottom:
every source-format representative × every production emit target, asserting the
applicability split and that no target ever reads as passing without instances checked.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from corpus_roundtrip import representatives_by_format
from corpus_snapshot import run_pipeline

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
    Type,
    TypeKind,
    TypeRef,
)
from app.conformance_transcoding import (
    TranscodeError,
    build_xsd_validation_harness,
    transcode_json_to_avro,
    transcode_json_to_xml,
)
from app.cross_format_conformance import (
    VALIDATABLE_TARGET_FORMATS,
    check_cross_format_conformance,
)
from app.emitter import get_emitter, load_builtin_emitters
from app.export_preflight import (
    ExportPreflightRequest,
    apply_instance_conformance,
    run_export_preflight,
)
from app.export_source import ExportSource
from app.import_export_quality_policy import DEFAULT_POLICY
from app.roundtrip_matrix import production_emit_targets
from app.xml_instance_validation import XmlValidationResult

_TENANT = "11111111-1111-4111-8111-111111111111"


# ===========================================================================
# Fixtures
# ===========================================================================


def _status_type() -> Type:
    return Type(
        key="Status",
        name="Status",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Status.ACTIVE", name="ACTIVE"),
            EnumValue(key="Status.RETIRED", name="RETIRED"),
        ],
    )


def _widget_type() -> Type:
    """A record every target emitter can carry: scalars, an enum ref, a list."""
    return Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Widget.id",
                name="id",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(min_length=1),
            ),
            CanonicalField(key="Widget.count", name="count", type=TypeRef(name="int32")),
            CanonicalField(key="Widget.status", name="status", type=TypeRef(name="Status")),
            CanonicalField(
                key="Widget.tags",
                name="tags",
                type=TypeRef(item=TypeRef(name="string")),
            ),
        ],
    )


def _api(
    types: Optional[List[Type]] = None,
    *,
    services: Optional[List[Service]] = None,
    raw: Optional[Dict[str, Any]] = None,
) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        types=types if types is not None else [_widget_type(), _status_type()],
        services=services or [],
        raw=raw,
    )


def _widget_service() -> Service:
    """One query returning ``Widget``, so graph-rooted emitters reach the type."""
    return Service(
        key="widgets",
        name="widgets",
        operations=[
            Operation(
                key="GET /widgets/{id}",
                name="getWidget",
                kind=OperationKind.QUERY,
                messages=[
                    Message(
                        key="GET /widgets/{id}#response.200",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="Widget"),
                    )
                ],
            )
        ],
    )


def _run(api: CanonicalApi, **kwargs: Any):
    return asyncio.run(check_cross_format_conformance(api, **kwargs))


def _target(report: Any, target_format: str) -> Any:
    matches = [t for t in report.targets if t.target == target_format]
    assert matches, f"report has no {target_format!r} target"
    return matches[0]


# ===========================================================================
# Report shape and determinism
# ===========================================================================


def test_report_is_deterministic_and_sorted():
    api = _api()
    first = _run(api, targets=["json-schema", "avro", "thrift"], seed=7)
    second = _run(api, targets=["json-schema", "avro", "thrift"], seed=7)
    assert first.model_dump() == second.model_dump()
    assert first.seed == 7
    assert first.entities == ["Widget"]
    assert [t.target for t in first.targets] == sorted(t.target for t in first.targets)


def test_entity_cap_is_reported_not_silent():
    types = [
        Type(
            key=f"Rec{i:02d}",
            name=f"Rec{i:02d}",
            kind=TypeKind.RECORD,
            fields=[
                CanonicalField(
                    key=f"Rec{i:02d}.id", name="id", type=TypeRef(name="string", nullable=False)
                )
            ],
        )
        for i in range(4)
    ]
    report = _run(_api(types), targets=["json-schema"], max_entities=2)
    assert report.entities == ["Rec00", "Rec01"]
    assert report.entities_truncated is True


# ===========================================================================
# Not-applicable targets are never passing
# ===========================================================================


def test_targets_without_validatable_schema_language_are_not_applicable():
    report = _run(_api(), targets=["thrift", "openapi", "jtd", "asyncapi"])
    assert report.targets, "expected the requested targets to be reported"
    for target in report.targets:
        assert target.applicable is False
        assert target.validated is False
        assert target.valid is None
        assert "not applicable" in (target.detail or "")
        assert target.entities == []


def test_validatable_target_set_is_the_five_ticket_formats():
    assert VALIDATABLE_TARGET_FORMATS == {
        "json-schema",
        "avro",
        "proto3",
        "graphql",
        "xsd",
    }


# ===========================================================================
# JSON Schema target
# ===========================================================================


def test_json_schema_target_accepts_faithfully_emitted_entities():
    report = _run(_api(), targets=["json-schema"])
    target = _target(report, "json-schema")
    assert target.applicable and target.validated
    assert target.valid is True
    entity = target.entities[0]
    assert entity.entity == "Widget"
    assert entity.status == "pass"
    assert entity.instances_checked >= 2  # minimal + full at least
    assert target.conformance_failures == 0 and target.transcode_failures == 0


def test_json_schema_missing_entity_is_a_conformance_loss_not_a_pass():
    # A re-emitted raw source document that never mentions Widget: the emitted schema
    # lost the entity entirely, which is the strongest instance-level loss.
    raw = {
        "source": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "SomethingElse",
            "type": "object",
        }
    }
    report = _run(_api(raw=raw), targets=["json-schema"])
    target = _target(report, "json-schema")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "missing"
    assert entity.failures and entity.failures[0].kind == "conformance"
    assert entity.failures[0].constraint == "entity"


def test_json_schema_reports_the_lost_constraint_per_entity():
    # The emitted document narrows Widget.id beyond the source (pattern the source never
    # demanded), so a source-valid instance fails and the failing keyword is named.
    raw = {
        "source": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "widgets",
            "type": "object",
            "$defs": {
                "Widget": {
                    "type": "object",
                    "properties": {"id": {"type": "string", "pattern": "^[0-9]{12}$"}},
                    "required": ["id"],
                }
            },
        }
    }
    report = _run(_api(raw=raw), targets=["json-schema"])
    target = _target(report, "json-schema")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "fail"
    assert any(f.kind == "conformance" and f.constraint == "pattern" for f in entity.failures)
    assert all(f.pointer is not None for f in entity.failures if f.kind == "conformance")


# ===========================================================================
# Avro target
# ===========================================================================


def test_avro_target_accepts_faithfully_emitted_entities():
    report = _run(_api(), targets=["avro"])
    target = _target(report, "avro")
    assert target.valid is True
    assert target.entities[0].status == "pass"
    assert target.wire_transcoding and "base64" in target.wire_transcoding.lower()


def test_avro_rejects_instances_when_field_names_do_not_survive():
    # ``user-id`` is legal JSON but not a legal Avro identifier; the emitter renames it to
    # ``user_id``, so a source-valid instance carries a field the emitted schema does not
    # know (strict extra) and misses one it requires — both conformance failures.
    renamed = Type(
        key="Account",
        name="Account",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Account.user-id",
                name="user-id",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    report = _run(_api([renamed]), targets=["avro"])
    target = _target(report, "avro")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "fail"
    assert entity.failures and all(f.kind == "conformance" for f in entity.failures)


def test_avro_transcode_decodes_base64_only_where_bytes_demanded():
    schema = {
        "type": "record",
        "name": "Blob",
        "fields": [
            {"name": "payload", "type": "bytes"},
            {"name": "label", "type": "string"},
        ],
    }
    out = transcode_json_to_avro({"payload": "aGVsbG8=", "label": "aGVsbG8="}, schema, {})
    assert out["payload"] == b"hello"
    assert out["label"] == "aGVsbG8="  # untouched: the schema wants text here


def test_avro_transcode_failure_names_the_wire_rule():
    schema = {"type": "record", "name": "Blob", "fields": [{"name": "payload", "type": "bytes"}]}
    with pytest.raises(TranscodeError) as exc_info:
        transcode_json_to_avro({"payload": "not base64 !!"}, schema, {})
    assert exc_info.value.constraint == "base64"
    assert exc_info.value.pointer == "/payload"


# ===========================================================================
# Protobuf target
# ===========================================================================


def test_proto_missing_toolchain_reports_not_validated_never_a_verdict():
    with patch("app.toolchain_runner.is_tool_available", return_value=False):
        report = _run(_api(), targets=["proto3"])
    target = _target(report, "proto3")
    assert target.applicable is True
    assert target.validated is False
    assert target.valid is None
    assert "buf" in (target.detail or "")


def _buf_available() -> bool:
    from app.proto_descriptor import BUF_TOOL_KEY
    from app.toolchain_runner import is_tool_available

    return is_tool_available(BUF_TOOL_KEY)


@pytest.mark.skipif(not _buf_available(), reason="buf toolchain unavailable in this runtime")
def test_proto_accepts_faithfully_emitted_entities():
    report = _run(_api(), targets=["proto3"])
    target = _target(report, "proto3")
    assert target.validated is True
    assert target.valid is True
    assert target.entities[0].status == "pass"


@pytest.mark.skipif(not _buf_available(), reason="buf toolchain unavailable in this runtime")
def test_proto_rejects_instances_when_field_names_do_not_survive():
    renamed = Type(
        key="Account",
        name="Account",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Account.user-id",
                name="user-id",
                type=TypeRef(name="string", nullable=False),
            )
        ],
    )
    report = _run(_api([renamed]), targets=["proto3"])
    target = _target(report, "proto3")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "fail"
    assert all(f.kind == "conformance" for f in entity.failures)
    # The failing constraint names the field the compiled schema does not know.
    assert any("user-id" in f.constraint for f in entity.failures)


# ===========================================================================
# GraphQL target
# ===========================================================================


def test_graphql_coerces_instances_through_the_emitted_input_shape():
    # ``count: int32`` is deliberately absent: the GraphQL emitter only maps GraphQL's own
    # scalar spellings, so ``int32`` lands as ``String`` — a genuine conformance loss the
    # narrowing test below asserts on. This fixture keeps to shapes that survive.
    gql_widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Widget.id", name="id", type=TypeRef(name="string", nullable=False)
            ),
            CanonicalField(key="Widget.status", name="status", type=TypeRef(name="Status")),
            CanonicalField(
                key="Widget.tags", name="tags", type=TypeRef(item=TypeRef(name="string"))
            ),
        ],
    )
    api = _api([gql_widget, _status_type()], services=[_widget_service()])
    report = _run(api, targets=["graphql"])
    target = _target(report, "graphql")
    assert target.validated is True
    assert target.valid is True
    assert target.entities[0].status == "pass"
    assert target.entities[0].instances_checked >= 2


def test_graphql_reports_scalar_narrowing_as_a_conformance_failure():
    # The GraphQL emitter maps only GraphQL's own scalar spellings, so ``int32`` is
    # emitted as ``String`` — and a source-valid integer instance no longer conforms.
    # This is precisely the runtime-breaking loss IXH-5.6 exists to surface.
    api = _api(services=[_widget_service()])
    report = _run(api, targets=["graphql"])
    target = _target(report, "graphql")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "fail"
    assert any(
        f.kind == "conformance" and f.pointer == "/count" for f in entity.failures
    )


def test_graphql_types_only_model_reports_the_entity_missing():
    # With no operations the GraphQL emitter reaches no types, so the emitted SDL lost the
    # entity — an instance-level conformance loss, not a silent pass.
    report = _run(_api(), targets=["graphql"])
    target = _target(report, "graphql")
    assert target.valid is False
    assert target.entities[0].status == "missing"


def test_graphql_union_member_is_skipped_never_passing():
    # ``serial`` (not ``id``) keeps the two union branches structurally disjoint, so the
    # source ``oneOf`` projection has synthesizable instances.
    gadget = Type(
        key="Gadget",
        name="Gadget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Gadget.serial", name="serial", type=TypeRef(name="string", nullable=False)
            )
        ],
    )
    union = Type(
        key="Payload",
        name="Payload",
        kind=TypeKind.UNION,
        union_members=["Widget", "Gadget"],
    )
    holder = Type(
        key="Envelope",
        name="Envelope",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Envelope.payload", name="payload", type=TypeRef(name="Payload", nullable=False)
            )
        ],
    )
    service = Service(
        key="envelopes",
        name="envelopes",
        operations=[
            Operation(
                key="GET /envelopes/{id}",
                name="getEnvelope",
                kind=OperationKind.QUERY,
                messages=[
                    Message(
                        key="GET /envelopes/{id}#response.200",
                        role=MessageRole.RESPONSE,
                        payload=TypeRef(name="Envelope"),
                    )
                ],
            )
        ],
    )
    api = _api([holder, union, gadget, _widget_type(), _status_type()], services=[service])
    report = _run(api, targets=["graphql"])
    target = _target(report, "graphql")
    envelope = next(e for e in target.entities if e.entity == "Envelope")
    assert envelope.status == "skipped"
    assert "input representation" in (envelope.reason or "")
    assert envelope.instances_checked == 0


# ===========================================================================
# XSD target
# ===========================================================================


def _xml_result(
    *, valid: Optional[bool], validated: bool = True, findings: Optional[List[Any]] = None
) -> XmlValidationResult:
    return XmlValidationResult(valid=valid, validated=validated, findings=findings or [])


def test_xsd_valid_instances_pass_through_the_harnessed_schema():
    async def fake_validate(schema_text: str, instance_text: str, **_: Any) -> XmlValidationResult:
        # The harness must declare a global element for the entity, referencing the
        # emitted type untouched; the instance root must be that element.
        assert '<xs:element name="Widget" type="Widget"/>' in schema_text
        assert instance_text.startswith("<Widget")
        return _xml_result(valid=True)

    with patch("app.xml_instance_validation.validate_xml_instance", side_effect=fake_validate):
        report = _run(_api(), targets=["xsd"])
    target = _target(report, "xsd")
    assert target.validated is True
    assert target.valid is True
    assert target.entities[0].status == "pass"


def test_xsd_validator_findings_become_conformance_failures():
    from app.schema_instance_validation import InstanceFinding

    finding = InstanceFinding(
        pointer="/Widget",
        keyword="cvc-enumeration-valid",
        message="Element 'status': the value is not an accepted enumeration member.",
    )

    async def fake_validate(*_: Any, **__: Any) -> XmlValidationResult:
        return _xml_result(valid=False, findings=[finding])

    with patch("app.xml_instance_validation.validate_xml_instance", side_effect=fake_validate):
        report = _run(_api(), targets=["xsd"])
    target = _target(report, "xsd")
    assert target.valid is False
    entity = target.entities[0]
    assert entity.status == "fail"
    assert entity.failures[0].kind == "conformance"
    assert entity.failures[0].constraint == "cvc-enumeration-valid"


def test_xsd_missing_xmllint_reports_not_validated():
    async def fake_validate(*_: Any, **__: Any) -> XmlValidationResult:
        return _xml_result(valid=None, validated=False)

    with patch("app.xml_instance_validation.validate_xml_instance", side_effect=fake_validate):
        report = _run(_api(), targets=["xsd"])
    target = _target(report, "xsd")
    assert target.applicable is True
    assert target.validated is False
    assert target.valid is None


def test_xsd_map_member_is_a_transcode_failure_not_a_verdict():
    # A MAP-typed member has no XML wire mapping in the emitted grammar: every instance
    # fails to transcode, the validator never runs, and the target reaches no verdict —
    # transcode failures are distinguished from conformance failures end to end.
    mapping = Type(
        key="Labels",
        name="Labels",
        kind=TypeKind.MAP,
        value_type=TypeRef(name="string"),
    )
    record = Type(
        key="Tagged",
        name="Tagged",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key="Tagged.labels", name="labels", type=TypeRef(name="Labels", nullable=False)
            )
        ],
    )
    report = _run(_api([record, mapping]), targets=["xsd"])
    target = _target(report, "xsd")
    assert target.validated is True
    assert target.valid is None  # nothing was judged — never a pass, never a fail
    entity = target.entities[0]
    assert entity.status == "transcode_failed"
    assert entity.failures and all(f.kind == "transcode" for f in entity.failures)
    assert target.transcode_failures == len(entity.failures)
    assert target.conformance_failures == 0


def test_xml_transcode_mirrors_the_emitted_grammar():
    api = _api()
    xml_text = transcode_json_to_xml(
        api,
        _widget_type(),
        {"id": "w-1", "count": 3, "status": "ACTIVE", "tags": ["a", "b"]},
    )
    assert xml_text.startswith("<Widget>")
    assert "<id>w-1</id>" in xml_text
    assert "<count>3</count>" in xml_text
    assert xml_text.count("<tags>") == 2  # lists repeat the element


def test_xsd_harness_only_adds_missing_global_elements():
    load_builtin_emitters()
    schema_text = get_emitter("xsd")().emit(_api()).files[0].content
    harness = build_xsd_validation_harness(schema_text, {"Widget": "Widget"})
    assert harness is not None
    assert harness.count('name="Widget"') >= 2  # the complexType and the added element
    again = build_xsd_validation_harness(harness, {"Widget": "Widget"})
    assert again == harness  # idempotent: already-declared elements are not duplicated


# ===========================================================================
# Feeding the IXH-2.4 readiness rank
# ===========================================================================


@pytest.fixture()
def _preflight_env():
    from app.style_guide_engine import builtin_fallback_guide

    with patch("app.export_preflight.load_tenant_policy", return_value=DEFAULT_POLICY), patch(
        "app.import_export_quality_policy.load_tenant_policy", return_value=DEFAULT_POLICY
    ), patch(
        "app.import_export_quality_policy.find_active_waiver", return_value=None
    ), patch(
        "app.export_preflight.resolve_style_guide", return_value=builtin_fallback_guide()
    ):
        yield


def _preflight_source() -> ExportSource:
    return ExportSource(
        api=_api(services=[_widget_service()]),
        artifact_id="artifact-1",
        version_record_id="22222222-2222-4222-8222-222222222222",
        version_label="1.0.0",
    )


def test_preflight_attaches_conformance_beside_fidelity(_preflight_env):
    source = _preflight_source()
    report = run_export_preflight(
        source,
        ExportPreflightRequest(artifact="artifact-1", targets=["json-schema", "thrift"]),
        tenant_id=_TENANT,
    )
    enriched = asyncio.run(apply_instance_conformance(report, source.api))
    by_format = {t.format: t for t in enriched.targets}
    json_schema = by_format["json-schema"]
    assert json_schema.conformance is not None
    assert json_schema.conformance.applicable is True
    assert json_schema.fidelity is not None  # reported alongside the structural envelope
    thrift = by_format["thrift"]
    assert thrift.conformance is not None
    assert thrift.conformance.applicable is False
    assert thrift.conformance.valid is None


def test_conformance_failure_demotes_ready_targets_and_rerankings(_preflight_env):
    from app.cross_format_conformance import (
        ConformanceFailure,
        CrossFormatConformanceReport,
        EntityTargetConformance,
        TargetConformance,
    )

    source = _preflight_source()
    report = run_export_preflight(
        source,
        ExportPreflightRequest(artifact="artifact-1", targets=["json-schema", "openapi"]),
        tenant_id=_TENANT,
    )
    ready = [t for t in report.targets if t.band == "ready"]
    assert ready, "fixture expects at least one ready target"
    victim = ready[0]

    failing = TargetConformance(
        target=victim.format,
        key=victim.key,
        applicable=True,
        validated=True,
        valid=False,
        entities=[
            EntityTargetConformance(
                entity="Widget",
                status="fail",
                instances_checked=2,
                failures=[
                    ConformanceFailure(
                        instance_id="minimal",
                        kind="conformance",
                        constraint="pattern",
                        message="rejected",
                    )
                ],
            )
        ],
        instances_checked=2,
        conformance_failures=1,
        transcode_failures=0,
    )
    canned = CrossFormatConformanceReport(seed=0, entities=["Widget"], targets=[failing])

    async def fake_check(*_: Any, **__: Any) -> CrossFormatConformanceReport:
        return canned

    with patch("app.export_preflight.check_cross_format_conformance", side_effect=fake_check):
        enriched = asyncio.run(apply_instance_conformance(report, source.api))

    demoted = next(t for t in enriched.targets if t.format == victim.format)
    assert demoted.band == "caution"
    assert "Instance conformance" in demoted.rationale
    assert demoted.conformance is not None and demoted.conformance.valid is False
    # The demotion feeds the rank: bands re-sort, ranks are reassigned contiguously, and
    # the fingerprint tracks the new ordering.
    assert [t.rank for t in enriched.targets] == list(range(1, len(enriched.targets) + 1))
    caution_or_worse = [t for t in enriched.targets if t.band != "ready"]
    ready_after = [t for t in enriched.targets if t.band == "ready"]
    assert all(r.rank < c.rank for r in ready_after for c in caution_or_worse)
    if ready_after:
        assert enriched.ranking_fingerprint != report.ranking_fingerprint


def test_transcode_only_failures_never_demote(_preflight_env):
    from app.cross_format_conformance import (
        ConformanceFailure,
        CrossFormatConformanceReport,
        EntityTargetConformance,
        TargetConformance,
    )

    source = _preflight_source()
    report = run_export_preflight(
        source,
        ExportPreflightRequest(artifact="artifact-1", targets=["json-schema"]),
        tenant_id=_TENANT,
    )
    target = report.targets[0]
    transcode_only = TargetConformance(
        target=target.format,
        key=target.key,
        applicable=True,
        validated=True,
        valid=None,
        entities=[
            EntityTargetConformance(
                entity="Widget",
                status="transcode_failed",
                failures=[
                    ConformanceFailure(
                        instance_id="minimal",
                        kind="transcode",
                        constraint="xml-structure",
                        message="no wire form",
                    )
                ],
            )
        ],
        transcode_failures=1,
    )
    canned = CrossFormatConformanceReport(seed=0, entities=["Widget"], targets=[transcode_only])

    async def fake_check(*_: Any, **__: Any) -> CrossFormatConformanceReport:
        return canned

    with patch("app.export_preflight.check_cross_format_conformance", side_effect=fake_check):
        enriched = asyncio.run(apply_instance_conformance(report, source.api))
    updated = enriched.targets[0]
    assert updated.band == report.targets[0].band
    assert "Instance conformance" not in updated.rationale


# ===========================================================================
# IXH-1.7 grid coverage: every corpus source format × every production target
# ===========================================================================


def test_conformance_covers_the_roundtrip_matrix_grid():
    """The conformance dimension holds over the 1.7 grid axes.

    For every corpus source-format representative, every production emit target is
    reported with the honest applicability split: the five validatable schema languages
    are checked (or carry a reason they could not be), everything else is not-applicable,
    and nothing ever reads as passing without instances actually judged.
    """
    production_formats = {
        target.descriptor.format for target in production_emit_targets()
    }
    reps = {
        fmt: entry for fmt, entry in representatives_by_format().items() if entry is not None
    }
    assert reps, "corpus produced no runnable representatives"

    for source_format, entry in sorted(reps.items()):
        api = run_pipeline(entry).model
        report = asyncio.run(
            check_cross_format_conformance(api, max_entities=2, max_instances_per_entity=2)
        )
        reported = {t.target for t in report.targets}
        missing = production_formats - reported
        assert not missing, f"{source_format}: targets missing from the report: {missing}"
        for target in report.targets:
            label = f"{source_format} -> {target.target}"
            if target.target in VALIDATABLE_TARGET_FORMATS:
                assert target.applicable is True, label
                if not target.validated:
                    assert target.detail, f"{label}: a non-run must say why"
            else:
                assert target.applicable is False, label
                assert target.valid is None, f"{label}: not-applicable must never pass"
            if target.valid is True:
                assert target.instances_checked > 0, f"{label}: a pass needs evidence"
            if target.valid is None and target.applicable and target.validated:
                assert target.detail, f"{label}: a no-verdict must say why"
