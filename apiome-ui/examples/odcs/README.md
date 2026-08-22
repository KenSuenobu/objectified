# Open Data Contract Standard (ODCS v3.x) — `odcs`

Fixtures for **FMT-5.1 / 5.2** ([#5439](https://github.com/apiome/apiome/issues/5439),
[#5440](https://github.com/apiome/apiome/issues/5440)) — the Linux Foundation (Bitol) data-contract
YAML. ODCS is the data-side twin of everything Apiome does for APIs: structure, ownership, quality,
SLAs, versioning, diff, lint, score. **Live in both directions** — the `odcs` adapter reads a
contract, or a contract set, and the `odcs` emitter writes one; every entry here is exercised by the
corpus suites, and each is re-emitted and checked against the standard's **own published JSON
Schema**, which this repository ships (`apiome-rest/src/app/data/odcs_3_*_schema.json`).

**Both v3 lines are represented, because they are not the same document.** `01`, `03` and the
JSON-Schema member of `07` are v3.1.0; `02`, `04`, `05`, `06` and `07`'s contract are v3.0.2. The
reader does not branch on the minor version — every construct it consumes is common to the line —
but v3.1 turned `team` from an array of members into an object with a `members` list and closed
`quality` against the v3.0 `rule:` spelling, so a document is *validated* against the schema for the
version it declares, and is written back declaring the same one.

**Detection marker.** `kind: DataContract` with an `apiVersion` — deliberately the ODCS *envelope*
and nothing else. The structural half (`schema:` with named things and their columns) is shared with
dbt, Kafka Connect and half a dozen catalog formats, and claiming on it would route their documents
here. Every declared `apiVersion` is claimed, **including the v2.2 line**, so a v2 contract becomes a
version rejection with migration guidance rather than "no importer recognized this document".

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-contract.yaml` | minimal | One schema object, two properties, no governance blocks. |
| `02-typical-orders-contract.yaml` | typical | `description`, keys and partitions, object-level `quality`, `servers`, `team`, `support`, `slaProperties`, `tags`. |
| `03-composition-nested-schema.yaml` | composition | Nested object properties, arrays of objects, `authoritativeDefinitions`, and two schema objects in one contract. |
| `04-stress-quality-sla-and-custom.yaml` | stress | All four quality rule kinds (`library` rules, `sql`, `text`, `custom`), `logicalTypeOptions`, transform/encryption metadata, three server types, `roles`, `price`, the full `slaProperties` vocabulary, `customProperties`. |
| `05-real-world-transactions-contract.yaml` | real-world | A retail transactions contract as a data platform actually publishes one: compound key, partitioning, PII classification, dual approvers, seven-year retention. |
| `06-typical-contract.json` | typical | The JSON serialization — the same envelope, so both must import identically. |
| `07-contract-set/` | multi-file | A contract that delegates its payload schema to a JSON Schema file and its quality rules to a third file. |
| `negative/` | — | Bad indentation, a schema object with no properties, truncation, a dbt `schema.yml` (the nearest neighbour), UTF-16, and an **ODCS v2.2** document (`quantumName`/`dataset`/`columns`), which rejects with a version code, not a parse error. |

## What is modelled

Each `schema[]` object becomes one canonical `RECORD`; each property becomes one member, with
`required` as nullability. A nested `object` property becomes a synthesized record keyed by its path
(`customers.address`), an `array` becomes a list around its `items` type (`customers.contact_points.items`
for an array of objects), and `logicalTypeOptions` — the portable half of ODCS typing — becomes
canonical constraints: lengths, numeric bounds, `pattern`, `enum`, and `format` when the declared
value is a format token (`uuid`) rather than a free-form date pattern (`yyyy-MM-dd'T'HH:mm:ssX`).
Declaration order survives in `odcs_position`, because a dataset's column order is physical and
canonical ordering sorts by key.

`physicalType` is deliberately **not** interpreted: `varchar(20)` does not become `maxLength: 20`,
because the unit differs by dialect and by encoding. It is carried instead.

## What is carried but not modelled — the `odcs_*` extras namespace

The governance half of a data contract has no canonical home, so it survives **verbatim** in
`extras` under a documented key namespace, on whichever node declared it. The emitter writes the same
keys back; that is the `extras` ↔ emitter symmetry rule, and it is why nothing here is re-spelled —
a contract imported and re-exported comes back canonically identical.

| Key | Node | Carries |
| --- | --- | --- |
| `odcs` | root | The reader's own record: `api_version`, `status`, `contract_id`, `domain`, `tenant`, `data_product`, `schema_objects`, `capability_limits`, `fileset`. |
| `odcs_description` | root | The `description` block (`purpose` also becomes the canonical description). |
| `odcs_servers` · `odcs_team` · `odcs_roles` · `odcs_support` | root | Serving infrastructure and ownership. |
| `odcs_sla_properties` · `odcs_sla_default_element` · `odcs_price` | root | Service levels and pricing. |
| `odcs_quality` | any | `quality[]`, verbatim — never executed, never turned into a constraint. |
| `odcs_tags` · `odcs_custom_properties` · `odcs_authoritative_defs` | any | Labels, the standard's extension point, and external definition URLs. |
| `odcs_position` · `odcs_logical_type` · `odcs_physical_type` · `odcs_physical_name` | type / field | Declaration order and the source's own typing. |
| `odcs_logical_type_options` · `odcs_examples` | field | The full options block and declared examples. |
| `odcs_key` · `odcs_partition` · `odcs_classification` · `odcs_critical_data_element` | field | Identity, physical layout and governance labels. |
| `odcs_transform` · `odcs_encrypted_name` | field | Lineage and the encrypted twin's name. |
| `odcs_extra` | any | Any remaining ODCS key the reader does not name — the standard's forward-compatibility slot. |

Only `odcs` is the reader's own bookkeeping; every other key is a *source* construct, so it is
reported as **partially-mapped** coverage on the catalog detail view rather than silently absorbed.
Sixteen declared limits — `odcs.quality_rule`, `odcs.sla_property`, `odcs.server`,
`odcs.team_role`, `odcs.support_channel`, `odcs.price`, `odcs.custom_property`, `odcs.tag`,
`odcs.authoritative_definition`, `odcs.physical_type`, `odcs.key_uniqueness`,
`odcs.partitioning`, `odcs.classification`, `odcs.transform_metadata`,
`odcs.declaration_order`, `odcs.free_form_object` — are published by
`GET /v1/import/format-capabilities` and counted per document in
`extras['odcs']['capability_limits']`. Every one of them is a *carried* construct, never a dropped
one. `03`, `04` and `05` between them exercise all sixteen.

## Composition is the file set

ODCS has no include directive, so a contract published across files is composed by being imported
*together*. `07-contract-set/` shows both member roles: `quality.yaml` is a quality pack keyed by
`contractId` and schema object, and is merged into that object's rules; `shipment-event.schema.json`
is named by a relative `authoritativeDefinitions` URL and is recorded as **resolved but not
expanded** — a JSON Schema a contract delegates its payload shape to stays a reference. URLs are
never fetched during import, and a relative URL that escapes the set is refused.

## Two rejections the ticket required

`negative/06` is the acceptance case: **v2.2.x is claimed and then rejected by version.** The v2 line
declares the same `apiVersion`/`kind` pair but spells a dataset as `quantumName` with
`dataset[].columns[]`, so parsing it as v3 would produce a contract with no schema objects and a
misleading "describes no structure" error. It fails as `FORMAT_VERSION_UNSUPPORTED` with the
v2 → v3 renames named in the message.

`negative/02` is the other: a schema object with **no `properties`** is refused rather than imported.
An empty canonical type reads as "this dataset has no columns", which is a claim the document never
made. The emitter applies the same rule in reverse: a record whose members were never modelled is
left out of `schema[]` and reported, rather than written as a table with no columns.

## The one deliberately non-standard thing here

`04` and `05` each carry an **`enum` inside `logicalTypeOptions`** — a column whose permitted values
are stated inline. No ODCS version admits it: the standard states allowed values through a quality
rule, not through a type option. It is here on purpose, because real catalog tools write it and the
two halves of the pipeline treat it differently, which is the property worth fixing in place:

* the **reader is lenient** — it accepts the extension and projects it onto the canonical
  `enum` constraint, which is what makes those values visible to diff and lint;
* the **emitter is strict** — it refuses to write a facet the standard does not admit beside the
  column's `logicalType`, drops it, and reports it as a fidelity loss. Every contract this service
  writes validates against the published schema, including these two.

Everything else in this directory is valid ODCS as published.
