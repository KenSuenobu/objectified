# apiome-cli

Python 3.12+, typer, httpx, pydantic-settings, py-yaml12, jsonschema, openapi-spec-validator

## Rules

This file applies **only** to the `apiome-cli` package. It complements the repository root `AGENTS.md`. **Keep it current** when commands, layout, configuration, HTTP client behaviour, or REST contract alignment changes.

## Role

`apiome-cli` is a **client** for [apiome-rest](../apiome-rest). It does not implement business logic or database access. All persistence and import orchestration live in the REST service; the CLI validates inputs locally, calls HTTP endpoints, formats output, and maps errors to process exit codes.

## REST contract

The **canonical API contract** is `apiome-rest/openapi.yaml` (OpenAPI **3.2.0**, JSON Schema 2020-12 dialect). See [OpenAPI 3.2](https://spec.openapis.org/oas/v3.2.0.html) and [`apiome-rest/AGENTS.md`](../apiome-rest/AGENTS.md) for server-side rules.

**Do not** invent routes or request/response shapes in the CLI. When the REST API changes:

1. Update the REST OpenAPI spec and implementations in `apiome-rest` first.
2. Align CLI paths, payloads, and field names with the committed contract.
3. Update tests (`pytest-httpx` mocks and integration tests under `tests/integration/`).

Key REST surfaces used by the CLI:

| Area | Endpoints (representative) |
|------|----------------------------|
| Health | `GET /health` (anonymous) |
| List / get | `GET /projects`, `GET /properties`, `GET /schemas`, `GET /project-versions`, `GET /types`, `GET /{resource}/{id}` |
| Paths / workflows | `GET /versions/{version_id}/paths`, `GET /versions/{version_id}/paths/{path_id}`, `GET .../operations`, `GET /versions/{version_id}/workflows`, `GET .../steps` |
| API keys | `GET /api-keys`, `GET /api-keys/policy`, `PUT /api-keys/policy`, `POST /api-keys`, `GET /api-keys/mcp-tools`, `GET /api-keys/{id}`, `POST /api-keys/{id}/rotate`, `DELETE /api-keys/{id}` |
| Integrations | `GET /dashboard/linked-accounts` (session bearer) |
| MCP catalog | `GET /v1/mcp/{tenant_slug}/endpoints`, `POST /v1/mcp/{tenant_slug}/endpoints`, `GET /v1/mcp/{tenant_slug}/endpoints/{id}`, `PUT /v1/mcp/{tenant_slug}/endpoints/{id}/credentials` (API key; tenant scope required) |
| MCP governance | `GET` / `PUT /v1/tenants/{tenant_slug}/mcp-policy`, `GET /v1/tenants/{tenant_slug}/mcp-keys/{key_id}`, `PUT …/mcp-keys/{key_id}/capabilities` (session bearer; tenant admin for mutations; MTG-5.3) |
| Repositories | `GET /tenants/{id}/repositories`, `POST /tenants/{id}/repositories`, `POST /tenants/{id}/repositories/test-public-url`, `POST /tenants/{id}/repositories/{repository_id}/scans`, `GET /tenants/{id}/repositories/{repository_id}/scans/{scan_id}`, `GET /tenants/{id}/repositories/{repository_id}/files`, `POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/sniff`, `POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/verify`, `POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/import`, `POST /tenants/{id}/repositories/{repository_id}/imports:batch`, `POST /tenants/{id}/repositories/{repository_id}/imports:manifest`, `GET /tenants/{id}/repositories/{repository_id}/imports` (API key; tenant scope required); linked-account resolution uses `GET /dashboard/linked-accounts` and `GET /dashboard/linked-accounts/{id}/repositories` (session bearer). Auto-refresh (RAR): `POST /v1/tenants/{tenant_slug}/repositories/{repository_id}/refresh` (RAR-5.2 manual refresh), `GET /v1/tenants/{tenant_slug}/repositories/{repository_id}/refresh-history` (RAR-5.3 cycle audit), `GET /v1/tenants/{tenant_slug}/repository-imports/{id}/spec[?path=&branch=]` (RAR-1.5 stored spec + RAR-2.3 `refresh_status`), `GET /v1/tenants/{tenant_slug}/repository-files?repository_id=` (REPO-6.4 spec catalog) |
| Import | `POST /imports/openapi`, `POST /imports/arazzo`, `POST /imports/json-schema`, `POST /imports/json-schema-type`, `GET /imports/{job_id}`; spec-import jobs `POST /v1/tenants/{tenant_slug}/imports` (JSON+base64), `GET …/imports/{job_id}`; import-source registry `GET /v1/import/sources` |
| Pre-flight | `POST /v1/tenants/{tenant_slug}/import/preflight` (IXH-2.1: lint + rank a candidate document, nothing persisted), `POST /v1/tenants/{tenant_slug}/export/preflight` (IXH-2.4: source lint + target-readiness ranking, nothing emitted). Both return 200 with a full report even when the verdict is "do not do this" — key off the report, never off the HTTP status |
| Spec export | `GET /browse/tenants/{tenant}/projects/{project}/versions/{version}/spec?format=openapi\|arazzo` (optional API key); reconstruction routes `GET /v1/schema/{tenant}/{project}/{version}` (OpenAPI 3.1), `GET /v1/arazzo/...` |
| Emitter-registry export | `GET /v1/export/{tenant}/targets?artifact=&version=`, `POST /v1/export/{tenant}/preview` (fidelity only, no artifact; accepts `options`), `POST /v1/export/{tenant}/projection-evidence` (bounded cursor-paginated projection evidence, EFP-2.1), `POST /v1/export/{tenant}/document` (emit through the SPI → document bytes, JSON/YAML per `Accept`; API key + tenant scope), `POST /v1/export/{tenant}/jobs` (async export job → poll `GET …/jobs/{id}` → download `GET …/jobs/{id}/download`; API key + tenant scope) |
| Import provenance | `GET /versions/{id}/import-source`, `GET /versions/{id}/import-fidelity-diff` (API key) |
| Hosted mock | `PUT /v1/versions/{tenant}/{project}/{version_record_id}/mock` (SIM-2.1 toggle; published versions only), `GET /v1/versions/{tenant}/{project}/{version_record_id}` (mock state via `mockEnabled`/`mockBaseUrl`), `GET /v1/mocks/{tenant}/usage?days=&project_slug=&version_label=` (SIM-1.5 usage; best-effort) |
| Contract assurance | `POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/suite` (ECA-1.1); `POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/run` (ECA-2.1 — compile → resolve target → execute → record evidence); `GET /v1/tenants/{tenant_slug}/verification-runs/{run_id}/export?format=json\|junit` (ECA-1.3 artifact export). `version_ref` is the schema-reference grammar without a type segment (`project/{slug}/{version}`, `catalog/{item}/{version}`). Suite/run: a version that yields no suite is a 200 with `ok: false`; successful runs return 201 with evidence (200 on idempotent replay) |
| Classified diff | `POST /v1/diff/{tenant_slug}/classified` (CTG-1.2 / CTG-2.1); inline candidate vs stored base; `Accept: text/markdown` returns CTG-1.3 changelog |
| Schema testing | `POST /v1/tenants/{tenant_slug}/schemas/{schema_ref}/validate` (IXH-5.1 instance validation) and `POST …/schemas/{schema_ref}/synthesize` (IXH-5.2 payload synthesis, `verify: true`). `schema_ref` is the path-shaped reference (`project/{slug}/{version}[/{type}]`, `catalog/{item}/{version}[/{type}]`, `registry/{namespace}/{name}`) carried as multiple path segments — never percent-encode it. Unserviceable payloads are a 200 with `ok: false` + taxonomy `error`; only addressing faults are HTTP errors (400/404/422) |

Tier 2 commands require `X-API-Key` (see **Auth** below). Tier 1 `GET /health` does not.

## CLI guidelines ([clig.dev](https://clig.dev/))

Follow [Command Line Interface Guidelines](https://clig.dev/):

- **Help:** `-h` / `--help` on every command; concise default help when invoked with no subcommand (`main.py` → `echo_concise_help()`).
- **Exit codes:** `exit_codes.py` — `0` success, `1` error, `2` usage (`EXIT_SUCCESS`, `EXIT_ERROR`, `EXIT_USAGE`). Map HTTP 4xx → usage, 5xx → error (`client/errors.py`). The pre-flight surface adds three gate codes used **only** by `import preflight` / `export preflight` and the `--min-grade` / `--fail-on` flags (IXH-2.6): `3` `EXIT_POLICY_BLOCKED` (tenant quality policy refuses the payload), `4` `EXIT_QUALITY_GATE` (a caller-supplied threshold was missed), `5` `EXIT_PREFLIGHT_UNUSABLE` (nothing gradable). They exist so CI can tell a bad spec apart from a bad network (`1`) or bad credentials (`2`). Failed import/export **jobs** also map taxonomy categories via `taxonomy_exit.py` (IXH-6.4): `policy` → 3, `input`/`format`/`capability`/`resource` → 2, `transport`/`internal` → 1; stderr prints `[CODE] message — remediation`. `schema test` adds `6` `EXIT_SCHEMA_TEST_FAILED` (IXH-5.5): at least one schema-test case failed — kept distinct from `1` (could not run) and `2` (auth/reference rejected) so CI can gate on the verdict.
- **Streams:** human tables and JSON on **stdout**; diagnostics, progress spinners, and tracebacks (with `--verbose`) on **stderr**.
- **Machine output:** global `--json` emits raw API JSON on stdout.
- **Configuration precedence** (highest first): CLI flags → `APIOME_*` env → dotenv files (default package + cwd `.env`, or `--env-file`) → `~/.config/apiome/config.toml` → defaults. Document new settings in `.env.example` and `README.md`.
- **Secrets:** never log or print full API keys (`config show` masks `api-key`).
- **Examples:** keep copy-pasteable examples in `README.md` when adding commands.

## Layout

| Path | Role |
|------|------|
| `src/apiome_cli/main.py` | Typer root app, global flags, console entry `run()` |
| `run.sh` | Load `.env`, ensure `.venv`, forward argv to `apiome` or start interactive/batch mode |
| `src/apiome_cli/run_interactive.py` | Interactive prompt and stdin batch runner used by `run.sh` |
| `src/apiome_cli/cli_context.py` | Resolve settings, timeout, `--json`, `--no-progress`, `--insecure` from context |
| `src/apiome_cli/config.py` | `CliSettings`, TOML user config, env/flag overrides |
| `src/apiome_cli/exit_codes.py` | Process exit codes (0–6) |
| `src/apiome_cli/taxonomy_exit.py` | Map intake/delivery taxonomy categories → exit codes + stderr format (IXH-6.4) |
| `src/apiome_cli/client/http.py` | `RestClient` (httpx sync), auth headers |
| `src/apiome_cli/client/pagination.py` | Offset/limit pagination for list commands |
| `src/apiome_cli/client/repos_add.py` | Linked-account and public-URL payload builders for `repos add` |
| `src/apiome_cli/client/repos_files.py` | Repository file list filters and table output for `repos files` |
| `src/apiome_cli/client/repos_inspect.py` | Sniff and deep-verdict output for `repos inspect` |
| `src/apiome_cli/client/repos_closure.py` | `$ref` closure resolution for `repos inspect --closure` and `repos files --closure` |
| `src/apiome_cli/client/repos_import.py` | Import mapping validation and REST body builder for `repos import` |
| `src/apiome_cli/client/repos_import_batch.py` | Batch file selection, import map parsing, and summary output for `repos import --files` |
| `src/apiome_cli/client/repos_import_manifest.py` | Manifest import request builder, local manifest validation, and summary output for `repos import --manifest` |
| `src/apiome_cli/client/repos_imports.py` | Import provenance list filters and table output for `repos imports` |
| `src/apiome_cli/client/repos_verify.py` | Integrity/signature trust assessment and output for `repos verify` |
| `src/apiome_cli/client/repos_scan.py` | Scan enqueue output and poll loop for `repos scan --wait` |
| `src/apiome_cli/client/repository_refresh.py` | Repository auto-refresh client: repository reference resolution, per-file status reads (catalog + RAR-1.5 spec), manual refresh trigger, refresh-history reads, and the settle poll loop for `repository refresh` (RAR-5.6) |
| `src/apiome_cli/repository_refresh_output.py` | Pure refresh logic: status-row normalization, settle rules, failure/divergence classification, and human/JSON rendering for `repository refresh` (RAR-5.6) |
| `src/apiome_cli/client/errors.py` | `CliError`, HTTP → exit code, concise help |
| `src/apiome_cli/client/browse_scope.py` | Resolve tenant/project/version slugs for browse spec export |
| `src/apiome_cli/client/mock_settings.py` | Hosted-mock toggle/status client and output for `mock` (SIM-2.4) |
| `src/apiome_cli/client/contract_verify.py` | Pure helpers for `verify contract`: request body, exit gate, failure lines (ECA-2.2) |
| `src/apiome_cli/schema_test.py` | Pure logic for `schema test`: suite discovery, case judging, verdict/exit rules, JUnit + JSON + human renderings (IXH-5.5). No HTTP, no typer |
| `src/apiome_cli/client/spec_download.py` | Browse spec and import-source HTTP download helpers |
| `src/apiome_cli/spec_output.py` | Write document bytes; emit metadata on stdout/stderr per clig.dev |
| `src/apiome_cli/commands/` | Typer subcommands (`auth`, `api-keys`, `integrations`, `config`, `doctor`, `health`, `projects`, `properties`, `schema`, `schemas`, `types`, `tokens`, `versions`, `paths`, `operations`, `workflows`, `spec`, `import`, `export`, `convert`, `diff`, `contract`, `verify`, `repos`, `repository`, `mcp`, `mcp_governance`, `mock`) |
| `src/apiome_cli/output_diff.py` | Against-ref parse, `--fail-on` threshold, text/json formatting for `diff` (CTG-2.1) |
| `src/apiome_cli/client/conversion_output.py` | Fidelity summary + mandatory-warning formatting and low-tier detection for `convert` (MFI-22.6) |
| `src/apiome_cli/client/export_registry.py` | Emitter-registry export client: targets discovery (`GET /export/targets`) + dry-run fidelity preview (`POST /export/preview`) + projection evidence paging (`POST /export/projection-evidence`, EFP-2.1) + target resolution for generic export (MFX-9.4 / MFX-8.1) |
| `src/apiome_cli/client/export_jobs.py` | Async export job client: submit (`POST /export/jobs`), poll (`GET …/jobs/{id}`), download (`GET …/download`) for generic `export <format>` (MFX-8.1) |
| `src/apiome_cli/export_dispatch.py` | Generic export runner: resolve target, poll job, write single file or unzip bundle to `--out` (MFX-8.1) |
| `src/apiome_cli/client/export_document.py` | Emit-document client: `POST /export/document` → emitted bytes for `export asyncapi`, `export grpc`, `export graphql`, `export avro`, and other non-OpenAPI targets (MFX-11.5, MFX-12.5, MFX-13.5, MFX-19.5) |
| `src/apiome_cli/export_output.py` | Export fidelity advisory + loss table formatting, lossy gating (`--force` or TTY confirm), and targets-table rows for `export` (MFX-8.2 / MFX-9.4) |
| `src/apiome_cli/paths_inventory.py` | REST helpers to resolve paths, operations, and workflow steps |
| `src/apiome_cli/output_paths.py` | Human tables for path/operation/workflow inspection |
| `src/apiome_cli/import_/` | OpenAPI/Arazzo/JSON Schema load (file, stdin, URL), validate, detect, upload, job poll |
| `src/apiome_cli/client/git_import.py` | Git-repository intake client (`POST /v1/tenants/{tenant}/import/git/fileset`): repository selection → packed fileset + commit provenance (MFI-29.3) |
| `src/apiome_cli/client/bulk_import.py` | Bulk-import client (`POST /v1/tenants/{tenant}/import/bulk[/plan\|/status]`): partition a payload, start one job per independent spec, roll the jobs up (MFI-29.5) |
| `src/apiome_cli/import_/bulk.py` | Bulk payload packing (a local directory → deterministic archive, skipped files reported) plus the per-item result rendering and exit-code rules (MFI-29.5) |
| `src/apiome_cli/import_/sources.py` | Import-source registry client (`GET /v1/import/sources`), generic adapter-import request body, and `import --list` / `import <format>` output (MFI-1.4) |
| `src/apiome_cli/preflight.py` | Pure pre-flight logic: `--min-grade` / `--fail-on` validation, gate evaluation → exit code, and report rendering (headlines, findings table, ranked targets, waiver reporting). No HTTP, no typer (IXH-2.6) |
| `src/apiome_cli/preflight_runner.py` | Pre-flight orchestration shared by the commands and the gate flags: emit (verbatim `--json` or table), `enforce_gate`, and the `gate_import_before_job` / `gate_export_before_job` short-circuits (IXH-2.6) |
| `src/apiome_cli/client/preflight.py` | Pre-flight HTTP client: `POST …/import/preflight` request body + call, `POST …/export/preflight` call (IXH-2.6) |
| `src/apiome_cli/extract/` | OpenAPI `info` metadata and slug helpers |
| `src/apiome_cli/output.py` | Human tables and import result formatters |
| `src/apiome_cli/progress.py` | Stderr progress during long imports |
| `tests/` | Unit tests (no network); `tests/integration/` uses `pytest-httpx` mocks |
| `test/scaffold.test.mjs` | Node scaffold checks (package.json, pyproject, paths) |

## Commands (Typer)

Registered in `main.py`:

| Group | Purpose |
|-------|---------|
| `help` | Concise usage, or subcommand help (`apiome help projects list`) |
| `auth` | `whoami`, `status`, `tenants` (session bearer; `GET /auth/me`, `/auth/tenants`) |
| `config` | `show` / `set` / `unset` for `base-url`, `tenant`, `api-key`, `session-token` |
| `doctor` | Anonymous connectivity probe (`GET /health`) |
| `health` | Print health JSON |
| `projects` | `list`, `get` |
| `properties` | `list`, `get` |
| `schema` | `test` runs schema tests server-side and gates on the verdicts (IXH-5.5, #5117): `--schema REF` (path-shaped IXH-5.1 reference), case sources `--payload FILE` (repeatable, expected valid; `*.xml` sent as XML), `--generate` (IXH-5.2 set — valid instances + single-constraint mutants — via `POST …/synthesize` with `verify: true`; `--seed` reproduces it), and `--suite PATH` (a directory of saved payload files, or an IXH-1.1 corpus manifest whose `instance-payload` entries run with expectations from `validity_class`; suite mode also runs the generated set unless `--no-generate`). Emits a stable report under global `--json` and JUnit XML via `--junit FILE\|-`; every mutant is reported with its intended keyword and whether it violated it, and server-rejected mutant candidates surface as `rejected_mutants`. Exit codes (this command): `0` all passed, `6` a case failed, `1` a case could not be checked / transport / empty run, `2` usage/auth/reference rejection (any 4xx). API key + tenant scope |
| `schemas` | `list`, `get` |
| `types` | `list`, `show`, `search` (public `GET /types`; no API key), `publish`, `unpublish` (master tenant API key) |
| `versions` | `list`, `get` (REST path `project-versions`) |
| `paths` | `list`, `show` (`GET /versions/{version_id}/paths`, filters: `--method`, `--tag`, `--q`) |
| `lint` | Quality score + findings for a version (`GET /versions/{tenant}/{project}/{version}/lint`); `--base-version` folds breaking-change risk; `--min-grade A..F` gates CI exit code; `--fail-on-policy` fetches `GET …/lint/policy` and exits non-zero when style-guide gates fail; when the score persisted at import time is out of date (`scoreIsStale`) it also prints the stored `capturedScore`/`capturedGrade` |
| `compat` | Independent oasdiff compatibility evidence (`POST …/compatibility/evidence`); requires `--project`, `--version`, `--base-version`; `--format json\|sarif\|junit`; `--fail-on breaking\|dangerous\|info` (default breaking) |
| `contract` | `suite` compiles a version's executable contract suite (`POST /v1/tenants/{tenant}/contracts/{ref}/suite`, ECA-1.1): `--project`, `--version`, `--kind project\|catalog`, `--seed`, `--examples/--no-examples`, `--generated/--no-generated`, `--negative/--no-negative`, `--operation` (repeatable), `--max-operations`, `--out FILE`. `--out` writes the manifest's **canonical bytes** (sorted keys, tight separators, trailing newline — the bytes the digest covers) and the command re-derives that digest locally, exiting `1` on a mismatch or on `ok: false`. API key + tenant scope |
| `verify` | `contract` runs a suite against a verification target and emits CI artifacts (`POST …/contracts/{ref}/run` + `GET …/verification-runs/{id}/export`, ECA-2.2): `--project`, `--version`, `--target`, `--kind project\|catalog`, `--format json\|junit`, `--out FILE`, suite options (same as `contract suite`), `--idempotency-key`, `--context KEY=VALUE` (repeatable). Prints evidence run id + per-case `failure_code` lines; writes JSON/JUnit via the server export (no local re-serialize). Exit `0` only when `run.outcome` is `passed`; `ok: false` and non-passing outcomes exit `1`. Target credentials are never accepted on the CLI (env/stored refs only on the server). Default HTTP timeout 120s. API key + tenant scope |
| `diff` | CI classified-diff gate (`POST /v1/diff/{tenant}/classified` inline mode): `apiome diff <file> --against <project>@<version\|latest>`; `--fail-on breaking\|warn` (default `breaking`); `--format text\|json\|md` (`md` re-fetches with `Accept: text/markdown` for the CTG-1.3 changelog). Exit codes for this command: `0` = gate passed, `1` = threshold met, `2` = auth/network/parse/oversize. API key + tenant scope (CTG-2.1 / #4471) |
| `operations` | `show` (resolve by operation UUID or `operationId`) |
| `workflows` | `list`, `show` (`GET /versions/{version_id}/workflows`, steps sub-resource) |
| `spec` | `export` (browse reconstructed OpenAPI/Arazzo), `download-original` (`GET /versions/{id}/import-source`) |
| `convert` | Convert a catalog item (a non-OpenAPI import) to an OpenAPI project (`POST /v1/catalog/{tenant}/{artifact}/convert`, MFI-22.6): `apiome convert <artifact> --to openapi` commits the convert-to-project/version job (MFI-22.5); `--dry-run` returns the fidelity report only (MFI-22.3) with `--out FILE` writing the would-be OpenAPI document; `--title`/`--api-version`/`--server` supply defaults applied only where the source left a gap; prints the server-computed fidelity summary + mandatory warning and **exits non-zero on a low-fidelity tier unless `--force`** (`--to openapi` is the only target today; the verb is target-generic). API key + tenant scope |
| `import` | `openapi`, `swagger`, `arazzo`, `json-schema`, `json-schema-type`, `auto`; `--list` enumerates the registered import sources (`GET /v1/import/sources`); `import <format> <input>` dispatches any **registry** format (MFI-1.4) — resolves `<format>` against the registry and submits via the shared spec-import job with `--file`/`--url`/INPUT, `--dry-run`, `--import-timeout` (no per-format flags; document bytes sent verbatim, preview summary surfaced). `git REPO_URL [--ref REF] [--path GLOB] [--root PATH] [--format KEY] [--repository-id ID|--linked-account-id ID]` imports a repository selection (MFI-29.3): the server reads the path/glob at an immutable commit (`POST …/import/git/fileset`), packs it as the multi-file payload archive intake already accepts, and the normal job runs with `options.git_source` recording repo/ref/commit. `auto --bulk <archive|directory>` imports **every independent spec** in one payload (MFI-29.5): a local directory is packed deterministically client-side, `POST …/import/bulk/plan` partitions it, `POST …/import/bulk` starts one ordinary job per spec, and `POST …/import/bulk/status` rolls them up — a failed item is one row, never a failed batch, and the exit code follows the failing items' taxonomy categories (3 policy / 2 caller fault / 1 transport). `preflight [INPUT|--file|--url] [--format KEY] [--root PATH] [--target catalog|types|project] [--min-grade G] [--fail-on S]` scores a candidate without persisting anything (`POST …/import/preflight`, IXH-2.6). `--min-grade` / `--fail-on` are also available on `openapi`, `swagger`, `auto`, and `import <format>`, where they pre-flight the exact bytes the job would submit and **exit before the job is created** when the verdict blocks |
| `export` | Emitter-registry export — the inverse of `import` (MFX-9.4 / MFX-8.1). **Generic (async job):** any registry target not covered by a dedicated verb is invokable as `apiome export <format> <artifact> [--version V] [--out FILE|DIR] [--option key=value …]` — resolves the emitter, submits `POST /v1/export/{tenant}/jobs`, polls to completion, downloads the artifact, writes a single file (or `-` for stdout) or unpacks a zip bundle to a directory; `--force` / `--confirm` / global `--json` supported. Use format keys like `openapi-3.1` or `protobuf` (alias `grpc`) when the dedicated verb name differs. **Dedicated verbs (sync):** `export openapi --project P --version V -o FILE` writes the OpenAPI document (via the browse reconstruction `GET /v1/schema/...`, the same source as `spec export`) and surfaces the emitter registry's fidelity report (`POST /v1/export/{tenant}/preview`, target `openapi`), **exiting non-zero on a lossy/types-only export unless `--force`** (the document is written either way); `--yaml`/`--accept` pick the serialization. `export asyncapi` … `export avro` write through `POST /v1/export/{tenant}/document` + `/preview` fidelity. `export targets --project P [--version V]` lists emitters + fidelity (`GET /v1/export/{tenant}/targets`). `export preflight --project P [--version V] [--to TARGET …] [--min-grade G] [--fail-on S]` ranks every target by readiness before a job exists (`POST /v1/tenants/{tenant}/export/preflight`, IXH-2.6); blocked and unavailable targets are ranked and shown, never hidden, and the export counts as refused only when **no** target is selectable. `--min-grade` / `--fail-on` are also available on every dedicated verb and on the generic job export, where they pre-flight the target being exported and **exit before any bytes are emitted**. API key + tenant scope |
| `tokens` | `list`, `create`, `revoke` personal access tokens (`/auth/personal-access-tokens`) |
| `api-keys` | `list`, `create`, `show`, `rotate`, `revoke`, `policy get`, `policy set` workspace API keys (`/api-keys`) |
| `list-api-keys` | Top-level alias for `api-keys list` |
| `integrations` | `list`, `show` linked services (`GET /dashboard/linked-accounts`, session bearer) |
| `mcp` | **Catalog (API key + tenant scope):** `register` an external MCP server (`POST /v1/mcp/{tenant}/endpoints`; `--name`, `--url`, `--transport`, optional `--slug`/`--description`/`--category`/`--visibility`, and `--bearer`/`--header` to seal an outbound credential via `PUT .../credentials`), `list` (`GET /v1/mcp/{tenant}/endpoints`), `show <id>` (`GET /v1/mcp/{tenant}/endpoints/{id}`), `discover <id>` triggers a discovery run (`POST .../endpoints/{id}/discover`) and polls its status (`GET .../endpoints/{id}/jobs/{job_id}`) to a terminal state, printing the new version, change summary, and best-effort quality score (`GET .../versions/{version_id}/lint`); `--wait/--no-wait`, `--poll-interval`, `--import-timeout` (reuses the import poll loop); human + `--json`/`--output json`; `lint <id>` scores a version snapshot (`GET .../versions/{version_id}/lint`; `--min-grade`, `--fail-on-policy`), `conformance <id>` gates MCP protocol conformance + agent-readiness (`GET .../versions/{version_id}/conformance`; `--version`, `--profile mcp-conformance|mcp-protocol|mcp-agent-readiness`, `--format json\|sarif\|junit`, `--fail-on error\|warning\|info\|none`, `--min-score 0..100`; always reads the JSON report first and exits non-zero when the server-computed `gate.passed` is false — including under `--format sarif|junit`, which re-GET the artifact and echo it verbatim (same two-call ordering as `compat`); skipped transcript rules are printed as NOT EVALUATED, never as passing), `conformance-rules` lists the rule catalog with each rule's MCP spec version + source reference (`GET /v1/mcp/conformance/rules`, registry-level, `--profile` filter). **Governance (session bearer + tenant scope; mutations need tenant admin — MTG-5.3):** `policy get` / `policy set` (`GET`/`PUT /v1/tenants/{slug}/mcp-policy`; `--file`/`-` and/or `--default-mode` / `--allow-anonymous`), `key capabilities get <key_id>` / `key capabilities set <key_id>` (`GET …/mcp-keys/{id}` projected to `{mode, enabled_tools}`; `PUT …/capabilities`; `--file`/`-` and/or `--mode` / `--tool`) |
| `mock` | `status <project> <version>` shows the hosted-mock flag, stable mock base URL, and a best-effort usage summary (`GET /v1/versions/{tenant}/{project}/{version_record_id}` + `GET /v1/mocks/{tenant}/usage?days=&project_slug=&version_label=`; `--days` widens the rollup window); `enable` / `disable <project> <version>` toggle the mock (`PUT …/{version_record_id}/mock`, SIM-2.1; enable is rejected by REST for draft versions and for callers who are not the version creator or a tenant admin — errors surface verbatim with a non-zero exit). Human record table + global `--json` (`status` emits `{"version": …, "usage": …|null}`; toggles emit the raw updated `VersionSchema`). API key + tenant scope (SIM-2.4, #4445) |
| `repos` | `list` tenant repositories (`GET /tenants/{id}/repositories`, filters: `--provider`, `--status`, `--name`; `--format table\|json`); `add` registers via public URL (`--url`, optional `--branch`) or linked account (`--account`, `--repo`, session bearer + API key); `scan` enqueues a branch scan (`POST /tenants/{id}/repositories/{repository_id}/scans`, optional `--branch`; `--wait` polls `GET …/scans/{scan_id}` and prints file counts); `files` lists scanned files (`GET …/files`, filters: `--glob`, `--regex`, `--preset`, `--detected-kind`, `--importable/--not-importable`; `--closure` adds a closure indicator column; table shows detected kind + importable verdict); `inspect` runs content sniff (`POST …/files/{file_id}/sniff`; prints verdict, kind, version, and reasons; `--closure` prints resolved/missing `$ref` members via `GET …/files/{file_id}/content` + file tree; `--deep` runs deep pre-import verdict (`POST …/files/{file_id}/verify`; prints validation/lint/fidelity/secrets findings and exits non-zero on blocking findings; `--format table\|json`); `verify` checks integrity + signature metadata (`GET …/files` or `GET …/files/{file_id}`; exits non-zero on integrity or invalid-signature failures; `--format table\|json`); `import` imports one repository file (`POST …/files/{file_id}/import`), many via batch import (`POST …/imports:batch` with `--files`/`--regex` file selection and optional `--map` YAML/JSON per-path mappings), or per manifest (`POST …/imports:manifest` with `--manifest`, or `--manifest-file PATH` for a local `.apiome.yaml`); `--new-project` or `--project` with `--version-id` / `--version-name` (batch only); optional `--dry-run`, `--resume-run-id`; reuses `emit_import_result` / batch or manifest summary output); `imports` lists import provenance (`GET …/imports`, filters: `--project`, `--version-id`, `--actor`, `--since`, `--until`; table shows file path, project, version, importer, imported_at, blob SHA) |
| `repository` | Repository auto-refresh (RAR-5.6). `refresh REPO [--path PATH] [--branch B]` triggers the RAR-5.2 spec-faithful manual refresh (`POST /v1/tenants/{slug}/repositories/{id}/refresh`) — stored import spec, freshness gate, divergence guard, cadence/opt-out bypass — and by default polls until the refreshed lineages settle (`--wait/--no-wait`, `--poll-interval`, `--refresh-timeout`, `--limit`), printing the final per-file state plus any refresh cycles recorded in the RAR-5.3 history; exits `1` on a `failed` file or a failed cycle, while a held divergence is reported but is not a failure. `refresh status REPO [--path] [--branch] [--all-branches] [--limit]` lists per-file refresh state, joining the spec catalog (`GET /v1/tenants/{slug}/repository-files?repository_id=`) to each lineage's stored spec (`GET /v1/tenants/{slug}/repository-imports/{repository_id}/spec?path=`, RAR-1.5), whose `refresh_status` is the RAR-2.3 state. `REPO` is a repository UUID or a name matched against `full_name` then `name`. Human tables + `--format table\|json` / global `--json`. API key + tenant scope |

Global flags on the root callback: `--base-url`, `--tenant`, `--api-key`, `--session-token`, `--env-file`, `--json`, `--verbose`, `--timeout`, `--no-progress`, `--insecure`.

Add new subcommands as modules under `commands/` and register with `app.add_typer()` in `main.py`.

### Repository Store (`repos`)

Tenant-scoped Git repository commands live in `commands/repos.py` with client helpers under
`client/repos_*.py`. The CLI mirrors the Control Panel Repositories tab: register a repo, scan a
branch, browse files, sniff importability, verify trust signals, run deep pre-import verdicts,
import via the existing single-file importer (single, batch, or manifest), and list provenance.
**Do not fork** import logic — `repos import` calls
`POST /tenants/{id}/repositories/{repository_id}/files/{file_id}/import` and reuses
`emit_import_result` from `output.py`.

| Subcommand | REST surface | Auth |
|------------|--------------|------|
| `repos list` | `GET /tenants/{id}/repositories` | API key + tenant |
| `repos add` (public URL) | `POST …/test-public-url`, `POST …/repositories` | API key + tenant |
| `repos add` (linked account) | `GET /dashboard/linked-accounts`, `GET …/repositories`, `POST …/repositories` | API key + tenant + session bearer |
| `repos scan` | `POST …/scans`, `GET …/scans/{scan_id}` (when `--wait`) | API key + tenant |
| `repos files` | `GET …/files`, `GET …/files/{file_id}/content` (when `--closure`) | API key + tenant |
| `repos inspect` | `POST …/files/{file_id}/sniff`, `POST …/files/{file_id}/verify` (when `--deep`) | API key + tenant |
| `repos verify` | `GET …/files`, `GET …/files/{file_id}` | API key + tenant |
| `repos import` | `POST …/files/{file_id}/import`, `POST …/imports:batch`, `POST …/imports:manifest` | API key + tenant |
| `repos imports` | `GET …/imports` | API key + tenant |

**Trust flags:** `repos inspect --deep` calls `POST …/verify` and exits non-zero on blocking
findings. `repos verify` checks `content_integrity_verified` and `signature_status` and exits
non-zero on integrity or invalid-signature failures. `repos import --manifest` drives
`POST …/imports:manifest`; `--manifest-file PATH` validates a local `.apiome.yaml` and
resolves targets against scanned repository files.

Copy-pasteable examples for each subcommand are in [`README.md`](README.md) under
**Repository Store** (workflow + per-command subsections). When adding flags or REST fields,
update that section and the `repos` row in **Commands** above.

### Repository auto-refresh (`repository refresh`)

The RAR auto-refresh surface lives in `commands/repository.py` with
`client/repository_refresh.py` (HTTP) and `repository_refresh_output.py` (pure logic +
rendering). It mirrors the Repositories → **Specs** tab: "Refresh now" and the per-file status
column, driven by the same REST calls.

| Subcommand | REST surface | Auth |
|------------|--------------|------|
| `repository refresh REPO` | `POST …/repositories/{id}/refresh` (RAR-5.2), then `GET …/repository-files` + `GET …/repository-imports/{id}/spec` + `GET …/refresh-history` while waiting | API key + tenant |
| `repository refresh status REPO` | `GET …/repository-files?repository_id=` (REPO-6.4) + `GET …/repository-imports/{repository_id}/spec?path=` (RAR-1.5) | API key + tenant |

**Gates are the server's.** The CLI adds none: the freshness comparator (RAR-2.2) decides what is
enqueued (`enqueued`/`skipped` counts; `enqueued: 0` is a reported no-op) and the divergence guard
(RAR-4.4) decides whether a hand-edited version may be overwritten. A held divergence is surfaced
loudly but exits `0`; a `failed` lineage or a failed RAR-5.3 cycle exits `1`.

**Waiting.** `refresh` snapshots the pending (`stale` / `refreshing`) lineages *before* triggering,
then polls until each has left that set or a new refresh-cycle audit row (compared by **entry id**,
never by timestamp, so clock skew cannot end the wait early) covers it. Note that the RAR-1.5 read
does not join the refresh-job queue, so its `refresh_status` carries the recency axis; the history
poll is what surfaces the operational outcome once the EPIC-4 dispatcher records cycles.

`REPO` accepts a repository UUID or a name (matched against `full_name`, then `name`); an ambiguous
name is a usage error naming the candidates. `refresh status` is a declared subcommand, so a
repository literally named `status` must be refreshed by UUID.

## Implementation rules

- **Python ≥ 3.14**, **uv** + `.venv`, PEP 8, `ruff` for lint. After dependency changes: `uv lock` and commit `uv.lock`.
- **HTTP:** use `RestClient` and `settings_from_context()`; do not open raw httpx calls in commands except via the client layer.
- **Auth:** `doctor` uses `RestClient(..., anonymous=True)` for unauthenticated `GET /health`; `health` uses normal `RestClient(...)` behavior (it may send `X-API-Key` when configured). Tier 2 list/import/get and `api-keys` commands use workspace API key auth (`X-API-Key`). `types list`, `types show`, and `types search` use `RestClient(..., anonymous=True)` for public `GET /types` reads; `types publish` and `types unpublish` require the master tenant API key. `auth`, `tokens`, and `integrations` use `RestClient(..., session=True)` with `Authorization: Bearer` from `APIOME_SESSION_TOKEN` / `--session-token`; `tokens create` prints the raw PAT only once in human mode. `mcp policy` and `mcp key capabilities` also use `session=True` (tenant-admin JWT); catalog `mcp` verbs stay on API key auth.
- **Imports:** validate OpenAPI (`openapi-spec-validator`), Arazzo 1.0 (vendored JSON Schema 2020-12 in `import_/schemas/arazzo/`), and JSON Schema 2020-12 (`jsonschema`) locally before upload; load documents from local paths, stdin (`-`), or `http`/`https` URLs via `import_/source.py`; use `import_/detect.py` to reject wrong document types with actionable messages. `import auto` resolves the format from content markers (`openapi`/`swagger`/`arazzo`/`$schema`); content always wins, and a `*.arazzo.{yaml,yml,json}` filename hint routes to Arazzo only as a last resort when no marker matches (mirrors the REST scanner; stdin has no filename hint). Optional ``--publish public|private`` (alias ``--visibility``) sets REST ``visibility`` on OpenAPI/Arazzo import (`private` → ``protected``); omit to leave the version as ``draft``. For ``import json-schema-type``, ``--publish public`` sets REST ``system: true`` (system-wide library; master tenant only); ``--publish private`` or omit defaults to tenant scope.
- **Registry dispatch (MFI-1.4):** the `import` group is a `DispatchImportGroup` — a name that is not a dedicated verb resolves to a generic adapter import against the MFI-1.1 registry, so a server-side `ImportSource` is invokable as `import <format> <input>` with **no new CLI command code**. The requested format is validated against the live `GET /v1/import/sources` list (typo → actionable "unknown format" with the available list). The generic path sends document bytes verbatim (any format the adapter accepts), reuses `resolve_import_result` poll + the shared spec-import job, and renders the adapter preview summary (`import_/sources.py`). Add a dedicated verb only when a format needs its own flags; otherwise the registry seam already covers it.
- **JSON Schema MVP:** only the file given is imported; external `$ref` targets are not resolved (document in README when behaviour changes).
- **Timeouts:** default 30 s; import poll/upload default 120 s unless `--timeout` is set (`cli_context.import_timeout_from_context`).
- **DRY:** reuse `output.py`, `client/pagination.py`, and `import_/upload.py` rather than duplicating format or poll logic.

## Testing

| Layer | Location | Notes |
|-------|----------|-------|
| Unit | `tests/test_*.py` | No live network; mock HTTP with `pytest-httpx` where needed; `repos` coverage in `tests/test_repos_commands.py` plus `tests/test_repos_*_helpers.py` |
| Integration (mocked) | `tests/integration/` | Import wait loop and list commands against mocked REST |
| Scaffold | `tests/test_scaffold.py`, `test/scaffold.test.mjs` | Package layout and tooling |
| Docs | `tests/test_readme.py`, `tests/test_agents.py` | README and AGENTS.md guard required sections |
| Fixtures | `tests/fixtures/` | Synthetic OpenAPI/Arazzo/AsyncAPI (2.6/3.0/3.1)/GraphQL SDL/gRPC `.proto`/Avro `.avsc` samples (no credentials or PII) for import/export tests |

Run from monorepo root or package:

| Task | Command |
|------|---------|
| Install / build | `yarn cli:build` or `cd packages/apiome-cli && uv sync` |
| Test | `yarn cli:test` or `uv run pytest tests/ -v && node --test test/*.test.mjs` |
| Lint | `yarn cli:lint` or `uv run ruff check src/ tests/` |

Tests must pass with **no warnings, no errors, and no skips** before merge.

## Review checklist

- [ ] Behaviour matches `apiome-rest/openapi.yaml` (no ad-hoc API shapes)
- [ ] [clig.dev](https://clig.dev/) exit codes, stdout/stderr split, and help text respected
- [ ] New env vars in `.env.example`; config precedence documented in `README.md`
- [ ] `AGENTS.md` and `README.md` updated if commands, layout, or conventions changed
- [ ] Unit and/or integration tests added; `yarn cli:test` and `yarn cli:lint` pass
- [ ] No secrets in logs, commits, or test fixtures

## Related docs

- [`README.md`](README.md) — install, configuration, examples
- [`docs/ROADMAP_APIOME_CLI.md`](../../docs/ROADMAP_APIOME_CLI.md) — planned commands and epics
- [`packages/apiome-rest`](../apiome-rest) — REST service and OpenAPI contract
