# Open Data Contract Standard (ODCS v3.1) — `odcs`

Fixtures for **FMT-5.1 / 5.2** ([#5439](https://github.com/apiome/apiome/issues/5439),
[#5440](https://github.com/apiome/apiome/issues/5440)) — the Linux Foundation (Bitol) data-contract
YAML. ODCS is the data-side twin of everything Apiome does for APIs: structure, ownership, quality,
SLAs, versioning, diff, lint, score. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** `apiVersion: v3.x` + `kind: DataContract` with a top-level `schema:` list.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-contract.yaml` | minimal | One schema object, two properties, no governance blocks. |
| `02-typical-orders-contract.yaml` | typical | `description`, keys and partitions, object-level `quality`, `servers`, `team`, `support`, `slaProperties`, `tags`. |
| `03-composition-nested-schema.yaml` | composition | Nested object properties, arrays of objects, `authoritativeDefinitions`, and two schema objects in one contract. |
| `04-stress-quality-sla-and-custom.yaml` | stress | All four quality rule kinds (`library` rules, `sql`, `text`, `custom`), `logicalTypeOptions`, transform/encryption metadata, three server types, `roles`, `price`, the full `slaProperties` vocabulary, `customProperties`. |
| `05-real-world-transactions-contract.yaml` | real-world | A retail transactions contract as a data platform actually publishes one: compound key, partitioning, PII classification, dual approvers, seven-year retention. |
| `06-typical-contract.json` | typical | The JSON serialization — the same envelope, so both must import identically. |
| `07-contract-set/` | multi-file | A contract that delegates its payload schema to a JSON Schema file and its quality rules to a third file. |
| `negative/` | — | Bad indentation, a schema object with no properties, truncation, a dbt `schema.yml` (the nearest neighbour), UTF-16, and an **ODCS v2.2** document (`quantumName`/`dataset`/`columns`), which must reject with a version code, not a parse error. |

**Extras namespace (FMT-5.1 → 5.2).** `quality`, `team`/`roles`, `slaProperties`, `servers`,
`support`, `price` and `customProperties` have no canonical home; they must survive in `extras` under
a documented key namespace so the FMT-5.2 emitter can write them back — the `extras` ↔ emitter
symmetry rule. Every one of those blocks is exercised by `04` and `05`.
