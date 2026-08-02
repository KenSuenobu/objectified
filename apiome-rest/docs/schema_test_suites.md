# Saved schema test suites and regression tracking (IXH-5.7, #5119)

A payload validated once (IXH-5.1) is worth keeping. A **suite** persists a named set of
payloads plus expected verdicts, attached to a schema reference that survives revisions;
**runs** execute the suite against one revision, judge every payload, and diff the verdicts
against the previous run so a revision that breaks a previously-passing payload is flagged as
a **regression**.

Modules: `schema_suite_routes.py` (HTTP) → `schema_suite_service.py` (models, judging,
regression, corpus round trip) → `schema_suite_store.py` (persistence door) →
`apiome.schema_test_suite*` tables (apiome-db V240).

## The suite reference

A suite is attached to the version-independent part of the IXH-5.1 grammar:

```
project/{artifact}[/{type}]        catalog/{artifact}[/{type}]
```

Create/import requests accept either the stable form (`project/petstore`) or a full IXH-5.1
reference whose **version segment is discarded** (`project/petstore/1.0.0/Pet` — a three-part
tail is always read as a version, exactly like the 5.1 grammar, so a reference copied from the
Test Bench means the same thing here). To attach a type without caring about a version, write
`project/petstore/latest/Pet`.

`registry/…` is rejected with 400: every capability of this feature is revision-centric, and
registry types have no revisions to track a regression across.

## Endpoints

All under `/v1/tenants/{tenant_slug}`, scoped to the **authenticated** tenant (the URL slug
never scopes anything), gated on the `types` resource like the rest of the 5.x surface:

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /schema-suites` | `types:create` | Create (with optional initial payloads) |
| `GET /schema-suites[?ref=…]` | `types:view` | List, each with its newest run summary |
| `GET /schema-suites/{id}` | `types:view` | Detail with payloads |
| `PATCH /schema-suites/{id}` | `types:edit` | Rename / re-describe |
| `PUT /schema-suites/{id}/payloads` | `types:edit` | Replace-all payloads; bumps `suite_version` |
| `DELETE /schema-suites/{id}` | `types:delete` | Delete suite + history |
| `POST /schema-suites/{id}/runs` | `types:view` | Execute against a revision (see below) |
| `GET /schema-suites/{id}/runs` | `types:view` | Run history, newest first (limit ≤ 100) |
| `GET /schema-suites/{id}/runs/{run_id}` | `types:view` | One run with per-payload results |
| `GET /schema-suites/{id}/export` | `types:view` | IXH-1.1 corpus manifest envelope |
| `POST /schema-suites/import` | `types:create` | Create a suite from such an envelope |

Runs are `types:view` deliberately: a run repeats what the 5.1 validate endpoint already lets
a viewer do — read schemas, check payloads — and the row it leaves behind is history *about*
that read.

## Verdicts and regressions

Each payload carries an IXH-1.1 `validity_class`; the expected verdict derives from it
(`valid` ⇒ must validate, everything else ⇒ must not). Judging mirrors the CLI's
`apiome schema test` exactly:

- **error** — the validate response was not serviceable (`ok: false`) or no validator ran
  (`valid: null`, e.g. XML toolchain absent). No verdict was produced.
- **passed** — the validator's verdict matches the expectation.
- **failed** — it contradicts the expectation.

A run resolves its reference **once** and pins the resolved revision id, so a moving `latest`
cannot split one run across two revisions. An unresolvable reference still records a run
(`status: error`, no results): that the suite could not run against a revision is history the
feature exists to show, not an exception to swallow.

**Regression rule.** Each result is diffed by payload *name* against the suite's most recent
prior **completed** run, whatever revision it targeted (that cross-revision comparison is the
point). `regression = previous_status == 'passed' AND status == 'failed'` — strictly the
verdict flip. `passed → error` is **not** a regression (no verdict was produced, so there is
no evidence the schema broke the payload); it stays visible through `previous_status`. A
renamed payload has no baseline and gets `previous_status: null`. The run-level `regression`
flag is the OR of its results, and the newest run's flag is what the UI badges surface.

## Corpus round trip (IXH-1.1)

`GET …/export` returns `{suite, manifest, files}`: a corpus manifest whose entries carry the
`instance-payload` feature (shaped like the Test Bench's copy-as-fixture, extended with the
suite's validity classes — `valid` ⇒ `expected_outcome: imports`, otherwise `rejects`;
JSON payloads live under `json-schema/test-bench/`, XML under `xsd/test-bench/`), plus each
payload's text. Materialize each `files[*].content` at its `files[*].path` next to a
`manifest.json` holding `manifest` and the set runs in CI unchanged:

```
apiome schema test --schema project/petstore/latest --suite manifest.json
```

`POST …/import` accepts the same envelope (plus `name` and `ref`) and reads it exactly as the
CLI's `--suite` mode does: entries with the `instance-payload` feature become payloads,
`expected_valid = (validity_class == 'valid')`, non-payload entries are ignored. Export →
import round-trips the payload set losslessly, including non-`valid` classes.

## Bounds and retention

Content bounds (friendly 400s, mirrored by V240 CHECKs):

| Setting | Default | Meaning |
|---|---|---|
| `APIOME_SCHEMA_SUITE_MAX_PAYLOADS` | 50 | Payloads per suite (≤ 0 disables the cap) |
| — | 256 KiB | Bytes per payload (fixed, V240 CHECK) |
| `APIOME_SCHEMA_SUITE_RESULT_FINDINGS_CAP` | 20 | Findings persisted per result |

History bounds — runs accrue with traffic, so they are pruned twice over:

| Setting | Default | Meaning |
|---|---|---|
| `APIOME_SCHEMA_SUITE_RUN_MAX_PER_SUITE` | 200 | Prune-on-write: after every run insert, the suite's oldest runs beyond this cap are deleted (≤ 0 disables) |
| `APIOME_SCHEMA_SUITE_RUN_RETENTION_DAYS` | 180 | Age prune on the IXH-6.3 retention tick (≤ 0 keeps runs forever) |
| `APIOME_SCHEMA_SUITE_RUN_KEEP_MIN` | 20 | Newest runs per suite immune to the age prune, so a rarely-run suite never loses its regression baseline |

Result rows follow their run via `ON DELETE CASCADE`; a pruned baseline degrades the next
run's diff to `previous_status: null`, never to an error.
