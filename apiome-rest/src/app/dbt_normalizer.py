"""dbt → canonical model normalizer — FMT-5.4 (#5442).

Projects a read :class:`~app.dbt_resources.DbtProject` onto a
:class:`~app.canonical_model.CanonicalApi` with paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA`.

The projection
==============

* Each resource that describes data — a model, a source table, a seed, a snapshot, a
  semantic model — becomes one canonical ``RECORD`` :class:`Type`, keyed by its name
  (``<source>.<table>`` for a source table, ``semantic_model.<name>`` for a semantic
  model, so the three namespaces cannot collide).
* Each column becomes one :class:`CanonicalField`. Its ``data_type`` — the warehouse
  type — is projected onto a canonical scalar **by its base name only**; the parameters
  are carried, not interpreted, so ``varchar(20)`` does not become ``maxLength: 20``.
* A semantic model's entities, dimensions and measures each become one field, typed by
  what they are: an entity is the key expression it names, a ``time`` dimension is a
  timestamp, a counting measure is an integer.

Where a dbt test lands
======================

This is the projection's one real decision, and it is the ticket's acceptance criterion:

===================  ==================================================================
Test                 Lands as
===================  ==================================================================
``not_null``         ``nullable=False`` on the field — a canonical facet, modelled.
``accepted_values``  :attr:`Constraints.enum` on the field — a canonical facet, modelled.
``unique``           ``extras['dbt_key']`` — the canonical vocabulary has no identity
                     facet, so the declaration is carried and not enforced.
``relationships``    ``extras['dbt_relationship']`` — the canonical model has no edge
                     vocabulary, so the edge is carried in the ODCS v3.1 property-level
                     relationship shape, resolved to canonical keys.
everything else      ``extras['odcs_quality']`` — **the shared quality namespace FMT-5.1
                     defined**, in the ODCS ``type: custom`` rule shape with
                     ``engine: dbt``. A dbt project and an ODCS contract describing the
                     same table therefore put their expectations in the same place.
===================  ==================================================================

The extras namespace
====================

Everything a dbt project states that the canonical model has no home for is carried
verbatim under a documented key namespace. Every carried key is prefixed ``dbt_`` — with
the one deliberate exception of ``odcs_quality``, which is shared with FMT-5.1 on purpose:

===============================  ======  =====================================================
Key                              Node    Carries
===============================  ======  =====================================================
``dbt``                          root    Reader bookkeeping: ``surface``, the declared
                                         versions, ``resources``, ``lineage``,
                                         ``unresolved_lineage``, ``manifest``,
                                         ``capability_limits``, ``fileset``.
``dbt_project``                  root    The ``dbt_project.yml`` mapping.
``dbt_exposures``                root    ``exposures[]``.
``dbt_metrics``                  root    ``metrics[]``.
``dbt_extra``                    any     Any remaining dbt key the reader does not name.
``dbt_position``                 type,   Declaration order, because canonical ordering sorts
                                 field   by key and a relation's column order is physical.
``dbt_resource_type``            type    ``model`` / ``source`` / ``seed`` / ``snapshot`` /
                                         ``semantic_model``.
``dbt_unique_id``                type    The manifest ``unique_id``.
``dbt_config``                   type    The ``config`` block (materialization, contract).
``dbt_constraints``              type,   Model-contract ``constraints[]``.
                                 field
``dbt_relation``                 type    ``database``/``schema``/``alias``/``identifier``.
``dbt_freshness``                type    A source's ``freshness`` and ``loaded_at_field``.
``dbt_versions``                 type    ``versions[]`` / ``latest_version``.
``dbt_depends_on``               type    The resolved and unresolved lineage of this
                                         resource.
``dbt_source``                   type    The owning source's name, for a source table.
``dbt_meta``                     any     ``meta``.
``dbt_tags``                     any     ``tags[]``.
``dbt_data_type``                field   The declared warehouse ``data_type``, verbatim.
``dbt_key``                      field   ``unique`` / ``primary_key`` declarations.
``dbt_relationship``             field   A recorded lineage edge, ODCS-shaped.
``dbt_semantic``                 field   The entity/dimension/measure block, verbatim.
``odcs_quality``                 any     Data tests with no canonical analogue, in the
                                         FMT-5.1 shared quality namespace.
===============================  ======  =====================================================

Only ``dbt`` is the reader's own bookkeeping; it is therefore the single key listed in
:data:`app.import_preview_manifest.PROVENANCE_EXTRA_KEYS`. Every other key is a *source*
construct the canonical model does not hold, so it is reported as partially-mapped
coverage — which is exactly what "carried but not modelled" should look like to somebody
reading the catalog detail view.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Type,
    TypeKind,
    TypeRef,
)
from .dbt_resources import (
    DbtColumn,
    DbtProject,
    DbtRef,
    DbtRelationship,
    DbtResource,
    DbtSurface,
    DbtTest,
    LimitRecorder,
)
from .normalizer import Keys, Normalizer, normalize_ordering
from .odcs_normalizer import ODCS_QUALITY_EXTRAS_KEY

__all__ = [
    "DBT_EXTRAS_KEY",
    "DBT_QUALITY_ENGINE",
    "WAREHOUSE_SCALARS",
    "DbtNormalizer",
]

_FORMAT_KEY = "dbt"

#: The root extras key holding the reader's own projection record.
DBT_EXTRAS_KEY = "dbt"

#: The ``engine`` an ODCS ``type: custom`` quality rule carries when this reader wrote it.
#: The ODCS 3.1 schema names ``dbt`` among its own examples for the field, so a rule
#: projected here is one an ODCS consumer already knows how to read.
DBT_QUALITY_ENGINE = "dbt"

#: Warehouse type base name → canonical scalar.
#:
#: A dbt column's ``data_type`` is whatever the warehouse calls the type, and dbt itself
#: never interprets it. This reader interprets only its **base name** — the identifier
#: before any ``(...)`` parameters or ``[]`` suffix — because that is the half that means
#: the same thing in every dialect. The parameters are carried in ``dbt_data_type``: a
#: ``varchar(20)`` is a string of *some* declared length whose unit (characters? bytes?
#: code points?) differs by dialect and by encoding, so turning 20 into ``maxLength``
#: would be inventing a fact. This is the same rule FMT-5.1 applies to ODCS
#: ``physicalType``.
#:
#: The canonical spellings are the precise widths the rest of the fleet uses, so a dbt
#: model and an Avro record describing the same table produce comparable canonical fields.
WAREHOUSE_SCALARS: Dict[str, str] = {
    # text
    "varchar": "string",
    "varchar2": "string",
    "nvarchar": "string",
    "nvarchar2": "string",
    "char": "string",
    "nchar": "string",
    "bpchar": "string",
    "character": "string",
    "text": "string",
    "string": "string",
    "clob": "string",
    "uuid": "uuid",
    # integers
    "tinyint": "int8",
    "smallint": "int16",
    "int2": "int16",
    "int": "int32",
    "integer": "int32",
    "int4": "int32",
    "bigint": "int64",
    "int8": "int64",
    "long": "int64",
    # reals
    "real": "float",
    "float4": "float",
    "float": "double",
    "float8": "double",
    "double": "double",
    "double precision": "double",
    "numeric": "decimal",
    "decimal": "decimal",
    "number": "decimal",
    "money": "decimal",
    # temporal
    "date": "date",
    "time": "time",
    "timetz": "time",
    "datetime": "timestamp",
    "datetime2": "timestamp",
    "timestamp": "timestamp",
    "timestamptz": "timestamp",
    "timestamp_ntz": "timestamp",
    "timestamp_tz": "timestamp",
    "timestamp_ltz": "timestamp",
    # booleans, binary, and the open types
    "boolean": "boolean",
    "bool": "boolean",
    "binary": "bytes",
    "varbinary": "bytes",
    "bytea": "bytes",
    "blob": "bytes",
    "json": "json",
    "jsonb": "json",
    "variant": "json",
    "super": "json",
    "object": "json",
}

#: The canonical scalar a column with no declared ``data_type`` takes. A properties file
#: that documents a column without typing it is the common case — dbt reads the real type
#: out of the compiled SQL, which this reader does not execute — so ``string`` is the
#: honest "not stated here", matching what FMT-5.1 does for an untyped ODCS property.
_UNTYPED_SCALAR = "string"

#: The base name of a warehouse type: the identifier before any ``(...)`` parameters, any
#: ``[]`` array suffix, and any trailing modifier (``timestamp without time zone``).
_TYPE_BASE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_ ]*?)\s*(?:\(|\[|<|$)")

#: ``... without time zone`` / ``... with time zone`` modifiers, which name the same
#: canonical instant either way — the canonical model has no zone-awareness facet.
_TIME_ZONE_SUFFIX_RE = re.compile(r"\s+with(?:out)?\s+time\s+zone\s*$", re.IGNORECASE)

#: dbt test names that declare identity rather than shape.
_IDENTITY_TESTS = frozenset({"unique"})

#: The lineage test, handled by :func:`_relationship_payload`.
_RELATIONSHIP_TEST = "relationships"

#: Model-contract constraint types that declare identity.
_IDENTITY_CONSTRAINTS = frozenset({"primary_key", "unique"})

#: Semantic-model member ``role`` → the canonical scalar its column takes when the block
#: says nothing more specific. An entity is a key, a dimension is a label, a measure is a
#: number.
_SEMANTIC_ROLE_SCALARS: Dict[str, str] = {
    "entity": "string",
    "dimension": "string",
    "measure": "number",
}

#: Measure ``agg`` → canonical scalar. A count is a whole number of rows however the
#: measured column is typed; every other aggregate stays a number, because the canonical
#: model cannot know the precision the warehouse will return.
_MEASURE_AGG_SCALARS: Dict[str, str] = {
    "count": "int64",
    "count_distinct": "int64",
}

#: Column-level keys lifted onto their own extras key, with the limit each one declares.
_COLUMN_GOVERNANCE: Tuple[Tuple[str, str, str], ...] = (
    ("meta", "dbt_meta", "dbt.meta"),
    ("tags", "dbt_tags", "dbt.tag"),
)

#: Resource-level keys lifted onto their own extras key, with the limit each declares.
_RESOURCE_GOVERNANCE: Tuple[Tuple[str, str, str], ...] = (
    ("meta", "dbt_meta", "dbt.meta"),
    ("tags", "dbt_tags", "dbt.tag"),
)


# ---------------------------------------------------------------------------
# Warehouse types
# ---------------------------------------------------------------------------


def _scalar_for(data_type: Optional[str]) -> str:
    """Return the canonical scalar a declared warehouse type projects onto.

    Args:
        data_type: The declared ``data_type``, verbatim, or ``None``.

    Returns:
        The canonical scalar name; :data:`_UNTYPED_SCALAR` when the type is absent or its
        base name is one this reader does not decode. An unknown base name is *not* an
        error and not a loss of information — the declared spelling survives in
        ``dbt_data_type``.
    """
    if not data_type:
        return _UNTYPED_SCALAR
    normalized = _TIME_ZONE_SUFFIX_RE.sub("", data_type.strip())
    match = _TYPE_BASE_RE.match(normalized)
    if match is None:
        return _UNTYPED_SCALAR
    base = " ".join(match.group(1).lower().split())
    return WAREHOUSE_SCALARS.get(base, _UNTYPED_SCALAR)


def _is_array_type(data_type: Optional[str]) -> bool:
    """Whether a declared warehouse type is an array (``varchar[]``, ``array<int>``)."""
    if not data_type:
        return False
    stripped = data_type.strip().lower()
    return stripped.endswith("[]") or stripped.startswith("array")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def _test_base_name(test: DbtTest) -> str:
    """Return a test's unqualified name (``dbt_utils.recency`` → ``recency``)."""
    return test.name.rsplit(".", 1)[-1]


def _quality_rule(test: DbtTest, *, owner: str) -> Dict[str, Any]:
    """Project one dbt test into the shared quality namespace, ODCS-shaped.

    The result is a valid ODCS ``DataQuality`` object of ``type: custom``: the standard's
    own extension point for "a quality attribute that is vendor-specific", whose published
    examples name ``dbt`` among the engines. That is what makes this the *shared* namespace
    rather than a dbt-shaped bag that happens to sit under an ODCS key — an ODCS consumer
    reading ``extras['odcs_quality']`` finds a rule it already understands.

    Args:
        test: The parsed test.
        owner: What the rule is attached to, for the rule's description.

    Returns:
        The rule mapping. Keys absent from the source are absent from the rule, so a
        golden file never records a severity the project did not declare.
    """
    implementation: Dict[str, Any] = {"test": test.name}
    if test.column:
        implementation["column"] = test.column
    arguments = {key: value for key, value in test.arguments.items() if key != "config"}
    if arguments:
        implementation["arguments"] = arguments
    rule: Dict[str, Any] = {
        "type": "custom",
        "engine": DBT_QUALITY_ENGINE,
        "implementation": implementation,
        "name": test.name,
        "description": f"dbt data test `{test.name}` on {owner}.",
    }
    if test.severity:
        rule["severity"] = test.severity
    return rule


def _enum_values(test: DbtTest) -> Optional[List[Any]]:
    """Return the values an ``accepted_values`` test permits, or ``None``.

    Args:
        test: The parsed test.

    Returns:
        The declared values as a list. ``None`` when the test declares none, or declares
        something that is not a list — a malformed argument is carried in the quality
        namespace rather than turned into an empty enum, which would read as "no value is
        permitted".
    """
    values = test.arguments.get("values")
    if isinstance(values, Sequence) and not isinstance(values, (str, bytes)):
        return list(values)
    return None


def _relationship_payload(
    relationship: DbtRelationship, *, target: Optional[DbtResource]
) -> Dict[str, Any]:
    """Render one recorded lineage edge for the field's extras bag.

    The shape is ODCS v3.1's property-level relationship (``type: foreignKey`` with a
    ``to`` shorthand reference), plus the canonical coordinates the edge resolved to — the
    part a canonical consumer can actually follow.

    Args:
        relationship: The resolved edge.
        target: The resource the edge points at.

    Returns:
        The payload mapping.
    """
    to_column = relationship.to_columns[0] if relationship.to_columns else None
    payload: Dict[str, Any] = {
        "type": "foreignKey",
        "origin": relationship.origin,
        "ref": relationship.to_ref.raw or relationship.to_ref.target,
    }
    if target is not None:
        payload["to_type"] = target.key
        if to_column:
            payload["to"] = f"{target.key}.{to_column}"
            payload["to_field"] = Keys.field(target.key, to_column)
        else:
            payload["to"] = target.key
    if relationship.to_columns:
        payload["to_columns"] = list(relationship.to_columns)
    return payload


# ---------------------------------------------------------------------------
# The type graph
# ---------------------------------------------------------------------------


class _TypeGraph:
    """Builds the canonical types one dbt project projects onto.

    Every resource is one record. Nothing nests: a warehouse relation is flat, and a
    ``VARIANT``/``JSON`` column is an opaque scalar rather than a synthesized record,
    because a properties file states no shape for what is inside it.
    """

    def __init__(self, project: DbtProject) -> None:
        self._project = project
        # A compiled manifest keys its nodes and its columns in JSON *objects*, and a JSON
        # object is an unordered collection: the manifest states no declaration order, and
        # recording one would make a cosmetically re-serialized artifact fingerprint as a
        # new revision. The properties file the manifest was compiled from does state an
        # order — `models:` and `columns:` are lists — so that is the surface `dbt_position`
        # is read from, and the only one.
        self._ordered = project.surface != DbtSurface.MANIFEST
        self._limits = LimitRecorder()
        self._by_key = {resource.key: resource for resource in project.resources}
        self._edges: Dict[Tuple[str, str], List[DbtRelationship]] = {}
        for relationship in project.relationships:
            for column in relationship.from_columns or ("",):
                self._edges.setdefault((relationship.from_resource, column), []).append(
                    relationship
                )

    @property
    def limits(self) -> LimitRecorder:
        """The limit recorder this build populated."""
        return self._limits

    def build(self) -> List[Type]:
        """Project every resource onto a canonical record type.

        Returns:
            The canonical types, in declaration order (canonical ordering re-sorts them by
            key; ``dbt_position`` preserves what the source declared).
        """
        return [self._resource_type(resource) for resource in self._project.resources]

    # -- resources ---------------------------------------------------------

    def _resource_type(self, resource: DbtResource) -> Type:
        """Project one resource onto a record type."""
        key = Keys.type(resource.key)
        extras: Dict[str, Any] = {"dbt_resource_type": resource.kind}
        if self._ordered:
            extras["dbt_position"] = resource.position
            # Recorded once per resource rather than once per column: the limit is that
            # canonical ordering does not follow the source, and a 200-column model states
            # that fact once.
            self._limits.record("dbt.declaration_order", location=key)
        if resource.unique_id:
            extras["dbt_unique_id"] = resource.unique_id
        if resource.source_name:
            extras["dbt_source"] = resource.source_name
        if resource.config:
            extras["dbt_config"] = dict(resource.config)
            self._limits.record("dbt.materialization", location=key)
        if resource.relation:
            extras["dbt_relation"] = dict(resource.relation)
            self._limits.record("dbt.relation_name", location=key)
        if resource.freshness:
            extras["dbt_freshness"] = dict(resource.freshness)
            self._limits.record("dbt.freshness", location=key)
        if resource.versions:
            extras["dbt_versions"] = dict(resource.versions)
            self._limits.record("dbt.model_version", location=key)
        if resource.semantic:
            extras["dbt_semantic_model"] = dict(resource.semantic)
        self._carry_constraints(resource.constraints, extras, location=key)
        self._carry_lineage(resource, extras, location=key)

        governance = dict(resource.governance)
        for source_key, extras_key, limit in _RESOURCE_GOVERNANCE:
            if source_key in governance:
                extras[extras_key] = governance.pop(source_key)
                self._limits.record(limit, location=key)
        quality = self._resource_quality(resource, location=key)
        if quality:
            extras[ODCS_QUALITY_EXTRAS_KEY] = quality
        if governance:
            extras["dbt_extra"] = governance

        fields = [
            self._field(column, resource=resource, owner=key, position=index)
            for index, column in enumerate(resource.columns)
        ]
        if not fields:
            self._limits.record("dbt.undocumented_columns", location=key)
        return Type(
            key=key,
            name=resource.name,
            kind=TypeKind.RECORD,
            description=resource.description,
            fields=fields,
            extras=extras,
        )

    def _resource_quality(self, resource: DbtResource, *, location: str) -> List[Dict[str, Any]]:
        """Project the resource-level tests that have no canonical analogue.

        A resource-level test is one a properties file attached to the model rather than
        to a column, or one a manifest hoisted with a ``column_name`` the node does not
        declare. Neither can become a constraint — there is no field to put it on — so
        both land in the shared quality namespace.
        """
        rules: List[Dict[str, Any]] = []
        declared = {column.name for column in resource.columns}
        for test in resource.tests:
            base = _test_base_name(test)
            if base == _RELATIONSHIP_TEST:
                # The edge itself is recorded on the resource; the test is not a rule.
                continue
            if test.column and test.column in declared:
                # Attached to a column the resource declares: the field carries it.
                continue
            rules.append(_quality_rule(test, owner=f"`{resource.name}`"))
            self._limits.record("dbt.data_test", location=location)
        return rules

    def _carry_constraints(
        self,
        constraints: Sequence[Mapping[str, Any]],
        extras: Dict[str, Any],
        *,
        location: str,
    ) -> None:
        """Carry model-contract constraints, recording the limit each one declares."""
        if not constraints:
            return
        extras["dbt_constraints"] = [dict(item) for item in constraints]
        for constraint in constraints:
            kind = str(constraint.get("type") or "").strip().lower()
            if kind in _IDENTITY_CONSTRAINTS:
                self._limits.record("dbt.uniqueness", location=location)
            elif kind == "check":
                self._limits.record("dbt.check_constraint", location=location)
            elif kind == "foreign_key":
                self._limits.record("dbt.lineage_relationship", location=location)

    def _carry_lineage(
        self, resource: DbtResource, extras: Dict[str, Any], *, location: str
    ) -> None:
        """Record the resource's upstream lineage, resolved and unresolved alike."""
        if not resource.depends_on:
            return
        resolved: List[str] = []
        dangling: List[str] = []
        for ref in resource.depends_on:
            target = self._by_key.get(ref.target)
            (resolved if target is not None else dangling).append(ref.target)
        payload: Dict[str, Any] = {}
        if resolved:
            payload["resolved"] = sorted(set(resolved))
        if dangling:
            payload["unresolved"] = sorted(set(dangling))
        extras["dbt_depends_on"] = payload
        self._limits.record("dbt.model_lineage", location=location)

    # -- columns -----------------------------------------------------------

    def _field(
        self, column: DbtColumn, *, resource: DbtResource, owner: str, position: int
    ) -> CanonicalField:
        """Project one column onto a canonical field of ``owner``."""
        key = Keys.field(owner, column.name)
        extras: Dict[str, Any] = {"dbt_position": position} if self._ordered else {}
        if column.data_type:
            extras["dbt_data_type"] = column.data_type
            self._limits.record("dbt.data_type", location=owner)
        if column.semantic:
            extras["dbt_semantic"] = dict(column.semantic)
            self._limits.record("dbt.semantic_layer", location=owner)

        nullable = True
        values: Dict[str, Any] = {}
        identity: Dict[str, Any] = {}
        rules: List[Dict[str, Any]] = []
        for test in column.tests:
            base = _test_base_name(test)
            if base == "not_null":
                nullable = False
                continue
            if base == "accepted_values":
                enum = _enum_values(test)
                if enum is not None:
                    values["enum"] = enum
                    continue
                # A malformed `accepted_values` states an expectation this reader cannot
                # turn into an enum; it is carried rather than silently dropped.
            if base in _IDENTITY_TESTS:
                identity[base] = True
                self._limits.record("dbt.uniqueness", location=owner)
                continue
            if base == _RELATIONSHIP_TEST:
                continue
            rules.append(_quality_rule(test, owner=f"`{resource.name}.{column.name}`"))
            self._limits.record("dbt.data_test", location=owner)

        for constraint in column.constraints:
            kind = str(constraint.get("type") or "").strip().lower()
            if kind == "not_null":
                nullable = False
            elif kind in _IDENTITY_CONSTRAINTS:
                identity[kind] = True
                self._limits.record("dbt.uniqueness", location=owner)
        if column.constraints:
            extras["dbt_constraints"] = [dict(item) for item in column.constraints]

        edges = self._edges.get((resource.key, column.name), ())
        if edges:
            extras["dbt_relationship"] = [
                _relationship_payload(edge, target=self._by_key.get(edge.to_ref.target))
                for edge in edges
            ]
            for _ in edges:
                self._limits.record("dbt.lineage_relationship", location=owner)
        if identity:
            extras["dbt_key"] = identity

        governance = dict(column.governance)
        for source_key, extras_key, limit in _COLUMN_GOVERNANCE:
            if source_key in governance:
                extras[extras_key] = governance.pop(source_key)
                self._limits.record(limit, location=owner)
        if rules:
            extras[ODCS_QUALITY_EXTRAS_KEY] = rules
        if governance:
            extras["dbt_extra"] = governance

        return CanonicalField(
            key=key,
            name=column.name,
            type=self._type_ref(column, nullable=nullable),
            description=column.description,
            constraints=Constraints(**values) if values else None,
            extras=extras,
        )

    def _type_ref(self, column: DbtColumn, *, nullable: bool) -> TypeRef:
        """Build the type reference a column's declared type names."""
        scalar = self._semantic_scalar(column) or _scalar_for(column.data_type)
        if _is_array_type(column.data_type):
            return TypeRef(item=TypeRef(name=scalar), nullable=nullable)
        return TypeRef(name=scalar, nullable=nullable)

    @staticmethod
    def _semantic_scalar(column: DbtColumn) -> Optional[str]:
        """Return the canonical scalar a semantic-model member takes, if it is one.

        A semantic model states what each member *is* rather than how the warehouse stores
        it: a ``time`` dimension is an instant, a counting measure is a whole number, an
        entity is the key expression it names. That is more type information than the
        member's absent ``data_type``, so it is used.
        """
        if not column.semantic:
            return None
        role = str(column.semantic.get("role") or "")
        if role == "dimension" and str(column.semantic.get("type") or "").lower() == "time":
            return "timestamp"
        if role == "measure":
            agg = str(column.semantic.get("agg") or "").lower()
            return _MEASURE_AGG_SCALARS.get(agg, _SEMANTIC_ROLE_SCALARS["measure"])
        return _SEMANTIC_ROLE_SCALARS.get(role)


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


def _lineage_payload(project: DbtProject) -> List[Dict[str, Any]]:
    """Render the lineage edges this reader recorded, sorted for determinism."""
    edges = [
        {
            "from": relationship.from_resource,
            "from_columns": list(relationship.from_columns),
            "to": relationship.to_ref.target,
            "to_columns": list(relationship.to_columns),
            "origin": relationship.origin,
        }
        for relationship in project.relationships
    ]
    return sorted(edges, key=lambda edge: (edge["from"], edge["from_columns"], edge["to"]))


def _unresolved_payload(unresolved: Sequence[Tuple[str, DbtRef]]) -> List[Dict[str, Any]]:
    """Render the references that name nothing in the import, sorted for determinism."""
    rows = [
        {"declared_by": owner, "kind": ref.kind, "target": ref.target, "ref": ref.raw or ref.target}
        for owner, ref in unresolved
    ]
    seen: List[Dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: (item["declared_by"], item["kind"], item["target"])):
        if row not in seen:
            seen.append(row)
    return seen


def _root_extras(project: DbtProject, recorder: LimitRecorder) -> Dict[str, Any]:
    """Build the project-level extras: the projection record plus the carried blocks.

    Args:
        project: The read project.
        recorder: The limit recorder the type build populated; project-level blocks record
            their own limits into it here.

    Returns:
        The root ``extras`` mapping.
    """
    extras: Dict[str, Any] = {}
    if project.project_config:
        extras["dbt_project"] = dict(project.project_config)
        recorder.record("dbt.project_config")
    if project.exposures:
        extras["dbt_exposures"] = [dict(item) for item in project.exposures]
        for _ in project.exposures:
            recorder.record("dbt.exposure")
    if project.metrics:
        extras["dbt_metrics"] = [dict(item) for item in project.metrics]
        for _ in project.metrics:
            recorder.record("dbt.metric")
    unresolved = _unresolved_payload(project.unresolved)
    for _ in unresolved:
        recorder.record("dbt.unresolved_lineage")
    if project.manifest_graph:
        recorder.record("dbt.manifest_graph")
    if project.governance:
        extras["dbt_extra"] = dict(project.governance)

    record: Dict[str, Any] = {
        "surface": project.surface,
        "resources": sorted(
            (
                {"key": resource.key, "kind": resource.kind, "name": resource.name}
                for resource in project.resources
            ),
            key=lambda row: row["key"],
        ),
        "capability_limits": _limits_payload(recorder),
    }
    for label, value in (
        ("properties_version", project.properties_version),
        ("manifest_schema_version", project.schema_version),
        ("dbt_version", project.dbt_version),
        ("adapter_type", project.adapter_type),
        ("generated_at", project.generated_at),
        ("project_version", project.version),
    ):
        if value is not None:
            record[label] = value
    lineage = _lineage_payload(project)
    if lineage:
        record["lineage"] = lineage
    if unresolved:
        record["unresolved_lineage"] = unresolved
    if project.manifest_graph:
        record["manifest"] = dict(project.manifest_graph)
    if project.fileset:
        record["fileset"] = dict(project.fileset)
    extras[DBT_EXTRAS_KEY] = record
    return extras


class DbtNormalizer(Normalizer, register=True):
    """Normalize a read dbt project into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project a :class:`~app.dbt_resources.DbtProject` onto the canonical model.

        Args:
            source: The read project.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model: one ``data_schema`` document whose types are the
            project's models, sources, seeds, snapshots and semantic models, and whose
            tests land as constraints or as shared-namespace quality rules.

        Raises:
            ValueError: If ``source`` is not a read dbt project.
        """
        if not isinstance(source, DbtProject):
            raise ValueError(
                "dbt source must be a DbtProject (see app.dbt_parser.parse_dbt)"
            )

        graph = _TypeGraph(source)
        types = graph.build()
        extras = _root_extras(source, graph.limits)

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=source.name),
            version=source.version,
            title=source.name,
            description=None,
            types=types,
            raw={"dbt": source.raw} if include_raw else None,
            extras=extras,
        )
        return normalize_ordering(api)
