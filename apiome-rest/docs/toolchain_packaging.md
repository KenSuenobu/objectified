# Tool runtime packaging (MFI-5.2)

> **Status:** bundled tool declarations + availability probe + Dockerfile installer —
> `src/app/toolchain_packaging.py`, `Dockerfile`
> **Issue:** [#3751](https://github.com/objectified-project/objectified/issues/3751) ·
> **Epic:** MFI-EPIC-5 (#3720) · **Builds on:** MFI-5.1 (#3750, the runner)

MFI-5.1 built the *seam* for shelling out to non-Python parser/linter/diff CLIs
(`app.toolchain_runner`). MFI-5.2 is the *packaging*: it ships the real binaries, pins each
to a reproducible version, and makes a missing tool a clean **"format unavailable"** signal
instead of a crash.

## What is bundled (pinned)

`BUNDLED_TOOLS` in `src/app/toolchain_packaging.py` is the **single source of truth** for
which tools ship and at what version. The Dockerfile installs exactly these versions via
build args (`BUF_VERSION`, `TSP_VERSION`, …) — **bump both together**.

One tool is different. `asyncapi-parser` is a **hard dependency** (FMT-1.3, #5414): its exact
pin lives in the toolchain manifest `apiome-rest/toolchain/package.json`, which the container
build installs from and CI installs from, and it has no build arg — so no build can quietly
ship a parser the runtime never verified. See
[Required tools & the startup self-check](#required-tools--the-startup-self-check) below.

| Key | Tool | Pinned | Runtime | Installed by |
|-----|------|--------|---------|--------------|
| `buf` | Protobuf/gRPC build·lint·breaking | `1.72.0` — floor for Protobuf Edition 2024 (FMT-3.7) | native | GitHub release binary |
| `tsp` | TypeSpec compiler (`@typespec/compiler`) | `0.65.0` | node | npm into tools prefix + wrapper |
| `smithy` | Smithy IDL build·validate | `1.53.0` | jvm | GitHub CLI zip (bundles its own runtime) |
| `drafter` | API Blueprint → JSON | `4.0.0` | native | built from source (pinned tag) |
| `amf` | AML Modeling Framework (RAML/OAS) | `5.7.1` | jvm | MuleSoft Nexus assembly jar + `java -jar` wrapper |
| `asyncapi` | AsyncAPI validate·convert·diff (`@asyncapi/cli`) | `2.16.0` | node | npm into tools prefix + wrapper |
| `asyncapi-parser` **(required)** | AsyncAPI parse·validate·dereference → canonical JSON (`@asyncapi/parser`, MFI-8.1) | `3.6.0` — pinned in `toolchain/package.json` | node | npm from the toolchain manifest + Node wrapper (`toolchain/asyncapi-parse.mjs`) |
| `asyncapi-diff` | AsyncAPI diff → breaking/non-breaking/unclassified (`@asyncapi/diff`, MFI-8.4) | `0.5.0` | node | npm into tools prefix + Node wrapper (`toolchain/asyncapi-diff.mjs`) |
| `rover` | Apollo GraphQL schema CLI | `0.27.0` | native | GitHub release tarball |
| `graphql-inspector-diff` | GraphQL diff → breaking/dangerous/non-breaking (`@graphql-inspector/core`, MFI-10.5) | `6.2.0` | node | npm into tools prefix + Node wrapper (`toolchain/graphql-inspector-diff.mjs`) |
| `spectral` | OpenAPI/AsyncAPI lint (`@stoplight/spectral-cli`, CLX-2.2) | `6.16.1` | node | npm into tools prefix + wrapper |
| `vacuum` | OpenAPI lint (`daveshanley/vacuum`, CLX-2.2) | `0.29.9` | native | GitHub release tarball |
| `redocly` | OpenAPI lint/resolve (`@redocly/cli`, CLX-2.2) | `2.39.0` | node | npm into tools prefix + wrapper |

All thirteen land under `/opt/apiome-tools/bin` (on `PATH`); the JVM/Node tools are thin
wrappers so the runner invokes them by bare name exactly like the native binaries. The
`asyncapi-parser` tool is a small repo-committed Node script (`apiome-rest/toolchain/
asyncapi-parse.mjs`) that imports `@asyncapi/parser`: it reads a document on `stdin` and writes
the validated, `$ref`-dereferenced canonical JSON (plus identity + diagnostics) on `stdout`. It
is driven by the `app.asyncapi_parser` service. The `asyncapi-diff` tool is a sibling Node
script (`toolchain/asyncapi-diff.mjs`) that imports `@asyncapi/diff`: it reads
`{"old": …, "new": …}` (two dereferenced documents) on `stdin` and writes each change's
`breaking`/`non-breaking`/`unclassified` verdict on `stdout`. It is driven by the
`app.asyncapi_diff` service and its breaking-change classifier. The `graphql-inspector-diff`
tool is a third Node script (`toolchain/graphql-inspector-diff.mjs`) that imports
`@graphql-inspector/core` (+ its `graphql` peer): it reads `{"old": …, "new": …}` (two SDL
strings) on `stdin`, builds each into a `graphql-js` schema, and writes each change's
`BREAKING`/`DANGEROUS`/`NON_BREAKING` verdict on `stdout`. It is driven by the
`app.graphql_diff` service and its breaking-change classifier. Spectral, Vacuum, and Redocly
back the CLX-2.2 OpenAPI validation packs (`app.openapi_validation_pack`).
`oasdiff` backs CLX-2.3 independent OpenAPI compatibility evidence
(`app.openapi_compatibility_adapters`); `openapi-changes` is an optional HTML
renderer and is not required in the image.

## Footprint

Approximate added image size over the base `python:3.12-slim` runtime (amd64; the tools tree
plus the JRE the AMF wrapper needs — smithy ships its own runtime, so no extra JRE for it):

| Component | Approx. size |
|-----------|-------------:|
| `default-jre-headless` (for AMF) | ~140 MB |
| `smithy` CLI (self-contained runtime) | ~80 MB |
| `amf` assembly jar | ~60 MB |
| `tsp` + `asyncapi` + `@asyncapi/parser` + `@asyncapi/diff` + `@graphql-inspector/core` + spectral + redocly (node_modules) | ~180 MB |
| `buf` | ~30 MB |
| `vacuum` | ~25 MB |
| `rover` | ~30 MB |
| `drafter` | ~5 MB |
| **Total added** | **~480 MB** |

The build-time `tools` stage also pulls `cmake`/`build-essential`/`git` to compile drafter,
but that toolchain stays in the builder stage and is **not** copied into the runtime image.

If the footprint is unacceptable for a deployment, the same `BUNDLED_TOOLS` declarations work
unchanged when the tools live in a **sidecar**: point each `APIOME_<TOOL>_BIN` at the
sidecar mount, or omit a tool entirely and accept its format degrading to "unavailable".

## Required tools & the startup self-check

`REQUIRED_TOOL_KEYS` in `src/app/toolchain_selfcheck.py` names the tools this runtime treats as
**hard dependencies**. Today that is exactly one:

| Key | Why it cannot be optional |
|-----|---------------------------|
| `asyncapi-parser` | The AsyncAPI adapter has no fallback parser — there is no pure-Python AsyncAPI 2.x/3.x parser behind it — and AsyncAPI is a shipped, documented, fixture-covered format. Losing it is losing a product surface. |

At startup `app.main` calls `enforce_toolchain_selfcheck()`, which:

1. resolves every bundled tool and **invokes** each required one, logging the version it
   reported (`bundled toolchain: asyncapi-parser resolved (asyncapi-parse (apiome)
   @asyncapi/parser 3.6.0), pinned 3.6.0`);
2. warns when the reported version disagrees with the pin — the tool still runs, but the image
   installed something other than what it declares;
3. **raises** `ToolchainUnavailableError` when a required tool is missing or not invocable and
   this deployment enforces the toolchain, so the service refuses to start rather than serving
   with a shipped format silently gone. Without enforcement it logs an `ERROR` naming the lost
   formats and starts anyway — degraded, never silent.

Enforcement is `APIOME_REQUIRE_TOOLCHAIN` (`settings.enforce_bundled_toolchain`): unset it
follows `APIOME_ENV`, so a production deployment fails fast and a developer laptop keeps
working. The shipped image sets it to `1`.

Run the same check by hand — it is what CI uses as an explicit gate:

```bash
uv run python -m app.toolchain_selfcheck        # exits 1 when a required tool is unusable
```

The build proves the same thing before the image is finished: the Dockerfile pipes a tiny
AsyncAPI document through `asyncapi-parser` and fails the build unless it comes back `ok`.

### Keeping the hard pin in sync

`toolchain/package.json` → `BUNDLED_TOOLS` → Dockerfile must agree.
`tests/test_toolchain_selfcheck.py` asserts all three: the manifest exists, its pins are exact
(no ranges), each matches the `BundledTool.version`, and the Dockerfile installs from the
manifest instead of re-pinning the package itself.

## Optional / lazy — the "format unavailable" path

Every tool *except* the required ones above is optional by construction:

* **Resolution is lazy.** `probe_tool(key)` / `probe_all()` only do a `PATH`/override lookup —
  no subprocess — so an absent tool is reported as `available: false` cheaply.
* **A missing optional binary never crashes the service.** At call time the runner raises
  `ToolNotAvailableError`; before calling, an adapter can `probe_tool(...)` and skip straight
  to a "format unavailable" status. (A missing *required* tool is the opposite: the startup
  self-check refuses to boot — that is the point of the distinction.)
* **Overrides.** Set `APIOME_<KEY>_BIN` (e.g. `APIOME_BUF_BIN`) to an absolute path
  to use a custom/sidecar binary instead of the bundled one. This works for required tools too:
  pointing `APIOME_ASYNCAPI_PARSER_BIN` at a sidecar satisfies the self-check.

## Operator surface

`GET /health` (unauthenticated, the compose healthcheck) carries the compact verdict — enough
to see a deployment lost a format. Availability only: no resolved paths and no third-party
versions, because the endpoint is anonymous and rate-limit exempt.

```jsonc
{
  "status": "healthy",
  "database": "connected",
  "toolchain": {
    "status": "ok",            // ok | degraded | failed
    "enforced": true,
    "required": 1,
    "available": 1,
    "missing": []
  }
}
```

`GET /v1/ops/toolchain` (platform-admin) returns the full picture — each tool's pinned version,
availability, whether it is required, and which registered formats it gates:

```jsonc
{
  "summary": { "total": 15, "available": 15, "unavailable": 0,
               "required": 1, "required_missing": [],
               "toolchain_status": "ok", "enforced": true },
  "tools": [
    { "key": "buf", "pinned_version": "1.72.0", "runtime": "native",
      "available": true, "resolved_path": "/opt/apiome-tools/bin/buf",
      "override_env": "APIOME_BUF_BIN", "detail": "resolved to /opt/apiome-tools/bin/buf",
      "required": false, "gated_formats": ["connectrpc", "grpc"] },
    { "key": "asyncapi-parser", "pinned_version": "3.6.0", "runtime": "node",
      "available": true, "required": true, "reported_version": "3.6.0",
      "gated_formats": ["asyncapi"] }
    // …
  ]
}
```

`gated_formats` is read from the live import-source and emitter registries, so a new adapter
that declares `required_tools` appears here with no edit to the packaging layer.

Add `?verify=true` to additionally invoke each available tool's `--version` probe and confirm
it actually runs (one subprocess per available tool, so it is slower).

## Keeping versions in sync

1. Edit the `version=` field of the relevant `BundledTool` in `toolchain_packaging.py`.
2. Edit the matching `ARG <TOOL>_VERSION` default in `Dockerfile` — except for a **required**
   tool, whose pin lives in `toolchain/package.json` and has no build arg.
3. Update the table above.

The Python pin is authoritative for what the *runtime reports*; the Dockerfile pin is what is
*installed*. A mismatch does not break anything (the tool still resolves and runs), but the
reported `pinned_version` would then be misleading — so keep them aligned.
