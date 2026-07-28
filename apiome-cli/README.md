# apiome-cli

Command-line client for the [Apiome](https://github.com/KenSuenobu/apiome) REST API. Import OpenAPI, Arazzo, and JSON Schema documents, list tenant resources, and manage configuration from the terminal.

Follows [clig.dev](https://clig.dev/) guidelines: structured help (`help`, `-h` / `--help`), sensible exit codes, human-readable tables on stdout, and diagnostics on stderr.

## Install

**Requirements:** Python ≥ 3.14, [uv](https://docs.astral.sh/uv/) (recommended).

From the monorepo:

```bash
cd packages/apiome-cli
uv sync
uv run apiome --version
```

`uv sync` installs the `apiome` console script into `.venv/bin`. Use `uv run apiome …`, `.venv/bin/apiome …`, or activate the virtual environment before calling `apiome` directly.

From the repository root via Turborepo:

```bash
yarn cli:build
yarn cli:test
```

### Run script

`run.sh` loads `.env` from this package, ensures the local `.venv` exists, and runs the CLI:

```bash
cd packages/apiome-cli
./run.sh --version
./run.sh doctor
./run.sh projects list
```

With **no arguments**, `run.sh` starts an interactive prompt (`apiome>`) when stdin is a TTY, or reads **one command per line** from stdin (batch mode):

```bash
./run.sh
apiome> doctor
apiome> projects list
apiome> exit

printf '%s\n' "doctor" "projects list" | ./run.sh
```

Equivalent via Yarn: `yarn run` from `packages/apiome-cli`.

## Configuration

Settings resolve in this order (highest wins first):

1. CLI flags (`--base-url`, `--tenant`, `--api-key`, `--session-token`, `--env-file`)
2. Environment variables (`APIOME_*`)
3. Dotenv files (default: package `.env` then `.env` in the current working directory; `--env-file` replaces both with a single file)
4. User config file (`$XDG_CONFIG_HOME/apiome/config.toml`, default `~/.config/apiome/config.toml`)
5. Built-in defaults (`base_url` → `http://localhost:8000`)

### Environment variables

| Variable | Description |
|----------|-------------|
| `APIOME_BASE_URL` | REST API base URL (default `http://localhost:8000`) |
| `APIOME_TENANT_ID` | Tenant UUID (optional; some operations need tenant scope) |
| `APIOME_API_KEY` | API key sent as `X-API-Key` (required for Tier 2 API-key-authenticated commands/routes, including list/import and `api-keys`) |
| `APIOME_SESSION_TOKEN` | UI session bearer token from `POST /auth/login` (required for `auth`, `tokens`, and `integrations` commands) |

Copy the package template and edit values:

```bash
cd packages/apiome-cli
cp .env.example .env
# edit APIOME_BASE_URL, APIOME_TENANT_ID, APIOME_API_KEY
```

Or export variables for a single shell session:

```bash
export APIOME_BASE_URL=https://api.example.com
export APIOME_API_KEY=obj_your_key_here
```

Use an alternate dotenv file for one invocation:

```bash
apiome --env-file /path/to/staging.env doctor
```

### User config file

Persist defaults with `apiome config` (writes `~/.config/apiome/config.toml`):

```bash
apiome config set base-url https://api.example.com
apiome config set api-key obj_your_key_here
apiome config show
apiome config unset tenant
```

You can also edit the file directly. Top-level keys or an `[apiome]` table are supported:

```toml
base_url = "https://api.example.com"
tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
api_key = "obj_your_key_here"
```

```toml
[apiome]
base_url = "https://api.example.com"
api_key = "obj_your_key_here"
```

`config show` masks `api-key` and `session-token` values; commands other than `tokens create` do not print full secret values.

### Identity and personal access tokens

Auth commands use a session bearer token (from dashboard login or `POST /auth/login`), not the workspace API key:

```bash
export APIOME_SESSION_TOKEN=obj_sess_your_token_here

apiome config set session-token obj_sess_your_token_here
apiome auth whoami
apiome auth status
apiome auth tenants
apiome tokens list
apiome tokens create my-cli-token --scope read --scope write --ttl-days 30
apiome tokens revoke <pat-uuid>
```

`tokens create` prints the full PAT secret once in human mode; list and revoke never expose it.

### Workspace API keys and integrations

API key lifecycle commands use the workspace API key (`X-API-Key`). Integration status uses a session bearer token like `auth` and `tokens`:

```bash
export APIOME_API_KEY=obj_your_key_here
export APIOME_SESSION_TOKEN=obj_sess_your_token_here

apiome api-keys list
apiome list-api-keys
apiome api-keys list --type mcp --output json
apiome api-keys create --type browser --label "CI reader" --scope read,write --yes
apiome api-keys create --type mcp --label "Agent" --transport streamable_http --tools spec.list --yes
apiome api-keys show <key-uuid>
apiome api-keys rotate <key-uuid>
apiome api-keys revoke <key-uuid>
apiome integrations list
apiome integrations show github
```

`api-keys create` and `api-keys rotate` print the one-time secret once in human mode (`--output json` includes `secret`); list and show only show masked key prefixes. Use `--yes` to skip the create or revoke confirmation prompt in CI. `integrations show` flags re-auth when status is `expired`.

### Repository Store credentials

`repos` commands require a workspace API key (`X-API-Key`) and tenant scope (`APIOME_TENANT_ID` or `--tenant`). Registering via a linked Git account also requires a session bearer token (`APIOME_SESSION_TOKEN` or `--session-token`) to resolve `GET /dashboard/linked-accounts` and `GET /dashboard/linked-accounts/{id}/repositories`.

```bash
export APIOME_BASE_URL=http://localhost:8000
export APIOME_API_KEY=obj_dev_key
export APIOME_TENANT_ID=acme-corp
export APIOME_SESSION_TOKEN=obj_sess_your_token_here
```

## Examples

Replace placeholders such as `<uuid>` with values from your tenant. Tier 2 commands (list, import, get) require an API key via flag, env, `.env`, or `config set`.

### Help

```bash
apiome help
apiome help projects list
apiome --help
```

In interactive mode (`./run.sh`), type `help` or `help <subcommand>` at the `apiome>` prompt.

### Verify connectivity

```bash
# Anonymous health check (no API key)
apiome --base-url http://localhost:8000 health

# Probe reachability before configuring credentials
apiome doctor
```

### Configure once, reuse everywhere

```bash
export APIOME_BASE_URL=http://localhost:8000
export APIOME_API_KEY=obj_dev_key

apiome config set base-url http://localhost:8000
apiome config set api-key obj_dev_key
apiome config show
```

Override saved defaults for one invocation:

```bash
apiome --base-url http://localhost:8000 --api-key obj_dev_key projects list
```

### Import sources (registry dispatch)

List every import format the server has registered, then import any of them by
key — including formats that have no dedicated verb yet — with no new CLI code:

```bash
# List the registered import sources (formats)
apiome import --list
apiome --json import --list        # machine-readable

# Import by registry format key: apiome import <format> <input>
apiome import sample ./catalog.json
apiome import graphql ./schema.graphql        # GraphQL SDL (graph paradigm)
apiome import graphql --url https://example.com/schema.graphql
apiome import asyncapi ./asyncapi.yaml        # AsyncAPI 2.x/3.x event API
apiome import asyncapi --url https://example.com/asyncapi.yaml
apiome import grpc ./echo.proto               # gRPC / Protobuf .proto (rpc paradigm)
apiome import grpc --url https://example.com/echo.proto
apiome import sample - < ./payload.json     # read from stdin

# Shared flags: --dry-run previews without persisting; --import-timeout bounds
# the async job wait (and per-request HTTP timeout while polling).
apiome import sample ./catalog.json --dry-run --import-timeout 240
```

`<format>` is resolved against the import-source registry
(`GET /v1/import/sources`); an unknown key fails with the list of available
formats. Provide the document as an `INPUT` argument (path, `http(s)` URL, or `-`
for stdin) **or** via `--file` / `--url` — exactly one. The dedicated verbs below
(`openapi`, `arazzo`, …) keep their format-specific flags and take precedence
over this generic seam.

For `grpc`, the `INPUT` / `--file` / `--url` paths import a single `.proto`
document (the REST service compiles it with `buf`); a proto that `import`s sibling
files needs those resolved server-side. Importing from a **live gRPC Server
Reflection endpoint** is a server-side crawl (not an HTTP document fetch), surfaced
through the `grpc` source card's *discovery* input rather than this document seam.

### Pre-flight and CI quality gates

Score a payload **before** anything is created. `apiome import preflight` runs the same
detect → parse → normalize → fingerprint → lint pipeline a real import runs (with dry-run
semantics, nothing persisted) and reports the verdict; `apiome export preflight` lints the
source revision and ranks every export target by readiness before a job exists. Both emit
the API's report verbatim under the global `--json` flag, and a readable table without it.

```bash
# Score a candidate document — no catalog item, project, version, or job is created:
apiome import preflight ./payments.json
apiome import preflight --url https://example.com/openapi.yaml --format openapi
apiome --json import preflight ./payments.json > preflight.json

# Turn it into a CI gate (exit 4 when the threshold is missed):
apiome import preflight ./payments.json --min-grade B
apiome import preflight ./payments.json --fail-on error

# Rank every export target for a revision before emitting anything:
apiome export preflight --project payments-api --version 1.0.0
apiome export preflight --project payments-api --to openapi --min-grade B
apiome --json export preflight --project payments-api > targets.json

# The same flags gate the real commands and short-circuit before the job is created:
apiome import openapi ./payments.json --min-grade B
apiome import graphql ./schema.graphql --fail-on error
apiome export openapi --project payments-api --version 1.0.0 -o openapi.json --min-grade B
apiome export protobuf my-grpc-api --out ./proto/ --fail-on warning
```

`--min-grade A..F` fails when the lint grade is worse than the given letter. `--fail-on
error|warning|info` fails when the report has any finding at or above that severity.
Independently of both, the tenant's import/export quality policy carries its own verdict,
and a policy **block** fails whether or not you asked for a threshold.

**Exit codes (pre-flight surface only).** These are deliberately distinct from transport
and auth failures so a pipeline can tell a bad spec apart from a bad network:

| Code | Meaning |
|------|---------|
| `0` | The pre-flight passed every gate. |
| `1` | Transport failure or server error — unrelated to quality. |
| `2` | Bad invocation, or a rejected request (any 4xx, **including authentication**). |
| `3` | The tenant's quality policy **blocks** this payload. |
| `4` | A `--min-grade` / `--fail-on` threshold you supplied was missed. |
| `5` | Nothing gradable: the candidate cannot be imported, or no export target is usable. |

**Waivers.** A tenant waiver (recorded in the Control Panel) downgrades a blocking policy
verdict server-side, so a waived payload passes the policy gate — but never silently: the
waiver id and expiry are printed and every covered floor is listed as a *waived floor*
rather than dropped from the report. A waiver does **not** relax `--min-grade` /
`--fail-on`; a tenant-side waiver cannot lower a bar your pipeline set for itself.

**Without the flags nothing changes.** `import` and `export` only spend the extra
pre-flight round trip when you pass `--min-grade` or `--fail-on`; the server still enforces
its own policy at commit time either way.

### Import auto-detect

Detect the document format from top-level headers (``openapi``, ``swagger``, ``arazzo``, ``$schema``) and run the matching importer:

```bash
apiome import auto ./spec.json
apiome import auto https://example.com/openapi.json
apiome import auto ./schema.json --dry-run

# Filename hint: a *.arazzo.{yaml,yml,json} document routes to the Arazzo
# importer even when its `arazzo:` version line is missing or it would
# otherwise sniff as generic YAML.
apiome import auto ./checkout.arazzo.yaml
```

Content markers always win; the ``*.arazzo.{yaml,yml,json}`` extension hint is a
last resort applied only when no header matches (mirrors the REST repository
scanner). Stdin (``-``) has no filename, so pipe Arazzo documents that omit the
``arazzo:`` line through ``import arazzo`` explicitly.

### Bulk import a folder of specs

A `specs/` folder usually holds several **unrelated** documents. `--bulk` imports all of
them in one command: the server auto-detects each one, groups the files that compile
together (a proto tree with cross-directory imports stays one spec), and starts one
import per spec.

```bash
# A directory of independent specs — packed and sent as one payload
apiome import auto --bulk ./specs

# Or an archive of the same
apiome import auto --bulk ./specs.zip

# Validate everything without persisting
apiome import auto --bulk ./specs --dry-run

# Start the imports and return immediately
apiome import auto --bulk ./specs --no-wait
```

Each spec is reported as its own row — where it landed (Catalog or Projects), what it
created, or why it failed. **A failure never aborts the batch:** the specs that can
import still do, and the exit code reflects the failures (`3` when the tenant's quality
policy blocked one, `2` for a caller-fault failure such as an unparseable document, `1`
for transport errors or items still running when the wait gave up). Files that are part
of no importable spec — READMEs, binaries, dotfiles — are listed, never silently dropped.

### Import OpenAPI

```bash
# Create project + version from info.title / info.version
apiome import openapi ./openapi.yaml

# Resolve the project name from another OpenAPI field
apiome import openapi ./openapi.yaml --project-name-field info.summary

# Or embed the field path in the document itself
# info:
#   x-apiome-project-name-field: info.summary

# Import from a public HTTP(S) URL
apiome import openapi https://example.com/openapi.json

# Plan without persisting
apiome import openapi ./openapi.yaml --dry-run

# Update an existing project
apiome import openapi ./openapi.yaml --project-id <uuid> --version 2.0.0

# Publish immediately after import (default leaves the version as draft)
apiome import openapi ./openapi.yaml --publish public
apiome import openapi ./openapi.yaml --publish private
```

### Import Arazzo

Import an [Arazzo 1.0](https://spec.openapis.org/arazzo/latest.html) workflow document (validated locally before upload):

```bash
apiome import arazzo ./checkout.arazzo.yaml
apiome import arazzo https://example.com/workflows/checkout.json
apiome import arazzo ./checkout.yaml --dry-run
apiome import arazzo ./checkout.yaml --project-id <uuid> --version-id <uuid>
apiome import arazzo ./checkout.yaml --no-wait
apiome import arazzo ./checkout.yaml --publish public
apiome --json import arazzo ./checkout.yaml
```

Use `import openapi` for OpenAPI API descriptions and `import json-schema` for standalone JSON Schema files.

### OpenAPI/Arazzo path workflow (import → inspect → export)

After importing a spec, inspect normalized paths and operations, then export a reconstructed document for CI or review. Replace placeholders with values from your tenant.

```bash
export APIOME_BASE_URL=http://localhost:8000
export APIOME_API_KEY=obj_dev_key
export APIOME_TENANT_ID=acme-corp

# 1. Import (OpenAPI or Arazzo)
apiome import openapi ./payments-openapi.json
apiome import arazzo ./checkout.arazzo.yaml

# 2. Inspect stored paths and operations (project slug + version from import output)
apiome paths list --project payments-api --version 1.0.0
apiome paths show /payments --project payments-api --version 1.0.0
apiome operations show createPayment --project payments-api --version 1.0.0

# Score schema quality (server-computed, deterministic) and gate CI.
# If the score persisted at import time is out of date, the report also prints the
# stored "Stored score: N/100 (grade X)" line alongside the live recompute.
apiome lint --project payments-api --version 1.0.0
apiome lint --project payments-api --version 1.0.0 --base-version 0.9.0
apiome lint --project payments-api --version 1.0.0 --min-grade B

# Independent oasdiff compatibility evidence (normalized JSON / SARIF / JUnit)
apiome compat --project payments-api --version 1.1.0 --base-version 1.0.0
apiome compat --project payments-api --version 1.1.0 --base-version 1.0.0 --format sarif
apiome compat --project payments-api --version 1.1.0 --base-version 1.0.0 --fail-on dangerous

# Executable contract suite (ECA-1.1): deterministic cases compiled from a version
# --out writes the canonical bytes the digest covers, and the digest is re-derived locally
apiome contract suite --project payments-api --version 1.0.0
apiome contract suite --project payments-api --version 1.0.0 --out ./artifacts/contract-suite.json
apiome contract suite --project payments-api --version 1.0.0 --no-negative --operation "GET /payments"

# Contract verification against a registered target (ECA-2.2): run + JUnit/JSON CI artifacts
# Exit 0 only when the stored outcome is passed; evidence id and failure codes print on failure
# Target auth is env/stored on the server — never pasted on the CLI
apiome verify contract --project payments-api --version 1.0.0 --target mock
apiome verify contract --project payments-api --version 1.0.0 --target mock --format junit --out ./artifacts/contract.xml
apiome verify contract --project payments-api --version 1.0.0 --target staging --context commit=$GITHUB_SHA --idempotency-key build-$GITHUB_RUN_ID
apiome --json verify contract --project payments-api --version 1.0.0 --target mock

# Classified diff CI gate (inline candidate vs published contract)
# Exit 0 = pass, 1 = threshold met, 2 = auth/network/parse/oversize
apiome diff ./openapi.yaml --against payments-api@latest --fail-on breaking
apiome diff ./openapi.yaml --against payments-api@1.0.0 --fail-on warn --format json
apiome diff ./openapi.yaml --against payments-api@latest --format md

# Arazzo workflows (after arazzo import)
apiome workflows list --project checkout-flow --version 1.0.0
apiome workflows show checkout --project checkout-flow --version 1.0.0

# 3. Export reconstructed spec or download the original upload bytes
apiome spec export \
  --project payments-api \
  --version 1.0.0 \
  --format openapi \
  --output ./artifacts/openapi.json

apiome spec download-original \
  --import-id <version-uuid> \
  --output ./artifacts/original.yaml
```

Machine-readable inspection (`--json` on stdout):

```bash
apiome --json paths list --project <uuid> --version <uuid>
apiome --json paths show <path-uuid> --project <uuid> --version <uuid>
apiome --json operations show createPayment --project payments-api --version 1.0.0
apiome --json workflows list --project <uuid> --version <uuid>
```

Post-MVP verification commands (`spec fidelity`, `spec verify-attestation`) are documented when they land in the CLI.

### Classified diff CI gate

Compare a local OpenAPI file to a published project version (`POST /v1/diff/{tenant}/classified` inline mode). Useful in PR pipelines:

```bash
apiome diff ./openapi.yaml --against payments-api@latest
apiome diff ./openapi.yaml --against payments-api@1.0.0 --fail-on warn
apiome diff ./openapi.yaml --against payments-api@latest --format json
apiome diff ./openapi.yaml --against payments-api@latest --format md
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--fail-on` | `breaking` | Exit `1` when `maxSeverity` is at least this level. `warn` also fails on `non-breaking`. `docs-only` alone never fails. |
| `--format` | `text` | `text` human summary, `json` ClassifiedDiffResponse, `md` CTG-1.3 markdown changelog (`Accept: text/markdown`). |

**Exit codes (this command only):** `0` = gate passed, `1` = threshold met (breaking/warn findings), `2` = auth/network/parse/oversize. Requires API key + tenant scope. Read-only CI tokens with `diff:read` (CTG-2.3) are supported.

For GitHub pull requests, prefer the copy-paste Action
[`apiome/apiome/diff-action`](../diff-action/) — it runs this command, fails the check on
exit `1`, surfaces exit `2` distinctly, and upserts one sticky PR comment with `--format md`.
See [CI contract gate](../docs/guide/ci-diff-gate.md).

### Inspect paths and operations

List flattened path/operation rows for a project version (filters: `--method`, `--tag`, `--q`):

```bash
apiome paths list --project payments-api --version 1.0.0
apiome paths list --project payments-api --version 1.0.0 --method POST --tag payments
apiome paths show /payments --project payments-api --version 1.0.0
apiome paths show <path-uuid> --project <uuid> --version <uuid>
apiome operations show createPayment --project payments-api --version 1.0.0
apiome --json operations show <operation-uuid> --project <uuid> --version <uuid>
```

### Inspect Arazzo workflows

```bash
apiome workflows list --project checkout-flow --version 1.0.0
apiome workflows show checkout --project checkout-flow --version 1.0.0
apiome workflows show <workflow-uuid> --project <uuid> --version <uuid>
apiome --json workflows list --project <uuid> --version <uuid>
```

### Import JSON Schema

Import a standalone [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-core.html) file as a tenant property or schema:

```bash
apiome import json-schema ./email.json
apiome import json-schema https://example.com/schemas/email.json
apiome import json-schema ./user.json --as schema --version-id <uuid>
apiome import json-schema ./field.json --project-id <uuid> --link-project-property
```

`--link-project-property` requires `--project-id`. Use `import openapi` for full OpenAPI specifications.

**`$ref` resolution (MVP):** Only the schema document in the given file is imported. External or relative `$ref` targets are not resolved or inlined; bundle multi-file schemas before import if you need a self-contained definition.

### Convert a catalog item to OpenAPI

A *catalog item* is a non-OpenAPI import (gRPC, GraphQL, AsyncAPI, …) held in the catalog rather than
as a publishable Project. `convert` turns one into a publishable OpenAPI project, or previews how
faithful that conversion would be:

```bash
# Preview only — print the server-computed fidelity report + warning, create nothing:
apiome convert <artifact-id> --to openapi --dry-run

# Preview and save the would-be OpenAPI document (dry-run only; '-' writes to stdout):
apiome convert <artifact-id> --dry-run --out converted.openapi.json

# Commit — create the OpenAPI project/version from the conversion:
apiome convert <artifact-id> --to openapi

# Fill cheap gaps the source did not carry (applied only where the source is empty):
apiome convert <artifact-id> --title "Widgets API" --api-version 1.0.0 --server https://api.example.com

# Write the machine-readable projection manifest ('-' writes to stdout):
apiome convert <artifact-id> --dry-run --projection-out projection.json

# Machine-readable report/result:
apiome --json convert <artifact-id> --dry-run
```

`<artifact-id>` is the catalog item id (its project id). `--to openapi` is the only target today (the
verb is target-generic for future emitters). The command prints the fidelity **grade + score + tier**,
the mandatory warning, and the gaps OpenAPI favors but the conversion lacks.

**Projection manifest.** Where the fidelity report says *how much* a conversion loses, the projection
manifest says **which source construct became which OpenAPI JSON Pointer, and why anything did not**.
Every response carries its bounded summary — the snapshot hash, the converter tool versions, and the
per-status tallies — and `--projection-out` writes the whole graph:

```jsonc
{
  "summary": { "manifest_hash": "…", "status_counts": { "retained": 12, "dropped": 1, … } },
  "nodes":   [ { "id": "source:construct:GET /widgets", "kind": "source", … },
               { "id": "target:/paths/~1widgets/get",   "kind": "target", … } ],
  "edges":   [ { "id": "construct:operation:GET /widgets", "scope": "construct",
                 "status": "retained" },
               { "id": "construct:channel:user/signedup", "scope": "construct",
                 "status": "dropped", "reason": "destination_unsupported",
                 "remediation": "OpenAPI has no equivalent construct; …" } ]
}
```

Edge statuses are `retained` / `transformed` / `inferred` / `dropped` / `unavailable` /
`not-applicable`; every one except `retained` carries a `reason` code and a `remediation`. `dropped`
means apiome *established* the construct is absent; `unavailable` means it could not determine where
the construct went, or that the source analysis never saw it — the two are never conflated. The
manifest is deterministic: the same source revision converted with the same `--title` /
`--api-version` / `--server` defaults yields the same `manifest_hash`.

**Exit codes.** A **low** fidelity tier exits non-zero — a CI-friendly hint that the converted spec
will be substantially incomplete. Pass `--force` to accept a low-fidelity result and exit `0`, or
supply `--title` / `--api-version` / `--server` to close gaps and lift the tier. `--out` is valid only
with `--dry-run` (the commit path creates the project instead of writing a file); `--projection-out`
works with both, since the projection read has no side effects. Requires a workspace API key and
tenant scope.

### Export a version to a target format

`export` is the inverse of `import` — it emits a stored version to a registered target format and
reports how faithful that export is. `export targets` lists the emitters available for a version;
`export openapi` and `export asyncapi` write the document and its fidelity report;
`export grpc` writes a proto3 `.proto` document and its fidelity report;
`export graphql` writes GraphQL SDL and its fidelity report;
`export avro` writes Avro `.avsc` schema JSON and its fidelity report.
Any other registered target (or a format key like `openapi-3.1` / `protobuf`) is also exportable
via the async job pipeline: `apiome export <format> <artifact> [--version] [--out file|dir]`.

`export evidence` pages the source→target projection evidence for a configured export
(EFP-2.1): one row per source construct with its status, reason category, and reviewed
explanation, for exactly the snapshot hash a preview of the same source, target, and
options references. Use `--json` for the machine-readable page: a `summary` (snapshot
hash, emitter/registry versions, status + reason counts) plus a bounded `page` of rows
with `next_cursor` for paging. `--option key=value` folds per-target emit options into
the snapshot — different options are a different snapshot. Source-native values are
always redacted server-side (`[redacted]`); statuses, reasons, and target locations
remain. How to interpret the statuses, reason categories, and destination-documentation
links is documented in [`docs/guide/export-fidelity.md`](../docs/guide/export-fidelity.md).

`export preflight` ranks every target for a revision *before* a job exists — source lint
grade, projected fidelity, capability fit, policy verdict, and a composite readiness band —
and doubles as a CI gate; see
[Pre-flight and CI quality gates](#pre-flight-and-ci-quality-gates).

```bash
# List the emitter targets + per-source fidelity for a version:
apiome export targets --project payments-api --version 1.0.0

# Rank targets by readiness before emitting anything (blocked targets are shown, not hidden):
apiome export preflight --project payments-api --version 1.0.0

# Page the projection evidence for one configured export (JSON for automation):
apiome export evidence --project payments-api --version 1.0.0 --target avro
apiome --json export evidence --project payments-api --target avro --limit 25

# Generic async export (submit job → poll → download → write/unzip):
apiome export openapi-3.1 payments-api --version 1.0.0 --out openapi.json
apiome export protobuf my-grpc-api --version 1.0.0 --out ./proto-bundle/
apiome export sample payments-api --out report.json --force

# Export a version as OpenAPI and write the document to a file:
apiome export openapi --project payments-api --version 1.0.0 --output openapi.json

# Export a version as AsyncAPI 3 (event sources are lossless; REST sources reframe onto channels):
apiome export asyncapi --project user-events --version 1.0.0 --output asyncapi.json

# Export a version as proto3 (native gRPC sources are lossless; REST/OpenAPI sources are lossy):
apiome export grpc --project echo-api --version 1.0.0 --output v1.proto

# Export a version as GraphQL SDL (native Graph sources are lossless; REST/OpenAPI sources are lossy):
apiome export graphql --project blog-api --version 1.0.0 --output schema.graphql

# Export a version as Avro .avsc (native data-schema sources are lossless; REST/OpenAPI sources are types-only):
apiome export avro --project users-schema --version 1.0.0 --output User.avsc

# Write the document to stdout (fidelity summary + metadata go to stderr):
apiome export openapi --project payments-api --version 1.0.0 --output -

# YAML serialization, and a machine-readable metadata envelope:
apiome export asyncapi --project user-events --version 1.0.0 --yaml --output asyncapi.yaml
apiome --json export openapi --project payments-api --version 1.0.0 --output openapi.json
```

OpenAPI document bytes come from the OpenAPI reconstruction (the same source as `spec export`);
every other target — AsyncAPI, protobuf/gRPC, GraphQL SDL, and Avro `.avsc` included — is emitted through the Emitter SPI
(`POST /v1/export/{tenant}/document`). The fidelity **tier + preserved-%**, the server advisory (MFX-2.4),
and a concise per-construct loss table always come from the emitter registry's dry-run preview (printed on stderr).

**Exit codes.** A **lossy** or **types-only** export exits non-zero — a CI-friendly gate that the
emitted document does not carry every source construct (e.g. an event-driven source loses its channels).
The document is written regardless; pass `--force` to accept the loss and exit `0`, or confirm at the
interactive prompt when stdin is a TTY. Requires a workspace API key and tenant scope.

**Stale previews.** The dispatch path submits the preview's snapshot hash as the job's
`acknowledged_snapshot` (EFP-3.1). If the source revision, options, emitter version, or capability
registry changed between preview and generate, the job fails with a structured `STALE_PREVIEW` error
(exit `1`) naming both the acknowledged and the current hash — nothing is silently exported that
differs from what was accepted. Re-run the export (which re-previews) or re-fetch
`export evidence` to see what changed, then acknowledge the current snapshot.

### Repository Store

Connect Git repositories, scan branches for spec files, sniff importability, and import into projects or versions. The CLI mirrors the Control Panel Repositories tab (`add` → `scan` → `files` → `inspect` → `import` → `imports`).

End-to-end workflow (replace placeholders with values from your tenant):

```bash
# 1. Register a repository (public URL or linked account)
apiome repos add --url https://github.com/acme/public-specs.git
apiome repos add --url https://github.com/acme/public-specs.git --branch release
apiome repos add --account "Acme GitHub" --repo acme/api-specs

# 2. Scan the default or selected branch (--wait polls until complete)
apiome repos scan <repository-uuid>
apiome repos scan <repository-uuid> --branch release --wait

# 3. List scanned files (filters match the Files tab)
apiome repos files <repository-uuid>
apiome repos files <repository-uuid> --glob "**/openapi*.yaml, **/arazzo/*.yaml"
apiome repos files <repository-uuid> --preset openapi --importable

# 4. Sniff a file before import
apiome repos inspect <repository-uuid> <file-uuid>
apiome repos inspect <repository-uuid> <file-uuid> --format json
apiome repos inspect <repository-uuid> <file-uuid> --closure
apiome repos inspect <repository-uuid> <file-uuid> --closure --format json
apiome repos inspect <repository-uuid> <file-uuid> --deep
apiome repos inspect <repository-uuid> <file-uuid> --deep --format json

# 4b. Verify integrity + signature trust (CI-friendly; exits 1 on failure)
apiome repos verify <repository-uuid>
apiome repos verify <repository-uuid> <file-uuid>
apiome repos verify <repository-uuid> --format json

# 5. Import into a new or existing project/version
apiome repos import <repository-uuid> <file-uuid> --new-project
apiome repos import <repository-uuid> --files "**/openapi*.yaml" --new-project
apiome repos import <repository-uuid> <file-uuid> --project <project-uuid> --version-name 2.0.0
apiome repos import <repository-uuid> <file-uuid> --project <project-uuid> --version-id <version-uuid>
apiome repos import <repository-uuid> <file-uuid> --new-project --dry-run

# 6. Review import provenance
apiome repos imports <repository-uuid>
apiome repos imports <repository-uuid> --project <project-uuid> --format json
apiome repos imports <repository-uuid> --since 2026-06-01T00:00:00Z --until 2026-06-30T23:59:59Z
```

#### `repos list`

List registered repositories for the tenant. Filters: `--provider` (`github`, `gitlab`, `bitbucket`, `public_url`), `--status` (`pending`, `scanning`, `ready`, `error`, `archived`), `--name` (substring). Use `--format json` or global `--json` for machine output.

```bash
apiome repos list
apiome repos list --tenant <uuid-or-slug>
apiome repos list --provider github --status ready
apiome repos list --name api-specs --all --format json
```

#### `repos add`

Register a repository via public HTTPS clone URL or a linked account. Public URLs are pre-flighted with `POST /tenants/{id}/repositories/test-public-url`. Linked-account mode requires `--account` (display name from `integrations list`) and `--repo` (`OWNER/NAME` slug).

```bash
apiome repos add --url https://github.com/acme/public-specs.git
apiome repos add --url https://github.com/acme/public-specs.git --branch release
apiome repos add --account "Acme GitHub" --repo acme/api-specs
apiome repos add --account "Acme GitHub" --repo acme/api-specs --branch develop --format json
```

#### `repos scan`

Enqueue a branch scan (`POST /tenants/{id}/repositories/{repository_id}/scans`). Omit `--branch` to use the repository default. `--wait` polls `GET …/scans/{scan_id}` until the scan finishes and prints file counts.

```bash
apiome repos scan <repository-uuid>
apiome repos scan <repository-uuid> --branch release
apiome repos scan <repository-uuid> --wait
apiome repos scan <repository-uuid> --branch main --wait --poll-interval 2
```

#### `repos files`

List files discovered by the latest scan (`GET …/files`). `--glob` accepts comma-separated patterns; `--regex` is mutually exclusive with `--glob`. `--preset` values: `all_importable`, `openapi`, `arazzo`, `asyncapi`, `json_schema`, `graphql`, `protobuf`, `avro`, `postman`, `sql_ddl`. Use `--importable` or `--not-importable` to filter by sniff verdict; omit both to include unsniffed rows. `--closure` adds a closure indicator column showing resolved and missing `$ref` targets per file.

```bash
apiome repos files <repository-uuid>
apiome repos files <repository-uuid> --glob "**/openapi*.yaml"
apiome repos files <repository-uuid> --regex 'openapi.*\.ya?ml$'
apiome repos files <repository-uuid> --preset openapi --importable
apiome repos files <repository-uuid> --detected-kind openapi-candidate --all
apiome repos files <repository-uuid> --closure
apiome repos files <repository-uuid> --closure --format json
```

#### `repos inspect`

Run content sniff on a cached file (`POST …/files/{file_id}/sniff`). Prints importable verdict, detected kind, version, and reasons. Sniff before import when the Files table shows a pending verdict. Use `--closure` to print the resolved `$ref` closure and flag unresolved targets. Use `--deep` to run the deep pre-import verdict (`POST …/files/{file_id}/verify`) and print validation, lint, fidelity, and secrets findings; exits with code `1` when blocking findings are reported.

```bash
apiome repos inspect <repository-uuid> <file-uuid>
apiome repos inspect <repository-uuid> <file-uuid> --format json
apiome repos inspect <repository-uuid> <file-uuid> --closure
apiome repos inspect <repository-uuid> <file-uuid> --closure --format json
apiome repos inspect <repository-uuid> <file-uuid> --deep
apiome repos inspect <repository-uuid> <file-uuid> --deep --format json
```

#### `repos verify`

Check repository file integrity and commit signature metadata (`GET …/files` or `GET …/files/{file_id}`). Prints per-file integrity and signature status. Exits with code `1` when any file has failed git blob verification or an invalid signature. Omit the file UUID to verify all files (fetches all pages by default).

```bash
apiome repos verify <repository-uuid>
apiome repos verify <repository-uuid> <file-uuid>
apiome repos verify <repository-uuid> --format json
apiome --json repos verify <repository-uuid>
```

#### `repos import`

Import a repository file into the catalog (`POST …/files/{file_id}/import`), many files in one batch run (`POST …/imports:batch`), or per a GitOps manifest (`POST …/imports:manifest`). Single-file mode requires a file UUID argument. Batch mode selects files with `--files` (comma-separated globs) or `--regex`, then applies either global target flags or a `--map` YAML/JSON file with per-path mappings. Manifest mode uses `--manifest` to import from the repository's scanned `.apiome.yaml`, or `--manifest-file PATH` to validate and import from a local manifest file (resolved against scanned repository files). Use exactly one target mode per file: `--new-project` (create project + version from document metadata), or `--project` with optional `--version-id` (existing version) or `--version-name` (new version under the project). `--resume-run-id` retries a prior batch or manifest run without re-selecting files. Reuses the same `ImportResult` output as `import openapi` / `import arazzo` for single imports; batch and manifest modes print an aggregate summary. `--dry-run` plans without persisting.

```bash
apiome repos import <repository-uuid> <file-uuid> --new-project
apiome repos import <repository-uuid> <file-uuid> --new-project --version-name 1.0.0
apiome repos import <repository-uuid> <file-uuid> --project <project-uuid> --version-name 2.0.0
apiome repos import <repository-uuid> <file-uuid> --project <project-uuid> --version-id <version-uuid>
apiome repos import <repository-uuid> <file-uuid> --new-project --dry-run
apiome repos import <repository-uuid> --files "**/openapi*.yaml" --new-project
apiome repos import <repository-uuid> --files "**/*.yaml" --map ./import-map.yaml
apiome repos import <repository-uuid> --regex 'openapi' --project <project-uuid> --version-id <version-uuid>
apiome repos import <repository-uuid> --resume-run-id <batch-run-uuid>
apiome repos import <repository-uuid> --manifest
apiome repos import <repository-uuid> --manifest-file ./.apiome.yaml
apiome repos import <repository-uuid> --manifest --dry-run
apiome --json repos import <repository-uuid> --files "**/*.yaml" --new-project
```

#### `repos imports`

List import provenance for a repository (`GET …/imports`). Filters: `--project`, `--version-id`, `--actor` (user UUID), `--since` / `--until` (ISO-8601). Table columns: file path, project, version, importer, `imported_at`, blob SHA.

```bash
apiome repos imports <repository-uuid>
apiome repos imports <repository-uuid> --project <project-uuid>
apiome repos imports <repository-uuid> --version-id <version-uuid> --format json
apiome repos imports <repository-uuid> --actor <user-uuid> --since 2026-06-01T00:00:00Z
```

### MCP catalog

Register, list, and inspect external MCP servers in your tenant's catalog. These commands
require an API key and a tenant scope (`--tenant` or `APIOME_TENANT_ID`); the server
re-scopes from the token, so you only ever see your own catalog.

Register a server (`POST /v1/mcp/{tenant}/endpoints`). `--name` and `--url` are required;
`--transport` defaults to `streamable_http` (`sse` and `stdio` are also accepted):

```bash
apiome mcp register --name "Weather MCP" --url https://mcp.example.com/sse
apiome mcp register --name "Weather MCP" --url https://mcp.example.com/sse --transport sse
apiome mcp register --name "Weather MCP" --url https://mcp.example.com/sse \
  --description "Weather lookups" --category tools --visibility public
```

Attach an outbound credential while registering — `--bearer` seals a bearer token, `--header`
seals a custom header secret as `Name:Value` (the two are mutually exclusive). The secret is
sealed server-side via `PUT …/credentials` and is never echoed back:

```bash
apiome mcp register --name "Weather MCP" --url https://mcp.example.com/sse --bearer "$MCP_TOKEN"
apiome mcp register --name "Weather MCP" --url https://mcp.example.com/sse --header "X-Api-Token: $MCP_TOKEN"
```

List the catalog (`GET /v1/mcp/{tenant}/endpoints`) and show one endpoint by id
(`GET /v1/mcp/{tenant}/endpoints/{id}`). Both honour the global `--json` flag and a local
`--output json`:

```bash
apiome mcp list
apiome mcp list --output json
apiome mcp show <endpoint-uuid>
apiome --json mcp show <endpoint-uuid>
```

Trigger a discovery run and follow it to completion (`POST …/endpoints/{id}/discover`, then
poll `GET …/endpoints/{id}/jobs/{job_id}`). On a terminal run the CLI prints the new version,
a change summary, and a best-effort quality score (`GET …/versions/{version_id}/lint`); a
failed run or a timeout exits non-zero:

```bash
apiome mcp discover <endpoint-uuid>
apiome mcp discover <endpoint-uuid> --no-wait
apiome mcp discover <endpoint-uuid> --import-timeout 300 --poll-interval 2
apiome mcp discover <endpoint-uuid> --output json
```

`--wait` (default) polls until the job reaches `completed` or `failed`; `--no-wait` enqueues the
run and prints the job id without blocking. `--import-timeout` caps the total wait (and the
per-request HTTP timeout) at the given seconds — like the `import` poll loop, it defaults to
120s and overrides the global `--timeout`. Concurrent discover requests on the same endpoint are
de-duplicated server-side: the existing in-flight job is returned with a "deduplicated" note.

Score a discovered surface and list its lint findings (`GET …/versions/{version_id}/lint`). This
is the MCP-catalog analogue of the project `lint` command: a deterministic 0-100 quality score,
an A-F grade, and itemized findings for one version snapshot:

```bash
apiome mcp lint <endpoint-uuid>
apiome mcp lint <endpoint-uuid> --version <version-uuid>
apiome mcp lint <endpoint-uuid> --output json
apiome mcp lint <endpoint-uuid> --min-grade B
```

`--version` targets a specific snapshot; omitted, the endpoint's current (latest discovered)
version is scored — the CLI exits with guidance when the endpoint has never been discovered.
`--min-grade` turns the report into a CI gate, exiting non-zero when the grade is worse than the
floor (A best, F worst). `--output json` (or the global `--json`) prints the raw report.

Gate a discovered surface on MCP **protocol conformance and agent-readiness**
(`GET …/versions/{version_id}/conformance`). The server evaluates a rule profile against the
snapshot, scores it, and computes the CI gate; the CLI exits non-zero when the gate fails:

```bash
apiome mcp conformance <endpoint-uuid>
apiome mcp conformance <endpoint-uuid> --version <version-uuid>
apiome mcp conformance <endpoint-uuid> --profile mcp-agent-readiness
apiome mcp conformance <endpoint-uuid> --fail-on warning --min-score 80
apiome mcp conformance <endpoint-uuid> --format sarif
apiome mcp conformance <endpoint-uuid> --format junit
```

`--profile` selects the rule set: `mcp-conformance` (default, all rules), `mcp-protocol`, or
`mcp-agent-readiness`. `--fail-on error|warning|info|none` (default `error`) and `--min-score
0..100` are passed through so the server computes the gate. `--format sarif|junit` echoes the raw
gate artifact for CI ingestion **and still exits non-zero on a failing gate** (the gate is always
read from the JSON report, never inferred from the artifact); `--output json` (or the global
`--json`) prints the report.
Rules that require a captured protocol transcript are reported as **skipped, not passing** — the
human report prints an explicit "NOT EVALUATED" note listing them.

List the rule catalog, including the MCP specification version and source reference each rule
cites (`GET /v1/mcp/conformance/rules`):

```bash
apiome mcp conformance-rules
apiome mcp conformance-rules --profile mcp-protocol
apiome mcp conformance-rules --output json
```

### MCP governance (policy & key capabilities)

Tenant MCP policy and per-key capability grants are managed with a **session bearer**
(`APIOME_SESSION_TOKEN` / `--session-token`) and tenant scope. Mutations require a
**tenant administrator** JWT — workspace API keys cannot write governance (MTG-3.4 / MTG-5.3).

Print or replace the tenant policy (`GET` / `PUT /v1/tenants/{slug}/mcp-policy`). `--json`
emits the raw document; `policy set` accepts a JSON file (or `-` for stdin) and/or field
flags. Flags alone fetch the current policy, merge, validate locally, then PUT:

```bash
apiome mcp policy get
apiome --json mcp policy get
apiome mcp policy set --file policy.json
apiome mcp policy get --output json | apiome mcp policy set --file - --allow-anonymous false
apiome mcp policy set --default-mode explicit --allow-anonymous false
```

Example `policy.json` body (matches `TenantMcpPolicyPutRequest`; response-only
`updated_at` / `updated_by` fields are stripped when piping `get` into `set`):

```json
{
  "default_mode": "all",
  "allow_anonymous_mcp": true,
  "tools": [
    {
      "tool_id": "ping",
      "in_ceiling": true,
      "default_enabled": true,
      "anonymous_enabled": true
    }
  ]
}
```

Read or replace per-key grants. `key capabilities get` projects
`GET …/mcp-keys/{id}` onto `{mode, enabled_tools}` so the shape matches
`PUT …/capabilities`:

```bash
apiome mcp key capabilities get <key-uuid>
apiome --json mcp key capabilities get <key-uuid>
apiome mcp key capabilities set <key-uuid> --mode inherit
apiome mcp key capabilities set <key-uuid> --mode explicit --tool ping --tool spec.list
apiome mcp key capabilities set <key-uuid> --file caps.json
```

### Import JSON Schema types

Import system-wide JSON Schema type definitions (typically a `$defs` library) into the platform type table:

```bash
apiome import json-schema-type ./common-types.json
apiome import json-schema-type https://example.com/schemas/common-types.json
apiome import json-schema-type ./email.json --name contact_email --description "Primary email"
apiome import json-schema-type ./common-types.json --dry-run
apiome import json-schema-type ./common-types.json --publish public
apiome import json-schema-type ./common-types.json --publish private
```

Use `--publish public` to import into the system-wide type library (master tenant only). Use `--publish private` or omit the flag to import tenant-scoped types. `--visibility` is an alias for `--publish`.

Requires an API key (for `creator_id`) but not a tenant-scoped import target. If you run `import json-schema` on a type library file, the CLI suggests `import json-schema-type` instead.

### List resources

Human-readable tables (default):

```bash
apiome projects list
apiome projects list --limit 50 --all
apiome properties list
apiome schemas list
apiome versions list --project-id <uuid>
apiome types list
apiome types show email
apiome types search phone
```

Machine-readable JSON:

```bash
apiome --json projects list
apiome --json schemas get <uuid>
apiome --json types list
apiome --json types show email
```

Fetch a single record:

```bash
apiome projects get <uuid>
apiome properties get <uuid>
```

### Publish and unpublish types

Requires the master tenant API key (Tier 2). Publishing promotes a tenant-owned
type to the system-wide library (`system: true`). Unpublishing demotes a
system-wide type to tenant scope under the master tenant.

```bash
# Publish a tenant-owned type by slug
apiome types publish email

# Publish by UUID
apiome types publish <type-uuid>

# Unpublish a system-wide type
apiome types unpublish email

# Machine-readable result
apiome --json types publish email
```

### Publish and unpublish versions

Requires an API key (Tier 2). Publishing records `published_on` and makes the
version discoverable: `public` adds it to the public catalog, while `private`
publishes it as tenant-protected (visible only within your tenant).

Pass a version UUID directly, or use `--project` to publish by version slug or
label. The default visibility is `public`.

```bash
# Publish a version to the public catalog (by UUID)
apiome versions publish <version-uuid>

# Publish privately (tenant-protected), resolving by project + label
apiome versions publish 1.0.0 --project payments-api --visibility private

# Return a published version to draft (removes it from the catalog)
apiome versions unpublish 1.0.0 --project payments-api

# Machine-readable result
apiome --json versions publish <version-uuid>
```

### Manage hosted mocks

Requires an API key (Tier 2) and tenant scope (`APIOME_TENANT_ID` or
`--tenant`). Mirrors the SIM-2.1 REST control plane: the mock can only be
enabled on a **published** version (drafts are rejected by REST with a
readable error and a non-zero exit), and toggling requires the version
creator or a tenant-administrator role. `mock status` prints the enabled
flag, the stable mock base URL, and — when the usage endpoint is available —
a usage summary for the version.

Pass the project as a UUID or slug and the version as a UUID, slug, or label.

```bash
# Show mock state, base URL, and usage for a version
apiome mock status payments-api 1.0.0

# Widen or narrow the usage rollup window (default 30 days)
apiome mock status payments-api 1.0.0 --days 7

# Enable the hosted mock (published versions only)
apiome mock enable payments-api 1.0.0

# Disable it again
apiome mock disable payments-api 1.0.0

# Machine-readable status: {"version": <VersionSchema>, "usage": <MockUsageResponse|null>}
apiome --json mock status payments-api 1.0.0

# Machine-readable toggle result (raw updated VersionSchema)
apiome --json mock enable payments-api 1.0.0
```

### Run a portable mock (local / CI)

`mock run` needs **no API key and no tenant scope**: it launches a
version-pinned [mock bundle](../docs/guide/mock-bundle-format.md), which is the
whole configuration. It prefers a locally installed `apiome-mock` and otherwise
launches the official container image; both execute the same runtime, so both
answer the same mock conformance corpus.

```bash
# Serve a bundle at http://127.0.0.1:8775/{tenant}/{project}/{version}/...
apiome mock run petstore-1.0.0-mock-bundle.json

# Pick the runtime and the port explicitly
apiome mock run petstore-1.0.0-mock-bundle.json --runtime docker --port 9000

# Serve spec paths at the root instead of the hosted URL shape
apiome mock run petstore-1.0.0-mock-bundle.json --base-path root

# Show the command that would run, without launching anything
apiome mock run petstore-1.0.0-mock-bundle.json --dry-run
apiome --json mock run petstore-1.0.0-mock-bundle.json --dry-run

# Verify a signed bundle (the secret is passed via the environment, never argv)
APIOME_MOCK_BUNDLE_SECRET=… apiome mock run bundle.json --require-signature
```

Wait on `GET /ready` (not `/health`) before sending traffic — it reports the
digest of the bundle actually being served. Full reference, including the
runtime's flags, structured log events, and exit codes:
[docs/guide/portable-mock-runtime.md](../docs/guide/portable-mock-runtime.md).

### Export reconstructed specs (CI artifacts)

Requires tenant scope (`APIOME_TENANT_ID` or `--tenant`). Sends `X-API-Key` when configured so protected published versions are visible. Document bytes go to `--output`; diagnostics and metadata go to stderr. With global `--json`, metadata is JSON on stdout when `--output` is a file, and on stderr when `--output -` so stdout stays byte-safe for pipelines.

```bash
export APIOME_TENANT_ID=acme-corp

# Write OpenAPI JSON to a CI artifact path
apiome spec export \
  --project payments-api \
  --version 1.0.0 \
  --format openapi \
  --output ./artifacts/openapi.json

# Stream YAML to stdout (metadata on stderr)
apiome spec export \
  --project payments-api \
  --version 1.0.0 \
  --format arazzo \
  --yaml \
  --output -

# Machine-readable metadata (document still written to --output file)
apiome --json spec export \
  --project payments-api \
  --version 1.0.0 \
  --format openapi \
  --output ./artifacts/openapi.json
```

### Download original import artifact

`--import-id` is the project version UUID that owns the active import provenance row (`GET /versions/{id}/import-source`). Requires an API key.

```bash
apiome spec download-original \
  --import-id <version-uuid> \
  --output ./artifacts/original.yaml

apiome spec download-original \
  --import-id <version-uuid> \
  --output -
```

## Development

```bash
cd packages/apiome-cli
uv venv --allow-existing
uv sync
uv run pytest tests/ -v
uv run ruff check src/ tests/
```

```bash
yarn cli:lint
```

See [`AGENTS.md`](AGENTS.md) for contributor conventions, layout, and review checklist.

See the [CLI roadmap](../../docs/ROADMAP_APIOME_CLI.md) for planned commands.
