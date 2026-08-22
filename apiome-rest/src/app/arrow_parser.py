"""Apache Arrow JSON integration-form reader and writer — FMT-4.5 (#5438).

Reads the textual half of :mod:`app.arrow_schema`'s three surfaces: the **JSON
integration form** Arrow's own integration suite exchanges
(``{"schema": {"fields": [...], "metadata": [...]}}``), and the Flight
``GetSchema`` / ``GetFlightInfo`` envelopes that wrap it.

The reader is hand-written rather than delegated to ``pyarrow`` on purpose. ``pyarrow``
reads the *binary* IPC serialization (:mod:`app.arrow_ipc`) and has no public reader for
the integration JSON, and a schema that arrives as text must be read without a native
dependency being installed — the JSON surface is the one an operator can paste into the
import wizard.

**JSON, not JSON-or-YAML.** Unlike the OpenAPI-family adapters this reader does not fall
back to YAML. The integration form is defined as JSON, and the fallback would cost two
things that matter here: a near-miss document (an Avro schema, a Flight response from a
different serializer) would parse far enough to be *claimed* instead of being handed back
to format detection, and the JSON decoder's error position — the one signal that
distinguishes a truncated upload from a syntax error — would be lost.

The writer (:func:`render_json_form`) is the inverse, and exists because the fidelity bag
must hold something a person can read: an IPC or Flight document has no source text, so
its ``raw`` is its schema rendered back into this form.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .arrow_schema import (
    MAX_DEPTH,
    MAX_DOCUMENT_BYTES,
    MAX_FIELDS,
    NESTED_TYPE_NAMES,
    TYPE_NAMES,
    TYPE_PARAMETERS,
    ArrowDictionaryEncoding,
    ArrowDocument,
    ArrowField,
    ArrowParseError,
    ArrowSchema,
    ArrowType,
    FlightDescriptor,
    FlightEndpoint,
    FlightInfo,
    LimitRecorder,
)

__all__ = [
    "ARROW_IPC_SUFFIXES",
    "ARROW_JSON_SUFFIXES",
    "ARROW_SUFFIXES",
    "is_arrow",
    "is_arrow_document",
    "parse_arrow",
    "parse_arrow_fileset",
    "read_arrow_document",
    "render_json_form",
]

#: Filename suffixes that name an Arrow schema written as the JSON integration form.
ARROW_JSON_SUFFIXES: Tuple[str, ...] = (".arrow.json", ".flight.json", ".json")

#: Filename suffixes that name a *binary* Arrow IPC stream or file (:mod:`app.arrow_ipc`).
#:
#: Declared here beside the text suffixes so the adapter's picker list, the binary-intake
#: claim and the corpus runner's "is this entry binary?" test all read one tuple.
ARROW_IPC_SUFFIXES: Tuple[str, ...] = (".arrow", ".arrows", ".ipc", ".feather")

#: Every suffix the adapter accepts, binary first because those are unambiguous.
ARROW_SUFFIXES: Tuple[str, ...] = ARROW_IPC_SUFFIXES + ARROW_JSON_SUFFIXES

#: Bounded prefix of a document the content sniff inspects. Detection must be cheap; a
#: schema states its shape in its first object, and a document that needs more than this to
#: look like Arrow is not one.
_SNIFF_BYTES = 64 * 1024

_SCHEMA_MARKER = re.compile(r'"schema"\s*:\s*\{')
_FIELDS_MARKER = re.compile(r'"fields"\s*:\s*\[')
_TYPE_NAME_MARKER = re.compile(r'"type"\s*:\s*\{\s*"name"\s*:\s*"')
_FLIGHT_DESCRIPTOR_MARKER = re.compile(r'"flight_?[Dd]escriptor"\s*:\s*\{')
_SCHEMA_REF_MARKER = re.compile(r'"schema_?[Rr]ef"\s*:\s*"')

#: Permitted values for each enumerated type parameter, so a typo is a stated semantic
#: error rather than a parameter that quietly survives into the model.
_ENUMERATED_PARAMETERS: Dict[Tuple[str, str], Tuple[str, ...]] = {
    ("floatingpoint", "precision"): ("HALF", "SINGLE", "DOUBLE"),
    ("date", "unit"): ("DAY", "MILLISECOND"),
    ("time", "unit"): ("SECOND", "MILLISECOND", "MICROSECOND", "NANOSECOND"),
    ("timestamp", "unit"): ("SECOND", "MILLISECOND", "MICROSECOND", "NANOSECOND"),
    ("duration", "unit"): ("SECOND", "MILLISECOND", "MICROSECOND", "NANOSECOND"),
    ("interval", "unit"): ("YEAR_MONTH", "DAY_TIME", "MONTH_DAY_NANO"),
    ("union", "mode"): ("DENSE", "SPARSE"),
}

#: Bit widths an ``int`` may declare.
_INT_BIT_WIDTHS = (8, 16, 32, 64)

#: Storage widths a ``decimal`` may declare.
_DECIMAL_BIT_WIDTHS = (32, 64, 128, 256)

#: The number of children each nested type name requires. ``struct``, ``union`` and
#: ``map``'s entries struct are variadic and are checked separately.
_REQUIRED_CHILD_COUNT: Dict[str, int] = {
    "list": 1,
    "largelist": 1,
    "listview": 1,
    "largelistview": 1,
    "fixedsizelist": 1,
    "map": 1,
    "runendencoded": 2,
}


def _semantic(message: str, *, where: Optional[str] = None) -> ArrowParseError:
    """Build the error for a document that parses but does not describe a schema."""
    location = f" at `{where}`" if where else ""
    return ArrowParseError(f"{message}{location}", code="INPUT_SEMANTIC_INVALID")


def is_arrow(text: str) -> bool:
    """Whether ``text`` looks like an Arrow schema or Flight response.

    A content sniff over a bounded prefix, so it stays cheap and — as the detection
    contract requires — can never raise. Two shapes claim a document:

    * a ``schema`` object holding ``fields`` whose members carry an Arrow ``type.name``
      (the JSON integration form), or
    * a Flight descriptor alongside either a schema or a reference to one.

    Requiring all three markers of the first shape is what keeps this off its nearest
    neighbours: an Avro ``.avsc`` has ``fields`` and a ``type``, but no ``schema``
    wrapper and no ``type`` *object* naming an Arrow type.

    Args:
        text: The candidate document text.

    Returns:
        ``True`` when the text carries an Arrow marker.
    """
    if not text:
        return False
    head = text[:_SNIFF_BYTES]
    if _FLIGHT_DESCRIPTOR_MARKER.search(head) and (
        _SCHEMA_MARKER.search(head) or _SCHEMA_REF_MARKER.search(head)
    ):
        return True
    return bool(
        _SCHEMA_MARKER.search(head)
        and _FIELDS_MARKER.search(head)
        and _TYPE_NAME_MARKER.search(head)
    )


def is_arrow_document(document: Any) -> bool:
    """Whether an already-parsed mapping is an Arrow schema or Flight response.

    The structural twin of :func:`is_arrow`, for callers that hold the parsed document
    rather than its text.

    Args:
        document: The candidate, usually a ``dict``.

    Returns:
        ``True`` when the mapping carries an Arrow schema or a Flight envelope.
    """
    if not isinstance(document, Mapping):
        return False
    if _flight_descriptor_value(document) is not None:
        return "schema" in document or _schema_ref(document) is not None
    schema = document.get("schema")
    if isinstance(schema, Mapping) and isinstance(schema.get("fields"), list):
        # A `schema` object holding a `fields` array is unambiguous — no other format
        # spells one that way — so an empty schema still counts as an Arrow schema.
        return True
    # The bare form (a schema written without its wrapper) is *not* unambiguous: an Avro
    # `.avsc` is also an object with a `fields` array. It is claimed only on evidence no
    # other format produces — a field whose `type` is an object naming an Arrow type.
    fields = document.get("fields")
    if not isinstance(fields, list):
        return False
    for entry in fields:
        if isinstance(entry, Mapping):
            entry_type = entry.get("type")
            if isinstance(entry_type, Mapping) and entry_type.get("name") in TYPE_NAMES:
                return True
    return False


def _flight_descriptor_value(document: Mapping[str, Any]) -> Optional[Any]:
    """Return the Flight descriptor member under either of its two spellings.

    Flight's protobuf field is ``flight_descriptor``; a JSON mapping produced by a
    protobuf JSON printer spells it ``flightDescriptor``. Both are the same field.
    """
    for key in ("flight_descriptor", "flightDescriptor"):
        value = document.get(key)
        if value is not None:
            return value
    return None


def _schema_ref(document: Mapping[str, Any]) -> Optional[str]:
    """Return the sibling document a Flight envelope defers its schema to, if any."""
    for key in ("schema_ref", "schemaRef"):
        value = document.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first(document: Mapping[str, Any], *keys: str) -> Any:
    """Return the first present member among ``keys`` (snake_case / camelCase spellings)."""
    for key in keys:
        if key in document:
            return document[key]
    return None


# ===========================================================================
# Reading
# ===========================================================================


def parse_arrow(raw: str, *, source_label: Optional[str] = None) -> ArrowDocument:
    """Parse one Arrow document written as the JSON integration form.

    Args:
        raw: The document text.
        source_label: The document's name, used in error messages.

    Returns:
        The parsed :class:`~app.arrow_schema.ArrowDocument`.

    Raises:
        ArrowParseError: With ``code`` set when the reader can classify the failure —
            ``INPUT_TRUNCATED`` for a document that ends mid-value, ``INPUT_TOO_LARGE``
            for one past the reader's ceiling, ``INPUT_SEMANTIC_INVALID`` for one that
            parses but does not describe a schema — and without one for a plain syntax
            error, so the import pipeline classifies it instead.
    """
    document = _load_json(raw, source_label=source_label)
    parsed = read_arrow_document(document, source_label=source_label)
    return ArrowDocument(
        schema=parsed.schema,
        flight=parsed.flight,
        limits=parsed.limits,
        raw=raw,
        source_label=source_label,
    )


def parse_arrow_fileset(
    members: Mapping[str, str],
    *,
    root: str,
    source_label: Optional[str] = None,
) -> ArrowDocument:
    """Parse a Flight response whose schema lives in a sibling document.

    A ``GetFlightInfo`` response names the dataset and lists its endpoints but need not
    repeat the schema; the corpus convention — and the convention a captured Flight
    session follows — is a ``schema_ref`` pointing at the sibling that holds it. The set is
    the unit of import: a reference that resolves in no member is an error rather than a
    deferred lookup, because the alternative is importing a dataset with no columns.

    Args:
        members: The set's documents, keyed by member name.
        root: The member holding the Flight response.
        source_label: Fallback label when the set names no root.

    Returns:
        The composed document: the root's Flight envelope with the referenced schema.

    Raises:
        ArrowParseError: If the root is missing, a reference resolves to nothing, or
            either document is not readable as Arrow.
    """
    if root not in members:
        raise _semantic(f"Arrow fileset is missing its root document `{root}`")
    root_text = members[root]
    document = _load_json(root_text, source_label=root or source_label)

    ref = _schema_ref(document)
    if ref is not None and "schema" not in document:
        member_text = _resolve_member(members, ref, root=root)
        if member_text is None:
            raise ArrowParseError(
                f"Arrow Flight response `{root}` refers to schema `{ref}`, which is not a "
                f"member of this set.",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
        referenced = _load_json(member_text, source_label=ref)
        schema_member = referenced.get("schema") if isinstance(referenced, Mapping) else None
        if not isinstance(schema_member, Mapping):
            raise _semantic(
                f"Arrow Flight response `{root}` refers to `{ref}`, which declares no schema"
            )
        document = {**document, "schema": schema_member}

    parsed = read_arrow_document(document, source_label=root or source_label)
    return ArrowDocument(
        schema=parsed.schema,
        flight=parsed.flight,
        limits=parsed.limits,
        raw=root_text,
        source_label=root or source_label,
    )


def _resolve_member(
    members: Mapping[str, str], reference: str, *, root: str
) -> Optional[str]:
    """Resolve a ``schema_ref`` against a set's members.

    The reference is matched by exact member name first, then by basename, so a set
    unpacked from an archive with a directory prefix resolves the same way a flat one
    does. It is never resolved outside the set: an absolute or parent-relative reference
    simply does not match, which is what keeps a hostile document from naming a file on
    the host.

    Args:
        members: The set's documents.
        reference: The declared reference.
        root: The referring member, whose directory a relative reference is read against.

    Returns:
        The referenced member's text, or ``None`` when nothing in the set matches.
    """
    if reference in members:
        return members[reference]
    prefix = root.rsplit("/", 1)[0] + "/" if "/" in root else ""
    joined = f"{prefix}{reference}"
    if joined in members:
        return members[joined]
    basename = reference.rsplit("/", 1)[-1]
    for name, text in members.items():
        if name.rsplit("/", 1)[-1] == basename:
            return text
    return None


def _load_json(raw: str, *, source_label: Optional[str]) -> Dict[str, Any]:
    """Decode one Arrow document's text into a mapping, bounded and classified.

    Args:
        raw: The document text.
        source_label: The document's name, for error messages.

    Returns:
        The parsed top-level object.

    Raises:
        ArrowParseError: ``INPUT_TOO_LARGE`` past the byte ceiling, ``INPUT_TRUNCATED``
            when the decoder stops at the end of the text (the document was cut short),
            and — for any other syntax fault, and for a top-level value that is not an
            object — with no code, so the pipeline classifies it.
    """
    where = f" ({source_label})" if source_label else ""
    if raw is None or not raw.strip():
        raise ArrowParseError(f"Arrow document is empty{where}", code="INPUT_EMPTY")
    size = len(raw.encode("utf-8", errors="replace"))
    if size > MAX_DOCUMENT_BYTES:
        raise ArrowParseError(
            f"Arrow document is {size} bytes, above the {MAX_DOCUMENT_BYTES}-byte reader "
            f"ceiling{where}",
            code="INPUT_TOO_LARGE",
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        if _looks_truncated(raw, exc):
            raise ArrowParseError(
                f"Arrow document ends mid-value{where}: {exc.msg}", code="INPUT_TRUNCATED"
            ) from exc
        raise ArrowParseError(f"Arrow document is not valid JSON{where}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ArrowParseError(
            f"Arrow document must be a JSON object at the top level{where}"
        )
    return parsed


def _looks_truncated(raw: str, exc: json.JSONDecodeError) -> bool:
    """Whether a JSON decode failure is a *truncation* rather than a syntax error.

    Truncation is a position, not a message: a document cut short fails at — or past — its
    own last non-blank character, because the decoder consumed everything there was and
    still wanted more. A syntax error inside an otherwise complete document fails before
    that point. The one message that has to be named explicitly is an unterminated string,
    which is reported at the *opening* quote rather than at the end.

    Args:
        raw: The document text.
        exc: The decoder's error.

    Returns:
        ``True`` when the failure is a truncation.
    """
    if exc.msg.startswith("Unterminated string"):
        return True
    return exc.pos >= len(raw.rstrip())


def read_arrow_document(
    document: Mapping[str, Any], *, source_label: Optional[str] = None
) -> ArrowDocument:
    """Read an already-parsed Arrow/Flight mapping into an :class:`ArrowDocument`.

    The shared entry point for every textual surface: :func:`parse_arrow` calls it with a
    decoded file, :func:`parse_arrow_fileset` with a composed one, and a caller holding a
    Flight response mapping can call it directly. ``raw`` is left unset — the caller owns
    the source text.

    Args:
        document: The parsed top-level object.
        source_label: The document's name, for error messages.

    Returns:
        The document, with the schema read and Flight envelope resolved.

    Raises:
        ArrowParseError: When the mapping does not describe an Arrow schema.
    """
    where = "" if source_label is None else f" ({source_label})"
    if not is_arrow_document(document):
        # Deliberately *uncoded*: a document with no Arrow schema in it is not a broken
        # Arrow document, it is a document of some other format handed to this adapter.
        # Leaving the code off is what lets the import pipeline call it FORMAT_MISMATCH
        # when another adapter confidently claims it (an Avro `.avsc` is the near
        # neighbour that makes this matter) and INPUT_MALFORMED when nobody does.
        raise ArrowParseError(f"Document does not declare an Arrow schema{where}")
    limits = LimitRecorder()
    flight = _read_flight(document, limits)
    schema_member = document.get("schema")
    if not isinstance(schema_member, Mapping):
        # A bare schema object — Arrow's integration files wrap the schema in a document
        # that also carries record batches, but a schema exchanged on its own is often
        # written without the wrapper.
        schema_member = document
    if not isinstance(schema_member, Mapping):
        raise _semantic(f"Arrow document declares no `schema` object{where}")
    schema = _read_schema(schema_member)
    return ArrowDocument(
        schema=schema,
        flight=flight,
        limits=limits.limits(),
        raw=None,
        source_label=source_label,
    )


def _read_schema(member: Mapping[str, Any]) -> ArrowSchema:
    """Read the ``schema`` object: its fields, its metadata and its declared endianness."""
    raw_fields = member.get("fields")
    if not isinstance(raw_fields, list):
        raise _semantic("Arrow schema declares no `fields` array")
    budget = _FieldBudget()
    fields = tuple(
        _read_field(entry, path=str(index), depth=1, budget=budget)
        for index, entry in enumerate(raw_fields)
    )
    endianness = member.get("endianness")
    return ArrowSchema(
        fields=fields,
        metadata=_read_metadata(member.get("metadata"), where="schema"),
        endianness=endianness if isinstance(endianness, str) and endianness else None,
    )


class _FieldBudget:
    """Counts fields across the whole schema so a wide document is bounded once.

    Depth is bounded per branch and width is bounded per document, and both have to be
    charged from one place: a schema can be pathological in either dimension alone.
    """

    def __init__(self) -> None:
        self.count = 0

    def charge(self, path: str) -> None:
        """Charge one field, refusing past :data:`~app.arrow_schema.MAX_FIELDS`."""
        self.count += 1
        if self.count > MAX_FIELDS:
            raise ArrowParseError(
                f"Arrow schema declares more than {MAX_FIELDS} fields (at `{path}`)",
                code="INPUT_TOO_LARGE",
            )


def _read_field(entry: Any, *, path: str, depth: int, budget: _FieldBudget) -> ArrowField:
    """Read one field and, recursively, its children.

    Args:
        entry: The field object.
        path: The field's path from the schema root, for error messages.
        depth: Current nesting depth, 1 for a top-level column.
        budget: The document-wide field counter.

    Returns:
        The parsed field.

    Raises:
        ArrowParseError: For a malformed field, an unknown type name, a nested type with
            no children, or a document past a reader ceiling.
    """
    if depth > MAX_DEPTH:
        raise ArrowParseError(
            f"Arrow schema nests more than {MAX_DEPTH} levels deep (at `{path}`)",
            code="INPUT_DEPTH_LIMIT",
        )
    if not isinstance(entry, Mapping):
        raise _semantic("Arrow field must be an object", where=path)
    budget.charge(path)

    name = entry.get("name")
    if not isinstance(name, str):
        raise _semantic("Arrow field declares no `name`", where=path)
    where = f"{path}:{name}" if name else path

    type_ = _read_type(entry.get("type"), where=where)
    nullable = entry.get("nullable")
    if nullable is not None and not isinstance(nullable, bool):
        raise _semantic("Arrow field `nullable` must be a boolean", where=where)

    raw_children = entry.get("children")
    if raw_children is None:
        raw_children = []
    if not isinstance(raw_children, list):
        raise _semantic("Arrow field `children` must be an array", where=where)
    children = tuple(
        _read_field(child, path=f"{where}/{index}", depth=depth + 1, budget=budget)
        for index, child in enumerate(raw_children)
    )
    _check_children(type_, children, where=where)

    return ArrowField(
        name=name,
        type=type_,
        nullable=True if nullable is None else nullable,
        children=children,
        dictionary=_read_dictionary(entry.get("dictionary"), where=where),
        metadata=_read_metadata(entry.get("metadata"), where=where),
    )


def _read_type(member: Any, *, where: str) -> ArrowType:
    """Read one ``type`` object, keeping only the parameters its name declares."""
    if not isinstance(member, Mapping):
        raise _semantic("Arrow field declares no `type` object", where=where)
    name = member.get("name")
    if not isinstance(name, str) or not name:
        raise _semantic("Arrow type declares no `name`", where=where)
    key = name.strip().lower()
    if key not in TYPE_NAMES:
        raise _semantic(f"`{name}` is not an Arrow type name", where=where)
    parameters: Dict[str, Any] = {}
    for parameter in TYPE_PARAMETERS[key]:
        if parameter in member:
            parameters[parameter] = member[parameter]
    _check_parameters(key, parameters, where=where)
    return ArrowType(name=key, parameters=parameters)


def _check_parameters(name: str, parameters: Mapping[str, Any], *, where: str) -> None:
    """Validate one type's parameters against the vocabulary its name admits.

    Raises:
        ArrowParseError: ``INPUT_SEMANTIC_INVALID`` for a parameter outside its declared
            domain — an ``int`` of 12 bits, a ``timestamp`` in furlongs, a ``union`` whose
            type-code list does not match its variants.
    """
    for parameter, value in parameters.items():
        allowed = _ENUMERATED_PARAMETERS.get((name, parameter))
        if allowed is not None and value not in allowed:
            raise _semantic(
                f"Arrow `{name}` declares {parameter} `{value}`; expected one of "
                f"{', '.join(allowed)}",
                where=where,
            )
    if name == "int":
        width = parameters.get("bitWidth")
        if width not in _INT_BIT_WIDTHS:
            raise _semantic(
                f"Arrow `int` declares bitWidth `{width}`; expected one of "
                f"{', '.join(str(value) for value in _INT_BIT_WIDTHS)}",
                where=where,
            )
        if not isinstance(parameters.get("isSigned"), bool):
            raise _semantic("Arrow `int` declares no boolean `isSigned`", where=where)
    if name == "decimal":
        precision = parameters.get("precision")
        scale = parameters.get("scale")
        if not isinstance(precision, int) or isinstance(precision, bool) or precision <= 0:
            raise _semantic(
                "Arrow `decimal` declares no positive integer `precision`", where=where
            )
        if not isinstance(scale, int) or isinstance(scale, bool):
            raise _semantic("Arrow `decimal` declares no integer `scale`", where=where)
        width = parameters.get("bitWidth", 128)
        if width not in _DECIMAL_BIT_WIDTHS:
            raise _semantic(
                f"Arrow `decimal` declares bitWidth `{width}`; expected one of "
                f"{', '.join(str(value) for value in _DECIMAL_BIT_WIDTHS)}",
                where=where,
            )
    for parameter, minimum in (("byteWidth", 0), ("listSize", 0)):
        if parameter in parameters:
            value = parameters[parameter]
            if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
                raise _semantic(
                    f"Arrow `{name}` declares {parameter} `{value}`; expected a "
                    f"non-negative integer",
                    where=where,
                )
    if name == "union":
        type_ids = parameters.get("typeIds")
        if type_ids is not None and (
            not isinstance(type_ids, list)
            or any(not isinstance(value, int) or isinstance(value, bool) for value in type_ids)
        ):
            raise _semantic("Arrow `union` declares a non-integer typeIds entry", where=where)
    if name == "map":
        sorted_flag = parameters.get("keysSorted")
        if sorted_flag is not None and not isinstance(sorted_flag, bool):
            raise _semantic("Arrow `map` declares a non-boolean `keysSorted`", where=where)


def _check_children(
    type_: ArrowType, children: Sequence[ArrowField], *, where: str
) -> None:
    """Validate a field's children against what its type requires.

    A nested Arrow type is defined *by* its children: a ``struct`` with no members and a
    ``list`` with no element field describe nothing, and a ``map`` whose child is not the
    two-member ``entries`` struct is not a map. Enforcing that here is what makes a
    structurally impossible schema a stated semantic error instead of a model with an
    empty record in it.

    Raises:
        ArrowParseError: ``INPUT_SEMANTIC_INVALID`` when the children do not match.
    """
    if type_.name not in NESTED_TYPE_NAMES:
        return
    if not children:
        raise _semantic(
            f"Arrow `{type_.name}` declares no children; a nested type is defined by them",
            where=where,
        )
    required = _REQUIRED_CHILD_COUNT.get(type_.name)
    if required is not None and len(children) != required:
        raise _semantic(
            f"Arrow `{type_.name}` declares {len(children)} children; expected {required}",
            where=where,
        )
    if type_.name == "map":
        entries = children[0]
        if entries.type.name != "struct" or len(entries.children) != 2:
            raise _semantic(
                "Arrow `map` child must be a struct of exactly `key` and `value`",
                where=where,
            )
    if type_.name == "union":
        type_ids = type_.parameter("typeIds")
        if isinstance(type_ids, list) and len(type_ids) != len(children):
            raise _semantic(
                f"Arrow `union` declares {len(type_ids)} typeIds for {len(children)} "
                f"variants",
                where=where,
            )


def _read_dictionary(member: Any, *, where: str) -> Optional[ArrowDictionaryEncoding]:
    """Read a field's dictionary encoding, when it declares one."""
    if member is None:
        return None
    if not isinstance(member, Mapping):
        raise _semantic("Arrow field `dictionary` must be an object", where=where)
    index_member = _first(member, "indexType", "index_type")
    if index_member is None:
        index_type = ArrowType(name="int", parameters={"bitWidth": 32, "isSigned": True})
    else:
        index_type = _read_type(index_member, where=f"{where}/dictionary")
        if index_type.name != "int":
            raise _semantic(
                f"Arrow dictionary index type must be an integer, not `{index_type.name}`",
                where=where,
            )
    ordered = _first(member, "isOrdered", "is_ordered")
    if ordered is not None and not isinstance(ordered, bool):
        raise _semantic("Arrow dictionary `isOrdered` must be a boolean", where=where)
    return ArrowDictionaryEncoding(index_type=index_type, is_ordered=bool(ordered))


def _read_metadata(member: Any, *, where: str) -> Tuple[Tuple[str, str], ...]:
    """Read key/value metadata in either of the two shapes Arrow writes it in.

    The integration form writes ``[{"key": …, "value": …}, …]``; a schema serialized from
    a language binding's mapping is often written as a plain object. Both are read, in
    declaration order, because metadata order is how an author groups related keys.
    """
    if member is None:
        return ()
    if isinstance(member, Mapping):
        return tuple((str(key), _metadata_text(value)) for key, value in member.items())
    if not isinstance(member, list):
        raise _semantic("Arrow `metadata` must be an array or an object", where=where)
    pairs: List[Tuple[str, str]] = []
    for entry in member:
        if not isinstance(entry, Mapping) or "key" not in entry:
            raise _semantic("Arrow metadata entry must be an object with a `key`", where=where)
        pairs.append((str(entry["key"]), _metadata_text(entry.get("value"))))
    return tuple(pairs)


def _metadata_text(value: Any) -> str:
    """Render a metadata value as the text Arrow stores it as."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _read_flight(document: Mapping[str, Any], limits: LimitRecorder) -> Optional[FlightInfo]:
    """Read the Flight envelope around a schema, when the document is a Flight response."""
    descriptor_member = _flight_descriptor_value(document)
    endpoint_member = _first(document, "endpoint", "endpoints")
    if descriptor_member is None and endpoint_member is None:
        return None

    descriptor: Optional[FlightDescriptor] = None
    if isinstance(descriptor_member, Mapping):
        raw_path = descriptor_member.get("path")
        path = (
            tuple(str(segment) for segment in raw_path)
            if isinstance(raw_path, list)
            else ()
        )
        cmd = descriptor_member.get("cmd")
        descriptor = FlightDescriptor(
            type=str(descriptor_member.get("type") or ("CMD" if cmd else "PATH")).upper(),
            path=path,
            cmd=cmd if isinstance(cmd, str) and cmd else None,
        )

    endpoints: List[FlightEndpoint] = []
    if isinstance(endpoint_member, list):
        for entry in endpoint_member:
            if not isinstance(entry, Mapping):
                continue
            ticket_member = entry.get("ticket")
            ticket = None
            if isinstance(ticket_member, Mapping):
                inner = ticket_member.get("ticket")
                ticket = inner if isinstance(inner, str) else None
            elif isinstance(ticket_member, str):
                ticket = ticket_member
            location_member = _first(entry, "location", "locations")
            locations: List[str] = []
            if isinstance(location_member, list):
                for location in location_member:
                    if isinstance(location, Mapping) and isinstance(location.get("uri"), str):
                        locations.append(location["uri"])
                    elif isinstance(location, str):
                        locations.append(location)
            endpoints.append(FlightEndpoint(ticket=ticket, locations=tuple(locations)))

    if endpoints:
        limits.record("arrow.flight_endpoint", location=_descriptor_label(descriptor))

    return FlightInfo(
        descriptor=descriptor,
        endpoints=tuple(endpoints),
        total_records=_optional_int(_first(document, "total_records", "totalRecords")),
        total_bytes=_optional_int(_first(document, "total_bytes", "totalBytes")),
        ordered=_first(document, "ordered") if isinstance(_first(document, "ordered"), bool) else None,
    )


def _descriptor_label(descriptor: Optional[FlightDescriptor]) -> str:
    """Return the human name of a Flight descriptor, for limit locations."""
    if descriptor is None:
        return "flight"
    if descriptor.path:
        return "/".join(descriptor.path)
    return descriptor.cmd or "flight"


def _optional_int(value: Any) -> Optional[int]:
    """Coerce a Flight count to ``int``; Flight writes ``-1`` when it does not know."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


# ===========================================================================
# Writing
# ===========================================================================


def render_json_form(
    schema: ArrowSchema, *, flight: Optional[FlightInfo] = None, indent: int = 2
) -> str:
    """Render a schema back into the JSON integration form.

    The inverse of :func:`read_arrow_document`, and the reason an IPC or Flight document
    can carry a readable ``raw``: those surfaces have no source text, and rendering their
    schema in Arrow's own textual form is more honest than storing base64 of a Flatbuffer.
    Reading the result back produces an equal :class:`ArrowSchema`.

    Args:
        schema: The schema to render.
        flight: The Flight envelope to wrap it in, when there is one.
        indent: JSON indentation.

    Returns:
        The rendered document, newline-terminated.
    """
    document: Dict[str, Any] = {}
    if flight is not None and flight.descriptor is not None:
        document["flight_descriptor"] = _render_descriptor(flight.descriptor)
    if flight is not None and flight.endpoints:
        document["endpoint"] = [
            _render_endpoint(endpoint) for endpoint in flight.endpoints
        ]
    document["schema"] = _render_schema(schema)
    if flight is not None:
        if flight.total_records is not None:
            document["total_records"] = flight.total_records
        if flight.total_bytes is not None:
            document["total_bytes"] = flight.total_bytes
        if flight.ordered is not None:
            document["ordered"] = flight.ordered
    return json.dumps(document, indent=indent) + "\n"


def _render_schema(schema: ArrowSchema) -> Dict[str, Any]:
    """Render the ``schema`` object."""
    rendered: Dict[str, Any] = {"fields": [_render_field(f) for f in schema.fields]}
    if schema.metadata:
        rendered["metadata"] = _render_metadata(schema.metadata)
    if schema.endianness:
        rendered["endianness"] = schema.endianness
    return rendered


def _render_field(field_: ArrowField) -> Dict[str, Any]:
    """Render one field, children first-class so the shape matches what was read."""
    rendered: Dict[str, Any] = {
        "name": field_.name,
        "type": _render_type(field_.type),
        "nullable": field_.nullable,
        "children": [_render_field(child) for child in field_.children],
    }
    if field_.dictionary is not None:
        rendered["dictionary"] = {
            "indexType": _render_type(field_.dictionary.index_type),
            "isOrdered": field_.dictionary.is_ordered,
        }
    if field_.metadata:
        rendered["metadata"] = _render_metadata(field_.metadata)
    return rendered


def _render_type(type_: ArrowType) -> Dict[str, Any]:
    """Render one type object, parameters in the order :data:`TYPE_PARAMETERS` names them."""
    rendered: Dict[str, Any] = {"name": type_.name}
    for parameter in TYPE_PARAMETERS[type_.name]:
        if parameter in type_.parameters:
            rendered[parameter] = type_.parameters[parameter]
    return rendered


def _render_metadata(metadata: Sequence[Tuple[str, str]]) -> List[Dict[str, str]]:
    """Render key/value metadata as the integration form's array of objects."""
    return [{"key": key, "value": value} for key, value in metadata]


def _render_descriptor(descriptor: FlightDescriptor) -> Dict[str, Any]:
    """Render a Flight descriptor."""
    rendered: Dict[str, Any] = {"type": descriptor.type}
    if descriptor.path:
        rendered["path"] = list(descriptor.path)
    if descriptor.cmd is not None:
        rendered["cmd"] = descriptor.cmd
    return rendered


def _render_endpoint(endpoint: FlightEndpoint) -> Dict[str, Any]:
    """Render a Flight endpoint."""
    rendered: Dict[str, Any] = {}
    if endpoint.ticket is not None:
        rendered["ticket"] = {"ticket": endpoint.ticket}
    if endpoint.locations:
        rendered["location"] = [{"uri": uri} for uri in endpoint.locations]
    return rendered

