# Kafka Connect schema — `kafka-connect`

Fixtures for **FMT-5.3** ([#5441](https://github.com/apiome/apiome/issues/5441)). Connect's schema
form — `{type, optional, name, version, doc, fields, parameters}` — is what a Connect pipeline
actually carries between systems, and it is neither Avro nor JSON Schema. Apicurio types it natively;
Apiome had the two things on either side of it and not the thing in the middle. **Live** — the
`kafka-connect` adapter reads a schema, a converter envelope or a pipeline file set, the
`kafka-connect` emitter writes the same form back, and every entry here is exercised by the corpus
suites.

**Detection marker.** `"type": "struct"` with a `fields[]` array whose members use the key `field`
(not `name`), each with its own `type` and `optional`. The envelope form nests that under `schema`
beside a `payload`, and a connector configuration is `{name, config}` with a `connector.class` or a
converter key. Requiring the `field` spelling is what separates Connect from Avro — the neighbour it
is most easily confused with, and the one the FMT-5.3 transcode depends on telling apart. An Avro
`.avsc` routed here is refused *without* a taxonomy code, so the pipeline reports it as a
wrong-format upload on the strength of the Avro adapter claiming it.

**Logical types these fixtures carry**

| `name` | Base type | Parameters | Canonical projection |
| --- | --- | --- | --- |
| `org.apache.kafka.connect.data.Decimal` | `bytes` | `scale`, `connect.decimal.precision` | `bytes` + `format: decimal`, digits in extras |
| `org.apache.kafka.connect.data.Date` | `int32` | — | `string` + `format: date` |
| `org.apache.kafka.connect.data.Time` | `int32` | — | `string` + `format: time` |
| `org.apache.kafka.connect.data.Timestamp` | `int64` | — | `string` + `format: date-time` |
| `io.debezium.time.MicroTimestamp` / `ZonedTimestamp` | `int64` / `string` | — | `string` + `format: date-time` |
| `io.debezium.data.Enum` | `string` | `allowed` | `string` + an `enum` constraint |

A `name` on a non-struct schema is *always* a logical type. One this reader does not decode keeps its
base type's canonical scalar and is carried verbatim in `extras['connect_logical_type']`, counted as
the `kafka-connect.unknown_logical_type` capability limit — recognized as a logical type, not
silently reduced to its wire representation.

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

## What is modelled

Each `struct` becomes one canonical `RECORD` keyed by its schema `name`; each member becomes one
field keyed by its `field` name, with `optional` as nullability and `default` as the field's default.
An `array` becomes a list reference and a `map` becomes a canonical `MAP` carrying both its key and
value types. Declaration order survives in `field_number`, because a key-sorted canonical model would
otherwise lose the order a struct describes. Two members that name the same struct share **one**
canonical type — which is what makes `05`'s `before`/`after` pair one record rather than two.

Primitives take the canonical scalar of their exact declared width, so `int8` stays `int8` and
`float32`/`float64` land on `float`/`double` — the names the Avro reader produces for the same two
IEEE widths. That is the whole premise of the transcode: a Connect schema and its Avro equivalent
describe the same canonical fields.

## What is carried but not modelled — the `connect_*` extras namespace

| Key | Node | Carries |
| --- | --- | --- |
| `kafka_connect` | root | The reader's own record: `roots`, `envelope`, `source_files`, `capability_limits`. |
| `kafka_connect_connector` | root | A connector configuration's `name` and `config`. |
| `kafka_connect_payload` | root | The sample record(s) beside an enveloped schema. |
| `connect_kind` | type | `struct` or `map`. |
| `connect_optional` | type | A root schema's own `optional` flag, which has no field to carry it. |
| `connect_anonymous` | type | That the source named nothing and the key was derived from position. |
| `connect_version` | type / field | A schema's integer registry revision. |
| `connect_parameters` | type / field | The `parameters` a recognized logical type did not consume. |
| `connect_type` | field | The exact Connect `type` keyword. |
| `connect_logical_type` | field | The logical-type `name`. |
| `precision` / `scale` | field | A `Decimal`'s digits — the spelling the Avro writer already reads. |

The emitter writes every one of those keys back, which is what makes `kafka-connect -> kafka-connect`
a round-trip rather than a re-derivation — the `extras` ↔ emitter symmetry rule.

**Contract the adapter meets.** Logical types map to canonical formats and constraints — never to
opaque strings — so that a Connect schema and its Avro equivalent produce comparable canonical
models, and Avro ↔ Connect transcoding is asserted in the round-trip matrix.
