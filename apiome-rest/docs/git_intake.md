# Git-repository intake (MFI-29.3)

> **Status:** implemented — `src/app/git_intake.py` (fetch + selection + packing),
> `src/app/git_import_routes.py` (`POST /v1/tenants/{tenant}/import/git/fileset`)
> **Issue:** [#4390](https://github.com/apiome/apiome/issues/4390) ·
> **Epic:** MFI-EPIC-29 (#4384) · **Roadmap:** `ROADMAP_MULTI_FORMAT_IMPORT.md`

Specs live in git. The legacy git source card fetches **one** file and feeds it to the
OpenAPI-family importer, so "import `protos/**` from this repo at this ref" had no path.
This is that path — for every registry adapter, not just OpenAPI.

## Shape

```
repo + ref + path/glob
      │
      ▼  resolve ref → commit sha            (immutable provenance anchor)
      ▼  list tree, select by path/glob      (skips dotfiles/binaries/vendored dirs)
      ▼  read blobs under the archive budget (entries / per-file / total / depth)
      ▼  resolve root  ─ shared with archive intake (`resolve_fileset_root`)
      ▼  pack a deterministic zip
      │
      └──▶ the MFI-29.1 archive payload  ──▶ 29.2 fileset ──▶ adapter ──▶ catalog
```

The packed zip is the point: it is exactly what archive intake already accepts, so the
whole downstream chain — pre-flight, preview manifest, quality gate, `run_adapter_import_job`
→ `ImportSource.parse_fileset`, catalog persistence — runs **unmodified**. Git intake adds a
*source*, not a second pipeline.

## The endpoint

`POST /v1/tenants/{tenant}/import/git/fileset` (permission `imports:create`) takes
`{repo_url, ref?, path?, root?, repository_id?, linked_account_id?, include_document?}` and
returns:

| Field | Meaning |
|-------|---------|
| `document_base64` | The packed selection — pass to `/import/preflight` and `POST …/imports` |
| `archive_root` | Resolved root document (send as `options.archive_root`) |
| `members` / `total_bytes` | What was selected |
| `skipped` | What was matched but not ingested, each with a reason |
| `detection` / `source_kind` | Format detection for the root document |
| `git_source` | Provenance to echo back in `options.git_source` |

Nothing is persisted by this call. `include_document: false` previews a selection (members,
root, detection, commit) without the bytes.

## Selection semantics

* **empty path** — the whole tree;
* **directory** (`protos/`) — everything beneath it;
* **exact file** — just that file;
* **glob** (`protos/**`, `**/*.proto`, `v[0-9]/api.yaml`) — `**` crosses directory
  boundaries, `*` / `?` do not.

The selection's **static prefix is stripped** from member paths: `protos/` yields
`user/user_service.proto`, so a proto's `import "common/types.proto"` still resolves. The
prefix is recorded in `git_source.path`, so a member's repository path is recoverable.

Dotfiles, `.git`/`.github`/`node_modules`/`vendor` trees, known binary extensions, and blobs
over the per-file limit are **skipped and reported** in `skipped` — never silently dropped.
Budgets come from the archive policy (`archive_max_entries` / `_total_bytes` / `_file_bytes` /
`_depth`), so a repository selection can never cost more than an archive upload.

## Provenance

`git_source` is recorded on the created revision's `format_metadata` as `intakeKind: "git"`
plus `gitProvider` / `gitRepoUrl` / `gitRef` / `gitCommit` / `gitPath`, with the browse URL as
`sourceUri`. The **commit** — not the ref — is the anchor: a branch moves, a commit does not,
so this is what a later re-import-on-change comparison (EPIC-31) diffs against.

The client echoes the provenance back rather than the server re-deriving it; a client that
lied would only mislabel its own catalog item, and the alternative (server-held fetch state
between two calls) buys nothing for that.

## Credentials

Tokens are **never** accepted in the request. A private read uses a stored linked-account
credential named by `repository_id` (a registered tenant repository, whose linked account is
reused) or `linked_account_id` (the caller's own linked account). Anything else reads
anonymously.

## Errors

Failures carry intake-taxonomy codes (`app/intake_error_taxonomy.py`), mapped to HTTP:

| Code | HTTP | When |
|------|------|------|
| `SOURCE_NOT_FOUND` | 404 | Repository/ref/path missing or invisible |
| `SOURCE_AUTH_REQUIRED` | 403 | Private repository, no stored credential |
| `SOURCE_UNREACHABLE` | 502 | Provider unreachable or rate-limiting (retriable) |
| `SOURCE_PROVIDER_UNSUPPORTED` | 422 | Not a github.com URL |
| `SOURCE_SELECTION_EMPTY` | 422 | Path/glob matched nothing importable |
| `INPUT_TOO_LARGE` | 413 | Selection over the entry/size budget |

## Providers

GitHub only, via the same REST plumbing the repository store uses (commit → tree → contents;
no subprocess `git`, no working copy). `GitRepositoryClient` is the seam — a second provider
is a second implementation of `resolve_ref` / `list_tree` / `read_file`, and the tests drive
an in-memory one rather than mocking HTTP.

## Clients

* **UI** — the Catalog import wizard's **Git Repository** tile (`CatalogImportDialog`), via
  the `/api/catalog/import/git` proxy.
* **CLI** — `apiome import git REPO_URL --ref REF --path GLOB [--format KEY]`.
