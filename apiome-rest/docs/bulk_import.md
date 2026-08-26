# Bulk import of independent specs (MFI-29.5)

> **Status:** implemented — `src/app/bulk_intake.py` (grouping engine),
> `src/app/bulk_import_reconciliation.py` (BLK-1.2 reconciliation),
> `src/app/bulk_import_routes.py` (`POST /v1/tenants/{tenant}/import/bulk[/plan|/status]`)
> **Issue:** [#4392](https://github.com/apiome/apiome/issues/4392) ·
> **Epic:** MFI-EPIC-29 (#4384) · **Roadmap:** `ROADMAP_MULTI_FORMAT_IMPORT.md`
> **Extended by:** BLK-1.1 ([#5523](https://github.com/apiome/apiome/issues/5523)) ·
> BLK-1.2 ([#5524](https://github.com/apiome/apiome/issues/5524)) ·
> BLK-1.3 ([#5525](https://github.com/apiome/apiome/issues/5525))

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
| `plan_fingerprint` | BLK-1.3: opaque token describing these resolutions. Echo it on the submit and a plan that drifted is refused. Do not parse it |
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
How the apply expresses that append is BLK-1.3's problem, below.

## Applying the plan (BLK-1.3)

The submit endpoint used to answer "where does this go?" with a constant: every item was
submitted as `project: {name, slug}` at `1.0.0`, so a batch could only mint new projects at
their first version. It now applies the plan it re-derives, and only what a reviewer agreed to.

### `POST /v1/tenants/{tenant}/import/bulk`

Body: the same source plus `{keys?: [...], overrides?: [...], plan_fingerprint?, dry_run?}`.
The payload is re-planned server-side — identical bytes always yield an identical plan — and
**reconciled again**, so each item's destination is the one its plan row named.

| Item resolves to | Submitted as | Version |
|---|---|---|
| `create-project` | `project: {name, slug}` | The batch default (`1.0.0`) |
| `append-version` onto a Project | `project: {project_id}` (BLK-1.1) | Derived from that project's own labels |
| `append-version` onto a **catalog item** | `project: {name, slug}` carrying the matched item's slug | Derived from that item's own labels |
| `unresolved` (`always-ask`) | Nothing — the row fails with `TARGET_DECISION_REQUIRED` until an override decides it | — |

A catalog item is appended to **by slug rather than by id** because BLK-1.1's `project_id`
refuses a non-publishable target outright, and `_resolve_import_project` already adds another
revision to a live catalog item with the same slug. The revision lands on the same project
either way; only the field that names it differs. The row still reports
`target_project_id`, so a client sees where it went.

#### Overrides

`overrides[]` is keyed by the plan's stable item `key` and is **sparse** — an item with no
entry applies its resolution, so agreeing with the plan costs nothing to express.

| Field | Effect |
|---|---|
| `mode: "existing"` | Append to `project_id` when given, else to the item's matched project |
| `mode: "new"` | Create a project, whatever the plan matched |
| `project_id` | Implies `existing`. Named explicitly, it is submitted as an id — so a catalog item named here is refused with `TARGET_NOT_PUBLISHABLE`, exactly as BLK-1.1 refuses it for a single import |
| `version_id` | The label to create, replacing the derived one. On its own it keeps the plan's resolution |

An override that both creates and names a project, two overrides for one item, or an override
whose key the batch is not importing are all reported rather than silently applied — the first
two as a 422, the third as that key's own failed row.

#### `dry_run` is the verify pass

Every item is resolved and validated through **the same function** the apply uses
(`decide_item_target`), and nothing is persisted. The rows a dry run returns therefore *are*
the import it would perform: same `resolution`, same `target_project_id`, same `version_id`.

#### Stale plans

Send the plan's `plan_fingerprint` and the submit refuses — **before any item starts, so
nothing is written** — when re-planning would now do something else:

```
HTTP 409  {"detail": {"code": "TARGET_PLAN_STALE", …, "drift": [
  {"key": "openapi/orders.yaml", "change": "resolution",
   "reviewed": "create-project at 1.0.0",
   "current": "append-version onto project 9f2c… at 1.1.0",
   "detail": "…Re-plan the batch, or send an override that says what you want."}
]}}
```

`change` is `resolution`, `target`, `version`, `item-missing` or `item-added`. A submit naming
explicit `keys` compares only those — an item it will not touch cannot make its apply wrong —
while a submit with no `keys` treats an item appearing or vanishing as drift too. Omit the
fingerprint to apply whatever re-planning produces.

#### Per-item outcomes

Each item is gated and scheduled **independently**:

| Outcome | Row |
|---------|-----|
| Job started | `state: accepted`, `job_id`, `status_path`, plus `resolution` / `target_project_id` / `version_id` / `overridden` |
| Key not in the plan (or an override for one) | `state: failed`, `FORMAT_UNRECOGNIZED` |
| No adapter for the detected format | `state: failed`, `FORMAT_UNRECOGNIZED` |
| Refused by the tenant's import policy (IXH-2.3) | `state: failed`, `QUALITY_POLICY_BLOCKED` |
| Undecided under `always-ask`, or an `existing` override naming nothing | `state: failed`, `TARGET_DECISION_REQUIRED` |
| A target BLK-1.1 will not honour | `state: failed`, `TARGET_PROJECT_NOT_FOUND` / `TARGET_NOT_PUBLISHABLE` / `TARGET_VERSION_EXISTS` |

**A partial failure never aborts the batch.** Every requested item is reported, and the
items that can import still do — including when the failure is one reviewer's bad override.

Single-file items are submitted verbatim (`input_kind: file`) so the catalog stores the
user's own document; multi-file items are packed as the MFI-29.1 archive payload
(`input_kind: fileset` + `archive_root`).

### `POST /v1/tenants/{tenant}/import/bulk/status`

Body: `{items: [{key, job_id}]}` — the pairs the submit call returned. Returns per-item
`state`, `percent`, the authoritative `target`, the created `project_slug`/`project_id`, and
the taxonomy-coded `error`, plus counts and a `done` flag. A job id this tenant does not own
is reported as `not-found` rather than failing the whole call.

A completed row also names its **realized destination** (BLK-1.3): `outcome` is
`version-appended` or `project-created`, alongside the `version_id` the import created, and
the summary counts both as `appended` / `created`. That is read back from the catalog — a
revision that is its project's only version means the batch produced that project — rather
than echoed from what the submit predicted, so the roll-up states what happened. It is a
snapshot, so an unrelated version added in between can read as an append; the alternative,
trusting the client's own prediction, cannot report a prediction that was wrong.

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
  `always-create` or `always-ask`. The result table adds `Action` / `Project` / `Version` —
  what each item was applied *as* — and a `Destinations:` line counting what the batch did.
  `--override KEY=SPEC` (repeatable) moves one item: `new`, `existing`,
  `existing:PROJECT_ID`, any of them suffixed `@VERSION`, or `@VERSION` alone. Because the
  command plans and applies in one run it echoes the plan's fingerprint, so a tenant that
  moved underneath the batch produces a named-drift refusal rather than a silent
  substitution. Exits non-zero when any item failed.
* **UI** — the Catalog import wizard's detect step offers bulk mode when a payload holds
  more than one independent spec, and renders the per-item result list as the jobs finish. The
  repository detail screen's Files tab opens the **batch wizard** from *Import selected* as
  soon as a reader ticks more than one row (BLK-1.4): a **Review** table of the plan with a
  per-row target override feeding `overrides`, a **Verify** step that is the `dry_run` with
  nothing written, and an **Apply** step reporting each item's realized destination — all on
  the same submit-and-poll surface, echoing `plan_fingerprint` so a drifted plan is refused
  with the rows named. One ticked row still opens the single-file Map & import wizard.
