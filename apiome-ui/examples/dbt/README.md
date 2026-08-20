# dbt models and manifests — `dbt`

Fixtures for **FMT-5.4** ([#5442](https://github.com/apiome/apiome/issues/5442)) — the
analytics-engineering on-ramp. For most analytics teams the *only* formal description of their data is
a dbt project: `schema.yml` model and column definitions, tests, and the compiled `manifest.json`.
Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `version: 2` + a `models:`/`sources:`/`semantic_models:` list for properties
files; `metadata.dbt_schema_version` + `nodes`/`sources`/`parent_map` for a compiled manifest.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-schema.yml` | minimal | One model, two documented columns, no tests. |
| `02-typical-schema.yml` | typical | `unique`, `not_null`, `accepted_values`, `relationships`, `meta`, `tags`. |
| `03-project-set/` | multi-file | A project: `dbt_project.yml`, `schema.yml`, and two models whose `ref()`/`source()` calls are the lineage edges. |
| `04-stress-contracts-sources-and-exposures.yml` | stress | Sources with freshness, enforced `contract` + `constraints` (primary/foreign/check/not_null), `data_type` on every column, model `versions`, seeds, snapshots, exposures, a package test (`dbt_utils.*`), per-test `severity`. |
| `05-real-world-manifest.json` | real-world | A compiled `manifest.json`: nodes with configs and columns, sources with freshness, test nodes with `test_metadata.kwargs`, an exposure, and `parent_map`/`child_map`. |
| `06-semantic-manifest.yml` | typical | Semantic models — entities, dimensions, measures — plus simple, ratio and derived metrics. |
| `07-composition-model-inheritance.yml` | composition | YAML anchors for shared column groups and tests, reused by three models. |
| `negative/` | — | Bad indentation, a properties file with nothing in it, truncation, an ODCS contract, UTF-16, and a `relationships` test pointing at a model that does not exist (the broken-`ref` case). |

**Where the tests go.** FMT-5.4 maps dbt tests onto constraints where an analogue exists
(`not_null` → required, `accepted_values` → enum, `unique` → uniqueness) and otherwise onto the
**shared quality namespace defined by FMT-5.1** (ODCS `quality`), so a dbt project and an ODCS
contract describing the same table land in the same canonical shape.
