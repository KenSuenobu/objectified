# Apache Arrow / Flight schema — `arrow`

Fixtures for **FMT-4.5** ([#5438](https://github.com/apiome/apiome/issues/5438)). The Parquet/Arrow
**emitter** is filed (**#4317**); nothing reads an Arrow schema or a Flight `GetSchema` response yet,
so these entries carry `adapter_key: null` and the `pending-adapter` tag.

**Form.** These fixtures use the **JSON integration-test form** — Arrow's own textual representation
of a schema (`{"schema": {"fields": [...], "metadata": [...]}}`), the same shape the Arrow integration
suite exchanges. It is the half of FMT-4.5 that can be committed as readable text.

> **Binary IPC fixtures are deliberately absent.** An Arrow IPC `.arrow` stream is a Flatbuffer
> serialization that must be produced by an Arrow implementation, not hand-authored. When the adapter
> lands, generate the IPC twins from these JSON schemas with `pyarrow` (one call per fixture) and add
> them beside these entries with the `binary-intake` feature — the acceptance criterion is that an IPC
> schema and its JSON form import to the *same* canonical model.

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
| `negative/` | — | Trailing comma, an unknown `type.name`, truncation, an Avro `.avsc` (the neighbour most easily confused), UTF-16, and nested types declared with **no children** (semantically impossible for `struct`/`list`). |

**Contract the adapter must meet.** Nested, dictionary-encoded and decimal types are modelled or
declared limits; a Flight `GetSchema` discovery path imports from a live endpoint in an integration
test; round-trip against **#4317**'s emitter is asserted once both exist.
