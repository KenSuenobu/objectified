# SSRF-guarded remote `$ref` resolver (MFI-29.4)

> **Status:** implemented — `src/app/remote_ref_resolver.py` (resolver service),
> `src/app/intake_lint_rules.py` (rule catalogue),
> `src/app/import_source_pipeline.py` (`resolve_intake_remote_refs`, wiring)
> **Issue:** [#4391](https://github.com/apiome/apiome/issues/4391) ·
> **Epic:** MFI-EPIC-29 (#4384) · **Roadmap:** `ROADMAP_MULTI_FORMAT_IMPORT.md`

AsyncAPI dereferences **in-document** `$ref`s only, and the JSON Schema adapter parses a
single mapping — so a document that points at a shared message library or a split schema
bundle by URL imports with a hole in it, silently. Fetching those URLs naively would make
every import an SSRF primitive. This is the one shared service that does it safely.

## Shape

```
intake (single document or fileset)
      │
      ▼  scan every $ref                     (absolute http/https only)
      │
      ├── opt-in off ──▶ report unresolved externals as lint findings, fetch nothing
      │
      └── opt-in on
              ▼  validate URL shape          (ssrf_guard.validate_url_policy)
              ▼  fetch                        (ssrf_guard.build_guarded_client — every
              │                                hop re-validated, redirects included)
              ▼  budgets: refs / depth / bytes / per-fetch timeout / total deadline
              ▼  content-addressed cache      (url → sha256 → parsed document)
              ▼  inline at the $ref node
              │
              └──▶ adapter.parse ──▶ normalize ──▶ fingerprint ──▶ lint
```

Resolution rewrites only **what the adapter parses**. The intake itself is untouched, so
the verbatim source the catalog persists (MFI-23.9) is still exactly what the user
submitted — while the model, and therefore the revision fingerprint, covers the resolved
definitions. Importing a document with its references resolved fingerprints identically to
importing the same document with those definitions already inlined by hand.

## Turning it on

Per import, in `SpecImportOptions`:

```jsonc
{ "options": { "resolve_remote_refs": true } }
```

Default **false** — an import fetches nothing unless it asks to. The option is honored only
by adapters whose descriptor reports `supports_remote_refs` (`GET /v1/import/sources`):
today **AsyncAPI** and **JSON Schema**. A format adds itself by setting
`supports_remote_refs = True` on its `ImportSource` subclass; no other change is needed.

Deployment settings (`APIOME_REMOTE_REF_*`):

| Setting | Default | Meaning |
|---------|---------|---------|
| `RESOLUTION_ALLOWED` | `true` | Kill switch. `false` makes every import behave as if the opt-in were off |
| `MAX_REFS` | `50` | References inlined per import |
| `MAX_DEPTH` | `5` | Nesting depth of chained remote references |
| `MAX_BYTES` | `4 MiB` | Total fetched bytes per import |
| `FETCH_TIMEOUT_SECONDS` | `5` | Per request |
| `TOTAL_TIMEOUT_SECONDS` | `15` | Wall clock for a whole resolution run |
| `CACHE_MAX_ENTRIES` / `CACHE_MAX_BYTES` / `CACHE_TTL_SECONDS` | `64` / `16 MiB` / `900` | Bounds on the process-wide document cache |

Keep `TOTAL_TIMEOUT_SECONDS` below the intake guard's `stageWallClockSeconds` (20s) so the
resolver's own budget is what fires first.

## What counts as remote

| Reference | Root document | Inside a fetched document |
|-----------|---------------|---------------------------|
| `https://host/lib.json#/X` | resolved | resolved |
| `./sibling.yaml#/X` | left alone — the MFI-29.2 fileset bundler's job | resolved against the fetched URL |
| `#/components/schemas/X` | left alone — the adapter dereferences it | addresses the fetched document |
| `file:` / `data:` / `user:pass@` | reported blocked, never fetched | reported blocked, never fetched |

An unresolved reference that came from a **fetched** document is rewritten to its absolute
URL form before it is inlined: copying `./nope.json#/Q` verbatim into the root would
silently re-target it, turning a missing definition into a wrong one.

## Failure is degradation, never a failed import

Nothing the resolver hits fails a job. Each reference that cannot be inlined is left in
place and recorded with a reason:

`resolution-disabled` · `blocked-by-ssrf-guard` · `fetch-failed` · `unparseable-document` ·
`pointer-not-found` · `circular-reference` · `budget-exhausted-{refs,depth,bytes,time}`

Those become:

* **lint findings** on the same report the revision persists —
  `intake.unresolved-external-ref`, or `intake.blocked-external-ref` for a guard refusal.
  Both default to `warning`; a tenant that treats external references as a hard error
  promotes them through its style guide (GOV-1.2) rather than through a code change. They
  are merged before the guide is applied, so overrides and disables govern them normally;
* **job events** — `REMOTE_REFS_RESOLVED` (info), `REMOTE_REFS_UNRESOLVED` (warn),
  `REMOTE_REFS_BLOCKED` (warn);
* a **`remote_refs` block** on the completed job summary: exact counts plus the first 25
  references itemized (`refs_truncated` marks the cut).

A hostile ref-chain therefore terminates on a budget and reports itself, rather than
stalling or crashing the import.

## Cache

`RemoteRefCache` maps a URL to the SHA-256 of the bytes it served, and stores the *parsed*
document under that digest — so two URLs serving identical content share one entry, and a
re-import is a cache hit rather than a re-fetch. It is bounded three ways (entry count,
total bytes, per-entry TTL) so a long-lived process cannot grow without limit, and a
remote library that changes is picked up after its TTL.

## Tests

* `tests/test_remote_ref_resolver.py` — the resolver: scanning, inlining, chained and
  fragment references, every failure reason, all four budgets, the cache (LRU, byte
  ceiling, TTL, content addressing), guard refusals including a redirect to an internal
  address driven through the real guard over an `httpx.MockTransport`.
* `tests/test_import_remote_refs.py` — the pipeline: opted-in vs default imports,
  fingerprint parity with a hand-inlined document, the kill switch, a format that opts out,
  and the intake seam (what is parsed vs. what is persisted).
