# Arazzo Workflow Importer (REPO-3.4)

> **Status:** persistence layer — `src/app/arazzo_workflow_persistence.py`
> **Issue:** [#2773](https://github.com/apiome/apiome/issues/2773) ·
> **Epic:** REPO-EPIC-3 (#2747) · **Migration:** `apiome-db/scripts/V225__arazzo_workflow_entities_repo_3_4.sql`

Arazzo describes **orchestrated multi-step API workflows** — a sibling specification to OpenAPI,
where each step points at an operation defined in some OpenAPI document. MFI-30.2 already taught
Apiome to *read* Arazzo (detect → parse → normalize → lint → emit → diff, see
[`arazzo_import_source.py`](../src/app/arazzo_import_source.py)). REPO-3.4 adds the missing
*write*: an imported orchestration becomes queryable entities instead of an opaque catalog blob.

```
 Arazzo document                 Canonical model                 V225 entities
 ───────────────                 ───────────────                 ─────────────
 workflows[]         ──────►     Service                ──────►  api_workflows
   └─ steps[]        ──────►       └─ Operation         ──────►    └─ api_workflow_steps
        operationRef                    extras.operationRef            resolved_path_operation_id
```

Nothing re-parses the source document: the rows are mapped off the canonical model the existing
normalizer produces, so a change to the parser flows through for free.

## What gets written

One `api_workflows` row per `workflows[]` entry, carrying `workflowId`, `summary`, `description`,
and the workflow-level `inputs` / `outputs` verbatim. One `api_workflow_steps` row per `steps[]`
entry, in **source order**.

Source order matters and is not free: the canonical model sorts services and operations by key
(`normalize_ordering`), so the normalizer records the document position separately
(`extras.workflowIndex` / `extras.stepIndex`) and the row builder sorts on those. Without this a
workflow's steps would render alphabetically, which for an orchestration is simply wrong.

Step payloads — `parameters`, `successCriteria`, `onFailure`, `outputs`, `dependsOn` — are stored
**exactly as written**. Arazzo's runtime-expression grammar (`$response.body#/id`,
`$steps.find-pet.outputs.my_pet_id`) is never parsed and rebuilt; a lossless copy is what keeps
round-trip honest and lets the emitter reproduce the source document.

## operationRef resolution

The point of the entities is the link: when a step names an operation that was imported in the
same scan, the row records that operation's internal `path_operation.id`.

**"The same scan" is concrete.** With repository provenance on the import
(`options.git_source`), the scope is every project `repository_import_spec` links to the same
repository *and* branch — i.e. the OpenAPI specs discovered alongside the Arazzo document.
Without it, the scope is the importing project, which covers a plain upload whose OpenAPI spec
was imported into that same project. See
`Database.get_scan_path_operation_index`.

**Every spelling in the wild is handled** (`parse_operation_ref`):

| Written as | Resolves by |
|---|---|
| `operationId: findPetsByTags` | operationId |
| `operationId: $sourceDescriptions.petStore.loginUser` | operationId, prefix stripped; the source name becomes a disambiguation hint |
| `operationRef: "./petstore.yaml#/paths/~1pets~1{petId}/get"` | route + verb |
| `operationRef: "openapi:cart#/createCart"` | operationId fragment |
| `operationPath: "{$sourceDescriptions.x.url}#/paths/~1pet~1findByStatus"` | route only — resolves **only** when that route carries exactly one operation, otherwise `ambiguous-operation` |

When two candidates match equally, the reference's document part (a `sourceDescriptions` name or
a filename) is compared against each candidate's repository path to break the tie. A hint that
matches nothing is ignored rather than treated as a miss, because repository paths and
`sourceDescriptions` names routinely differ in spelling while the operationId match is already
strong evidence.

## A miss is not a failure

An unresolved reference is normal — the target spec may simply live outside this scan. The row
keeps the raw `operationRef` / `operationId` string, leaves `resolved_path_operation_id` NULL,
and records a stable machine reason:

| `resolution_status` | `resolution_reason` | Meaning |
|---|---|---|
| `resolved` | *(null)* | Matched exactly one imported operation. |
| `unresolved` | `unknown-operation` | Parsed fine, nothing in scope matched. |
| `unresolved` | `ambiguous-operation` | More than one candidate; refusing to guess. |
| `unresolved` | `no-operation-target` | The step names neither an operationId nor a ref. |
| `unresolved` | `unparsable-ref` | A reference we could not reduce to a lookup. |
| `not_applicable` | `calls-workflow` | The step calls a sibling workflow — there was never an operation to match. |
| `parse_error` | `malformed-step` | The step could not be read; it is isolated and its siblings still import. |

Each miss also produces a human-readable warning naming the workflow, the step, and the
reference. A V225 CHECK constraint keeps `resolution_status = 'resolved'` and a non-NULL FK in
lockstep, so a reader may trust either one. The FK is `ON DELETE SET NULL`, never CASCADE:
losing the target operation must **degrade** a step to unresolved, not delete the workflow's step.

## Where it runs

`persist_adapter_import` (`import_source_pipeline.py`) writes the canonical artifact and then the
workflows for any `arazzo`-format import. The whole branch is wrapped: workflow persistence is an
*enrichment* over a catalog item whose source bytes are already stored safely, so a failure there
is logged and swallowed rather than failing the import.

Re-importing a version soft-deletes the previous workflows and steps before inserting, mirroring
`canonical_persistence._soft_delete_live_artifact`, so a re-import replaces rather than
accumulates.

## Studio surface

`getArazzoWorkflowsForVersion` (`apiome-ui/lib/db/helper-arazzo-workflows.ts`) reads the live
workflows for a version; the Studio sidebar renders them as a **Workflows** node behind
`NEXT_PUBLIC_REPO_WORKFLOWS=1` (`private-suite/designer`). Each step is badged *Linked* /
*Unlinked* / *Workflow* / *Error* from its `resolution_status`, and an unlinked step still shows
the raw reference it kept.

## Fixtures & tests

`tests/fixtures/arazzo/` holds the **official** OAI example bundles verbatim — `pet-coupons`
(sub-workflow steps, `$ref`-ed inputs), `login-and-retrieve-pets` (the `$sourceDescriptions.`
prefix and the `operationPath` route pointer), and `oauth` (operationIds reused across
workflows). See that directory's README before refreshing them.

* `tests/test_arazzo_workflow_importer_ac.py` — the ticket's acceptance criteria: row mapping and
  source ordering, every reference spelling, resolution/ambiguity/miss behaviour, and a
  persist → load round trip on each bundle. The fake cursor parses each statement's column list
  and zips it with the bound parameters, so a column/value mismatch fails there.
* `tests/test_arazzo_workflow_migration.py` — SQL guardrails pinning the columns, scoping, the
  two constraints, and the live-rows-only unique indexes.
* `tests/test_persist_adapter_import.py` — the pipeline wiring: scan scope from git provenance,
  resolution end to end, and that a workflow-persistence fault leaves the catalog import intact.
