"""Kubernetes CRD emitter: canonical model → CustomResourceDefinition — FMT-2.1 (#5419).

The inverse of :class:`app.k8s_crd_import_source.K8sCrdImportSource` and an
implementation of the :class:`app.emitter.Emitter` SPI. It turns any
``data_schema``-paradigm :class:`~app.canonical_model.CanonicalApi` into an
``apiextensions.k8s.io/v1`` CustomResourceDefinition — the "design and govern a
schema in Apiome, then emit the CRD your cluster applies" half of the platform
engineering story the import adapter already implies.

What it produces
----------------

* ``spec.group`` / ``spec.names`` (kind, plural, singular, shortNames) /
  ``spec.scope`` — recovered from the ``k8s_crd_*`` extras a CRD import stamped,
  overridable per emit through :class:`K8sCrdEmitOptions`, otherwise derived from
  the canonical identity;
* one ``spec.versions[]`` entry per canonical version, each carrying its schema as
  a **structural** ``openAPIV3Schema`` plus ``served`` / ``storage`` /
  ``deprecated`` / ``deprecationWarning``;
* ``subresources.status`` when the resource declares a ``status`` property;
* ``additionalPrinterColumns`` derived from fields marked with a
  ``printer_column`` extra;
* ``x-kubernetes-*`` vendor extensions the source carried, re-attached at the
  nodes they came from.

Structural-schema enforcement
-----------------------------

Kubernetes does not accept arbitrary JSON Schema. Every node must declare a
``type`` (or opt out with ``x-kubernetes-preserve-unknown-fields`` /
``x-kubernetes-int-or-string``), a documented set of keywords is rejected
outright, and ``uniqueItems: true`` / ``additionalProperties: false`` are not
allowed. Rather than emit a document the API server would reject, this emitter
*enforces* those restrictions while building and records every construct the
restriction cost as an :class:`~app.emitter.Loss` — a union at the root, a
reference cycle, a format Kubernetes does not know. :func:`validate_k8s_crd_document`
re-checks the finished artifact independently, so "emitted CRDs satisfy structural
schema rules" is a testable property rather than a claim.

That enforcement is also why this module builds its schemas rather than reusing the
shared :class:`~app.emitter.SchemaEmitter`: that emitter's two load-bearing habits —
referencing named types by ``$ref`` and emitting ``deprecated`` — are exactly the two
things a structural schema forbids, so every named type is *inlined* here (with cycle
detection standing in for the ``$ref`` a CRD may not have) and the restriction table is
applied on the way out.

Free-form nodes
---------------

The canonical model records "an object of unspecified shape" as a typeless
member. Kubernetes has two ways to spell that, and they mean different things at
runtime: ``{type: object}`` declares an object and *prunes* every key inside it,
while ``x-kubernetes-preserve-unknown-fields: true`` keeps them. The default
(``preserve_unknown_fields=False``) emits the pruning form, which round-trips
exactly, and records an ``INFERRED`` loss per node so the pruning is never
silent; set the option to keep unknown keys on a CRD destined for a live cluster.
A node whose source already carried ``x-kubernetes-preserve-unknown-fields`` keeps
it either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import yaml
from pydantic import Field

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    Operation,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict
from .k8s_crd_normalizer import K8S_CRD_FORMAT
from .lossiness import LossinessSeverity
from .k8s_structural_schema import (
    CRD_API_VERSION,
    CRD_KIND,
    DNS_SUBDOMAIN,
    INT_OR_STRING,
    KUBERNETES_KNOWN_FORMATS,
    PRESERVE_UNKNOWN_FIELDS,
    VERSION_NAME,
    structural_schema_violations,
    validate_k8s_crd_document,
)

__all__ = [
    "K8sCrdEmitOptions",
    "K8sCrdEmitter",
    "K8sCrdFidelityRulePack",
    # Re-exported so an export caller needs one import to emit and verify.
    "structural_schema_violations",
    "validate_k8s_crd_document",
]


# ===========================================================================
# Emit-side vocabulary
# ===========================================================================

#: Scalar ``TypeRef`` names that map straight onto a JSON-Schema ``type``.
_PRIMITIVE_TYPES: frozenset = frozenset({"string", "number", "integer", "boolean"})

#: ``Constraints`` attribute → JSON-Schema keyword, restricted to the facets a CRD
#: structural schema accepts. ``uniqueItems`` is deliberately absent: Kubernetes
#: rejects ``uniqueItems: true``, so it is handled as a loss instead.
_CONSTRAINT_KEYWORDS: Tuple[Tuple[str, str], ...] = (
    ("minimum", "minimum"),
    ("maximum", "maximum"),
    ("exclusive_minimum", "exclusiveMinimum"),
    ("exclusive_maximum", "exclusiveMaximum"),
    ("multiple_of", "multipleOf"),
    ("min_length", "minLength"),
    ("max_length", "maxLength"),
    ("pattern", "pattern"),
    ("min_items", "minItems"),
    ("max_items", "maxItems"),
    ("enum", "enum"),
)

#: Fallback API group when the model carries nothing usable. ``example.com`` is
#: the group Kubernetes' own documentation uses for illustrative CRDs.
DEFAULT_GROUP = "example.com"

#: Fallback version name when the model carries nothing usable.
DEFAULT_VERSION = "v1"

#: Field extras key that marks a field for ``additionalPrinterColumns``.
PRINTER_COLUMN_EXTRA = "printer_column"

#: Canonical scalar → printer-column ``type``. A ``date``/``date-time`` format maps
#: onto Kubernetes' ``date`` column, which no canonical scalar names directly.
_SCALAR_PRINTER_COLUMN_TYPES: Dict[str, str] = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "boolean": "boolean",
}

#: Every column type Kubernetes renders; anything else is rejected by the API server.
PRINTER_COLUMN_TYPES: frozenset = frozenset(_SCALAR_PRINTER_COLUMN_TYPES) | {"date"}


# ===========================================================================
# Name derivation
# ===========================================================================


def _pluralize(word: str) -> str:
    """Return the lower-case English plural of ``word`` for ``spec.names.plural``.

    Kubernetes only requires the plural to be a unique lower-case DNS label, so a
    small regular-English rule set is enough: ``-s``/``-x``/``-z``/``-ch``/``-sh``
    take ``-es``, a consonant followed by ``-y`` becomes ``-ies``, everything else
    takes ``-s``.

    Args:
        word: The singular resource name (any case).

    Returns:
        The lower-cased plural form.
    """
    lowered = word.lower()
    if not lowered:
        return lowered
    if lowered.endswith(("s", "x", "z", "ch", "sh")):
        return f"{lowered}es"
    if lowered.endswith("y") and len(lowered) > 1 and lowered[-2] not in "aeiou":
        return f"{lowered[:-1]}ies"
    return f"{lowered}s"


def _dns_label(value: str) -> str:
    """Reduce ``value`` to a lower-case DNS label (``[a-z0-9-]``, trimmed)."""
    label = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    return label


def _kind_name(value: str) -> str:
    """Reduce ``value`` to a CamelCase Kubernetes ``kind`` (alphanumeric only)."""
    parts = [part for part in re.split(r"[^A-Za-z0-9]+", value) if part]
    if not parts:
        return ""
    joined = "".join(part[0].upper() + part[1:] for part in parts)
    return re.sub(r"^[^A-Za-z]+", "", joined)


def _first_str(*candidates: Any) -> Optional[str]:
    """Return the first candidate that is a non-empty string, else ``None``."""
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


# ===========================================================================
# Fidelity
# ===========================================================================


class K8sCrdFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for CustomResourceDefinition export — FMT-2.7 (#5425).

    States, construct by construct and *before* an emit runs, the same losses
    :class:`K8sCrdEmitter` records while building the document, so a target card and
    the finished artifact agree.

    A CRD is a **resource definition**: one structural ``openAPIV3Schema`` per
    version, and no operations — the API server generates the endpoints from the
    resource. What the profile's six axes cannot say on their own is *which*
    JSON-Schema constructs Kubernetes rejects: a ``oneOf`` may not carry a ``type``,
    ``uniqueItems: true`` is refused outright, and a ``format`` outside the set the
    API server knows validates nothing. Each of those is named here rather than
    discovered in the artifact.
    """

    target_label = "Kubernetes CRD"

    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        """An event channel has no place in a resource definition; it is dropped."""
        return FidelityVerdict.drop(
            message=(
                f"{self.target_label} defines a resource's schema and has no "
                f"event/channel vocabulary; channel {channel.key!r} is dropped"
            ),
            target_mapping="channel → dropped",
        )

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Every operation is dropped: the API server generates a CRD's endpoints."""
        return FidelityVerdict.drop(
            message=(
                f"{self.target_label} declares a resource, not its endpoints — the API "
                f"server generates those — so operation {operation.key!r} is dropped"
            ),
            target_mapping="operation → dropped",
        )

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """Report the two type shapes a structural schema cannot declare."""
        if type_.kind is TypeKind.UNION:
            return FidelityVerdict.drop(
                message=(
                    f"a structural schema's `oneOf`/`anyOf` may not carry a `type`, so "
                    f"{self.target_label} cannot express the union {type_.key!r}; the "
                    "node is emitted as a free-form object"
                ),
                target_mapping="union → free-form node",
            )
        if (
            type_.kind is TypeKind.SCALAR
            and _infer_scalar_from_constraints(type_.constraints) is None
        ):
            return FidelityVerdict.approx(
                message=(
                    f"scalar type {type_.key!r} names no JSON type "
                    f"{self.target_label} can declare; it is emitted as a free-form node"
                ),
                target_mapping="untyped scalar → free-form node",
            )
        return super().type_verdict(type_)

    def field_verdicts(self, field: CanonicalField) -> List[FidelityVerdict]:
        """Add the two validation facets Kubernetes refuses to the default verdicts.

        ``nullability`` and ``constraints`` are both ``True`` on the profile, so the
        base pack contributes nothing for most fields — but "Kubernetes honours the
        validation facets" is true only of the facets it *knows*. The two exceptions
        are enumerated here so a source that carries them is warned before the emit
        silently drops the keyword.
        """
        verdicts = super().field_verdicts(field)
        constraints = field.constraints
        if constraints is None:
            return verdicts
        if constraints.unique_items:
            verdicts.append(
                FidelityVerdict.drop(
                    message=(
                        f"{self.target_label} rejects `uniqueItems: true`; the "
                        f"constraint on {field.key!r} is dropped"
                    ),
                    severity=LossinessSeverity.INFO,
                    target_mapping="uniqueItems → dropped",
                )
            )
        if constraints.format and constraints.format not in KUBERNETES_KNOWN_FORMATS:
            verdicts.append(
                FidelityVerdict.drop(
                    message=(
                        f"{self.target_label} does not recognise "
                        f"`format: {constraints.format}`; the keyword on {field.key!r} "
                        "is dropped because it would validate nothing"
                    ),
                    severity=LossinessSeverity.INFO,
                    target_mapping="unknown format → dropped",
                )
            )
        return verdicts


# ===========================================================================
# Emit options
# ===========================================================================


class K8sCrdEmitOptions(EmitOptions):
    """Per-target options for :class:`K8sCrdEmitter`.

    Every field defaults to ``None``/the source's own value, so an unconfigured
    emit reproduces a CRD import faithfully and only the fields a caller sets are
    overridden.
    """

    group: Optional[str] = Field(
        default=None,
        description="API group for `spec.group`. Defaults to the source CRD's group, "
        "else the canonical namespace, else `example.com`.",
    )
    kind: Optional[str] = Field(
        default=None,
        description="Resource kind for `spec.names.kind`. Defaults to the source CRD's "
        "kind, else the root type / artifact name.",
    )
    plural: Optional[str] = Field(
        default=None,
        description="Plural name for `spec.names.plural`. Defaults to the source CRD's "
        "plural, else the pluralized kind.",
    )
    singular: Optional[str] = Field(
        default=None,
        description="Singular name for `spec.names.singular`. Defaults to the source "
        "CRD's singular, else the lower-cased kind.",
    )
    short_names: Optional[List[str]] = Field(
        default=None,
        description="Short names for `spec.names.shortNames`. Defaults to the source "
        "CRD's short names; an empty list emits none.",
    )
    scope: Optional[str] = Field(
        default=None,
        description="`spec.scope`: `Namespaced` or `Cluster`. Defaults to the source "
        "CRD's scope, else `Namespaced`.",
    )
    version: Optional[str] = Field(
        default=None,
        description="Version name for a model that carries none (`v1`, `v2beta1`). "
        "Ignored when the source CRD already names its versions.",
    )
    served: Optional[bool] = Field(
        default=None,
        description="Force `served` on every emitted version. Defaults to the source "
        "CRD's per-version flag, else `true`.",
    )
    storage_version: Optional[str] = Field(
        default=None,
        description="Name of the version that carries `storage: true`. Defaults to the "
        "source CRD's storage version; exactly one version is always marked.",
    )
    status_subresource: bool = Field(
        default=True,
        description="Emit `subresources.status` when the resource declares a `status` "
        "property. Disable to emit the resource without a status subresource.",
    )
    printer_columns: bool = Field(
        default=True,
        description="Emit `additionalPrinterColumns` derived from fields marked with a "
        "`printer_column` extra.",
    )
    preserve_unknown_fields: bool = Field(
        default=False,
        description="Stamp `x-kubernetes-preserve-unknown-fields: true` on nodes the "
        "canonical model leaves free-form, so Kubernetes keeps their contents instead "
        "of pruning them. Recommended for a CRD that will be applied to a cluster.",
    )
    pretty_print: bool = Field(
        default=True,
        description="Render block-style YAML. Disable for a compact flow-style document.",
    )

    def resolved_scope(self) -> Optional[str]:
        """Return the requested scope, normalized to Kubernetes' spelling, or ``None``."""
        if not self.scope:
            return None
        lowered = self.scope.strip().lower()
        if lowered == "cluster":
            return "Cluster"
        if lowered == "namespaced":
            return "Namespaced"
        return self.scope.strip()


# ===========================================================================
# Emission plan
# ===========================================================================


@dataclass
class _VersionPlan:
    """One ``spec.versions[]`` entry: its flags and the canonical type behind it."""

    name: str
    served: bool
    storage: bool
    deprecated: bool
    deprecation_warning: Optional[str]
    root_type: Optional[Type]
    #: True when the source version declared no ``openAPIV3Schema`` at all, so the
    #: emitted entry must omit the ``schema`` block rather than invent one.
    schema_absent: bool = False
    #: The type whose fields are scanned for ``printer_column`` marks. Differs from
    #: ``root_type`` when the schema was nested under a synthesized ``spec``.
    column_source: Optional[Type] = None
    #: JSONPath prefix for this version's printer columns (``""`` or ``".spec"``).
    column_prefix: str = ""


@dataclass
class _CrdPlan:
    """One CustomResourceDefinition document to emit."""

    name: str
    group: str
    kind: str
    plural: str
    singular: str
    short_names: List[str]
    scope: str
    versions: List[_VersionPlan] = dataclass_field(default_factory=list)
    #: Canonical types reachable only by inlining; kept so the schema builder can
    #: resolve named references without re-scanning the model.
    inlinable: Dict[str, Type] = dataclass_field(default_factory=dict)


# ===========================================================================
# Structural schema construction
# ===========================================================================


def _vendor_extensions(extras: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the ``x-kubernetes-*`` bag an import stamped onto ``extras``."""
    bag = extras.get("x_kubernetes")
    if not isinstance(bag, Mapping):
        return {}
    return {
        key: value
        for key, value in bag.items()
        if isinstance(key, str) and key.startswith("x-kubernetes-")
    }


def _ordered_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Return ``schema`` with its keys in the order a CRD author expects to read them.

    Purely presentational — YAML mappings are unordered — but a schema that opens
    with ``type``/``description`` and closes with the vendor extensions is far
    easier to review in a pull request than one in construction order.
    """
    lead = [key for key in ("type", "format", "description") if key in schema]
    trail = [key for key in schema if key.startswith("x-kubernetes-")]
    middle = [key for key in schema if key not in lead and key not in trail]
    return {key: schema[key] for key in (*lead, *middle, *trail)}


def _scalar_type_of(values: Sequence[Any]) -> Optional[str]:
    """Infer the single JSON-Schema scalar ``type`` covering ``values``, or ``None``."""
    found = set()
    for value in values:
        if isinstance(value, bool):
            found.add("boolean")
        elif isinstance(value, int):
            found.add("integer")
        elif isinstance(value, float):
            found.add("number")
        elif isinstance(value, str):
            found.add("string")
        else:
            return None
    return found.pop() if len(found) == 1 else None


class _StructuralSchemaBuilder:
    """Build one structural ``openAPIV3Schema`` from a canonical :class:`Type`.

    Kubernetes structural schemas have no ``$ref``, so every named reference is
    **inlined**; a reference that revisits a type already on the inlining stack is
    a cycle the target cannot express and becomes a free-form node plus a loss.
    Constructs the restriction table forbids (unions, ``uniqueItems``, unknown
    formats, ``deprecated``) are dropped the same way — reported, never silent.
    """

    def __init__(
        self,
        types_by_name: Mapping[str, Type],
        options: K8sCrdEmitOptions,
        tracker: ProvenanceTracker,
        losses: LossTracker,
    ) -> None:
        """Create a builder.

        The inlining ``stack`` holds type *keys* rather than names, because a
        synthesized wrapper deliberately reuses the resource ``kind`` as its name.

        Args:
            types_by_name: Named canonical types available for inlining.
            options: The active emit options.
            tracker: Provenance sink for the values this builder emits.
            losses: Loss sink for constructs it cannot carry.
        """
        self._types = types_by_name
        self._options = options
        self._tracker = tracker
        self._losses = losses

    # --- entry point --------------------------------------------------------

    def build(self, type_: Type, *, pointer: str, deprecated_carried: bool = False) -> Dict[str, Any]:
        """Build the root ``openAPIV3Schema`` for ``type_``.

        Args:
            type_: The canonical type describing the custom resource.
            pointer: JSON Pointer of the root schema in the emitted document.
            deprecated_carried: ``True`` when the caller already represents this
                type's ``deprecated`` flag elsewhere (a deprecated CRD version),
                so dropping the schema-level keyword costs no fidelity.

        Returns:
            A structural schema fragment.
        """
        schema = self._for_type(
            type_,
            pointer=pointer,
            stack=(type_.key,),
            deprecated_carried=deprecated_carried,
        )
        self._apply_extension_paths(type_, schema, pointer=pointer)
        return schema

    # --- named types --------------------------------------------------------

    def _for_type(
        self,
        type_: Type,
        *,
        pointer: str,
        stack: Tuple[str, ...],
        deprecated_carried: bool = False,
    ) -> Dict[str, Any]:
        """Build the schema for a named canonical type."""
        if type_.kind is TypeKind.RECORD:
            schema = self._record(type_, pointer=pointer, stack=stack)
        elif type_.kind is TypeKind.ENUM:
            schema = self._enum(type_, pointer=pointer)
        elif type_.kind is TypeKind.MAP:
            schema = self._map(type_, pointer=pointer, stack=stack)
        elif type_.kind is TypeKind.ALIAS:
            schema = (
                self._for_ref(type_.aliased, pointer=pointer, stack=stack)
                if type_.aliased is not None
                else self._free_form(pointer, "alias-without-target", f"type {type_.key!r}")
            )
        elif type_.kind is TypeKind.UNION:
            schema = self._union(type_, pointer=pointer)
        else:
            schema = self._scalar(type_, pointer=pointer)

        if type_.description:
            schema["description"] = type_.description
            self._tracker.record(f"{pointer}/description", Provenance.SOURCE)
        if type_.deprecated and not deprecated_carried:
            self._losses.record(
                LossKind.NA,
                "deprecated-keyword",
                "Kubernetes structural schemas have no `deprecated` keyword; the flag on "
                f"type {type_.name!r} is dropped",
                pointer=type_.key,
            )
        schema.update(_vendor_extensions(type_.extras))
        return _ordered_schema(self._reconcile_int_or_string(schema))

    def _record(self, type_: Type, *, pointer: str, stack: Tuple[str, ...]) -> Dict[str, Any]:
        """Build an object schema with ``properties`` and ``required``."""
        properties: Dict[str, Any] = {}
        for member in type_.fields:
            member_pointer = ProvenanceTracker.child(pointer, "properties", member.name)
            properties[member.name] = self._for_field(member, pointer=member_pointer, stack=stack)
            self._tracker.record(member_pointer, Provenance.SOURCE)

        schema: Dict[str, Any] = {"type": "object", "properties": properties}
        required = self._required_names(type_, properties)
        if required:
            schema["required"] = required
        return schema

    def _required_names(self, type_: Type, properties: Mapping[str, Any]) -> List[str]:
        """Resolve a record's ``required`` list, dropping names with no property.

        The source list (``required_names``, stamped by the CRD normalizer) wins
        when present so an import round-trips exactly; otherwise the non-nullable
        members are required, which is the inverse of how the normalizer reads a
        ``required`` array.
        """
        declared = type_.extras.get("required_names")
        if isinstance(declared, list):
            names = [name for name in declared if isinstance(name, str)]
        else:
            names = [f.name for f in type_.fields if f.type.nullable is False]

        kept = [name for name in names if name in properties]
        missing = [name for name in names if name not in properties]
        if missing:
            self._losses.record(
                LossKind.NA,
                "required-without-property",
                f"required names {sorted(missing)} have no declared property on "
                f"{type_.name!r} and would be rejected by Kubernetes; dropped",
                pointer=type_.key,
            )
        return kept

    def _enum(self, type_: Type, *, pointer: str) -> Dict[str, Any]:
        """Build an enumerated scalar schema, recovering the base type from its values."""
        values = [
            value.value if value.value is not None else value.name for value in type_.enum_values
        ]
        scalar = _scalar_type_of(values)
        if scalar is None:
            self._losses.record(
                LossKind.INFERRED,
                "untyped-enum",
                f"enum {type_.name!r} mixes value types; emitted as a free-form node "
                "because a structural schema needs one declared type",
                pointer=type_.key,
            )
            return self._free_form(pointer, "untyped-enum", f"type {type_.key!r}", record=False)
        schema: Dict[str, Any] = {"type": scalar}
        if values:
            schema["enum"] = values
        return schema

    def _map(self, type_: Type, *, pointer: str, stack: Tuple[str, ...]) -> Dict[str, Any]:
        """Build a free-form object keyed by string with a uniform value schema."""
        value_pointer = ProvenanceTracker.child(pointer, "additionalProperties")
        if type_.value_type is None:
            # A map with no value type permits any content: exactly what
            # `x-kubernetes-preserve-unknown-fields` means.
            return {"type": "object", PRESERVE_UNKNOWN_FIELDS: True}
        return {
            "type": "object",
            "additionalProperties": self._for_ref(
                type_.value_type, pointer=value_pointer, stack=stack
            ),
        }

    def _union(self, type_: Type, *, pointer: str) -> Dict[str, Any]:
        """Report a union as unrepresentable and fall back to a free-form node."""
        self._losses.record(
            LossKind.NA,
            "structural-union",
            f"Kubernetes structural schemas cannot express the union {type_.name!r} "
            f"({', '.join(type_.union_members) or 'no members'}): `oneOf`/`anyOf` may not "
            "carry a type, so the node is emitted as free-form",
            pointer=type_.key,
        )
        return self._free_form(pointer, "structural-union", f"type {type_.key!r}", record=False)

    def _scalar(self, type_: Type, *, pointer: str) -> Dict[str, Any]:
        """Build a constrained leaf, inferring its JSON type from the facets it carries."""
        constraints = self._constraints(type_.constraints, pointer=pointer, subject=type_.key)
        inferred = _infer_scalar_from_constraints(type_.constraints)
        if inferred is None:
            self._losses.record(
                LossKind.INFERRED,
                "untyped-scalar",
                f"scalar type {type_.name!r} carries no JSON type the target can declare; "
                "emitted as a free-form node",
                pointer=type_.key,
            )
            node = self._free_form(pointer, "untyped-scalar", f"type {type_.key!r}", record=False)
            node.update(constraints)
            return node
        schema: Dict[str, Any] = {"type": inferred}
        schema.update(constraints)
        return schema

    # --- use sites ----------------------------------------------------------

    def _for_field(
        self,
        member: CanonicalField,
        *,
        pointer: str,
        stack: Tuple[str, ...],
    ) -> Dict[str, Any]:
        """Build the property schema for one record member."""
        schema = self._for_ref(member.type, pointer=pointer, stack=stack)
        schema.update(self._constraints(member.constraints, pointer=pointer, subject=member.key))
        if member.default is not None:
            schema["default"] = member.default
            self._tracker.record(f"{pointer}/default", Provenance.SOURCE)
        if member.description:
            schema["description"] = member.description
        if member.deprecated:
            self._losses.record(
                LossKind.NA,
                "deprecated-keyword",
                "Kubernetes structural schemas have no `deprecated` keyword; the flag on "
                f"property {member.name!r} is dropped",
                pointer=member.key,
            )
        schema.update(_vendor_extensions(member.extras))
        return _ordered_schema(self._reconcile_int_or_string(schema))

    def _for_ref(
        self,
        ref: TypeRef,
        *,
        pointer: str,
        stack: Tuple[str, ...],
    ) -> Dict[str, Any]:
        """Build the schema for a use-site type reference, inlining named types."""
        if ref.is_list():
            items_pointer = ProvenanceTracker.child(pointer, "items")
            items = (
                self._for_ref(ref.item, pointer=items_pointer, stack=stack)
                if ref.item is not None
                else self._free_form(items_pointer, "untyped-array-item", "array items")
            )
            return {"type": "array", "items": items}

        if ref.name is None:
            return self._free_form(pointer, "free-form-node", pointer)

        if ref.name in _PRIMITIVE_TYPES:
            return {"type": ref.name}

        if ref.name == "null":
            self._losses.record(
                LossKind.NA,
                "null-type",
                "Kubernetes structural schemas have no `null` type; the member is emitted "
                "as a free-form node",
                pointer=pointer,
            )
            return self._free_form(pointer, "null-type", pointer, record=False)

        target = self._types.get(ref.name)
        if target is None:
            self._losses.record(
                LossKind.NA,
                "unresolved-type-reference",
                f"named type {ref.name!r} is not present in the model and structural "
                "schemas have no `$ref`; the member is emitted as a free-form node",
                pointer=pointer,
            )
            return self._free_form(pointer, "unresolved-type-reference", pointer, record=False)

        if target.key in stack:
            self._losses.record(
                LossKind.NA,
                "reference-cycle",
                f"type {ref.name!r} is reached from itself through {' → '.join(stack)}; a "
                "structural schema cannot express a cycle without `$ref`, so the member is "
                "emitted as a free-form node",
                pointer=pointer,
            )
            return self._free_form(pointer, "reference-cycle", pointer, record=False)

        self._tracker.record(pointer, Provenance.INFERRED, f"inlined named type {ref.name!r}")
        return self._for_type(target, pointer=pointer, stack=stack + (target.key,))

    # --- shared helpers -----------------------------------------------------

    def _free_form(
        self,
        pointer: str,
        subject: str,
        detail_subject: str,
        *,
        record: bool = True,
    ) -> Dict[str, Any]:
        """Return the node that stands in for "an object of unspecified shape".

        With ``preserve_unknown_fields`` the node keeps whatever a user puts in it;
        without it Kubernetes prunes the contents, which is recorded as a loss so
        the pruning is visible rather than silent.
        """
        node: Dict[str, Any] = {"type": "object"}
        if self._options.preserve_unknown_fields:
            node[PRESERVE_UNKNOWN_FIELDS] = True
        elif record:
            self._losses.record(
                LossKind.INFERRED,
                subject,
                f"{detail_subject} has no declared shape in the canonical model; emitted as "
                "`type: object`, whose contents Kubernetes prunes. Set the "
                "`preserve_unknown_fields` emit option to keep them",
                pointer=pointer,
            )
        return node

    def _constraints(
        self,
        constraints: Optional[Constraints],
        *,
        pointer: str,
        subject: str,
    ) -> Dict[str, Any]:
        """Emit the validation facets a CRD structural schema accepts.

        ``uniqueItems: true`` and formats Kubernetes does not know are dropped with
        a loss; every other facet maps straight across.
        """
        emitted: Dict[str, Any] = {}
        if constraints is None:
            return emitted
        for attribute, keyword in _CONSTRAINT_KEYWORDS:
            value = getattr(constraints, attribute)
            if value is not None:
                emitted[keyword] = value
        if constraints.unique_items:
            self._losses.record(
                LossKind.NA,
                "unique-items",
                "Kubernetes rejects `uniqueItems: true`; the constraint is dropped",
                pointer=subject,
            )
        if constraints.format:
            if constraints.format in KUBERNETES_KNOWN_FORMATS:
                emitted["format"] = constraints.format
            else:
                self._losses.record(
                    LossKind.NA,
                    "unsupported-format",
                    f"Kubernetes does not recognise `format: {constraints.format}`; the "
                    "keyword is dropped because it would validate nothing",
                    pointer=subject,
                )
        if emitted:
            self._tracker.record(pointer, Provenance.SOURCE, "validation facets")
        return emitted

    @staticmethod
    def _reconcile_int_or_string(schema: Dict[str, Any]) -> Dict[str, Any]:
        """Drop ``type`` from a node the source marked ``x-kubernetes-int-or-string``.

        The two are mutually exclusive: an int-or-string node is precisely one that
        declares no type, and Kubernetes rejects the pair.
        """
        if schema.get(INT_OR_STRING) is True:
            schema.pop("type", None)
        return schema

    def _apply_extension_paths(self, type_: Type, schema: Dict[str, Any], *, pointer: str) -> None:
        """Re-attach the ``x_kubernetes_paths`` map the CRD normalizer recorded.

        The normalizer walks the whole source schema tree and records every
        ``x-kubernetes-*`` bag against a path (``$``, ``$.properties.spec``, …).
        The canonical model keeps only the root and its direct members, so the two
        placeable path shapes are re-attached and anything deeper is reported.
        """
        paths = type_.extras.get("x_kubernetes_paths")
        if not isinstance(paths, Mapping):
            return
        properties = schema.get("properties")
        for path, bag in sorted(paths.items()):
            if not isinstance(path, str) or not isinstance(bag, Mapping):
                continue
            if path == "$":
                schema.update(bag)
                self._reconcile_int_or_string(schema)
                continue
            member = path[len("$.properties.") :] if path.startswith("$.properties.") else None
            if member and "." not in member and isinstance(properties, Mapping):
                node = properties.get(member)
                if isinstance(node, dict):
                    node.update(bag)
                    self._reconcile_int_or_string(node)
                    continue
            self._losses.record(
                LossKind.NA,
                "unplaceable-vendor-extension",
                f"vendor extensions at {path} describe a nested node the canonical model "
                "does not retain; they cannot be re-attached",
                pointer=ProvenanceTracker.child(pointer, path),
            )


def _infer_scalar_from_constraints(constraints: Optional[Constraints]) -> Optional[str]:
    """Guess a JSON-Schema scalar ``type`` for a canonical SCALAR from its facets.

    A canonical ``SCALAR`` type keeps its validation facets but not the JSON type
    it constrained, and a structural schema needs one. String facets
    (``pattern``/``minLength``/``maxLength``/a string ``format``) imply ``string``;
    numeric bounds imply ``number``; an ``enum`` implies its values' shared type.

    Args:
        constraints: The scalar's canonical constraints, or ``None``.

    Returns:
        ``"string"``/``"number"``/``"integer"``/``"boolean"``, or ``None`` when no
        facet implies a type.
    """
    if constraints is None:
        return None
    if constraints.enum:
        inferred = _scalar_type_of(constraints.enum)
        if inferred is not None:
            return inferred
    if (
        constraints.pattern is not None
        or constraints.min_length is not None
        or constraints.max_length is not None
        or constraints.format is not None
    ):
        return "string"
    if (
        constraints.minimum is not None
        or constraints.maximum is not None
        or constraints.exclusive_minimum is not None
        or constraints.exclusive_maximum is not None
        or constraints.multiple_of is not None
    ):
        return "number"
    return None


# ===========================================================================
# Planning: canonical model → CRD identities and versions
# ===========================================================================


def _sanitize_version_name(name: str, *, ordinal: int) -> Tuple[str, bool]:
    """Return a Kubernetes-shaped version name and whether it had to be replaced.

    Args:
        name: The canonical version name.
        ordinal: 1-based position, used to synthesize ``v1``/``v2``/… for a name
            Kubernetes would reject.

    Returns:
        ``(name, replaced)``.
    """
    if isinstance(name, str) and VERSION_NAME.match(name):
        return name, False
    return f"v{ordinal}", True


def _is_crd_sourced(api: CanonicalApi) -> bool:
    """Whether ``api`` came from a CRD import (its services carry ``k8s_crd_*`` extras)."""
    return any("k8s_crd_name" in service.extras for service in api.services)


def _ordered_crd_services(api: CanonicalApi) -> List[Service]:
    """Return CRD-bearing services in source-document order.

    The canonical model sorts services by key, but the normalizer keeps the stream's
    document order in ``k8s_crd_names``; emitting in that order makes a
    multi-document stream round-trip byte-for-byte at the model level.
    """
    services = [s for s in api.services if "k8s_crd_name" in s.extras]
    order = api.extras.get("k8s_crd_names")
    if isinstance(order, list):
        position = {name: index for index, name in enumerate(order) if isinstance(name, str)}
        services.sort(key=lambda s: (position.get(s.key, len(position)), s.key))
    else:
        services.sort(key=lambda s: s.key)
    return services


def _version_plan_from_type(type_: Type, *, ordinal: int, losses: LossTracker) -> _VersionPlan:
    """Build a version plan from the ``k8s_crd_*`` extras a CRD import stamped."""
    raw_name = type_.extras.get("k8s_crd_version")
    name, replaced = _sanitize_version_name(
        raw_name if isinstance(raw_name, str) else "", ordinal=ordinal
    )
    if replaced:
        losses.record(
            LossKind.INFERRED,
            "synthesized-version-name",
            f"version name {raw_name!r} is not a Kubernetes API version; emitted as {name!r}",
            pointer=type_.key,
        )
    warning = type_.extras.get("deprecation_warning")
    return _VersionPlan(
        name=name,
        served=type_.extras.get("served") is not False,
        storage=type_.extras.get("storage") is True,
        deprecated=type_.extras.get("deprecated") is True,
        deprecation_warning=warning if isinstance(warning, str) and warning else None,
        root_type=None if type_.extras.get("missing_openapi_v3_schema") else type_,
        schema_absent=bool(type_.extras.get("missing_openapi_v3_schema")),
        column_source=type_,
    )


def _apply_version_overrides(
    plan: _CrdPlan,
    options: K8sCrdEmitOptions,
    losses: LossTracker,
) -> None:
    """Apply the ``served``/``storage`` emit options and guarantee one storage version.

    Kubernetes requires exactly one served version to be the storage version. When
    the model names none — or names several — one is chosen and the choice is
    recorded, because emitting the document as-is would simply be rejected.
    """
    if options.served is not None:
        for version in plan.versions:
            version.served = options.served

    if not plan.versions:
        return

    requested = options.storage_version
    if requested:
        matches = [v for v in plan.versions if v.name == requested]
        if matches:
            for version in plan.versions:
                version.storage = version.name == requested
            return
        losses.record(
            LossKind.INFERRED,
            "unknown-storage-version",
            f"storage_version={requested!r} names no emitted version of {plan.name!r}; "
            "the model's own storage version is used instead",
            pointer=plan.name,
        )

    storage = [v for v in plan.versions if v.storage]
    if len(storage) == 1:
        return

    chosen = storage[0] if storage else plan.versions[0]
    for version in plan.versions:
        version.storage = version is chosen
    losses.record(
        LossKind.INFERRED,
        "synthesized-storage-version",
        f"{plan.name!r} declares {len(storage)} storage versions; Kubernetes requires "
        f"exactly one, so {chosen.name!r} is marked as storage",
        pointer=plan.name,
    )


def _plan_from_crd_extras(
    api: CanonicalApi,
    options: K8sCrdEmitOptions,
    losses: LossTracker,
) -> List[_CrdPlan]:
    """Rebuild the CRD identities a Kubernetes import recorded in ``extras``."""
    claimed: set = set()
    plans: List[_CrdPlan] = []
    services = _ordered_crd_services(api)

    # `kind`/`plural`/`singular`/`short_names` name **one** resource. Applying them
    # across a multi-document stream would give every CRD the same `metadata.name`,
    # which Kubernetes rejects — so they are declined, loudly, rather than obeyed
    # into an inapplicable document. Group and scope stay: they are stream-wide.
    per_resource = {
        "kind": options.kind,
        "plural": options.plural,
        "singular": options.singular,
        "short_names": options.short_names,
    }
    ignored = sorted(name for name, value in per_resource.items() if value is not None)
    if len(services) > 1 and ignored:
        losses.record(
            LossKind.NA,
            "per-resource-option-ignored",
            f"the model carries {len(services)} CustomResourceDefinitions, so the "
            f"single-resource option(s) {ignored} would give them all one name; they are "
            "ignored and each resource keeps its own naming",
        )
        per_resource = dict.fromkeys(per_resource, None)

    for service in services:
        extras = service.extras
        group = options.group or _first_str(extras.get("k8s_crd_group")) or DEFAULT_GROUP
        kind = (
            per_resource["kind"]
            or _first_str(extras.get("k8s_crd_kind"), service.name)
            or "Resource"
        )
        plural = per_resource["plural"] or _first_str(extras.get("k8s_crd_plural")) or _pluralize(kind)
        singular = per_resource["singular"] or _first_str(extras.get("k8s_crd_singular")) or kind.lower()
        if per_resource["short_names"] is not None:
            short_names = [name for name in per_resource["short_names"] if name]
        else:
            raw_short = extras.get("k8s_crd_short_names")
            short_names = [n for n in raw_short if isinstance(n, str)] if isinstance(raw_short, list) else []
        scope = options.resolved_scope() or _first_str(extras.get("k8s_crd_scope")) or "Namespaced"

        source_group = _first_str(extras.get("k8s_crd_group"))
        source_kind = _first_str(extras.get("k8s_crd_kind"))
        members = [
            type_
            for type_ in api.types
            if type_.extras.get("k8s_crd_group") == source_group
            and type_.extras.get("k8s_crd_kind") == source_kind
        ]
        claimed.update(type_.key for type_ in members)

        plan = _CrdPlan(
            name=f"{plural}.{group}",
            group=group,
            kind=kind,
            plural=plural,
            singular=singular,
            short_names=short_names,
            scope=scope,
            versions=[
                _version_plan_from_type(type_, ordinal=index + 1, losses=losses)
                for index, type_ in enumerate(sorted(members, key=lambda t: t.key))
            ],
        )
        if not plan.versions:
            plan.versions = [
                _VersionPlan(
                    name=DEFAULT_VERSION,
                    served=True,
                    storage=True,
                    deprecated=False,
                    deprecation_warning=None,
                    root_type=None,
                )
            ]
            losses.record(
                LossKind.INFERRED,
                "synthesized-version",
                f"{plan.name!r} carries no versioned schema; a bare {DEFAULT_VERSION!r} "
                "version is emitted so the CRD is applicable",
                pointer=service.key,
            )
        plans.append(plan)

    inlinable = {t.name: t for t in api.types if t.key not in claimed}
    for plan in plans:
        plan.inlinable = dict(inlinable)
    return plans


def _resolve_group(api: CanonicalApi, options: K8sCrdEmitOptions, losses: LossTracker) -> str:
    """Choose ``spec.group`` for a model that was not imported from a CRD."""
    if options.group:
        return options.group
    namespace = _first_str(api.identity.namespace)
    if namespace and DNS_SUBDOMAIN.match(namespace.lower()):
        return namespace.lower()
    losses.record(
        LossKind.INFERRED,
        "synthesized-group",
        f"the model names no Kubernetes API group; {DEFAULT_GROUP!r} is used. Set the "
        "`group` emit option to the group your cluster expects",
    )
    return DEFAULT_GROUP


def _select_root_type(api: CanonicalApi, options: K8sCrdEmitOptions) -> Optional[Type]:
    """Pick the canonical type that describes the custom resource.

    Preference order: the type the ``kind`` option names, the artifact title, the
    identity name, the only type, then the first type by key — the same rule the
    JSON Schema emitter uses to find a document root.
    """
    if not api.types:
        return None
    by_name = {type_.name: type_ for type_ in api.types}
    for candidate in (options.kind, api.title, api.identity.name):
        if isinstance(candidate, str) and candidate in by_name:
            return by_name[candidate]
    if len(api.types) == 1:
        return api.types[0]
    return sorted(api.types, key=lambda t: t.key)[0]


def _spec_wrapper(root: Type, kind: str) -> Type:
    """Wrap ``root`` in the ``spec`` property Kubernetes custom resources expect.

    A custom resource's own fields live under ``spec``; ``apiVersion``, ``kind`` and
    ``metadata`` are supplied by the API server. A canonical type that is not
    already shaped like a resource root is therefore nested rather than spread
    across the top level, where it would collide with those reserved names.
    """
    return Type(
        key=f"{root.key}.crd-root",
        name=kind,
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(
                key=f"{root.key}.crd-root.spec",
                name="spec",
                type=TypeRef(name=root.name, nullable=False),
            )
        ],
    )


def _plan_derived(
    api: CanonicalApi,
    options: K8sCrdEmitOptions,
    losses: LossTracker,
) -> List[_CrdPlan]:
    """Derive a single CRD identity for a model that carries no Kubernetes extras."""
    root = _select_root_type(api, options)
    kind = (
        options.kind
        or _kind_name(_first_str(root.name if root else None, api.title, api.identity.name) or "")
        or "Resource"
    )
    plural = options.plural or _dns_label(_pluralize(kind)) or _pluralize(kind.lower())
    singular = options.singular or _dns_label(kind) or kind.lower()
    group = _resolve_group(api, options, losses)

    declared = _first_str(options.version, api.version)
    name, replaced = _sanitize_version_name(declared or "", ordinal=1)
    if replaced:
        losses.record(
            LossKind.INFERRED,
            "synthesized-version-name",
            (
                f"version {declared!r} is not a Kubernetes API version"
                if declared
                else "the model names no API version"
            )
            + f"; {name!r} is emitted. Set the `version` emit option to choose one",
        )

    schema_root = root
    column_prefix = ""
    if root is not None:
        wraps = root.kind is not TypeKind.RECORD or not any(
            member.name in {"spec", "status"} for member in root.fields
        )
        if wraps:
            schema_root = _spec_wrapper(root, kind)
            column_prefix = ".spec"
            losses.record(
                LossKind.INFERRED,
                "synthesized-spec-wrapper",
                f"type {root.name!r} is not shaped like a Kubernetes resource root; it is "
                "nested under `spec`, where a custom resource's own fields belong",
                pointer=root.key,
            )
    else:
        losses.record(
            LossKind.INFERRED,
            "no-schema",
            "the model declares no types; the CRD is emitted with a free-form schema",
        )

    plan = _CrdPlan(
        name=f"{plural}.{group}",
        group=group,
        kind=kind,
        plural=plural,
        singular=singular,
        short_names=[n for n in (options.short_names or []) if n],
        scope=options.resolved_scope() or "Namespaced",
        versions=[
            _VersionPlan(
                name=name,
                served=True,
                storage=True,
                deprecated=False,
                deprecation_warning=None,
                root_type=schema_root,
                column_source=root,
                column_prefix=column_prefix,
            )
        ],
        inlinable={type_.name: type_ for type_ in api.types},
    )
    return [plan]


def _plan_crds(
    api: CanonicalApi,
    options: K8sCrdEmitOptions,
    losses: LossTracker,
) -> List[_CrdPlan]:
    """Plan every CustomResourceDefinition document this model emits."""
    plans = _plan_from_crd_extras(api, options, losses) if _is_crd_sourced(api) else []
    if not plans:
        plans = _plan_derived(api, options, losses)
    for plan in plans:
        _apply_version_overrides(plan, options, losses)
    return plans


# ===========================================================================
# Printer columns
# ===========================================================================


def _printer_column(
    member: CanonicalField,
    spec: Mapping[str, Any],
    *,
    prefix: str,
    losses: LossTracker,
) -> Optional[Dict[str, Any]]:
    """Render one ``additionalPrinterColumns`` entry for a marked field.

    Kubernetes accepts only ``integer``/``number``/``string``/``boolean``/``date``
    columns, so a field whose canonical type maps to none of them is reported and
    skipped rather than emitted as a column the API server would reject.

    Args:
        member: The marked canonical field.
        spec: The mark's payload — ``{}`` for a bare ``True``, otherwise the
            ``name``/``type``/``description``/``priority``/``jsonPath`` overrides.
        prefix: JSONPath prefix for the field's location (``""`` or ``".spec"``).
        losses: Loss sink for a field that cannot become a column.

    Returns:
        The column mapping, or ``None`` when the field cannot be rendered.
    """
    declared = spec.get("type")
    if isinstance(declared, str) and declared:
        if declared not in PRINTER_COLUMN_TYPES:
            losses.record(
                LossKind.NA,
                "printer-column-untyped",
                f"printer column for {member.name!r} declares type {declared!r}, which "
                f"Kubernetes does not render ({', '.join(sorted(PRINTER_COLUMN_TYPES))}); skipped",
                pointer=member.key,
            )
            return None
        column_type: Optional[str] = declared
    elif member.constraints is not None and member.constraints.format in {"date", "date-time"}:
        column_type = "date"
    else:
        column_type = _SCALAR_PRINTER_COLUMN_TYPES.get(member.type.name or "")

    if column_type is None:
        losses.record(
            LossKind.NA,
            "printer-column-untyped",
            f"field {member.name!r} is marked as a printer column but its type is not one "
            f"Kubernetes can render ({', '.join(sorted(PRINTER_COLUMN_TYPES))}); skipped",
            pointer=member.key,
        )
        return None

    column: Dict[str, Any] = {
        "name": _first_str(spec.get("name")) or member.name,
        "type": column_type,
        "jsonPath": _first_str(spec.get("jsonPath")) or f"{prefix}.{member.name}",
    }
    description = _first_str(spec.get("description"), member.description)
    if description:
        column["description"] = description
    priority = spec.get("priority")
    if isinstance(priority, int) and not isinstance(priority, bool):
        column["priority"] = priority
    return column


def _printer_columns(
    version: _VersionPlan,
    options: K8sCrdEmitOptions,
    losses: LossTracker,
) -> List[Dict[str, Any]]:
    """Collect the printer columns marked on a version's fields, in field order."""
    source = version.column_source
    if not options.printer_columns or source is None:
        return []
    columns: List[Dict[str, Any]] = []
    for member in source.fields:
        mark = member.extras.get(PRINTER_COLUMN_EXTRA)
        if not mark:
            continue
        spec = mark if isinstance(mark, Mapping) else {}
        column = _printer_column(member, spec, prefix=version.column_prefix, losses=losses)
        if column is not None:
            columns.append(column)
    return columns


# ===========================================================================
# The emitter
# ===========================================================================


class K8sCrdEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a Kubernetes CustomResourceDefinition."""

    key = "k8s-crd"
    format = K8S_CRD_FORMAT
    label = "Kubernetes CRD"
    description = (
        "Export as an apiextensions.k8s.io/v1 CustomResourceDefinition whose "
        "openAPIV3Schema is a Kubernetes structural schema (.crd.yaml)."
    )
    icon = "box"
    paradigm = ApiParadigm.DATA_SCHEMA
    multi_file = False
    options_model = K8sCrdEmitOptions

    OUTPUT_MEDIA_TYPE = "application/yaml"

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what a CRD structural schema carries faithfully.

        Operations and events have no representation in a resource definition, and
        a structural schema cannot express a discriminated union — ``oneOf`` may
        not carry a ``type``. Records, nullability (through ``required``) and the
        validation facets Kubernetes honours all survive.
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
        """Return the CustomResourceDefinition degradation rules."""
        return K8sCrdFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[K8sCrdEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one or more CustomResourceDefinition documents.

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults reproduce a CRD import faithfully.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the CRD
            YAML text, with the provenance of every emitted value and a loss for
            every construct the structural-schema restrictions cost.
        """
        options = (
            opts
            if isinstance(opts, K8sCrdEmitOptions)
            else K8sCrdEmitOptions.model_validate(opts.model_dump() if opts else {})
        )
        writer = _K8sCrdWriter(api, options)
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


class _K8sCrdWriter:
    """Render the planned CRD documents as YAML, tracking provenance and losses."""

    def __init__(self, api: CanonicalApi, options: K8sCrdEmitOptions) -> None:
        """Plan the emission for ``api`` under ``options``."""
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self._plans = _plan_crds(api, options, self.losses)
        self.output_path = _output_path(api, self._plans)

    def render(self) -> str:
        """Return the emitted YAML text (one document per planned CRD)."""
        self._record_unrepresentable_constructs()
        documents = [self._document(plan, index) for index, plan in enumerate(self._plans)]
        if self._options.pretty_print:
            return yaml.safe_dump_all(
                documents,
                sort_keys=False,
                default_flow_style=False,
                allow_unicode=True,
                explicit_start=len(documents) > 1,
            )
        return yaml.safe_dump_all(documents, default_flow_style=True, allow_unicode=True)

    def _record_unrepresentable_constructs(self) -> None:
        """Report the canonical constructs a resource definition has no place for."""
        operations = sum(len(service.operations) for service in self._api.services)
        if operations:
            self.losses.record(
                LossKind.NA,
                "operations-dropped",
                f"a CustomResourceDefinition describes a resource schema, not endpoints; "
                f"{operations} operation(s) are omitted",
            )
        if self._api.channels:
            self.losses.record(
                LossKind.NA,
                "channels-dropped",
                f"a CustomResourceDefinition has no event/channel representation; "
                f"{len(self._api.channels)} channel(s) are omitted",
            )
        if self._api.servers:
            self.losses.record(
                LossKind.NA,
                "servers-dropped",
                "a CustomResourceDefinition is applied to a cluster rather than served from "
                "a URL; the model's servers are omitted",
            )

    def _document(self, plan: _CrdPlan, index: int) -> Dict[str, Any]:
        """Render one CustomResourceDefinition mapping."""
        pointer = f"/{index}" if len(self._plans) > 1 else ""
        names: Dict[str, Any] = {
            "kind": plan.kind,
            "plural": plan.plural,
            "singular": plan.singular,
        }
        if plan.short_names:
            names["shortNames"] = list(plan.short_names)
        for token in ("kind", "plural", "singular"):
            self.tracker.record(f"{pointer}/spec/names/{token}", Provenance.SOURCE)
        self.tracker.record(f"{pointer}/apiVersion", Provenance.DEFAULT, "the CRD API version")
        self.tracker.record(f"{pointer}/kind", Provenance.DEFAULT, "the resource kind")
        self.tracker.record(f"{pointer}/metadata/name", Provenance.INFERRED, "`<plural>.<group>`")
        self.tracker.record(f"{pointer}/spec/group", Provenance.SOURCE)
        self.tracker.record(f"{pointer}/spec/scope", Provenance.SOURCE)

        return {
            "apiVersion": CRD_API_VERSION,
            "kind": CRD_KIND,
            "metadata": {"name": plan.name},
            "spec": {
                "group": plan.group,
                "names": names,
                "scope": plan.scope,
                "versions": [
                    self._version(plan, version, f"{pointer}/spec/versions/{ordinal}")
                    for ordinal, version in enumerate(plan.versions)
                ],
            },
        }

    def _version(self, plan: _CrdPlan, version: _VersionPlan, pointer: str) -> Dict[str, Any]:
        """Render one ``spec.versions[]`` entry."""
        entry: Dict[str, Any] = {
            "name": version.name,
            "served": version.served,
            "storage": version.storage,
        }
        self.tracker.record(f"{pointer}/name", Provenance.SOURCE)
        if version.deprecated:
            entry["deprecated"] = True
            if version.deprecation_warning:
                entry["deprecationWarning"] = version.deprecation_warning

        schema = self._schema(plan, version, f"{pointer}/schema/openAPIV3Schema")
        if schema is not None:
            entry["schema"] = {"openAPIV3Schema": schema}
            if self._options.status_subresource and _declares_status(schema):
                entry["subresources"] = {"status": {}}
                self.tracker.record(
                    f"{pointer}/subresources/status",
                    Provenance.INFERRED,
                    "the resource declares a `status` property",
                )

        columns = _printer_columns(version, self._options, self.losses)
        if columns:
            entry["additionalPrinterColumns"] = columns
            self.tracker.record(
                f"{pointer}/additionalPrinterColumns",
                Provenance.INFERRED,
                "derived from fields marked `printer_column`",
            )
        return entry

    def _schema(
        self,
        plan: _CrdPlan,
        version: _VersionPlan,
        pointer: str,
    ) -> Optional[Dict[str, Any]]:
        """Build one version's structural ``openAPIV3Schema``, or ``None`` to omit it."""
        if version.schema_absent:
            return None
        types = dict(plan.inlinable)
        if version.root_type is not None:
            types.setdefault(version.root_type.name, version.root_type)
        builder = _StructuralSchemaBuilder(types, self._options, self.tracker, self.losses)
        if version.root_type is None:
            return {"type": "object", PRESERVE_UNKNOWN_FIELDS: True}
        return builder.build(
            version.root_type,
            pointer=pointer,
            deprecated_carried=version.deprecated,
        )


def _declares_status(schema: Mapping[str, Any]) -> bool:
    """Whether a root schema declares an object ``status`` property.

    Kubernetes only accepts a status subresource when ``status`` is a nested object
    — a scalar property that happens to be called ``status`` (an enum of states,
    say) is an ordinary field and must not be split off into a subresource.
    """
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return False
    status = properties.get("status")
    return isinstance(status, Mapping) and status.get("type") == "object"


def _output_path(api: CanonicalApi, plans: Sequence[_CrdPlan]) -> str:
    """Return the emitted file name: the CRD's own name, or the artifact's for a stream."""
    if len(plans) == 1:
        base = plans[0].name
    else:
        base = _first_str(api.title, api.identity.name) or "customresourcedefinitions"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", base).strip("-") or "customresourcedefinitions"
    return f"{safe}.crd.yaml"
