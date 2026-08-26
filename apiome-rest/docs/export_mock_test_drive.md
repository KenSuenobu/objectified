# Export test-drive mocks (MFX-44.5)

*"Test the format" at its strongest: hit a live mock of the exported API.*

The Mock Server (#3615, RC1-2.2) already knows how to serve an OpenAPI document — it freezes one
into `apiome.mock_instances.spec` and replays schema-shaped responses from it on the public data
plane at `/v1/mock/{mock_id}/…`. What it could not do was start from an **emitted** artifact: its
only provisioning path requires a *published version*, and an export under review has neither.

This surface is that binding. It is deliberately **not a second mock engine**: it provisions rows
the existing engine serves, with a shorter lifetime and its own guardrails.

```
POST /v1/export/{tenant}/mock   ──▶  emit(source, target, options)
                                     ──▶  freeze document into mock_instances (TTL in minutes)
                                     ──▶  { baseUrl: /v1/mock/{id}, operations, expiresInSeconds }

GET  /v1/mock/{id}/widgets      ──▶  the existing data plane, unchanged
```

## Endpoints

| Route | What it does |
|---|---|
| `GET /v1/export/{tenant}/mock/capability` | Can this server mock, and within what bounds |
| `POST /v1/export/{tenant}/mock` | 201 — provision a mock from an emitted artifact |
| `GET /v1/export/{tenant}/mock` | The tenant's **live** test-drive mocks |
| `GET /v1/export/{tenant}/mock/{id}` | One instance: fresh countdown + request count |
| `GET /v1/export/{tenant}/mock/{id}/requests` | The retained request log |
| `DELETE /v1/export/{tenant}/mock/{id}` | 204 — tear it down early |

All six are tenant-scoped (JWT or API key). An instance is reachable here only when it is *this*
tenant's **and** carries the test-drive origin marker — a hosted mock is managed on `/v1/mocks/…`,
not through this surface, and vice versa.

### Provisioning

```http
POST /v1/export/acme/mock
Content-Type: application/json

{ "artifact": "<project-id>", "version": "1.0.0", "target": "openapi", "ttlMinutes": 30 }
```

The emit is re-run **server-side** from the source revision — the emitted document is never
uploaded. The mock therefore provably serves what that revision emits for those options, and a
caller cannot mint a mock of arbitrary bytes.

Refusals are typed:

| Status | When |
|---|---|
| `400` | Unknown target, or a format the mock engine cannot serve |
| `404` / `422` | The source revision cannot be loaded (the loader's own status) |
| `409` | The workspace already holds the maximum number of live test-drive mocks |
| `413` | The emitted document exceeds `export_mock_max_document_bytes` |
| `422` | The emit produced no single structured document with paths to serve |
| `503` | Mocking is unavailable on this server |

### Which targets can be mocked

Derived from the emitter registry, not from a hand-kept list: every registered emitter whose
registry `format` starts with `openapi` or `swagger` qualifies (see
`app.export_mock.MOCK_SERVABLE_FORMAT_PREFIXES`). A new OpenAPI-family emitter is mockable the day
it registers, and the Export Studio reads the list from `…/mock/capability` rather than deciding
for itself — so no UI change is needed either.

### Lifetime

* **Auto-teardown.** Every instance carries an `expires_at` in the minutes band. Past it, the data
  plane answers `410 Gone`, exactly as it does for a hosted mock.
* **Explicit teardown.** `DELETE` frees the URL, the concurrency budget and the request log.
* **Reaping.** A provision first deletes *this tenant's lapsed test-drive rows*, so a minutes-scale
  mock does not litter the table. It never touches a live row or a hosted mock, and a failed delete
  never blocks the new mock.
* **The cap** counts live test-drive instances only, so an expired one never blocks a new start. It
  is a courtesy guardrail against a runaway loop, not a licence boundary: the read-then-count is
  not transactional.

## The request log

`GET …/mock/{id}/requests` returns what the mock served, newest first — method, path, status,
whether an operation matched, the scenario in force, whether the body agreed with the response
schema, and how long it took.

**Scope.** Like the rate limiter it sits beside (`app.rate_limit`), the log is an **in-memory,
per-replica ring buffer** — bounded per instance and bounded in the number of instances tracked. It
is a live view of a mock that expires in minutes, not a durable audit trail, and it deliberately
adds no database write to the data plane's hot path. A horizontally scaled deployment would show
each replica its own slice; the lifetime request count on the instance (`requestCount`) is the
authoritative total, and the log reports `truncated` when it has fallen behind it.

## Configuration

| Setting | Env var | Default |
|---|---|---|
| `mock_server_enabled` | `APIOME_MOCK_SERVER_ENABLED` | `true` |
| `export_mock_enabled` | `APIOME_EXPORT_MOCK_ENABLED` | `true` |
| `export_mock_default_ttl_minutes` | `APIOME_EXPORT_MOCK_DEFAULT_TTL_MINUTES` | `30` |
| `export_mock_max_ttl_minutes` | `APIOME_EXPORT_MOCK_MAX_TTL_MINUTES` | `240` |
| `export_mock_max_per_tenant` | `APIOME_EXPORT_MOCK_MAX_PER_TENANT` | `3` |
| `export_mock_max_document_bytes` | `APIOME_EXPORT_MOCK_MAX_DOCUMENT_BYTES` | `2097152` |
| `export_mock_request_log_size` | `APIOME_EXPORT_MOCK_REQUEST_LOG_SIZE` | `50` |

Two switches gate the feature, and `…/mock/capability` names which one is down: `mock_server_enabled`
(no engine to bind to) and `export_mock_enabled` (the binding itself). Either being off makes the
capability report `available: false` with a reason, and every other route answer `503` — which is
how the Export Studio knows to hide or disable its Test-drive panel instead of offering a control
that cannot work.

## Related

- `mock_routes.py` — the engine's management + data planes (#3615)
- [../../docs/guide/portable-mock-runtime.md](../../docs/guide/portable-mock-runtime.md) — the
  offline mock runtime (PMR)
- [emitter_spi.md](emitter_spi.md) — the emitter registry the target list is derived from
