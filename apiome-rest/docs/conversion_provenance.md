# Conversion Provenance Evidence History (CPDO-3.3)

> apiome#4803 — child of CPDO-EPIC-3 (#4792). Builds on the provenance ledger
> (MFI-22.5, V139), the projection manifest (CPDO-1.3, #4800, V214), and the
> conversion evidence drawer (CPDO-3.2, #4802).

## Why

A committed conversion used to keep its fidelity report and, since V214, the
bounded *summary* of the projection manifest it was approved under — on the
reasoning that the full node/edge graph is deterministic in the source bytes
and the defaults, and therefore reproducible. That holds only while the source
and the converter stay put. The moment either changes, a rebuild describes the
*new* conversion, not the one the user reviewed and approved.

CPDO-3.3 makes the approved evidence permanent: the full manifest graph is
persisted in a **content-addressed snapshot store** at commit time, each
ledger row records the **digest of the exact source text** it converted, and
two read surfaces — the catalog item and the converted Project — serve the
stored graph back, clearly distinguished from a fresh preview.

## Modules

| Module | Role |
|---|---|
| `app/conversion_projection.py` | The manifest contract: `ConversionManifest`, the content-addressed hash, `paginate_conversion_evidence`, `summarize_conversion_manifest`. Unchanged by CPDO-3.3. |
| `app/conversion_job.py` | The commit path: `run_conversion` hands the full manifest + source digest to the `ProvenanceStore` port; `DbConversionProvenanceStore` writes the snapshot (best-effort) then the ledger row. |
| `app/conversion_evidence.py` | The shared read side: row normalization, the current-source digest, and the evidence/degrade response both surfaces build through. |
| `app/catalog_routes.py` | `GET …/{item}/conversions` (history list) and `GET …/{item}/conversions/{id}/evidence` (stored snapshot pages). |
| `app/projects_routes.py` | The project-side twins under `GET /v1/projects/{tenant}/{project}/conversions…`. |
| `database.py` | `upsert_conversion_evidence_snapshot`, `get_conversion_evidence_snapshot`, `get_conversions_for_source`, `get_conversions_for_project`, `get_conversion_provenance_by_id`, `purge_conversion_evidence_snapshots`. |
| apiome-db `V139__conversion_provenance_4006.sql` | The append-only ledger and its immutability trigger. |
| apiome-db `V214__conversion_projection_manifest_4800.sql` | `projection_manifest_hash` + the bounded summary on every ledger row. |
| apiome-db `V215__conversion_evidence_snapshot_4803.sql` | The `conversion_evidence_snapshot` table, `conversion_provenance.source_hash`, and the orphan purge. |

## Content addressing and dedupe

A snapshot row is keyed `(tenant_id, manifest_hash)` — the bare 64-hex sha256
the manifest builder computes over the canonical graph JSON. Equal hash means
identical projection: same statuses, same reasons, same evidence references,
same tool versions, same defaults. Re-converting an unchanged source under
unchanged defaults therefore **reuses** the existing snapshot row
(`ON CONFLICT DO NOTHING`; the table is write-once via the shared
`mcp_forbid_row_mutation` guard), while every convert/re-convert still appends
its **own** `conversion_provenance` row naming its own target revision. That
is how "re-conversions create separate snapshots linked to target revisions"
is satisfied without storing the same graph twice.

Two consequences worth knowing:

* The stored manifest's `source.project_id` / `source.version_record_id` are
  **nulled before storage**. Both ids are excluded from the hash, so under
  dedupe they would otherwise record whichever catalog item happened to write
  first. Readers take real coordinates from the provenance row they asked
  about.
* The **source digest lives on the ledger row**, not the snapshot: two
  byte-different sources (a whitespace-only edit) can project to an identical
  graph, and a per-snapshot digest would silently keep only the first
  writer's bytes. `conversion_provenance.source_hash` is the per-conversion
  fact, in the V209 `sha256:<64hex>` shape.

Raw source bytes never enter the snapshot at all — the manifest excludes them
by construction (the CPDO-3.2 redaction guarantee, extended to persistence by
`test_conversion_evidence_routes.py`).

## Historic evidence vs a fresh preview

The history list (`GET …/conversions`) returns each row's `sourceHash`
alongside `currentSourceHash`, the digest of the item's currently captured
source. A client compares the two: equal means the stored evidence still
describes the source in front of the user; different means the evidence is
historic — accurate about what was approved, silent about what the source has
become. The fresh view is, as before, the rebuild behind
`POST …/{item}/projection`; the historic view is the stored snapshot behind
`GET …/conversions/{id}/evidence`, which is **never rebuilt**.

## Degrade vocabulary

A snapshot that cannot be served is data, not an error — always HTTP 200:

| `snapshot.reason` | Meaning |
|---|---|
| `predates_snapshots` | The ledger row was committed before CPDO-1.3/3.3 (`projection_manifest_hash = ''`). Normal in any pre-existing history. |
| `snapshot_missing` | The row names a hash, but the best-effort snapshot write failed at commit time. |
| `unreadable` | A snapshot is stored, but it no longer validates against this reader's manifest contract. |

In all three cases `summary` and `page` are `null` and the recorded fidelity
grade/tool versions on the ledger row remain the authoritative facts.

## Authorization

| Surface | Guard |
|---|---|
| History lists (catalog + project) | Authentication + tenant scoping — the same class of metadata the unguarded catalog list/detail already expose on their `conversion` back-link. |
| Evidence reads (catalog + project) | `imports:view`, checked **after** the item/project lookup so a cross-tenant id 404s rather than confirming its existence — identical to the projection and analysis reads. |
| Cross-object probing | A provenance id that does not belong to the item (catalog side) or did not target the project (project side) 404s. |

The project-side evidence read exists precisely because
`conversion_provenance.source_project_id` is `ON DELETE SET NULL`: the source
catalog item can disappear while the converted Project must keep its approved
evidence readable.

## Retention

Snapshot rows are **write-once** (BEFORE UPDATE trigger; DELETE stays open
only for the tenant FK cascade and the purge). A snapshot referenced by any
`conversion_provenance` row is effectively **permanent**: the ledger is
append-only (V139 rejects user UPDATE/DELETE), projects are only ever
soft-deleted, and the sole path that removes ledger rows — a tenant
hard-delete — cascades the snapshots with them.

`apiome.purge_conversion_evidence_snapshots(p_retention_days DEFAULT 90)`
(thin DAO delegate: `Database.purge_conversion_evidence_snapshots`) deletes
snapshots older than the window that **no ledger row references**. Because
references never disappear in normal operation, only crash orphans — a
snapshot written by a commit whose provenance insert then failed — ever
match; the function normally purges nothing. The approved evidence of a
conversion is never subject to age-based deletion.
