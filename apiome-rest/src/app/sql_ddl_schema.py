"""SQL DDL document algebra and declared limits — FMT-5.6 (#5444).

The typed shape a read DDL script takes on its way to the canonical model, plus the two
things every reader in this fleet states up front: which document versions it will read,
and which of the format's constructs it carries but does not model.

**A script is a sequence of edits, and the model is the final state.** That is the one
structural idea here. ``CREATE TABLE`` introduces a relation, ``ALTER TABLE`` changes one,
``COMMENT ON`` documents one, and a migrations directory is simply more of the same
statements in a later file. A :class:`SqlCatalog` is therefore *mutable while being built*
and read-only afterwards: statements are applied to it in order, and what it holds at the
end is what the canonical model describes. A migrations set imports as the shape the last
migration leaves behind, never as the shape the first one created — which is the ticket's
"taking the *final* state", expressed as an algebra rather than as a special case.

**There is no version to gate.** SQL DDL has no version marker: a script does not declare
which SQL it is written in, and the ISO revisions (SQL:1999 … SQL:2023) add syntax without
renumbering anything a ``CREATE TABLE`` says. What a script *does* carry is a vendor
accent, and that is resolved in :mod:`app.sql_ddl_dialects` and recorded in provenance.
Version coverage is therefore declared ``ungated`` (FMT-3.8), and the dialect — not a
version — is the fact this reader states about its input.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

__all__ = [
    "LIMIT_DETAILS",
    "MAX_COLUMNS",
    "MAX_PAREN_DEPTH",
    "MAX_SQL_BYTES",
    "MAX_STATEMENTS",
    "MAX_TABLES",
    "ConstraintKind",
    "LimitRecorder",
    "SqlCatalog",
    "SqlColumn",
    "SqlConstraint",
    "SqlDdlParseError",
    "SqlDomain",
    "SqlEnum",
    "SqlIndex",
    "SqlLimit",
    "SqlReference",
    "SqlRelation",
    "SqlSequence",
    "SqlViewColumn",
    "qualify",
]


# ---------------------------------------------------------------------------
# Resource ceilings
# ---------------------------------------------------------------------------

#: How many bytes of DDL one import may carry. A schema dump is text, and a very large
#: estate genuinely runs to a few megabytes; anything past this is a dump of *data*, not of
#: structure. Runaway backstop, not a routine truncation.
MAX_SQL_BYTES = 16 * 1024 * 1024

#: How many statements one import may apply. A migrations directory with a decade of
#: history is a few thousand.
MAX_STATEMENTS = 100_000

#: How many relations (tables plus views) one import may declare.
MAX_TABLES = 20_000

#: How many columns one import may declare across every relation.
MAX_COLUMNS = 400_000

#: How deep parentheses may nest inside one statement. A ``CHECK`` predicate or a partition
#: bound is a handful of levels; a thousand is a hand-built expression bomb.
MAX_PAREN_DEPTH = 64


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SqlDdlParseError(ValueError):
    """Raised when a DDL script cannot be read into a :class:`SqlCatalog`.

    Attributes:
        code: The intake-taxonomy code the pipeline should report, when this reader can
            classify the failure itself. ``None`` leaves the classification to
            :func:`app.import_source_pipeline._classify_parse_failure` — which is what
            makes a UTF-16 upload read as ``INPUT_ENCODING_INVALID`` rather than as a
            generic malformed document.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Declared limits
# ---------------------------------------------------------------------------

#: Stable limit key → the published sentence explaining what the reader does with the
#: construct. This is the reader's *declared* boundary, in one place: the adapter's
#: ``unsupported`` capability list is built from these keys, the capability registry seed
#: repeats them, and every document's own ledger (``extras['sql_ddl']['capability_limits']``)
#: counts and locates the occurrences it actually met.
#:
#: A key belongs here when the construct is **carried but not modelled** — parsed, kept
#: verbatim in extras, and not turned into a canonical facet. A construct the reader models
#: (a column, its nullability, a comment, an enum type) is not a limit, and a construct the
#: reader *refuses* is an error, not a limit.
LIMIT_DETAILS: Dict[str, str] = {
    "sql.check_constraint": (
        "A `CHECK` constraint states a predicate over a row's values. The canonical "
        "constraint vocabulary has no predicate facet, so the expression is carried "
        "verbatim on the type or the column that declared it (`extras['sql_checks']`) and "
        "is never evaluated. The one shape with an exact analogue is decoded as well as "
        "carried: `col IN (<literals>)` also becomes the column's `enum`."
    ),
    "sql.uniqueness": (
        "`PRIMARY KEY` and `UNIQUE` declare identity over the *rows* of a table. The "
        "canonical constraint vocabulary has no identity facet (`unique_items` is about "
        "the members of one array), so the declaration is carried on the type in "
        "`extras['sql_key']` and is not enforced. A primary key's columns *are* modelled "
        "as non-nullable, because SQL says they are."
    ),
    "sql.foreign_key": (
        "A `FOREIGN KEY` names the table and columns a column points at. The canonical "
        "model has no edge vocabulary, so the edge is recorded on the field in "
        "`extras['sql_relationship']` — in the ODCS v3.1 property-level relationship shape "
        "(`type: foreignKey`, `to: <table>.<column>`), beside the canonical type and field "
        "keys it resolved to — and no canonical feature traverses it. A foreign key that "
        "names a table the import does not contain is refused rather than carried, because "
        "this is an edge the reader writes down."
    ),
    "sql.index": (
        "An index — ordinary, `UNIQUE`, expression-based, filtered/partial, covering, "
        "`FULLTEXT` or `CLUSTERED` — states how a relation is *accessed*, not what shape it "
        "has. The declaration is carried in `extras['sql_indexes']` on the table it "
        "belongs to and creates no canonical structure."
    ),
    "sql.partitioning": (
        "`PARTITION BY`, a partition list, and PostgreSQL's `PARTITION OF` state how a "
        "relation is *physically divided*. The canonical model describes one logical shape, "
        "so the clause is carried in `extras['sql_partitioning']`. A declarative partition "
        "child is still modelled as a relation, with the columns it inherits from its "
        "parent, because that is the shape a row in it has."
    ),
    "sql.storage_clause": (
        "`ENGINE`, `DEFAULT CHARSET`, `TABLESPACE`, `COMPRESS`, `WITH (...)` and the rest "
        "of a table's physical options describe storage, not structure, and are carried "
        "verbatim in `extras['sql_table_options']`."
    ),
    "sql.identity": (
        "`IDENTITY`, `AUTO_INCREMENT`, `GENERATED … AS IDENTITY` and the `SERIAL` family "
        "declare that the database assigns the value. The canonical model has no "
        "server-assigned facet — a default it cannot state is not a default — so the "
        "declaration is carried in `extras['sql_identity']` and the column keeps the "
        "scalar its type names."
    ),
    "sql.computed_column": (
        "A computed / generated column (`AS (<expr>) STORED|VIRTUAL|PERSISTED`, "
        "`GENERATED ALWAYS AS`) derives its value from other columns. The expression is "
        "carried in `extras['sql_generated']`; it is never evaluated, and where the "
        "declaration states no type the column is projected as a string, because the "
        "document did not say what the expression returns."
    ),
    "sql.default_expression": (
        "A `DEFAULT` that is not a literal — `now()`, `SYSDATE`, `CURRENT_TIMESTAMP`, "
        "`NEXTVAL('seq')`, a `CASE` — is a value the *database* computes at insert time. "
        "The canonical `default` holds literals only, so the expression is carried "
        "verbatim in `extras['sql_default_expression']` rather than recorded as a value "
        "the document does not state."
    ),
    "sql.type_parameters": (
        "A type's parameters beyond a character length — `numeric(13,2)`, `TIMESTAMP(6)`, "
        "`FLOAT(24)`, `INTERVAL DAY(2) TO SECOND(6)` — have no canonical facet. The scalar "
        "comes from the type's base name and the full declared spelling is carried in "
        "`extras['sql_data_type']`, so nothing is lost and nothing is invented."
    ),
    "sql.length_semantics": (
        "An Oracle `VARCHAR2(40)` is forty *bytes* or forty *characters* depending on the "
        "session's `NLS_LENGTH_SEMANTICS`, which a script does not state. Rather than "
        "guess, the length is carried in `extras['sql_data_type']` and no `maxLength` is "
        "claimed. A declaration that says `VARCHAR2(40 CHAR)` *is* unambiguous and does "
        "project onto `maxLength`."
    ),
    "sql.vendor_type": (
        "A vendor type with no portable meaning — SQL Server's `ROWVERSION`, Oracle's "
        "`ROWID`/`BFILE`, MySQL's `YEAR`, PostGIS geometry — is projected onto the nearest "
        "canonical scalar so the column still has a shape, and the declared spelling is "
        "carried. The semantics the vendor attaches to it (auto-maintained, "
        "storage-locating, externally-referencing) are not modelled."
    ),
    "sql.set_type": (
        "MySQL's `SET('a','b','c')` is a multi-valued column: zero or more members of a "
        "fixed list stored in one field. It is projected as a list of strings constrained "
        "to the declared members, which is its shape; that the database stores it as a "
        "single packed value, and orders the members by declaration, is not modelled."
    ),
    "sql.table_inheritance": (
        "PostgreSQL's `INHERITS (parent)` copies the parent's columns into the child and "
        "keeps a catalog link between them. The copied columns *are* modelled — they are "
        "columns of the child — but the link is not: the canonical model has no type "
        "hierarchy for records, so the parent is named in `extras['sql_inherits']`."
    ),
    "sql.view_definition": (
        "A view's `SELECT` is carried verbatim in `extras['sql_view']` and is never "
        "executed, planned or otherwise interpreted. The reader reads it only far enough "
        "to name the columns the view projects and to resolve the ones that are plain "
        "column references."
    ),
    "sql.view_derived_column": (
        "A view column produced by an expression — an aggregate, an arithmetic term, a "
        "`CASE` — has no declared type, and the reader does not evaluate SQL to infer one. "
        "The column is modelled with its projected name and a string type, and the "
        "expression is carried, because 'the document did not say' is the honest answer."
    ),
    "sql.sequence": (
        "`CREATE SEQUENCE` declares a number generator, not a shape. The declaration is "
        "carried in `extras['sql_sequences']` at the document level; a column that draws "
        "from it keeps the scalar its own type names."
    ),
    "sql.schema_definition": (
        "`CREATE SCHEMA`, `CREATE DATABASE` and `USE` establish the namespace later "
        "statements resolve against. The namespace *is* modelled — it is a type's "
        "`namespace` — but the statement's own options (owner, character set, collation, "
        "authorization) are carried in `extras['sql_schemas']`."
    ),
    "sql.collation": (
        "`COLLATE` selects how text is compared and sorted. The canonical model has no "
        "collation facet, so the declaration is carried on the column or table that "
        "declared it."
    ),
    "sql.column_clause": (
        "A column clause this reader does not decode — a vendor storage attribute, a "
        "`SPARSE`/`FILESTREAM`/`ROWGUIDCOL` marker, an encryption or masking clause. It is "
        "skipped without changing the column's shape and counted here, so a document that "
        "leans on one is visible rather than silently simplified."
    ),
    "sql.unsupported_statement": (
        "A statement that is not part of the schema this reader models — `INSERT`, `GRANT`, "
        "`CREATE TRIGGER`/`PROCEDURE`/`FUNCTION`, `SET`, a vendor session command. It is "
        "skipped, counted and located, so a script that carries logic beside its structure "
        "reports what was left behind rather than appearing to have imported whole."
    ),
}


@dataclass(frozen=True)
class SqlLimit:
    """One declared limit the read script exercised.

    Attributes:
        construct: The stable key; always a key of :data:`LIMIT_DETAILS`.
        detail: The published sentence for ``construct``.
        count: How many occurrences were recorded.
        locations: The canonical entity keys the occurrences sit under, sorted. Empty for a
            document-level construct, which has no owning entity.
    """

    construct: str
    detail: str
    count: int
    locations: Tuple[str, ...] = ()


class LimitRecorder:
    """Accumulates :class:`SqlLimit` records while a script is read.

    Recording lives here rather than inline in the parser and the normalizer so the
    wording, the de-duplication and the vocabulary check are one implementation — a
    construct is counted the same way wherever it is met. Mirrors
    :class:`app.dbt_resources.LimitRecorder`, which is the fleet's convention for this.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The canonical entity key the occurrence sits under, when the
                construct belongs to one. Column-level constructs deliberately record their
                owning **table**, not the column, so a 200-column table contributes one
                location rather than two hundred.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown sql-ddl limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def extend(self, other: "LimitRecorder") -> None:
        """Fold another recorder's counts and locations into this one.

        The reader and the projection each meet limits the other cannot: the reader knows a
        statement was skipped, the projection knows a type's parameters had no canonical
        facet. Seeding the projection's recorder from the reader's — rather than having the
        projection write back into the catalog — is what keeps normalizing a catalog twice
        produce the same ledger both times.

        Args:
            other: The recorder to fold in.
        """
        for construct, count in other._counts.items():  # noqa: SLF001 - same class
            self._counts[construct] = self._counts.get(construct, 0) + count
        for construct, locations in other._locations.items():  # noqa: SLF001 - same class
            self._locations.setdefault(construct, set()).update(locations)

    def limits(self) -> Tuple[SqlLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            SqlLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------


def qualify(schema: Optional[str], name: str) -> str:
    """Return the qualified relation name — ``schema.name``, or ``name`` unqualified.

    Args:
        schema: The owning schema, when the declaration named one.
        name: The relation's own name, in the spelling the document used.

    Returns:
        The qualified name, which is also the canonical type key.
    """
    return f"{schema}.{name}" if schema else name


# ---------------------------------------------------------------------------
# The document algebra
# ---------------------------------------------------------------------------


class ConstraintKind:
    """The constraint families a table declaration can carry.

    Plain string constants, for the same reason :class:`app.sql_ddl_dialects.SqlDialect`
    is: the value is written into an extras bag and read back out of a golden file.
    """

    PRIMARY_KEY = "primary_key"
    UNIQUE = "unique"
    FOREIGN_KEY = "foreign_key"
    CHECK = "check"


@dataclass
class SqlReference:
    """The target half of a foreign key, as the document spelled it.

    Attributes:
        table: The referenced relation's name, verbatim (may be schema-qualified).
        columns: The referenced columns, or empty when the declaration relied on the
            target's primary key.
        on_delete: The `ON DELETE` action, upper-cased, when one was declared.
        on_update: The `ON UPDATE` action, upper-cased, when one was declared.
        resolved_table: The qualified key of the relation the reference resolved to, filled
            in by the whole-document resolution pass. A reference that resolves to nothing
            never reaches the model: it is refused as ``INPUT_REFERENCE_UNRESOLVED``.
    """

    table: str
    columns: Tuple[str, ...] = ()
    on_delete: Optional[str] = None
    on_update: Optional[str] = None
    resolved_table: Optional[str] = None


@dataclass
class SqlConstraint:
    """One table-level constraint.

    A constraint declared inline on a column (``id text PRIMARY KEY``) is lifted to this
    same shape with a single-column list, so the projection has one representation to read
    rather than two.

    Attributes:
        kind: A :class:`ConstraintKind` value.
        name: The declared constraint name, when the document named it.
        columns: The constrained columns, in declaration order.
        reference: The foreign key's target, for :attr:`ConstraintKind.FOREIGN_KEY`.
        expression: The predicate text, for :attr:`ConstraintKind.CHECK`.
        enum_values: The literal list a ``col IN (…)`` predicate constrains the column to,
            when the check has exactly that shape.
    """

    kind: str
    name: Optional[str] = None
    columns: Tuple[str, ...] = ()
    reference: Optional[SqlReference] = None
    expression: Optional[str] = None
    enum_values: Tuple[Any, ...] = ()


@dataclass
class SqlIndex:
    """One index declaration, carried rather than modelled.

    Attributes:
        name: The index name, when declared.
        table: The relation it indexes.
        columns: The indexed column names or expressions, in declaration order.
        unique: Whether the index enforces uniqueness.
        kind: A vendor qualifier — ``fulltext``, ``spatial``, ``clustered``,
            ``nonclustered`` — or ``None``.
        predicate: The `WHERE` predicate of a filtered/partial index, when declared.
        include: The covering columns of an `INCLUDE` clause, when declared.
    """

    name: Optional[str]
    table: str
    columns: Tuple[str, ...] = ()
    unique: bool = False
    kind: Optional[str] = None
    predicate: Optional[str] = None
    include: Tuple[str, ...] = ()


@dataclass
class SqlColumn:
    """One column of a table, or one attribute of a composite type.

    Attributes:
        name: The column name in the spelling the document used.
        data_type: The declared type, rendered back verbatim (``numeric(13,2)``).
        type_base: The type's base name, lower-cased and space-collapsed
            (``character varying``), which is what :data:`SQL_TYPE_SCALARS` is keyed by.
        type_arguments: The parenthesized arguments, as written.
        is_array: Whether the declaration carried an array suffix (``text[]``).
        not_null: ``True`` when `NOT NULL` was declared, ``False`` when `NULL` was declared
            explicitly, ``None`` when the declaration said nothing.
        has_default: Whether a `DEFAULT` clause was declared at all. Needed because
            ``DEFAULT NULL`` states a default *of* null, which ``default_literal`` alone
            cannot tell apart from "no default was declared".
        default_literal: The `DEFAULT` value when it is a literal this reader can state.
        default_expression: The `DEFAULT` expression when it is not.
        identity: The auto-assignment declaration (`IDENTITY`, `AUTO_INCREMENT`, `SERIAL`,
            `GENERATED … AS IDENTITY`), when there is one.
        generated: The computed-column declaration, when there is one.
        comment: The column's documented description.
        collation: A `COLLATE` clause, when declared.
        enum_values: The members of an inline `ENUM(…)`/`SET(…)` type.
        checks: Column-level `CHECK` predicates, verbatim.
        position: Declaration order within the relation, 0-based.
        extras: Anything else the reader carried for this column.
    """

    name: str
    data_type: Optional[str] = None
    type_base: Optional[str] = None
    type_arguments: Tuple[str, ...] = ()
    is_array: bool = False
    not_null: Optional[bool] = None
    has_default: bool = False
    default_literal: Optional[Any] = None
    default_expression: Optional[str] = None
    identity: Optional[Dict[str, Any]] = None
    generated: Optional[Dict[str, Any]] = None
    comment: Optional[str] = None
    collation: Optional[str] = None
    enum_values: Tuple[Any, ...] = ()
    checks: Tuple[str, ...] = ()
    position: int = 0
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SqlViewColumn:
    """One column a view projects.

    Attributes:
        name: The output name — the alias when the select item had one, the referenced
            column's name when it did not.
        expression: The select item verbatim.
        source_table: The relation a plain column reference resolved to, when it did.
        source_column: The column a plain column reference resolved to, when it did.
    """

    name: str
    expression: str
    source_table: Optional[str] = None
    source_column: Optional[str] = None


@dataclass
class SqlRelation:
    """A table or a view — the two things that have rows and therefore have a shape.

    Attributes:
        name: The relation's own name.
        schema: Its schema, when the declaration qualified it or a `USE`/`CREATE SCHEMA`
            established one.
        kind: ``table``, ``view`` or ``materialized_view``.
        columns: The columns, in declaration order.
        constraints: Table-level constraints, including the ones lifted from columns.
        indexes: Index declarations attached to this relation.
        comment: The relation's documented description.
        options: Physical/storage options (`ENGINE`, `CHARSET`, `TABLESPACE`, …).
        partitioning: The partitioning clause, when declared.
        inherits: The parents a PostgreSQL `INHERITS` clause named.
        partition_of: The parent a PostgreSQL `PARTITION OF` child belongs to.
        view_definition: The `SELECT` text, for a view.
        view_columns: The projected columns, for a view.
        position: Declaration order within the document, so a golden file can be read in
            the order the script was written.
    """

    name: str
    schema: Optional[str] = None
    kind: str = "table"
    columns: List[SqlColumn] = field(default_factory=list)
    constraints: List[SqlConstraint] = field(default_factory=list)
    indexes: List[SqlIndex] = field(default_factory=list)
    comment: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)
    partitioning: Optional[str] = None
    inherits: Tuple[str, ...] = ()
    partition_of: Optional[str] = None
    view_definition: Optional[str] = None
    view_columns: List[SqlViewColumn] = field(default_factory=list)
    position: int = 0

    @property
    def key(self) -> str:
        """The qualified name, which is also the canonical type key."""
        return qualify(self.schema, self.name)

    def column(self, name: str) -> Optional[SqlColumn]:
        """Return the column called ``name``, case-insensitively, or ``None``."""
        folded = name.casefold()
        for column in self.columns:
            if column.name.casefold() == folded:
                return column
        return None


@dataclass
class SqlEnum:
    """A named enumerated type — PostgreSQL's ``CREATE TYPE … AS ENUM``.

    Attributes:
        name: The type's own name.
        schema: Its schema, when qualified.
        values: The members, in declaration order.
        comment: A documented description, when one was attached.
    """

    name: str
    schema: Optional[str] = None
    values: Tuple[str, ...] = ()
    comment: Optional[str] = None
    position: int = 0

    @property
    def key(self) -> str:
        """The qualified name, which is also the canonical type key."""
        return qualify(self.schema, self.name)


@dataclass
class SqlDomain:
    """A named scalar with constraints — ``CREATE DOMAIN``.

    Attributes:
        name: The domain's own name.
        schema: Its schema, when qualified.
        data_type: The base type, verbatim.
        type_base: The base type's base name.
        type_arguments: The base type's parenthesized arguments.
        not_null: Whether the domain declares `NOT NULL`.
        default_literal: A literal default, when declared.
        default_expression: A non-literal default, when declared.
        checks: The domain's `CHECK` predicates, verbatim.
        enum_values: The literal list a ``VALUE IN (…)`` check constrains it to.
    """

    name: str
    schema: Optional[str] = None
    data_type: Optional[str] = None
    type_base: Optional[str] = None
    type_arguments: Tuple[str, ...] = ()
    not_null: bool = False
    default_literal: Optional[Any] = None
    default_expression: Optional[str] = None
    checks: Tuple[str, ...] = ()
    enum_values: Tuple[Any, ...] = ()
    position: int = 0

    @property
    def key(self) -> str:
        """The qualified name, which is also the canonical type key."""
        return qualify(self.schema, self.name)


@dataclass
class SqlSequence:
    """A ``CREATE SEQUENCE`` declaration, carried rather than modelled.

    Attributes:
        name: The sequence's own name.
        schema: Its schema, when qualified.
        options: The declared options, as written.
    """

    name: str
    schema: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        """The qualified name."""
        return qualify(self.schema, self.name)


@dataclass
class SqlCatalog:
    """Everything one DDL import declares, in its final state.

    Built by applying a script's statements in order (see
    :func:`app.sql_ddl_parser.parse_sql_ddl`); read-only afterwards. A file set is the same
    build with more statements, which is what makes "a migrations directory imports as its
    final state" the ordinary path rather than a special case.

    Attributes:
        name: The import's name — the dominant schema, or the source label.
        dialect: The resolved :class:`app.sql_ddl_dialects.SqlDialect` key.
        dialect_source: ``detected`` / ``override`` / ``default``.
        dialect_evidence: The markers that decided a detected dialect.
        relations: Tables and views, keyed by qualified name, in insertion order.
        enums: Named enumerated types, keyed by qualified name.
        domains: Named constrained scalars, keyed by qualified name.
        composites: Composite (row) types, keyed by qualified name, held as relations
            because that is exactly what their shape is.
        sequences: Sequence declarations, keyed by qualified name.
        schemas: Declared schema/database names with their options, in declaration order.
        current_schema: The namespace unqualified names resolve into, established by a
            `USE` statement.
        declaration_count: How many objects have been declared so far, which is what gives
            each relation its `position`. It lives here rather than on the reader because a
            file set reads several documents into one catalog.
        statement_counts: How many statements of each kind were applied.
        limits: The declared-limit ledger for this document.
        fileset: The members a file-set import composed, when it was one.
        source_label: The document's name, for messages.
        raw: The source text, for the fidelity bag.
    """

    name: str = "schema"
    dialect: str = "ansi"
    dialect_source: str = "default"
    dialect_evidence: Tuple[str, ...] = ()
    relations: Dict[str, SqlRelation] = field(default_factory=dict)
    enums: Dict[str, SqlEnum] = field(default_factory=dict)
    domains: Dict[str, SqlDomain] = field(default_factory=dict)
    composites: Dict[str, SqlRelation] = field(default_factory=dict)
    sequences: Dict[str, SqlSequence] = field(default_factory=dict)
    schemas: List[Dict[str, Any]] = field(default_factory=list)
    current_schema: Optional[str] = None
    declaration_count: int = 0
    statement_counts: Dict[str, int] = field(default_factory=dict)
    limits: LimitRecorder = field(default_factory=LimitRecorder)
    fileset: Optional[Dict[str, Any]] = None
    source_label: Optional[str] = None
    raw: Optional[str] = None

    # -- lookup ------------------------------------------------------------

    def find_relation(self, name: str) -> Optional[SqlRelation]:
        """Resolve a relation reference the way a database would, near enough.

        Names are matched case-insensitively, because the dialects disagree about folding
        (PostgreSQL lowers an unquoted name, Oracle raises it, SQL Server and MySQL keep
        it) and a script that spells one table two ways means one table either way. A
        qualified name matches a qualified declaration; an unqualified name also matches a
        qualified declaration when exactly one schema holds that table, which is what makes
        ``REFERENCES customer`` resolve after ``CREATE TABLE commerce.customer``.

        Args:
            name: The reference as the document spelled it.

        Returns:
            The relation, or ``None`` when the import declares no such table.
        """
        folded = name.casefold()
        for relation in self.relations.values():
            if relation.key.casefold() == folded:
                return relation
        if "." in folded:
            bare = folded.rsplit(".", 1)[1]
            matches = [r for r in self.relations.values() if r.name.casefold() == bare]
            return matches[0] if len(matches) == 1 else None
        matches = [r for r in self.relations.values() if r.name.casefold() == folded]
        return matches[0] if len(matches) == 1 else None

    def find_named_type(self, name: str) -> Optional[str]:
        """Return the canonical key of the user-defined type ``name`` names, or ``None``.

        Args:
            name: A type reference as a column declaration spelled it, possibly qualified.

        Returns:
            The declaring enum/domain/composite's qualified key.
        """
        folded = name.casefold()
        for table in (self.enums, self.domains, self.composites):
            for key in table:
                if key.casefold() == folded:
                    return key
        bare = folded.rsplit(".", 1)[-1]
        for table in (self.enums, self.domains, self.composites):
            matches = [key for key in table if key.casefold().rsplit(".", 1)[-1] == bare]
            if len(matches) == 1:
                return matches[0]
        return None

    def count_statement(self, kind: str) -> None:
        """Record that one statement of ``kind`` was applied."""
        self.statement_counts[kind] = self.statement_counts.get(kind, 0) + 1

    def describes_data(self) -> bool:
        """Whether the import declares any shape at all.

        A script of nothing but `GRANT`s, or one whose only `CREATE TABLE` has an empty
        column list, describes no structure; importing it would produce a catalog entry
        that reads as "this database has no tables" rather than as "this document did not
        say". :func:`app.sql_ddl_parser.parse_sql_ddl` refuses that case.
        """
        if any(relation.columns or relation.view_columns for relation in self.relations.values()):
            return True
        return bool(self.enums or self.domains or self.composites)

    def ordered_relations(self) -> List[SqlRelation]:
        """Return the relations in declaration order."""
        return sorted(self.relations.values(), key=lambda relation: (relation.position, relation.key))


def snapshot_fileset(members: Mapping[str, str], *, root: str, applied: Sequence[str]) -> Dict[str, Any]:
    """Describe a composed file set for the extras bag.

    Args:
        members: Every member of the set, keyed by relative path.
        root: The member the set is rooted at.
        applied: The members whose statements were applied, in the order they were applied.

    Returns:
        The record: the root, the applied order, and the members that carried no DDL.
    """
    skipped = sorted(set(members) - set(applied))
    record: Dict[str, Any] = {"root": root, "applied": list(applied)}
    if skipped:
        record["skipped"] = skipped
    return record
