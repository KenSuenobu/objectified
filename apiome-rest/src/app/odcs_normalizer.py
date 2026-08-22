"""ODCS → canonical model normalizer — FMT-5.1 (#5439).

Projects a parsed :class:`~app.odcs_contract.OdcsContract` onto a
:class:`~app.canonical_model.CanonicalApi` with paradigm
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA`.

The projection
==============

* Each ``schema[]`` object becomes one canonical ``RECORD`` :class:`Type`, keyed by
  its ``name``.
* Each property becomes one :class:`CanonicalField` on that type; ``required: false``
  is ``nullable``. A property typed ``object`` with nested ``properties`` becomes a
  synthesized ``RECORD`` keyed ``<owner>.<property>``; one typed ``array`` becomes a
  list :class:`TypeRef` around its ``items`` type, synthesizing a record for an array
  of objects. Everything else is a scalar named by its ``logicalType``.
* ``logicalTypeOptions`` — the portable half of ODCS's typing — becomes
  :class:`Constraints`: lengths, numeric bounds, ``pattern``, ``enum``, and ``format``
  when the declared value is a format token the canonical vocabulary knows.

The extras namespace
====================

ODCS's governance half — quality, ownership, SLAs, servers, support, price — has no
canonical home, so it is **carried verbatim** under a documented key namespace. FMT-5.2
writes the same keys back, which is the ``extras`` ↔ emitter symmetry rule: adding a
key here without teaching that emitter is what breaks the round-trip matrix.

Every carried key is prefixed ``odcs_`` and holds the *source mapping unmodified*:

===============================  ======  =====================================================
Key                              Node    Carries
===============================  ======  =====================================================
``odcs``                         root    Reader bookkeeping: ``api_version``, ``status``,
                                         ``contract_id``, ``domain``, ``tenant``,
                                         ``data_product``, ``schema_objects``,
                                         ``capability_limits``, ``fileset``.
``odcs_description``             root    The ``description`` block (``purpose`` also becomes
                                         the canonical description).
``odcs_servers``                 root    ``servers[]``.
``odcs_team`` / ``odcs_roles``   root    ``team[]`` / ``roles[]``.
``odcs_support``                 root    ``support[]``.
``odcs_sla_properties``          root    ``slaProperties[]``.
``odcs_sla_default_element``     root    ``slaDefaultElement``.
``odcs_price``                   root    ``price``.
``odcs_tags``                    any     ``tags[]``.
``odcs_custom_properties``       any     ``customProperties[]``.
``odcs_quality``                 any     ``quality[]``, verbatim, per node.
``odcs_authoritative_defs``      any     ``authoritativeDefinitions[]``.
``odcs_position``                type,   Declaration order, because canonical ordering sorts
                                 field   by key and a dataset's column order is physical.
``odcs_logical_type``            field   ``logicalType``.
``odcs_physical_type``           any     ``physicalType``.
``odcs_physical_name``           any     ``physicalName``.
``odcs_logical_type_options``    field   ``logicalTypeOptions``.
``odcs_examples``                field   ``examples[]``.
``odcs_transform``               field   ``transformSourceObjects`` / ``transformLogic`` /
                                         ``transformDescription``.
``odcs_encrypted_name``          field   ``encryptedName``.
``odcs_key``                     field   ``primaryKey`` / ``primaryKeyPosition`` / ``unique``.
``odcs_partition``               field   ``partitioned`` / ``partitionKeyPosition``.
``odcs_classification``          field   ``classification``.
``odcs_critical_data_element``   field   ``criticalDataElement``.
``odcs_data_granularity``        type    ``dataGranularityDescription``.
``odcs_extra``                   any     Any remaining ODCS key the reader does not name —
                                         the standard's forward-compatibility slot.
===============================  ======  =====================================================

Only ``odcs`` is the reader's own bookkeeping; it is therefore the single key listed in
:data:`app.import_preview_manifest.PROVENANCE_EXTRA_KEYS`. Every other key is a *source*
construct the canonical model does not hold, so it is reported as partially-mapped
coverage — which is exactly what "carried but not modelled" should look like to
somebody reading the catalog detail view.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

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
from .normalizer import Keys, Normalizer, normalize_ordering
from .odcs_contract import (
    LimitRecorder,
    OdcsContract,
    OdcsProperty,
    OdcsQualityRule,
    OdcsSchemaObject,
)

__all__ = [
    "ODCS_EXTRAS_KEY",
    "ODCS_LOGICAL_SCALARS",
    "OdcsNormalizer",
]

_FORMAT_KEY = "odcs"

#: The root extras key holding the reader's own projection record.
ODCS_EXTRAS_KEY = "odcs"

#: ODCS ``logicalType`` → canonical scalar name. The v3 vocabulary is closed and maps
#: one-for-one onto names :data:`app.canonical_json_schema.CANONICAL_SCALAR_SCHEMAS`
#: already knows, so no spelling is invented here. ``object`` and ``array`` are
#: structural and handled before this map is consulted.
ODCS_LOGICAL_SCALARS: Dict[str, str] = {
    "string": "string",
    "date": "date",
    "number": "number",
    "integer": "integer",
    "boolean": "boolean",
}

#: The canonical scalar a property with no (or an unknown) ``logicalType`` takes. ODCS
#: makes ``logicalType`` optional, and guessing from ``physicalType`` would mean
#: parsing a dialect-specific spelling — the very thing ``odcs.physical_type``
#: declares this reader does not do.
_UNTYPED_SCALAR = "string"

#: ``logicalTypeOptions.format`` values that are canonical format tokens rather than
#: free-form pattern strings. ODCS lets ``format`` hold either — ``uuid`` beside
#: ``yyyy-MM-dd'T'HH:mm:ssX`` — and only the tokens mean the same thing to every
#: consumer, so only they reach :attr:`Constraints.format`. The rest stay in
#: ``odcs_logical_type_options``, where they are still exact.
_FORMAT_TOKENS = frozenset(
    {
        "date",
        "date-time",
        "decimal",
        "duration",
        "email",
        "hostname",
        "ipv4",
        "ipv6",
        "time",
        "uri",
        "url",
        "uuid",
    }
)

#: ``logicalTypeOptions`` key → the :class:`Constraints` field it sets and the value type
#: that field accepts. ODCS models these on JSON Schema, so the mapping is a rename — but
#: the *type check* is load-bearing: nothing validates a contract's option values before
#: they arrive, and handing pydantic a string where it wants an ``int`` raises a
#: ``ValidationError`` the import pipeline does not catch, which would surface as a 5xx
#: rather than as a rejection. An option whose value is the wrong shape is skipped here and
#: still survives, exactly as written, in ``odcs_logical_type_options``.
_OPTION_CONSTRAINTS: Dict[str, Tuple[str, type]] = {
    "minLength": ("min_length", int),
    "maxLength": ("max_length", int),
    "pattern": ("pattern", str),
    "minimum": ("minimum", float),
    "maximum": ("maximum", float),
    "exclusiveMinimum": ("exclusive_minimum", float),
    "exclusiveMaximum": ("exclusive_maximum", float),
    "multipleOf": ("multiple_of", float),
    "minItems": ("min_items", int),
    "maxItems": ("max_items", int),
    "uniqueItems": ("unique_items", bool),
}

#: Governance keys lifted onto their own extras key, with the limit each one declares.
#: ``None`` means "carried, but not itself a declared limit" — the key is only a
#: rename of something the canonical model does hold elsewhere.
_FIELD_GOVERNANCE: Tuple[Tuple[str, str, Optional[str]], ...] = (
    ("classification", "odcs_classification", "odcs.classification"),
    ("criticalDataElement", "odcs_critical_data_element", "odcs.classification"),
    ("encryptedName", "odcs_encrypted_name", "odcs.transform_metadata"),
)

#: ``customProperties`` and ``tags`` appear on every ODCS node, so they are lifted the
#: same way wherever they appear.
_SHARED_GOVERNANCE: Tuple[Tuple[str, str, str], ...] = (
    ("tags", "odcs_tags", "odcs.tag"),
    ("customProperties", "odcs_custom_properties", "odcs.custom_property"),
    ("authoritativeDefinitions", "odcs_authoritative_defs", "odcs.authoritative_definition"),
)

#: Contract-level governance blocks: source key → extras key → declared limit.
_CONTRACT_GOVERNANCE: Tuple[Tuple[str, str, str], ...] = (
    ("servers", "odcs_servers", "odcs.server"),
    ("team", "odcs_team", "odcs.team_role"),
    ("roles", "odcs_roles", "odcs.team_role"),
    ("support", "odcs_support", "odcs.support_channel"),
    ("slaProperties", "odcs_sla_properties", "odcs.sla_property"),
    ("slaDefaultElement", "odcs_sla_default_element", "odcs.sla_property"),
    ("price", "odcs_price", "odcs.price"),
)

#: Field transform/lineage keys folded into one ``odcs_transform`` mapping.
_TRANSFORM_KEYS = ("transformSourceObjects", "transformLogic", "transformDescription")


def _quality_payload(rules: Sequence[OdcsQualityRule]) -> List[Dict[str, Any]]:
    """Render quality rules for the extras bag, verbatim.

    Args:
        rules: The parsed rules.

    Returns:
        One dict per rule, exactly as the source spelled it.
    """
    return [dict(rule.definition) for rule in rules]


def _has_type(value: Any, expected: type) -> bool:
    """Whether ``value`` is safe to hand to the :class:`Constraints` field of ``expected``.

    ``bool`` is a subclass of ``int`` in Python, so ``uniqueItems: true`` would otherwise
    satisfy an ``int`` facet and ``minLength: true`` would become a length of 1.

    Args:
        value: The declared option value.
        expected: The type the constraint field accepts (``bool`` accepts only a bool,
            ``float`` accepts any non-bool number, ``int`` only a non-bool integer).

    Returns:
        ``True`` when the value can be used as-is.
    """
    if expected is bool:
        return isinstance(value, bool)
    if isinstance(value, bool):
        return False
    if expected is float:
        return isinstance(value, (int, float))
    return isinstance(value, expected)


def _constraints_for(property_: OdcsProperty) -> Optional[Constraints]:
    """Build the canonical constraints a property's ``logicalTypeOptions`` state.

    Args:
        property_: The parsed property.

    Returns:
        The constraints, or ``None`` when the property declares none that map.
    """
    options = property_.logical_type_options
    values: Dict[str, Any] = {}
    for source_key, (target, expected) in _OPTION_CONSTRAINTS.items():
        if source_key in options and _has_type(options[source_key], expected):
            values[target] = options[source_key]
    declared_enum = options.get("enum")
    if isinstance(declared_enum, Sequence) and not isinstance(declared_enum, (str, bytes)):
        values["enum"] = list(declared_enum)
    declared_format = options.get("format")
    if isinstance(declared_format, str) and declared_format.strip().lower() in _FORMAT_TOKENS:
        values["format"] = declared_format.strip().lower()
    return Constraints(**values) if values else None


class _TypeGraph:
    """Builds the canonical types one contract projects onto.

    A schema object is one record; a nested ``object`` property and an ``array`` of
    objects each synthesize one more, keyed by their path so two properties named
    ``address`` under different objects cannot collide.
    """

    def __init__(self, contract: OdcsContract) -> None:
        self._contract = contract
        self._limits = LimitRecorder()
        self._types: List[Type] = []

    @property
    def limits(self) -> LimitRecorder:
        """The limit recorder this build populated."""
        return self._limits

    def build(self) -> List[Type]:
        """Project every schema object, and everything nested under it, onto types.

        Returns:
            The canonical types, in declaration order (canonical ordering re-sorts
            them by key; ``odcs_position`` preserves what the source declared).
        """
        for position, obj in enumerate(self._contract.schema_objects):
            self._object_type(obj, position=position)
        return self._types

    # -- schema objects ----------------------------------------------------

    def _object_type(self, obj: OdcsSchemaObject, *, position: int) -> None:
        """Project one ``schema[]`` object onto a record type."""
        key = Keys.type(obj.name)
        extras: Dict[str, Any] = {"odcs_position": position}
        # Recorded once per schema object rather than once per property: the limit is that
        # canonical ordering does not follow the source, and a 200-column table states that
        # fact once.
        self._limits.record("odcs.declaration_order", location=key)
        if obj.physical_name:
            extras["odcs_physical_name"] = obj.physical_name
            self._limits.record("odcs.physical_type", location=key)
        if obj.physical_type:
            extras["odcs_physical_type"] = obj.physical_type
            self._limits.record("odcs.physical_type", location=key)
        governance = dict(obj.governance)
        granularity = governance.pop("dataGranularityDescription", None)
        if granularity is not None:
            extras["odcs_data_granularity"] = granularity
        self._carry_shared(governance, extras, location=key)
        self._carry_quality(obj.quality, extras, location=key)
        if governance:
            extras["odcs_extra"] = governance

        self._types.append(
            Type(
                key=key,
                name=obj.name,
                kind=TypeKind.RECORD,
                description=obj.description,
                fields=[
                    self._field(prop, owner=key, position=index)
                    for index, prop in enumerate(obj.properties)
                ],
                extras=extras,
            )
        )

    # -- properties --------------------------------------------------------

    def _field(self, prop: OdcsProperty, *, owner: str, position: int) -> CanonicalField:
        """Project one property onto a canonical field of ``owner``."""
        key = Keys.field(owner, prop.name)
        extras: Dict[str, Any] = {"odcs_position": position}
        if prop.logical_type:
            extras["odcs_logical_type"] = prop.logical_type
        if prop.physical_type:
            extras["odcs_physical_type"] = prop.physical_type
            self._limits.record("odcs.physical_type", location=owner)
        if prop.physical_name:
            extras["odcs_physical_name"] = prop.physical_name
        if prop.logical_type_options:
            extras["odcs_logical_type_options"] = dict(prop.logical_type_options)
        if prop.examples:
            extras["odcs_examples"] = list(prop.examples)

        governance = dict(prop.governance)
        self._carry_key_and_partition(governance, extras, location=owner)
        self._carry_transform(governance, extras, location=owner)
        for source_key, extras_key, limit in _FIELD_GOVERNANCE:
            if source_key in governance:
                extras[extras_key] = governance.pop(source_key)
                if limit:
                    self._limits.record(limit, location=owner)
        self._carry_shared(governance, extras, location=owner)
        self._carry_quality(prop.quality, extras, location=owner)
        if governance:
            extras["odcs_extra"] = governance

        return CanonicalField(
            key=key,
            name=prop.name,
            type=self._type_ref(prop, owner=owner, nullable=not prop.required),
            description=prop.description,
            constraints=_constraints_for(prop),
            extras=extras,
        )

    def _type_ref(self, prop: OdcsProperty, *, owner: str, nullable: bool) -> TypeRef:
        """Build the type reference a property's ``logicalType`` names.

        A nested ``object`` and an ``array`` of objects each synthesize a record type
        as a side effect; a scalar names its canonical spelling directly.
        """
        logical = prop.logical_type
        if logical == "array":
            element = prop.items
            if element is None:
                # An array with no `items` states that the column is repeated and
                # nothing about what it repeats.
                return TypeRef(item=TypeRef(name=_UNTYPED_SCALAR), nullable=nullable)
            inner = self._type_ref(element, owner=f"{owner}.{prop.name}", nullable=True)
            return TypeRef(item=inner, nullable=nullable)
        if logical == "object":
            nested_key = f"{owner}.{prop.name}"
            if not prop.properties:
                self._limits.record("odcs.free_form_object", location=owner)
            self._nested_type(prop, key=nested_key)
            return TypeRef(name=nested_key, nullable=nullable)
        return TypeRef(name=ODCS_LOGICAL_SCALARS.get(logical or "", _UNTYPED_SCALAR), nullable=nullable)

    def _nested_type(self, prop: OdcsProperty, *, key: str) -> None:
        """Synthesize the record type a nested ``object`` property describes."""
        if any(existing.key == key for existing in self._types):
            # Two properties cannot share a name under one owner (the parser refuses it),
            # so this only guards against a future caller reusing a key.
            return
        extras: Dict[str, Any] = {}
        if prop.physical_type:
            extras["odcs_physical_type"] = prop.physical_type
        self._types.append(
            Type(
                key=key,
                name=prop.name,
                kind=TypeKind.RECORD,
                description=prop.description,
                fields=[
                    self._field(child, owner=key, position=index)
                    for index, child in enumerate(prop.properties)
                ],
                extras=extras,
            )
        )

    # -- shared carriers ---------------------------------------------------

    def _carry_shared(
        self, governance: Dict[str, Any], extras: Dict[str, Any], *, location: str
    ) -> None:
        """Lift ``tags``/``customProperties``/``authoritativeDefinitions`` onto extras."""
        for source_key, extras_key, limit in _SHARED_GOVERNANCE:
            if source_key in governance:
                extras[extras_key] = governance.pop(source_key)
                self._limits.record(limit, location=location)

    def _carry_quality(
        self, rules: Sequence[OdcsQualityRule], extras: Dict[str, Any], *, location: str
    ) -> None:
        """Carry a node's quality rules verbatim, one declared limit per rule."""
        if not rules:
            return
        extras["odcs_quality"] = _quality_payload(rules)
        for _ in rules:
            self._limits.record("odcs.quality_rule", location=location)

    def _carry_key_and_partition(
        self, governance: Dict[str, Any], extras: Dict[str, Any], *, location: str
    ) -> None:
        """Lift identity and physical-layout declarations onto their own extras keys."""
        identity = {
            source: governance.pop(source)
            for source in ("primaryKey", "primaryKeyPosition", "unique")
            if source in governance
        }
        if identity:
            extras["odcs_key"] = identity
            self._limits.record("odcs.key_uniqueness", location=location)
        partition = {
            source: governance.pop(source)
            for source in ("partitioned", "partitionKeyPosition")
            if source in governance
        }
        if partition:
            extras["odcs_partition"] = partition
            self._limits.record("odcs.partitioning", location=location)

    def _carry_transform(
        self, governance: Dict[str, Any], extras: Dict[str, Any], *, location: str
    ) -> None:
        """Lift the transform/lineage declarations into one ``odcs_transform`` mapping."""
        transform = {
            source: governance.pop(source) for source in _TRANSFORM_KEYS if source in governance
        }
        if transform:
            extras["odcs_transform"] = transform
            self._limits.record("odcs.transform_metadata", location=location)


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


def _root_extras(contract: OdcsContract, recorder: LimitRecorder) -> Dict[str, Any]:
    """Build the contract-level extras: the projection record plus the carried blocks.

    Args:
        contract: The parsed contract.
        recorder: The limit recorder the type build populated; contract-level blocks
            record their own limits into it here.

    Returns:
        The root ``extras`` mapping.
    """
    extras: Dict[str, Any] = {}
    governance = dict(contract.governance)
    for source_key, extras_key, limit in _CONTRACT_GOVERNANCE:
        if source_key in governance:
            extras[extras_key] = governance.pop(source_key)
            recorder.record(limit)
    for source_key, extras_key, limit in _SHARED_GOVERNANCE:
        if source_key in governance:
            extras[extras_key] = governance.pop(source_key)
            recorder.record(limit)
    contract_quality = governance.pop("quality", None)
    if contract_quality is not None:
        extras["odcs_quality"] = contract_quality
        occurrences = len(contract_quality) if isinstance(contract_quality, list) else 1
        for _ in range(max(occurrences, 1)):
            recorder.record("odcs.quality_rule")
    if contract.description:
        extras["odcs_description"] = dict(contract.description)
    if governance:
        extras["odcs_extra"] = governance

    # The projection record last, so it can carry the limits every carrier above fed.
    record: Dict[str, Any] = {
        "api_version": contract.api_version.raw,
        "schema_objects": [obj.name for obj in contract.schema_objects],
        "capability_limits": _limits_payload(recorder),
    }
    for label, value in (
        ("contract_id", contract.contract_id),
        ("status", contract.status),
        ("domain", contract.domain),
        ("tenant", contract.tenant),
        ("data_product", contract.data_product),
    ):
        if value is not None:
            record[label] = value
    if contract.fileset:
        record["fileset"] = dict(contract.fileset)
    extras[ODCS_EXTRAS_KEY] = record
    return extras


class OdcsNormalizer(Normalizer, register=True):
    """Normalize a parsed ODCS data contract into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Project an :class:`~app.odcs_contract.OdcsContract` onto the canonical model.

        Args:
            source: The parsed contract.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model: one ``data_schema`` document whose types are the
            contract's schema objects and whose governance survives in ``extras``.

        Raises:
            ValueError: If ``source`` is not a parsed ODCS contract.
        """
        if not isinstance(source, OdcsContract):
            raise ValueError(
                "ODCS source must be an OdcsContract (see app.odcs_parser.parse_odcs)"
            )

        graph = _TypeGraph(source)
        types = graph.build()
        extras = _root_extras(source, graph.limits)
        purpose = source.description.get("purpose") if source.description else None

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(
                name=source.name,
                namespace=source.domain,
                id=source.contract_id,
            ),
            version=source.version,
            title=source.name,
            description=purpose.strip() if isinstance(purpose, str) and purpose.strip() else None,
            types=types,
            raw={"odcs": source.raw} if include_raw else None,
            extras=extras,
        )
        return normalize_ordering(api)
