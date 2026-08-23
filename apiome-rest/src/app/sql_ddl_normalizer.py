"""SQL DDL → canonical model normalizer — FMT-5.6 (#5444).

Projects a read :class:`~app.sql_ddl_schema.SqlCatalog` onto a
:class:`~app.canonical_model.CanonicalApi` with paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA`.

The projection
==============

* Each **table** becomes one canonical ``RECORD`` :class:`Type`, keyed by its qualified
  name (``commerce.customer``), with the schema as its ``namespace``.
* Each **column** becomes one :class:`CanonicalField`, typed by its declared type's *base
  name* through the shared table :data:`app.sql_ddl_dialects.SQL_TYPE_SCALARS`, and
  nullable unless ``NOT NULL`` or a primary key says otherwise.
* Each **view** becomes a ``RECORD`` too — a view has rows, so it has a shape. Its columns
  are the ones its ``SELECT`` projects: a plain column reference is resolved back to the
  source column and takes that column's type, and a derived column is declared as such.
* ``CREATE TYPE … AS ENUM`` becomes an ``ENUM``, ``CREATE DOMAIN`` becomes an ``ALIAS``
  carrying its base scalar and constraints, and a composite ``CREATE TYPE`` becomes a
  ``RECORD``. A column declared with one of them references it by key, so a schema's own
  vocabulary survives instead of collapsing to ``string``.
* Each **foreign key** becomes a relationship on the origin field, in the ODCS v3.1
  property-level shape FMT-5.4 already writes — ``type: foreignKey`` with a ``to``
  reference — beside the canonical type and field keys it resolved to.

Where a constraint lands
========================

This is the projection's real decision, and it is the ticket's "columns to properties with
type and constraint mapping":

=====================  ================================================================
Constraint             Lands as
=====================  ================================================================
``NOT NULL``           ``TypeRef.nullable = False`` — a canonical facet, modelled.
``PRIMARY KEY``        ``nullable = False`` on each key column (SQL says a key column is
                       not nullable), **and** ``extras['sql_key']`` on the type, because
                       the canonical vocabulary has no identity facet.
``UNIQUE``             ``extras['sql_key']`` — same reason.
``DEFAULT <literal>``  ``CanonicalField.default`` — a canonical facet, modelled.
``DEFAULT <expr>``     ``extras['sql_default_expression']`` — the database computes it, so
                       the document does not state the value.
``CHECK``              ``extras['sql_checks']`` — carried verbatim. The one shape with an
                       exact analogue, ``col IN (<literals>)``, *also* becomes the column's
                       ``enum``.
``ENUM(…)`` / ``SET``  ``Constraints.enum`` — a canonical facet, modelled. A ``SET`` is a
                       list of those members, because that is its shape.
``VARCHAR(n)``         ``Constraints.max_length`` — but only where ``n`` is unambiguously a
                       character count; see :func:`_max_length`.
``FOREIGN KEY``        ``extras['sql_relationship']`` — no canonical edge vocabulary.
=====================  ================================================================

The extras namespace
====================

Everything a script states that the canonical model has no home for is carried verbatim
under a documented key namespace. Every carried key is prefixed ``sql_``:

============================  ======  ==================================================
Key                           Node    Carries
============================  ======  ==================================================
``sql_ddl``                   root    Reader bookkeeping: the resolved ``dialect`` and how
                                      it was resolved, the relation list, statement
                                      counts, the recorded relationships, ``capability_
                                      limits``, and the composed file set.
``sql_schemas``               root    ``CREATE SCHEMA``/``CREATE DATABASE``/``USE``.
``sql_sequences``             root    ``CREATE SEQUENCE``.
``sql_position``              type,   Declaration order, because canonical ordering sorts
                              field   by key and a table's column order is physical.
``sql_kind``                  type    ``table`` / ``view`` / ``materialized_view`` /
                                      ``composite`` / ``domain``.
``sql_key``                   type    ``PRIMARY KEY`` and ``UNIQUE`` declarations.
``sql_checks``                type,   ``CHECK`` predicates, verbatim.
                              field
``sql_indexes``               type    Index declarations.
``sql_table_options``         type    ``ENGINE``, charset, tablespace and the rest.
``sql_partitioning``          type    ``PARTITION BY`` / ``PARTITION OF``.
``sql_inherits``              type    PostgreSQL table inheritance parents.
``sql_view``                  type    A view's ``SELECT`` and its projected columns.
``sql_data_type``             field   The declared type, verbatim.
``sql_identity``              field   ``IDENTITY`` / ``AUTO_INCREMENT`` / ``SERIAL``.
``sql_generated``             field   A computed column's expression and storage.
``sql_default_expression``    field   A non-literal ``DEFAULT``.
``sql_collation``             field   ``COLLATE``.
``sql_relationship``          field   A resolved foreign key, ODCS-shaped.
``sql_extra``                 field   A column clause this reader carried but did not
                                      decode (``ON UPDATE …``, ``AFTER …``).
============================  ======  ==================================================

Only ``sql_ddl`` is the reader's own bookkeeping; it is therefore the single key listed in
:data:`app.import_preview_manifest.PROVENANCE_EXTRA_KEYS`. Every other key is a *source*
construct the canonical model does not hold, so it is reported as partially-mapped
coverage — which is what "carried but not modelled" should look like to somebody reading
the catalog detail view.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    EnumValue,
    Type,
    TypeKind,
    TypeRef,
)
from .normalizer import Keys, Normalizer, normalize_ordering
from .sql_ddl_dialects import (
    BINARY_TYPE_BASES,
    CHARACTER_TYPE_BASES,
    DIALECT_LABELS,
    SQL_TYPE_SCALARS,
    SqlDialect,
)
from .sql_ddl_schema import (
    ConstraintKind,
    LimitRecorder,
    SqlCatalog,
    SqlColumn,
    SqlConstraint,
    SqlDomain,
    SqlEnum,
    SqlRelation,
    SqlViewColumn,
)

__all__ = [
    "SQL_DDL_EXTRAS_KEY",
    "SQL_DDL_FORMAT_KEY",
    "SqlDdlNormalizer",
]

#: The normalizer format key, which is also the adapter key and the corpus format.
SQL_DDL_FORMAT_KEY = "sql-ddl"

#: The root extras key holding the reader's own projection record.
SQL_DDL_EXTRAS_KEY = "sql_ddl"

#: The canonical scalar a column whose type this reader does not decode takes. A view's
#: derived column and a computed column with no declared type land here too: the document
#: states no type for them, and ``string`` is the honest "not stated here" — the same rule
#: FMT-5.4 applies to an untyped dbt column and FMT-5.1 to an untyped ODCS property.
_UNTYPED_SCALAR = "string"

#: The parameter that means "as long as the engine allows", not a number.
_UNBOUNDED_LENGTHS = frozenset({"max", "MAX"})


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


def _scalar_for(base: Optional[str]) -> str:
    """Return the canonical scalar a declared type's base name projects onto.

    Args:
        base: The type's base name, lower-cased, or ``None`` for an undeclared type.

    Returns:
        The canonical scalar. An unknown base name is *not* an error and not a loss of
        information — the declared spelling survives in ``sql_data_type``.
    """
    if not base:
        return _UNTYPED_SCALAR
    return SQL_TYPE_SCALARS.get(base, _UNTYPED_SCALAR)


def _max_length(column: SqlColumn, *, dialect: str) -> Optional[int]:
    """Return the ``maxLength`` a character type's parameter states, when it states one.

    A ``VARCHAR(16)`` genuinely declares a maximum length, and dropping it would lose a
    fact the document states — which is why this reader projects it where FMT-5.4's dbt
    reader deliberately does not. The difference is knowledge: dbt carries an
    *uninterpreted* warehouse-type string from an adapter it cannot identify, whereas this
    reader has resolved the dialect. Three cases still refuse to claim a length:

    * a **binary** width (``VARBINARY(16)``) counts bytes, and ``maxLength`` on a canonical
      ``bytes`` field would be read as a character count by every consumer;
    * ``VARCHAR(MAX)`` states no number at all;
    * an **Oracle** ``VARCHAR2(40)`` is forty bytes or forty characters depending on the
      session's ``NLS_LENGTH_SEMANTICS``, which the script does not state. Oracle's
      explicit ``VARCHAR2(40 CHAR)`` *is* unambiguous and does project.

    Args:
        column: The column whose type is being projected.
        dialect: The resolved dialect.

    Returns:
        The declared maximum length, or ``None``.
    """
    base = column.type_base or ""
    if base in BINARY_TYPE_BASES or base not in CHARACTER_TYPE_BASES:
        return None
    if len(column.type_arguments) != 1:
        return None
    argument = column.type_arguments[0].strip()
    if argument.lower() in _UNBOUNDED_LENGTHS:
        return None
    parts = argument.split()
    if dialect == SqlDialect.ORACLE:
        if len(parts) != 2 or parts[1].upper() != "CHAR":
            return None
        argument = parts[0]
    elif len(parts) != 1:
        return None
    try:
        length = int(argument)
    except ValueError:
        return None
    return length if length > 0 else None


class _TypeGraph:
    """Builds the canonical types one DDL import projects onto.

    Nothing nests: a relational row is flat, and a ``JSON``/``VARIANT`` column is an opaque
    scalar rather than a synthesized record, because the script states no shape for what is
    inside it. What *is* graph-shaped — a column typed by a user-defined type, a foreign key
    — becomes a reference to another canonical key rather than a copy.
    """

    def __init__(self, catalog: SqlCatalog) -> None:
        self._catalog = catalog
        self.limits = LimitRecorder()
        self.limits.extend(catalog.limits)
        self.relationships: List[Dict[str, Any]] = []

    # -- entry point -------------------------------------------------------

    def build(self) -> List[Type]:
        """Return every canonical type this catalog declares."""
        types: List[Type] = []
        for enum in self._catalog.enums.values():
            types.append(self._enum_type(enum))
        for domain in self._catalog.domains.values():
            types.append(self._domain_type(domain))
        for composite in self._catalog.composites.values():
            types.append(self._record_type(composite))
        for relation in self._catalog.ordered_relations():
            types.append(self._record_type(relation))
        return types

    # -- named types -------------------------------------------------------

    def _enum_type(self, enum: SqlEnum) -> Type:
        """Project a ``CREATE TYPE … AS ENUM`` onto a canonical ``ENUM``."""
        return Type(
            key=enum.key,
            name=enum.name,
            kind=TypeKind.ENUM,
            namespace=enum.schema,
            description=enum.comment,
            enum_values=[
                EnumValue(key=Keys.enum_value(enum.key, value), name=value)
                for value in enum.values
            ],
            extras={"sql_position": enum.position, "sql_kind": "enum"},
        )

    def _domain_type(self, domain: SqlDomain) -> Type:
        """Project a ``CREATE DOMAIN`` onto a canonical ``ALIAS`` with its constraints.

        A domain is a typedef with a predicate attached, which is exactly what an ``ALIAS``
        carrying ``constraints`` models: the aliased reference keeps the base scalar so a
        column typed by the domain still resolves to a shape, and the predicate is carried.
        """
        constraints: Dict[str, Any] = {}
        if domain.enum_values:
            constraints["enum"] = list(domain.enum_values)
        extras: Dict[str, Any] = {"sql_position": domain.position, "sql_kind": "domain"}
        if domain.data_type:
            extras["sql_data_type"] = domain.data_type
            if len(domain.type_arguments) > 1 or (
                domain.type_arguments and (domain.type_base or "") not in CHARACTER_TYPE_BASES
            ):
                self.limits.record("sql.type_parameters", location=domain.key)
        if domain.checks:
            extras["sql_checks"] = list(domain.checks)
        if domain.default_expression:
            extras["sql_default_expression"] = domain.default_expression
        return Type(
            key=domain.key,
            name=domain.name,
            kind=TypeKind.ALIAS,
            namespace=domain.schema,
            aliased=TypeRef(name=_scalar_for(domain.type_base), nullable=not domain.not_null),
            constraints=Constraints(**constraints) if constraints else None,
            extras=extras,
        )

    # -- relations ---------------------------------------------------------

    def _record_type(self, relation: SqlRelation) -> Type:
        """Project a table, a view or a composite type onto a canonical ``RECORD``."""
        key = relation.key
        keyed = self._key_declarations(relation)
        enum_checks = self._check_enums(relation)
        fields = [
            self._field(relation, column, enum_checks.get(column.name.casefold()))
            for column in relation.columns
        ]
        if not relation.columns and relation.view_columns:
            fields = [
                self._view_field(relation, column, position)
                for position, column in enumerate(relation.view_columns)
            ]
        self._record_relationships(relation, fields)
        extras: Dict[str, Any] = {"sql_position": relation.position, "sql_kind": relation.kind}
        if keyed:
            extras["sql_key"] = keyed
        checks = [
            {"name": constraint.name, "expression": constraint.expression}
            for constraint in relation.constraints
            if constraint.kind == ConstraintKind.CHECK and constraint.expression
        ]
        if checks:
            extras["sql_checks"] = checks
        if relation.indexes:
            extras["sql_indexes"] = [
                {
                    key_name: value
                    for key_name, value in (
                        ("name", index.name),
                        ("columns", list(index.columns)),
                        ("unique", index.unique or None),
                        ("kind", index.kind),
                        ("predicate", index.predicate),
                        ("include", list(index.include) or None),
                    )
                    if value
                }
                for index in relation.indexes
            ]
        if relation.options:
            extras["sql_table_options"] = dict(relation.options)
        if relation.partitioning or relation.partition_of:
            partitioning: Dict[str, Any] = {}
            if relation.partition_of:
                partitioning["partition_of"] = relation.partition_of
            if relation.partitioning:
                partitioning["clause"] = relation.partitioning
            extras["sql_partitioning"] = partitioning
        if relation.inherits:
            extras["sql_inherits"] = list(relation.inherits)
        if relation.view_definition is not None:
            extras["sql_view"] = {
                "definition": relation.view_definition,
                "columns": [
                    {
                        name: value
                        for name, value in (
                            ("name", column.name),
                            ("expression", column.expression),
                            ("source_table", column.source_table),
                            ("source_column", column.source_column),
                        )
                        if value is not None
                    }
                    for column in relation.view_columns
                ],
            }
        return Type(
            key=key,
            name=relation.name,
            kind=TypeKind.RECORD,
            namespace=relation.schema,
            description=relation.comment,
            fields=fields,
            extras=extras,
        )

    @staticmethod
    def _key_declarations(relation: SqlRelation) -> Dict[str, Any]:
        """Collect the identity declarations a relation carries, for ``sql_key``."""
        keyed: Dict[str, Any] = {}
        for constraint in relation.constraints:
            if constraint.kind == ConstraintKind.PRIMARY_KEY and constraint.columns:
                primary: Dict[str, Any] = {"columns": list(constraint.columns)}
                if constraint.name:
                    primary["name"] = constraint.name
                keyed["primary_key"] = primary
            elif constraint.kind == ConstraintKind.UNIQUE and constraint.columns:
                unique: Dict[str, Any] = {"columns": list(constraint.columns)}
                if constraint.name:
                    unique["name"] = constraint.name
                keyed.setdefault("unique", []).append(unique)
        return keyed

    @staticmethod
    def _check_enums(relation: SqlRelation) -> Dict[str, Tuple[Any, ...]]:
        """Index the ``col IN (<literals>)`` predicates by the column they constrain."""
        decoded: Dict[str, Tuple[Any, ...]] = {}
        for constraint in relation.constraints:
            if constraint.kind != ConstraintKind.CHECK or not constraint.enum_values:
                continue
            for name in constraint.columns:
                decoded.setdefault(name.casefold(), constraint.enum_values)
        return decoded

    # -- fields ------------------------------------------------------------

    def _field(
        self, relation: SqlRelation, column: SqlColumn, check_enum: Optional[Tuple[Any, ...]]
    ) -> CanonicalField:
        """Project one column onto a canonical field."""
        key = Keys.field(relation.key, column.name)
        nullable = column.not_null is not True
        reference = self._type_reference(column, nullable=nullable)
        constraints = self._constraints(relation, column, check_enum)
        extras: Dict[str, Any] = {"sql_position": column.position}
        if column.data_type:
            extras["sql_data_type"] = column.data_type
            self._record_type_parameters(relation, column)
        if column.identity:
            extras["sql_identity"] = dict(column.identity)
        if column.generated:
            extras["sql_generated"] = dict(column.generated)
        if column.default_expression:
            extras["sql_default_expression"] = column.default_expression
        if column.checks:
            extras["sql_checks"] = list(column.checks)
        if column.collation:
            extras["sql_collation"] = column.collation
        if column.extras:
            extras["sql_extra"] = dict(column.extras)
        return CanonicalField(
            key=key,
            name=column.name,
            type=reference,
            default=column.default_literal if column.has_default else None,
            constraints=constraints,
            description=column.comment,
            extras=extras,
        )

    def _record_type_parameters(self, relation: SqlRelation, column: SqlColumn) -> None:
        """Record the declared type parameters that have no canonical facet."""
        base = column.type_base or ""
        if not column.type_arguments:
            return
        if base in CHARACTER_TYPE_BASES and len(column.type_arguments) == 1:
            if self._catalog.dialect == SqlDialect.ORACLE and _max_length(
                column, dialect=self._catalog.dialect
            ) is None:
                self.limits.record("sql.length_semantics", location=relation.key)
            return
        if base in {"enum", "set"}:
            return
        self.limits.record("sql.type_parameters", location=relation.key)

    def _type_reference(self, column: SqlColumn, *, nullable: bool) -> TypeRef:
        """Build the type reference a column's declared type names.

        A user-defined type resolves to that type's canonical key, so a column declared
        ``commerce.order_status`` points at the enum rather than flattening to a string. A
        MySQL ``SET`` is a *list* of its members, which is its shape. Everything else is the
        canonical scalar its base name selects, wrapped once more when the declaration
        carried an array suffix.
        """
        named = self._catalog.find_named_type(column.type_base) if column.type_base else None
        scalar = named or _scalar_for(column.type_base)
        if column.type_base == "set":
            return TypeRef(item=TypeRef(name=_UNTYPED_SCALAR), nullable=nullable)
        if column.is_array:
            return TypeRef(item=TypeRef(name=scalar), nullable=nullable)
        return TypeRef(name=scalar, nullable=nullable)

    def _constraints(
        self, relation: SqlRelation, column: SqlColumn, check_enum: Optional[Tuple[Any, ...]]
    ) -> Optional[Constraints]:
        """Build the canonical constraint facets a column's declaration states."""
        facets: Dict[str, Any] = {}
        if column.enum_values:
            facets["enum"] = list(column.enum_values)
        elif check_enum:
            facets["enum"] = list(check_enum)
        length = _max_length(column, dialect=self._catalog.dialect)
        if length is not None:
            facets["max_length"] = length
        _ = relation
        return Constraints(**facets) if facets else None

    def _view_field(
        self, relation: SqlRelation, column: SqlViewColumn, position: int
    ) -> CanonicalField:
        """Project one of a view's projected columns onto a canonical field.

        A column that is a plain reference takes the *source* column's type and
        description, which is what makes a view over a typed table a typed record. A
        derived column takes :data:`_UNTYPED_SCALAR`, because the document states no type
        for the expression and this reader does not evaluate SQL to guess one.

        Args:
            relation: The view.
            column: The projected column.
            position: Its place in the select list.

        Returns:
            The canonical field.
        """
        source_column: Optional[SqlColumn] = None
        if column.source_table and column.source_column:
            source = self._catalog.relations.get(column.source_table)
            if source is not None:
                source_column = source.column(column.source_column)
        extras: Dict[str, Any] = {"sql_position": position}
        reference = TypeRef(name=_UNTYPED_SCALAR)
        constraints: Optional[Constraints] = None
        description: Optional[str] = None
        if source_column is not None:
            reference = self._type_reference(source_column, nullable=source_column.not_null is not True)
            constraints = self._constraints(relation, source_column, None)
            description = source_column.comment
            if source_column.data_type:
                extras["sql_data_type"] = source_column.data_type
            extras["sql_source"] = f"{column.source_table}.{column.source_column}"
        else:
            extras["sql_expression"] = column.expression
        return CanonicalField(
            key=Keys.field(relation.key, column.name),
            name=column.name,
            type=reference,
            constraints=constraints,
            description=description,
            extras=extras,
        )

    # -- relationships -----------------------------------------------------

    def _record_relationships(self, relation: SqlRelation, fields: Sequence[CanonicalField]) -> None:
        """Attach every resolved foreign key to the field that declares it.

        The payload is ODCS v3.1's property-level relationship — ``type: foreignKey`` with
        a ``to`` shorthand reference — plus the canonical coordinates the edge resolved to,
        which is the part a canonical consumer can actually follow. It is the same shape
        FMT-5.4's dbt reader writes for a ``relationships`` test, so two readers describing
        the same warehouse describe its edges identically.
        """
        by_name = {field.name.casefold(): field for field in fields}
        for constraint in relation.constraints:
            if constraint.kind != ConstraintKind.FOREIGN_KEY or constraint.reference is None:
                continue
            reference = constraint.reference
            target_key = reference.resolved_table or reference.table
            for position, name in enumerate(constraint.columns):
                field = by_name.get(name.casefold())
                if field is None:
                    continue
                target_column = (
                    reference.columns[position] if position < len(reference.columns) else None
                )
                payload = self._relationship_payload(
                    constraint, target_key=target_key, target_column=target_column
                )
                field.extras.setdefault("sql_relationship", []).append(payload)
                self.relationships.append(
                    {
                        "from": relation.key,
                        "from_column": name,
                        "to": target_key,
                        "to_column": target_column,
                        **({"name": constraint.name} if constraint.name else {}),
                    }
                )

    @staticmethod
    def _relationship_payload(
        constraint: SqlConstraint, *, target_key: str, target_column: Optional[str]
    ) -> Dict[str, Any]:
        """Render one foreign-key edge for the field's extras bag."""
        payload: Dict[str, Any] = {"type": "foreignKey", "to_type": target_key}
        if constraint.name:
            payload["name"] = constraint.name
        if target_column:
            payload["to"] = f"{target_key}.{target_column}"
            payload["to_field"] = Keys.field(target_key, target_column)
        else:
            payload["to"] = target_key
        if constraint.reference is not None:
            if constraint.reference.columns:
                payload["to_columns"] = list(constraint.reference.columns)
            if constraint.reference.on_delete:
                payload["on_delete"] = constraint.reference.on_delete
            if constraint.reference.on_update:
                payload["on_update"] = constraint.reference.on_update
        return payload


# ---------------------------------------------------------------------------
# Root extras
# ---------------------------------------------------------------------------


def _limits_payload(recorder: LimitRecorder) -> List[Dict[str, Any]]:
    """Render the reader's declared limits as the extras bag's ``capability_limits``."""
    return [
        {
            "construct": limit.construct,
            "detail": limit.detail,
            "count": limit.count,
            "locations": list(limit.locations),
        }
        for limit in recorder.limits()
    ]


def _root_extras(catalog: SqlCatalog, graph: _TypeGraph) -> Dict[str, Any]:
    """Build the document-level extras: the projection record plus the carried blocks.

    Args:
        catalog: The read catalog.
        graph: The completed type build, for its limit ledger and recorded relationships.

    Returns:
        The root ``extras`` mapping.
    """
    extras: Dict[str, Any] = {}
    if catalog.schemas:
        extras["sql_schemas"] = [dict(entry) for entry in catalog.schemas]
    if catalog.sequences:
        extras["sql_sequences"] = [
            {
                key: value
                for key, value in (
                    ("key", sequence.key),
                    ("name", sequence.name),
                    ("schema", sequence.schema),
                    ("options", dict(sequence.options) or None),
                )
                if value
            }
            for sequence in sorted(catalog.sequences.values(), key=lambda item: item.key)
        ]
    record: Dict[str, Any] = {
        "dialect": catalog.dialect,
        "dialect_label": DIALECT_LABELS.get(catalog.dialect, catalog.dialect),
        "dialect_source": catalog.dialect_source,
        "relations": [
            {"key": relation.key, "kind": relation.kind, "name": relation.name}
            for relation in sorted(catalog.relations.values(), key=lambda item: item.key)
        ],
        "capability_limits": _limits_payload(graph.limits),
    }
    if catalog.dialect_evidence:
        record["dialect_evidence"] = list(catalog.dialect_evidence)
    if catalog.statement_counts:
        record["statements"] = dict(sorted(catalog.statement_counts.items()))
    if graph.relationships:
        record["relationships"] = sorted(
            graph.relationships,
            key=lambda edge: (edge["from"], edge["from_column"], edge["to"]),
        )
    if catalog.current_schema:
        record["current_schema"] = catalog.current_schema
    if catalog.fileset:
        record["fileset"] = dict(catalog.fileset)
    extras[SQL_DDL_EXTRAS_KEY] = record
    return extras


class SqlDdlNormalizer(Normalizer, register=True):
    """Normalize a read DDL script into a :class:`CanonicalApi`."""

    format = SQL_DDL_FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project a :class:`~app.sql_ddl_schema.SqlCatalog` onto the canonical model.

        Args:
            source: The read catalog.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model: one ``data_schema`` document whose types are the script's
            tables, views and user-defined types, and whose foreign keys are recorded
            relationships.

        Raises:
            ValueError: If ``source`` is not a read DDL catalog.
        """
        if not isinstance(source, SqlCatalog):
            raise ValueError(
                "SQL DDL source must be a SqlCatalog (see app.sql_ddl_parser.parse_sql_ddl)"
            )
        graph = _TypeGraph(source)
        types = graph.build()
        extras = _root_extras(source, graph)
        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=source.name),
            title=source.name,
            types=types,
            raw={"sql_ddl": source.raw} if include_raw else None,
            extras=extras,
        )
        return normalize_ordering(api)
