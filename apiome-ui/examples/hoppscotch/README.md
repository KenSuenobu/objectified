# Hoppscotch collections — `hoppscotch`

Fixtures for **FMT-10.1** ([#5473](https://github.com/apiome/apiome/issues/5473)). Hoppscotch is the
open-source client teams choose when they leave Postman; it imports from OpenAPI, Postman, Insomnia
and HAR, and Apiome cannot read its collection JSON at all. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection markers.** A top-level `v` (collection schema version) with `name`, `folders[]` and
`requests[]`, where each request carries `endpoint`, `method`, `params`, `headers` and an `auth`
object with `authType`. Variables are `<<doubleAngle>>`, not `{{curly}}` — the quickest way to tell a
Hoppscotch collection from a Postman one.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-collection.json` | minimal | One GET, no auth, no variables. |
| `02-typical-orders-collection.json` | typical | Four requests, active and **inactive** params, collection-level bearer auth inherited by every request, request variables, a test script. |
| `03-environment-set/` | multi-file | Collection plus its environment file — `<<baseUrl>>` and `<<apiKey>>` only resolve across the set. |
| `04-stress-auth-and-bodies.json` | stress | Every body kind (raw JSON, urlencoded, multipart with a file part, GraphQL), every auth type (`inherit`, `basic`, `api-key` in query, `oauth-2` client credentials), folders nested two deep, disabled headers, pre-request and test scripts. |
| `05-real-world-payments-collection.json` | real-world | A vendor sandbox: an auth folder that captures a token into the environment, an idempotency key generated per request, three feature folders. |
| `06-typical-nested-folders.json` | typical | Folders inside folders → operation groups. |
| `07-composition-inherited-auth.json` | composition | Auth and header inheritance down two folder levels, with a request-level override. |
| `negative/` | — | Missing brace, a collection with no requests anywhere, truncation, a **Postman v2.1** collection, UTF-16, and requests with an empty endpoint and an unresolvable variable. |

**Credential rule.** Every credential-shaped value is `""` or a `<<variable>>`; the environment marks
`apiKey` with `"secret": true`. FMT-10.1 still requires the scrub gate to be asserted — a saved
Hoppscotch request *can* carry a literal token, and it must never be persisted.
