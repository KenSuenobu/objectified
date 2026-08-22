"""Apache Arrow IPC (Flatbuffer) schema bridge — FMT-4.5 (#5438).

The binary half of the Arrow adapter. An ``.arrow`` stream or file is a Flatbuffer
serialization that no hand-written reader should attempt, so this module is the one place
``pyarrow`` is spoken to, and it converts in both directions between ``pyarrow``'s schema
objects and the :mod:`app.arrow_schema` dataclasses the rest of the adapter works in.

That conversion is what makes the acceptance criterion structural rather than incidental:
an IPC schema and its JSON twin do not go through two readers that happen to agree, they
go through *one* model. :func:`read_ipc_schema` produces the same
:class:`~app.arrow_schema.ArrowDocument` :func:`app.arrow_parser.parse_arrow` produces,
and the normalizer downstream cannot tell them apart.

``pyarrow`` is imported lazily. It is a declared dependency, but the JSON surface — the one
an operator pastes into the import wizard — must keep working in a runtime that does not
have it, and detection must never fail because a native library is missing. A binary
payload in such a runtime is refused with a stated reason rather than a traceback.

**Direction two exists for a reason.** :func:`schema_to_pyarrow` is not needed to *import*
anything; it is what lets a test serialize a committed JSON fixture into the IPC bytes its
twin is read from, and it is the seam an Arrow emitter (#4317) writes through when it
lands.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .arrow_parser import render_json_form
from .arrow_schema import (
    ARROW_EXTENSION_METADATA_KEY,
    ARROW_EXTENSION_NAME_KEY,
    MAX_DEPTH,
    MAX_DOCUMENT_BYTES,
    MAX_FIELDS,
    ArrowDictionaryEncoding,
    ArrowDocument,
    ArrowField,
    ArrowParseError,
    ArrowSchema,
    ArrowType,
    FlightInfo,
)

__all__ = [
    "ARROW_FILE_MAGIC",
    "ARROW_STREAM_MAGIC",
    "ArrowIpcError",
    "document_from_pyarrow",
    "pyarrow_available",
    "read_ipc_schema",
    "schema_from_pyarrow",
    "schema_to_pyarrow",
    "serialize_ipc_schema",
    "sniff_arrow_ipc",
]


class ArrowIpcError(ArrowParseError):
    """An Arrow IPC payload could not be read, or a schema could not be serialized."""


#: The 6-byte magic an Arrow IPC *file* starts (and ends) with.
ARROW_FILE_MAGIC = b"ARROW1"

#: The continuation marker every Arrow IPC *stream* message starts with since v0.15.
ARROW_STREAM_MAGIC = b"\xff\xff\xff\xff"

#: ``pyarrow`` time-unit spelling -> the Arrow JSON integration form's spelling. Held as a
#: table in both directions so the two surfaces cannot disagree about what ``us`` means.
_UNIT_TO_JSON: Dict[str, str] = {
    "s": "SECOND",
    "ms": "MILLISECOND",
    "us": "MICROSECOND",
    "ns": "NANOSECOND",
}
_UNIT_FROM_JSON: Dict[str, str] = {value: key for key, value in _UNIT_TO_JSON.items()}

#: Interval units ``pyarrow``'s Python API can *construct*. The Arrow format defines three;
#: ``pyarrow`` exposes a constructor for one, so a ``YEAR_MONTH`` or ``DAY_TIME`` interval
#: can be read from an IPC payload produced elsewhere but cannot be serialized from here.
_CONSTRUCTIBLE_INTERVAL_UNITS = ("MONTH_DAY_NANO",)


def pyarrow_available() -> bool:
    """Whether ``pyarrow`` can be imported in this runtime.

    Returns:
        ``True`` when the binary surface is usable. Detection and the JSON surface do not
        consult this — they never need ``pyarrow`` — so a ``False`` here narrows the
        adapter rather than disabling it.
    """
    try:
        import pyarrow  # noqa: F401
    except Exception:  # noqa: BLE001 - an import failure of any shape means "unavailable"
        return False
    return True


def _require_pyarrow() -> Any:
    """Import ``pyarrow``, or raise the stated reason it cannot be used here."""
    try:
        import pyarrow
    except ImportError as exc:  # pragma: no cover - pyarrow is a declared dependency
        raise ArrowIpcError(
            "pyarrow is not available in this runtime; an Arrow IPC schema cannot be read "
            "here. The JSON integration form of the same schema imports without it.",
            code="FORMAT_UNSUPPORTED",
        ) from exc
    return pyarrow


def sniff_arrow_ipc(data: bytes) -> bool:
    """Whether ``data`` begins as an Arrow IPC file or stream.

    Cheap and total, like every detection helper: it reads at most the first eight bytes
    and never raises.

    Args:
        data: The undecoded payload.

    Returns:
        ``True`` for the ``ARROW1`` file magic or a stream continuation marker followed by
        a plausible metadata length.
    """
    if not data or len(data) < 8:
        return False
    if data.startswith(ARROW_FILE_MAGIC):
        return True
    if data.startswith(ARROW_STREAM_MAGIC):
        length = int.from_bytes(data[4:8], "little", signed=False)
        # A schema message is small; a continuation marker followed by a nonsensical
        # length is four coincidental bytes, not a stream.
        return 0 < length <= MAX_DOCUMENT_BYTES
    return False


# ===========================================================================
# Reading
# ===========================================================================


def read_ipc_schema(data: bytes, *, source_label: Optional[str] = None) -> ArrowDocument:
    """Read the schema out of an Arrow IPC payload.

    Accepts all three shapes a caller can hand over: an IPC **file** (``ARROW1`` magic), an
    IPC **stream**, and a bare serialized **schema message** — which is what Flight's
    ``GetSchema`` returns and what ``pyarrow.Schema.serialize()`` writes.

    Args:
        data: The undecoded payload.
        source_label: The payload's name, for error messages.

    Returns:
        The document, with ``raw`` set to the schema rendered as the JSON integration form
        — the readable equivalent of bytes that are not text.

    Raises:
        ArrowIpcError: When ``pyarrow`` is unavailable, the payload is not a readable
            Arrow IPC serialization, or the schema breaches a reader ceiling.
    """
    where = f" ({source_label})" if source_label else ""
    if not data:
        raise ArrowIpcError(f"Arrow IPC payload is empty{where}", code="INPUT_EMPTY")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise ArrowIpcError(
            f"Arrow IPC payload is {len(data)} bytes, above the {MAX_DOCUMENT_BYTES}-byte "
            f"reader ceiling{where}",
            code="INPUT_TOO_LARGE",
        )
    pa = _require_pyarrow()
    schema = _read_pyarrow_schema(pa, data, where=where)
    return document_from_pyarrow(schema, source_label=source_label)


def _read_pyarrow_schema(pa: Any, data: bytes, *, where: str) -> Any:
    """Return the ``pyarrow.Schema`` in ``data``, trying each IPC shape in turn.

    A file is tried first because its magic is decisive; a stream and a bare schema message
    are then read through the same reader, which accepts either. Every ``pyarrow`` failure
    is folded into one stated error — the library raises several unrelated exception types
    for a corrupt payload, and none of them should reach the pipeline as a traceback.
    """
    errors: List[str] = []
    if data.startswith(ARROW_FILE_MAGIC):
        try:
            return pa.ipc.open_file(pa.BufferReader(data)).schema
        except Exception as exc:  # noqa: BLE001 - pyarrow raises several unrelated types
            errors.append(f"as an IPC file: {exc}")
    try:
        return pa.ipc.read_schema(pa.BufferReader(data))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"as an IPC stream or schema message: {exc}")
    detail = "; ".join(errors)
    raise ArrowIpcError(
        f"Arrow IPC payload could not be read{where} ({detail})",
        code="INPUT_TRUNCATED" if _looks_truncated(data) else "INPUT_MALFORMED",
    )


def _looks_truncated(data: bytes) -> bool:
    """Whether an unreadable IPC payload was *cut short* rather than corrupted.

    Truncation in Arrow IPC is a framing fact, not a guess, because both containers declare
    their own length. A file must end with the same ``ARROW1`` magic it starts with; a
    stream message declares its metadata length in the four bytes after the continuation
    marker. A payload that promises more than it delivers is truncated; one that delivers
    what it promised and is still unreadable is corrupt.
    """
    if len(data) < 8:
        return True
    if data.startswith(ARROW_FILE_MAGIC):
        return not data.rstrip(b"\x00").endswith(ARROW_FILE_MAGIC)
    if data.startswith(ARROW_STREAM_MAGIC):
        declared = int.from_bytes(data[4:8], "little", signed=False)
        return len(data) < 8 + declared
    return False


def document_from_pyarrow(
    schema: Any,
    *,
    flight: Optional[FlightInfo] = None,
    source_label: Optional[str] = None,
) -> ArrowDocument:
    """Build an :class:`~app.arrow_schema.ArrowDocument` from a ``pyarrow.Schema``.

    The single seam between ``pyarrow`` and the rest of the adapter — the IPC reader and
    the Flight client both land here, so a schema fetched from a live endpoint and one read
    from a file are the same object by construction.

    Args:
        schema: The ``pyarrow.Schema``.
        flight: The Flight envelope, when the schema came from a Flight response.
        source_label: The document's name, for error messages.

    Returns:
        The document, with ``raw`` rendered as the JSON integration form.
    """
    converted = schema_from_pyarrow(schema)
    return ArrowDocument(
        schema=converted,
        flight=flight,
        limits=(),
        raw=render_json_form(converted, flight=flight),
        source_label=source_label,
    )


def schema_from_pyarrow(schema: Any) -> ArrowSchema:
    """Convert a ``pyarrow.Schema`` into an :class:`~app.arrow_schema.ArrowSchema`.

    Args:
        schema: The ``pyarrow.Schema``.

    Returns:
        The converted schema, with the same field order, nullability and metadata.

    Raises:
        ArrowIpcError: When the schema breaches the reader's field-count or depth ceiling.
    """
    budget = _Budget()
    fields = tuple(_field_from_pyarrow(field, depth=1, budget=budget) for field in schema)
    return ArrowSchema(fields=fields, metadata=_metadata_from_pyarrow(schema.metadata))


class _Budget:
    """Charges the field-count ceiling across one converted schema."""

    def __init__(self) -> None:
        self.count = 0

    def charge(self, name: str) -> None:
        """Charge one field, refusing past :data:`~app.arrow_schema.MAX_FIELDS`."""
        self.count += 1
        if self.count > MAX_FIELDS:
            raise ArrowIpcError(
                f"Arrow IPC schema declares more than {MAX_FIELDS} fields (at `{name}`)",
                code="INPUT_TOO_LARGE",
            )


def _field_from_pyarrow(field: Any, *, depth: int, budget: _Budget) -> ArrowField:
    """Convert one ``pyarrow.Field``, recursing into its children."""
    if depth > MAX_DEPTH:
        raise ArrowIpcError(
            f"Arrow IPC schema nests more than {MAX_DEPTH} levels deep (at `{field.name}`)",
            code="INPUT_DEPTH_LIMIT",
        )
    budget.charge(field.name)
    metadata = list(_metadata_from_pyarrow(field.metadata))
    data_type = field.type

    # An extension type is a logical type over a storage type. `pyarrow` resolves the two
    # `ARROW:extension:*` metadata keys into a real extension type when it recognizes the
    # name (`arrow.uuid` is registered), which removes them from the field's metadata. The
    # storage type plus the two keys is the shape the JSON form states, so it is restored
    # here and the two surfaces stay identical.
    extension_name = getattr(data_type, "extension_name", None)
    if extension_name is not None:
        storage = getattr(data_type, "storage_type", None)
        if storage is not None:
            metadata = _with_extension_metadata(metadata, data_type, extension_name)
            data_type = storage

    dictionary: Optional[ArrowDictionaryEncoding] = None
    if _is(data_type, "is_dictionary"):
        dictionary = ArrowDictionaryEncoding(
            index_type=_type_from_pyarrow(data_type.index_type)[0],
            is_ordered=bool(data_type.ordered),
        )
        data_type = data_type.value_type

    arrow_type, children = _type_from_pyarrow(data_type)
    return ArrowField(
        name=field.name,
        type=arrow_type,
        nullable=bool(field.nullable),
        children=tuple(
            _field_from_pyarrow(child, depth=depth + 1, budget=budget) for child in children
        ),
        dictionary=dictionary,
        metadata=tuple(metadata),
    )


def _with_extension_metadata(
    metadata: List[Tuple[str, str]], data_type: Any, extension_name: str
) -> List[Tuple[str, str]]:
    """Restore the ``ARROW:extension:*`` keys ``pyarrow`` consumed into an extension type."""
    keys = {key for key, _ in metadata}
    restored = list(metadata)
    if ARROW_EXTENSION_NAME_KEY not in keys:
        restored.append((ARROW_EXTENSION_NAME_KEY, str(extension_name)))
    if ARROW_EXTENSION_METADATA_KEY not in keys:
        serialized = ""
        raw = getattr(data_type, "__arrow_ext_serialize__", None)
        if callable(raw):
            try:
                serialized = bytes(raw()).decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001 - an opaque blob that will not decode
                serialized = ""
        restored.append((ARROW_EXTENSION_METADATA_KEY, serialized))
    return restored


def _is(data_type: Any, predicate: str) -> bool:
    """Call ``pyarrow.types.<predicate>``, tolerating a build that does not define it.

    The view and run-end-encoded predicates only exist in newer ``pyarrow`` releases, and
    a missing predicate means the runtime cannot produce that type at all.
    """
    import pyarrow.types as types

    check = getattr(types, predicate, None)
    return bool(check(data_type)) if callable(check) else False


def _type_from_pyarrow(data_type: Any) -> Tuple[ArrowType, Tuple[Any, ...]]:
    """Map one ``pyarrow.DataType`` to its Arrow type descriptor and child fields.

    Returns:
        The type descriptor and the ``pyarrow.Field`` children it owns (empty for a leaf).

    Raises:
        ArrowIpcError: For a ``pyarrow`` type this adapter has no Arrow type name for.
    """
    import pyarrow as pa

    if _is(data_type, "is_null"):
        return ArrowType("null"), ()
    if _is(data_type, "is_boolean"):
        return ArrowType("bool"), ()
    if _is(data_type, "is_integer"):
        return (
            ArrowType(
                "int",
                {
                    "bitWidth": data_type.bit_width,
                    "isSigned": _is(data_type, "is_signed_integer"),
                },
            ),
            (),
        )
    for predicate, precision in (
        ("is_float16", "HALF"),
        ("is_float32", "SINGLE"),
        ("is_float64", "DOUBLE"),
    ):
        if _is(data_type, predicate):
            return ArrowType("floatingpoint", {"precision": precision}), ()
    if _is(data_type, "is_large_string"):
        return ArrowType("largeutf8"), ()
    if _is(data_type, "is_string_view"):
        return ArrowType("utf8view"), ()
    if _is(data_type, "is_string"):
        return ArrowType("utf8"), ()
    if _is(data_type, "is_fixed_size_binary"):
        return ArrowType("fixedsizebinary", {"byteWidth": data_type.byte_width}), ()
    if _is(data_type, "is_large_binary"):
        return ArrowType("largebinary"), ()
    if _is(data_type, "is_binary_view"):
        return ArrowType("binaryview"), ()
    if _is(data_type, "is_binary"):
        return ArrowType("binary"), ()
    if _is(data_type, "is_decimal"):
        return (
            ArrowType(
                "decimal",
                {
                    "precision": data_type.precision,
                    "scale": data_type.scale,
                    "bitWidth": data_type.bit_width,
                },
            ),
            (),
        )
    if _is(data_type, "is_date32"):
        return ArrowType("date", {"unit": "DAY"}), ()
    if _is(data_type, "is_date64"):
        return ArrowType("date", {"unit": "MILLISECOND"}), ()
    if _is(data_type, "is_time32") or _is(data_type, "is_time64"):
        return (
            ArrowType(
                "time",
                {"unit": _UNIT_TO_JSON[data_type.unit], "bitWidth": data_type.bit_width},
            ),
            (),
        )
    if _is(data_type, "is_timestamp"):
        parameters: Dict[str, Any] = {"unit": _UNIT_TO_JSON[data_type.unit]}
        if data_type.tz:
            parameters["timezone"] = data_type.tz
        return ArrowType("timestamp", parameters), ()
    if _is(data_type, "is_duration"):
        return ArrowType("duration", {"unit": _UNIT_TO_JSON[data_type.unit]}), ()
    if _is(data_type, "is_interval"):
        return ArrowType("interval", {"unit": _interval_unit(data_type)}), ()
    if _is(data_type, "is_map"):
        return (
            ArrowType("map", {"keysSorted": bool(data_type.keys_sorted)}),
            (_map_entries_field(pa, data_type),),
        )
    if _is(data_type, "is_fixed_size_list"):
        return (
            ArrowType("fixedsizelist", {"listSize": data_type.list_size}),
            (data_type.value_field,),
        )
    if _is(data_type, "is_large_list"):
        return ArrowType("largelist"), (data_type.value_field,)
    if _is(data_type, "is_list_view"):
        return ArrowType("listview"), (data_type.value_field,)
    if _is(data_type, "is_large_list_view"):
        return ArrowType("largelistview"), (data_type.value_field,)
    if _is(data_type, "is_list"):
        return ArrowType("list"), (data_type.value_field,)
    if _is(data_type, "is_struct"):
        return ArrowType("struct"), tuple(data_type)
    if _is(data_type, "is_union"):
        # `pyarrow.types` has no sparse/dense predicate — the union type itself carries the
        # mode, spelled lower-case, and that is the only place it is stated.
        mode = "SPARSE" if str(getattr(data_type, "mode", "dense")).lower() == "sparse" else "DENSE"
        children = tuple(data_type.field(index) for index in range(data_type.num_fields))
        return (
            ArrowType("union", {"mode": mode, "typeIds": list(data_type.type_codes)}),
            children,
        )
    if _is(data_type, "is_run_end_encoded"):
        return (
            ArrowType("runendencoded"),
            (
                pa.field("run_ends", data_type.run_end_type, nullable=False),
                pa.field("values", data_type.value_type),
            ),
        )
    raise ArrowIpcError(f"`{data_type}` has no Arrow schema type name this reader knows")


def _interval_unit(data_type: Any) -> str:
    """Return the Arrow JSON unit of a ``pyarrow`` interval type."""
    spelling = str(data_type).lower()
    if "month_day_nano" in spelling:
        return "MONTH_DAY_NANO"
    if "day_time" in spelling:
        return "DAY_TIME"
    return "YEAR_MONTH"


def _map_entries_field(pa: Any, data_type: Any) -> Any:
    """Rebuild the ``entries`` struct field an Arrow map's JSON form declares.

    ``pyarrow`` exposes a map's key and item fields directly and keeps the ``entries``
    struct that wraps them implicit. The JSON integration form states it, so it is
    reconstructed here — with the spelling Arrow fixes (``entries`` holding ``key`` and
    ``value``, the entry itself non-nullable).
    """
    return pa.field(
        "entries",
        pa.struct([data_type.key_field, data_type.item_field]),
        nullable=False,
    )


def _metadata_from_pyarrow(metadata: Any) -> Tuple[Tuple[str, str], ...]:
    """Convert ``pyarrow``'s bytes-keyed metadata mapping to text pairs, order preserved."""
    if not metadata:
        return ()
    pairs: List[Tuple[str, str]] = []
    for key, value in metadata.items():
        pairs.append((_text(key), _text(value)))
    return tuple(pairs)


def _text(value: Any) -> str:
    """Decode a metadata key or value, which ``pyarrow`` hands over as ``bytes``."""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


# ===========================================================================
# Writing
# ===========================================================================


def schema_to_pyarrow(schema: ArrowSchema) -> Any:
    """Convert an :class:`~app.arrow_schema.ArrowSchema` into a ``pyarrow.Schema``.

    The inverse of :func:`schema_from_pyarrow`. Not part of the import path: it exists so a
    committed JSON fixture can be serialized into the IPC bytes its twin is read from, and
    as the seam an Arrow emitter (#4317) writes through.

    Args:
        schema: The schema to convert.

    Returns:
        The ``pyarrow.Schema``.

    Raises:
        ArrowIpcError: For a type ``pyarrow``'s Python API cannot construct — a
            ``YEAR_MONTH`` or ``DAY_TIME`` interval, which the Arrow format defines and
            ``pyarrow`` exposes no constructor for.
    """
    pa = _require_pyarrow()
    fields = [_field_to_pyarrow(pa, field) for field in schema.fields]
    metadata = {key: value for key, value in schema.metadata} or None
    return pa.schema(fields, metadata=metadata)


def serialize_ipc_schema(schema: ArrowSchema) -> bytes:
    """Serialize a schema as a bare Arrow IPC schema message.

    The shape Flight's ``GetSchema`` returns, and the smallest self-describing Arrow
    payload — which is what a committed binary corpus fixture should be, since a schema
    fixture has no rows.

    Args:
        schema: The schema to serialize.

    Returns:
        The serialized schema message.
    """
    return bytes(schema_to_pyarrow(schema).serialize())


def _field_to_pyarrow(pa: Any, field: ArrowField) -> Any:
    """Convert one :class:`~app.arrow_schema.ArrowField` to a ``pyarrow.Field``."""
    data_type = _type_to_pyarrow(pa, field.type, field.children)
    if field.dictionary is not None:
        data_type = pa.dictionary(
            _type_to_pyarrow(pa, field.dictionary.index_type, ()),
            data_type,
            ordered=field.dictionary.is_ordered,
        )
    metadata = {key: value for key, value in field.metadata} or None
    return pa.field(field.name, data_type, nullable=field.nullable, metadata=metadata)


def _type_to_pyarrow(pa: Any, type_: ArrowType, children: Tuple[ArrowField, ...]) -> Any:
    """Convert one Arrow type descriptor (plus its children) to a ``pyarrow.DataType``."""
    name = type_.name
    if name == "null":
        return pa.null()
    if name == "bool":
        return pa.bool_()
    if name == "int":
        width, signed = type_.bit_width or 32, bool(type_.is_signed)
        return getattr(pa, f"{'' if signed else 'u'}int{width}")()
    if name == "floatingpoint":
        return {"HALF": pa.float16, "SINGLE": pa.float32, "DOUBLE": pa.float64}[
            str(type_.parameter("precision"))
        ]()
    if name == "utf8":
        return pa.string()
    if name == "largeutf8":
        return pa.large_string()
    if name == "utf8view":
        return pa.string_view()
    if name == "binary":
        return pa.binary()
    if name == "largebinary":
        return pa.large_binary()
    if name == "binaryview":
        return pa.binary_view()
    if name == "fixedsizebinary":
        return pa.binary(int(type_.parameter("byteWidth", 0)))
    if name == "decimal":
        precision = int(type_.parameter("precision"))
        scale = int(type_.parameter("scale"))
        width = int(type_.parameter("bitWidth", 128))
        builder = getattr(pa, f"decimal{width}", None)
        if builder is None:  # pragma: no cover - older pyarrow without decimal32/64
            raise ArrowIpcError(f"this pyarrow build cannot construct decimal{width}")
        return builder(precision, scale)
    if name == "date":
        return pa.date32() if type_.unit == "DAY" else pa.date64()
    if name == "time":
        width = type_.bit_width or (32 if type_.unit in ("SECOND", "MILLISECOND") else 64)
        return getattr(pa, f"time{width}")(_UNIT_FROM_JSON[str(type_.unit)])
    if name == "timestamp":
        return pa.timestamp(_UNIT_FROM_JSON[str(type_.unit)], tz=type_.timezone)
    if name == "duration":
        return pa.duration(_UNIT_FROM_JSON[str(type_.unit)])
    if name == "interval":
        if type_.unit not in _CONSTRUCTIBLE_INTERVAL_UNITS:
            raise ArrowIpcError(
                f"pyarrow exposes no constructor for a `{type_.unit}` interval; the Arrow "
                f"format defines it and this reader reads it, but it cannot be serialized "
                f"from here"
            )
        return pa.month_day_nano_interval()
    if name in ("list", "listview"):
        return pa.list_(_field_to_pyarrow(pa, children[0]))
    if name in ("largelist", "largelistview"):
        return pa.large_list(_field_to_pyarrow(pa, children[0]))
    if name == "fixedsizelist":
        return pa.list_(_field_to_pyarrow(pa, children[0]), int(type_.parameter("listSize", 0)))
    if name == "struct":
        return pa.struct([_field_to_pyarrow(pa, child) for child in children])
    if name == "map":
        entries = children[0]
        return pa.map_(
            _field_to_pyarrow(pa, entries.children[0]),
            _field_to_pyarrow(pa, entries.children[1]),
            keys_sorted=bool(type_.parameter("keysSorted", False)),
        )
    if name == "union":
        mode = str(type_.parameter("mode", "DENSE")).upper()
        codes = type_.parameter("typeIds") or list(range(len(children)))
        variants = [_field_to_pyarrow(pa, child) for child in children]
        builder = pa.sparse_union if mode == "SPARSE" else pa.dense_union
        return builder(variants, [int(code) for code in codes])
    if name == "runendencoded":
        return pa.run_end_encoded(
            _type_to_pyarrow(pa, children[0].type, children[0].children),
            _type_to_pyarrow(pa, children[1].type, children[1].children),
        )
    raise ArrowIpcError(f"`{name}` cannot be converted to a pyarrow type")
