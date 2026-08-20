# AsyncAPI Import Source (MFI-8.5)

> **Status:** `ImportSource` adapter — `src/app/asyncapi_import_source.py`
> **Issue:** [#3763](https://github.com/objectified-project/objectified/issues/3763) ·
> **Epic:** MFI-EPIC-8 (#3723) · **Roadmap:** `docs/ROADMAP_MULTI_FORMAT_IMPORT.md`

The [`ImportSource`](./import_source_spi.md) adapter (MFI-1.1) that makes the AsyncAPI pipeline
of MFI-8.1…8.4 reachable from the **UI source card** and the **CLI `import` command**. Like the
reference [OpenAPI adapter](./import_source_spi.md) it is a thin seam over machinery that
already exists — it adds *no* new parsing, mapping, or scoring logic:

```
 AsyncApiImportSource
   ├─ detect()    asyncapi version marker → asyncapi-2 / asyncapi-3   (cheap YAML/JSON sniff)
   ├─ parse()     @asyncapi/parser (MFI-8.1) → validated, dereferenced canonical JSON
   ├─ normalize() registered AsyncApiNormalizer (MFI-8.2) → CanonicalApi (paradigm EVENT)
   ├─ lint()      lint_asyncapi_result (MFI-8.3) → score / grade / fingerprint (+ Spectral)
   └─ fingerprint()/diff()  canonical-model defaults (the MFI-8.4 breaking overlay layers on the diff)
```

Registering the adapter (`register=True`) is **all the UI and CLI need**. Both surfaces are
data-driven off the [import-source registry](./import_source_spi.md) (`GET /v1/import/sources`):

* **UI** — the source-card grid merges every registry descriptor, so an `asyncapi` card with the
  `radio` icon, the *event* paradigm, and file/url/paste inputs appears with no UI change.
* **CLI** — `apiome import --list` enumerates the registry and `apiome import asyncapi
  <input>` dispatches through the generic adapter-import path (MFI-1.4) with no new command code.

## Detection

`detect()` recognizes both families by their `asyncapi` version marker — `2.x` → `asyncapi-2`,
`3.x` → `asyncapi-3` — reading the already-parsed `document` when present, else loading `text`
with the cheap YAML/JSON loader (no Node subprocess). A malformed or non-AsyncAPI document is
simply not a match; detection never raises.

## Async parser over a synchronous SPI seam

The `ImportSource` SPI's `parse()` is **synchronous**, but the authoritative `parse_asyncapi`
(MFI-8.1, `src/app/asyncapi_parser.py`) is a coroutine that drives a Node subprocess, and the
import pipeline ([`run_adapter_import_job`](./import_source_spi.md)) calls `parse()` from the
service's **running event loop** (where `asyncio.run` is illegal). The adapter therefore runs the
parse to completion on a **dedicated worker thread** with its own event loop
(`_parse_on_worker_loop`). A fresh sibling `ToolchainRunner` — mirroring the shared runner's
concurrency/timeout/policy configuration — is constructed *inside* that loop, so its
`asyncio.Semaphore` binds to the worker loop rather than the (different) service loop. The parse
is bounded (a single event document) and the in-process adapter path is preview-only, so the
brief block this puts on the calling loop is acceptable; a format with genuinely heavy parsing
would move to its own subprocess worker (see `import_source_pipeline.py`).

An invalid document (validation errors from the parser) becomes a clean `ImportSourceError`, so
the job fails with a user-facing message rather than a stack trace; an *advisory*-only document
(warnings/hints) parses successfully and its findings flow into the lint score.

## The parser is a hard dependency (FMT-1.3, #5414)

`required_tools = ("asyncapi-parser",)` used to mean "this format degrades to *unavailable* when
the Node toolchain is absent". It now means more than that: `asyncapi-parser` is listed in
`app.toolchain_selfcheck.REQUIRED_TOOL_KEYS`, so a deployment that cannot run it **refuses to
start** (or, with `APIOME_REQUIRE_TOOLCHAIN=0`, starts with a loud `ERROR` and reports the format
as missing on `GET /health`). There is deliberately no pure-Python fallback parser — see
[the fallback policy](../../docs/guide/import-a-spec.md#the-fallback-policy-stated) for why a
reduced-capability parse was rejected. The exact `@asyncapi/parser` pin lives in
`apiome-rest/toolchain/package.json` and is installed by the container build and by
`scripts/install_dev_toolchain.sh`.

Because the parser is now present in CI, the AsyncAPI corpus fixtures run their full
detect → parse → normalize → fingerprint → lint pipeline against checked-in golden snapshots
(`tests/golden/corpus/asyncapi/`) and their round-trip matrix rows execute instead of skipping.

## Normalize & lint

`normalize()` accepts either the `AsyncApiParseResult` `parse()` returns or a bare dereferenced
`dict` (the latter keeps the adapter unit-testable without the Node toolchain). It detects the
family and delegates to the registered [`AsyncApiNormalizer`](./normalizer_spi.md) (MFI-8.2).
Per-channel failures are isolated: a broken channel is kept with
`extras.status = "parse_error"` so sibling channels still import (REPO-3.3 / #2772).

On a non-dry-run catalog import, `persist_adapter_import` also:

1. promotes each message `payload_schema` / headers into designer `classes` rows and stores
   `payload_class_id` / `headers_class_id` on the message `extras`;
2. persists the full `CanonicalApi` into the MFI-2.2 tables (`api_artifacts`, `api_channels`,
   `api_operations`, `api_messages`, …) via [`canonical_persistence`](../src/app/canonical_persistence.py).

`lint()` folds the `spectral:asyncapi` diagnostics the parser already produced into the score via
[`lint_asyncapi_result`](./asyncapi_lint.md) (MFI-8.3) when the parse result is on hand (the
normal import flow, where one adapter instance is driven parse → normalize → lint). With no
stashed parse result it degrades gracefully to the engine default — the always-on common pack
plus the registered native AsyncAPI rules — so a revision is always rolled up to a deterministic
score / grade / `report_fingerprint`.

## Fixtures

The committed `tests/fixtures/asyncapi/` suite covers the three baseline versions —
`streetlights_2.6.yaml` (2.6), `user_events_3.0.yaml` (3.0), `account_3.1.yaml` (3.1) — plus an
`invalid_missing_version_3.0.yaml` and a `not_asyncapi.json`. The adapter's end-to-end test class
(`TestRealParser` in `tests/test_asyncapi_import_source.py`) drives parse → normalize → lint over
them, **gated** on the bundled `asyncapi-parser` tool being resolvable (it ships in the image /
via `APIOME_ASYNCAPI_PARSER_BIN`). The detect/normalize/lint/error paths are covered without
the tool using dereferenced inline documents and a monkeypatched parser.

## Tests

`tests/test_asyncapi_import_source.py` — descriptor + registry registration, v2/v3 detection,
normalize of inline v2/v3 documents (+ determinism and error boundaries), lint with and without a
stashed parse result, the parse bridge + error mapping (monkeypatched parser), and the gated
real-parser suite over the 2.6/3.0/3.1 fixtures.
