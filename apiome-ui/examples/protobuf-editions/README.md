# Protobuf editions — `protobuf-editions`

Fixtures for **FMT-3.7** ([#5432](https://github.com/apiome/apiome/issues/5432)). `grpc_import_source`
already *detects* `edition = ` files, but detection is not modelling: editions replace proto2/proto3
syntax with per-feature settings whose resolution changes field semantics — notably
`field_presence`, which drives nullability in the canonical model. Normalizing an editions file as
proto3 silently mis-models optionality, so these fixtures live outside `protobuf/` (whose entries run
against the shipped adapter) and carry `adapter_key: null` with the `pending-adapter` tag.

**Detection marker.** `edition = "2023"` / `"2024"` in place of `syntax = "proto3"`.

**The feature vocabulary these fixtures cover**

| Feature | Values exercised |
| --- | --- |
| `field_presence` | `EXPLICIT`, `IMPLICIT`, `LEGACY_REQUIRED` |
| `enum_type` | `OPEN`, `CLOSED` |
| `repeated_field_encoding` | `PACKED`, `EXPANDED` |
| `utf8_validation` | `VERIFY`, `NONE` |
| `message_encoding` | `LENGTH_PREFIXED`, `DELIMITED` |
| `json_format` | `LEGACY_BEST_EFFORT` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-edition-2023.proto` | minimal | A bare editions file with no feature options at all — everything from the edition defaults. |
| `02-typical-orders-edition-2023.proto` | typical | File-level `EXPLICIT` presence with one `IMPLICIT` field: the pair a nullability test compares. |
| `03-imports-set/` | multi-file | Two files with **opposite** presence defaults; feature sets must not leak across the import. |
| `04-stress-feature-overrides.proto` | stress | File → message → field override resolution for all six features, plus `DELIMITED` (proto2 groups), `LEGACY_REQUIRED`, oneof, map, extension. |
| `05-real-world-telemetry-edition-2023.proto` | real-world | A proto2 service migrated to editions: `LEGACY_REQUIRED` on the fields the wire format still requires, `utf8_validation = NONE` on binary ids, streaming RPC. |
| `06-typical-edition-2024.proto` | typical | Edition **2024**, so defaults are resolved per edition rather than from the 2023 table. |
| `07-composition-nested-and-extended.proto` | composition | Nested message and enum definitions, a message reused by three others, an extension range filled in the same file. |
| `negative/` | — | Missing semicolon, an unknown feature value, truncation, a FlatBuffers schema, UTF-16, and `edition = "2099"` (version-out-of-range). |

**Contract the adapter must meet.** An explicit-presence field must normalize to a *different*
nullability than its implicit-presence twin, asserted by test; edition, syntax and resolved feature
set are recorded in provenance; proto2/proto3 goldens are unchanged.
