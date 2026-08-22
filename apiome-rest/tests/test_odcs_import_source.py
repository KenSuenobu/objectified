"""Unit tests for the ODCS ImportSource — FMT-5.1 (#5439).

Organised around the ticket's five acceptance criteria:

#. a v3.1 contract imports, with schema objects becoming canonical types;
#. quality rules, ownership, SLAs and servers survive in ``extras`` under a documented
   namespace, and reach the catalog detail view as coverage rows;
#. a v2.2.x document is rejected with a version-out-of-range taxonomy code and
   actionable text, not a parse error;
#. the shipped corpus covers the full example, a minimal contract and a malformed one;
#. the capability registry declares what is modelled and what is carried-but-not-modelled.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import pytest
import yaml

from app.apiblueprint_parser import is_apiblueprint
from app.canonical_model import ApiIdentity, ApiParadigm, CanonicalApi, TypeKind
from app.fileset import IntakeFileset
from app.format_capability_registry import (
    CapabilityProvenance,
    ProjectionCoverage,
    capability_for,
)
from app.format_version_coverage import VersionSupport, version_coverage_for
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_routing import ImportTarget, decide_import_routing
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)
from app.odcs_contract import (
    LIMIT_DETAILS,
    MAX_PROPERTY_DEPTH,
    LimitRecorder,
    OdcsParseError,
    resolve_api_version,
)
from app.odcs_import_source import ODCS_CAPABILITIES, OdcsImportSource
from app.odcs_normalizer import ODCS_EXTRAS_KEY, ODCS_LOGICAL_SCALARS
from app.odcs_parser import is_odcs, is_odcs_document, parse_odcs, parse_odcs_fileset

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "odcs"

#: The smallest contract that exercises the envelope, a schema object and a property.
MINIMAL = """
apiVersion: v3.1.0
kind: DataContract
name: pings
version: 1.0.0
schema:
  - name: pings
    properties:
      - name: id
        logicalType: string
        required: true
"""


@pytest.fixture()
def adapter() -> OdcsImportSource:
    """The registered ODCS adapter."""
    return get_import_source("odcs")


def _fixture(name: str) -> str:
    """Return a shipped corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _negative(name: str) -> str:
    """Return a shipped negative fixture's text."""
    return (CORPUS / "negative" / name).read_text(encoding="utf-8")


def _model(name: str) -> CanonicalApi:
    """Import one shipped fixture end to end."""
    source = get_import_source("odcs")
    return source.normalize(source.parse(_fixture(name), source_label=name))


def _contract_set() -> IntakeFileset:
    """Return the shipped three-file contract set as an intake fileset."""
    members: Dict[str, str] = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "07-contract-set").iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root="contract.yaml")


def _type(model: CanonicalApi, key: str):
    """Return one named type from a canonical model."""
    found = model.type_by_key(key)
    assert found is not None, f"no type {key!r} in {[item.key for item in model.types]}"
    return found


def _field(model: CanonicalApi, type_key: str, field_name: str):
    """Return one named field of one named type from a canonical model."""
    return next(field for field in _type(model, type_key).fields if field.name == field_name)


# ===========================================================================
# Registration and detection
# ===========================================================================


def test_adapter_is_registered_as_a_data_schema_reader(adapter: OdcsImportSource) -> None:
    assert adapter.key == "odcs"
    assert adapter.paradigm is ApiParadigm.DATA_SCHEMA
    assert adapter.formats == ("odcs",)
    assert ".yaml" in adapter.file_extensions and ".json" in adapter.file_extensions
    assert adapter.supports_live_discovery is False


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-contract.yaml",
        "02-typical-orders-contract.yaml",
        "03-composition-nested-schema.yaml",
        "04-stress-quality-sla-and-custom.yaml",
        "05-real-world-transactions-contract.yaml",
        "06-typical-contract.json",
    ],
)
def test_every_valid_fixture_is_claimed_at_the_manifest_confidence(
    adapter: OdcsImportSource, name: str
) -> None:
    result = adapter.detect(DetectionInput(text=_fixture(name), filename=name))
    assert result.matched
    assert result.confidence >= 0.9
    assert result.format == "odcs"


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-contract.yaml",
        "02-typical-orders-contract.yaml",
        "03-composition-nested-schema.yaml",
        "04-stress-quality-sla-and-custom.yaml",
        "05-real-world-transactions-contract.yaml",
        "06-typical-contract.json",
    ],
)
def test_registry_detection_routes_every_fixture_to_odcs(name: str) -> None:
    """The whole registry, not just this adapter, must pick ODCS for these documents."""
    best = detect_import_source(DetectionInput(text=_fixture(name), filename=name))
    assert best is not None and best[0].key == "odcs"


def test_detection_claims_the_envelope_and_nothing_else() -> None:
    """The structural half is shared with dbt and friends; only the envelope claims."""
    assert is_odcs(MINIMAL)
    assert not is_odcs(_negative("04-wrong-format-dbt-schema.yml"))
    assert not is_odcs("schema:\n  - name: orders\n    properties: []\n")
    assert not is_odcs("")


def test_detection_claims_a_malformed_contract_that_carries_the_envelope() -> None:
    """A broken ODCS document is ours to reject as malformed, not somebody else's format."""
    assert is_odcs(_negative("01-syntactic-bad-yaml-indent.yaml"))


def test_detection_claims_the_v2_line_so_it_can_be_rejected_by_version() -> None:
    assert is_odcs(_negative("06-version-out-of-range-v2.yaml"))
    assert is_odcs_document({"kind": "DataContract", "apiVersion": "v2.2.2"})


def test_detection_is_case_insensitive_on_kind() -> None:
    assert is_odcs_document({"kind": " datacontract ", "apiVersion": "v3.1.0"})
    assert not is_odcs_document({"kind": "CustomResourceDefinition", "apiVersion": "v1"})
    assert not is_odcs_document({"kind": "DataContract"})
    assert not is_odcs_document(["not", "a", "mapping"])


def test_api_blueprint_no_longer_claims_a_yaml_format_key() -> None:
    """FMT-5.1 narrowed `is_apiblueprint`.

    API Blueprint's marker is ``FORMAT: 1A`` at column zero. The previous sniff matched
    ``format:`` at any indentation with any value, so an ODCS server's ``format: parquet``
    (and a JSON-Schema ``format: int32``) claimed the document as a blueprint.
    """
    assert not is_apiblueprint("servers:\n  - server: lake\n    format: parquet\n")
    assert not is_apiblueprint("properties:\n  age:\n    format: int32\n")
    assert is_apiblueprint("FORMAT: 1A\nHOST: https://example.com\n\n# Task API\n")
    assert is_apiblueprint("format: 1a9\n\n# Task API\n")


# ===========================================================================
# AC 1 — a v3.1 contract imports, schema objects become canonical types
# ===========================================================================


def test_a_schema_object_becomes_one_record_type() -> None:
    model = _model("01-minimal-contract.yaml")
    assert model.paradigm is ApiParadigm.DATA_SCHEMA
    assert model.format == "odcs"
    assert [item.key for item in model.types] == ["beacon_pings"]
    beacon = _type(model, "beacon_pings")
    assert beacon.kind is TypeKind.RECORD
    assert [field.name for field in beacon.fields] == ["beacon_id", "seen_at"]


def test_contract_identity_versioning_and_description_reach_canonical_fields() -> None:
    model = _model("02-typical-orders-contract.yaml")
    assert model.identity.name == "orders"
    assert model.identity.namespace == "commerce"
    assert model.identity.id == "0f6d2f0e-1b2c-4a5e-9f2a-000000000002"
    assert model.version == "2.3.0"
    assert model.title == "orders"
    assert model.description == "Serve settled order facts to finance and merchandising."


def test_required_becomes_nullability() -> None:
    model = _model("02-typical-orders-contract.yaml")
    assert _field(model, "orders", "order_id").type.nullable is False
    assert _field(model, "orders", "customer_id").type.nullable is False


def test_logical_types_map_onto_canonical_scalars() -> None:
    model = _model("02-typical-orders-contract.yaml")
    assert _field(model, "orders", "order_id").type.name == "string"
    assert _field(model, "orders", "placed_at").type.name == "date"
    assert _field(model, "orders", "total_amount").type.name == "number"
    assert set(ODCS_LOGICAL_SCALARS) == {
        "string",
        "date",
        "number",
        "integer",
        "boolean",
    }


def test_a_property_with_no_logical_type_falls_back_to_string_rather_than_guessing() -> None:
    """`physicalType` is dialect-specific; guessing from it is what `odcs.physical_type` refuses."""
    contract = parse_odcs(
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n"
        "  - name: t\n    properties:\n      - name: c\n        physicalType: numeric(9,3)\n"
    )
    model = get_import_source("odcs").normalize(contract)
    assert _field(model, "t", "c").type.name == "string"
    assert _field(model, "t", "c").extras["odcs_physical_type"] == "numeric(9,3)"


def test_a_nested_object_property_becomes_a_record_keyed_by_its_path() -> None:
    model = _model("03-composition-nested-schema.yaml")
    address = _field(model, "customers", "address")
    assert address.type.name == "customers.address"
    nested = _type(model, "customers.address")
    assert nested.kind is TypeKind.RECORD
    assert [field.name for field in nested.fields] == ["city", "country_code", "line1", "line2"]
    assert _field(model, "customers.address", "line2").type.nullable is True


def test_an_array_of_objects_becomes_a_list_around_a_synthesized_record() -> None:
    model = _model("03-composition-nested-schema.yaml")
    contact_points = _field(model, "customers", "contact_points")
    assert contact_points.type.is_list()
    assert contact_points.type.item is not None
    assert contact_points.type.item.name == "customers.contact_points.items"
    element = _type(model, "customers.contact_points.items")
    assert [field.name for field in element.fields] == ["channel", "value", "verified"]


def test_an_array_of_scalars_becomes_a_list_of_that_scalar() -> None:
    model = _model("03-composition-nested-schema.yaml")
    scores = _field(model, "customers", "segment_scores")
    assert scores.type.is_list()
    assert scores.type.item is not None and scores.type.item.name == "number"


def test_two_schema_objects_in_one_contract_become_two_types() -> None:
    model = _model("03-composition-nested-schema.yaml")
    assert {"customers", "customer_consents"} <= {item.key for item in model.types}


def test_declaration_order_survives_canonical_ordering() -> None:
    """Canonical ordering sorts by key; a dataset's column order is physical, so it is recorded."""
    model = _model("02-typical-orders-contract.yaml")
    by_position = sorted(
        _type(model, "orders").fields, key=lambda field: field.extras["odcs_position"]
    )
    assert [field.name for field in by_position] == [
        "order_id",
        "customer_id",
        "placed_at",
        "status",
        "total_amount",
        "currency",
    ]


def test_the_json_serialization_reads_identically_to_the_yaml_one() -> None:
    """AC: "the same envelope, so both must import identically"."""
    source = get_import_source("odcs")
    as_json = _fixture("06-typical-contract.json")
    as_yaml = yaml.safe_dump(yaml.safe_load(as_json), sort_keys=False)
    from_json = source.normalize(source.parse(as_json), include_raw=False)
    from_yaml = source.normalize(source.parse(as_yaml), include_raw=False)
    assert canonical_fingerprint(from_json) == canonical_fingerprint(from_yaml)


def test_the_import_is_routed_to_the_catalog_and_is_not_publishable(
    adapter: OdcsImportSource,
) -> None:
    decision = decide_import_routing(adapter, _model("01-minimal-contract.yaml"))
    assert decision.target is ImportTarget.CATALOG
    assert decision.publishable is False


def test_lint_produces_a_report(adapter: OdcsImportSource) -> None:
    assert adapter.lint(_model("05-real-world-transactions-contract.yaml")) is not None


# ===========================================================================
# Constraints — the portable half of ODCS typing
# ===========================================================================


def test_logical_type_options_become_canonical_constraints() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    event_id = _field(model, "events", "event_id")
    assert event_id.constraints is not None
    assert event_id.constraints.min_length == 36
    assert event_id.constraints.max_length == 36
    assert event_id.constraints.format == "uuid"

    latency = _field(model, "events", "latency_ms")
    assert latency.constraints is not None
    assert latency.constraints.minimum == 0
    assert latency.constraints.maximum == 600000


def test_an_enum_option_becomes_a_canonical_enum_constraint() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    severity = _field(model, "events", "severity")
    assert severity.constraints is not None
    assert severity.constraints.enum == ["debug", "info", "warn", "error", "fatal"]


def test_a_free_form_date_pattern_is_not_passed_off_as_a_canonical_format() -> None:
    """`format` holds either a token or a Java date pattern; only tokens mean the same thing."""
    model = _model("04-stress-quality-sla-and-custom.yaml")
    emitted_at = _field(model, "events", "emitted_at")
    assert emitted_at.constraints is None or emitted_at.constraints.format is None
    assert (
        emitted_at.extras["odcs_logical_type_options"]["format"]
        == "yyyy-MM-dd'T'HH:mm:ssX"
    )


def test_physical_type_is_carried_and_never_interpreted() -> None:
    """`varchar(20)` must not become `maxLength: 20` — the unit differs by dialect."""
    model = _model("02-typical-orders-contract.yaml")
    order_id = _field(model, "orders", "order_id")
    assert order_id.extras["odcs_physical_type"] == "varchar(20)"
    assert order_id.constraints is None or order_id.constraints.max_length is None


# ===========================================================================
# AC 2 — the documented extras namespace
# ===========================================================================


def test_governance_blocks_survive_verbatim_under_the_documented_namespace() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    raw = yaml.safe_load(_fixture("04-stress-quality-sla-and-custom.yaml"))
    for source_key, extras_key in (
        ("servers", "odcs_servers"),
        ("team", "odcs_team"),
        ("roles", "odcs_roles"),
        ("support", "odcs_support"),
        ("slaProperties", "odcs_sla_properties"),
        ("price", "odcs_price"),
        ("tags", "odcs_tags"),
        ("customProperties", "odcs_custom_properties"),
    ):
        assert model.extras[extras_key] == raw[source_key], extras_key
    assert model.extras["odcs_sla_default_element"] == raw["slaDefaultElement"]
    assert model.extras["odcs_description"] == raw["description"]


def test_quality_rules_are_carried_verbatim_at_every_level() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    raw = yaml.safe_load(_fixture("04-stress-quality-sla-and-custom.yaml"))
    events = raw["schema"][0]
    assert _type(model, "events").extras["odcs_quality"] == events["quality"]
    severity = next(p for p in events["properties"] if p["name"] == "severity")
    assert _field(model, "events", "severity").extras["odcs_quality"] == severity["quality"]
    # All four rule kinds are exercised by this fixture and none is rewritten.
    kinds = {
        rule.get("type", "library")
        for rule in _type(model, "events").extras["odcs_quality"]
        + _field(model, "events", "latency_ms").extras["odcs_quality"]
        + _field(model, "events", "severity").extras["odcs_quality"]
    }
    assert kinds == {"library", "sql", "text", "custom"}


def test_field_governance_reaches_its_own_extras_keys() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    pii = _field(model, "events", "pii_email")
    assert pii.extras["odcs_classification"] == "restricted"
    assert pii.extras["odcs_critical_data_element"] is True
    assert pii.extras["odcs_encrypted_name"] == "pii_email_enc"
    assert pii.extras["odcs_transform"] == {
        "transformSourceObjects": ["crm.customers"],
        "transformLogic": "sha256(lower(trim(email)))",
        "transformDescription": "Hashed at ingest; the raw value never lands.",
    }
    emitted_at = _field(model, "events", "emitted_at")
    assert emitted_at.extras["odcs_partition"] == {
        "partitioned": True,
        "partitionKeyPosition": 1,
    }
    assert _field(model, "events", "event_id").extras["odcs_key"] == {
        "unique": True,
        "primaryKey": True,
        "primaryKeyPosition": 1,
    }


def test_examples_and_authoritative_definitions_are_carried() -> None:
    orders = _model("02-typical-orders-contract.yaml")
    assert _field(orders, "orders", "order_id").extras["odcs_examples"] == ["ORD-00010042"]
    customers = _model("03-composition-nested-schema.yaml")
    assert [
        entry["type"] for entry in _type(customers, "customers").extras["odcs_authoritative_defs"]
    ] == ["businessDefinition", "transformationImplementation"]


def test_an_unknown_odcs_key_lands_in_the_forward_compatibility_slot() -> None:
    contract = parse_odcs(
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nsomeFutureBlock: {a: 1}\nschema:\n"
        "  - name: t\n    futureObjectKey: 7\n    properties:\n"
        "      - name: c\n        futurePropertyKey: 9\n"
    )
    model = get_import_source("odcs").normalize(contract)
    assert model.extras["odcs_extra"] == {"someFutureBlock": {"a": 1}}
    assert _type(model, "t").extras["odcs_extra"] == {"futureObjectKey": 7}
    assert _field(model, "t", "c").extras["odcs_extra"] == {"futurePropertyKey": 9}


def test_the_projection_record_carries_status_and_version_as_provenance() -> None:
    """AC: "Record contract status and version in provenance"."""
    model = _model("04-stress-quality-sla-and-custom.yaml")
    record = model.extras[ODCS_EXTRAS_KEY]
    # The stress fixture is a v3.0.2 document (its quality rules use the v3.0 `rule:`
    # spelling and its `team` is the v3.0 array), which is what the reader records.
    assert record["api_version"] == "v3.0.2"
    assert record["status"] == "draft"
    assert record["contract_id"] == "0f6d2f0e-1b2c-4a5e-9f2a-000000000004"
    assert record["domain"] == "platform"
    assert record["tenant"] == "ExampleCorp"
    assert record["data_product"] == "telemetry"
    assert record["schema_objects"] == ["events"]
    assert model.version == "0.9.0-rc.2"


def test_only_the_reader_s_own_record_is_registered_as_provenance() -> None:
    """The governance keys are *source* constructs and must read as partial coverage."""
    assert ODCS_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS
    for carried in ("odcs_quality", "odcs_team", "odcs_servers", "odcs_sla_properties"):
        assert carried not in PROVENANCE_EXTRA_KEYS


def test_including_raw_keeps_the_source_text() -> None:
    source = get_import_source("odcs")
    contract = source.parse(MINIMAL)
    assert source.normalize(contract).raw == {"odcs": MINIMAL}
    assert source.normalize(contract, include_raw=False).raw is None


# ===========================================================================
# AC 3 — version gating
# ===========================================================================


def test_a_v2_contract_is_rejected_by_version_with_actionable_text(
    adapter: OdcsImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("06-version-out-of-range-v2.yaml"))
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"
    message = str(excinfo.value)
    assert "v2.2" in message
    assert "quantumName" in message and "`name`" in message
    assert "dataset" in message and "`schema`" in message


def test_a_later_major_version_is_refused_rather_than_guessed_at() -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        resolve_api_version("v4.0.0")
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"


@pytest.mark.parametrize("declared", ["v3.0.0", "v3.1.0", "3.1", "v3.1.0-rc.1"])
def test_every_v3_spelling_is_read(declared: str) -> None:
    version = resolve_api_version(declared)
    assert version.major == 3
    assert version.raw == declared


@pytest.mark.parametrize("declared", [None, "", "  ", "latest", 3.1, ["v3.1.0"]])
def test_a_missing_or_unparseable_api_version_is_a_semantic_error(declared: Any) -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        resolve_api_version(declared)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_version_coverage_declares_one_v3_read_and_both_written_lines() -> None:
    """One read row covers the v3 line; the write rows are per *schema* line.

    The asymmetry is deliberate and is FMT-5.2's finding: the reader does not branch on
    the minor version because every construct it consumes is common to v3.0 and v3.1,
    but the two lines validate differently (v3.1 turned `team` into an object and closed
    `quality` against the v3.0 `rule:` spelling), so a contract is written back — and
    checked — as the line it declares.
    """
    coverage = version_coverage_for("odcs")
    assert [version.support for version in coverage.reads] == [VersionSupport.FULL]
    assert [version.version for version in coverage.writes] == ["ODCS v3.1.0", "ODCS v3.0.2"]
    assert coverage.default_write == "ODCS v3.1.0"


# ===========================================================================
# AC 4 — the negative corpus, error by error
# ===========================================================================


def test_a_document_that_is_not_a_contract_is_a_format_mismatch(
    adapter: OdcsImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("04-wrong-format-dbt-schema.yml"))
    assert excinfo.value.code == "FORMAT_MISMATCH"


def test_a_syntax_error_carries_no_code_so_the_pipeline_classifies_it(
    adapter: OdcsImportSource,
) -> None:
    """This is what makes the UTF-16 fixture read as an encoding fault, not a bad document."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("01-syntactic-bad-yaml-indent.yaml"))
    assert excinfo.value.code is None


def test_truncation_is_a_parser_state_not_a_message_heuristic(
    adapter: OdcsImportSource,
) -> None:
    """PyYAML reports where it gave up; at the end of the input means the bytes ran out."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("03-truncated-mid-property.yaml"))
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_document_that_is_wrong_before_the_end_is_not_called_truncated(
    adapter: OdcsImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse("apiVersion: v3.1.0\nkind: DataContract\na: [1, 2\nb: 3\nc: 4\n")
    assert excinfo.value.code is None


def test_a_schema_object_without_properties_is_refused(adapter: OdcsImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("02-semantic-schema-without-properties.yaml"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "shapeless_table" in str(excinfo.value)


@pytest.mark.parametrize(
    ("document", "fragment"),
    [
        ("apiVersion: v3.1.0\nkind: DataContract\nversion: 1.0.0\nschema: []\n", "`name`"),
        ("apiVersion: v3.1.0\nkind: DataContract\nname: t\n", "`schema`"),
        ("apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema: []\n", "`schema`"),
        (
            "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n  - properties: []\n",
            "`name`",
        ),
        (
            "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n"
            "  - name: t\n    properties:\n      - logicalType: string\n",
            "`name`",
        ),
    ],
)
def test_a_contract_that_describes_no_structure_is_a_semantic_error(
    document: str, fragment: str
) -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs(document)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert fragment in str(excinfo.value)


def test_quality_must_be_a_list_of_rules() -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs(
            "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n"
            "  - name: t\n    quality: not-a-list\n    properties:\n      - name: c\n"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_property_nesting_is_bounded_so_recursion_never_reaches_the_pipeline() -> None:
    """An uncaught RecursionError surfaces as a 5xx; the ceiling makes it a rejection."""
    leaf: Dict[str, Any] = {"name": "leaf", "logicalType": "string"}
    for level in range(MAX_PROPERTY_DEPTH + 2):
        leaf = {"name": f"p{level}", "logicalType": "object", "properties": [leaf]}
    document = {
        "apiVersion": "v3.1.0",
        "kind": "DataContract",
        "name": "deep",
        "schema": [{"name": "deep", "properties": [leaf]}],
    }
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs(yaml.safe_dump(document))
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_normalize_refuses_anything_that_is_not_a_parsed_contract(
    adapter: OdcsImportSource,
) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"apiVersion": "v3.1.0"})


# ===========================================================================
# File-set composition
# ===========================================================================


def test_a_sibling_quality_pack_is_merged_into_the_object_it_names(
    adapter: OdcsImportSource,
) -> None:
    contract = adapter.parse_fileset(_contract_set())
    model = adapter.normalize(contract)
    rules = _type(model, "shipment_events").extras["odcs_quality"]
    assert len(rules) == 5
    assert {rule.get("rule") for rule in rules if "rule" in rule} == {
        "rowCount",
        "nullCount",
        "duplicateCount",
        "freshness",
    }
    record = model.extras[ODCS_EXTRAS_KEY]["fileset"]
    assert record["quality_packs"] == {"quality.yaml": {"schema": "shipment_events", "rules": 5}}


def test_a_relative_definition_that_names_a_member_is_recorded_as_resolved(
    adapter: OdcsImportSource,
) -> None:
    """Resolved, *not* expanded — a delegated JSON Schema stays a reference."""
    model = adapter.normalize(adapter.parse_fileset(_contract_set()))
    record = model.extras[ODCS_EXTRAS_KEY]["fileset"]
    assert record["resolved_definitions"] == {
        "./shipment-event.schema.json": "shipment-event.schema.json"
    }
    assert "shipment-event.schema.json" not in {item.key for item in model.types}


def test_a_member_that_is_not_a_document_is_a_member_and_not_an_error() -> None:
    members = {
        "contract.yaml": MINIMAL,
        "README.md": "# Not a document\n\nJust prose: [a](b) *and* more.\n",
    }
    contract = parse_odcs_fileset(members, root="contract.yaml")
    assert contract.fileset["members"] == ["README.md", "contract.yaml"]


def test_a_set_with_a_second_contract_is_refused() -> None:
    members = {"a.yaml": MINIMAL, "b.yaml": MINIMAL}
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs_fileset(members, root="a.yaml")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "second data contract" in str(excinfo.value)


def test_a_quality_pack_naming_an_unknown_object_is_refused() -> None:
    members = {
        "contract.yaml": MINIMAL,
        "quality.yaml": "schema: not_a_table\nquality:\n  - rule: rowCount\n",
    }
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs_fileset(members, root="contract.yaml")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "not_a_table" in str(excinfo.value)


def test_a_quality_pack_for_another_contract_is_refused() -> None:
    members = {
        "contract.yaml": MINIMAL.replace("kind: DataContract", "kind: DataContract\nid: contract-a"),
        "quality.yaml": "contractId: contract-b\nschema: pings\nquality:\n  - rule: rowCount\n",
    }
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs_fileset(members, root="contract.yaml")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "contract-b" in str(excinfo.value)


def test_a_definition_url_that_escapes_the_set_is_refused() -> None:
    members = {
        "contract.yaml": MINIMAL
        + "    authoritativeDefinitions:\n"
        "      - url: ../../etc/passwd\n        type: schemaDefinition\n",
        "other.json": "{}",
    }
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs_fileset(members, root="contract.yaml")
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_an_absolute_definition_url_is_recorded_and_never_fetched() -> None:
    members = {
        "contract.yaml": MINIMAL
        + "    authoritativeDefinitions:\n"
        "      - url: https://example.com/governance/pings\n        type: businessDefinition\n"
    }
    contract = parse_odcs_fileset(members, root="contract.yaml")
    assert "resolved_definitions" not in contract.fileset


def test_a_set_missing_its_root_is_refused(adapter: OdcsImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(IntakeFileset(root="missing.yaml", members={"a.yaml": MINIMAL}))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    with pytest.raises(OdcsParseError):
        parse_odcs_fileset({"a.yaml": MINIMAL}, root="missing.yaml")


# ===========================================================================
# AC 5 — the capability registry declares both halves
# ===========================================================================


def test_the_declared_limit_vocabulary_is_one_list_in_three_places() -> None:
    entry = capability_for("odcs")
    assert set(LIMIT_DETAILS) == set(ODCS_CAPABILITIES.unsupported)
    assert set(LIMIT_DETAILS) == set(entry.canonical_projection.dropped_constructs)


def test_the_registry_entry_is_reviewed_and_states_the_two_halves() -> None:
    entry = capability_for("odcs")
    assert entry.provenance is CapabilityProvenance.REVIEWED
    assert entry.canonical_projection.coverage is ProjectionCoverage.PARTIAL
    note = entry.canonical_projection.note.lower()
    assert "carried but not modelled" in note
    assert "quality" in note and "physicaltype" in note


def test_supported_and_unsupported_constructs_do_not_overlap() -> None:
    assert not set(ODCS_CAPABILITIES.supported) & set(ODCS_CAPABILITIES.unsupported)


def test_recording_an_unknown_limit_key_is_a_programming_error() -> None:
    with pytest.raises(KeyError):
        LimitRecorder().record("odcs.not-a-real-limit")


def test_limits_are_counted_and_located() -> None:
    recorder = LimitRecorder()
    recorder.record("odcs.quality_rule", location="orders")
    recorder.record("odcs.quality_rule", location="orders")
    recorder.record("odcs.quality_rule", location="customers")
    recorder.record("odcs.price")
    limits = {limit.construct: limit for limit in recorder.limits()}
    assert limits["odcs.quality_rule"].count == 3
    assert limits["odcs.quality_rule"].locations == ("customers", "orders")
    assert limits["odcs.price"].count == 1
    assert limits["odcs.price"].locations == ()


def test_a_property_level_limit_locates_its_schema_object_not_every_property() -> None:
    """A 200-column table must contribute one location, not two hundred."""
    model = _model("05-real-world-transactions-contract.yaml")
    limits = {
        limit["construct"]: limit
        for limit in model.extras[ODCS_EXTRAS_KEY]["capability_limits"]
    }
    assert limits["odcs.physical_type"]["count"] > 1
    assert limits["odcs.physical_type"]["locations"] == ["transactions"]


def test_a_free_form_object_property_is_declared_rather_than_silently_empty() -> None:
    model = _model("04-stress-quality-sla-and-custom.yaml")
    payload = _field(model, "events", "payload")
    assert payload.type.name == "events.payload"
    assert _type(model, "events.payload").fields == []
    constructs = {
        limit["construct"] for limit in model.extras[ODCS_EXTRAS_KEY]["capability_limits"]
    }
    assert "odcs.free_form_object" in constructs


def test_the_corpus_exercises_every_declared_limit() -> None:
    """The shipped fixtures must reach all fifteen, or the vocabulary is untested."""
    exercised: set = set()
    for name in (
        "03-composition-nested-schema.yaml",
        "04-stress-quality-sla-and-custom.yaml",
        "05-real-world-transactions-contract.yaml",
    ):
        exercised |= {
            limit["construct"]
            for limit in _model(name).extras[ODCS_EXTRAS_KEY]["capability_limits"]
        }
    assert exercised == set(LIMIT_DETAILS)


def test_preview_manifest_renders_a_partially_mapped_row_per_declared_limit(
    adapter: OdcsImportSource,
) -> None:
    """AC: the carried blocks "appear on the catalog detail view"."""
    api = _model("04-stress-quality-sla-and-custom.yaml")
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="odcs", options={})
    )
    rows = {
        entry.source_construct: entry
        for entry in page.coverage
        if entry.source_construct.startswith("odcs.")
    }
    recorded = {
        limit["construct"] for limit in api.extras[ODCS_EXTRAS_KEY]["capability_limits"]
    }
    assert set(rows) == recorded
    assert recorded < set(LIMIT_DETAILS) and len(recorded) == 15
    assert rows["odcs.quality_rule"].coverage is CoverageClass.PARTIALLY_MAPPED
    assert "capability limit" in rows["odcs.quality_rule"].detail
    assert "events" in rows["odcs.quality_rule"].detail


def test_a_model_without_the_projection_record_contributes_no_odcs_rows() -> None:
    """The shared limit renderer keys off this adapter's extras key and nothing else."""
    bare = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="odcs",
        identity=ApiIdentity(name="x"),
    )
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(bare, adapter_key="odcs", options={})
    )
    assert not [row for row in page.coverage if row.source_construct.startswith("odcs.")]


# ===========================================================================
# Adversarial input must be a rejection, never an unhandled error (IXH-1.3)
# ===========================================================================


@pytest.mark.parametrize(
    "options",
    [
        {"minLength": "not-a-number"},
        {"maxLength": True},
        {"minimum": "0"},
        {"multipleOf": [1]},
        {"uniqueItems": "yes"},
        {"pattern": 7},
        {"enum": "abc"},
    ],
)
def test_a_wrongly_typed_logical_type_option_is_skipped_not_handed_to_pydantic(
    options: Dict[str, Any],
) -> None:
    """A `ValidationError` here escapes the pipeline's normalize catch and becomes a 5xx."""
    document = {
        "apiVersion": "v3.1.0",
        "kind": "DataContract",
        "name": "t",
        "schema": [
            {
                "name": "t",
                "properties": [
                    {"name": "c", "logicalType": "string", "logicalTypeOptions": options}
                ],
            }
        ],
    }
    source = get_import_source("odcs")
    model = source.normalize(source.parse(yaml.safe_dump(document)))
    field = _field(model, "t", "c")
    assert field.constraints is None
    # ...and the source value still survives exactly as written.
    assert field.extras["odcs_logical_type_options"] == options


def test_a_well_typed_option_still_reaches_the_constraint() -> None:
    document = {
        "apiVersion": "v3.1.0",
        "kind": "DataContract",
        "name": "t",
        "schema": [
            {
                "name": "t",
                "properties": [
                    {
                        "name": "c",
                        "logicalType": "integer",
                        "logicalTypeOptions": {"minimum": 0, "maximum": 10, "multipleOf": 2},
                    }
                ],
            }
        ],
    }
    source = get_import_source("odcs")
    constraints = _field(
        source.normalize(source.parse(yaml.safe_dump(document))), "t", "c"
    ).constraints
    assert constraints is not None
    assert (constraints.minimum, constraints.maximum, constraints.multiple_of) == (0, 10, 2)


def test_a_duplicate_property_name_is_refused_rather_than_silently_overwriting() -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs(
            "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n  - name: t\n"
            "    properties:\n      - name: c\n      - name: c\n"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "twice" in str(excinfo.value)


def test_a_duplicate_schema_object_name_is_refused() -> None:
    with pytest.raises(OdcsParseError) as excinfo:
        parse_odcs(
            "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n"
            "  - name: t\n    properties:\n      - name: c\n"
            "  - name: t\n    properties:\n      - name: d\n"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "twice" in str(excinfo.value)


@pytest.mark.parametrize(
    "document",
    [
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema: {a: 1}\n",
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n  - name: t\n"
        "    properties: not-a-list\n",
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n  - name: t\n"
        "    properties:\n      - name: c\n        logicalType: array\n        items: 3\n",
        "apiVersion: v3.1.0\nkind: DataContract\nname: t\nschema:\n  - name: t\n"
        "    properties:\n      - name: c\n        quality:\n          - not-a-mapping\n",
        "- just\n- a\n- list\n",
        "a plain scalar\n",
    ],
)
def test_a_structurally_wrong_document_fails_cleanly(document: str) -> None:
    """Every shape below must raise the reader's own error, never an arbitrary exception."""
    with pytest.raises(OdcsParseError):
        parse_odcs(document)


def test_every_extras_key_the_reader_emits_is_documented() -> None:
    """The namespace table in `odcs_normalizer`'s docstring is the contract FMT-5.2 reads.

    A key added to the reader without a row in that table is a key the emitter has no
    reason to know about, which is how the ``extras`` ↔ emitter symmetry rule gets broken
    quietly.
    """
    import re

    from app import odcs_normalizer

    emitted: set = set()
    for name in (
        "01-minimal-contract.yaml",
        "02-typical-orders-contract.yaml",
        "03-composition-nested-schema.yaml",
        "04-stress-quality-sla-and-custom.yaml",
        "05-real-world-transactions-contract.yaml",
        "06-typical-contract.json",
    ):
        model = _model(name)
        emitted |= set(model.extras)
        for type_ in model.types:
            emitted |= set(type_.extras)
            for field in type_.fields:
                emitted |= set(field.extras)

    table = odcs_normalizer.__doc__ or ""
    documented = set(re.findall(r"``(odcs(?:_[a-z_]+)?)``", table.split("The extras namespace")[1]))
    assert emitted <= documented, f"undocumented extras keys: {sorted(emitted - documented)}"
    # `odcs_extra` is the forward-compatibility slot; no shipped fixture needs it.
    assert documented - emitted == {"odcs_extra"}
