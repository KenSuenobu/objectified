"""ODCS emitter: canonical model → Open Data Contract Standard v3 — FMT-5.2 (#5440).

The inverse of :mod:`app.odcs_normalizer`. Point it at anything the catalog holds —
an Avro schema, a COBOL copybook, an OpenAPI response body, or a data contract that
came in through the ODCS reader — and it writes a governed, versioned ODCS contract.

Two halves, written by two different rules
==========================================

FMT-5.1 established that a data contract has a *structural* half and a *governance*
half, and that they land differently on the way in. They are written back by the same
split:

* **The structural half is built.** Canonical types become ``schema[]`` objects, their
  fields become ``properties[]``, nullability becomes ``required``, a record-valued
  field becomes a nested ``logicalType: object``, a list becomes ``logicalType: array``
  with an ``items`` block, and canonical :class:`~app.canonical_model.Constraints`
  become ``logicalTypeOptions``. This emitter *owns* the validity of everything here:
  the option keys are filtered against what the standard admits beside the emitted
  ``logicalType`` (see :mod:`app.odcs_schema`), and a facet with no ODCS spelling —
  ``enum`` is the only one — is dropped and reported rather than written illegally.

* **The governance half is carried back verbatim.** Every ``odcs_*`` extras key the
  reader parked is written to the ODCS key it came from, byte for byte, with no
  re-spelling in either direction. That is the ``extras`` ↔ emitter symmetry rule:
  the reader's namespace table (:mod:`app.odcs_normalizer`) and :data:`ROOT_CARRIERS`
  / :data:`OBJECT_CARRIERS` / :data:`PROPERTY_CARRIERS` /
  :data:`PROPERTY_GROUP_CARRIERS` here are the two sides of one contract, and
  ``test_every_documented_extras_key_is_either_structural_or_carried_back`` fails if a
  key exists on one side and not the other.

Nothing is invented
===================

ODCS has an ownership block, an SLA block, a quality block, a support block and a
price. Apiome cannot source any of them from a schema, and a **fabricated owner is
worse than an absent one** — an on-call rota nobody agreed to is a governance lie. So
each is written only when the model carries it, and its absence is reported as a
``SYNTH`` finding on the artifact root whose message says the field was left absent.
The only values this emitter supplies without a source are the three the standard
*requires* and a document cannot exist without — ``id``, ``version`` and ``status`` —
and each of those is reported too: derived ones as ``INFERRED`` provenance,
fabricated ones (``1.0.0``, ``draft``) as ``SYNTH``.

``quality`` comes from the source's carried rules. The data-contract lint pack
(FMT-5.5, #5443) is the other intended source and does not exist yet; when it does,
its findings become quality rules here rather than anywhere else.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple, Union

import yaml
from pydantic import Field, field_validator

from .canonical_json_schema import CANONICAL_SCALAR_SCHEMAS
from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Server,
    Type,
    TypeKind,
    TypeRef,
)
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitOptionsError,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict
from .lossiness import LossinessSeverity
from .odcs_normalizer import ODCS_EXTRAS_KEY
from .odcs_schema import (
    DEFAULT_ODCS_API_VERSION,
    ODCS_LOGICAL_TYPES,
    ODCS_SCHEMA_RELEASES,
    option_value_is_admitted,
    schema_line_for,
    validate_odcs_document,
)

__all__ = [
    "OBJECT_CARRIERS",
    "PROPERTY_CARRIERS",
    "ROOT_CARRIERS",
    "OdcsEmitOptions",
    "OdcsEmitter",
    "OdcsFidelityRulePack",
    "validate_odcs_document",
]

#: The ``kind`` every ODCS document declares — the format's only legal value.
ODCS_KIND_VALUE = "DataContract"

#: The ``version`` written when the model states none. ODCS requires one, so this is a
#: fabrication and is reported as such; it is not a guess at the dataset's real version.
FALLBACK_CONTRACT_VERSION = "1.0.0"

#: The ``status`` written when nothing sourced one. Reported as a fabrication for the
#: same reason: a contract with no declared lifecycle is a draft by default, and
#: claiming ``active`` for a dataset nobody promised to serve would be the lie.
FALLBACK_CONTRACT_STATUS = "draft"


# ===========================================================================
# The extras ↔ ODCS key tables (the symmetry rule, written once per node level)
# ===========================================================================

#: Contract-level extras key → the ODCS key it came from. The inverse of
#: :mod:`app.odcs_normalizer`'s ``_CONTRACT_GOVERNANCE`` / ``_SHARED_GOVERNANCE``
#: carriers plus the description block and contract-level quality.
ROOT_CARRIERS: Tuple[Tuple[str, str], ...] = (
    ("odcs_description", "description"),
    ("odcs_quality", "quality"),
    ("odcs_servers", "servers"),
    ("odcs_team", "team"),
    ("odcs_roles", "roles"),
    ("odcs_support", "support"),
    ("odcs_sla_default_element", "slaDefaultElement"),
    ("odcs_sla_properties", "slaProperties"),
    ("odcs_price", "price"),
    ("odcs_tags", "tags"),
    ("odcs_custom_properties", "customProperties"),
    ("odcs_authoritative_defs", "authoritativeDefinitions"),
)

#: Schema-object-level extras key → the ODCS key it came from.
OBJECT_CARRIERS: Tuple[Tuple[str, str], ...] = (
    ("odcs_physical_name", "physicalName"),
    ("odcs_physical_type", "physicalType"),
    ("odcs_data_granularity", "dataGranularityDescription"),
    ("odcs_quality", "quality"),
    ("odcs_tags", "tags"),
    ("odcs_custom_properties", "customProperties"),
    ("odcs_authoritative_defs", "authoritativeDefinitions"),
)

#: Property-level extras key → the ODCS key it came from. ``odcs_logical_type`` and
#: ``odcs_logical_type_options`` are absent here on purpose: both take part in the
#: *structural* build (the logical type decides which options are legal), so they are
#: applied by :meth:`_OdcsWriter._property` rather than copied blindly.
PROPERTY_CARRIERS: Tuple[Tuple[str, str], ...] = (
    ("odcs_physical_type", "physicalType"),
    ("odcs_physical_name", "physicalName"),
    ("odcs_classification", "classification"),
    ("odcs_critical_data_element", "criticalDataElement"),
    ("odcs_encrypted_name", "encryptedName"),
    ("odcs_examples", "examples"),
    ("odcs_quality", "quality"),
    ("odcs_tags", "tags"),
    ("odcs_custom_properties", "customProperties"),
    ("odcs_authoritative_defs", "authoritativeDefinitions"),
)

#: Property-level extras keys holding a *mapping* whose entries are spread back onto
#: the property as individual ODCS keys, exactly as the reader collected them.
PROPERTY_GROUP_CARRIERS: Tuple[str, ...] = (
    "odcs_key",
    "odcs_partition",
    "odcs_transform",
)

#: Extras keys that take part in the structural build or are the reader's own
#: bookkeeping, and are therefore never copied straight onto an emitted node.
STRUCTURAL_EXTRAS_KEYS: frozenset = frozenset(
    {
        ODCS_EXTRAS_KEY,
        "odcs_position",
        "odcs_logical_type",
        "odcs_logical_type_options",
        "odcs_extra",
    }
)

#: Key order for the emitted document root. ODCS publishes its contracts envelope-first
#: (what the file is, then what it identifies, then what it describes), and a stable
#: order is what makes two emissions of one model byte-identical.
_ROOT_ORDER: Tuple[str, ...] = (
    "apiVersion",
    "kind",
    "id",
    "name",
    "version",
    "status",
    "domain",
    "tenant",
    "dataProduct",
    "description",
    "schema",
    "quality",
    "servers",
    "team",
    "roles",
    "support",
    "slaDefaultElement",
    "slaProperties",
    "price",
    "tags",
    "customProperties",
    "authoritativeDefinitions",
)

#: Key order for one ``schema[]`` object.
_OBJECT_ORDER: Tuple[str, ...] = (
    "name",
    "physicalName",
    "logicalType",
    "physicalType",
    "description",
    "dataGranularityDescription",
    "properties",
    "quality",
    "tags",
    "customProperties",
    "authoritativeDefinitions",
)

#: Key order for one property (and for an array's ``items`` block).
_PROPERTY_ORDER: Tuple[str, ...] = (
    "name",
    "logicalType",
    "logicalTypeOptions",
    "physicalType",
    "physicalName",
    "description",
    "required",
    "unique",
    "primaryKey",
    "primaryKeyPosition",
    "partitioned",
    "partitionKeyPosition",
    "classification",
    "criticalDataElement",
    "encryptedName",
    "transformSourceObjects",
    "transformLogic",
    "transformDescription",
    "examples",
    "properties",
    "items",
    "quality",
    "tags",
    "customProperties",
    "authoritativeDefinitions",
)

#: Canonical :class:`~app.canonical_model.Constraints` field → the ``logicalTypeOptions``
#: key that states it. The exact inverse of :mod:`app.odcs_normalizer`'s
#: ``_OPTION_CONSTRAINTS``, minus ``enum``: ODCS has no enumeration facet in any v3
#: line, so a canonical enum has nowhere legal to go and is reported instead.
_CONSTRAINT_OPTIONS: Tuple[Tuple[str, str], ...] = (
    ("min_length", "minLength"),
    ("max_length", "maxLength"),
    ("pattern", "pattern"),
    ("minimum", "minimum"),
    ("maximum", "maximum"),
    ("exclusive_minimum", "exclusiveMinimum"),
    ("exclusive_maximum", "exclusiveMaximum"),
    ("multiple_of", "multipleOf"),
    ("min_items", "minItems"),
    ("max_items", "maxItems"),
    ("unique_items", "uniqueItems"),
    ("format", "format"),
)

#: Canonical scalar names that mean "any JSON value", mirroring
#: :mod:`app.canonical_json_schema`. They become a free-form ``logicalType: object``.
_ANY_SCALARS: frozenset = frozenset(
    {"any", "object", "json", "map", "value", "unknown", "variant"}
)

#: JSON-Schema ``(type, format)`` → the preferred ODCS ``logicalType``, most specific
#: first. Consulted against :data:`app.odcs_schema.ODCS_LOGICAL_TYPES` for the emitted
#: line, so a v3.0 contract — whose vocabulary has no ``timestamp`` — falls back to the
#: next spelling rather than writing a type that line does not admit.
_JSON_TYPE_LOGICAL_TYPES: Dict[str, Tuple[str, ...]] = {
    "string": ("string",),
    "integer": ("integer",),
    "number": ("number",),
    "boolean": ("boolean",),
    "null": ("string",),
}
_JSON_FORMAT_LOGICAL_TYPES: Dict[str, Tuple[str, ...]] = {
    "date": ("date",),
    "date-time": ("timestamp", "date"),
    "time": ("time", "string"),
}

#: The ODCS logical type a scalar this fleet does not name falls back to. A contract
#: that says nothing about a column's type is less useful than one that says "text",
#: and every serialization can carry text.
_FALLBACK_LOGICAL_TYPE = "string"

#: Logical types whose ``logicalTypeOptions.format`` is a **date pattern**
#: (``yyyy-MM-dd``), not a semantic token. A canonical ``format`` is a token, so it is
#: never derived into this slot — the logical type already says the column is a date,
#: and writing ``date-time`` there would claim a JDK pattern nobody can parse. A
#: pattern carried verbatim from an imported contract is untouched.
_DATE_FAMILY_LOGICAL_TYPES: frozenset = frozenset({"date", "timestamp", "time"})

#: JSON-Schema numeric format → the ODCS spelling of the same width. ODCS closes
#: ``format`` on numeric columns to the Rust type names, so the canonical token has to
#: be translated rather than copied; a width with no ODCS spelling is dropped and
#: reported by the normal option filter.
_NUMERIC_FORMAT_TOKENS: Dict[str, str] = {
    "int32": "i32",
    "int64": "i64",
    "float": "f32",
    "double": "f64",
}

#: Characters allowed in the emitted file's base name.
_PATH_UNSAFE = re.compile(r"[^\w.-]+")

#: Characters allowed in a derived contract ``id``.
_ID_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def _canonical_logical_type(scalar: Optional[str], line: str) -> Tuple[str, Optional[str]]:
    """Return the ODCS ``logicalType`` (and format hint) for a canonical scalar name.

    Derived from :data:`app.canonical_json_schema.CANONICAL_SCALAR_SCHEMAS` rather than
    from a second scalar table, so a spelling the fleet adds there is understood here
    without an edit. The JSON-Schema fragment a scalar projects to already states its
    type and its semantic shape; this reads both off it.

    Args:
        scalar: The canonical scalar name (``uuid``, ``int64``, ``timestamp``, …), or
            ``None`` for an unnamed reference.
        line: The schema line being emitted (see :data:`ODCS_SCHEMA_RELEASES`).

    Returns:
        ``(logical_type, format_hint)``. The format hint is the JSON-Schema ``format``
        the scalar carries when the emitted logical type does not already say it
        (``uuid`` on a ``string``); ``None`` otherwise.
    """
    admitted = ODCS_LOGICAL_TYPES[line]
    fragment = CANONICAL_SCALAR_SCHEMAS.get((scalar or "").strip().lower())
    if fragment is None:
        return _FALLBACK_LOGICAL_TYPE, None
    declared_format = fragment.get("format")
    candidates: Tuple[str, ...] = ()
    if isinstance(declared_format, str):
        candidates = _JSON_FORMAT_LOGICAL_TYPES.get(declared_format, ())
    for candidate in candidates:
        if candidate in admitted:
            # A date/time logical type says the shape itself; the format hint would
            # only repeat it (and ODCS reads `format` there as a date *pattern*).
            return candidate, None
    for candidate in _JSON_TYPE_LOGICAL_TYPES.get(str(fragment.get("type")), ()):
        if candidate in admitted:
            hint = declared_format if isinstance(declared_format, str) else None
            return candidate, hint
    return _FALLBACK_LOGICAL_TYPE, None


def _odcs_format(token: Optional[str], logical_type: str) -> Optional[str]:
    """Return the ``logicalTypeOptions.format`` spelling for a canonical format token.

    Args:
        token: The canonical / JSON-Schema format token (``uuid``, ``int64``, …).
        logical_type: The ODCS logical type the option will sit beside.

    Returns:
        The value to write, or ``None`` when the token has no place in this slot —
        either because the slot is a date *pattern* rather than a semantic token, or
        because there is no token to translate.
    """
    if not token or logical_type in _DATE_FAMILY_LOGICAL_TYPES:
        return None
    return _NUMERIC_FORMAT_TOKENS.get(token, token)


def _ordered(node: Dict[str, Any], order: Sequence[str]) -> Dict[str, Any]:
    """Return ``node`` with its keys in ``order``, then everything else alphabetically.

    Determinism is a hard requirement of the emitter SPI: two emissions of one model
    must compare equal byte for byte. Carried governance arrives in whatever order the
    source spelled it, and a forward-compatibility key the reader did not name can
    arrive at any level, so the ordering is applied once, here, rather than trusted to
    insertion order at a dozen call sites.

    Args:
        node: The assembled mapping.
        order: The keys to place first, in the order they should appear.

    Returns:
        A new mapping in the stable order.
    """
    ranked = {key: index for index, key in enumerate(order)}
    return {
        key: node[key]
        for key in sorted(node, key=lambda name: (ranked.get(name, len(order)), name))
    }


class OdcsFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for ODCS export.

    Refines the capability-derived defaults in the three places a data contract
    differs from a generic schema target: it is types-only, it can state validation
    facets but has no enumeration facet, and its governance blocks are *required
    slots this service cannot fill* — which is a reportable absence, not a drop.
    """

    target_label = "ODCS"

    #: Contract-level extras key → the sentence reported when the model carries none.
    #: These are the blocks an ODCS contract exists to hold; a schema-only source has
    #: none of them, and the report says so instead of the emitter inventing one.
    ABSENT_GOVERNANCE: Tuple[Tuple[str, str], ...] = (
        ("odcs_team", "ownership (`team`) is absent — no owner is written"),
        ("odcs_roles", "access roles (`roles`) are absent — no role grant is written"),
        (
            "odcs_sla_properties",
            "service levels (`slaProperties`) are absent — no SLA is written",
        ),
        ("odcs_quality", "quality rules (`quality`) are absent — no expectation is written"),
        ("odcs_support", "support channels (`support`) are absent — none is written"),
    )

    def operation_verdict(self, operation) -> FidelityVerdict:
        """Every operation is dropped: a data contract describes a dataset, not an API."""
        return FidelityVerdict.drop(
            message=f"{self.target_label} is a data contract — it describes a dataset's "
            f"structure and governance, not operations; the {operation.kind.value} "
            "operation is dropped",
            target_mapping="operation → dropped (data contracts describe datasets)",
        )

    def channel_verdict(self, channel) -> FidelityVerdict:
        """Every event channel is dropped, for the same reason as an operation."""
        return FidelityVerdict.drop(
            message=f"{self.target_label} is a data contract — it describes a dataset's "
            "structure and governance, not event channels; the channel is dropped",
            target_mapping="channel → dropped (data contracts describe datasets)",
        )

    def root_verdicts(self, api: CanonicalApi) -> List[FidelityVerdict]:
        """Report every required field fabricated and every governance block left absent.

        This is the acceptance criterion "fields with no source are omitted and
        reported as ``SYNTH``-absent losses, never invented" in machine-readable form.
        Two shapes of finding are produced, both ``SYNTH`` because both are about a
        slot the *target* demands rather than a construct the source lost:

        * a required field the model cannot source, which is fabricated (``version``,
          ``status``) — reported at ``warn``;
        * a governance block the model cannot source, which is **left absent** —
          reported at ``info``, because an absent owner is honest, not degraded.

        Args:
            api: The model about to be exported.

        Returns:
            Zero or more root findings.
        """
        record = _projection_record(api)
        verdicts: List[FidelityVerdict] = []
        if not api.version:
            verdicts.append(
                FidelityVerdict.synth(
                    message=f"{self.target_label} requires a contract `version` and the "
                    f"model states none; `{FALLBACK_CONTRACT_VERSION}` is written",
                    target_mapping="version → fabricated",
                )
            )
        if not record.get("status"):
            verdicts.append(
                FidelityVerdict.synth(
                    message=f"{self.target_label} requires a contract `status` and the "
                    f"model states none; `{FALLBACK_CONTRACT_STATUS}` is written",
                    target_mapping="status → fabricated",
                )
            )
        for extras_key, sentence in self.ABSENT_GOVERNANCE:
            if not api.extras.get(extras_key):
                verdicts.append(
                    FidelityVerdict.synth(
                        message=f"{self.target_label} {sentence}; Apiome has no source "
                        "for it and does not invent one",
                        severity=LossinessSeverity.INFO,
                        target_mapping="governance block → omitted (nothing to source)",
                    )
                )
        return verdicts

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Refine the record verdict when a column loses a facet ODCS cannot state.

        The capability-derived default calls a record container ``OK`` and leaves
        per-field losses to :meth:`field_verdicts`. That is right for a target where a
        lost facet leaves the *type* alone — but a dropped ``enum`` changes the
        re-imported record itself, so an ``OK`` on the container would be an
        over-claim: the report would say the dataset survived intact while the
        round-trip shows it did not.
        """
        if type_.kind is TypeKind.RECORD and any(
            field.constraints is not None and field.constraints.enum for field in type_.fields
        ):
            return FidelityVerdict.approx(
                message=f"{self.target_label} has no enumeration facet, so a column of "
                f"`{type_.name}` loses its permitted values; the object is otherwise carried",
                target_mapping="object carried; column enum → dropped",
            )
        return super().type_verdict(type_)

    def _constraints_verdict(self, field: CanonicalField) -> Optional[FidelityVerdict]:
        """``APPROX`` only for a facet ODCS has no ``logicalTypeOptions`` key for.

        ODCS carries lengths, numeric bounds, ``pattern`` and ``format`` natively, so
        the profile-derived "constraints are demoted to documentation" verdict would
        be wrong for almost every field. The one facet with nowhere to go in any v3
        line is ``enum``: the standard states allowed values through a quality rule,
        not through a type option, and turning one into the other would be inventing
        an expectation the source never made.
        """
        if field.constraints is not None and field.constraints.enum:
            return FidelityVerdict.approx(
                message=f"{self.target_label} has no enumeration facet in "
                "`logicalTypeOptions`; the permitted values are dropped and the field "
                "keeps its logical type",
                target_mapping="enum → dropped (no ODCS type option states one)",
            )
        return None


class OdcsEmitOptions(EmitOptions):
    """Per-target options for :class:`OdcsEmitter`."""

    api_version: Optional[str] = Field(
        default=None,
        description="ODCS version to declare (for example `v3.1.0`). Defaults to the "
        "version an imported contract declared, then to the newest version this "
        "service ships a schema for.",
        # Published in the options schema so the Export Studio card renders a choice
        # rather than a free-text box; the validator below is what enforces it.
        json_schema_extra={"enum": [None, *sorted(ODCS_SCHEMA_RELEASES.values())]},
    )
    status: Optional[str] = Field(
        default=None,
        description="Lifecycle status to declare (`draft`, `active`, `deprecated`, …). "
        "Defaults to the status an imported contract declared; when nothing sourced "
        "one, `draft` is written and reported as fabricated.",
    )

    @field_validator("api_version")
    @classmethod
    def _known_api_version(cls, value: Optional[str]) -> Optional[str]:
        """Reject a version this service ships no schema for.

        Emitting ``v4.0.0`` would produce a document nothing here could validate or
        read back, which is a worse outcome than refusing the option.
        """
        if value is None:
            return None
        candidate = value.strip()
        if candidate not in set(ODCS_SCHEMA_RELEASES.values()):
            known = ", ".join(sorted(ODCS_SCHEMA_RELEASES.values()))
            raise ValueError(f"unsupported ODCS api_version {candidate!r}; expected one of {known}")
        return candidate


class OdcsEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as an Open Data Contract Standard v3 contract."""

    key = "odcs"
    format = "odcs"
    label = "ODCS Data Contract"
    description = (
        "Export as an Open Data Contract Standard (ODCS v3) data contract — the Linux "
        "Foundation / Bitol YAML that states a dataset's structure, quality rules, "
        "ownership, SLAs and serving infrastructure."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    multi_file = False
    options_model = OdcsEmitOptions

    OUTPUT_MEDIA_TYPE = "application/yaml"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what an ODCS contract can carry.

        ``constraints`` is ``True`` because ``logicalTypeOptions`` states lengths,
        numeric bounds, ``pattern`` and ``format`` natively; the one facet it cannot
        state is refined by :class:`OdcsFidelityRulePack`. ``field_identity`` is
        ``False`` — ``primaryKeyPosition`` orders a key, it does not identify a column
        across renames the way a protobuf field number does.
        """
        return CapabilityProfile(
            operations=False,
            events=False,
            unions=False,
            nullability=True,
            constraints=True,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        """Return the ODCS rule pack (MFX-2.3)."""
        return OdcsFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[OdcsEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Render ``api`` as one ODCS contract document.

        Args:
            api: The canonical model to export.
            opts: Per-target options.

        Returns:
            The emitted bundle, with provenance and loss records.

        Raises:
            ValueError: If the model holds no record type. A data contract states a
                dataset's structure; a model with nothing to describe would produce a
                contract no ODCS reader — this one included — accepts.
            EmitOptionsError: If ``opts`` names an ODCS version this service cannot
                validate.
        """
        try:
            options = (
                opts
                if isinstance(opts, OdcsEmitOptions)
                else OdcsEmitOptions.model_validate(opts.model_dump() if opts else {})
            )
        except ValueError as exc:
            raise EmitOptionsError(str(exc)) from exc
        writer = _OdcsWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=writer.output_path,
                    content=content,
                    media_type=self.OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _projection_record(api: CanonicalApi) -> Mapping[str, Any]:
    """Return the ODCS reader's own projection record from ``api``, or an empty mapping.

    ``extras['odcs']`` is the only key the reader registers as its own bookkeeping, and
    it is what tells this emitter that the model came in through the ODCS adapter — and
    therefore which contract identity, status and version to write back.

    Args:
        api: The model being exported.

    Returns:
        The record mapping; empty when the model came from another format.
    """
    record = api.extras.get(ODCS_EXTRAS_KEY)
    return record if isinstance(record, Mapping) else {}


def _output_path(api: CanonicalApi) -> str:
    """Return the bundle-relative file name for ``api``'s contract."""
    base = (api.title or api.identity.name or "contract").strip()
    safe = _PATH_UNSAFE.sub("-", base).strip("-.") or "contract"
    return f"{safe.lower()}.odcs.yaml"


class _OdcsWriter:
    """Assembles one ODCS document from a canonical model.

    Split from :class:`OdcsEmitter` so the emitter class stays the SPI surface — the
    descriptor, the capability profile and the options — while the document assembly,
    which is where every fidelity decision is made, lives in one readable object.
    """

    def __init__(self, api: CanonicalApi, options: OdcsEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self.output_path = _output_path(api)

        self._record = _projection_record(api)
        self._types_by_key = {type_.key: type_ for type_ in api.types}
        self._api_version = self._resolve_api_version()
        self._line = schema_line_for(self._api_version)
        # Guards against a record type that reaches itself: ODCS has no `$ref`, so an
        # inlined cycle would recurse until the interpreter stopped it.
        self._inlining: List[str] = []
        # Types already inlined somewhere. ODCS cannot share a definition, so a type
        # used twice is written twice — a real fidelity fact, reported once per type.
        self._inlined: Set[str] = set()
        self._reported_shared: Set[str] = set()

    # -- top level ---------------------------------------------------------

    def render(self) -> str:
        """Build and serialize the contract.

        Returns:
            The YAML document text, ending in a newline.

        Raises:
            ValueError: If the model holds no record type to describe.
        """
        objects = self._schema_objects()
        if not objects:
            raise ValueError(
                "ODCS export requires at least one record type — a data contract states "
                "a dataset's structure, and this model describes none"
            )

        document: Dict[str, Any] = {
            "apiVersion": self._api_version,
            "kind": ODCS_KIND_VALUE,
            "id": self._contract_id(),
            "version": self._contract_version(),
            "status": self._contract_status(),
            "schema": objects,
        }
        self.tracker.record("/kind", Provenance.DEFAULT, "the format's only `kind`")

        name = (self._api.title or self._api.identity.name or "").strip()
        if name:
            document["name"] = name
            self.tracker.record("/name", Provenance.SOURCE)

        self._write_identity_fields(document)
        self._write_description(document)
        self._carry(self._api.extras, document, ROOT_CARRIERS, pointer="")
        self._write_servers(document)
        self._carry_extra(self._api.extras, document, pointer="")

        ordered = _ordered(document, _ROOT_ORDER)
        return yaml.safe_dump(
            ordered,
            sort_keys=False,
            allow_unicode=True,
            default_flow_style=False,
            width=100,
        )

    def _resolve_api_version(self) -> str:
        """Return the ``apiVersion`` to declare, most-specific source first."""
        if self._options.api_version:
            self.tracker.record(
                "/apiVersion", Provenance.DEFAULT, "declared by the export options"
            )
            return self._options.api_version
        declared = self._record.get("api_version")
        if isinstance(declared, str) and declared.strip():
            self.tracker.record("/apiVersion", Provenance.SOURCE)
            return declared.strip()
        self.tracker.record(
            "/apiVersion",
            Provenance.DEFAULT,
            "the newest ODCS version this service ships a schema for",
        )
        return DEFAULT_ODCS_API_VERSION

    def _contract_id(self) -> str:
        """Return the contract ``id``, derived rather than invented when unstated."""
        for candidate, provenance in (
            (self._record.get("contract_id"), Provenance.SOURCE),
            (self._api.identity.id, Provenance.SOURCE),
        ):
            if isinstance(candidate, str) and candidate.strip():
                self.tracker.record("/id", provenance)
                return candidate.strip()
        parts = [self._api.identity.namespace, self._api.identity.name]
        derived = _ID_UNSAFE.sub("-", ".".join(part for part in parts if part)).strip("-.")
        self.tracker.record(
            "/id",
            Provenance.INFERRED,
            "derived from the model's identity — ODCS requires an id and the source "
            "states none",
        )
        return derived or "contract"

    def _contract_version(self) -> str:
        """Return the contract ``version``, fabricating one only when required to."""
        if self._api.version and self._api.version.strip():
            self.tracker.record("/version", Provenance.SOURCE)
            return self._api.version.strip()
        self.tracker.record(
            "/version", Provenance.DEFAULT, "ODCS requires a version; the model states none"
        )
        self.losses.record(
            LossKind.INFERRED,
            "fabricated-contract-version",
            f"ODCS requires a contract `version` and the model states none; "
            f"`{FALLBACK_CONTRACT_VERSION}` is written",
            pointer="/version",
        )
        return FALLBACK_CONTRACT_VERSION

    def _contract_status(self) -> str:
        """Return the contract ``status``, fabricating one only when required to."""
        for candidate in (self._options.status, self._record.get("status")):
            if isinstance(candidate, str) and candidate.strip():
                self.tracker.record("/status", Provenance.SOURCE)
                return candidate.strip()
        self.tracker.record(
            "/status", Provenance.DEFAULT, "ODCS requires a status; the model states none"
        )
        self.losses.record(
            LossKind.INFERRED,
            "fabricated-contract-status",
            f"ODCS requires a contract `status` and the model states none; "
            f"`{FALLBACK_CONTRACT_STATUS}` is written",
            pointer="/status",
        )
        return FALLBACK_CONTRACT_STATUS

    def _write_identity_fields(self, document: Dict[str, Any]) -> None:
        """Write ``domain`` / ``tenant`` / ``dataProduct``, each only when sourced.

        ``domain`` has a second source: the ODCS reader projects a contract's domain
        onto ``identity.namespace``, so a model that came through it (or through any
        adapter with a namespace) can state one without a guess.
        """
        for key in ("domain", "tenant", "data_product"):
            value = self._record.get(key)
            if isinstance(value, str) and value.strip():
                emitted = "dataProduct" if key == "data_product" else key
                document[emitted] = value.strip()
                self.tracker.record(f"/{emitted}", Provenance.SOURCE)
        if "domain" not in document and self._api.identity.namespace:
            document["domain"] = self._api.identity.namespace
            self.tracker.record(
                "/domain",
                Provenance.INFERRED,
                "the model's namespace — the coordinate the ODCS reader projects a "
                "contract's domain onto",
            )

    def _write_description(self, document: Dict[str, Any]) -> None:
        """Write the ``description`` block.

        A carried block is written by :data:`ROOT_CARRIERS` and left alone here; a
        model from another format contributes only its prose, as ``purpose``, which is
        the field the reader takes the canonical description from.
        """
        if self._api.extras.get("odcs_description") is not None:
            return
        prose = (self._api.description or "").strip()
        if prose:
            document["description"] = {"purpose": prose}
            self.tracker.record("/description/purpose", Provenance.SOURCE)

    def _write_servers(self, document: Dict[str, Any]) -> None:
        """Project canonical servers onto ``servers[]`` when none were carried.

        A carried ``odcs_servers`` block is exact and wins. Otherwise a canonical
        :class:`~app.canonical_model.Server` — a URL with variables — becomes an
        ODCS ``api`` server, which is the one server type whose only required field
        is a location. Every other ODCS server type (a BigQuery dataset, an S3 prefix,
        a Kafka broker) needs fields a URL does not carry, so none is guessed at.
        """
        if "servers" in document or not self._api.servers:
            return
        entries = [self._server(server, index) for index, server in enumerate(self._api.servers)]
        document["servers"] = entries
        self.losses.record(
            LossKind.INFERRED,
            "synthesized-api-server",
            f"{len(entries)} canonical server(s) became ODCS `type: api` entries; the "
            "model states a URL, and the storage-specific fields every other ODCS "
            "server type requires are not guessed at",
            pointer="/servers",
        )

    def _server(self, server: Server, index: int) -> Dict[str, Any]:
        """Project one canonical server onto an ODCS ``servers[]`` entry.

        ODCS requires every entry to name itself (``server``). A canonical server may
        not, so the name is derived from its URL's host — which is what the entry is
        about — and only falls back to a positional label when even that is absent.
        """
        entry: Dict[str, Any] = {"type": "api", "location": server.url}
        pointer = f"/servers/{index}"
        self.tracker.record(f"{pointer}/location", Provenance.SOURCE)
        self.tracker.record(
            f"{pointer}/type", Provenance.INFERRED, "a URL-addressed server is an ODCS `api` server"
        )
        if server.name:
            entry["server"] = server.name
            self.tracker.record(f"{pointer}/server", Provenance.SOURCE)
        else:
            entry["server"] = _server_name(server.url, index)
            self.tracker.record(
                f"{pointer}/server",
                Provenance.INFERRED,
                "derived from the server URL — ODCS requires every entry to name itself",
            )
        if server.description:
            entry["description"] = server.description
            self.tracker.record(f"{pointer}/description", Provenance.SOURCE)
        return _ordered(entry, ("server", "type", "description", "location"))

    # -- schema objects ----------------------------------------------------

    def _schema_objects(self) -> List[Dict[str, Any]]:
        """Build the ``schema[]`` list — one entry per dataset the model describes.

        A canonical model is a graph of named types; an ODCS contract is a *list of
        datasets* whose sub-structures are nested inline, because the standard has no
        cross-reference. The datasets are therefore the record types nothing else
        points at — for an imported contract, exactly the ``schema[]`` objects it
        declared, since the reader keys a nested object ``<owner>.<property>`` and
        references it from its owner.

        Returns:
            The emitted objects, in the source's declaration order where the reader
            recorded one (``odcs_position``) and by canonical key otherwise.
        """
        referenced = self._referenced_type_keys()
        roots = [
            type_
            for type_ in self._api.types
            if type_.key not in referenced and type_.kind is TypeKind.RECORD
        ]
        if not roots:
            # Every record points at another (a cycle, or a model whose only types are
            # mutually referential). Falling back to all records keeps the contract
            # describing something rather than nothing.
            roots = [type_ for type_ in self._api.types if type_.kind is TypeKind.RECORD]
        self._report_unusable_root_types(referenced)
        roots = [type_ for type_ in roots if self._has_columns(type_)]

        ordered = sorted(roots, key=lambda type_: (_position(type_.extras), type_.key))
        return [self._schema_object(type_, index) for index, type_ in enumerate(ordered)]

    def _referenced_type_keys(self) -> Set[str]:
        """Return every named-type key some other type points at."""
        referenced: Set[str] = set()
        for type_ in self._api.types:
            for field in type_.fields:
                referenced.update(_referenced_names(field.type))
            referenced.update(type_.union_members)
            if type_.aliased is not None:
                referenced.update(_referenced_names(type_.aliased))
            for ref in (type_.key_type, type_.value_type):
                if ref is not None:
                    referenced.update(_referenced_names(ref))
        return referenced

    def _report_unusable_root_types(self, referenced: Set[str]) -> None:
        """Record a loss for every top-level type that cannot become a dataset.

        An ODCS ``schema[]`` entry is an object with columns. A top-level enum, union,
        map, alias or bare scalar that nothing references describes no dataset, so it
        has no entry — and saying so is better than a contract that quietly holds
        fewer things than the catalog item did.
        """
        for type_ in self._api.types:
            if type_.key in referenced or type_.kind is TypeKind.RECORD:
                continue
            self.losses.record(
                LossKind.NA,
                "non-dataset-type-dropped",
                f"`{type_.name}` is a top-level {type_.kind.value} type; an ODCS "
                "`schema[]` entry is a dataset with columns, so it has no entry",
                pointer=type_.key,
            )

    def _has_columns(self, type_: Type) -> bool:
        """Whether a record can honestly become a ``schema[]`` entry.

        A record whose members were never modelled (a response body an adapter typed
        only by name) would become a dataset with no columns — which reads as "this
        table has no columns", a claim the source never made and one the ODCS reader
        refuses to import. It is left out and reported instead.
        """
        if type_.fields:
            return True
        self.losses.record(
            LossKind.NA,
            "empty-record-dropped",
            f"`{type_.name}` declares no members, and an ODCS dataset with no columns "
            "states that the table is empty rather than that the source was silent; "
            "it has no `schema[]` entry",
            pointer=type_.key,
        )
        return False

    def _schema_object(self, type_: Type, index: int) -> Dict[str, Any]:
        """Build one ``schema[]`` entry from a canonical record type."""
        pointer = f"/schema/{index}"
        node: Dict[str, Any] = {"name": type_.name, "logicalType": "object"}
        self.tracker.record(f"{pointer}/name", Provenance.SOURCE)
        self.tracker.record(
            f"{pointer}/logicalType", Provenance.INFERRED, "a dataset is an ODCS object"
        )
        if type_.description:
            node["description"] = type_.description
            self.tracker.record(f"{pointer}/description", Provenance.SOURCE)

        self._inlining.append(type_.key)
        node["properties"] = [
            self._property(field, f"{pointer}/properties/{position}")
            for position, field in enumerate(_ordered_fields(type_))
        ]
        self._inlining.pop()

        self._carry(type_.extras, node, OBJECT_CARRIERS, pointer=pointer)
        self._carry_extra(type_.extras, node, pointer=pointer)
        return _ordered(node, _OBJECT_ORDER)

    # -- properties --------------------------------------------------------

    def _property(self, field: CanonicalField, pointer: str) -> Dict[str, Any]:
        """Build one ``properties[]`` entry from a canonical field."""
        node: Dict[str, Any] = {"name": field.name}
        self.tracker.record(f"{pointer}/name", Provenance.SOURCE)
        if field.description:
            node["description"] = field.description
            self.tracker.record(f"{pointer}/description", Provenance.SOURCE)
        if field.type.nullable is False:
            node["required"] = True
            self.tracker.record(f"{pointer}/required", Provenance.SOURCE)

        self._write_type(node, field.type, field.extras, field.constraints, pointer)
        self._carry(field.extras, node, PROPERTY_CARRIERS, pointer=pointer)
        self._carry_groups(field.extras, node, pointer=pointer)
        self._carry_extra(field.extras, node, pointer=pointer)
        if field.field_number is not None:
            self.losses.record(
                LossKind.NA,
                "field-number-dropped",
                f"`{field.name}` carries the source field number {field.field_number}; "
                "ODCS identifies a column by name and has nowhere to keep it",
                pointer=field.key,
            )
        return _ordered(node, _PROPERTY_ORDER)

    def _write_type(
        self,
        node: Dict[str, Any],
        ref: TypeRef,
        extras: Mapping[str, Any],
        constraints: Optional[Constraints],
        pointer: str,
    ) -> None:
        """Write ``logicalType`` (and the structure it implies) onto one property.

        Three shapes, in the order the standard distinguishes them: a list becomes
        ``array`` with an ``items`` block, a reference to a record becomes ``object``
        with the record's columns nested inline, and everything else is a scalar named
        by its logical type. A logical type the ODCS reader recorded verbatim
        (``odcs_logical_type``) always wins for a scalar — it is what the source
        actually said, including the ``timestamp``/``time`` spellings a canonical
        scalar name collapses.
        """
        if ref.item is not None:
            node["logicalType"] = "array"
            self.tracker.record(
                f"{pointer}/logicalType", Provenance.INFERRED, "a canonical list is an ODCS array"
            )
            node["items"] = self._items(ref.item, f"{pointer}/items")
            self._write_options(node, "array", extras, constraints, pointer)
            return

        target = self._types_by_key.get(ref.name or "")
        if target is not None and target.kind is TypeKind.RECORD:
            node["logicalType"] = "object"
            self.tracker.record(
                f"{pointer}/logicalType", Provenance.INFERRED, "a canonical record is an ODCS object"
            )
            nested = self._nested_properties(target, pointer)
            if nested:
                # An object with an *empty* `properties` list claims the record has no
                # members; omitting the key is ODCS's free-form object, which is what a
                # record whose members are unknown (or unreachable) actually is.
                node["properties"] = nested
            self._write_options(node, "object", extras, constraints, pointer)
            return

        logical, hint = self._scalar_logical_type(target, ref, extras, pointer)
        node["logicalType"] = logical
        self._write_options(node, logical, extras, constraints, pointer, format_hint=hint)

    def _scalar_logical_type(
        self,
        target: Optional[Type],
        ref: TypeRef,
        extras: Mapping[str, Any],
        pointer: str,
    ) -> Tuple[str, Optional[str]]:
        """Return the ``logicalType`` (and format hint) for a non-list, non-record use."""
        declared = extras.get("odcs_logical_type")
        if isinstance(declared, str) and declared in ODCS_LOGICAL_TYPES[self._line]:
            self.tracker.record(f"{pointer}/logicalType", Provenance.SOURCE)
            return declared, None

        if target is not None:
            if target.kind is TypeKind.ENUM:
                self.losses.record(
                    LossKind.NA,
                    "enum-type-flattened",
                    f"`{target.name}` is an enumeration; ODCS has no enum construct, so "
                    "the column keeps its value type and the permitted values are dropped",
                    pointer=target.key,
                )
            elif target.kind is TypeKind.UNION:
                self.losses.record(
                    LossKind.NA,
                    "union-type-flattened",
                    f"`{target.name}` is a union; ODCS has no alternative-type construct, "
                    "so the column becomes a free-form object",
                    pointer=target.key,
                )
                self.tracker.record(
                    f"{pointer}/logicalType", Provenance.INFERRED, "a union has no ODCS spelling"
                )
                return "object", None
            elif target.kind is TypeKind.MAP:
                self.losses.record(
                    LossKind.NA,
                    "map-type-flattened",
                    f"`{target.name}` is a map; ODCS names a dataset's columns, so the "
                    "column becomes a free-form object with no declared members",
                    pointer=target.key,
                )
                self.tracker.record(
                    f"{pointer}/logicalType", Provenance.INFERRED, "a map has no ODCS spelling"
                )
                return "object", None
            elif target.kind is TypeKind.ALIAS and target.aliased is not None:
                return self._scalar_logical_type(
                    self._types_by_key.get(target.aliased.name or ""),
                    target.aliased,
                    extras,
                    pointer,
                )

        # An enum or a custom scalar names itself, not a canonical scalar spelling, so
        # the lookup misses and the fallback applies — which is the right answer for
        # both: an ODCS column of unknown shape is text.
        scalar = target.name if target is not None else ref.name
        logical, hint = _canonical_logical_type(scalar, self._line)
        self.tracker.record(
            f"{pointer}/logicalType",
            Provenance.INFERRED,
            f"the ODCS logical type for the canonical scalar `{scalar or 'unnamed'}`",
        )
        return logical, hint

    def _items(self, ref: TypeRef, pointer: str) -> Dict[str, Any]:
        """Build the ``items`` block of an ``array`` property.

        The block is a property without a name — the reader synthesizes the name
        ``items`` on the way in, and the standard's ``SchemaItemProperty`` has no name
        of its own — so this is deliberately not routed through :meth:`_property`.
        """
        node: Dict[str, Any] = {}
        self._write_type(node, ref, {}, None, pointer)
        return _ordered(node, _PROPERTY_ORDER)

    def _nested_properties(self, target: Type, pointer: str) -> List[Dict[str, Any]]:
        """Inline a referenced record's columns, guarding against cycles and sharing."""
        if target.key in self._inlining:
            self.losses.record(
                LossKind.NA,
                "recursive-type-flattened",
                f"`{target.name}` reaches itself; ODCS has no type reference, so the "
                "recursive column becomes a free-form object with no declared members",
                pointer=target.key,
            )
            return []
        if target.key in self._inlined and target.key not in self._reported_shared:
            self._reported_shared.add(target.key)
            self.losses.record(
                LossKind.INFERRED,
                "shared-type-inlined",
                f"`{target.name}` is used by more than one column; ODCS has no type "
                "reference, so its columns are written out at each use site",
                pointer=target.key,
            )
        self._inlined.add(target.key)

        self._inlining.append(target.key)
        properties = [
            self._property(field, f"{pointer}/properties/{position}")
            for position, field in enumerate(_ordered_fields(target))
        ]
        self._inlining.pop()
        return properties

    def _write_options(
        self,
        node: Dict[str, Any],
        logical_type: str,
        extras: Mapping[str, Any],
        constraints: Optional[Constraints],
        pointer: str,
        *,
        format_hint: Optional[str] = None,
    ) -> None:
        """Write ``logicalTypeOptions``, filtered to what the standard admits.

        The carried block wins where it exists — it is what the source wrote, and it
        holds facets (a Java date pattern, a vendor option) the canonical constraints
        never modelled. Canonical constraints fill in the rest, which is how a
        contract emitted from an Avro schema or a SQL table gets its lengths and
        bounds. Either way every candidate is checked against
        :func:`app.odcs_schema.option_value_is_admitted`: a key the emitted logical
        type does not admit, or one whose value has the wrong JSON type, would make
        the whole document fail the standard's schema.
        """
        options: Dict[str, Any] = {}
        rejected: List[str] = []

        carried = extras.get("odcs_logical_type_options")
        if isinstance(carried, Mapping):
            for key, value in carried.items():
                if option_value_is_admitted(logical_type, str(key), value, self._line):
                    options[str(key)] = value
                else:
                    rejected.append(str(key))

        for attribute, key in _CONSTRAINT_OPTIONS:
            if key in options:
                continue
            value = getattr(constraints, attribute, None) if constraints else None
            if value is None:
                continue
            if key == "format":
                value = _odcs_format(str(value), logical_type)
                if value is None:
                    continue
            if option_value_is_admitted(logical_type, key, value, self._line):
                options[key] = value
            else:
                rejected.append(key)
        hint = _odcs_format(format_hint, logical_type) if format_hint else None
        if hint and "format" not in options:
            if option_value_is_admitted(logical_type, "format", hint, self._line):
                options["format"] = hint

        if constraints is not None and constraints.enum:
            rejected.append("enum")

        if options:
            node["logicalTypeOptions"] = options
            self.tracker.record(f"{pointer}/logicalTypeOptions", Provenance.SOURCE)
        for key in sorted(set(rejected)):
            self.losses.record(
                LossKind.NA,
                "unsupported-type-option",
                f"ODCS admits no `{key}` option beside `logicalType: {logical_type}`, "
                "so the facet is dropped rather than written illegally",
                pointer=pointer,
            )

    # -- carriers ----------------------------------------------------------

    def _carry(
        self,
        extras: Mapping[str, Any],
        node: Dict[str, Any],
        carriers: Sequence[Tuple[str, str]],
        *,
        pointer: str,
    ) -> None:
        """Write every carried governance block back to the ODCS key it came from."""
        for extras_key, odcs_key in carriers:
            if extras_key not in extras:
                continue
            value = extras[extras_key]
            if value is None:
                continue
            node[odcs_key] = value
            self.tracker.record(f"{pointer}/{odcs_key}", Provenance.SOURCE)

    def _carry_groups(
        self, extras: Mapping[str, Any], node: Dict[str, Any], *, pointer: str
    ) -> None:
        """Spread the grouped property carriers back onto their individual ODCS keys.

        The reader folded ``primaryKey``/``primaryKeyPosition``/``unique`` into one
        ``odcs_key`` mapping (and did the same for partitioning and for transforms) so
        that a related set travels together. Unfolding is the exact inverse: the keys
        inside are the source's own, so they are written unchanged.
        """
        for extras_key in PROPERTY_GROUP_CARRIERS:
            group = extras.get(extras_key)
            if not isinstance(group, Mapping):
                continue
            for key, value in group.items():
                node[str(key)] = value
                self.tracker.record(f"{pointer}/{key}", Provenance.SOURCE)

    def _carry_extra(
        self, extras: Mapping[str, Any], node: Dict[str, Any], *, pointer: str
    ) -> None:
        """Write back the forward-compatibility slot.

        ``odcs_extra`` holds every ODCS key the reader did not name — the standard's
        own growth room. Writing it back unchanged is what keeps a contract using a
        construct newer than this reader from losing it on a round trip.
        """
        extra = extras.get("odcs_extra")
        if not isinstance(extra, Mapping):
            return
        for key, value in extra.items():
            node[str(key)] = value
            self.tracker.record(f"{pointer}/{key}", Provenance.SOURCE)


def _server_name(url: str, index: int) -> str:
    """Derive an ODCS ``server`` name from a canonical server URL.

    Args:
        url: The server URL or URL template.
        index: The server's position, used only when the URL yields nothing usable.

    Returns:
        The host (with any URL-template braces and port removed), or ``server-<n>``.
    """
    host = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", (url or "").strip())
    host = host.split("/", 1)[0].split(":", 1)[0]
    safe = _ID_UNSAFE.sub("-", host).strip("-.")
    return safe or f"server-{index + 1}"


def _position(extras: Mapping[str, Any]) -> int:
    """Return a node's recorded declaration order, or a sentinel that sorts last.

    Canonical ordering sorts by key, which is not the order a dataset's columns are
    physically presented in; the ODCS reader records the source index in
    ``odcs_position`` precisely so an emitter can put them back.
    """
    value = extras.get("odcs_position")
    return value if isinstance(value, int) and not isinstance(value, bool) else 1 << 30


def _ordered_fields(type_: Type) -> List[CanonicalField]:
    """Return a record's fields in the source's declaration order."""
    return sorted(type_.fields, key=lambda field: (_position(field.extras), field.key))


def _referenced_names(ref: TypeRef) -> Set[str]:
    """Return every named type a reference reaches, through any depth of list."""
    names: Set[str] = set()
    current: Optional[TypeRef] = ref
    while current is not None:
        if current.name:
            names.add(current.name)
        current = current.item
    return names
