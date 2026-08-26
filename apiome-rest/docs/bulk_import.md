# Bulk import of independent specs (MFI-29.5)

> **Status:** implemented — `src/app/bulk_intake.py` (grouping engine),
> `src/app/bulk_import_reconciliation.py` (BLK-1.2 reconciliation),
> `src/app/bulk_import_routes.py` (`POST /v1/tenants/{tenant}/import/bulk[/plan|/status]`)
> **Issue:** [#4392](https://github.com/apiome/apiome/issues/4392) ·
> **Epic:** MFI-EPIC-29 (#4384) · **Roadmap:** `ROADMAP_MULTI_FORMAT_IMPORT.md`
> **Extended by:** BLK-1.1 ([#5523](https://github.com/apiome/apiome/issues/5523)) ·
> BLK-1.2 ([#5524](https://github.com/apiome/apiome/issues/5524))

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
                          ▼  reconcile each item against existing projects (BLK-1.2)
                          │
   plan ◀─────────────────┤   items + resolutions + skipped + summary   (nothing written)
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

Body: `{document_base64 | git: {repo_url, ref?, path?, paths?, repository_id?,
linked_account_id?}, filename?, include_documents?}` — exactly one source.

| Field | Meaning |
|-------|---------|
| `items[]` | One per independent spec: `key`, `root_path`, `members`, `source_kind`, `format`, `confidence`, `importable`, `predicted_target`, `input_kind`, `suggested_name`, `suggested_slug`, `reason` |
| `items[].resolution` | BLK-1.2: `append-version` \| `create-project` \| `unresolved` — what applying the plan now would do |
| `items[].matched_project` | The existing project it resolves to (`project_id`, `name`, `slug`), or null when the item is new |
| `items[].match_basis` / `match_detail` / `match_confidence` | Why it matched, in one token and one sentence, plus a 0..1 confidence **distinct from** the detection `confidence` above |
| `items[].proposed_version` | `version_id` plus `derived_from` (`default` \| `version-bump` \| `next-available`) and `previous_version_id` |
| `items[].document_base64` | The item's ready-to-import bytes — only when `include_documents` |
| `skipped[]` | Files belonging to no item, with `no-recognisable-format` or `over-item-limit` |
| `truncated` / `total_items` / `max_items` | Explicit statement when the payload holds more items than one batch may carry |
| `version_policy` / `version_policy_source` | The reconciliation policy in force, and which tier supplied it |
| `summary` | `items`, `importable`, `unimportable`, `skipped_files`, `by_target`, `by_format`, `by_resolution`, `matched` |

`predicted_target` is derived from the detected format (the §0.2 branch is on the emitted
format). The **authoritative** routing is the one each job records; the plan never parses.

## Reconciliation (BLK-1.2)

Without this, every item was described as if the tenant were empty: a `specs/` folder
re-imported after a change looked identical to a first-time import, and there was nothing to
verify and nothing for an apply step to act on. The plan now answers **"which of these is a
new version of something I already have?"** — with reads only, so it still writes nothing.

A candidate project is resolved in precedence order, stopping at the first hit:

| Basis | Signal | Confidence |
|-------|--------|------------|
| `repository-provenance` | A prior import from the **same repository and path**, read back from the MFI-29.3 provenance on `versions.format_metadata` (`gitRepoUrl` / `gitPath`) | 1.0 |
| `slug` | An existing project already uses the item's `suggested_slug` | 0.8 |
| `spec-identity` | An existing project is named for the same API — how a file that **moved** within the repository still matches | 0.6 |

What a match *means* is configuration, resolved most-specific-first:

```
tenant_repositories.bulk_import_version_policy ──► tenants.bulk_import_version_policy ──► 'append-when-matched'
```

| Policy | Effect |
|--------|--------|
| `append-when-matched` (default) | Matched items resolve to `append-version`; unmatched items to `create-project` |
| `always-create` | Every item resolves to `create-project`. The matches it ignores are **still reported**, so ignoring them is visible rather than hidden |
| `always-ask` | Every item resolves to `unresolved` and needs an explicit per-item choice at apply time |

`proposed_version` follows the item's outcome and never writes: an append bumps the minor of
the matched project's highest semantic version, a create takes the batch default (`1.0.0`),
and a matched project whose labels are not semantic versions falls back to the first free
label at or after that default — which is what `allocate_version_id` would pick anyway, so
the plan never promises a label the apply would rename.

A **non-publishable catalog item is still a valid match.** That is genuinely where a
re-imported non-OpenAPI spec lands (`_resolve_import_project` reuses a live catalog item with
the same slug), so filtering those out would reintroduce the bug for every catalog format.
BLK-1.1's `TARGET_NOT_PUBLISHABLE` remains the authority at apply time.

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

## Ticked files (BLK-1.5)

The repository detail screen's Files tab has a different shape of intent from a selection: a
reader ticks N specific rows. `git.paths` is that, and the Files tab's **Import Bulk Items**
button sends exactly them.

**It replaces `path` rather than filtering it.** A selection is answered by reading everything
it matches, and neither way of doing that works for ticked files:

| | Why not |
|---|---|
| Read the ticked files' shared directory | `protos/orders/orders.proto` imports `protos/common/types.proto`, one level up and outside the anchor. The item loses the sibling it compiles. |
| Read the whole tree and filter afterwards | A monorepo is refused outright — `INPUT_TOO_LARGE`, the selection matches more files than `archive_max_entries` — however small the four ticked files are. |

So `fetch_git_files` reads from the other end. The tree listing is one cheap call carrying no
content; the ticked files are downloaded, scanned for the references they make (`$ref`,
protobuf `import`, XSD/WSDL `schemaLocation`), and whatever those name is downloaded too,
until the set closes over itself or `MAX_REFERENCE_HOPS` is reached. The intake budget applies
to that closure, so it is bounded by what was asked for rather than by what the repository
happens to contain.

Members are keyed from the **repository root**, so an item's key, the path the Files tab shows,
and the `format_metadata.gitPath` an earlier import recorded are all the same string — which is
what BLK-1.2 reconciles a re-import against.

A ticked path that is no item's root — a shared type file another *ticked* item already
compiles — appears in `skipped` with reason `not-an-item-root` rather than vanishing. A path the
commit no longer holds is skipped rather than failing the batch, since a file index can be
stale. The batch ceiling applies to the **ticked** items, so a file ticked in a large directory
is never cut by a limit it was nowhere near.

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
  The plan table carries the reconciliation columns (`Resolution`, `Existing`, `Version`) and
  the summary leads with "N new versions, M new projects", naming the policy when it is
  `always-create` or `always-ask`. Exits non-zero when any item failed.
* **UI** — the Catalog import wizard's detect step offers bulk mode when a payload holds
  more than one independent spec, and renders the per-item result list as the jobs finish. The
  repository detail screen's Files tab offers **Import Bulk Items** as soon as a reader ticks
  more than one row: it plans the ticked paths, shows what each one would do (append a version
  to a project that already exists, or create a new one) and runs the batch on the same
  submit-and-poll surface.
