"""Arrow IPC intake and JSON/IPC parity — FMT-4.5 (#5438).

The suite behind the ticket's first acceptance criterion: *an Arrow IPC schema and a
JSON-form schema both import to the same canonical model.* It is asserted two ways, and
both matter.

**In the corpus, as committed artifacts.** ``arrow/08-…arrow`` and ``arrow/09-…arrow`` are
IPC twins of two JSON fixtures, and their golden snapshots are byte-identical to their
twins' apart from the corpus path. That is a fact anyone can check with ``diff`` without
running Python.

**Here, exhaustively.** Every JSON fixture is serialized to IPC through ``pyarrow`` and
read straight back, and the two canonical models must be equal — not merely similar. That
is a stronger claim than the corpus makes, because it covers the stress fixture's whole
type ladder rather than the two committed pairs.

``pyarrow`` is a declared dependency; the suite skips rather than fails without it, so a
runtime that cannot build the native wheel still runs the rest of the adapter's tests.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import List, Tuple

import pytest

from app.arrow_ipc import (
    ARROW_FILE_MAGIC,
    ARROW_STREAM_MAGIC,
    ArrowIpcError,
    pyarrow_available,
    read_ipc_schema,
    schema_from_pyarrow,
    schema_to_pyarrow,
    serialize_ipc_schema,
    sniff_arrow_ipc,
)
from app.arrow_parser import parse_arrow
from app.arrow_schema import ArrowSchema
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    get_import_source,
    load_builtin_import_sources,
)

load_builtin_import_sources()

pytestmark = pytest.mark.skipif(
    not pyarrow_available(), reason="pyarrow is not installed in this runtime"
)

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "arrow"

#: The JSON fixtures an IPC twin can be built from, and the fields that must be dropped
#: first because ``pyarrow``'s Python API exposes no constructor for them.
#:
#: The Arrow *format* defines three interval units; ``pyarrow`` can construct one. A
#: ``YEAR_MONTH`` interval therefore reads back correctly from an IPC payload produced by
#: another implementation but cannot be serialized from here — a limitation of the
#: serializer this test uses, not of the reader under test, which is why it is named and
#: bounded rather than worked around.
PARITY_FIXTURES: List[Tuple[str, Tuple[str, ...]]] = [
    ("01-minimal-schema.json", ()),
    ("02-typical-orders-schema.json", ()),
    ("03-composition-nested-types.json", ()),
    ("04-stress-type-coverage.json", ("f_interval_ym",)),
    ("05-real-world-trip-records-schema.json", ()),
    ("06-typical-flight-getschema-response.json", ()),
]


def _fixture(name: str) -> str:
    """Return a shipped corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _without(schema: ArrowSchema, names: Tuple[str, ...]) -> ArrowSchema:
    """Return ``schema`` without the named columns."""
    if not names:
        return schema
    return dataclasses.replace(
        schema, fields=tuple(f for f in schema.fields if f.name not in names)
    )


# ===========================================================================
# The acceptance criterion
# ===========================================================================


@pytest.mark.parametrize(("name", "unconstructible"), PARITY_FIXTURES)
def test_an_ipc_schema_and_its_json_twin_are_one_canonical_model(
    name: str, unconstructible: Tuple[str, ...]
) -> None:
    adapter = get_import_source("arrow")
    json_document = parse_arrow(_fixture(name), source_label=name)
    schema = _without(json_document.schema, unconstructible)
    json_document = dataclasses.replace(json_document, schema=schema)

    ipc_document = read_ipc_schema(serialize_ipc_schema(schema), source_label=f"{name}.arrow")
    # A Flight reply carries its descriptor beside the schema, exactly as
    # `arrow_flight.discover_flight_schema` supplies it; the JSON envelope states it inline.
    ipc_document = dataclasses.replace(
        ipc_document, flight=json_document.flight, limits=json_document.limits
    )

    from_json = adapter.normalize(json_document, include_raw=False)
    from_ipc = adapter.normalize(ipc_document, include_raw=False)
    assert from_ipc == from_json
    assert canonical_fingerprint(from_ipc) == canonical_fingerprint(from_json)


@pytest.mark.parametrize(
    ("binary", "text"),
    [
        ("08-composition-nested-types.arrow", "03-composition-nested-types.json"),
        ("09-real-world-trip-records.arrow", "05-real-world-trip-records-schema.json"),
    ],
)
def test_the_committed_twins_fingerprint_identically(binary: str, text: str) -> None:
    adapter = get_import_source("arrow")
    from_bytes = adapter.normalize(
        adapter.parse_bytes((CORPUS / binary).read_bytes(), source_label=binary),
        include_raw=False,
    )
    from_text = adapter.normalize(adapter.parse(_fixture(text), source_label=text), include_raw=False)
    assert canonical_fingerprint(from_bytes) == canonical_fingerprint(from_text)


@pytest.mark.parametrize(("name", "unconstructible"), PARITY_FIXTURES)
def test_the_pyarrow_bridge_is_a_fixed_point(name: str, unconstructible: Tuple[str, ...]) -> None:
    """`schema_from_pyarrow(schema_to_pyarrow(s)) == s` — the parity claim, one level down."""
    schema = _without(parse_arrow(_fixture(name)).schema, unconstructible)
    assert schema_from_pyarrow(schema_to_pyarrow(schema)) == schema


# ===========================================================================
# Binary intake
# ===========================================================================


def test_the_adapter_claims_ipc_bytes() -> None:
    adapter = get_import_source("arrow")
    data = (CORPUS / "08-composition-nested-types.arrow").read_bytes()
    assert adapter.accepts_bytes(data, filename="columns.arrow") is True
    assert adapter.accepts_bytes(data, filename=None) is True


def test_a_conventional_suffix_claims_even_broken_bytes() -> None:
    """IXH-7.5's rule: a cut-short `.arrow` must be reported by the binary reader."""
    adapter = get_import_source("arrow")
    assert adapter.accepts_bytes(b"not arrow at all", filename="columns.arrow") is True
    assert adapter.accepts_bytes(b"not arrow at all", filename="columns.json") is False


def test_a_json_document_is_never_routed_to_the_binary_reader() -> None:
    adapter = get_import_source("arrow")
    assert adapter.accepts_bytes(_fixture("01-minimal-schema.json").encode(), filename="s.json") is False


def test_an_ipc_file_container_reads() -> None:
    """`pa.ipc.new_file` writes the `ARROW1` container; the reader accepts it too."""
    import io

    import pyarrow as pa

    schema = schema_to_pyarrow(parse_arrow(_fixture("01-minimal-schema.json")).schema)
    buffer = io.BytesIO()
    with pa.ipc.new_file(buffer, schema):
        pass
    data = buffer.getvalue()
    assert data.startswith(ARROW_FILE_MAGIC)
    assert sniff_arrow_ipc(data) is True
    assert [f.name for f in read_ipc_schema(data).schema.fields] == ["id", "label"]


def test_an_ipc_stream_container_reads() -> None:
    import io

    import pyarrow as pa

    schema = schema_to_pyarrow(parse_arrow(_fixture("01-minimal-schema.json")).schema)
    buffer = io.BytesIO()
    with pa.ipc.new_stream(buffer, schema):
        pass
    data = buffer.getvalue()
    assert data.startswith(ARROW_STREAM_MAGIC)
    assert [f.name for f in read_ipc_schema(data).schema.fields] == ["id", "label"]


def test_an_ipc_document_carries_a_readable_raw() -> None:
    """The bytes are not text, so the fidelity bag holds Arrow's own textual form."""
    document = read_ipc_schema((CORPUS / "08-composition-nested-types.arrow").read_bytes())
    assert document.raw is not None
    assert parse_arrow(document.raw).schema == document.schema


# ===========================================================================
# Binary negatives
# ===========================================================================


def test_a_cut_short_payload_is_truncated_not_malformed() -> None:
    adapter = get_import_source("arrow")
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_bytes(
            (CORPUS / "negative" / "07-truncated-ipc-schema.arrow").read_bytes(),
            source_label="07-truncated-ipc-schema.arrow",
        )
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_payload_that_delivers_what_it_promised_and_is_unreadable_is_malformed() -> None:
    full = (CORPUS / "08-composition-nested-types.arrow").read_bytes()
    with pytest.raises(ArrowIpcError) as excinfo:
        read_ipc_schema(full[:8] + b"\xa5" * (len(full) - 8))
    assert excinfo.value.code == "INPUT_MALFORMED"


def test_an_empty_payload_is_empty() -> None:
    with pytest.raises(ArrowIpcError) as excinfo:
        read_ipc_schema(b"")
    assert excinfo.value.code == "INPUT_EMPTY"


def test_the_ipc_sniff_never_claims_arbitrary_bytes() -> None:
    assert sniff_arrow_ipc(b"") is False
    assert sniff_arrow_ipc(b"{}") is False
    assert sniff_arrow_ipc(b"ARROW") is False
    # A continuation marker followed by a nonsensical length is four coincidental bytes.
    assert sniff_arrow_ipc(ARROW_STREAM_MAGIC + b"\x00\x00\x00\x00") is False


def test_detection_reads_the_bytes_when_the_pipeline_supplies_them() -> None:
    adapter = get_import_source("arrow")
    data = (CORPUS / "09-real-world-trip-records.arrow").read_bytes()
    assert adapter.detect(DetectionInput(data=data)).format == "arrow"


# ===========================================================================
# The serializer's stated boundary
# ===========================================================================


def test_an_unconstructible_interval_is_refused_with_a_stated_reason() -> None:
    schema = parse_arrow(_fixture("04-stress-type-coverage.json")).schema
    with pytest.raises(ArrowIpcError) as excinfo:
        schema_to_pyarrow(schema)
    assert "YEAR_MONTH" in str(excinfo.value)


def test_that_interval_still_reads_from_the_json_surface() -> None:
    """The boundary is the serializer's; the reader models it and declares the limit."""
    document = parse_arrow(_fixture("04-stress-type-coverage.json"))
    field = next(f for f in document.schema.fields if f.name == "f_interval_ym")
    assert field.type.unit == "YEAR_MONTH"
