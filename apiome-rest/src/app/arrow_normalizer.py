"""Apache Arrow → canonical model normalizer — FMT-4.5 (#5438).

Maps a parsed :class:`~app.arrow_schema.ArrowDocument` — from any of Arrow's three
surfaces — onto a :class:`~app.canonical_model.CanonicalApi` with the
:attr:`~app.canonical_model.ApiParadigm.DATA_SCHEMA` paradigm.

An Arrow schema is one table's columns, so the projection is one root ``RECORD`` holding
one field per column, plus a named type for every nested ``struct``, ``map`` and ``union``
beneath them. Column order is positional in Arrow and is preserved as ``field_number``,
which is what lets the model be key-sorted (so its fingerprint is order-invariant) without
losing the fact that ``total_amount`` is column 15.

**The projection is deliberately surface-blind.** Nothing here records whether the schema
arrived as JSON, as IPC bytes or from a Flight endpoint, and the identity is derived from
the *document* — a Flight descriptor's path, or a ``name`` in the schema metadata — never
from the filename. That is what makes FMT-4.5's first acceptance criterion structural: an
IPC schema and its JSON twin do not merely resemble each other, they normalize to the same
model, and a golden snapshot of one is byte-identical to a snapshot of the other.

**What is modelled and what is declared.** Nested types are modelled exactly. A
dictionary-encoded field carries its *value* type — the encoding is a layout, and the index
type and ordering are recorded. A decimal carries the ``decimal`` scalar with its
precision, scale and storage width recorded, because the canonical constraint vocabulary
has no precision facet. Everything in that second category is a counted, located entry in
``extras['arrow']['capability_limits']`` with the reviewed wording from
:data:`app.arrow_schema.LIMIT_DETAILS` — a capability limit, never a silent omission.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .arrow_schema import (
    ARROW_EXTENSION_METADATA_KEY,
    ARROW_EXTENSION_NAME_KEY,
    ArrowDictionaryEncoding,
    ArrowDocument,
    ArrowField,
    ArrowLimit,
    ArrowSchema,
    ArrowType,
    FlightInfo,
    LimitRecorder,
)
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

__all__ = ["ARROW_EXTRAS_KEY", "ArrowNormalizer"]

#: The key the Arrow projection record sits under in ``CanonicalApi.extras``.
ARROW_EXTRAS_KEY = "arrow"

#: The name the root record takes when the document names nothing.
#:
#: An Arrow schema genuinely has no name — it is the shape of a record batch, not a
#: declaration — so this is the honest default. A Flight descriptor *does* name its
#: dataset, and a schema may carry a ``name`` in its metadata; both are preferred.
DEFAULT_ROOT_NAME = "Schema"

#: Schema-metadata key read as the schema's name.
_NAME_METADATA_KEY = "name"

#: Metadata keys read as a description, in precedence order. Arrow defines no
#: documentation key, so these are conventions rather than part of the format; a key that
#: is consumed here is not repeated in ``arrow_metadata``.
_DESCRIPTION_METADATA_KEYS: Tuple[str, ...] = ("description", "comment", "doc")

#: Metadata keys the projection consumes rather than carrying through verbatim.
_CONSUMED_METADATA_KEYS = frozenset(
    (ARROW_EXTENSION_NAME_KEY, ARROW_EXTENSION_METADATA_KEY, *_DESCRIPTION_METADATA_KEYS)
)

#: Arrow ``int`` (bit width, signedness) -> canonical scalar.
_INT_SCALARS: Dict[Tuple[int, bool], str] = {
    (8, True): "int8",
    (16, True): "int16",
    (32, True): "int32",
    (64, True): "int64",
    (8, False): "uint8",
    (16, False): "uint16",
    (32, False): "uint32",
    (64, False): "uint64",
}

#: Arrow floating-point precision -> canonical scalar. ``HALF`` has no canonical scalar of
#: its own and takes the next width up, which is recorded as a declared limit.
_FLOAT_SCALARS: Dict[str, str] = {"HALF": "float", "SINGLE": "float", "DOUBLE": "double"}

#: Arrow temporal type name -> the canonical ``format`` hint it carries. All four project
#: onto ``string``: the canonical model has no resolution facet, and a timestamp rendered
#: as text is what every downstream projection of this model emits.
_TEMPORAL_FORMATS: Dict[str, str] = {
    "date": "date",
    "time": "time",
    "timestamp": "date-time",
    "duration": "duration",
}

#: Type names that are the *same value space* as an ordinary counterpart and differ only in
#: memory layout, mapped to the canonical scalar that counterpart projects onto.
_LAYOUT_VARIANT_SCALARS: Dict[str, str] = {
    "largeutf8": "string",
    "utf8view": "string",
    "largebinary": "bytes",
    "binaryview": "bytes",
}

#: Arrow list-shaped type names, mapped to whether the variant is a layout variant.
_LIST_TYPE_NAMES: Dict[str, bool] = {
    "list": False,
    "fixedsizelist": False,
    "largelist": True,
    "listview": True,
    "largelistview": True,
}


def _sanitize(name: str) -> str:
    """Return ``name`` reduced to characters a canonical key may carry.

    Arrow field names are arbitrary strings — an analytical table's columns are routinely
    named with spaces or punctuation. Only the characters that would collide with the
    canonical key grammar's ``.`` separator are folded; everything else survives, because
    rewriting every column name would make the imported model unrecognizable beside the
    table it describes.

    Args:
        name: The source name.

    Returns:
        The folded name, or ``"field"`` when nothing survives.
    """
    folded = "".join(
        character if (character.isalnum() or character in "-_$@") else "_" for character in name
    )
    return folded or "field"


class _TypeCollector:
    """Accumulates the named types a schema's nested fields require.

    Names are built from the field *path*, so two ``address`` structs under different
    columns cannot collide, and a counter resolves the collisions a path still allows
    (two columns whose sanitized names fold together). The collector owns naming so that
    the walk below never has to think about uniqueness.
    """

    def __init__(self, namespace: Optional[str]) -> None:
        self._namespace = namespace
        self._types: List[Type] = []
        self._claimed: set[str] = set()

    def reserve(self, name: str) -> None:
        """Mark a name as taken before the walk starts.

        The root record's name is claimed this way, because a top-level column named
        ``Schema`` would otherwise produce a nested type with the root's own key.
        """
        self._claimed.add(name)

    def claim(self, path: Sequence[str]) -> Tuple[str, str]:
        """Reserve a unique name for a nested type at ``path``.

        Args:
            path: The field path from the schema root, root name excluded.

        Returns:
            The type's ``(name, key)``.
        """
        base = "_".join(_sanitize(segment) for segment in path) or "value"
        name = base
        suffix = 2
        while name in self._claimed:
            name = f"{base}_{suffix}"
            suffix += 1
        self._claimed.add(name)
        return name, Keys.type(name, self._namespace)

    def add(self, type_: Type) -> None:
        """Record a completed named type."""
        self._types.append(type_)

    def types(self) -> List[Type]:
        """Return the collected types, in the order they were completed."""
        return list(self._types)


def _metadata_map(
    metadata: Sequence[Tuple[str, str]], *, consumed: Sequence[str] = ()
) -> Dict[str, str]:
    """Return metadata as a mapping, dropping the keys the projection consumed."""
    skip = _CONSUMED_METADATA_KEYS.union(consumed)
    return {key: value for key, value in metadata if key not in skip}


def _description_from(metadata: Sequence[Tuple[str, str]]) -> Optional[str]:
    """Return the first metadata value that reads as documentation, when there is one."""
    lookup = dict(metadata)
    for key in _DESCRIPTION_METADATA_KEYS:
        value = lookup.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _type_extra(type_: ArrowType) -> Dict[str, Any]:
    """Render an Arrow type descriptor for ``extras``, so the source type is recoverable."""
    return {"name": type_.name, **dict(type_.parameters)}


def _dictionary_extra(dictionary: ArrowDictionaryEncoding) -> Dict[str, Any]:
    """Render a dictionary encoding for ``extras`` (index type and ordering, never the id)."""
    return {
        "indexType": _type_extra(dictionary.index_type),
        "isOrdered": dictionary.is_ordered,
    }


def _identity_of(document: ArrowDocument) -> Tuple[str, Optional[str]]:
    """Derive the model's ``(name, namespace)`` from the document alone.

    Precedence: a Flight descriptor's path names the dataset (its last segment is the
    name, the leading segments the namespace — a Flight ``PATH`` is a catalog/schema/table
    coordinate); then a ``CMD`` descriptor's command; then a ``name`` in the schema
    metadata; then :data:`DEFAULT_ROOT_NAME`.

    The filename is deliberately not consulted. An IPC schema and its JSON twin have
    different filenames and describe the same table, and an identity that disagreed about
    which one it was would make them two APIs rather than one.

    Args:
        document: The parsed document.

    Returns:
        The identity name and namespace.
    """
    flight = document.flight
    if flight is not None and flight.descriptor is not None:
        path = flight.descriptor.path
        if path:
            namespace = ".".join(_sanitize(segment) for segment in path[:-1]) or None
            return _sanitize(path[-1]), namespace
        if flight.descriptor.cmd:
            return _sanitize(flight.descriptor.cmd), None
    declared = document.schema.metadata_value(_NAME_METADATA_KEY)
    if isinstance(declared, str) and declared.strip():
        return _sanitize(declared.strip()), None
    return DEFAULT_ROOT_NAME, None


def _flight_extra(flight: FlightInfo) -> Dict[str, Any]:
    """Render the Flight envelope for ``extras``.

    Endpoints describe where the data can be fetched, not what it is, so they are recorded
    here and become no canonical service — the fact, and its reason, is a declared limit.
    """
    rendered: Dict[str, Any] = {}
    if flight.descriptor is not None:
        descriptor: Dict[str, Any] = {"type": flight.descriptor.type}
        if flight.descriptor.path:
            descriptor["path"] = list(flight.descriptor.path)
        if flight.descriptor.cmd is not None:
            descriptor["cmd"] = flight.descriptor.cmd
        rendered["descriptor"] = descriptor
    if flight.endpoints:
        rendered["endpoints"] = [
            {
                **({"ticket": endpoint.ticket} if endpoint.ticket is not None else {}),
                **({"locations": list(endpoint.locations)} if endpoint.locations else {}),
            }
            for endpoint in flight.endpoints
        ]
    if flight.total_records is not None:
        rendered["total_records"] = flight.total_records
    if flight.total_bytes is not None:
        rendered["total_bytes"] = flight.total_bytes
    if flight.ordered is not None:
        rendered["ordered"] = flight.ordered
    return rendered


def _limits_payload(limits: Sequence[ArrowLimit]) -> List[Dict[str, Any]]:
    """Render the reader's declared limits as the extras bag's ``capability_limits``."""
    return [
        {
            "construct": limit.construct,
            "detail": limit.detail,
            "count": limit.count,
            "locations": list(limit.locations),
        }
        for limit in limits
    ]


class _FieldKeys:
    """Allocates unique canonical field keys within one record.

    Two things make a bare ``Keys.field(owner, name)`` unsafe here. Arrow allows a record
    to declare the same field name twice, and an Arrow column name may contain the ``.``
    the canonical key grammar uses as its separator (``user.id`` is an ordinary column in
    an analytical table). The *name* is kept exactly as the table spells it; only the key
    is folded and disambiguated.
    """

    def __init__(self) -> None:
        self._claimed: Set[str] = set()

    def allocate(self, owner_key: str, name: str) -> str:
        """Return a unique key for ``name`` under ``owner_key``."""
        base = _sanitize(name)
        candidate = base
        suffix = 2
        while Keys.field(owner_key, candidate) in self._claimed:
            candidate = f"{base}_{suffix}"
            suffix += 1
        key = Keys.field(owner_key, candidate)
        self._claimed.add(key)
        return key


class _Projection:
    """One document's walk from Arrow fields to canonical types.

    Holds the three things every step needs — the type collector, the limit recorder and
    the root's namespace — so the recursive helpers stay pure functions of a field.
    """

    def __init__(self, namespace: Optional[str], limits: LimitRecorder) -> None:
        self.collector = _TypeCollector(namespace)
        self.limits = limits
        self.namespace = namespace

    # --- fields ----------------------------------------------------------

    def field(
        self,
        source: ArrowField,
        *,
        owner_key: str,
        path: Tuple[str, ...],
        position: int,
        keys: "_FieldKeys",
    ) -> CanonicalField:
        """Project one Arrow field onto a canonical field.

        Args:
            source: The Arrow field.
            owner_key: Key of the record that holds it.
            path: The field's path from the schema root, root excluded.
            position: The column's 1-based position within its record.
            keys: The owning record's key allocator.

        Returns:
            The canonical field.
        """
        location = "/".join(path)
        extras: Dict[str, Any] = {"arrow_type": _type_extra(source.type)}

        if source.dictionary is not None:
            # The field's own type is already the dictionary's *value* type, in both
            # surfaces — the JSON form states it that way and the pyarrow bridge unwraps
            # `pa.dictionary` to it — so the encoding is recorded and nothing is unwrapped
            # here.
            extras["arrow_dictionary"] = _dictionary_extra(source.dictionary)
            self.limits.record("arrow.dictionary_encoding", location=location)

        extension = source.extension_name
        if extension is not None:
            extras["arrow_extension"] = {
                "name": extension,
                "metadata": source.metadata_value(ARROW_EXTENSION_METADATA_KEY) or "",
            }
            self.limits.record("arrow.extension_type", location=location)

        reference, constraints = self.type_ref(
            source.type,
            source.children,
            path=path,
            nullable=source.nullable,
            location=location,
            extras=extras,
        )

        metadata = _metadata_map(source.metadata)
        if metadata:
            extras["arrow_metadata"] = metadata

        return CanonicalField(
            key=keys.allocate(owner_key, source.name),
            name=source.name,
            type=reference,
            field_number=position,
            constraints=constraints,
            description=_description_from(source.metadata),
            extras=extras,
        )

    def record_fields(
        self, children: Sequence[ArrowField], *, owner_key: str, path: Tuple[str, ...]
    ) -> List[CanonicalField]:
        """Project one record's children, allocating a unique key for each.

        Arrow permits two fields of a struct to share a name, and a canonical field key is
        the record's key plus the field's — so the keys are allocated here rather than
        derived, and a repeat gets a suffix instead of silently shadowing its twin.
        """
        keys = _FieldKeys()
        return [
            self.field(
                child,
                owner_key=owner_key,
                path=path + (child.name,),
                position=index + 1,
                keys=keys,
            )
            for index, child in enumerate(children)
        ]

    # --- types -----------------------------------------------------------

    def type_ref(
        self,
        type_: ArrowType,
        children: Sequence[ArrowField],
        *,
        path: Tuple[str, ...],
        nullable: bool,
        location: str,
        extras: Dict[str, Any],
    ) -> Tuple[TypeRef, Optional[Constraints]]:
        """Project one Arrow type onto a canonical reference plus its constraints.

        Named types (a ``struct``, ``map`` or ``union``) are created as a side effect on
        the collector; scalars and lists resolve inline.

        Args:
            type_: The Arrow type descriptor.
            children: The field's children, as the type's shape requires.
            path: The owning field's path from the schema root.
            nullable: Whether the owning field admits nulls.
            location: The path rendered for limit locations.
            extras: The owning field's extras bag, added to in place.

        Returns:
            The reference and the constraints the type implies, if any.
        """
        name = type_.name

        if name == "struct":
            child_name, child_key = self.collector.claim(path)
            self.collector.add(
                Type(
                    key=child_key,
                    name=child_name,
                    kind=TypeKind.RECORD,
                    namespace=self.namespace,
                    fields=self.record_fields(children, owner_key=child_key, path=path),
                    extras={"arrow_kind": "struct"},
                )
            )
            return TypeRef(name=child_key, nullable=nullable), None

        if name in _LIST_TYPE_NAMES:
            if _LIST_TYPE_NAMES[name]:
                self.limits.record("arrow.physical_layout", location=location)
            element = children[0]
            # A canonical `TypeRef` carries no name and no constraints, so an element's
            # own name (Arrow calls it `item`), its declared type and anything that type
            # records are carried in this bag rather than being lost at the wrapper.
            item_extras: Dict[str, Any] = {
                "name": element.name,
                "nullable": element.nullable,
                "type": _type_extra(element.type),
            }
            extras["arrow_item"] = item_extras
            item_ref, _element_constraints = self.type_ref(
                element.type,
                element.children,
                path=path + (element.name,),
                nullable=element.nullable,
                location=f"{location}/{element.name}",
                extras=item_extras,
            )
            # The element's constraints are re-derivable from `item_extras["type"]` — a
            # fixed-width binary element states its own byte width there — and there is no
            # canonical slot to hang them on, so they are not duplicated.
            constraints: Optional[Constraints] = None
            if name == "fixedsizelist":
                size = int(type_.parameter("listSize", 0))
                constraints = Constraints(min_items=size, max_items=size)
            return TypeRef(item=item_ref, nullable=nullable), constraints

        if name == "map":
            entries = children[0]
            key_field, value_field = entries.children[0], entries.children[1]
            child_name, child_key = self.collector.claim(path)
            key_ref, _ = self.type_ref(
                key_field.type,
                key_field.children,
                path=path + (key_field.name,),
                nullable=key_field.nullable,
                location=f"{location}/{key_field.name}",
                extras={},
            )
            value_ref, _ = self.type_ref(
                value_field.type,
                value_field.children,
                path=path + (value_field.name,),
                nullable=value_field.nullable,
                location=f"{location}/{value_field.name}",
                extras={},
            )
            self.collector.add(
                Type(
                    key=child_key,
                    name=child_name,
                    kind=TypeKind.MAP,
                    namespace=self.namespace,
                    key_type=key_ref,
                    value_type=value_ref,
                    extras={
                        "arrow_kind": "map",
                        "arrow_keys_sorted": bool(type_.parameter("keysSorted", False)),
                    },
                )
            )
            return TypeRef(name=child_key, nullable=nullable), None

        if name == "union":
            return self.union_ref(type_, children, path=path, nullable=nullable, location=location)

        if name == "runendencoded":
            # A run-end-encoded column *is* its values column, compressed. The run-ends
            # child is the encoding's bookkeeping and describes no data.
            self.limits.record("arrow.physical_layout", location=location)
            values = children[1]
            return self.type_ref(
                values.type,
                values.children,
                path=path,
                nullable=nullable,
                location=location,
                extras=extras,
            )

        scalar, constraints = self.scalar(type_, location=location, extras=extras)
        return TypeRef(name=scalar, nullable=nullable), constraints

    def union_ref(
        self,
        type_: ArrowType,
        children: Sequence[ArrowField],
        *,
        path: Tuple[str, ...],
        nullable: bool,
        location: str,
    ) -> Tuple[TypeRef, Optional[Constraints]]:
        """Project an Arrow union onto a canonical ``UNION`` type.

        A canonical union holds member type *keys*, so a variant that is itself a named
        type contributes its key and a scalar variant contributes its scalar name — which
        loses the variant's own name and its type code. Both are recorded verbatim on the
        union type's ``arrow_union``, and the loss is a declared limit.
        """
        self.limits.record("arrow.union_layout", location=location)
        child_name, child_key = self.collector.claim(path)
        members: List[str] = []
        variants: List[Dict[str, Any]] = []
        codes = type_.parameter("typeIds") or list(range(len(children)))
        for index, variant in enumerate(children):
            variant_extras: Dict[str, Any] = {}
            reference, _ = self.type_ref(
                variant.type,
                variant.children,
                path=path + (variant.name,),
                nullable=variant.nullable,
                location=f"{location}/{variant.name}",
                extras=variant_extras,
            )
            member = reference.name or "any"
            if member not in members:
                members.append(member)
            variants.append(
                {
                    "name": variant.name,
                    "typeId": codes[index] if index < len(codes) else index,
                    "type": _type_extra(variant.type),
                    "member": member,
                }
            )
        self.collector.add(
            Type(
                key=child_key,
                name=child_name,
                kind=TypeKind.UNION,
                namespace=self.namespace,
                union_members=members,
                extras={
                    "arrow_kind": "union",
                    "arrow_union": {
                        "mode": str(type_.parameter("mode", "DENSE")),
                        "variants": variants,
                    },
                },
            )
        )
        return TypeRef(name=child_key, nullable=nullable), None

    def scalar(
        self, type_: ArrowType, *, location: str, extras: Dict[str, Any]
    ) -> Tuple[str, Optional[Constraints]]:
        """Project one leaf Arrow type onto a canonical scalar and its constraints.

        Args:
            type_: The Arrow type descriptor.
            location: The owning field's path, for limit locations.
            extras: The owning field's extras bag, added to in place.

        Returns:
            The canonical scalar name and the constraints the type implies.
        """
        name = type_.name

        if name == "null":
            return "null", None
        if name == "bool":
            return "bool", None
        if name == "int":
            width = type_.bit_width or 32
            return _INT_SCALARS[(width, bool(type_.is_signed))], None
        if name == "floatingpoint":
            precision = str(type_.parameter("precision", "DOUBLE"))
            if precision == "HALF":
                self.limits.record("arrow.half_precision", location=location)
            return _FLOAT_SCALARS[precision], None
        if name == "utf8":
            return "string", None
        if name == "binary":
            return "bytes", None
        if name in _LAYOUT_VARIANT_SCALARS:
            self.limits.record("arrow.physical_layout", location=location)
            return _LAYOUT_VARIANT_SCALARS[name], None
        if name == "fixedsizebinary":
            width = int(type_.parameter("byteWidth", 0))
            return "bytes", Constraints(min_length=width, max_length=width)
        if name == "decimal":
            self.limits.record("arrow.decimal_width", location=location)
            extras["arrow_decimal"] = {
                "precision": type_.parameter("precision"),
                "scale": type_.parameter("scale"),
                "bitWidth": type_.parameter("bitWidth", 128),
            }
            return "decimal", None
        if name == "interval":
            self.limits.record("arrow.interval", location=location)
            return "string", Constraints(format="duration")
        if name in _TEMPORAL_FORMATS:
            self.limits.record("arrow.temporal_unit", location=location)
            return "string", Constraints(format=_TEMPORAL_FORMATS[name])
        # Unreachable for a document the reader accepted: every name in the vocabulary is
        # handled above or by `type_ref`. Kept so a vocabulary addition degrades to `any`
        # rather than raising after the document has already been accepted.
        return "any", None  # pragma: no cover


def _root_type(
    schema: ArrowSchema, projection: _Projection, *, name: str, key: str
) -> Type:
    """Build the root record — one field per column of the table the schema describes."""
    return Type(
        key=key,
        name=name,
        kind=TypeKind.RECORD,
        namespace=projection.namespace,
        description=_description_from(schema.metadata),
        fields=projection.record_fields(schema.fields, owner_key=key, path=()),
        extras={"arrow_kind": "schema"},
    )


class ArrowNormalizer(Normalizer, register=True):
    """Normalize a parsed Arrow document into a :class:`CanonicalApi`.

    Registered under ``arrow`` for all three of Arrow's surfaces — the JSON integration
    form, the IPC serialization and a Flight response — because they parse into one
    document type and there is nothing left for the normalizer to distinguish.
    """

    format = "arrow"
    paradigm = ApiParadigm.DATA_SCHEMA

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Map a parsed Arrow document to the canonical model.

        Args:
            source: The :class:`~app.arrow_schema.ArrowDocument` any Arrow reader produced.
            include_raw: Whether to keep the document's JSON integration form on ``raw``.

        Returns:
            The canonical model: one ``data_schema`` API whose root record is the table.

        Raises:
            ValueError: When ``source`` is not an :class:`~app.arrow_schema.ArrowDocument`.
        """
        if not isinstance(source, ArrowDocument):
            raise ValueError(
                "Arrow source must be an ArrowDocument (see app.arrow_parser.parse_arrow)"
            )

        name, namespace = _identity_of(source)
        limits = LimitRecorder()
        limits.extend(source.limits)
        projection = _Projection(namespace, limits)
        projection.collector.reserve(name)

        root_key = Keys.type(name, namespace)
        root = _root_type(source.schema, projection, name=name, key=root_key)
        types = [root, *projection.collector.types()]

        arrow: Dict[str, Any] = {
            "root": root_key,
            "capability_limits": _limits_payload(limits.limits()),
        }
        metadata = _metadata_map(source.schema.metadata, consumed=(_NAME_METADATA_KEY,))
        if metadata:
            arrow["schema_metadata"] = metadata
        if source.flight is not None:
            flight = _flight_extra(source.flight)
            if flight:
                arrow["flight"] = flight

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            identity=ApiIdentity(name=name, namespace=namespace),
            title=name,
            description=root.description,
            types=types,
            raw={"arrow": source.raw} if include_raw and source.raw is not None else None,
            extras={ARROW_EXTRAS_KEY: arrow},
        )
        return normalize_ordering(api)
