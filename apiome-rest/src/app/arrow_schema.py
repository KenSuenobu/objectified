"""Apache Arrow schema algebra — FMT-4.5 (#5438).

The shared middle of the Arrow adapter: the dataclasses every Arrow surface parses
*into*, the type vocabulary those surfaces agree on, the reader's own resource
ceilings, and the declared capability limits the canonical projection records.

Arrow ships a schema in three shapes and this module is what makes them one thing:

* the **JSON integration form** — ``{"schema": {"fields": [...], "metadata": [...]}}`` —
  which the Arrow integration suite exchanges and which is the only shape that can be
  committed as readable text (:mod:`app.arrow_parser`);
* the **IPC / Flatbuffer serialization** — an ``.arrow`` stream or file, read through
  ``pyarrow`` (:mod:`app.arrow_ipc`);
* a **Flight ``GetSchema`` response** from a live endpoint (:mod:`app.arrow_flight`),
  which is the IPC serialization plus the descriptor naming the dataset.

All three produce the same :class:`ArrowDocument`, so :mod:`app.arrow_normalizer` has one
input and the acceptance criterion — "an Arrow IPC schema and a JSON-form schema both
import to the same canonical model" — is a property of the code rather than a coincidence
of two readers agreeing.

**What is deliberately not modelled here.** An Arrow schema describes the *value space* of
a table's columns; the IPC encoding describes how those values are laid out in memory. A
dictionary's numeric ``id``, a union's type-code assignment, a large-offset or view layout
and a run-end encoding are all layout, not schema — two schemas that differ only in them
describe the same data. They are recorded on the document (so nothing is silently dropped)
and declared as capability limits, and the *canonical model* they project onto is
identical. That is why an IPC document and its JSON twin normalize to the same model
rather than to two models that happen to look alike.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Sequence, Set, Tuple

__all__ = [
    "ARROW_EXTENSION_METADATA_KEY",
    "ARROW_EXTENSION_NAME_KEY",
    "ArrowDictionaryEncoding",
    "ArrowDocument",
    "ArrowField",
    "ArrowLimit",
    "ArrowParseError",
    "ArrowSchema",
    "ArrowType",
    "FlightDescriptor",
    "FlightEndpoint",
    "FlightInfo",
    "LIMIT_DETAILS",
    "LimitRecorder",
    "MAX_DEPTH",
    "MAX_DOCUMENT_BYTES",
    "MAX_FIELDS",
    "NESTED_TYPE_NAMES",
    "TYPE_NAMES",
    "TYPE_PARAMETERS",
]


class ArrowParseError(Exception):
    """A document could not be read as an Arrow schema.

    Attributes:
        code: The :mod:`app.intake_error_taxonomy` code when the reader can classify the
            failure itself, and ``None`` when it must not — a plain syntax error carries
            no code so the import pipeline classifies it, which is what lets a UTF-16
            payload read as ``INPUT_ENCODING_INVALID`` and an Avro schema sent to this
            adapter read as ``FORMAT_MISMATCH``.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# ===========================================================================
# Reader ceilings
# ===========================================================================

#: Hard ceiling on the decoded size of one Arrow document, in bytes.
#:
#: The shared intake guard already bounds an upload; this is the reader's own bound, so a
#: schema handed straight to :func:`app.arrow_parser.parse_arrow` by a test, the CLI or a
#: Flight endpoint is bounded too. 16 MiB is far above any real schema — the largest
#: analytical tables in the wild are a few thousand columns — and far below the point at
#: which the recursive walk below becomes expensive.
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

#: Hard ceiling on the number of fields in one schema, counting nested children.
#:
#: A schema is a *flat* list of columns whose members may nest; a document that declares
#: more fields than this is not a schema anyone wrote, and the bound keeps the walk linear
#: in a value an attacker cannot inflate.
MAX_FIELDS = 50_000

#: Hard ceiling on nesting depth (``struct`` inside ``list`` inside ``struct`` …).
#:
#: The reader and the normalizer both walk the field tree recursively, and CPython raises
#: an uncatchable ``RecursionError`` well before a JSON document with 1 000 levels of
#: nesting runs out of anything else — which the import pipeline does not catch and which
#: would surface as a 5xx rather than a rejection.
MAX_DEPTH = 64


# ===========================================================================
# Type vocabulary
# ===========================================================================

#: Field metadata key naming an Arrow extension type (a logical type over a storage type).
ARROW_EXTENSION_NAME_KEY = "ARROW:extension:name"

#: Field metadata key carrying that extension type's opaque serialized parameters.
ARROW_EXTENSION_METADATA_KEY = "ARROW:extension:metadata"

#: Every ``type.name`` the reader recognizes, mapped to the parameter keys that name
#: carries in the JSON integration form.
#:
#: The map is the vocabulary *and* the parameter contract: a name outside it is a semantic
#: error (the document declares a type Arrow has no such thing as), and a parameter outside
#: its name's tuple is dropped rather than guessed at. Held in one table so the JSON
#: reader, the JSON writer and the ``pyarrow`` bridge cannot drift apart about what a type
#: is made of.
TYPE_PARAMETERS: Dict[str, Tuple[str, ...]] = {
    "null": (),
    "bool": (),
    "int": ("bitWidth", "isSigned"),
    "floatingpoint": ("precision",),
    "utf8": (),
    "largeutf8": (),
    "utf8view": (),
    "binary": (),
    "largebinary": (),
    "binaryview": (),
    "fixedsizebinary": ("byteWidth",),
    "decimal": ("precision", "scale", "bitWidth"),
    "date": ("unit",),
    "time": ("unit", "bitWidth"),
    "timestamp": ("unit", "timezone"),
    "interval": ("unit",),
    "duration": ("unit",),
    "list": (),
    "largelist": (),
    "listview": (),
    "largelistview": (),
    "fixedsizelist": ("listSize",),
    "struct": (),
    "union": ("mode", "typeIds"),
    "map": ("keysSorted",),
    "runendencoded": (),
}

#: The recognized ``type.name`` values, as a set.
TYPE_NAMES: Set[str] = set(TYPE_PARAMETERS)

#: The type names whose meaning *requires* children. A ``struct`` with no members and a
#: ``list`` with no element type cannot describe a record batch, so an empty ``children``
#: on one of these is a semantic error rather than an empty container.
NESTED_TYPE_NAMES: Set[str] = {
    "struct",
    "list",
    "largelist",
    "listview",
    "largelistview",
    "fixedsizelist",
    "union",
    "map",
    "runendencoded",
}


@dataclass(frozen=True)
class ArrowType:
    """One Arrow type descriptor: its name plus the parameters that name carries.

    Attributes:
        name: The Arrow type name, lower-cased (``int``, ``timestamp``, ``struct``, …).
            Always a member of :data:`TYPE_NAMES`.
        parameters: The parameters declared for that name, restricted to the keys
            :data:`TYPE_PARAMETERS` lists for it. Treat as read-only.
    """

    name: str
    parameters: Mapping[str, Any] = field(default_factory=dict)

    def parameter(self, key: str, default: Any = None) -> Any:
        """Return one declared parameter.

        Args:
            key: The parameter name as the JSON integration form spells it.
            default: Value returned when the parameter is absent.

        Returns:
            The parameter value, or ``default``.
        """
        return self.parameters.get(key, default)

    @property
    def bit_width(self) -> Optional[int]:
        """The declared bit width of an ``int``/``time``/``decimal``, when it has one."""
        value = self.parameters.get("bitWidth")
        return value if isinstance(value, int) else None

    @property
    def is_signed(self) -> Optional[bool]:
        """Whether an ``int`` is signed, when it says."""
        value = self.parameters.get("isSigned")
        return value if isinstance(value, bool) else None

    @property
    def unit(self) -> Optional[str]:
        """The temporal unit of a ``date``/``time``/``timestamp``/``duration``/``interval``."""
        value = self.parameters.get("unit")
        return value if isinstance(value, str) else None

    @property
    def timezone(self) -> Optional[str]:
        """A ``timestamp``'s timezone, when it is zoned."""
        value = self.parameters.get("timezone")
        return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class ArrowDictionaryEncoding:
    """The dictionary encoding declared on a field.

    A dictionary-encoded column stores small integer indices into a dictionary of the
    field's declared value type. The *values* are what the schema is about, so the value
    type is what the canonical model carries; the index type and ordering are recorded
    here and declared as a capability limit.

    The dictionary's numeric ``id`` is deliberately **not** kept: it names which dictionary
    message in an IPC stream feeds this field, is assigned by whichever writer produced the
    stream, and says nothing about the schema. Keeping it would make an IPC document and
    its JSON twin normalize differently for a reason that is not about the data.

    Attributes:
        index_type: The integer type the indices are stored as.
        is_ordered: Whether the dictionary's values are ordered (so ``<`` on the indices
            means ``<`` on the values).
    """

    index_type: ArrowType
    is_ordered: bool = False


@dataclass(frozen=True)
class ArrowField:
    """One field of an Arrow schema, or one child of a nested field.

    Attributes:
        name: The field name as declared.
        type: The field's type descriptor.
        nullable: Whether the column may hold nulls.
        children: Child fields — a ``struct``'s members, a ``list``'s single element
            field, a ``map``'s single ``entries`` field, a ``union``'s variants.
        dictionary: The dictionary encoding, when the field is dictionary-encoded.
        metadata: The field's key/value metadata, in declaration order.
    """

    name: str
    type: ArrowType
    nullable: bool = True
    children: Tuple["ArrowField", ...] = ()
    dictionary: Optional[ArrowDictionaryEncoding] = None
    metadata: Tuple[Tuple[str, str], ...] = ()

    def metadata_value(self, key: str) -> Optional[str]:
        """Return one metadata value by key, or ``None`` when the field has no such key."""
        for name, value in self.metadata:
            if name == key:
                return value
        return None

    @property
    def extension_name(self) -> Optional[str]:
        """The Arrow extension type this field declares, when it declares one."""
        return self.metadata_value(ARROW_EXTENSION_NAME_KEY)


@dataclass(frozen=True)
class ArrowSchema:
    """An Arrow schema: an ordered list of fields plus schema-level metadata.

    Attributes:
        fields: The top-level columns, in declaration order.
        metadata: Schema-level key/value metadata, in declaration order.
        endianness: The declared endianness of the IPC serialization, when stated. A
            layout fact, kept for provenance only.
    """

    fields: Tuple[ArrowField, ...] = ()
    metadata: Tuple[Tuple[str, str], ...] = ()
    endianness: Optional[str] = None

    def metadata_value(self, key: str) -> Optional[str]:
        """Return one schema metadata value by key, or ``None`` when absent."""
        for name, value in self.metadata:
            if name == key:
                return value
        return None


@dataclass(frozen=True)
class FlightDescriptor:
    """A Flight descriptor — how a Flight server names the dataset a schema describes.

    Attributes:
        type: ``PATH`` or ``CMD``.
        path: The path segments, for a ``PATH`` descriptor.
        cmd: The opaque command, for a ``CMD`` descriptor (kept verbatim as text).
    """

    type: str = "PATH"
    path: Tuple[str, ...] = ()
    cmd: Optional[str] = None


@dataclass(frozen=True)
class FlightEndpoint:
    """One Flight endpoint: a ticket plus the locations that will honour it."""

    ticket: Optional[str] = None
    locations: Tuple[str, ...] = ()


@dataclass(frozen=True)
class FlightInfo:
    """The Flight envelope a ``GetSchema``/``GetFlightInfo`` response carries.

    The schema itself lives on :class:`ArrowDocument`; this is everything *around* it —
    which dataset it describes and, for ``GetFlightInfo``, where its data can be fetched.

    Attributes:
        descriptor: The descriptor naming the dataset.
        endpoints: The endpoints, for a ``GetFlightInfo`` response; empty for ``GetSchema``.
        total_records: Declared record count, or ``None``/negative when unknown.
        total_bytes: Declared byte count, or ``None``/negative when unknown.
        ordered: Whether the endpoints must be read in order.
    """

    descriptor: Optional[FlightDescriptor] = None
    endpoints: Tuple[FlightEndpoint, ...] = ()
    total_records: Optional[int] = None
    total_bytes: Optional[int] = None
    ordered: Optional[bool] = None


@dataclass(frozen=True)
class ArrowDocument:
    """A parsed Arrow schema, whatever surface it arrived on.

    Attributes:
        schema: The schema itself.
        flight: The Flight envelope, when the document is a Flight response.
        limits: Capability limits the *reader* met while composing the document. The
            normalizer records its own and folds these in, so a limit is counted once.
        raw: The document rendered as the JSON integration form. For a JSON document that
            is (semantically) the text that arrived; for an IPC or Flight document it is
            the equivalent text, because the fidelity bag must hold something a person can
            read and Arrow's own textual form is the honest rendering of those bytes.
        source_label: The document's name, for error messages.
    """

    schema: ArrowSchema
    flight: Optional[FlightInfo] = None
    limits: Tuple["ArrowLimit", ...] = ()
    raw: Optional[str] = None
    source_label: Optional[str] = None


# ===========================================================================
# Declared capability limits
# ===========================================================================

#: The reviewed sentence for each declared limit, keyed by construct.
#:
#: Held here rather than at each recording site so the reader, the normalizer, the
#: capability registry and the per-document coverage ledger all quote one wording. The key
#: set is asserted equal to ``ARROW_CAPABILITIES.unsupported`` and to the registry seed's
#: ``dropped_constructs``.
LIMIT_DETAILS: Dict[str, str] = {
    "arrow.decimal_width": (
        "A `decimal` declares a precision, a scale and a storage width (128 or 256 bits). "
        "The canonical constraint vocabulary has no precision/scale facet, so the field "
        "keeps the `decimal` scalar and all three are recorded in `arrow_decimal` — "
        "preserved and reportable, but not enforced."
    ),
    "arrow.dictionary_encoding": (
        "A dictionary-encoded field stores integer indices into a dictionary of its "
        "declared value type. The *values* are what the schema describes, so the field "
        "keeps its value type; the index type and whether the dictionary is ordered are "
        "recorded in `arrow_dictionary`. The dictionary's numeric id is not carried — it "
        "names a message in an IPC stream, not a property of the data."
    ),
    "arrow.extension_type": (
        "An `ARROW:extension:name` field names a logical type layered over a storage type "
        "(`arrow.uuid` over `fixed_size_binary[16]`). The canonical model has no extension "
        "registry, so the storage type is carried and the extension name and its opaque "
        "parameters are recorded in `arrow_extension`."
    ),
    "arrow.half_precision": (
        "A `floatingpoint` of `HALF` precision is a 16-bit float. The canonical scalar "
        "vocabulary starts at 32 bits, so the field carries `float` — a strictly wider "
        "value space than the column holds — and the declared precision is recorded in "
        "`arrow_type`."
    ),
    "arrow.flight_endpoint": (
        "A Flight `GetFlightInfo` response carries endpoints — a ticket plus the locations "
        "that will honour it — which describe *where the data is*, not what it is. The "
        "descriptor names the dataset and becomes the model's identity; the endpoints are "
        "recorded in `extras['arrow']['flight']` and become no canonical service or "
        "operation, because they expose no callable API surface."
    ),
    "arrow.interval": (
        "An `interval` is a calendar offset (`YEAR_MONTH`, `DAY_TIME`, `MONTH_DAY_NANO`) "
        "whose components are not reducible to a fixed amount of time. The canonical model "
        "has no calendar-offset scalar, so the field is carried as a `duration`-formatted "
        "string and the unit is recorded in `arrow_type` — the nearest analogue, not an "
        "equivalent."
    ),
    "arrow.physical_layout": (
        "The large-offset (`largeutf8`, `largelist`, `largebinary`), view (`utf8view`, "
        "`binaryview`, `listview`) and run-end-encoded variants hold exactly the value "
        "space of their ordinary counterparts and differ only in memory layout. The "
        "canonical type is that counterpart and the declared variant is recorded in "
        "`arrow_type`, so nothing about the data is lost and nothing about the layout is "
        "claimed."
    ),
    "arrow.temporal_unit": (
        "A `date`, `time`, `timestamp` or `duration` declares a resolution (`DAY`, "
        "`SECOND`, `MILLISECOND`, `MICROSECOND`, `NANOSECOND`) and a `timestamp` may "
        "declare a timezone. The canonical model has a semantic format hint and no "
        "resolution facet, so the field carries `date`/`time`/`date-time`/`duration` and "
        "the unit and timezone are recorded in `arrow_type`."
    ),
    "arrow.union_layout": (
        "A `union` declares a mode (`DENSE` or `SPARSE`) and the type code each variant is "
        "stored under. The variants themselves become a canonical `UNION`; the mode and "
        "the type codes are storage, and are recorded in `arrow_union` rather than "
        "modelled."
    ),
}


@dataclass(frozen=True)
class ArrowLimit:
    """One declared capability limit, with how often it was met and where.

    Attributes:
        construct: The stable limit key; always a key of :data:`LIMIT_DETAILS`.
        detail: The reviewed sentence for that key.
        count: How many occurrences were met.
        locations: The field paths the occurrences sit at, sorted.
    """

    construct: str
    detail: str
    count: int = 1
    locations: Tuple[str, ...] = ()


class LimitRecorder:
    """Accumulates :class:`ArrowLimit` records while a document is read and normalized.

    The reader (composition — a Flight envelope's endpoints) and the normalizer
    (projection — every type-level limit) both meet these constructs, and both must record
    them with the same wording and the same de-duplication, so the bookkeeping lives here.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The field path the occurrence sits at, when known.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown Arrow limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def extend(self, limits: Sequence[ArrowLimit]) -> None:
        """Fold already-recorded limits (from a parse) back into this recorder.

        Args:
            limits: The limits to absorb, preserving counts and locations.
        """
        for limit in limits:
            self._counts[limit.construct] = self._counts.get(limit.construct, 0) + limit.count
            if limit.locations:
                self._locations.setdefault(limit.construct, set()).update(limit.locations)

    def limits(self) -> Tuple[ArrowLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            ArrowLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )
