# Apache Arrow / Flight schema — `arrow`

Fixtures for **FMT-4.5** ([#5438](https://github.com/apiome/apiome/issues/5438)), read by the
`arrow` adapter. The Parquet/Arrow **emitter** is still filed as **#4317**, so this format is
import-only: the round-trip cell against its own emitter lands when that issue does.

**Two forms, one model.** Most fixtures use the **JSON integration-test form** — Arrow's own
textual representation of a schema (`{"schema": {"fields": [...], "metadata": [...]}}`), the same
shape the Arrow integration suite exchanges. Two of them additionally ship as **binary IPC twins**
(`08`, `09`), serialized from their JSON siblings with `pyarrow`.

> **The twins are the acceptance criterion, committed.** `08` is the IPC form of `03` and `09` is
> the IPC form of `05`. Their canonical golden snapshots under
> `apiome-rest/tests/golden/corpus/arrow/` are byte-identical to their twins' apart from the
> `corpus_path` field — an IPC schema and its JSON form do not merely resemble each other, they
> import to the *same* canonical model. `apiome-rest/tests/test_arrow_ipc_parity.py` asserts the
> same property over every fixture, including the stress ladder.

**Detection marker.** A top-level `schema` object whose `fields[]` carry Arrow `type.name` values
(`int`/`utf8`/`timestamp`/`struct`/…), each with `nullable` and `children`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-schema.json` | minimal | Two flat fields. |
| `02-typical-orders-schema.json` | typical | Timestamps with a timezone, fixed-size binary, schema-level metadata. |
| `03-composition-nested-types.json` | composition | Nested `struct`, `list` of `struct`, and `map` (the `entries`/`key`/`value` child convention). |
| `04-stress-type-coverage.json` | stress | Every Arrow type family: all int widths, three float precisions, decimal128/256, date/time/timestamp/interval/duration units, large variants, fixed-size list, dense **and** sparse unions, dictionary encoding (ordered and not), and an `ARROW:extension:name` extension type. |
| `05-real-world-trip-records-schema.json` | real-world | Analytical table as published: dictionary-encoded low-cardinality columns, decimal money, partitioning metadata. |
| `06-typical-flight-getschema-response.json` | typical | A Flight `GetSchema` response: flight descriptor plus schema — the discovery-path shape. |
| `07-flight-set/` | multi-file | `GetFlightInfo` with two endpoints plus the schema it points at. |
| `08-composition-nested-types.arrow` | composition | Binary IPC twin of `03`, read through the `parse_bytes` seam. |
| `09-real-world-trip-records.arrow` | real-world | Binary IPC twin of `05` — dictionary-encoded and decimal columns. |
| `negative/` | — | Trailing comma, an unknown `type.name`, truncation, an Avro `.avsc` (the neighbour most easily confused), UTF-16, nested types declared with **no children** (semantically impossible for `struct`/`list`), and a **cut-short IPC payload** (a stream message declares its own length, so truncation is a framing fact). |

**Contract the adapter meets.** Nested types are modelled exactly; dictionary encoding, decimal
precision/scale, extension types, union layout, intervals, half precision, the large-offset/view
variants, temporal resolution and Flight endpoints are counted, located declared limits in
`extras['arrow']['capability_limits']`. A Flight `GetSchema` discovery path imports from a live
endpoint in `apiome-rest/tests/test_arrow_flight_discovery.py`, which starts a real
`pyarrow.flight` server on loopback. Round-trip against **#4317**'s emitter is asserted once both
exist.

**One thing deliberately not modelled.** A dictionary's numeric `id` names a message in an IPC
stream rather than a property of the data, so it is not carried — keeping it would make an IPC
document and its JSON twin normalize differently for a reason that is not about the schema.
