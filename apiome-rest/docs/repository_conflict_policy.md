# Repository refresh conflict policy (RAR-4.5, #3531)

Auto-refresh re-imports a changed repository file using the specification the user chose the
first time (RAR-4.1) and supersedes the catalog version that import produced (RAR-4.2). The
manual-edit divergence guard (RAR-4.4) stops that from silently destroying work: if the
version has been hand-edited in Apiome since the original import, the refresh is **held**
rather than allowed to clobber the edit.

Hold-not-clobber is the right default and it is only one of three answers teams want. This
document describes the configurable policy that selects among them.

## The three policies

| Token | What happens on a divergence |
|-------|------------------------------|
| `overwrite` | The repository wins: the refresh supersedes the hand-edited version. The divergence is still **detected and reported**, so audit and notifications reflect what was clobbered. |
| `hold-for-review` *(default)* | The refresh is skipped, the file is flagged `diverged`, and a human resolves it. Exactly the RAR-4.4 behaviour. |
| `new-branch` | Neither side loses: the current version is left untouched and the refresh lands on a new branch/version for review and merge. |

Divergence *detection* is unchanged by the policy. A file with no post-import snapshot fails
open (nothing proves an edit), an identical checksum applies the refresh, and a missing
current checksum with a snapshot present counts as a difference.

## Resolution order

```
per-file override ──► repository policy ──► hold-for-review
```

`app/repository_conflict_policy.resolve_conflict_policy` applies that precedence. An
unrecognised value at either level is treated as *not set* rather than as an error, so one bad
row degrades to the next-broadest policy instead of failing the refresh — and because the
broadest fallback is hold-not-clobber, every degradation path is the safe one.

## Storage

Migration `apiome-db/scripts/V235__repository_conflict_policy_rar_4_5.sql`:

* `apiome.tenant_repositories.refresh_conflict_policy` — `VARCHAR(32) NOT NULL DEFAULT
  'hold-for-review'`, CHECK-constrained to the three tokens. Every existing repository keeps
  the RAR-4.4 behaviour; opting into `overwrite` is an explicit act.
* `apiome.repository_conflict_policy_override` — one row per file that deviates, keyed
  `UNIQUE (repository_id, branch, path)` (the same file-lineage tuple as RAR-1.1's
  `repository_import_spec`). Rows are **exceptions**: a file with no row inherits its
  repository's policy.

The override lives in its own table rather than as a column on `tenant_repository_files`
deliberately: that table is rewritten by every successful scan and only holds paths the
scanner currently sees, so an operator's policy choice would be at the mercy of a rescan.

## API

All routes are tenant-scoped from the bearer token; the path slug is decorative.

### `GET /v1/tenants/{slug}/repositories/{id}/conflict-policy`

Returns the repository policy, the built-in default, every accepted token, and the per-file
overrides:

```json
{
  "success": true,
  "conflictPolicy": {
    "repositoryId": "770e8400-e29b-41d4-a716-446655440002",
    "policy": "overwrite",
    "defaultPolicy": "hold-for-review",
    "availablePolicies": ["overwrite", "hold-for-review", "new-branch"],
    "overrides": [
      {
        "branch": "main",
        "path": "specs/petstore.yaml",
        "policy": "hold-for-review",
        "createdBy": "660e8400-e29b-41d4-a716-446655440001",
        "createdAt": "2026-08-01T10:00:00Z",
        "updatedAt": null
      }
    ]
  }
}
```

Requires `imports:view`. `404` when the repository is not the token tenant's.

### `PUT /v1/tenants/{slug}/repositories/{id}/conflict-policy`

Body `{"policy": "new-branch"}`. Sets the repository-wide policy; returns the same projection
the read does, so a panel re-renders from stored state. Requires `imports:edit`. `400` when the
token is not recognised (the accepted tokens are listed in the detail), `404` when the
repository is not the token tenant's.

The repository policy is also settable through the existing dashboard patch,
`PATCH /v1/tenants/{slug}/repositories/{id}`, as `refreshConflictPolicy`.

### `PUT /v1/tenants/{slug}/repositories/{id}/conflict-policy/file`

Body `{"branch": "main", "path": "specs/petstore.yaml", "policy": "overwrite"}` writes the
override. `"policy": null` **clears** it, so the file inherits whatever the repository says
next — the reason clearing is a delete rather than a stored copy of today's repository policy.
Clearing is idempotent. Requires `imports:edit`.

## Applying the decision

`app/repository_conflict_policy.decide_conflict(...)` is the one place a refresh asks what to
do. It resolves the policy, runs the RAR-4.4 guard under it, and returns a `ConflictOutcome`:

| Divergence | Policy | `action` |
|------------|--------|----------|
| none | any | `apply` |
| detected | `overwrite` | `apply` (divergence reported, not held) |
| detected | `hold-for-review` | `hold` |
| detected | `new-branch` | `new-branch`, with `branch_name` set |

`refresh_branch_name` names the `new-branch` target deterministically —
`apiome-refresh/<base branch>/<file stem>-<short sha>` — so a refresh that runs twice for one
commit targets one branch rather than accumulating near-duplicates.

Like RAR-4.1/4.2/4.3/4.4, the module is pure and DB-free. Acting on the returned action —
superseding the version, persisting the `diverged` flag and firing the RAR-5.4 notification, or
creating the side branch — is the EPIC-4 dispatcher's job.
