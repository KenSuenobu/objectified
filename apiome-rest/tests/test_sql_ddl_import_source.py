"""Unit tests for the SQL DDL ImportSource — FMT-5.6 (#5444).

Organised around the ticket's five acceptance criteria:

#. a DDL script imports, with tables becoming canonical types and foreign keys becoming
   relationships;
#. the dialect is detected **and recorded**, and an override forces one;
#. vendor-specific constructs that cannot be modelled are *declared* parsing limits;
#. the round trip against the filed emitter (**#4311**) is asserted once both exist — the
   shared type-mapping table it will read is asserted here in the meantime;
#. the corpus covers each dialect, a migrations directory, and a syntactically broken
   script.

Plus the two things every reader in this fleet must prove: that its declared limits are
one vocabulary in three places, and that every taxonomy code its negatives claim is the
code the pipeline actually reports.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

import pytest

from app.canonical_json_schema import CANONICAL_SCALAR_SCHEMAS
from app.canonical_model import ApiParadigm, TypeKind
from app.fileset import IntakeFileset
from app.format_capability_registry import ProjectionCoverage, capability_for
from app.format_version_coverage import VersionSupport, version_coverage_for
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)
from app.import_source_pipeline import _classify_parse_failure
from app.sql_ddl_dialects import (
    DIALECT_LABELS,
    SQL_TYPE_SCALARS,
    SqlDialect,
    detect_dialect,
    normalize_dialect,
)
from app.sql_ddl_import_source import (
    SQL_DDL_CAPABILITIES,
    SQL_DIALECT_OPTION,
    SqlDdlImportSource,
)
from app.sql_ddl_normalizer import SQL_DDL_EXTRAS_KEY, SqlDdlNormalizer
from app.sql_ddl_parser import (
    detection_confidence,
    is_sql_ddl,
    parse_sql_ddl,
    parse_sql_ddl_fileset,
    render,
    split_statements,
    tokenize,
)
from app.sql_ddl_schema import (
    LIMIT_DETAILS,
    MAX_PAREN_DEPTH,
    MAX_SQL_BYTES,
    ConstraintKind,
    LimitRecorder,
    SqlDdlParseError,
)

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "sql-ddl"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _corpus_text(name: str) -> str:
    """Read a shipped corpus fixture, asserting it is still there."""
    path = CORPUS / name
    assert path.is_file(), f"missing corpus fixture {name} — the suite asserts against it"
    return path.read_text(encoding="utf-8")


def _corpus_bytes(name: str) -> bytes:
    """Read a shipped corpus fixture's raw bytes."""
    path = CORPUS / name
    assert path.is_file(), f"missing corpus fixture {name}"
    return path.read_bytes()


def _migrations_members() -> Dict[str, str]:
    """Return the shipped migrations set, keyed by member filename."""
    directory = CORPUS / "03-migrations-set"
    members = {path.name: path.read_text(encoding="utf-8") for path in sorted(directory.glob("*.sql"))}
    assert len(members) == 3, "the migrations fixture should still have three members"
    return members


def _adapter(**kwargs: Optional[str]) -> SqlDdlImportSource:
    """Return the registered adapter, optionally configured with an option bag."""
    source = get_import_source("sql-ddl")
    assert isinstance(source, SqlDdlImportSource)
    if kwargs:
        configured = source.configure({key: value for key, value in kwargs.items()})
        assert isinstance(configured, SqlDdlImportSource)
        return configured
    return source


def _model(name: str):
    """Parse and normalize one corpus fixture."""
    adapter = _adapter()
    return adapter.normalize(adapter.parse(_corpus_text(name), source_label=name), include_raw=False)


def _field(model, type_key: str, field_name: str):
    """Return one field of one canonical type, asserting both exist."""
    type_ = model.type_by_key(type_key)
    assert type_ is not None, f"no canonical type {type_key!r} (have {[t.key for t in model.types]})"
    for field in type_.fields:
        if field.name == field_name:
            return field
    raise AssertionError(f"{type_key!r} has no field {field_name!r} ({[f.name for f in type_.fields]})")


# ===========================================================================
# Registration and descriptor
# ===========================================================================


def test_adapter_is_registered_with_a_data_schema_descriptor() -> None:
    descriptor = _adapter().descriptor()
    assert descriptor.key == "sql-ddl"
    assert descriptor.paradigm is ApiParadigm.DATA_SCHEMA
    assert descriptor.formats == ["sql-ddl"]
    assert descriptor.supports_live_discovery is False, (
        "FMT-5.6 is file intake only: live introspection is explicitly out of scope"
    )
    assert ".sql" in descriptor.file_extensions
    assert ".zip" in descriptor.file_extensions, "a fileset adapter carries the archive suffixes"
    assert "fileset" in [kind.value for kind in descriptor.input_kinds]


def test_no_input_kind_opens_a_connection() -> None:
    """The security boundary the ticket draws, asserted rather than assumed."""
    kinds = {kind.value for kind in _adapter().descriptor().input_kinds}
    assert "discovery" not in kinds
    assert kinds == {"file", "url", "paste", "fileset"}


# ===========================================================================
# Detection
# ===========================================================================


@pytest.mark.parametrize(
    "name",
    [
        "01-minimal-ansi.sql",
        "02-typical-postgres.sql",
        "04-stress-mysql.sql",
        "05-real-world-sqlserver.sql",
        "06-typical-oracle.sql",
        "07-composition-inheritance-and-views.sql",
    ],
)
def test_every_dialect_fixture_is_claimed_above_the_manifest_floor(name: str) -> None:
    result = _adapter().detect(DetectionInput(text=_corpus_text(name), filename=name))
    assert result.format == "sql-ddl"
    assert result.confidence >= 0.85


def test_a_migration_file_is_claimed_but_less_confidently_than_a_definition() -> None:
    alter_only = _migrations_members()["V2__widen_and_rename.sql"]
    definition = _corpus_text("01-minimal-ansi.sql")
    assert 0.85 <= detection_confidence(alter_only) < detection_confidence(definition)


def test_detection_ignores_a_create_table_that_is_only_mentioned_in_a_comment() -> None:
    """A document that documents DDL is not a DDL document."""
    prose = "-- This exporter writes CREATE TABLE statements.\n/* CREATE VIEW too. */\n"
    assert is_sql_ddl(prose) is False


def test_auto_detection_routes_a_ddl_script_to_this_adapter() -> None:
    """The GraphQL sniffer claims any text containing ``type ``/``enum `` — including a
    ``CREATE TYPE … AS ENUM`` script — so the definition mark has to outrank it."""
    text = _corpus_text("02-typical-postgres.sql")
    best = detect_import_source(DetectionInput(text=text, filename="02-typical-postgres.sql"))
    assert best is not None
    assert best[0].key == "sql-ddl", f"auto-detection chose {best[0].key!r}"


def test_a_dbml_document_is_not_claimed() -> None:
    assert is_sql_ddl(_corpus_text("negative/04-wrong-format-dbml.dbml")) is False


# ===========================================================================
# Dialect detection, recording and override
# ===========================================================================


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("01-minimal-ansi.sql", SqlDialect.ANSI),
        ("02-typical-postgres.sql", SqlDialect.POSTGRES),
        ("04-stress-mysql.sql", SqlDialect.MYSQL),
        ("05-real-world-sqlserver.sql", SqlDialect.SQLSERVER),
        ("06-typical-oracle.sql", SqlDialect.ORACLE),
        ("07-composition-inheritance-and-views.sql", SqlDialect.POSTGRES),
    ],
)
def test_each_fixture_is_detected_as_the_dialect_its_readme_declares(name: str, expected: str) -> None:
    assert parse_sql_ddl(_corpus_text(name), source_label=name).dialect == expected


def test_a_detected_dialect_records_the_markers_that_decided_it() -> None:
    catalog = parse_sql_ddl(_corpus_text("04-stress-mysql.sql"))
    assert catalog.dialect_source == "detected"
    assert "auto-increment" in catalog.dialect_evidence
    assert "backtick-identifier" in catalog.dialect_evidence


def test_a_script_with_no_vendor_marker_is_ansi_by_verdict_not_by_guess() -> None:
    catalog = parse_sql_ddl(_corpus_text("01-minimal-ansi.sql"))
    assert catalog.dialect == SqlDialect.ANSI
    assert catalog.dialect_source == "default"
    assert catalog.dialect_evidence == ()


def test_the_dialect_and_how_it_was_resolved_reach_the_canonical_model() -> None:
    record = _model("06-typical-oracle.sql").extras[SQL_DDL_EXTRAS_KEY]
    assert record["dialect"] == SqlDialect.ORACLE
    assert record["dialect_label"] == DIALECT_LABELS[SqlDialect.ORACLE]
    assert record["dialect_source"] == "detected"
    assert record["dialect_evidence"]


def test_the_override_option_forces_a_dialect_against_the_markers() -> None:
    text = _corpus_text("04-stress-mysql.sql")
    assert parse_sql_ddl(text).dialect == SqlDialect.MYSQL
    forced = _adapter(**{SQL_DIALECT_OPTION: "postgresql"}).parse(text)
    assert forced.dialect == SqlDialect.POSTGRES
    assert forced.dialect_source == "override"
    assert forced.dialect_evidence == ()


def test_configure_returns_the_same_adapter_when_no_dialect_is_requested() -> None:
    adapter = _adapter()
    assert adapter.configure({}) is adapter
    assert adapter.configure({SQL_DIALECT_OPTION: "  "}) is adapter
    assert adapter.configure({"unrelated": "value"}) is adapter


def test_configure_returns_a_copy_so_two_imports_cannot_see_each_others_setting() -> None:
    adapter = _adapter()
    configured = adapter.configure({SQL_DIALECT_OPTION: "oracle"})
    assert configured is not adapter
    assert adapter.parse(_corpus_text("04-stress-mysql.sql")).dialect == SqlDialect.MYSQL


def test_an_unknown_dialect_override_is_refused_rather_than_ignored() -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter().configure({SQL_DIALECT_OPTION: "sqlite"})
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "sqlite" in str(excinfo.value)


@pytest.mark.parametrize(
    ("spelling", "expected"),
    [
        ("PostgreSQL", SqlDialect.POSTGRES),
        ("tsql", SqlDialect.SQLSERVER),
        ("MSSQL", SqlDialect.SQLSERVER),
        ("mariadb", SqlDialect.MYSQL),
        ("standard", SqlDialect.ANSI),
        ("sql_server", SqlDialect.SQLSERVER),
    ],
)
def test_the_override_accepts_the_spellings_a_human_types(spelling: str, expected: str) -> None:
    assert normalize_dialect(spelling) == expected


def test_detection_is_bounded_and_scores_every_candidate() -> None:
    detection = detect_dialect(_corpus_text("05-real-world-sqlserver.sql"))
    scores = dict(detection.scores)
    assert set(scores) == {
        SqlDialect.POSTGRES,
        SqlDialect.MYSQL,
        SqlDialect.SQLSERVER,
        SqlDialect.ORACLE,
    }
    assert scores[SqlDialect.SQLSERVER] == max(scores.values())


# ===========================================================================
# Lexing and statement splitting
# ===========================================================================


def test_a_go_batch_separator_ends_a_statement_only_when_it_stands_alone() -> None:
    script = "CREATE TABLE a (id INT);\nGO\nCREATE TABLE b (id INT);\n"
    tokens = tokenize(script, dialect=SqlDialect.SQLSERVER)
    statements, unterminated = split_statements(tokens, dialect=SqlDialect.SQLSERVER)
    assert [token.value.upper() for token in statements[0][:2]] == ["CREATE", "TABLE"]
    assert len(statements) == 2
    assert unterminated is False


def test_a_table_called_go_is_still_readable() -> None:
    """``GO`` is a batch separator only on a line of its own — otherwise it is a name."""
    catalog = parse_sql_ddl("CREATE TABLE go (id INT NOT NULL);", dialect="sqlserver")
    assert "go" in catalog.relations


def test_a_semicolon_inside_parentheses_does_not_end_a_statement() -> None:
    tokens = tokenize("CREATE TABLE t (note VARCHAR(8) DEFAULT 'a;b');")
    statements, _ = split_statements(tokens)
    assert len(statements) == 1


def test_each_dialect_reads_its_own_identifier_quoting() -> None:
    assert "product" in parse_sql_ddl("CREATE TABLE `product` (`id` INT);", dialect="mysql").relations
    assert "Product" in parse_sql_ddl("CREATE TABLE [Product] ([Id] INT);", dialect="sqlserver").relations
    assert "order" in parse_sql_ddl('CREATE TABLE "order" ("id" INT);', dialect="postgres").relations


def test_a_quoted_identifier_is_never_read_as_a_keyword() -> None:
    catalog = parse_sql_ddl('CREATE TABLE t ("check" INT NOT NULL, "unique" INT);', dialect="postgres")
    assert [column.name for column in catalog.relations["t"].columns] == ["check", "unique"]
    assert not catalog.relations["t"].constraints


def test_a_mysql_hash_comment_is_a_comment() -> None:
    catalog = parse_sql_ddl("# a note\nCREATE TABLE `t` (`id` INT);", dialect="mysql")
    assert "t" in catalog.relations


def test_a_dollar_quoted_string_is_one_token() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE t (note text DEFAULT $tag$a ; b$tag$ NOT NULL);", dialect="postgres"
    )
    assert catalog.relations["t"].columns[0].default_literal == "a ; b"


def test_render_is_stable_and_readable() -> None:
    tokens = tokenize("CHECK (total_amount >= 0 AND status IN ('a','b'))")
    assert render(tokens) == "CHECK (total_amount >= 0 AND status IN ('a', 'b'))"


# ===========================================================================
# Tables become types, columns become properties
# ===========================================================================


def test_a_minimal_script_imports_as_one_record_with_its_columns() -> None:
    model = _model("01-minimal-ansi.sql")
    assert model.paradigm is ApiParadigm.DATA_SCHEMA
    assert model.format == "sql-ddl"
    beacon = model.type_by_key("beacon")
    assert beacon is not None
    assert beacon.kind is TypeKind.RECORD
    assert [field.name for field in beacon.fields] == ["beacon_id", "seen_at"]
    assert beacon.extras["sql_key"]["primary_key"]["columns"] == ["beacon_id"]


def test_a_schema_qualified_table_keys_and_namespaces_by_its_schema() -> None:
    model = _model("02-typical-postgres.sql")
    customer = model.type_by_key("commerce.customer")
    assert customer is not None
    assert customer.namespace == "commerce"
    assert customer.name == "customer"


def test_not_null_and_a_primary_key_both_make_a_column_non_nullable() -> None:
    model = _model("02-typical-postgres.sql")
    assert _field(model, "commerce.customer", "customer_id").type.nullable is False
    assert _field(model, "commerce.customer", "display_name").type.nullable is False
    assert _field(model, "commerce.order", "note").type.nullable is True


def test_a_composite_primary_key_marks_every_key_column_non_nullable() -> None:
    model = _model("02-typical-postgres.sql")
    line = model.type_by_key("commerce.order_line")
    assert line is not None
    assert line.extras["sql_key"]["primary_key"]["columns"] == ["order_id", "line_number"]
    assert _field(model, "commerce.order_line", "line_number").type.nullable is False


def test_a_literal_default_is_modelled_and_an_expression_default_is_carried() -> None:
    model = _model("02-typical-postgres.sql")
    total = _field(model, "commerce.order", "total_amount")
    assert total.default == 0
    created = _field(model, "commerce.customer", "created_at")
    assert created.default is None
    assert created.extras["sql_default_expression"] == "now()"


def test_default_null_is_a_default_and_not_the_absence_of_one() -> None:
    catalog = parse_sql_ddl("CREATE TABLE t (a INT DEFAULT NULL, b INT);", dialect="postgres")
    columns = {column.name: column for column in catalog.relations["t"].columns}
    assert columns["a"].has_default is True and columns["a"].default_literal is None
    assert columns["b"].has_default is False


def test_a_column_comment_becomes_its_description_from_either_spelling() -> None:
    postgres = _model("02-typical-postgres.sql")
    assert _field(postgres, "commerce.customer", "email").description == (
        "Login address; unique across the tenant."
    )
    assert postgres.type_by_key("commerce.customer").description == "One row per customer account."
    mysql = _model("04-stress-mysql.sql")
    assert mysql.type_by_key("shop.product").description == "Sellable products"


def test_a_user_defined_enum_becomes_an_enum_type_a_column_references() -> None:
    model = _model("02-typical-postgres.sql")
    status_type = model.type_by_key("commerce.order_status")
    assert status_type is not None
    assert status_type.kind is TypeKind.ENUM
    assert [value.name for value in status_type.enum_values] == ["new", "paid", "shipped", "cancelled"]
    assert _field(model, "commerce.order", "status").type.name == "commerce.order_status"


def test_a_domain_becomes_an_alias_carrying_its_base_scalar_and_check() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    domain = model.type_by_key("sku_code")
    assert domain is not None
    assert domain.kind is TypeKind.ALIAS
    assert domain.aliased is not None and domain.aliased.name == "string"
    assert domain.extras["sql_checks"]
    assert _field(model, "product", "sku").type.name == "sku_code"


def test_a_composite_type_becomes_a_record_a_column_references() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    composite = model.type_by_key("money_amount")
    assert composite is not None
    assert composite.kind is TypeKind.RECORD
    assert {field.name for field in composite.fields} == {"minor_units", "currency"}
    assert _field(model, "product", "price").type.name == "money_amount"


# ===========================================================================
# Type and constraint mapping
# ===========================================================================


def test_every_mapped_scalar_is_one_the_rest_of_the_fleet_uses() -> None:
    unknown = sorted(
        {scalar for scalar in SQL_TYPE_SCALARS.values() if scalar not in CANONICAL_SCALAR_SCHEMAS}
    )
    assert unknown == ["json"], "``json`` is an `_ANY_SCALARS` member; anything else is a typo"


@pytest.mark.parametrize(
    ("declaration", "expected"),
    [
        ("VARCHAR(16)", "string"),
        ("CHARACTER VARYING(16)", "string"),
        ("NATIONAL CHARACTER VARYING(16)", "string"),
        ("DOUBLE PRECISION", "double"),
        ("TIMESTAMP(6) WITH TIME ZONE", "timestamp"),
        ("TIMESTAMP WITHOUT TIME ZONE", "timestamp"),
        ("BIGINT UNSIGNED", "int64"),
        ("NUMERIC(13,2)", "decimal"),
        ("BOOLEAN", "boolean"),
        ("BYTEA", "bytes"),
        ("JSONB", "json"),
        ("UUID", "uuid"),
    ],
)
def test_a_multiword_or_modified_type_still_projects_by_its_base_name(
    declaration: str, expected: str
) -> None:
    catalog = parse_sql_ddl(f"CREATE TABLE t (c {declaration});", dialect="postgres")
    model = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    assert _field(model, "t", "c").type.name == expected


def test_a_character_length_becomes_max_length_and_a_binary_width_does_not() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE t (a VARCHAR(16), b VARBINARY(16), c NVARCHAR(MAX));", dialect="sqlserver"
    )
    model = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    assert _field(model, "t", "a").constraints.max_length == 16
    assert _field(model, "t", "b").constraints is None
    assert _field(model, "t", "c").constraints is None


def test_an_oracle_length_is_only_claimed_when_the_script_states_its_unit() -> None:
    """``VARCHAR2(40)`` is forty bytes or forty characters depending on the session."""
    catalog = parse_sql_ddl(
        "CREATE TABLE t (a VARCHAR2(40), b VARCHAR2(40 CHAR));", dialect="oracle"
    )
    model = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    assert _field(model, "t", "a").constraints is None
    assert _field(model, "t", "b").constraints.max_length == 40
    limits = {row["construct"] for row in model.extras[SQL_DDL_EXTRAS_KEY]["capability_limits"]}
    assert "sql.length_semantics" in limits


def test_the_declared_type_spelling_is_always_carried_verbatim() -> None:
    model = _model("02-typical-postgres.sql")
    assert _field(model, "commerce.order", "total_amount").extras["sql_data_type"] == "numeric(13, 2)"


def test_an_inline_enum_becomes_an_enum_constraint() -> None:
    model = _model("04-stress-mysql.sql")
    kind = _field(model, "shop.product", "kind")
    assert kind.constraints is not None
    assert kind.constraints.enum == ["physical", "digital", "service"]
    assert kind.default == "physical"


def test_a_mysql_set_is_a_list_of_its_members() -> None:
    model = _model("04-stress-mysql.sql")
    channels = _field(model, "shop.product", "channels")
    assert channels.type.is_list()
    assert channels.constraints.enum == ["web", "store", "partner"]


def test_a_check_that_enumerates_literals_also_becomes_an_enum() -> None:
    model = _model("05-real-world-sqlserver.sql")
    status = _field(model, "claims.Claim", "Status")
    assert status.constraints is not None
    assert status.constraints.enum == ["open", "assessing", "settled", "rejected"]


def test_a_general_check_predicate_is_carried_and_not_decoded() -> None:
    model = _model("02-typical-postgres.sql")
    order = model.type_by_key("commerce.order")
    expressions = [check["expression"] for check in order.extras["sql_checks"]]
    assert "total_amount >= 0" in expressions
    assert _field(model, "commerce.order", "total_amount").constraints is None


def test_an_array_column_is_a_list_of_its_element_scalar() -> None:
    catalog = parse_sql_ddl("CREATE TABLE t (tags text[] NOT NULL);", dialect="postgres")
    model = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    reference = _field(model, "t", "tags").type
    assert reference.is_list() and reference.item.name == "string"


# ===========================================================================
# Foreign keys become relationships
# ===========================================================================


def test_a_foreign_key_becomes_a_relationship_on_the_origin_field() -> None:
    model = _model("02-typical-postgres.sql")
    [edge] = _field(model, "commerce.order", "customer_id").extras["sql_relationship"]
    assert edge["type"] == "foreignKey"
    assert edge["name"] == "order_customer_fk"
    assert edge["to_type"] == "commerce.customer"
    assert edge["to"] == "commerce.customer.customer_id"
    assert edge["to_field"] == "commerce.customer.customer_id"
    assert edge["on_delete"] == "RESTRICT"


def test_an_inline_references_clause_produces_the_same_edge_as_a_named_constraint() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    [edge] = _field(model, "sales_order_line", "sku").extras["sql_relationship"]
    assert edge["to_type"] == "product"
    assert edge["to"] == "product.sku"


def test_a_composite_foreign_key_pairs_its_columns_by_position() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    [order_edge] = _field(model, "sales_order_line", "order_id").extras["sql_relationship"]
    [placed_edge] = _field(model, "sales_order_line", "placed_at").extras["sql_relationship"]
    assert order_edge["to"] == "sales_order.order_id"
    assert placed_edge["to"] == "sales_order.placed_at"
    assert order_edge["on_delete"] == "CASCADE"


def test_recorded_relationships_are_listed_once_at_the_document_level() -> None:
    record = _model("02-typical-postgres.sql").extras[SQL_DDL_EXTRAS_KEY]
    edges = {(edge["from"], edge["to"]) for edge in record["relationships"]}
    assert ("commerce.order", "commerce.customer") in edges
    assert ("commerce.order_line", "commerce.order") in edges


def test_a_foreign_key_naming_a_table_the_import_lacks_is_refused() -> None:
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(_corpus_text("negative/06-unresolvable-foreign-key.sql"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "customer_master" in str(excinfo.value)


def test_a_reference_resolves_case_insensitively_across_dialect_folding() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE Parent (id INT PRIMARY KEY);\n"
        "CREATE TABLE child (parent_id INT REFERENCES PARENT (id));",
        dialect="oracle",
    )
    [fk] = [c for c in catalog.relations["child"].constraints if c.kind == ConstraintKind.FOREIGN_KEY]
    assert fk.reference.resolved_table == "Parent"


# ===========================================================================
# Views
# ===========================================================================


def test_a_view_becomes_a_record_whose_plain_columns_resolve_to_the_source() -> None:
    model = _model("02-typical-postgres.sql")
    view = model.type_by_key("commerce.open_orders")
    assert view is not None
    assert view.extras["sql_kind"] == "view"
    assert [field.name for field in view.fields] == [
        "customer_id",
        "order_id",
        "placed_at",
        "total_amount",
    ]
    total = _field(model, "commerce.open_orders", "total_amount")
    assert total.type.name == "decimal"
    assert total.extras["sql_source"] == "commerce.order.total_amount"


def test_a_view_column_produced_by_an_expression_is_named_by_its_alias() -> None:
    model = _model("05-real-world-sqlserver.sql")
    outstanding = _field(model, "claims.vOutstandingClaims", "Outstanding")
    assert outstanding.type.name == "string", "the document states no type for an expression"
    assert "ReserveAmount" in outstanding.extras["sql_expression"]


def test_a_multiplied_select_item_is_not_mistaken_for_a_star_projection() -> None:
    """``l.unit_price * l.quantity`` is arithmetic; only ``*``/``alias.*`` is a star."""
    model = _model("07-composition-inheritance-and-views.sql")
    view = model.type_by_key("order_summary")
    assert "computed_minor_units" in {field.name for field in view.fields}


def test_a_materialized_view_is_modelled_and_labelled_as_one() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    view = model.type_by_key("order_summary_daily")
    assert view is not None
    assert view.extras["sql_kind"] == "materialized_view"
    assert {field.name for field in view.fields} == {"day", "orders"}


def test_a_views_select_is_carried_verbatim_and_never_executed() -> None:
    model = _model("02-typical-postgres.sql")
    carried = model.type_by_key("commerce.open_orders").extras["sql_view"]
    assert carried["definition"].startswith("SELECT")
    assert carried["columns"]


# ===========================================================================
# Composition: inheritance and partitioning
# ===========================================================================


def test_inherited_columns_are_modelled_and_the_link_is_carried() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    product = model.type_by_key("product")
    names = [field.name for field in product.fields]
    assert {"created_at", "created_by", "updated_at", "updated_by"} <= set(names)
    assert product.extras["sql_inherits"] == ["audited"]


def test_a_declarative_partition_child_carries_its_parents_columns() -> None:
    model = _model("07-composition-inheritance-and-views.sql")
    child = model.type_by_key("sales_order_2025")
    assert [field.name for field in child.fields] == ["order_id", "placed_at", "status", "total"]
    assert child.extras["sql_partitioning"]["partition_of"] == "sales_order"


def test_an_inheritance_cycle_terminates_instead_of_spinning() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE a (x INT) INHERITS (b);\nCREATE TABLE b (y INT) INHERITS (a);",
        dialect="postgres",
    )
    assert {column.name for column in catalog.relations["a"].columns} >= {"x", "y"}


# ===========================================================================
# ALTER: the script is a sequence of edits
# ===========================================================================


def test_a_migrations_directory_imports_as_its_final_state() -> None:
    catalog = parse_sql_ddl_fileset(_migrations_members(), root="V1__create_core.sql")
    account = catalog.relations["account"]
    names = [column.name for column in account.columns]
    assert "login" not in names, "V2 renamed it"
    assert "username" in names
    assert account.column("email").data_type == "VARCHAR(255)", "V2 widened it"
    assert account.column("email").not_null is True, "V3 constrained it"
    assert account.column("country_code") is not None, "V2 added it"
    assert "ledger_entry_tag" in catalog.relations, "V3 created it"


def test_the_applied_order_of_a_file_set_is_recorded() -> None:
    catalog = parse_sql_ddl_fileset(_migrations_members(), root="V1__create_core.sql")
    assert catalog.fileset["applied"] == [
        "V1__create_core.sql",
        "V2__widen_and_rename.sql",
        "V3__constraints_and_indexes.sql",
    ]


def test_a_member_carrying_no_ddl_is_skipped_and_said_so() -> None:
    members = dict(_migrations_members())
    members["README.md"] = "# How to run these migrations\n"
    members["seed.sql"] = "INSERT INTO account (username) VALUES ('root');\n"
    catalog = parse_sql_ddl_fileset(members, root="V1__create_core.sql")
    assert catalog.fileset["skipped"] == ["README.md", "seed.sql"]


def test_a_rename_follows_the_column_through_its_constraints() -> None:
    catalog = parse_sql_ddl_fileset(_migrations_members(), root="V1__create_core.sql")
    unique = [
        constraint
        for constraint in catalog.relations["account"].constraints
        if constraint.kind == ConstraintKind.UNIQUE
    ]
    assert unique and unique[0].columns == ("username",)


def test_alter_table_handles_every_dialects_spelling() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE t (a INT NOT NULL, b VARCHAR(10), c INT, d INT);\n"
        "ALTER TABLE t ALTER COLUMN a DROP NOT NULL;\n"
        "ALTER TABLE t ALTER COLUMN b SET DATA TYPE VARCHAR(40);\n"
        "ALTER TABLE t ALTER COLUMN c SET DEFAULT 7;\n"
        "ALTER TABLE t DROP COLUMN d;\n"
        "ALTER TABLE t RENAME TO renamed;\n",
        dialect="postgres",
    )
    relation = catalog.relations["renamed"]
    assert relation.column("a").not_null is False
    assert relation.column("b").data_type == "VARCHAR(40)"
    assert relation.column("c").default_literal == 7
    assert relation.column("d") is None


def test_a_transact_sql_add_without_the_column_keyword_still_adds_a_column() -> None:
    model = _model("05-real-world-sqlserver.sql")
    assert _field(model, "claims.Claim", "LossAdjusterId").type.name == "int32"


def test_a_mysql_alter_applies_every_comma_separated_action() -> None:
    model = _model("04-stress-mysql.sql")
    assert _field(model, "shop.product", "brand").type.name == "string"
    indexes = {index["name"] for index in model.type_by_key("shop.product").extras["sql_indexes"]}
    assert "product_brand_idx" in indexes


def test_drop_table_removes_the_relation_from_the_final_state() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE keep (id INT);\nCREATE TABLE gone (id INT);\nDROP TABLE gone;",
        dialect="postgres",
    )
    assert set(catalog.relations) == {"keep"}


def test_an_alter_naming_an_unknown_table_is_recorded_not_fatal() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE known (id INT);\nALTER TABLE elsewhere ADD COLUMN x INT;",
        dialect="postgres",
    )
    assert "known" in catalog.relations
    limits = {limit.construct for limit in catalog.limits.limits()}
    assert "sql.unsupported_statement" in limits


# ===========================================================================
# Vendor constructs are declared limits
# ===========================================================================


def _limits(model) -> Dict[str, int]:
    """Return the model's declared-limit ledger as ``construct -> count``."""
    return {
        row["construct"]: row["count"]
        for row in model.extras[SQL_DDL_EXTRAS_KEY]["capability_limits"]
    }


def test_the_limit_vocabulary_is_one_list_in_three_places() -> None:
    """`LIMIT_DETAILS`, the adapter's `unsupported` list and the reviewed seed must agree."""
    declared = set(LIMIT_DETAILS)
    assert set(SQL_DDL_CAPABILITIES.unsupported) == declared
    capability = capability_for("sql-ddl")
    assert capability is not None
    assert set(capability.canonical_projection.dropped_constructs) == declared
    assert capability.canonical_projection.coverage is ProjectionCoverage.PARTIAL


def test_every_declared_limit_is_reachable() -> None:
    """A limit nobody can hit is a claim, not a boundary."""
    reached: set[str] = set()
    for name in (
        "02-typical-postgres.sql",
        "04-stress-mysql.sql",
        "05-real-world-sqlserver.sql",
        "06-typical-oracle.sql",
        "07-composition-inheritance-and-views.sql",
    ):
        reached |= set(_limits(_model(name)))
    extra = SqlDdlNormalizer().normalize(
        parse_sql_ddl(
            "CREATE TABLE t (a VARCHAR2(40), b VARCHAR2(10) COLLATE BINARY_CI);\n"
            "GRANT SELECT ON t TO reader;\n",
            dialect="oracle",
        ),
        include_raw=False,
    )
    reached |= set(_limits(extra))
    assert set(LIMIT_DETAILS) - reached == set()


def test_a_vendor_type_with_no_portable_meaning_is_declared() -> None:
    model = _model("05-real-world-sqlserver.sql")
    assert _limits(model)["sql.vendor_type"] >= 1
    assert _field(model, "claims.Policy", "RowVersion").type.name == "bytes"


def test_storage_clauses_and_partitions_are_carried_not_dropped() -> None:
    model = _model("04-stress-mysql.sql")
    product = model.type_by_key("shop.product")
    assert product.extras["sql_table_options"]["ENGINE"] == "InnoDB"
    history = model.type_by_key("shop.price_history")
    assert "PARTITION BY RANGE" in history.extras["sql_partitioning"]["clause"]
    assert _limits(model)["sql.partitioning"] >= 1


def test_a_computed_column_carries_its_expression_and_its_storage() -> None:
    mysql = _model("04-stress-mysql.sql")
    generated = _field(mysql, "shop.stock", "available").extras["sql_generated"]
    assert generated["storage"] == "virtual"
    assert "on_hand" in generated["expression"]
    sqlserver = _model("05-real-world-sqlserver.sql")
    persisted = _field(sqlserver, "claims.Policy", "IsActive").extras["sql_generated"]
    assert persisted["storage"] == "persisted"


def test_identity_is_carried_however_the_dialect_spells_it() -> None:
    assert _field(_model("04-stress-mysql.sql"), "shop.product", "product_id").extras[
        "sql_identity"
    ] == {"kind": "auto_increment"}
    assert _field(_model("05-real-world-sqlserver.sql"), "claims.Policy", "PolicyId").extras[
        "sql_identity"
    ]["kind"] == "identity"
    oracle = _field(_model("06-typical-oracle.sql"), "hr_employee", "employee_id")
    assert oracle.extras["sql_identity"]["mode"] == "by default"
    catalog = parse_sql_ddl("CREATE TABLE t (id BIGSERIAL PRIMARY KEY);", dialect="postgres")
    assert catalog.relations["t"].columns[0].identity == {"kind": "serial"}


def test_indexes_are_carried_with_their_filters_and_covering_columns() -> None:
    model = _model("05-real-world-sqlserver.sql")
    indexes = {index["name"]: index for index in model.type_by_key("claims.Claim").extras["sql_indexes"]}
    assert indexes["IX_Claim_Policy"]["include"] == ["Status", "ReserveAmount"]
    assert "Status IN" in indexes["IX_Claim_Open"]["predicate"]


def test_an_expression_index_keeps_its_expression() -> None:
    model = _model("02-typical-postgres.sql")
    indexes = {index["name"]: index for index in model.type_by_key("commerce.customer").extras["sql_indexes"]}
    assert indexes["customer_email_lower_idx"]["columns"] == ["lower(email)"]
    assert indexes["customer_email_lower_idx"]["unique"] is True


def test_sequences_and_schemas_are_carried_at_the_document_level() -> None:
    oracle = _model("06-typical-oracle.sql")
    assert [sequence["name"] for sequence in oracle.extras["sql_sequences"]] == ["hr_department_seq"]
    postgres = _model("02-typical-postgres.sql")
    assert [schema["name"] for schema in postgres.extras["sql_schemas"]] == ["commerce"]


def test_a_use_statement_namespaces_the_tables_that_follow_it() -> None:
    model = _model("04-stress-mysql.sql")
    assert model.type_by_key("shop.product") is not None
    assert model.extras[SQL_DDL_EXTRAS_KEY]["current_schema"] == "shop"


def test_a_statement_this_reader_does_not_model_is_counted_and_located() -> None:
    catalog = parse_sql_ddl(
        "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nGRANT SELECT ON t TO reader;",
        dialect="postgres",
    )
    counts = {limit.construct: limit.count for limit in catalog.limits.limits()}
    assert counts["sql.unsupported_statement"] == 2


# ===========================================================================
# Negatives: the codes the manifest declares
# ===========================================================================


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("negative/01-syntactic-missing-paren.sql", "INPUT_MALFORMED"),
        ("negative/02-semantic-table-without-columns.sql", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-statement.sql", "INPUT_TRUNCATED"),
        ("negative/06-unresolvable-foreign-key.sql", "INPUT_REFERENCE_UNRESOLVED"),
    ],
)
def test_each_negative_is_refused_with_the_code_its_manifest_entry_declares(
    name: str, expected: str
) -> None:
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(_corpus_text(name), source_label=name)
    assert excinfo.value.code == expected


def test_a_lost_bracket_and_a_cut_off_file_are_told_apart() -> None:
    """Both end with an unclosed parenthesis; only one has a later statement inside it."""
    with pytest.raises(SqlDdlParseError) as lost:
        parse_sql_ddl(_corpus_text("negative/01-syntactic-missing-paren.sql"))
    with pytest.raises(SqlDdlParseError) as cut:
        parse_sql_ddl(_corpus_text("negative/03-truncated-mid-statement.sql"))
    assert lost.value.code == "INPUT_MALFORMED"
    assert cut.value.code == "INPUT_TRUNCATED"


def test_a_wrong_format_document_is_refused_as_a_format_mismatch() -> None:
    adapter = _adapter()
    text = _corpus_text("negative/04-wrong-format-dbml.dbml")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(text, source_label="04-wrong-format-dbml.dbml")
    assert excinfo.value.code == "FORMAT_MISMATCH"
    assert _classify_parse_failure(excinfo.value, adapter, text, "x.dbml") == "FORMAT_MISMATCH"


def test_a_badly_decoded_document_reads_as_an_encoding_fault_not_a_mismatch() -> None:
    """The refusal is deliberately code-less so the pipeline reports what it really is."""
    adapter = _adapter()
    text = _corpus_bytes("negative/05-encoding-utf16.sql").decode("utf-8", errors="replace")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(text, source_label="05-encoding-utf16.sql")
    assert excinfo.value.code is None
    assert (
        _classify_parse_failure(excinfo.value, adapter, text, "05-encoding-utf16.sql")
        == "INPUT_ENCODING_INVALID"
    )


def test_an_unterminated_string_is_truncation() -> None:
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl("CREATE TABLE t (a VARCHAR(4) DEFAULT 'oops")
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_file_set_with_no_ddl_member_is_refused() -> None:
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl_fileset({"a.sql": "SELECT 1;\n"}, root="a.sql")
    assert excinfo.value.code == "FORMAT_MISMATCH"


def test_a_fileset_missing_its_root_is_refused_by_the_adapter() -> None:
    fileset = IntakeFileset(root="missing.sql", members={"a.sql": "CREATE TABLE t (id INT);"})
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter().parse_fileset(fileset)
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_normalize_refuses_something_that_is_not_a_read_catalog() -> None:
    with pytest.raises(ImportSourceError):
        _adapter().normalize({"not": "a catalog"})
    with pytest.raises(ValueError):
        SqlDdlNormalizer().normalize("not a catalog")


# ===========================================================================
# Determinism, provenance and the coverage ledger
# ===========================================================================


def test_normalizing_twice_produces_the_same_model_and_the_same_ledger() -> None:
    catalog = parse_sql_ddl(_corpus_text("04-stress-mysql.sql"))
    first = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    second = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    assert first.model_dump() == second.model_dump()
    assert canonical_fingerprint(first) == canonical_fingerprint(second)


def test_the_projection_record_is_the_only_registered_provenance_key() -> None:
    assert SQL_DDL_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS
    for carried in ("sql_key", "sql_checks", "sql_indexes", "sql_schemas", "sql_sequences"):
        assert carried not in PROVENANCE_EXTRA_KEYS, (
            f"{carried} is a source construct, so it must read as partial coverage"
        )


def test_the_declared_limits_render_as_partially_mapped_ledger_rows() -> None:
    model = _model("04-stress-mysql.sql")
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(model, adapter_key="sql-ddl", options={})
    )
    rows = {
        row.source_construct: row
        for row in page.coverage
        if row.source_construct.startswith("sql.")
    }
    declared = {row["construct"] for row in model.extras[SQL_DDL_EXTRAS_KEY]["capability_limits"]}
    assert set(rows) == declared
    for row in rows.values():
        assert row.coverage is CoverageClass.PARTIALLY_MAPPED
        assert row.document_scoped is True


def test_version_coverage_declares_an_ungated_read_and_no_write() -> None:
    coverage = version_coverage_for("sql-ddl")
    assert coverage.declared is True
    assert [read.support for read in coverage.reads] == [VersionSupport.UNGATED]
    assert coverage.writes == ()
    assert coverage.reads[0].format_key in _adapter().descriptor().formats


def test_the_shared_type_table_is_import_free_so_the_emitter_can_reuse_it() -> None:
    """#4311 must be able to import the mapping without pulling a reader in with it."""
    import app.sql_ddl_dialects as dialects

    assert not any(
        name.startswith("sql_ddl_") for name in dir(dialects) if name.endswith("parser")
    )
    assert SQL_TYPE_SCALARS["varchar"] == "string"
    assert SQL_TYPE_SCALARS["number"] == "decimal"


def test_the_limit_recorder_refuses_a_construct_outside_the_vocabulary() -> None:
    recorder = LimitRecorder()
    with pytest.raises(KeyError):
        recorder.record("sql.not_a_real_limit")


def test_limit_recorders_merge_without_double_counting_a_second_normalize() -> None:
    catalog = parse_sql_ddl(_corpus_text("02-typical-postgres.sql"))
    first = _limits(SqlDdlNormalizer().normalize(catalog, include_raw=False))
    second = _limits(SqlDdlNormalizer().normalize(catalog, include_raw=False))
    assert first == second


# ===========================================================================
# Misuse: the resource ceilings and the SPI default
# ===========================================================================


def test_a_script_past_the_byte_ceiling_is_refused_before_it_is_lexed() -> None:
    padding = "-- " + ("x" * 1024) + "\n"
    oversized = "CREATE TABLE t (id INT);\n" + padding * ((MAX_SQL_BYTES // len(padding)) + 1)
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(oversized)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_a_file_set_past_the_byte_ceiling_is_refused() -> None:
    body = "-- " + ("x" * 4096) + "\n"
    members = {
        "a.sql": "CREATE TABLE t (id INT);\n",
        "b.sql": "CREATE TABLE u (id INT);\n" + body * ((MAX_SQL_BYTES // len(body)) + 1),
    }
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl_fileset(members, root="a.sql")
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_an_expression_nested_past_the_depth_ceiling_is_refused() -> None:
    bomb = "CREATE TABLE t (a INT CHECK " + "(" * (MAX_PAREN_DEPTH + 4)
    bomb += "1" + ")" * (MAX_PAREN_DEPTH + 4) + ");"
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(bomb)
    assert excinfo.value.code == "INPUT_MALFORMED"
    assert str(MAX_PAREN_DEPTH) in str(excinfo.value)


def test_a_stray_closing_parenthesis_is_refused_rather_than_ignored() -> None:
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl("CREATE TABLE t (id INT));")
    assert excinfo.value.code == "INPUT_MALFORMED"


def test_a_relation_count_past_the_ceiling_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.sql_ddl_parser.MAX_TABLES", 2)
    script = "".join(f"CREATE TABLE t{index} (id INT);\n" for index in range(4))
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(script)
    assert excinfo.value.code == "INPUT_ENTITY_LIMIT"


def test_a_column_count_past_the_ceiling_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.sql_ddl_parser.MAX_COLUMNS", 3)
    columns = ", ".join(f"c{index} INT" for index in range(8))
    with pytest.raises(SqlDdlParseError) as excinfo:
        parse_sql_ddl(f"CREATE TABLE t ({columns});")
    assert excinfo.value.code == "INPUT_ENTITY_LIMIT"


def test_the_configure_hook_is_a_no_op_for_every_other_adapter() -> None:
    """The SPI default must leave the 40-odd adapters that own no option untouched."""
    for key in ("openapi", "graphql", "dbt", "odcs"):
        adapter = get_import_source(key)
        assert adapter is not None
        assert adapter.configure({SQL_DIALECT_OPTION: "postgres", "dry_run": True}) is adapter


def test_a_column_less_table_beside_real_ones_is_kept_as_an_empty_record() -> None:
    """PostgreSQL allows ``CREATE TABLE t ()``; the script did declare the relation."""
    catalog = parse_sql_ddl(
        "CREATE TABLE placeholder ();\nCREATE TABLE real_one (id INT NOT NULL);",
        dialect="postgres",
    )
    model = SqlDdlNormalizer().normalize(catalog, include_raw=False)
    placeholder = model.type_by_key("placeholder")
    assert placeholder is not None
    assert placeholder.fields == []
    assert model.type_by_key("real_one") is not None
