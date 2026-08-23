"""Unit tests for the dbt ImportSource — FMT-5.4 (#5442).

Organised around the ticket's four acceptance criteria:

#. a ``schema.yml`` project **and** a compiled ``manifest.json`` both import;
#. dbt tests map onto constraints or onto the shared quality namespace FMT-5.1 defined;
#. model lineage (``ref``) is recorded as relationships where representable;
#. the corpus covers a small project, a manifest, and a project with a broken ``ref``.

Plus the two things every reader in this fleet must prove: that its declared limits are
one vocabulary in three places, and that every taxonomy code its negatives claim is the
code the pipeline actually reports.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.canonical_model import ApiParadigm, TypeKind
from app.dbt_import_source import DBT_CAPABILITIES, DbtImportSource
from app.dbt_normalizer import (
    DBT_EXTRAS_KEY,
    DBT_QUALITY_ENGINE,
    WAREHOUSE_SCALARS,
    DbtNormalizer,
)
from app.dbt_parser import (
    is_dbt,
    is_dbt_document,
    parse_dbt,
    parse_dbt_fileset,
)
from app.dbt_resources import (
    LIMIT_DETAILS,
    MANIFEST_READ_VERSIONS,
    PROPERTIES_VERSION,
    DbtParseError,
    LimitRecorder,
    resolve_manifest_schema_version,
    resolve_properties_version,
)
from app.fileset import IntakeFileset
from app.format_capability_registry import ProjectionCoverage, capability_for
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
from app.import_source_pipeline import _classify_parse_failure
from app.odcs_normalizer import ODCS_QUALITY_EXTRAS_KEY

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "dbt"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _corpus_text(name: str) -> str:
    """Read a shipped corpus fixture, asserting it is still there."""
    path = CORPUS / name
    assert path.is_file(), f"corpus fixture {name} is missing"
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def adapter() -> DbtImportSource:
    """The registered dbt adapter."""
    return get_import_source("dbt")


@pytest.fixture(scope="module")
def typical(adapter: DbtImportSource):
    """The typical properties fixture, normalized."""
    return adapter.normalize(
        adapter.parse(_corpus_text("02-typical-schema.yml"), source_label="02-typical-schema.yml")
    )


@pytest.fixture(scope="module")
def stress(adapter: DbtImportSource):
    """The stress fixture (contracts, sources, versions, exposures), normalized."""
    name = "04-stress-contracts-sources-and-exposures.yml"
    return adapter.normalize(adapter.parse(_corpus_text(name), source_label=name))


@pytest.fixture(scope="module")
def manifest(adapter: DbtImportSource):
    """The compiled-manifest fixture, normalized."""
    name = "05-real-world-manifest.json"
    return adapter.normalize(adapter.parse(_corpus_text(name), source_label=name))


@pytest.fixture(scope="module")
def semantic(adapter: DbtImportSource):
    """The semantic-manifest fixture, normalized."""
    name = "06-semantic-manifest.yml"
    return adapter.normalize(adapter.parse(_corpus_text(name), source_label=name))


@pytest.fixture(scope="module")
def project_set(adapter: DbtImportSource):
    """The multi-file project fixture, normalized."""
    directory = CORPUS / "03-project-set"
    members = {p.name: p.read_text(encoding="utf-8") for p in sorted(directory.iterdir())}
    fileset = IntakeFileset.from_members(members, root="dbt_project.yml")
    return adapter.normalize(
        adapter.parse_fileset(fileset, source_label="03-project-set/dbt_project.yml")
    )


def _type(model, key: str):
    """Return the canonical type with ``key``, asserting it exists."""
    for type_ in model.types:
        if type_.key == key:
            return type_
    raise AssertionError(f"no type {key!r} in {[t.key for t in model.types]}")


def _field(model, type_key: str, name: str):
    """Return the named field of a canonical type, asserting it exists."""
    for field in _type(model, type_key).fields:
        if field.name == name:
            return field
    raise AssertionError(f"no field {name!r} on {type_key}")


# ---------------------------------------------------------------------------
# 1. Both surfaces import
# ---------------------------------------------------------------------------


def test_properties_file_imports_models_as_types(typical) -> None:
    """AC1: a `schema.yml` imports, with each model becoming a canonical record."""
    assert typical.paradigm is ApiParadigm.DATA_SCHEMA
    assert typical.format == "dbt"
    assert sorted(t.key for t in typical.types) == ["customers", "orders"]
    orders = _type(typical, "orders")
    assert orders.kind is TypeKind.RECORD
    assert orders.description == "Order facts, one row per order."
    assert sorted(f.name for f in orders.fields) == [
        "customer_id",
        "order_id",
        "placed_at",
        "status",
        "total_amount",
    ]


def test_manifest_imports_nodes_and_sources_as_types(manifest) -> None:
    """AC1: a compiled `manifest.json` imports the same way a properties file does."""
    assert sorted(t.key for t in manifest.types) == [
        "fct_orders",
        "raw_commerce.customers_raw",
        "raw_commerce.orders_raw",
        "stg_customers",
        "stg_orders",
    ]
    record = manifest.extras[DBT_EXTRAS_KEY]
    assert record["surface"] == "manifest"
    assert record["manifest_schema_version"] == 12
    assert record["dbt_version"] == "1.9.2"
    assert record["adapter_type"] == "snowflake"
    assert manifest.identity.name == "example_commerce"


def test_manifest_node_carries_its_unique_id_and_relation(manifest) -> None:
    """A manifest's own coordinates survive as extras rather than being discarded."""
    fct = _type(manifest, "fct_orders")
    assert fct.extras["dbt_unique_id"] == "model.example_commerce.fct_orders"
    assert fct.extras["dbt_relation"] == {
        "database": "ANALYTICS",
        "schema": "ANALYTICS",
        "alias": "fct_orders",
    }
    assert fct.extras["dbt_config"]["materialized"] == "table"


def test_manifest_states_no_declaration_order(manifest, typical) -> None:
    """A JSON object is unordered, so only the properties surface records positions.

    A manifest re-serialized with its `nodes` in a different order must produce the same
    canonical model, or every cosmetic recompile reads as a new revision.
    """
    assert all("dbt_position" not in t.extras for t in manifest.types)
    assert all("dbt_position" not in f.extras for t in manifest.types for f in t.fields)
    assert _type(typical, "orders").extras["dbt_position"] == 0
    assert _field(typical, "orders", "order_id").extras["dbt_position"] == 0


def test_manifest_reordering_does_not_change_the_fingerprint(adapter) -> None:
    """The order-freedom above is asserted where it matters: the version fingerprint."""
    text = _corpus_text("05-real-world-manifest.json")
    document = json.loads(text)
    document["nodes"] = dict(reversed(list(document["nodes"].items())))
    for node in document["nodes"].values():
        if isinstance(node.get("columns"), dict):
            node["columns"] = dict(reversed(list(node["columns"].items())))
    baseline = canonical_fingerprint(adapter.normalize(adapter.parse(text)))
    permuted = canonical_fingerprint(adapter.normalize(adapter.parse(json.dumps(document))))
    assert permuted == baseline


def test_seeds_snapshots_and_source_tables_all_become_types(stress) -> None:
    """Every dbt resource that describes data is modelled, not just models."""
    kinds = {t.key: t.extras["dbt_resource_type"] for t in stress.types}
    assert kinds == {
        "country_codes": "seed",
        "dim_customers": "model",
        "fct_orders": "model",
        "orders_snapshot": "snapshot",
        "raw_commerce.customers_raw": "source",
        "raw_commerce.orders_raw": "source",
    }


def test_source_table_inherits_its_source_freshness_and_schema(stress) -> None:
    """A source states one policy and a table overrides it; both land on the table."""
    orders_raw = _type(stress, "raw_commerce.orders_raw")
    assert orders_raw.extras["dbt_source"] == "raw_commerce"
    assert orders_raw.extras["dbt_relation"]["identifier"] == "orders"
    assert orders_raw.extras["dbt_freshness"]["loaded_at_field"] == "_loaded_at"
    assert orders_raw.extras["dbt_freshness"]["freshness"]["error_after"] == {
        "count": 24,
        "period": "hour",
    }
    customers_raw = _type(stress, "raw_commerce.customers_raw")
    # The table overrode `freshness` but inherited `loaded_at_field`.
    assert customers_raw.extras["dbt_freshness"]["freshness"] == {
        "warn_after": {"count": 12, "period": "hour"}
    }
    assert customers_raw.extras["dbt_freshness"]["loaded_at_field"] == "_loaded_at"


def test_yaml_anchor_column_groups_compose(adapter) -> None:
    """AC-composition: an anchored column group splices in as columns, not as one column."""
    name = "07-composition-model-inheritance.yml"
    model = adapter.normalize(adapter.parse(_corpus_text(name), source_label=name))
    assert sorted(f.name for f in _type(model, "dim_customer").fields) == [
        "country_code",
        "created_at",
        "created_by",
        "display_name",
        "id",
        "natural_key",
        "updated_at",
    ]
    # The shared group is the same group in every model that spliced it.
    assert {f.name for f in _type(model, "dim_product").fields} >= {"id", "natural_key"}


def test_project_fileset_composes_properties_and_sql(project_set) -> None:
    """AC-multi-file: the project directory is one import with one resource namespace."""
    assert sorted(t.key for t in project_set.types) == [
        "fct_orders",
        "stg_customers",
        "stg_orders",
    ]
    record = project_set.extras[DBT_EXTRAS_KEY]
    assert record["surface"] == "project"
    assert record["project_version"] == "1.3.0"
    assert project_set.identity.name == "example_commerce"
    assert record["fileset"]["properties_files"] == ["schema.yml"]
    assert record["fileset"]["model_files"] == ["fct_orders.sql", "stg_orders.sql"]
    assert project_set.extras["dbt_project"]["profile"] == "example_commerce"


def test_model_sql_contributes_lineage_but_is_never_compiled(project_set) -> None:
    """The `.sql` members are read for their `ref()` calls and nothing else."""
    fct = _type(project_set, "fct_orders")
    assert fct.extras["dbt_depends_on"] == {"resolved": ["stg_customers", "stg_orders"]}
    # `stg_orders.sql` selects from a source no properties file in the set declares.
    assert _type(project_set, "stg_orders").extras["dbt_depends_on"] == {
        "unresolved": ["raw_commerce.orders_raw"]
    }


def test_semantic_models_become_an_additional_layer(semantic) -> None:
    """Entities, dimensions and measures each become one field, typed by what they are."""
    orders = _type(semantic, "semantic_model.orders")
    by_name = {f.name: f for f in orders.fields}
    assert set(by_name) == {
        "average_order_value",
        "channel",
        "customer",
        "order",
        "order_count",
        "order_total",
        "placed_at",
        "status",
    }
    assert by_name["order"].extras["dbt_semantic"]["role"] == "entity"
    assert by_name["placed_at"].type.name == "timestamp"
    assert by_name["status"].type.name == "string"
    assert by_name["order_count"].type.name == "int64"
    assert by_name["order_total"].type.name == "number"
    assert semantic.extras["dbt_metrics"][0]["name"] == "revenue"


# ---------------------------------------------------------------------------
# 2. Where a dbt test lands
# ---------------------------------------------------------------------------


def test_not_null_becomes_nullability(typical) -> None:
    """AC2: `not_null` has an exact canonical analogue and is modelled as one."""
    assert _field(typical, "orders", "order_id").type.nullable is False
    assert _field(typical, "orders", "placed_at").type.nullable is False
    assert _field(typical, "orders", "total_amount").type.nullable is True


def test_accepted_values_becomes_an_enum_constraint(typical) -> None:
    """AC2: `accepted_values` becomes `Constraints.enum`, not a carried blob."""
    status = _field(typical, "orders", "status")
    assert status.constraints is not None
    assert status.constraints.enum == ["new", "paid", "shipped", "cancelled"]
    assert ODCS_QUALITY_EXTRAS_KEY not in status.extras


def test_unique_is_carried_because_there_is_no_identity_facet(typical) -> None:
    """AC2: `unique` declares identity, which the canonical vocabulary has no facet for."""
    assert _field(typical, "orders", "order_id").extras["dbt_key"] == {"unique": True}
    assert _field(typical, "orders", "status").extras.get("dbt_key") is None


def test_other_tests_land_in_the_shared_quality_namespace(stress) -> None:
    """AC2: the ticket's alignment — a package test lands where an ODCS rule would.

    The rule is a valid ODCS ``DataQuality`` of ``type: custom``: the standard's own
    extension point, whose published examples name ``dbt`` among the engines. That is what
    makes this the *shared* namespace rather than a dbt-shaped bag under a borrowed key.
    """
    rules = _type(stress, "fct_orders").extras[ODCS_QUALITY_EXTRAS_KEY]
    assert len(rules) == 1
    rule = rules[0]
    assert rule["type"] == "custom"
    assert rule["engine"] == DBT_QUALITY_ENGINE
    assert rule["name"] == "dbt_utils.expression_is_true"
    assert rule["implementation"]["arguments"] == {"expression": "total_amount >= 0"}


def test_a_tests_severity_survives_onto_the_rule(manifest) -> None:
    """A test the model does not declare a column for lands on the model, with severity."""
    rules = _type(manifest, "fct_orders").extras[ODCS_QUALITY_EXTRAS_KEY]
    accepted = [r for r in rules if r["name"] == "accepted_values"]
    assert len(accepted) == 1
    assert accepted[0]["severity"] == "warn"
    assert accepted[0]["implementation"]["column"] == "status"


def test_a_manifest_test_node_is_reattached_to_its_column(manifest) -> None:
    """A manifest hoists tests into their own nodes; re-attaching them is the reader's job."""
    assert _field(manifest, "fct_orders", "order_id").extras["dbt_key"] == {"unique": True}


def test_both_surfaces_agree_about_where_a_test_landed(adapter) -> None:
    """The two surfaces are one projection: the same test lands in the same place.

    Asserted field by field on the model the properties fixture and the manifest fixture
    both describe, which is what makes "one algebra, two surfaces" testable rather than
    merely stated.
    """
    properties = adapter.normalize(
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: fct_orders\n"
            "    description: Order facts joined to the customer dimension.\n"
            "    columns:\n"
            "      - name: order_id\n"
            "        description: Business identifier.\n"
            "        data_type: VARCHAR(20)\n"
            "        tests: [unique, not_null]\n",
            source_label="properties",
        )
    )
    compiled = adapter.normalize(
        adapter.parse(_corpus_text("05-real-world-manifest.json"), source_label="manifest")
    )
    for model in (properties, compiled):
        order_id = _field(model, "fct_orders", "order_id")
        assert order_id.type.name == "string"
        assert order_id.type.nullable is False
        assert order_id.extras["dbt_key"] == {"unique": True}
        assert order_id.extras["dbt_data_type"] == "VARCHAR(20)"


def test_a_not_null_constraint_and_a_not_null_test_agree(stress) -> None:
    """A model contract's `not_null` constraint is the same canonical fact as the test."""
    assert _field(stress, "fct_orders", "customer_id").type.nullable is False
    assert _field(stress, "fct_orders", "order_id").type.nullable is False
    assert _field(stress, "fct_orders", "currency").type.nullable is True


def test_check_and_key_constraints_are_carried_on_the_model(stress) -> None:
    """A `check` expression is warehouse SQL; the canonical model has no expression facet."""
    constraints = _type(stress, "fct_orders").extras["dbt_constraints"]
    kinds = [c["type"] for c in constraints]
    assert kinds == ["primary_key", "foreign_key", "check"]
    assert constraints[2]["expression"] == "total_amount >= 0"


# ---------------------------------------------------------------------------
# 3. Lineage
# ---------------------------------------------------------------------------


def test_a_relationships_test_is_recorded_as_a_relationship(typical) -> None:
    """AC3: the edge is recorded in the ODCS property-level relationship shape."""
    edges = _field(typical, "orders", "customer_id").extras["dbt_relationship"]
    assert edges == [
        {
            "type": "foreignKey",
            "origin": "relationships_test",
            "ref": "ref('customers')",
            "to_type": "customers",
            "to": "customers.customer_id",
            "to_field": "customers.customer_id",
            "to_columns": ["customer_id"],
        }
    ]


def test_a_foreign_key_constraint_is_recorded_the_same_way(stress) -> None:
    """A model contract's `foreign_key` is the same edge by another spelling."""
    edges = _field(stress, "fct_orders", "customer_id").extras["dbt_relationship"]
    assert len(edges) == 1
    assert edges[0]["origin"] == "foreign_key_constraint"
    assert edges[0]["to"] == "dim_customers.customer_id"


def test_the_projection_record_lists_every_recorded_edge(typical) -> None:
    """The edges are also collected at the root, so the graph is readable in one place."""
    assert typical.extras[DBT_EXTRAS_KEY]["lineage"] == [
        {
            "from": "orders",
            "from_columns": ["customer_id"],
            "to": "customers",
            "to_columns": ["customer_id"],
            "origin": "relationships_test",
        }
    ]


def test_an_exposure_ref_is_recorded_but_not_required(stress) -> None:
    """An exposure names downstream use; both of its refs resolve in this fixture."""
    assert stress.extras["dbt_exposures"][0]["name"] == "revenue_dashboard"
    assert "unresolved_lineage" not in stress.extras[DBT_EXTRAS_KEY]


def test_a_semantic_models_target_may_live_outside_the_import(semantic) -> None:
    """A semantic manifest routinely names models a *different* file declares.

    Requiring those to resolve would reject the ordinary case, so they are recorded as
    unresolved rather than refused — unlike a `relationships` test, which is refused,
    because that is an edge this reader writes down.
    """
    unresolved = semantic.extras[DBT_EXTRAS_KEY]["unresolved_lineage"]
    assert {row["target"] for row in unresolved} == {"fct_orders", "dim_customers"}


def test_a_dangling_relationships_test_is_refused(adapter) -> None:
    """AC4 (the broken-`ref` corpus case): a recorded edge that dangles is an error."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(
            _corpus_text("negative/06-unresolvable-ref.yml"), source_label="06-unresolvable-ref.yml"
        )
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "dim_customers" in str(excinfo.value)


def test_a_relationships_test_with_no_ref_call_is_refused(adapter) -> None:
    """`to: customers` is not a lineage target; dbt requires the Jinja call."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: orders\n"
            "    columns:\n"
            "      - name: customer_id\n"
            "        tests:\n"
            "          - relationships:\n"
            "              to: customers\n"
            "              field: id\n"
        )
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_a_manifest_test_node_pointing_nowhere_is_refused(adapter) -> None:
    """A compiled manifest states its own graph, so a dangling test node is corruption."""
    document = json.loads(_corpus_text("05-real-world-manifest.json"))
    node = document["nodes"]["test.example_commerce.unique_fct_orders_order_id.9c1b2f"]
    node["depends_on"]["nodes"] = ["model.example_commerce.does_not_exist"]
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(json.dumps(document), source_label="manifest.json")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


# ---------------------------------------------------------------------------
# Warehouse types
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("declared", "expected"),
    [
        ("varchar(20)", "string"),
        ("VARCHAR(20)", "string"),
        ("char(3)", "string"),
        ("text", "string"),
        ("numeric(13,2)", "decimal"),
        ("NUMBER(13,2)", "decimal"),
        ("bigint", "int64"),
        ("smallint", "int16"),
        ("int", "int32"),
        ("double precision", "double"),
        ("real", "float"),
        ("boolean", "boolean"),
        ("date", "date"),
        ("timestamp", "timestamp"),
        ("TIMESTAMP_NTZ", "timestamp"),
        ("timestamp without time zone", "timestamp"),
        ("jsonb", "json"),
        ("VARIANT", "json"),
        ("bytea", "bytes"),
        ("some_udt", "string"),
        (None, "string"),
    ],
)
def test_warehouse_types_project_by_base_name(adapter, declared, expected) -> None:
    """The base name selects the scalar; the parameters are carried, not interpreted."""
    declaration = f"        data_type: {declared}\n" if declared else ""
    model = adapter.normalize(
        adapter.parse(
            "version: 2\nmodels:\n  - name: t\n    columns:\n      - name: c\n" + declaration
        )
    )
    field = _field(model, "t", "c")
    assert field.type.name == expected
    assert field.extras.get("dbt_data_type") == declared


def test_a_length_never_becomes_a_max_length(adapter) -> None:
    """`varchar(20)`'s 20 is dialect-dependent, so inventing `maxLength` is refused."""
    model = adapter.normalize(
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: t\n"
            "    columns:\n"
            "      - name: c\n"
            "        data_type: varchar(20)\n"
        )
    )
    assert _field(model, "t", "c").constraints is None


def test_an_array_type_becomes_a_list_reference(adapter) -> None:
    """`varchar[]` is a repeated column, which the canonical model *does* express."""
    model = adapter.normalize(
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: t\n"
            "    columns:\n"
            "      - name: c\n"
            "        data_type: varchar[]\n"
        )
    )
    reference = _field(model, "t", "c").type
    assert reference.is_list()
    assert reference.item is not None and reference.item.name == "string"


def test_every_warehouse_scalar_is_a_name_the_canonical_vocabulary_knows() -> None:
    """A scalar spelling this reader invents would project to `{}` in every consumer."""
    from app.canonical_json_schema import CANONICAL_SCALAR_SCHEMAS

    known = set(CANONICAL_SCALAR_SCHEMAS) | {"json"}
    assert set(WAREHOUSE_SCALARS.values()) <= known


# ---------------------------------------------------------------------------
# Detection & standing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-schema.yml",
        "02-typical-schema.yml",
        "04-stress-contracts-sources-and-exposures.yml",
        "05-real-world-manifest.json",
        "06-semantic-manifest.yml",
        "07-composition-model-inheritance.yml",
        "03-project-set/dbt_project.yml",
    ],
)
def test_every_valid_corpus_entry_is_claimed(adapter, name) -> None:
    """Detection claims a properties file, a manifest and a `dbt_project.yml` alike."""
    result = adapter.detect(DetectionInput(text=_corpus_text(name), filename=name))
    assert result.matched
    assert result.confidence >= 0.85


def test_a_model_sql_is_deliberately_not_claimed(adapter) -> None:
    """Jinja-templated SQL has no marker; a sniffer that claimed it would claim everything."""
    text = _corpus_text("03-project-set/fct_orders.sql")
    assert adapter.detect(DetectionInput(text=text, filename="fct_orders.sql")).matched is False


def test_the_project_file_is_told_from_a_properties_file() -> None:
    """`dbt_project.yml` spells `models:` too — as a mapping of build defaults."""
    project = {"name": "p", "config-version": 2, "models": {"p": {"+materialized": "view"}}}
    assert is_dbt_document(project)
    properties = {"version": 2, "models": [{"name": "m"}]}
    assert is_dbt_document(properties)
    # Imported alone, the project file describes no data and says so.
    with pytest.raises(DbtParseError) as excinfo:
        parse_dbt("name: p\nconfig-version: 2\nprofile: p\n", source_label="dbt_project.yml")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "file set" in str(excinfo.value)


def test_detection_does_not_claim_a_bare_openapi_document(adapter) -> None:
    """`models:` is not enough; the marker is `version: 2` beside a properties list."""
    assert not is_dbt("openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n")
    assert not is_dbt("version: 2\nservices:\n  - name: a\n")


def test_a_dbt_document_wins_detection_against_the_fleet(adapter) -> None:
    """The winning adapter for a `schema.yml` is this one, not a lookalike."""
    text = _corpus_text("02-typical-schema.yml")
    best = detect_import_source(DetectionInput(text=text, filename="schema.yml"))
    assert best is not None and best[0].key == "dbt"


def test_dbt_routes_to_the_catalog(adapter, typical) -> None:
    """A dbt project is a schemas-only source; it is not a publishable Project."""
    decision = decide_import_routing(adapter, typical)
    assert decision.target is ImportTarget.CATALOG
    assert decision.schemas_only is True


# ---------------------------------------------------------------------------
# Error grounding
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("negative/01-syntactic-bad-indentation.yml", "INPUT_MALFORMED"),
        ("negative/02-semantic-no-models.yml", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-test.yml", "INPUT_TRUNCATED"),
        ("negative/04-wrong-format-odcs.yaml", "FORMAT_MISMATCH"),
        ("negative/05-encoding-utf16.yml", "INPUT_ENCODING_INVALID"),
        ("negative/06-unresolvable-ref.yml", "INPUT_REFERENCE_UNRESOLVED"),
    ],
)
def test_every_negative_grounds_at_the_code_the_manifest_declares(adapter, name, expected) -> None:
    """The pipeline's classification, not the reader's opinion of it."""
    raw = (CORPUS / name).read_bytes().decode("utf-8", errors="replace")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(raw, source_label=name)
    assert _classify_parse_failure(excinfo.value, adapter, raw, name) == expected


def test_a_syntax_error_carries_no_code(adapter) -> None:
    """A code-less failure is what lets the pipeline call a UTF-16 upload an encoding fault."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse("version: 2\nmodels:\n  - name: a\n   bad: indent\n")
    assert excinfo.value.code is None


def test_an_odcs_contract_is_refused_without_a_code(adapter) -> None:
    """No standing: this reader is not the one qualified to judge somebody else's format."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_corpus_text("negative/04-wrong-format-odcs.yaml"))
    assert excinfo.value.code is None


def test_truncation_is_a_parser_state_not_a_message_heuristic(adapter) -> None:
    """A document that is wrong *where it stands* is malformed, not truncated."""
    truncated = _corpus_text("negative/03-truncated-mid-test.yml")
    with pytest.raises(ImportSourceError) as truncated_error:
        adapter.parse(truncated)
    assert truncated_error.value.code == "INPUT_TRUNCATED"
    with pytest.raises(ImportSourceError) as malformed_error:
        adapter.parse(_corpus_text("negative/01-syntactic-bad-indentation.yml"))
    assert malformed_error.value.code is None


def test_a_truncated_manifest_is_recognised_too(adapter) -> None:
    """The JSON loader reports the offset it gave up at; the rule is the same one."""
    text = _corpus_text("05-real-world-manifest.json")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(text[: len(text) // 2], source_label="manifest.json")
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_duplicate_resource_name_is_refused(adapter) -> None:
    """Canonical types are keyed by name, so the second would overwrite the first."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse("version: 2\nmodels:\n  - name: orders\n  - name: orders\n")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_duplicate_column_name_is_refused(adapter) -> None:
    """Same rule, one level down."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: orders\n"
            "    columns:\n"
            "      - name: id\n"
            "      - name: id\n"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_malformed_test_entry_is_refused(adapter) -> None:
    """A test is a name or a single-key mapping; anything else is a mis-written file."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: orders\n"
            "    columns:\n"
            "      - name: id\n"
            "        tests:\n"
            "          - unique: {}\n"
            "            not_null: {}\n"
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_fileset_missing_its_root_is_refused(adapter) -> None:
    """The set's root is the one member that has to be there."""
    with pytest.raises(DbtParseError) as excinfo:
        parse_dbt_fileset({"schema.yml": "version: 2\n"}, root="dbt_project.yml")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    with pytest.raises(ImportSourceError) as adapter_error:
        adapter.parse_fileset(
            IntakeFileset(root="dbt_project.yml", members={"schema.yml": "version: 2\n"})
        )
    assert adapter_error.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_fileset_member_that_is_not_a_document_is_simply_a_member(adapter) -> None:
    """A README beside a project is a member, not a parse error."""
    members = {
        "schema.yml": "version: 2\nmodels:\n  - name: m\n    columns:\n      - name: c\n",
        "README.md": "# Not a document\n\n- just prose: [and, brackets\n",
    }
    project = parse_dbt_fileset(members, root="schema.yml")
    assert [r.key for r in project.resources] == ["m"]
    assert project.fileset["other_files"] == ["README.md"]


# ---------------------------------------------------------------------------
# Version gating
# ---------------------------------------------------------------------------


def test_a_missing_properties_version_is_read_as_two() -> None:
    """dbt itself defaults it, so refusing it would reject files the tooling reads."""
    assert resolve_properties_version(None) == PROPERTIES_VERSION


@pytest.mark.parametrize("declared", [1, 3, "2", True])
def test_a_properties_version_other_than_two_is_rejected_by_version(declared) -> None:
    """The v1 shape is a different document, so it is refused rather than mis-read."""
    with pytest.raises(DbtParseError) as excinfo:
        resolve_properties_version(declared)
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"


@pytest.mark.parametrize("version", MANIFEST_READ_VERSIONS)
def test_every_declared_manifest_version_resolves(version) -> None:
    """The declared read line is the one the resolver actually accepts."""
    url = f"https://schemas.getdbt.com/dbt/manifest/v{version}.json"
    assert resolve_manifest_schema_version(url) == version


@pytest.mark.parametrize("version", [1, 6, 13, 99])
def test_a_manifest_outside_the_read_line_is_rejected_by_version(version) -> None:
    """With the `dbt compile` remediation named, not a parse error."""
    with pytest.raises(DbtParseError) as excinfo:
        resolve_manifest_schema_version(
            f"https://schemas.getdbt.com/dbt/manifest/v{version}.json"
        )
    assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"


def test_a_manifest_with_no_schema_version_is_semantically_invalid() -> None:
    """Every compiled manifest names the schema it was written against."""
    with pytest.raises(DbtParseError) as excinfo:
        resolve_manifest_schema_version(None)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    with pytest.raises(DbtParseError) as bad:
        resolve_manifest_schema_version("https://schemas.getdbt.com/dbt/manifest/latest")
    assert bad.value.code == "INPUT_SEMANTIC_INVALID"


def test_version_coverage_declares_two_reads_and_no_writes() -> None:
    """FMT-3.8: the declared read/write versions are published, not implied."""
    coverage = version_coverage_for("dbt")
    assert coverage is not None
    assert [entry.support for entry in coverage.reads] == [
        VersionSupport.FULL,
        VersionSupport.FULL,
    ]
    assert list(coverage.writes) == []
    assert coverage.default_write is None


# ---------------------------------------------------------------------------
# Declared limits — one vocabulary in three places
# ---------------------------------------------------------------------------


def test_the_adapter_declares_exactly_the_limit_vocabulary() -> None:
    """The adapter's `unsupported` list is the limit table, not a second list."""
    assert sorted(DBT_CAPABILITIES.unsupported) == sorted(LIMIT_DETAILS)


def test_the_capability_seed_declares_exactly_the_limit_vocabulary() -> None:
    """A construct cannot be carried without the reviewed registry saying so."""
    capability = capability_for("dbt")
    assert capability is not None
    projection = capability.canonical_projection
    assert projection.coverage is ProjectionCoverage.PARTIAL
    assert sorted(projection.dropped_constructs) == sorted(LIMIT_DETAILS)


def test_the_limit_recorder_refuses_a_key_outside_the_vocabulary() -> None:
    """A typo in a limit key must fail loudly, not create a new construct."""
    recorder = LimitRecorder()
    with pytest.raises(KeyError):
        recorder.record("dbt.not_a_real_limit")


def test_property_level_limits_locate_their_resource_not_their_column() -> None:
    """A 200-column model contributes one location, not two hundred."""
    recorder = LimitRecorder()
    for _ in range(3):
        recorder.record("dbt.data_type", location="orders")
    (limit,) = recorder.limits()
    assert limit.count == 3
    assert limit.locations == ("orders",)


def test_the_stress_fixture_records_its_limits_with_counts_and_locations(stress) -> None:
    """The ledger is per-document evidence, not a static claim about the format."""
    limits = {
        row["construct"]: row for row in stress.extras[DBT_EXTRAS_KEY]["capability_limits"]
    }
    assert limits.keys() >= {
        "dbt.check_constraint",
        "dbt.data_test",
        "dbt.data_type",
        "dbt.declaration_order",
        "dbt.exposure",
        "dbt.freshness",
        "dbt.lineage_relationship",
        "dbt.materialization",
        "dbt.model_version",
        "dbt.relation_name",
        "dbt.uniqueness",
    }
    assert limits["dbt.freshness"]["locations"] == [
        "raw_commerce.customers_raw",
        "raw_commerce.orders_raw",
    ]
    assert limits["dbt.check_constraint"]["count"] == 1


def test_every_declared_limit_is_reachable(adapter, stress, manifest, semantic, project_set, typical) -> None:
    """A limit nothing can trigger is a claim about the format nobody has checked.

    The corpus reaches most of them; the two it cannot — an undocumented model and an
    unknown properties key — are exercised here by hand, rather than left unproven.
    """
    reached: set = set()
    for model in (stress, manifest, semantic, project_set, typical):
        reached.update(
            row["construct"] for row in model.extras[DBT_EXTRAS_KEY]["capability_limits"]
        )
    hand_authored = adapter.normalize(
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: undocumented\n"
            "    meta:\n"
            "      owner: analytics\n"
            "    tags: [nightly]\n"
            "    unrecognised_key: kept\n",
            source_label="hand.yml",
        )
    )
    reached.update(
        row["construct"] for row in hand_authored.extras[DBT_EXTRAS_KEY]["capability_limits"]
    )
    assert reached == set(LIMIT_DETAILS), f"unreachable: {sorted(set(LIMIT_DETAILS) - reached)}"


def test_an_unrecognised_key_survives_in_dbt_extra(adapter) -> None:
    """dbt keeps adding properties keys; an unknown one is carried, never dropped."""
    model = adapter.normalize(
        adapter.parse(
            "version: 2\n"
            "models:\n"
            "  - name: m\n"
            "    unrecognised_key: kept\n"
            "    columns:\n"
            "      - name: c\n"
            "        column_level_unknown: also-kept\n"
        )
    )
    assert _type(model, "m").extras["dbt_extra"] == {"unrecognised_key": "kept"}
    assert _field(model, "m", "c").extras["dbt_extra"] == {"column_level_unknown": "also-kept"}


def test_an_undocumented_model_says_so_rather_than_claiming_no_columns(adapter) -> None:
    """A properties file that documents no columns did not say the relation has none."""
    model = adapter.normalize(adapter.parse("version: 2\nmodels:\n  - name: m\n"))
    assert _type(model, "m").fields == []
    constructs = {
        row["construct"] for row in model.extras[DBT_EXTRAS_KEY]["capability_limits"]
    }
    assert "dbt.undocumented_columns" in constructs


# ---------------------------------------------------------------------------
# Provenance & the coverage ledger
# ---------------------------------------------------------------------------


def test_only_the_projection_record_is_registered_as_provenance() -> None:
    """A carried source construct must read as *partial*, never as fully mapped."""
    assert DBT_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS
    for key in (
        "dbt_project",
        "dbt_config",
        "dbt_relation",
        "dbt_freshness",
        "dbt_relationship",
        "dbt_key",
        "dbt_data_type",
        ODCS_QUALITY_EXTRAS_KEY,
    ):
        assert key not in PROVENANCE_EXTRA_KEYS


def test_the_declared_limits_reach_the_coverage_ledger(stress) -> None:
    """CPDO-1.3: every declared limit is a partially-mapped document-scoped row."""
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(stress, adapter_key="dbt", options={})
    )
    rows = {
        row.source_construct: row
        for row in page.coverage
        if row.source_construct.startswith("dbt.")
    }
    declared = {
        row["construct"] for row in stress.extras[DBT_EXTRAS_KEY]["capability_limits"]
    }
    assert set(rows) == declared
    for row in rows.values():
        assert row.coverage is CoverageClass.PARTIALLY_MAPPED
        assert row.document_scoped is True
        assert "Resource(s):" in row.detail or row.detail.endswith("normalized.)")


# ---------------------------------------------------------------------------
# Normalizer contract
# ---------------------------------------------------------------------------


def test_the_normalizer_refuses_a_foreign_ast() -> None:
    """The registry hands the normalizer whatever the adapter parsed; it checks."""
    with pytest.raises(ValueError):
        DbtNormalizer().normalize({"version": 2})


def test_the_adapter_refuses_a_foreign_ast(adapter) -> None:
    """Same check on the adapter seam, with the import-source error type."""
    with pytest.raises(ImportSourceError):
        adapter.normalize({"version": 2})


def test_the_raw_source_is_retained_only_when_asked(adapter) -> None:
    """The fidelity bag is opt-out, and opting out must actually drop the text."""
    native = adapter.parse(_corpus_text("01-minimal-schema.yml"))
    assert adapter.normalize(native, include_raw=True).raw is not None
    assert adapter.normalize(native, include_raw=False).raw is None


def test_reimporting_the_same_document_is_a_no_op(adapter) -> None:
    """A stable fingerprint is what makes re-import a no-op rather than a new revision."""
    text = _corpus_text("02-typical-schema.yml")
    first = canonical_fingerprint(adapter.normalize(adapter.parse(text)))
    second = canonical_fingerprint(adapter.normalize(adapter.parse(text)))
    assert first == second


def test_the_extras_namespace_table_documents_every_key_the_reader_emits(
    stress, manifest, semantic, project_set, typical
) -> None:
    """A key added without a row in the module's table is a key nobody can look up."""
    import app.dbt_normalizer as normalizer_module

    documented = {
        line.split("``")[1]
        for line in (normalizer_module.__doc__ or "").splitlines()
        if line.startswith("``")
    }
    emitted: set = set()
    for model in (stress, manifest, semantic, project_set, typical):
        emitted.update(key for key in model.extras)
        for type_ in model.types:
            emitted.update(type_.extras)
            for field in type_.fields:
                emitted.update(field.extras)
    # `dbt_semantic_model` is the semantic model's own header block; it is documented as
    # part of the `dbt_semantic` row rather than as a row of its own.
    emitted.discard("dbt_semantic_model")
    assert emitted <= documented, f"undocumented extras keys: {sorted(emitted - documented)}"
