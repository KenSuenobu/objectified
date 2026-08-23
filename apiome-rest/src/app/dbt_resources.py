"""dbt project document algebra — FMT-5.4 (#5442).

The typed shape a read dbt project takes on its way to the canonical model, plus the two
things every reader in this fleet states up front: which document versions it will read,
and which of the format's constructs it carries but does not model.

**Two surfaces, one algebra.** An analytics team describes its warehouse twice: in
``schema.yml`` *properties files* it hand-writes, and in the ``manifest.json`` dbt
compiles from them. The two spell the same facts differently — a properties file nests
``models[].columns[]`` and attaches tests inline, a manifest keys ``nodes`` by
``model.<package>.<name>`` and hoists every test into a node of its own — but they
describe one project. Both are read into the same :class:`DbtProject`, which is what
makes "a ``schema.yml`` project and a compiled ``manifest.json`` both import" a single
projection rather than two.

**A dbt test is either a constraint or a quality rule, never both.** ``not_null`` and
``accepted_values`` have exact canonical analogues (nullability, ``enum``) and are
*modelled*. ``unique`` and ``relationships`` declare identity and lineage, which the
canonical model has no facet for, so they are carried on the field. Everything else — a
package test (``dbt_utils.expression_is_true``), a singular test, a generic test this
reader does not decode — is projected into the **shared quality namespace FMT-5.1
defined** (:data:`app.odcs_normalizer.ODCS_QUALITY_EXTRAS_KEY`), in the ODCS
``type: custom`` rule shape with ``engine: dbt``. That is the alignment the ticket asks
for: a dbt project and an ODCS contract describing the same table put their expectations
in the same place, under the same key, in the same shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Set, Tuple

__all__ = [
    "LIMIT_DETAILS",
    "MANIFEST_READ_VERSIONS",
    "MAX_ALIAS_COST",
    "MAX_COLUMNS",
    "MAX_RESOURCES",
    "PROPERTIES_VERSION",
    "RESOURCE_KINDS",
    "DbtColumn",
    "DbtLimit",
    "DbtParseError",
    "DbtProject",
    "DbtRef",
    "DbtRelationship",
    "DbtResource",
    "DbtSurface",
    "DbtTest",
    "LimitRecorder",
    "resolve_manifest_schema_version",
    "resolve_properties_version",
]


# ---------------------------------------------------------------------------
# Version vocabulary
# ---------------------------------------------------------------------------

#: The one ``version:`` a dbt properties file may declare. dbt removed the v1 properties
#: shape in 0.21 and has published nothing since ``version: 2``, so this is not a "current
#: version" so much as the only one — but it is still checked, because a file that says
#: something else is either very old or not a dbt properties file at all, and reading it
#: as v2 would silently mis-read whichever it is.
PROPERTIES_VERSION = 2

#: The compiled-manifest schema versions this reader models, as the integer in
#: ``metadata.dbt_schema_version`` (``https://schemas.getdbt.com/dbt/manifest/v12.json``).
#: v7 is dbt 1.0 — the first release with the node shape this reader walks (``nodes``
#: keyed by ``unique_id``, ``columns`` as a mapping, tests hoisted into their own nodes
#: with ``test_metadata``). Every version since has *added* keys, which are carried, so
#: one reader covers the line.
MANIFEST_READ_VERSIONS: Tuple[int, ...] = (7, 8, 9, 10, 11, 12)

#: How many resources (models, source tables, seeds, snapshots, semantic models) one
#: import may declare. A runaway backstop: the largest honest dbt projects run to a few
#: thousand models.
MAX_RESOURCES = 20_000

#: How many columns one import may declare across every resource. Same purpose.
MAX_COLUMNS = 200_000

#: The YAML alias-expansion budget a dbt document is read under.
#:
#: The shared intake guard's default (100) is calibrated for OpenAPI, where a YAML anchor
#: is a rarity. In dbt it is the *composition mechanism*: a properties file shares a column
#: group or a test block by anchoring it once and splicing it into several models, and a
#: perfectly ordinary three-model file spends more than the shared budget doing it. This
#: reader therefore raises that one bound and leaves every other guard — byte ceiling,
#: nesting depth, expansion ratio, entity count — at the shared default, because those are
#: the ones that actually stop an expansion bomb. The scanner short-circuits at the bound,
#: and an exponential anchor chain passes 5,000 within a handful of levels, so raising it
#: buys honest documents room without buying a bomb any.
MAX_ALIAS_COST = 5_000

#: The dbt resource kinds that describe *data* — the ones that become canonical types.
#: Exposures and metrics describe consumption, not structure, and are carried instead.
RESOURCE_KINDS: Tuple[str, ...] = ("model", "source", "seed", "snapshot", "semantic_model")


class DbtSurface:
    """Which of dbt's descriptions of a project was read.

    Plain string constants rather than an ``Enum`` so the value lands in the extras bag
    (and therefore in a golden file) as the word itself, with no serialization step to get
    wrong.
    """

    #: A hand-written ``schema.yml`` properties file.
    PROPERTIES = "properties"
    #: A compiled ``manifest.json``.
    MANIFEST = "manifest"
    #: A file set rooted at ``dbt_project.yml``.
    PROJECT = "project"


class DbtParseError(ValueError):
    """Raised when a dbt document cannot be read into a :class:`DbtProject`.

    Attributes:
        code: The intake-taxonomy code the pipeline should report, when this reader can
            classify the failure itself. ``None`` leaves the classification to
            :func:`app.import_source_pipeline._classify_parse_failure` — which is what
            makes a UTF-16 upload read as ``INPUT_ENCODING_INVALID`` and an ODCS contract
            handed to this adapter read as ``FORMAT_MISMATCH`` rather than as a generic
            malformed document.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


def resolve_properties_version(declared: Any, *, source_label: Optional[str] = None) -> int:
    """Check a properties file's ``version:`` declaration.

    Args:
        declared: The document's ``version`` value, of whatever type it had.
        source_label: The document's name, for error messages.

    Returns:
        :data:`PROPERTIES_VERSION`.

    Raises:
        DbtParseError: ``FORMAT_VERSION_UNSUPPORTED`` when the file declares a version
            that is not 2, with the migration named. A *missing* ``version`` is not an
            error: dbt itself treats it as 2, and refusing it would reject files the
            reference tooling reads.
    """
    if declared is None:
        return PROPERTIES_VERSION
    if isinstance(declared, bool) or not isinstance(declared, int):
        where = f" ({source_label})" if source_label else ""
        raise DbtParseError(
            f"dbt properties file declares `version: {declared!r}`{where}; the property is "
            f"the *schema* version of the file and must be the integer "
            f"{PROPERTIES_VERSION}. A project's own release number belongs in "
            "`dbt_project.yml`'s `version:`, which is a different file.",
            code="FORMAT_VERSION_UNSUPPORTED",
        )
    if declared != PROPERTIES_VERSION:
        raise DbtParseError(
            f"dbt properties file declares `version: {declared}`; this importer reads "
            f"`version: {PROPERTIES_VERSION}`, the only properties schema dbt has "
            "published since 0.21. Version 1 spelled models as a mapping keyed by name "
            "with `constraints:` strings instead of a `models:` list, so the two are not "
            "interchangeable documents — migrate the file to `version: 2`.",
            code="FORMAT_VERSION_UNSUPPORTED",
        )
    return PROPERTIES_VERSION


def resolve_manifest_schema_version(
    declared: Any, *, source_label: Optional[str] = None
) -> int:
    """Parse and range-check a compiled manifest's ``metadata.dbt_schema_version``.

    Args:
        declared: The declared schema-version URL
            (``https://schemas.getdbt.com/dbt/manifest/v12.json``).
        source_label: The document's name, for error messages.

    Returns:
        The major version number the URL names.

    Raises:
        DbtParseError: ``INPUT_SEMANTIC_INVALID`` when the URL is missing or carries no
            ``vN`` segment; ``FORMAT_VERSION_UNSUPPORTED`` when it parses but names a
            version outside :data:`MANIFEST_READ_VERSIONS`.
    """
    where = f" ({source_label})" if source_label else ""
    if not isinstance(declared, str) or not declared.strip():
        raise DbtParseError(
            f"dbt manifest declares no `metadata.dbt_schema_version`{where}; every "
            "compiled manifest names the schema it was written against (for example "
            "`https://schemas.getdbt.com/dbt/manifest/v12.json`)",
            code="INPUT_SEMANTIC_INVALID",
        )
    tail = declared.strip().rstrip("/").rsplit("/", 1)[-1]
    digits = tail[1:].split(".", 1)[0] if tail[:1].lower() == "v" else ""
    if not digits.isdigit():
        raise DbtParseError(
            f"dbt manifest `metadata.dbt_schema_version` {declared.strip()!r}{where} names "
            "no manifest version; expected a URL ending in `/manifest/v<N>.json`",
            code="INPUT_SEMANTIC_INVALID",
        )
    version = int(digits)
    if version in MANIFEST_READ_VERSIONS:
        return version
    lowest, highest = MANIFEST_READ_VERSIONS[0], MANIFEST_READ_VERSIONS[-1]
    if version < lowest:
        raise DbtParseError(
            f"dbt manifest v{version} predates dbt 1.0; this importer reads manifest "
            f"v{lowest}-v{highest}. Manifests before v{lowest} spelled a node's `columns` "
            "and hoisted tests differently, so they are not interchangeable documents — "
            "recompile the project with dbt 1.0 or later (`dbt compile`).",
            code="FORMAT_VERSION_UNSUPPORTED",
        )
    raise DbtParseError(
        f"dbt manifest v{version} is newer than this importer reads (v{lowest}-v{highest}), "
        "and this reader will not guess at a later schema's node shape. Compile the "
        f"project with a dbt release that writes manifest v{highest} or earlier, or "
        "upgrade Apiome.",
        code="FORMAT_VERSION_UNSUPPORTED",
    )


# ---------------------------------------------------------------------------
# Declared limits — what the reader carries but does not model
# ---------------------------------------------------------------------------

#: Stable limit key → the sentence published for it.
#:
#: These keys are one vocabulary in three places: here, in
#: :data:`app.dbt_import_source.DBT_CAPABILITIES`'s ``unsupported`` list, and in the
#: ``dbt`` seed's ``dropped_constructs`` in :mod:`app.format_capability_registry`. A test
#: asserts all three agree, so a construct cannot be silently carried.
#:
#: Every one of them is *carried*: the source block survives in canonical ``extras``
#: under the documented ``dbt_*`` namespace — or, for data tests, under the shared
#: quality namespace FMT-5.1 defined — so nothing is lost. What is declared here is that
#: the canonical model has no *native* home for it, and no Apiome feature that consumes
#: the canonical model (diff, lint, compatibility) sees it.
LIMIT_DETAILS: Dict[str, str] = {
    "dbt.data_test": (
        "A data test states an expectation about the *rows* of a model — a package test "
        "(`dbt_utils.expression_is_true`), a singular test, or a generic test with no "
        "canonical analogue. The canonical model constrains shape, so the test is "
        "projected into the shared quality namespace FMT-5.1 defined "
        "(`extras['odcs_quality']`, in the ODCS `type: custom` rule shape with "
        "`engine: dbt`) on the model or the column that declared it, and is never "
        "executed, compiled, or turned into a constraint."
    ),
    "dbt.uniqueness": (
        "A `unique` test, a `primary_key` constraint and a `unique` constraint declare "
        "identity over the *rows* of a model. The canonical constraint vocabulary has no "
        "identity facet (`unique_items` is about the members of one array), so the "
        "declaration is carried on the field or the type in `extras['dbt_key']` and is "
        "not enforced."
    ),
    "dbt.lineage_relationship": (
        "A `relationships` test and a `foreign_key` constraint name the model a column "
        "points at. The canonical model has no edge vocabulary, so the edge is recorded "
        "on the field in `extras['dbt_relationship']` — in the ODCS v3.1 property-level "
        "relationship shape (`type: foreignKey`, `to: <model>.<column>`), beside the "
        "canonical type and field keys it resolved to — and no canonical feature "
        "traverses it."
    ),
    "dbt.unresolved_lineage": (
        "A `ref()` or `source()` that names something the import does not contain — an "
        "upstream model in another package, a source a `schema.yml` beside this one "
        "declares, a semantic model's `model:` target. The name is recorded in "
        "`extras['dbt']['unresolved_lineage']` exactly as written and is *not* resolved; "
        "the import does not reach outside itself to look for it. A `relationships` test "
        "or a `foreign_key` constraint that dangles is a different matter and is refused, "
        "because that edge is one this reader records."
    ),
    "dbt.materialization": (
        "`config` states how dbt *builds* the relation — `materialized`, `unique_key`, "
        "`incremental_strategy`, `partition_by`, `contract.enforced`, and every adapter- "
        "specific key beside them. The canonical model describes shape, not build "
        "strategy, so the block is carried verbatim in `extras['dbt_config']`."
    ),
    "dbt.data_type": (
        "`data_type` is the column's type *in the warehouse* (`varchar(20)`, "
        "`numeric(13,2)`, `TIMESTAMP_NTZ`, `VARIANT`). Its base name selects a canonical "
        "scalar, but its parameters are deliberately not interpreted — `varchar(20)` does "
        "**not** become `maxLength: 20`, because the unit differs by dialect and by "
        "encoding — and the declared spelling is carried verbatim in "
        "`extras['dbt_data_type']`."
    ),
    "dbt.freshness": (
        "A source's `freshness` block states `warn_after`/`error_after` windows against "
        "`loaded_at_field`. That is a service level over the loading pipeline, not a "
        "property of the schema, so it is carried verbatim in `extras['dbt_freshness']` "
        "beside the field it is measured on."
    ),
    "dbt.relation_name": (
        "`database`, `schema`, `alias` and a source table's `identifier` say what the "
        "relation is actually called in the warehouse. The canonical model names the "
        "logical resource, so the physical location is carried verbatim in "
        "`extras['dbt_relation']` and the type keeps the name the project gave it."
    ),
    "dbt.meta": (
        "`meta` is dbt's own extension point: publisher-defined keys on a model, a "
        "source, a column or a test (`owner`, `maturity`, `pii`). It is carried verbatim "
        "in `extras['dbt_meta']` on whichever node declared it, and no meaning is "
        "assigned to any key."
    ),
    "dbt.tag": (
        "`tags[]` labels a resource or a column with free-form keywords that dbt uses for "
        "selection (`dbt run --select tag:nightly`). The canonical model tags "
        "*operations*, not data-schema entities, so the list is carried verbatim in "
        "`extras['dbt_tags']` on whichever node declared it."
    ),
    "dbt.model_version": (
        "`versions[]` and `latest_version` declare several shapes of one model at once, "
        "each an `include`/`exclude` projection over the model's columns. The canonical "
        "model holds one shape per type, so the *latest* version's columns are the ones "
        "modelled and the version list is carried verbatim in `extras['dbt_versions']`; "
        "no per-version type is synthesized."
    ),
    "dbt.check_constraint": (
        "A `check` constraint carries a SQL expression (`total_amount >= 0`) evaluated by "
        "the warehouse. The canonical constraint vocabulary is JSON-Schema-shaped and has "
        "no expression facet, so the constraint is carried verbatim in "
        "`extras['dbt_constraints']` and is never parsed, translated or evaluated."
    ),
    "dbt.exposure": (
        "An `exposure` names a dashboard, an application or a report that *consumes* the "
        "project's models. It describes downstream use, not structure, so no canonical "
        "type is synthesized for it and the entries are carried verbatim in "
        "`extras['dbt_exposures']`."
    ),
    "dbt.metric": (
        "A `metric` composes measures into a number the semantic layer serves — `simple`, "
        "`ratio`, `derived`, with filters and offset windows. The canonical model has no "
        "aggregation vocabulary, so the entries are carried verbatim in "
        "`extras['dbt_metrics']` and no expression is parsed."
    ),
    "dbt.semantic_layer": (
        "A `semantic_model`'s entities, dimensions and measures are read as an additional "
        "layer: each becomes one canonical field so the layer is visible and diffable. "
        "What the canonical model cannot hold is what each one *means* — an entity's "
        "`primary`/`foreign` role, a dimension's `time_granularity`, a measure's `agg` and "
        "`agg_time_dimension`, an `expr` that is warehouse SQL — so the declaring block is "
        "carried verbatim on the field in `extras['dbt_semantic']`."
    ),
    "dbt.project_config": (
        "`dbt_project.yml` configures how the project is *built*: path lists, profile "
        "selection, and per-directory `+materialized`/`+schema` defaults that dbt merges "
        "onto nodes at compile time. None of it is dataset structure, and this reader "
        "does not merge it onto anything, so the file is carried verbatim in "
        "`extras['dbt_project']`."
    ),
    "dbt.model_lineage": (
        "A resource's upstream lineage — the `ref()`/`source()` calls in its SQL, or the "
        "`depends_on.nodes` a compiled manifest records for it. The canonical model has no "
        "edge vocabulary, so the resolved and unresolved upstreams are recorded on the "
        "type in `extras['dbt_depends_on']` and no canonical feature traverses them. This "
        "is the *build* lineage; the column-level edges a `relationships` test or a "
        "`foreign_key` constraint declares are `dbt.lineage_relationship`."
    ),
    "dbt.manifest_graph": (
        "A compiled manifest's own bookkeeping — `parent_map`/`child_map`, `macros`, "
        "`group_map`, `selectors`, `disabled`, and each node's `raw_code`/`compiled_code` "
        "— describes the build graph rather than the data. The lineage it states is "
        "recorded per resource in `extras['dbt_depends_on']`; the rest is carried verbatim "
        "in `extras['dbt']['manifest']` and no SQL is read."
    ),
    "dbt.declaration_order": (
        "A model's column order is physical: it is the order the relation actually "
        "presents. Canonical entities are keyed and sorted by key, so declaration order is "
        "not a canonical property; the source index is recorded on every resource and "
        "every column as `extras['dbt_position']` and the canonical ordering does not "
        "follow it."
    ),
    "dbt.undocumented_columns": (
        "A model whose properties file documents no `columns` still declares a relation — "
        "dbt reads the column list out of the compiled SQL, which this reader does not "
        "execute. The type is created with no fields, which states 'this document did not "
        "say' rather than 'this model has no columns'."
    ),
}


@dataclass(frozen=True)
class DbtLimit:
    """One declared limit the read project exercised.

    Attributes:
        construct: The stable key; always a key of :data:`LIMIT_DETAILS`.
        detail: The published sentence for ``construct``.
        count: How many occurrences were recorded.
        locations: The canonical entity keys the occurrences sit under, sorted. Empty for
            a project-level block, which has no owning entity.
    """

    construct: str
    detail: str
    count: int
    locations: Tuple[str, ...] = ()


class LimitRecorder:
    """Accumulates :class:`DbtLimit` records while a project is read.

    Recording lives here rather than inline in the normalizer so the wording, the
    de-duplication and the vocabulary check are one implementation — a construct is
    counted the same way wherever it is met.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The canonical entity key the occurrence sits under, when the
                construct belongs to one. Column-level constructs deliberately record
                their owning **resource**, not the column, so a 200-column model
                contributes one location rather than two hundred.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown dbt limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def limits(self) -> Tuple[DbtLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            DbtLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


# ---------------------------------------------------------------------------
# The document algebra
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DbtRef:
    """One ``ref()`` or ``source()`` the project states, parsed but not resolved.

    Attributes:
        kind: ``ref`` or ``source``.
        name: The model name, or the source *table* name.
        source_name: The source's name, when ``kind`` is ``source``.
        package: The package a two-argument ``ref('pkg', 'model')`` names.
        version: The version a ``ref('model', v=2)`` names, as written.
        raw: The call exactly as the document spelled it, for error messages.
    """

    kind: str
    name: str
    source_name: Optional[str] = None
    package: Optional[str] = None
    version: Optional[Any] = None
    raw: str = ""

    @property
    def target(self) -> str:
        """The resource name this ref points at — ``<source>.<table>`` for a source."""
        if self.kind == "source" and self.source_name:
            return f"{self.source_name}.{self.name}"
        return self.name


@dataclass(frozen=True)
class DbtTest:
    """One data test, from either surface.

    A properties file spells a test as a bare string (``unique``) or a single-key mapping
    (``accepted_values: {values: [...]}``); a manifest spells the same test as a node with
    ``test_metadata.name`` and ``test_metadata.kwargs``. Both land here.

    Attributes:
        name: The test name — ``unique``, ``not_null``, ``accepted_values``,
            ``relationships``, or a package-qualified name (``dbt_utils.recency``).
        column: The column the test is attached to; ``None`` for a model-level test.
        arguments: The test's arguments, verbatim (``values``, ``to``, ``field``, …).
        severity: The declared severity (``warn``/``error``), lower-cased.
        definition: The source mapping this test was read from, verbatim.
    """

    name: str
    column: Optional[str] = None
    arguments: Mapping[str, Any] = field(default_factory=dict)
    severity: Optional[str] = None
    definition: Any = None

    @property
    def is_package_test(self) -> bool:
        """Whether the test name is package-qualified (``dbt_utils.recency``)."""
        return "." in self.name


@dataclass(frozen=True)
class DbtRelationship:
    """A lineage edge this reader records, resolved against the import.

    Attributes:
        from_resource: The declaring resource's name.
        from_columns: The declaring column(s).
        to_ref: The ``ref()``/``source()`` the edge points at.
        to_columns: The target column(s) named by ``field``/``to_columns``.
        origin: ``relationships_test`` or ``foreign_key_constraint``.
    """

    from_resource: str
    from_columns: Tuple[str, ...]
    to_ref: DbtRef
    to_columns: Tuple[str, ...]
    origin: str


@dataclass(frozen=True)
class DbtColumn:
    """One column of a model, source table, seed, snapshot or semantic model.

    Attributes:
        name: The column name.
        description: The column description.
        data_type: The declared warehouse type, verbatim (``varchar(20)``).
        tests: Data tests attached to this column.
        constraints: Model-contract constraints declared on this column, verbatim.
        semantic: The entity/dimension/measure block a semantic model's member was read
            from, verbatim, with a ``role`` key naming which of the three it was.
        governance: Every remaining dbt-declared attribute of this column (``meta``,
            ``tags``, ``quote``, ``policy_tags``, …), keyed exactly as the source spelled
            it.
    """

    name: str
    description: Optional[str] = None
    data_type: Optional[str] = None
    tests: Tuple[DbtTest, ...] = ()
    constraints: Tuple[Mapping[str, Any], ...] = ()
    semantic: Mapping[str, Any] = field(default_factory=dict)
    governance: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DbtResource:
    """One resource that describes data — a model, source table, seed, snapshot or
    semantic model.

    Attributes:
        kind: One of :data:`RESOURCE_KINDS`.
        name: The resource's own name.
        key: The name canonical types are keyed by — the bare name for a model, seed or
            snapshot, ``<source>.<table>`` for a source table, ``semantic_model.<name>``
            for a semantic model.
        unique_id: The manifest ``unique_id``, when the project came from a manifest.
        source_name: The owning source's name, when ``kind`` is ``source``.
        description: The resource description.
        columns: The columns, in declaration order.
        tests: Resource-level data tests.
        constraints: Model-contract constraints declared on the resource, verbatim.
        config: The ``config`` block, verbatim.
        relation: ``database``/``schema``/``alias``/``identifier``, verbatim.
        freshness: The ``freshness`` block, verbatim, and ``loaded_at_field`` beside it.
        versions: ``versions``/``latest_version``, verbatim.
        semantic: A semantic model's ``model``/``defaults`` block, verbatim.
        depends_on: Every ``ref()``/``source()`` this resource states.
        governance: Every remaining dbt-declared attribute (``meta``, ``tags``,
            ``loader``, ``group``, ``access``, …), keyed exactly as the source spelled it.
        position: Declaration order within the import.
    """

    kind: str
    name: str
    key: str
    unique_id: Optional[str] = None
    source_name: Optional[str] = None
    description: Optional[str] = None
    columns: Tuple[DbtColumn, ...] = ()
    tests: Tuple[DbtTest, ...] = ()
    constraints: Tuple[Mapping[str, Any], ...] = ()
    config: Mapping[str, Any] = field(default_factory=dict)
    relation: Mapping[str, Any] = field(default_factory=dict)
    freshness: Mapping[str, Any] = field(default_factory=dict)
    versions: Mapping[str, Any] = field(default_factory=dict)
    semantic: Mapping[str, Any] = field(default_factory=dict)
    depends_on: Tuple[DbtRef, ...] = ()
    governance: Mapping[str, Any] = field(default_factory=dict)
    position: int = 0


@dataclass(frozen=True)
class DbtProject:
    """A read dbt project, from either surface.

    Attributes:
        surface: Which description was read — see :class:`DbtSurface`.
        name: The project's name, when one is stated (``dbt_project.yml``'s ``name``, a
            manifest's ``metadata.project_name``); otherwise the source label.
        version: The project's own release number, from ``dbt_project.yml``.
        properties_version: The properties ``version:``, when a properties file was read.
        schema_version: The manifest schema version, when a manifest was read.
        dbt_version: ``metadata.dbt_version``, when a manifest was read.
        adapter_type: ``metadata.adapter_type`` (``snowflake``), when a manifest was read.
        generated_at: ``metadata.generated_at``, when a manifest was read.
        resources: Every resource that describes data, in declaration order.
        relationships: The lineage edges this reader records, already resolved.
        unresolved: ``ref()``/``source()`` calls that name nothing in the import, as
            ``(declaring resource, ref)`` pairs.
        exposures: ``exposures[]``, verbatim.
        metrics: ``metrics[]``, verbatim.
        project_config: The ``dbt_project.yml`` mapping, verbatim.
        manifest_graph: A manifest's own bookkeeping (``parent_map``, ``child_map``,
            ``macros`` counts, …), summarized.
        governance: Remaining top-level keys, verbatim.
        fileset: What a multi-file import composed. Empty for a single document.
        raw: The source text, retained for the fidelity bag.
    """

    surface: str
    name: str
    version: Optional[str] = None
    properties_version: Optional[int] = None
    schema_version: Optional[int] = None
    dbt_version: Optional[str] = None
    adapter_type: Optional[str] = None
    generated_at: Optional[str] = None
    resources: Tuple[DbtResource, ...] = ()
    relationships: Tuple[DbtRelationship, ...] = ()
    unresolved: Tuple[Tuple[str, DbtRef], ...] = ()
    exposures: Tuple[Mapping[str, Any], ...] = ()
    metrics: Tuple[Mapping[str, Any], ...] = ()
    project_config: Mapping[str, Any] = field(default_factory=dict)
    manifest_graph: Mapping[str, Any] = field(default_factory=dict)
    governance: Mapping[str, Any] = field(default_factory=dict)
    fileset: Mapping[str, Any] = field(default_factory=dict)
    raw: str = ""
