# Kafka Connect schema — `kafka-connect`

Fixtures for **FMT-5.3** ([#5441](https://github.com/apiome/apiome/issues/5441)). Connect's schema
form — `{type, optional, name, version, doc, fields, parameters}` — is what a Connect pipeline
actually carries between systems, and it is neither Avro nor JSON Schema. Apicurio types it natively;
Apiome has the two things on either side of it and not the thing in the middle. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** `"type": "struct"` with a `fields[]` array whose members use the key `field`
(not `name`), each with its own `type` and `optional`. The envelope form nests that under `schema`
beside a `payload`.

**Logical types these fixtures carry**

| `name` | Base type | Parameters |
| --- | --- | --- |
| `org.apache.kafka.connect.data.Decimal` | `bytes` | `scale`, `connect.decimal.precision` |
| `org.apache.kafka.connect.data.Date` | `int32` | — |
| `org.apache.kafka.connect.data.Time` | `int32` | — |
| `org.apache.kafka.connect.data.Timestamp` | `int64` | — |
| `io.debezium.time.MicroTimestamp` / `ZonedTimestamp` | `int64` / `string` | — |
| `io.debezium.data.Enum` | `string` | `allowed` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-struct.json` | minimal | Two required primitive fields. |
| `02-typical-order-schema.json` | typical | `version`, `doc`, optionality, defaults. |
| `03-composition-nested-and-map.json` | composition | Nested structs, `array.items`, `map.keys`/`map.values`, a Decimal inside a list element. |
| `04-stress-logical-types-and-parameters.json` | stress | Every primitive, every bundled logical type, connector-specific logical types, schema-level and field-level `parameters`, array-of-array, map-of-struct, optional struct with a `null` default. |
| `05-real-world-change-event-schema.json` | real-world | A CDC change-event envelope: `before`/`after` row images sharing one named schema, a `source` block, `op`, and a transaction block. |
| `06-typical-schema-payload-envelope.json` | typical | The `{schema, payload}` envelope a JSON converter writes with `schemas.enable=true`. |
| `07-pipeline-set/` | multi-file | A connector configuration plus the key and value schemas the pipeline carries. |
| `negative/` | — | Missing brace, a struct with no fields, truncation, an Avro `.avsc` (the closest neighbour), UTF-16, and fields with a missing/unknown `type`. |

**Contract the adapter must meet.** Logical types map to canonical formats and constraints — never to
opaque strings — so that a Connect schema and its Avro equivalent produce comparable canonical
models, and Avro ↔ Connect transcoding can be asserted in the round-trip matrix.
