# One mock engine

Apiome shipped two mock implementations. They described the same product concept — "serve my API
before it exists" — under two scenario schemas, in two storage homes, with two resolvers. A feature
built in one was invisible in the other, and correlation, templates and stateful CRUD would have had
to be written twice to reach every surface.

**apiome-mock is the engine.** The in-REST one is deleted. This page is what changed, what it means
for stored configuration, and what a deployment now has to be able to reach.

| | |
|---|---|
| Ticket | MSC-2.2 (#5532) |
| Surviving engine | `apiome_mock.handler.serve_compiled_request` |
| Retired | `app.mock_engine`, `app.mock_data_generator`, the in-REST `data_router` resolver |
| Migration | `apiome-db/scripts/V250__mock_instance_engine_fold_5532.sql` + `app.mock_instance_config` |
| Operator backfill | `apiome-rest/scripts/fold_mock_instance_configs.py` |

---

## What each engine was

**In-REST (RC1-2.2, #3615)** served `/v1/mock/{id}/…` — the short-lived *sandbox* instances the
hosted Mock Server and the Export Studio's test drive provision — from the `mock_instances` table.
Scenarios were a **list** with `rules`; four built-ins shipped (`happy-path`, `server-error`,
`not-found`, `slow`); `active_scenario` selected among them. It had no templates, no match
predicates, no stateful CRUD, no fixture packs, no chaos, and no non-HTTP transports.

**apiome-mock (SIM + PMR)** served `/{tenant}/{project}/{version}/…` and portable bundles from
`versions.mock_settings`. Scenarios are a **dict keyed by name** with per-operation overrides, `when`
match predicates, `{{ }}` templates, stateful CRUD over a session store, fixture packs, chaos
injection, gRPC and event transports, portable bundles and a CI parity harness.

They shared exactly three symbols — `MockOperation`, `extract_operations`, `match_operation` — and
reimplemented everything downstream of routing.

## What replaced it

Routing was the shared middle, and it survived under a name that says what it is:
`app.mock_routing`. It is not an engine; it answers "which operation is this request for?" and
nothing else, and both the author-time validators in apiome-rest and the runtime in apiome-mock
resolve through it.

Resolution moved wholesale. A sandbox request now takes one internal hop:

```
   caller
      │  GET /v1/mock/{id}/pets/42
      ▼
 apiome-rest ── does the instance exist? has it expired? is it inside its rate limit?
      │      ── build the instance's portable bundle(spec, folded settings)
      │  POST /__sandbox__              (X-Internal-Service-Token)
      ▼
 apiome-mock ── load_bundle_document() → serve_compiled_request()   ← the data plane's own path
      │
      ▼  { status, headers, mediaType, body, bodyEncoding, operation, scenario, schemaValid }
```

apiome-rest keeps what a **sandbox** is — existence, expiry (`expires_at` → `410 Gone`), the
per-instance rate limit, the request log the Export Studio renders. apiome-mock owns what a **mock**
is. There is no local fallback resolver: a deployment with no `APIOME_MOCK_INTERNAL_BASE_URL` /
`APIOME_MOCK_INTERNAL_TOKEN` answers `503` on the data plane and says so, because inventing an
answer from a second engine is the failure this work removes.

`/__sandbox__` is the sibling of [`/__preview__`](mock-response-preview.md) and differs in the three
ways a real request differs from a dry run: chaos **applies** rather than being reported, session
state **persists** for the sandbox's life, and — unchanged from the retired engine — outbound
callbacks are not dispatched, because a sandbox serves anonymous callers from a frozen artifact.

Session state is held per sandbox, keyed by the instance id, so two sandboxes frozen from the same
version can never read each other's stateful CRUD.

## The built-in scenarios still work

`happy-path`, `server-error`, `not-found` and `slow` are written into client code and CI jobs by
name, so all four are now defined on **every** version, supplied by the runtime and merged into
whatever the version stores. A stored scenario of the same name wins outright — the built-ins are a
floor, never an override, exactly as the retired engine's `normalize_scenarios` resolved the same
collision.

| Name | Behaviour |
| --- | --- |
| `happy-path` | No overrides: every operation answers as it would with no scenario. |
| `server-error` | Every operation returns `500` with `{"error": {"code": "internal_error", …}}`. |
| `not-found` | Every operation returns `404` with `{"error": {"code": "not_found", …}}`. |
| `slow` | Normal responses with 1500 ms of injected latency. |

They also apply to versions that never had a hosted instance. That widening is deliberate: one
engine means one set of names, and a name that works on some versions and not others is the
two-engine split wearing a different hat.

## Two additions to the scenario schema

Expressing the built-ins — and the migrated rules — needed the dict-keyed schema to cover what the
list-shaped one could say. Both additions are available to any authored scenario.

**The wildcard operation key.** `"*"` applies to every operation the scenario does not name
explicitly. An exact key always wins:

```json
{
  "scenarios": {
    "outage": {
      "operations": {
        "*": { "responses": [{ "status": 500, "body": { "error": "down" } }] },
        "GET /health": { "responses": [{ "status": 200, "body": { "status": "ok" } }] }
      }
    }
  }
}
```

A wildcard override covers operations with different response schemas, so its bodies are **not**
checked against the spec at save time; status, media type, headers and template syntax still are.

**The status pin.** An override's `status` pins the response status and leaves the **body to the
spec**, resolved exactly as a request sending `?__status=` resolves it:

```json
{ "operations": { "GET /pets": { "status": 503 } } }
```

This is what "make it fail, with a body that still matches the contract" needs. A canned response
with no body would serve an empty one, and freezing a synthesized body into settings would stop it
tracking the spec. The pin is the weakest layer: a matching rule wins, then a fallback response,
then the pin, then the default spec-driven flow.

## Migrating a stored instance config

`mock_instances.config` — the list-shaped RC1-2.2 configuration — is translated into the
`versions.mock_settings` shape by `app.mock_instance_config`, which is the **one** translator
between the two vocabularies.

| Legacy | Folded |
|---|---|
| `scenarios: [{name, rules}]` | `scenarios: {name: {description, operations}}` |
| `rule.operation` / `rule.method` + `rule.path` | canonical `"METHOD /template"` keys, or `"*"` |
| `rule.status` + `rule.body` | `operations[key].responses[0]` |
| `rule.status` alone | `operations[key].status` (the pin above) |
| `rule.body` alone | a response at the operation's **own** default success status |
| `rule.latency_ms` | scenario-scoped `chaos.default.delayMs` / `chaos.operations[key].delayMs` |
| `active_scenario` | `activeScenario` — the key [MSC-2.1](mock-bundle-format.md) introduced |
| `seed` | carried per request on the sandbox hop (`?__seed=`), not stored |

The translation is **spec-aware**, because three legacy behaviours cannot be reproduced from the
stored shapes alone:

* a body-only rule served the operation's own default success status, which differs per route
  (`201` for a create, `204` for a delete, `200` otherwise);
* precedence was *first matching rule wins per operation*, which inverts in the keyed shape where an
  exact key beats the wildcard — so each operation is resolved against the ordered rule list rather
  than the rules being translated in isolation;
* a rule that matched no operation in the frozen spec did nothing, and saying so is the difference
  between a report and a silent drop.

**Nothing is dropped quietly.** A rule that is unreachable, that matches no operation, that sets
nothing, or whose latency exceeded the 30 s ceiling is reported in `mock_instances.migration_notes`
and surfaced as `migrationNotes` on the instance in `/v1/mocks/…`.

### When the fold happens

V250 adds `settings` and `migration_notes` to `mock_instances` and leaves `settings` NULL, meaning
"not folded yet". Either plane folds a row the first time it reads one and writes the result back,
so no maintenance window is required. To do the whole estate at once — and, more usefully, to read
the report before any traffic arrives:

```bash
cd apiome-rest
uv run python scripts/fold_mock_instance_configs.py --dry-run   # translate and report, write nothing
uv run python scripts/fold_mock_instance_configs.py             # fold every unfolded instance
```

The legacy `config` column is kept, unread, as the pre-fold record: it is what a migrated instance
is diffed against when someone asks whether it still serves the same responses.

## Deployment checklist

* Set `APIOME_MOCK_INTERNAL_BASE_URL` and `APIOME_MOCK_INTERNAL_TOKEN` on apiome-rest, and
  `APIOME_MOCK_INTERNAL_TOKEN` on apiome-mock, if preview (MSC-1.2) had not already required it.
  Without them `/v1/mock/{id}/…` answers `503`.
* `APIOME_MOCK_SANDBOX_TIMEOUT_SECONDS` (default `35`) bounds one sandbox round trip. It sits above
  the 30 s injected-latency cap so a chaos-delayed response is not cut off by the transport.
* `APIOME_MOCK_SANDBOX_MAX_BODY_BYTES` (default `1048576`) caps the request body the data plane
  will carry. Past it the caller gets `413`: the engine reads a body only to evaluate predicates
  and templates against it, so a larger one would cross a service boundary to be ignored.
* Apply V250 and run the backfill script; read the notes it prints.

## See also

* [Mock response preview](mock-response-preview.md) — the sibling internal endpoint.
* [Portable mock bundle format](mock-bundle-format.md) — the unit that crosses the hop.
* [Portable mock runtime](portable-mock-runtime.md) — the same engine, offline.
