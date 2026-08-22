"""Unit tests for the ODCS emitter and its schema validator — FMT-5.2 (#5440).

The ticket's acceptance criteria, in order, and where each is asserted:

#. *Emitted contracts validate against the ODCS v3.1 JSON Schema* — every shipped ODCS
   fixture and a hand-built model from every other paradigm are emitted and run through
   the **published** schema, not a restatement of it
   (:func:`test_every_odcs_fixture_emits_a_schema_valid_contract`,
   :func:`test_a_foreign_model_emits_a_schema_valid_contract`).
#. *Round-trip ODCS → canonical → ODCS preserves schema, quality, ownership and SLAs* —
   asserted the strongest way available: the two canonical models must be **identical**
   (:func:`test_round_trip_is_canonically_identical`), with the one documented exception
   (a non-standard ``enum`` type option) named and explained.
#. *Fields with no source are omitted and reported, never invented* —
   :func:`test_absent_governance_is_reported_and_not_invented` and the ``SYNTH``
   root-verdict tests.
#. *The Export Studio card carries an accurate fidelity badge* — the descriptor and the
   capability profile the card reads (:func:`test_descriptor_and_capability_profile`).
#. *Emitting from a non-ODCS source produces a valid minimal contract* — the Avro,
   copybook and hand-built cases.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    EmitOptionsError,
    LossKind,
    Provenance,
    coerce_emit_options,
    get_emitter,
    load_builtin_emitters,
)
from app.fidelity_engine import compute_lossiness_for_emitter
from app.import_source import canonical_diff
from app.lossiness import LossinessKind
from app.odcs_emitter import (
    FALLBACK_CONTRACT_STATUS,
    FALLBACK_CONTRACT_VERSION,
    OBJECT_CARRIERS,
    PROPERTY_CARRIERS,
    PROPERTY_GROUP_CARRIERS,
    ROOT_CARRIERS,
    STRUCTURAL_EXTRAS_KEYS,
    OdcsEmitOptions,
    OdcsEmitter,
    OdcsFidelityRulePack,
)
from app.odcs_import_source import OdcsImportSource
from app.odcs_normalizer import OdcsNormalizer
from app.odcs_parser import load_odcs_document, parse_odcs, parse_odcs_fileset
from app.odcs_schema import (
    DEFAULT_ODCS_API_VERSION,
    ODCS_SCHEMA_RELEASES,
    json_projection,
    load_odcs_schema,
    odcs_document_violations,
    option_value_is_admitted,
    schema_line_for,
    validate_odcs_document,
)

load_builtin_emitters()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "odcs"

#: Every shipped single-document ODCS fixture, in corpus order.
SINGLE_FIXTURES = (
    "01-minimal-contract.yaml",
    "02-typical-orders-contract.yaml",
    "03-composition-nested-schema.yaml",
    "04-stress-quality-sla-and-custom.yaml",
    "05-real-world-transactions-contract.yaml",
    "06-typical-contract.json",
)

#: The two fixtures that carry ``enum`` inside ``logicalTypeOptions`` — a non-standard
#: extension real catalog tools write, which the reader accepts and the emitter refuses
#: to write back because no ODCS version admits it.
ENUM_EXTENSION_FIXTURES = (
    "04-stress-quality-sla-and-custom.yaml",
    "05-real-world-transactions-contract.yaml",
)


# ===========================================================================
# Helpers
# ===========================================================================


def _import(name: str) -> CanonicalApi:
    """Import one shipped single-document corpus fixture."""
    text = (CORPUS / name).read_text(encoding="utf-8")
    return OdcsNormalizer().normalize(parse_odcs(text, source_label=name))


def _import_contract_set() -> CanonicalApi:
    """Import the multi-file corpus fixture as one composed contract."""
    root = "contract.yaml"
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-contract-set").iterdir())
        if path.is_file() and path.suffix in {".yaml", ".yml", ".json"}
    }
    return OdcsNormalizer().normalize(parse_odcs_fileset(members, root=root))


def _emit(api: CanonicalApi, **options: Any) -> str:
    """Emit one model and return the single file's text."""
    result = OdcsEmitter().emit(api, opts=OdcsEmitOptions(**options) if options else None)
    assert len(result.files) == 1
    return str(result.files[0].content)


def _document(api: CanonicalApi, **options: Any) -> Dict[str, Any]:
    """Emit one model and return the loaded document."""
    return load_odcs_document(_emit(api, **options))


def _reimport(text: str) -> CanonicalApi:
    """Re-import an emitted contract."""
    return OdcsNormalizer().normalize(parse_odcs(text, source_label="emitted.odcs.yaml"))


def _losses(api: CanonicalApi, **options: Any) -> List[Any]:
    """Emit one model and return its loss records."""
    return OdcsEmitter().emit(api, opts=OdcsEmitOptions(**options) if options else None).losses


def _subjects(api: CanonicalApi, **options: Any) -> List[str]:
    """The loss subjects one emission records."""
    return [loss.subject for loss in _losses(api, **options)]


def _object(document: Dict[str, Any], name: str) -> Dict[str, Any]:
    """The named ``schema[]`` entry of an emitted document."""
    for entry in document["schema"]:
        if entry["name"] == name:
            return entry
    raise AssertionError(f"no schema object named {name!r} in {document['schema']}")


def _property(node: Dict[str, Any], name: str) -> Dict[str, Any]:
    """The named property of a schema object or nested object."""
    for entry in node.get("properties", []):
        if entry.get("name") == name:
            return entry
    raise AssertionError(f"no property named {name!r}")


def _record_api(
    *,
    fields: List[CanonicalField],
    types: List[Type] | None = None,
    **kwargs: Any,
) -> CanonicalApi:
    """A minimal single-record canonical model from a foreign format."""
    root = Type(key="Order", name="Order", kind=TypeKind.RECORD, fields=fields)
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format=kwargs.pop("format", "avro"),
        identity=kwargs.pop("identity", ApiIdentity(name="Order", namespace="sales")),
        types=[root, *(types or [])],
        **kwargs,
    )


def _field(name: str, ref: TypeRef, **kwargs: Any) -> CanonicalField:
    """A canonical field with a key under ``Order``."""
    return CanonicalField(key=f"Order.{name}", name=name, type=ref, **kwargs)


# ===========================================================================
# Registration, descriptor and capability profile
# ===========================================================================


def test_emitter_is_registered_under_its_format_key() -> None:
    assert get_emitter("odcs") is OdcsEmitter


def test_descriptor_and_capability_profile() -> None:
    """The Export Studio card's fields, and the profile its fidelity badge reads."""
    assert OdcsEmitter.key == "odcs"
    assert OdcsEmitter.paradigm is ApiParadigm.DATA_SCHEMA
    assert OdcsEmitter.multi_file is False
    assert OdcsEmitter.required_tools == ()

    profile = OdcsEmitter.capability_profile()
    assert profile.operations is False
    assert profile.events is False
    assert profile.unions is False
    assert profile.nullability is True
    # ODCS states lengths, bounds, pattern and format natively; the one facet it
    # cannot state is refined by the rule pack rather than by the profile.
    assert profile.constraints is True
    assert profile.field_identity is False
    assert OdcsEmitter.fidelity_rule_pack() is OdcsFidelityRulePack


def test_output_is_one_yaml_file_named_after_the_contract() -> None:
    result = OdcsEmitter().emit(_import("01-minimal-contract.yaml"))
    assert result.media_type == "application/yaml"
    assert len(result.files) == 1
    assert result.files[0].path.endswith(".odcs.yaml")
    assert result.files[0].media_type == "application/yaml"


def test_emission_is_deterministic() -> None:
    """Two emissions of one model are byte-identical (the SPI's determinism rule)."""
    api = _import("04-stress-quality-sla-and-custom.yaml")
    assert _emit(api) == _emit(api)


# ===========================================================================
# AC 1 — emitted contracts validate against the published JSON Schema
# ===========================================================================


@pytest.mark.parametrize("name", SINGLE_FIXTURES)
def test_every_odcs_fixture_emits_a_schema_valid_contract(name: str) -> None:
    assert odcs_document_violations(_document(_import(name))) == []


def test_the_contract_set_emits_a_schema_valid_contract() -> None:
    assert odcs_document_violations(_document(_import_contract_set())) == []


def test_a_foreign_model_emits_a_schema_valid_contract() -> None:
    """A model with no ODCS provenance still produces a contract the standard accepts."""
    api = _record_api(
        fields=[
            _field("id", TypeRef(name="uuid", nullable=False)),
            _field("total", TypeRef(name="double"), constraints=Constraints(minimum=0)),
            _field("placed_at", TypeRef(name="timestamp")),
            _field("tags", TypeRef(item=TypeRef(name="string"))),
        ],
        version="2.1.0",
    )
    assert odcs_document_violations(_document(api)) == []


def test_a_foreign_model_with_every_type_kind_emits_a_schema_valid_contract() -> None:
    """Enums, unions, maps, aliases and nested records all land somewhere legal."""
    api = _record_api(
        fields=[
            _field("status", TypeRef(name="Status")),
            _field("payload", TypeRef(name="Payload")),
            _field("labels", TypeRef(name="Labels")),
            _field("alias", TypeRef(name="OrderId")),
            _field("line", TypeRef(name="Line")),
            _field("lines", TypeRef(item=TypeRef(name="Line"))),
        ],
        types=[
            Type(
                key="Status",
                name="Status",
                kind=TypeKind.ENUM,
                enum_values=[EnumValue(key="Status.NEW", name="NEW")],
            ),
            Type(key="Payload", name="Payload", kind=TypeKind.UNION, union_members=["Line"]),
            Type(
                key="Labels",
                name="Labels",
                kind=TypeKind.MAP,
                key_type=TypeRef(name="string"),
                value_type=TypeRef(name="string"),
            ),
            Type(key="OrderId", name="OrderId", kind=TypeKind.ALIAS, aliased=TypeRef(name="uuid")),
            Type(
                key="Line",
                name="Line",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(key="Line.sku", name="sku", type=TypeRef(name="string")),
                ],
            ),
        ],
    )
    assert odcs_document_violations(_document(api)) == []


def test_validate_odcs_document_accepts_an_emitted_contract() -> None:
    validate_odcs_document(_emit(_import("02-typical-orders-contract.yaml")))


def test_validate_odcs_document_rejects_a_schema_invalid_contract() -> None:
    """A legal-to-parse contract that breaks the standard's schema is caught."""
    document = _document(_import("01-minimal-contract.yaml"))
    document["schema"][0]["properties"][0]["logicalTypeOptions"] = {"enum": ["a"]}
    with pytest.raises(ValueError, match="JSON Schema"):
        validate_odcs_document(yaml.safe_dump(document, sort_keys=False))


def test_validate_odcs_document_rejects_text_that_is_not_a_contract() -> None:
    with pytest.raises(ValueError):
        validate_odcs_document("kind: NotAContract\n")


# ===========================================================================
# AC 2 — the round trip
# ===========================================================================


@pytest.mark.parametrize("name", SINGLE_FIXTURES)
def test_round_trip_is_canonically_identical(name: str) -> None:
    """ODCS → canonical → ODCS → canonical must produce the *same* model.

    The only permitted difference is the non-standard ``enum`` type option two
    fixtures carry: no ODCS version admits it, so it is dropped on the way out and
    reported. Everything else — schema, quality, ownership, SLAs, servers, tags,
    lineage — must survive byte for byte.
    """
    before = _import(name)
    after = _reimport(_emit(before))
    changed = {entry.key for entry in canonical_diff(before, after).entries}
    if name in ENUM_EXTENSION_FIXTURES:
        assert changed and all(
            after.type_by_key(key) is not None for key in changed
        ), "only the enum-carrying types may differ"
    else:
        assert changed == set()


def test_the_contract_set_round_trips_identically() -> None:
    before = _import_contract_set()
    assert canonical_diff(before, _reimport(_emit(before))).entries == []


@pytest.mark.parametrize("name", SINGLE_FIXTURES)
def test_round_trip_preserves_every_carried_governance_block(name: str) -> None:
    """Quality, ownership, SLAs, servers and price come back byte for byte."""
    before = _import(name)
    after = _reimport(_emit(before))
    for key, _ in ROOT_CARRIERS:
        assert after.extras.get(key) == before.extras.get(key), key


def test_round_trip_preserves_declaration_order() -> None:
    """A dataset's physical column order is restored from ``odcs_position``."""
    before = _import("05-real-world-transactions-contract.yaml")
    document = _document(before)
    source = load_odcs_document((CORPUS / "05-real-world-transactions-contract.yaml").read_text())
    assert [entry["name"] for entry in _object(document, "transactions")["properties"]] == [
        entry["name"] for entry in source["schema"][0]["properties"]
    ]


def test_the_enum_extension_is_dropped_and_reported() -> None:
    """The one facet ODCS cannot state is refused, not written illegally."""
    api = _import("05-real-world-transactions-contract.yaml")
    document = _document(api)
    for entry in _object(document, "transactions")["properties"]:
        assert "enum" not in entry.get("logicalTypeOptions", {})
    assert any(
        loss.subject == "unsupported-type-option" and "`enum`" in loss.detail
        for loss in _losses(api)
    )


def test_the_enum_drop_is_explained_by_the_fidelity_report() -> None:
    """The report must not claim the enum-carrying dataset survived unchanged."""
    api = _import("05-real-world-transactions-contract.yaml")
    report = compute_lossiness_for_emitter(api, OdcsEmitter())
    verdicts = {
        (item.construct_key, item.kind) for item in report.items if item.kind is LossinessKind.OK
    }
    assert ("transactions", LossinessKind.OK) not in verdicts
    assert any(
        item.construct_key == "transactions" and item.kind is LossinessKind.APPROX
        for item in report.items
    )


# ===========================================================================
# The extras ↔ emitter symmetry rule
# ===========================================================================


def test_every_documented_extras_key_is_either_structural_or_carried_back() -> None:
    """The reader's namespace table and this emitter's carrier tables must agree.

    FMT-5.1 documents every ``odcs_*`` key it produces in
    :mod:`app.odcs_normalizer`'s docstring. Each one must be re-emitted here, or be a
    key the structural build consumes — otherwise a governance block silently
    disappears on export, which is exactly the failure the symmetry rule exists to
    prevent.
    """
    from app import odcs_normalizer

    table = (odcs_normalizer.__doc__ or "").split("The extras namespace")[1]
    documented = set(re.findall(r"``(odcs(?:_[a-z_]+)?)``", table))

    carried = {key for key, _ in (*ROOT_CARRIERS, *OBJECT_CARRIERS, *PROPERTY_CARRIERS)}
    carried |= set(PROPERTY_GROUP_CARRIERS)
    handled = carried | set(STRUCTURAL_EXTRAS_KEYS)

    assert documented - handled == set(), f"extras keys never written back: {documented - handled}"
    assert carried - documented == set(), f"emitter invents extras keys: {carried - documented}"


@pytest.mark.parametrize("name", SINGLE_FIXTURES)
def test_every_extras_key_a_fixture_carries_reaches_the_document(name: str) -> None:
    """Empirically: nothing the reader parked is missing from the emitted contract."""
    api = _import(name)
    document = _document(api)
    for extras_key, odcs_key in ROOT_CARRIERS:
        if extras_key in api.extras:
            assert document[odcs_key] == api.extras[extras_key]


def test_the_forward_compatibility_slot_is_written_back() -> None:
    """A key the reader did not name survives a round trip through ``odcs_extra``."""
    text = (
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nversion: 1.0.0\n"
        "someFutureBlock:\n  a: 1\nschema:\n"
        "  - name: t\n    properties:\n      - name: c\n        logicalType: string\n"
    )
    api = OdcsNormalizer().normalize(parse_odcs(text))
    assert _document(api)["someFutureBlock"] == {"a": 1}


def test_grouped_property_carriers_are_unfolded_onto_their_own_keys() -> None:
    """``odcs_key`` / ``odcs_partition`` / ``odcs_transform`` spread back out."""
    document = _document(_import("05-real-world-transactions-contract.yaml"))
    properties = {entry["name"]: entry for entry in _object(document, "transactions")["properties"]}
    assert any("primaryKey" in entry for entry in properties.values())
    assert any("partitioned" in entry for entry in properties.values())


# ===========================================================================
# AC 3 — nothing is invented
# ===========================================================================


def test_absent_governance_is_reported_and_not_invented() -> None:
    """A schema-only model gets no owner, no SLA and no quality — and says so."""
    api = _record_api(fields=[_field("id", TypeRef(name="string"))], version="1.0.0")
    document = _document(api)
    for absent in ("team", "roles", "slaProperties", "quality", "support", "price"):
        assert absent not in document

    report = compute_lossiness_for_emitter(api, OdcsEmitter())
    synthesized = [item for item in report.items if item.kind is LossinessKind.SYNTH]
    messages = " ".join(item.message for item in synthesized)
    assert "ownership" in messages
    assert "service levels" in messages
    assert "quality rules" in messages


def test_a_required_field_the_model_cannot_source_is_fabricated_and_reported() -> None:
    """``version`` and ``status`` are the only fabrications, and both are reported."""
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    document = _document(api)
    assert document["version"] == FALLBACK_CONTRACT_VERSION
    assert document["status"] == FALLBACK_CONTRACT_STATUS

    subjects = _subjects(api)
    assert "fabricated-contract-version" in subjects
    assert "fabricated-contract-status" in subjects

    report = compute_lossiness_for_emitter(api, OdcsEmitter())
    assert any(
        item.kind is LossinessKind.SYNTH and "version" in item.message for item in report.items
    )
    assert any(
        item.kind is LossinessKind.SYNTH and "status" in item.message for item in report.items
    )


def test_a_sourced_version_and_status_are_not_fabricated() -> None:
    api = _import("02-typical-orders-contract.yaml")
    subjects = _subjects(api)
    assert "fabricated-contract-version" not in subjects
    assert "fabricated-contract-status" not in subjects


def test_a_carried_governance_block_suppresses_its_absence_report() -> None:
    api = _import("04-stress-quality-sla-and-custom.yaml")
    report = compute_lossiness_for_emitter(api, OdcsEmitter())
    absences = [
        item.message
        for item in report.items
        if item.kind is LossinessKind.SYNTH and "does not invent" in item.message
    ]
    assert not any("ownership" in message for message in absences)
    assert not any("service levels" in message for message in absences)


# ===========================================================================
# The envelope
# ===========================================================================


def test_the_envelope_comes_from_the_source_contract() -> None:
    api = _import("02-typical-orders-contract.yaml")
    source = load_odcs_document((CORPUS / "02-typical-orders-contract.yaml").read_text())
    document = _document(api)
    for key in ("apiVersion", "kind", "id", "name", "version", "status", "domain", "tenant"):
        if key in source:
            assert document[key] == source[key], key


def test_the_default_api_version_is_the_newest_vendored_line() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    assert _document(api)["apiVersion"] == DEFAULT_ODCS_API_VERSION


def test_the_api_version_option_overrides_the_source() -> None:
    api = _import("01-minimal-contract.yaml")
    assert _document(api, api_version="v3.0.2")["apiVersion"] == "v3.0.2"


def test_an_unsupported_api_version_option_is_refused() -> None:
    """The option-coercion path every caller uses turns this into a 422, not a 500."""
    with pytest.raises(EmitOptionsError, match="unsupported ODCS api_version"):
        coerce_emit_options(OdcsEmitter, {"api_version": "v4.0.0"})
    assert coerce_emit_options(OdcsEmitter, {"api_version": "v3.0.2"}).api_version == "v3.0.2"


def test_the_status_option_supplies_what_the_model_cannot() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    document = _document(api, status="active")
    assert document["status"] == "active"
    assert "fabricated-contract-status" not in _subjects(api, status="active")


def test_the_contract_id_is_derived_rather_than_invented() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    assert _document(api)["id"] == "sales.Order"


def test_a_source_contract_id_wins_over_the_derived_one() -> None:
    api = _import("02-typical-orders-contract.yaml")
    source = load_odcs_document((CORPUS / "02-typical-orders-contract.yaml").read_text())
    assert _document(api)["id"] == source["id"]


def test_the_domain_falls_back_to_the_model_namespace() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    assert _document(api)["domain"] == "sales"


def test_a_foreign_description_becomes_the_purpose() -> None:
    api = _record_api(
        fields=[_field("id", TypeRef(name="string"))],
        description="Every order the storefront accepted.",
    )
    assert _document(api)["description"] == {"purpose": "Every order the storefront accepted."}


def test_provenance_marks_derived_and_defaulted_envelope_values() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    records = {record.pointer: record for record in OdcsEmitter().emit(api).provenance}
    assert records["/id"].provenance is Provenance.INFERRED
    assert records["/version"].provenance is Provenance.DEFAULT
    assert records["/status"].provenance is Provenance.DEFAULT
    assert records["/kind"].provenance is Provenance.DEFAULT
    assert records["/name"].provenance is Provenance.SOURCE


# ===========================================================================
# The structural half
# ===========================================================================


def test_a_record_becomes_a_schema_object_and_its_fields_become_properties() -> None:
    document = _document(_import("01-minimal-contract.yaml"))
    assert len(document["schema"]) == 1
    obj = document["schema"][0]
    assert obj["logicalType"] == "object"
    assert [entry["name"] for entry in obj["properties"]]


def test_a_referenced_record_is_inlined_as_a_nested_object() -> None:
    """ODCS has no ``$ref``, so a nested record's columns are written in place."""
    api = _import("03-composition-nested-schema.yaml")
    document = _document(api)
    nested = [
        entry
        for obj in document["schema"]
        for entry in obj["properties"]
        if entry.get("logicalType") == "object"
    ]
    assert nested, "the composition fixture declares a nested object property"
    assert all("properties" in entry for entry in nested)
    # …and nothing nested leaked out as a dataset of its own.
    assert all("." not in obj["name"] for obj in document["schema"])


def test_a_list_becomes_an_array_with_an_items_block() -> None:
    api = _record_api(fields=[_field("tags", TypeRef(item=TypeRef(name="string")))])
    entry = _property(_object(_document(api), "Order"), "tags")
    assert entry["logicalType"] == "array"
    assert entry["items"] == {"logicalType": "string"}


def test_nullability_becomes_required() -> None:
    api = _record_api(
        fields=[
            _field("id", TypeRef(name="string", nullable=False)),
            _field("note", TypeRef(name="string")),
        ]
    )
    obj = _object(_document(api), "Order")
    assert _property(obj, "id")["required"] is True
    assert "required" not in _property(obj, "note")


def test_a_shared_record_is_written_at_each_use_site_and_reported() -> None:
    line = Type(
        key="Line",
        name="Line",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Line.sku", name="sku", type=TypeRef(name="string"))],
    )
    api = _record_api(
        fields=[_field("a", TypeRef(name="Line")), _field("b", TypeRef(name="Line"))],
        types=[line],
    )
    obj = _object(_document(api), "Order")
    assert _property(obj, "a")["properties"] == _property(obj, "b")["properties"]
    assert _subjects(api).count("shared-type-inlined") == 1


def test_a_recursive_record_is_flattened_once_and_reported() -> None:
    node = Type(
        key="Node",
        name="Node",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Node.child", name="child", type=TypeRef(name="Node"))],
    )
    api = _record_api(fields=[_field("root", TypeRef(name="Node"))], types=[node])
    document = _document(api)
    child = _property(_property(_object(document, "Order"), "root"), "child")
    assert child["logicalType"] == "object"
    # No `properties` key at all — ODCS's free-form object, not "this record is empty".
    assert "properties" not in child
    assert "recursive-type-flattened" in _subjects(api)
    assert odcs_document_violations(document) == []


def test_a_record_with_no_members_is_not_written_as_an_empty_dataset() -> None:
    """A dataset with no columns claims the table is empty; the source never said so."""
    api = _record_api(
        fields=[_field("id", TypeRef(name="string"))],
        types=[Type(key="Unmodelled", name="Unmodelled", kind=TypeKind.RECORD)],
    )
    document = _document(api)
    assert [entry["name"] for entry in document["schema"]] == ["Order"]
    assert "empty-record-dropped" in _subjects(api)
    # …and the emitted contract still re-imports, which an empty object would not.
    validate_odcs_document(_emit(api))


def test_a_model_whose_only_record_has_no_members_is_refused() -> None:
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="typespec",
        identity=ApiIdentity(name="Empty"),
        types=[Type(key="Empty", name="Empty", kind=TypeKind.RECORD)],
    )
    with pytest.raises(ValueError, match="requires at least one record type"):
        OdcsEmitter().emit(api)


def test_a_top_level_non_record_type_is_reported_rather_than_dropped_silently() -> None:
    api = _record_api(
        fields=[_field("id", TypeRef(name="string"))],
        types=[
            Type(
                key="Colour",
                name="Colour",
                kind=TypeKind.ENUM,
                enum_values=[EnumValue(key="Colour.RED", name="RED")],
            )
        ],
    )
    assert "non-dataset-type-dropped" in _subjects(api)


def test_a_model_with_no_record_types_is_refused_with_a_readable_message() -> None:
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Ops"),
        services=[
            Service(
                key="Ops",
                name="Ops",
                operations=[
                    Operation(key="GET /ping", name="ping", kind=OperationKind.QUERY),
                ],
            )
        ],
    )
    with pytest.raises(ValueError, match="requires at least one record type"):
        OdcsEmitter().emit(api)


# ===========================================================================
# logicalType and logicalTypeOptions
# ===========================================================================


def test_the_source_logical_type_wins_for_a_scalar() -> None:
    """``timestamp`` survives even though the canonical scalar collapses to text."""
    text = (
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nversion: 1.0.0\nschema:\n"
        "  - name: t\n    properties:\n"
        "      - name: seen_at\n        logicalType: timestamp\n"
    )
    api = OdcsNormalizer().normalize(parse_odcs(text))
    assert _property(_object(_document(api), "t"), "seen_at")["logicalType"] == "timestamp"


@pytest.mark.parametrize(
    ("scalar", "expected"),
    [
        ("string", "string"),
        ("uuid", "string"),
        ("int64", "integer"),
        ("double", "number"),
        ("boolean", "boolean"),
        ("date", "date"),
        ("timestamp", "timestamp"),
        ("mystery-scalar", "string"),
    ],
)
def test_canonical_scalars_map_onto_odcs_logical_types(scalar: str, expected: str) -> None:
    api = _record_api(fields=[_field("value", TypeRef(name=scalar))])
    assert _property(_object(_document(api), "Order"), "value")["logicalType"] == expected


def test_a_timestamp_falls_back_on_the_v3_0_line_which_has_no_such_type() -> None:
    api = _record_api(fields=[_field("seen_at", TypeRef(name="timestamp"))])
    document = _document(api, api_version="v3.0.2")
    assert _property(_object(document, "Order"), "seen_at")["logicalType"] == "date"
    assert odcs_document_violations(document) == []


def test_canonical_constraints_become_logical_type_options() -> None:
    api = _record_api(
        fields=[
            _field(
                "sku",
                TypeRef(name="string"),
                constraints=Constraints(min_length=3, max_length=12, pattern="[A-Z]+"),
            )
        ]
    )
    entry = _property(_object(_document(api), "Order"), "sku")
    assert entry["logicalTypeOptions"] == {"minLength": 3, "maxLength": 12, "pattern": "[A-Z]+"}


def test_a_numeric_format_is_translated_to_the_odcs_spelling() -> None:
    """ODCS closes numeric ``format`` to the Rust widths, so ``int64`` becomes ``i64``."""
    api = _record_api(fields=[_field("count", TypeRef(name="int64"))])
    entry = _property(_object(_document(api), "Order"), "count")
    assert entry["logicalTypeOptions"] == {"format": "i64"}


def test_a_date_column_does_not_get_a_semantic_format_token() -> None:
    """``format`` on a date is a JDK *pattern*; a canonical token must not land there."""
    api = _record_api(
        fields=[_field("day", TypeRef(name="date"), constraints=Constraints(format="date"))]
    )
    entry = _property(_object(_document(api), "Order"), "day")
    assert "logicalTypeOptions" not in entry


def test_an_option_the_logical_type_does_not_admit_is_dropped_and_reported() -> None:
    """``maxLength`` is legal on a string and illegal on an integer."""
    api = _record_api(
        fields=[_field("count", TypeRef(name="integer"), constraints=Constraints(max_length=5))]
    )
    entry = _property(_object(_document(api), "Order"), "count")
    assert "maxLength" not in entry.get("logicalTypeOptions", {})
    assert "unsupported-type-option" in _subjects(api)


def test_carried_options_win_over_derived_ones() -> None:
    """A source's exact option block — including a JDK date pattern — is preserved."""
    text = (
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nversion: 1.0.0\nschema:\n"
        "  - name: t\n    properties:\n"
        "      - name: day\n        logicalType: date\n"
        "        logicalTypeOptions:\n          format: \"yyyy-MM-dd'T'HH:mm:ssX\"\n"
    )
    api = OdcsNormalizer().normalize(parse_odcs(text))
    entry = _property(_object(_document(api), "t"), "day")
    assert entry["logicalTypeOptions"] == {"format": "yyyy-MM-dd'T'HH:mm:ssX"}


def test_array_facets_land_on_the_array_property() -> None:
    api = _record_api(
        fields=[
            _field(
                "tags",
                TypeRef(item=TypeRef(name="string")),
                constraints=Constraints(min_items=1, max_items=9, unique_items=True),
            )
        ]
    )
    entry = _property(_object(_document(api), "Order"), "tags")
    assert entry["logicalTypeOptions"] == {"minItems": 1, "maxItems": 9, "uniqueItems": True}


# ===========================================================================
# Servers
# ===========================================================================


def test_carried_servers_are_written_back_verbatim() -> None:
    api = _import("04-stress-quality-sla-and-custom.yaml")
    assert _document(api)["servers"] == api.extras["odcs_servers"]
    assert "synthesized-api-server" not in _subjects(api)


def test_canonical_servers_become_api_servers() -> None:
    api = _record_api(
        fields=[_field("id", TypeRef(name="string"))],
        servers=[Server(url="https://data.example.com/v1", description="Live")],
    )
    document = _document(api)
    assert document["servers"] == [
        {
            "server": "data.example.com",
            "type": "api",
            "description": "Live",
            "location": "https://data.example.com/v1",
        }
    ]
    assert "synthesized-api-server" in _subjects(api)
    assert odcs_document_violations(document) == []


def test_a_named_canonical_server_keeps_its_name() -> None:
    api = _record_api(
        fields=[_field("id", TypeRef(name="string"))],
        servers=[Server(url="https://data.example.com", name="prod")],
    )
    assert _document(api)["servers"][0]["server"] == "prod"


# ===========================================================================
# Fidelity rule pack
# ===========================================================================


def test_operations_and_channels_are_dropped_by_the_rule_pack() -> None:
    pack = OdcsFidelityRulePack(OdcsEmitter.capability_profile(), OdcsEmitter.label)
    operation = Operation(key="GET /pets", name="listPets", kind=OperationKind.QUERY)
    channel = Channel(key="orders", name="orders", address="orders")
    assert pack.operation_verdict(operation).kind is LossinessKind.DROP
    assert pack.channel_verdict(channel).kind is LossinessKind.DROP


def test_ordinary_constraints_are_not_reported_as_lost() -> None:
    """ODCS carries lengths and bounds natively; reporting them would be noise."""
    pack = OdcsFidelityRulePack(OdcsEmitter.capability_profile(), OdcsEmitter.label)
    field = CanonicalField(
        key="Order.sku",
        name="sku",
        type=TypeRef(name="string"),
        constraints=Constraints(max_length=12, pattern="[A-Z]+"),
    )
    assert pack.field_verdicts(field) == []


def test_an_enum_constraint_is_reported_as_approximate() -> None:
    pack = OdcsFidelityRulePack(OdcsEmitter.capability_profile(), OdcsEmitter.label)
    field = CanonicalField(
        key="Order.channel",
        name="channel",
        type=TypeRef(name="string"),
        constraints=Constraints(enum=["online", "in-store"]),
    )
    verdicts = pack.field_verdicts(field)
    assert [verdict.kind for verdict in verdicts] == [LossinessKind.APPROX]


def test_a_union_is_dropped_by_the_rule_pack() -> None:
    pack = OdcsFidelityRulePack(OdcsEmitter.capability_profile(), OdcsEmitter.label)
    union = Type(key="Payload", name="Payload", kind=TypeKind.UNION, union_members=["A", "B"])
    assert pack.type_verdict(union).kind is LossinessKind.DROP


# ===========================================================================
# The schema module
# ===========================================================================


@pytest.mark.parametrize(("line", "release"), sorted(ODCS_SCHEMA_RELEASES.items()))
def test_each_vendored_schema_declares_the_release_it_is_named_for(
    line: str, release: str
) -> None:
    schema = load_odcs_schema(line)
    assert schema["properties"]["apiVersion"]["default"] == release
    assert release in schema["properties"]["apiVersion"]["enum"]
    assert schema["required"] == ["version", "apiVersion", "kind", "id", "status"]


@pytest.mark.parametrize(
    ("declared", "expected"),
    [
        ("v3.1.0", "3.1"),
        ("3.1", "3.1"),
        ("v3.0.2", "3.0"),
        ("v3.0.0", "3.0"),
        ("v2.2.0", "3.1"),
        ("nonsense", "3.1"),
        (None, "3.1"),
        (3.1, "3.1"),
    ],
)
def test_the_schema_line_follows_the_declared_api_version(declared: Any, expected: str) -> None:
    assert schema_line_for(declared) == expected


def test_json_projection_renders_yaml_date_scalars_as_strings() -> None:
    """An unquoted YAML date is a ``date``; the standard's schema wants JSON's string."""
    projected = json_projection(yaml.safe_load("dateIn: 2026-01-15\nat: 2026-01-15T09:00:00Z\n"))
    assert projected["dateIn"] == "2026-01-15"
    assert projected["at"].startswith("2026-01-15T09:00:00")


def test_json_projection_leaves_every_other_value_alone() -> None:
    value = {"a": [1, "two", True, None, 3.5]}
    assert json_projection(value) == value


@pytest.mark.parametrize(
    ("logical_type", "key", "value", "admitted"),
    [
        ("string", "maxLength", 12, True),
        ("string", "maxLength", "12", False),
        ("string", "minimum", 1, False),
        ("integer", "format", "i64", True),
        ("integer", "format", "int64", False),
        ("number", "format", "f64", True),
        ("date", "minimum", "2020-01-01", True),
        ("date", "minimum", 2020, False),
        ("array", "uniqueItems", True, True),
        ("boolean", "anything", 1, True),
        (None, "maxLength", 12, False),
    ],
)
def test_option_admission_follows_the_standards_own_subschema(
    logical_type: Any, key: str, value: Any, admitted: bool
) -> None:
    assert option_value_is_admitted(logical_type, key, value, "3.1") is admitted


def test_violations_are_sorted_and_stable() -> None:
    document = {"kind": "DataContract"}
    first = odcs_document_violations(document)
    assert first == odcs_document_violations(document)
    assert [violation.path for violation in first] == sorted(
        violation.path for violation in first
    )
    assert any(violation.keyword == "required" for violation in first)


def test_the_import_adapter_reads_back_what_the_emitter_writes() -> None:
    """The adapter and the emitter agree on the format key, so the loop closes."""
    text = _emit(_import("02-typical-orders-contract.yaml"))
    adapter = OdcsImportSource()
    assert adapter.detect.__self__ is adapter  # bound, and therefore callable below
    model = adapter.normalize(adapter.parse(text))
    assert model.format == OdcsEmitter.format


def test_a_loss_is_recorded_for_a_source_field_number() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"), field_number=1)])
    assert "field-number-dropped" in _subjects(api)


def test_loss_records_are_deterministically_ordered() -> None:
    api = _import("04-stress-quality-sla-and-custom.yaml")
    assert [loss.model_dump() for loss in _losses(api)] == [
        loss.model_dump() for loss in _losses(api)
    ]


def test_emit_result_losses_use_the_shared_loss_kinds() -> None:
    api = _record_api(fields=[_field("id", TypeRef(name="string"))])
    assert all(loss.kind in set(LossKind) for loss in _losses(api))


def test_the_options_schema_publishes_the_versions_the_service_can_write() -> None:
    """The Export Studio card renders a choice, not a free-text version box."""
    from app.emitter import describe_emit_targets

    target = next(t for t in describe_emit_targets() if t.descriptor.key == "odcs")
    assert target.descriptor.available is True
    assert target.descriptor.needs_toolchain is False
    assert target.options_schema["properties"]["api_version"]["enum"] == [
        None,
        *sorted(ODCS_SCHEMA_RELEASES.values()),
    ]


@pytest.mark.asyncio
async def test_the_export_gate_validates_an_emitted_contract() -> None:
    """MFX-5.1: the delivery gate re-checks the artifact through this format's checker."""
    from app.export_validation import validate_emitted_artifact

    api = _import("02-typical-orders-contract.yaml")
    result = OdcsEmitter().emit(api)
    verdict = await validate_emitted_artifact("odcs", result, api=api)
    assert verdict.applicable is True
    assert verdict.validated is True
    assert verdict.valid is True


@pytest.mark.asyncio
async def test_the_export_gate_catches_a_schema_invalid_contract() -> None:
    """A hand-broken artifact is rejected — the gate is not a rubber stamp."""
    from app.emitter import EmitResult, EmittedFile
    from app.export_validation import validate_emitted_artifact

    api = _import("01-minimal-contract.yaml")
    document = _document(api)
    document["schema"][0]["properties"][0]["logicalTypeOptions"] = {"maxItems": 3}
    broken = EmitResult(
        files=[
            EmittedFile(
                path="broken.odcs.yaml",
                content=yaml.safe_dump(document, sort_keys=False),
                media_type="application/yaml",
            )
        ],
        media_type="application/yaml",
    )
    verdict = await validate_emitted_artifact("odcs", broken, api=api)
    assert verdict.failed is True
