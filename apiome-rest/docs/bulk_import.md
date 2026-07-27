# Bulk import of independent specs (MFI-29.5)

> **Status:** implemented — `src/app/bulk_intake.py` (grouping engine),
> `src/app/bulk_import_routes.py` (`POST /v1/tenants/{tenant}/import/bulk[/plan|/status]`)
> **Issue:** [#4392](https://github.com/apiome/apiome/issues/4392) ·
> **Epic:** MFI-EPIC-29 (#4384) · **Roadmap:** `ROADMAP_MULTI_FORMAT_IMPORT.md`

MFI-29.1 answers *"one spec, many files"* — a proto tree is unpacked and handed to one
adapter as a fileset. This is the other shape: a team's `specs/` folder holds **N unrelated
documents**, and importing them one at a time does not scale to onboarding.

## Shape

```
archive upload  ─┐
                 ├─▶ members {path: text}
repo selection  ─┘        │
                          ▼  scan each member for references to siblings
                          ▼  connected components  = the independent specs
                          ▼  resolve one root per component (shared rules)
                          │
   plan ◀─────────────────┤   items + skipped + summary   (nothing written)
                          │
   submit ────────────────┴─▶ one ordinary import job per item
                                    │
                                    └─▶ gate ─▶ pipeline ─▶ §0.2 routing ─▶ Catalog/Projects
```

Bulk mode is a **front end**, not a second pipeline. Each item runs the unchanged chain —
quality gate, `run_adapter_import_job`, routing, persistence — so a document imported in a
batch of twenty behaves exactly as it would on its own.

## Grouping

A file is joined to another when it **references** it. The scan is syntactic and covers the
reference vocabularies the accepted formats use:

| Construct | Formats | Resolved against |
|-----------|---------|------------------|
| `import "path.proto";` | protobuf | the fileset root, then the referring directory |
| `$ref: "./file.yaml#/…"` | OpenAPI, AsyncAPI, JSON Schema, Arazzo | the referring directory, then the root |
| `schemaLocation=` / `location=` | XSD, WSDL | the referring directory, then the root |

Only *relative* references that land on another member count — URLs, fragment-only refs,
absolute paths, and imports of files outside the payload (`google/protobuf/timestamp.proto`)
are ignored.

Components are taken **undirected**. Two service protos that both import
`common/types.proto` reference the same file without referencing each other; splitting them
would compile the shared file into two half-items, so they are one compilation unit. Two
AsyncAPI documents that reference nothing are two items.

Each component resolves its own root with `archive_intake.resolve_fileset_root` — the same
ranking a single archive upload uses — so an item's root is chosen exactly as it would be
had that item been uploaded alone.

## The endpoints

All three take `imports:create` and write nothing but the jobs the submit call starts.

### `POST /v1/tenants/{tenant}/import/bulk/plan`

Body: `{document_base64 | git: {repo_url, ref?, path?, repository_id?, linked_account_id?},
filename?, include_documents?}` — exactly one source.

| Field | Meaning |
|-------|---------|
| `items[]` | One per independent spec: `key`, `root_path`, `members`, `source_kind`, `format`, `confidence`, `importable`, `predicted_target`, `input_kind`, `suggested_name`, `suggested_slug`, `reason` |
| `items[].document_base64` | The item's ready-to-import bytes — only when `include_documents` |
| `skipped[]` | Files belonging to no item, with `no-recognisable-format` or `over-item-limit` |
| `truncated` / `total_items` / `max_items` | Explicit statement when the payload holds more items than one batch may carry |
| `summary` | `items`, `importable`, `unimportable`, `skipped_files`, `by_target`, `by_format` |

`predicted_target` is derived from the detected format (the §0.2 branch is on the emitted
format). The **authoritative** routing is the one each job records; the plan never parses.

### `POST /v1/tenants/{tenant}/import/bulk`

Body: the same source plus `{keys?: [...], dry_run?}`. The payload is re-planned server-side —
identical bytes always yield an identical plan — and one job is started per selected item
(every planned item when `keys` is omitted).

Each item is gated and scheduled **independently**:

| Outcome | Row |
|---------|-----|
| Job started | `state: accepted`, `job_id`, `status_path` |
| Key not in the plan | `state: failed`, `FORMAT_UNRECOGNIZED` |
| No adapter for the detected format | `state: failed`, `FORMAT_UNRECOGNIZED` |
| Refused by the tenant's import policy (IXH-2.3) | `state: failed`, `QUALITY_POLICY_BLOCKED` |

**A partial failure never aborts the batch.** Every requested item is reported, and the
items that can import still do.

Single-file items are submitted verbatim (`input_kind: file`) so the catalog stores the
user's own document; multi-file items are packed as the MFI-29.1 archive payload
(`input_kind: fileset` + `archive_root`).

### `POST /v1/tenants/{tenant}/import/bulk/status`

Body: `{items: [{key, job_id}]}` — the pairs the submit call returned. Returns per-item
`state`, `percent`, the authoritative `target`, the created `project_slug`/`project_id`, and
the taxonomy-coded `error`, plus counts and a `done` flag. A job id this tenant does not own
is reported as `not-found` rather than failing the whole call.

The batch itself is **stateless**: each job is an ordinary import job in the shared store, so
`GET …/imports/{job_id}` remains the source of truth and this endpoint is only a roll-up.

## Provenance

An item from a repository records its own path — every item shares the repo, ref, and commit,
but `git_source.path` and `browse_url` point at *that item's* root document, so four catalog
items do not all claim the batch's selection as their origin.

## Limits

`APIOME_BULK_IMPORT_MAX_ITEMS` (default **50**) caps how many jobs one payload may start.
Everything else — entry count, per-file and total size, depth, path safety, compression
ratio — is the existing archive policy, unchanged: a bulk payload can never cost more than
the same archive imported as one spec.

## Clients

* **CLI** — `apiome import auto --bulk <archive|directory>` packs a directory
  deterministically, plans, submits, waits, and prints the per-item table plus the summary.
  Exits non-zero when any item failed.
* **UI** — the Catalog import wizard's detect step offers bulk mode when a payload holds
  more than one independent spec, and renders the per-item result list as the jobs finish.
