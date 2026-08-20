# Tyk API definitions — `tyk`

Fixtures for the Tyk sub-format of **FMT-7.5** ([#5459](https://github.com/apiome/apiome/issues/5459)).
Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Two forms.**

| Form | Detection marker | Where the routes are |
| --- | --- | --- |
| Classic | top-level `api_id` + `proxy.listen_path` + `version_data` | `version_data.versions.*.extended_paths.white_list[].path` with `method_actions` |
| Tyk OAS | an OpenAPI document carrying `x-tyk-api-gateway` | the OpenAPI `paths` themselves; the extension carries gateway behaviour keyed by `operationId` |

The OAS form is the important detection case: it is a **real OpenAPI document**, so the adapter must
claim it only because of the `x-tyk-api-gateway` extension — the same non-greedy rule the AWS adapter
follows.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-classic.json` | minimal | Keyless API, one listen path, unversioned. |
| `02-typical-classic-with-paths.json` | typical | Auth token, `white_list` paths with per-method actions, cache and hard-timeout path rules, a global rate limit. |
| `03-composition-versions-and-middleware.json` | composition | **Two versions** selected by header with an expiry on the old one, `white_list`/`black_list`/`ignored`, `validate_json` with a JSON Schema, `url_rewrites`, per-version headers, custom middleware chain. |
| `04-stress-oas-extension.json` | stress | The **Tyk OAS** form: an OpenAPI 3 document plus `x-tyk-api-gateway` with upstream load balancing, uptime tests, JWT authentication, global CORS/cache/header middleware, and per-operation cache, rate limit, validation, rewrite, mock and circuit breaker. |
| `05-real-world-payments-classic.json` | real-world | A production payments API: OAuth2 client credentials, load-balanced targets with uptime tests, request validation, per-path timeouts, a circuit breaker, CORS and header stripping. |
| `06-typical-graphql-proxy.json` | typical | A GraphQL proxy definition carrying its SDL inline — the paradigm switch a route importer must notice. |
| `07-policies-set/` | multi-file | An API definition plus the policies file that carries its quotas and per-URL access rights. |
| `negative/` | — | Missing comma, an API with no `listen_path`, truncation, a **Kong** declarative config (the neighbouring gateway), UTF-16, and a versioned API whose `versions` map is empty. |

**Credential rule.** Every secret-shaped field here (`shared_secret`, `oauth_on_keychange_url`) is
empty; the fixtures carry nothing to scrub, but the scrub gate must still be asserted.
