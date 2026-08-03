# Snippet service (SDK-2.3, #4487)

Per-operation usage snippets — an install line plus runnable call code — rendered
server-side from the persisted canonical model. This service is the **single source of
truth** for snippets: the browse operation pages (SDK-3.3) and the Try It copy-as-code
feature (SIM-3.5) consume it instead of hand-rolling their own generators, so snippets
can never drift between surfaces.

Modules:

- `app.snippet_render` — pure rendering (no FastAPI/db imports): operation lookup,
  deterministic request synthesis, escaping, and the three language renderers.
- `app.snippet_routes` — the two HTTP surfaces described below.

## Endpoints

### Authenticated

```
GET /v1/versions/{tenant_slug}/{project_id}/{version_record_id}/snippets/{operation_id}?lang=
```

JWT or API key. Follows the sibling agent-outputs API conventions: the URL `tenant_slug`
is decorative (the token's `tenant_id` scopes every read, so cross-tenant ids resolve to
404), `project_id` and `version_record_id` are UUIDs, and only **published** revisions are
eligible (400 otherwise). Canonical content comes from
`app.canonical_persistence.load_canonical_api`; a published revision with no persisted
canonical artifact has no operations, so every lookup is a 404.

### Anonymous (browse)

```
GET /v1/browse/tenants/{tenant_slug}/projects/{project_slug}/versions/{version_slug}/snippets/{operation_id}?lang=
```

No authentication, slug-addressed, for the public browse surface. Resolves through
`app.export_source.load_public_export_source`, so private, draft, and unknown versions
are one uniform 404 (the route can never confirm a hidden artifact exists). Shares the
MFX-7.3 public-export per-IP rate limit (429 when exceeded). The response echoes the
resolved slug coordinates (`tenant_slug`, `project_slug`, `version_slug`,
`version_record_id`, `version_label`), mirroring the public export responses.

## Languages

| `lang` value | Renders | Install line |
| --- | --- | --- |
| `ts` | JavaScript/TypeScript `await fetch(...)` | `null` (fetch is built in) |
| `python` | `httpx.request(...)` | `pip install httpx` |
| `curl` | one-line `curl` command | `null` |

The browse Try It vocabulary is accepted as aliases: `fetch` → `ts`, `httpx` → `python`.
The response's `lang` field always echoes the canonical value. `lang` is required
(missing → 422 from validation); an unknown value is a 400 listing the accepted values.

## Operation addressing

`{operation_id}` matches operations in declaration order, comparing per operation with
precedence:

1. `extras["operationId"]` (the source operationId, when the format declares one),
2. the canonical operation `name`,
3. the canonical `key` (e.g. `GET /pets/{id}`).

`operation_id` is declared as a `:path` route parameter and the lookup URL-unquotes the
requested id, so canonical keys containing spaces and slashes are addressable
(`GET%20/pets/%7Bid%7D`) by paradigms that have no operationId. No match is a 404.
Operations without an HTTP binding (gRPC/GraphQL/event operations) are a 422 — no snippet
is defined for them.

## Request synthesis

Synthesis is fully deterministic (fixed defaults, seed-0 instance synthesis), so repeated
renders are byte-identical and both routes serve content-addressed strong `ETag`s with
`If-None-Match` → 304 support (`Cache-Control: private/public, max-age=300`).

- **Server** — the first declared server; URL template variables substitute their
  declared default, else an `UPPER_SNAKE` placeholder. A model with no servers falls back
  to `https://api.example.com` (recorded as a `server` placeholder).
- **Path parameters** — declared default, else `UPPER_SNAKE(name)` (`{petId}` → `PET_ID`).
- **Query parameters** — required ones only; credential-named ones (`api_key`, `token`, …)
  render `$`-tokens, others default-or-`UPPER_SNAKE`.
- **Headers** — required header parameters (credential-named ones render `$`-tokens),
  plus `Content-Type` when a body is emitted (the first JSON-ish declared content type
  wins).
- **Body** — the first request-role message's inline `payload_schema` (or its named
  `payload` type projected via `app.canonical_json_schema.build_ref_json_schema`),
  reduced to the minimal valid instance by `app.schema_instance_synthesis`. Non-JSON
  content types and unusable schemas degrade to a body-less snippet rather than failing.

## Secret placeholders

Name-based inference over declared parameters, in lockstep with
`apiome-browse/lib/tryit/secrets.ts` (change one, change the other):

- Header names matching `authorization | proxy-authorization | x-api-key | api-key |
  x-auth-token | x-access-token` render `$AUTHORIZATION` / `$API_KEY` / `$ACCESS_TOKEN` /
  `$SECRET`.
- Query names matching `api_key | apikey | access_token | token | key` render `$API_KEY` /
  `$ACCESS_TOKEN` / `$SECRET`.

**Known limitation:** the canonical model does not record security schemes (the OpenAPI
normalizer does not preserve `security`), so auth material appears only when an operation
*declares* a credential-named header/query parameter. Consumers that know the spec's
security schemes (e.g. Try It's SIM-3.6 auth helpers) can substitute scheme-aware values
into the structured `request` — the placeholder tokens are identical on both sides.

## Response shape

```json
{
  "lang": "curl",
  "install": null,
  "code": "curl 'https://api.pets.dev/v1/pets/PET_ID' -H 'X-API-Key: $API_KEY'",
  "operation": {
    "operation_id": "getPet",
    "name": "getPet",
    "key": "GET /pets/{petId}",
    "method": "GET",
    "path": "/pets/{petId}"
  },
  "request": {
    "method": "GET",
    "url": "https://api.pets.dev/v1/pets/PET_ID",
    "headers": { "X-API-Key": "$API_KEY" },
    "body": null
  },
  "placeholders": [
    { "token": "PET_ID", "kind": "path", "name": "petId", "location": null },
    { "token": "$API_KEY", "kind": "secret", "name": "X-API-Key", "location": "header" }
  ]
}
```

`request` and `placeholders` exist so consumers can substitute real values (or re-render
with user input) without parsing `code`. The anonymous surface adds the slug-coordinate
fields listed above.

## Origin note

The original SDK-2.3 scope derived snippets from the SDK-2.1/2.2 client-generator
templates. Those tickets (#4482–#4486) were closed as not-planned, so snippets render
directly from the canonical spec instead — matching the shape the client-side Try It
generators already produce, which keeps the "matches what you'd actually run" guarantee
without a generator package.
