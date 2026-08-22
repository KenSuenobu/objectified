# Protobuf editions — `protobuf-editions`

Fixtures for **FMT-3.7** ([#5432](https://github.com/apiome/apiome/issues/5432)). Editions replace
proto2/proto3 syntax with per-feature settings whose resolution changes field semantics — notably
`field_presence`, which drives nullability in the canonical model. `buf build` does *not* resolve
them: it writes each scope's raw `features` override into the descriptor and leaves the merge to
the reader, so before FMT-3.7 an editions document normalized as though it were proto3 and silently
mis-modelled optionality.

These entries run against the shipped **`grpc`** adapter. They live in their own directory rather
than in `protobuf/` because the dialect gets its own detection key (`protobuf-editions`) and its own
matrix row; the canonical model they normalize to still carries `format = "protobuf"`.

**Detection marker.** `edition = "2023"` / `"2024"` in place of `syntax = "proto3"`.

**The feature vocabulary these fixtures cover**

Each feature declares the scopes that may set it (`targets` in `descriptor.proto`), and the compiler
rejects the others — a message-level `option features.field_presence` is a compile error, not a
stronger statement. The fixtures override each feature only where it is legal.

| Feature | Settable at | Values exercised |
| --- | --- | --- |
| `field_presence` | file, field | `EXPLICIT`, `IMPLICIT`, `LEGACY_REQUIRED` |
| `enum_type` | file, enum | `OPEN`, `CLOSED` |
| `repeated_field_encoding` | file, field | `PACKED`, `EXPANDED` |
| `utf8_validation` | file, field (string fields only) | `VERIFY`, `NONE` |
| `message_encoding` | file, field | `LENGTH_PREFIXED`, `DELIMITED` |
| `json_format` | file, message, enum | `ALLOW`, `LEGACY_BEST_EFFORT` |

`enforce_naming_style` and `default_symbol_visibility` (Edition 2024) are resolved and recorded in
provenance but deliberately not modelled — they govern generated-code naming and symbol visibility,
which have no wire or JSON meaning. The capability registry states that split.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-edition-2023.proto` | minimal | A bare editions file with no feature options at all — everything from the edition defaults. |
| `02-typical-orders-edition-2023.proto` | typical | File-level `EXPLICIT` presence with one `IMPLICIT` field: the pair a nullability test compares. |
| `03-imports-set/` | multi-file | Two files with **opposite** presence defaults; feature sets must not leak across the import. |
| `04-stress-feature-overrides.proto` | stress | File → enum/message → field override resolution for all six features, plus `DELIMITED` (proto2 groups), `LEGACY_REQUIRED`, oneof, map, extension range. |
| `05-real-world-telemetry-edition-2023.proto` | real-world | A proto2 service migrated to editions: `LEGACY_REQUIRED` on the fields the wire format still requires, `utf8_validation = NONE` on opaque pass-through text, streaming RPC. |
| `06-typical-edition-2024.proto` | typical | Edition **2024**, so defaults are resolved per edition rather than from the 2023 table. |
| `07-composition-nested-and-extended.proto` | composition | Nested message and enum definitions, a message reused by three others, an extension range filled in the same file. |
| `negative/` | — | Missing semicolon, an unknown feature value, truncation, a FlatBuffers schema, UTF-16, and `edition = "2099"` (version-out-of-range). |

**Contract the adapter meets.** An explicit-presence field normalizes to a *different* nullability
than its implicit-presence twin, asserted by test; edition, syntax and the resolved feature set are
recorded in provenance under `extras["protobuf_editions"]`; proto2/proto3 goldens are unchanged.

**Two notes on the negatives.** Every `.proto` that fails to compile reaches the pipeline as one
class of fault, so `02` (an unknown feature enum value) and `03` (cut off mid-message) are grounded
on `INPUT_MALFORMED` rather than on the finer code their `failure_class` names — the same
re-grounding FMT-3.3/3.4/3.5/3.6 made. `06` is the exception: a rejected `edition` *value* is
classified as `FORMAT_VERSION_UNSUPPORTED`, because "this build cannot read that edition" and "your
file is broken" call for different fixes.

**Toolchain floor.** Edition 2024 needs `buf` **1.72.0** or newer; 1.50.0 rejects
`edition = "2024"` outright.
