# Avro IDL (`.avdl`) — `avro-idl`

Fixtures for **FMT-3.5** ([#5430](https://github.com/apiome/apiome/issues/5430)) — the half of Avro
humans actually author. The shipped `avro/` corpus is `.avsc`, the *generated* JSON schema; `.avdl`
carries the protocol grouping, RPC messages, doc comments and annotations that `.avsc` loses. Entries
carry `adapter_key: null` and the `pending-adapter` tag until the Avro adapter accepts `.avdl`.

**Detection marker.** `protocol <Name> {` or a top-level `namespace …;` followed by `record`/`enum`/
`fixed` declarations, in a `.avdl` file.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-record.avdl` | minimal | Schema-only IDL: one record, no protocol → stays `data_schema`. |
| `02-typical-orders-protocol.avdl` | typical | A protocol with three messages → `rpc` operations, one `oneway`, one `throws`. |
| `03-composition-named-type-reuse.avdl` | composition | Named types referenced from several records, a self-referential record, a record inside a map and an array. |
| `04-stress-grammar-corners.avdl` | stress | `fixed`, `decimal(p,s)`, every `@logicalType`, `@order`, `@aliases`, enum default, a backtick-escaped field name, nested map/array/union. |
| `05-real-world-payments-protocol.avdl` | real-world | Payment authorization protocol: money as decimal, error types, request/response and one-way messages. |
| `06-imports-set/` | multi-file | `import idl` **and** `import schema` resolved across a set (`.avdl` + `.avsc` members). |
| `negative/` | — | Missing semicolon, a union with two `string` branches, truncation, a `.proto`, UTF-16, and an `import idl` of a file that is not in the set. |

**Contract the adapter must meet.** An IDL protocol with messages produces RPC operations; a
schema-only IDL does not. `.avsc` behaviour is unchanged, and a `.avdl` emitted from the same model
round-trips.
