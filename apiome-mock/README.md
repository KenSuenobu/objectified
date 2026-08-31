# apiome-mock

FastAPI mock runtime for published Apiome OpenAPI specs.

Public URL shape:

```
https://mock.<host>/{tenant}/{project}/{version}/<spec-path>
```

## Portable mock bundles (PMR-1.1)

A mock bundle is a single signed JSON document that pins a version's spec, mock settings, and
fixture digests, so the same mock can run offline — in CI, on a laptop, or air-gapped:

```python
from apiome_mock.bundle import load_bundle_file

bundle = load_bundle_file("petstore-1.0.0-mock-bundle.json", secret=SHARED_SECRET)
compiled = bundle.to_compiled_spec()   # identical to the database-backed serving unit
```

Export one from apiome-rest with
`GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/bundle`. Loading verifies the
runtime compatibility window, every content digest, the HMAC signature, and that no tenant
credentials are present; incompatibility raises `MockBundleIncompatibleError` with the required
version range. Full format reference: [docs/guide/mock-bundle-format.md](../docs/guide/mock-bundle-format.md).

## Portable runtime (PMR-1.2)

`apiome-mock run` serves one bundle with no database, no network, and no credentials — the same
runtime the official image and `apiome mock run` execute:

```bash
uv run apiome-mock run --bundle petstore-1.0.0-mock-bundle.json      # serve a bundle
uv run apiome-mock verify --bundle petstore-1.0.0-mock-bundle.json   # check it without serving
uv run apiome-mock selftest                                          # prove this build passes the corpus
```

`/health` is liveness and `/ready` is readiness (it reports the served bundle's digest).
Configuration comes only from the flags declared in `apiome_mock/portable_config.py` and their
`APIOME_MOCK_*` environment variables. Every log line is one JSON object.

The **conformance corpus** (`src/apiome_mock/conformance_data/`) is the shared proof that every
deployment behaves identically; run it against any running mock with
`apiome-mock conformance --base-url http://127.0.0.1:8775`. Regenerate the corpus bundle after
editing its spec or settings:

```bash
uv run python scripts/build_conformance_bundle.py           # rewrite
uv run python scripts/build_conformance_bundle.py --check   # verify it is current
```

## Serverless adapter (PMR-1.3)

`apiome_mock/serverless.py` runs the *same* portable app inside a function environment — AWS
Lambda, Google Cloud Run functions, or Azure Functions — by translating the provider's event into
one ASGI call. The bundle is verified and compiled once per execution environment and reused by
every warm invocation, and that cost is measured rather than assumed:

```bash
uv run apiome-mock serverless --provider aws-lambda --bundle petstore-1.0.0-mock-bundle.json
uv run apiome-mock serverless --provider aws-lambda --conformance   # corpus through real events
```

Preflight reports each provider's published package/payload/timeout limits, checks the measured
cold start against the provider's budget, and refuses a bundle carrying a cloud credential (exit
code `7`). Provider limits live as data in `apiome_mock/serverless_providers.py`, so the CLI and
the guide read one table.

Full guide: [docs/guide/serverless-mock-adapter.md](../docs/guide/serverless-mock-adapter.md).

## CI parity and the mock action (PMR-3.1)

`conformance` proves one deployment answers the corpus. **`parity`** proves a hosted deployment and
a portable one *agree*, diffing every response (status, `X-Mock-*`/`Content-Type`/`Allow`/
`Retry-After`, and the body — structurally for JSON). Transport headers and the reserved
`/health` + `/ready` endpoints are excluded by design and reported as skipped; exit code is `6` on
any difference:

```bash
uv run apiome-mock parity \
  --hosted-url https://mock.apiome.dev --hosted-mount /acme/petstore/1.0.0 \
  --portable-url http://127.0.0.1:8775
```

The corpus covers routing, request validation, scenarios and sequences, declarative rules and
templates, chaos, session CRUD and isolation, fixture packs and the `__mock__` reset lifecycle, and
seeded determinism — so parity is asserted across all of it.

To start a pinned runtime inside a CI job (loopback-only URL, reported digests, automatic
cleanup), use the [mock action](../mock-action/README.md).

Full guide: [docs/guide/portable-mock-runtime.md](../docs/guide/portable-mock-runtime.md).

## Release-proof attestation (PMR-3.2)

**`attest`** turns what `verify` and `conformance` proved into the record a release proof attaches:
the immutable bundle digest, this runtime's version and image, the conformance corpus identity
(declared `corpusVersion` plus a content digest) and result, and every fixture-pack digest.

```bash
uv run apiome-mock conformance --base-url http://127.0.0.1:8775 --json > conformance.json
uv run apiome-mock attest --bundle bundle.json --conformance conformance.json --out mock-attestation.json
```

The status is **derived** from the corpus result, so a job cannot record a verified mock over a red
one, and a record is always written: a failing corpus yields `failed` (exit `5`) and no corpus at
all yields `missing` — never silence. The emitted `mock` block is exactly what
`POST /v1/tenants/{tenant}/verification-runs` accepts, and `apiome mock verify-attestation` checks
the server's signed statement offline.

Full guide: [docs/guide/mock-release-attestation.md](../docs/guide/mock-release-attestation.md).

## Declarative matching and templates (PMR-2.1)

Scenario operation overrides may carry ordered **match rules** — request predicates plus the
responses they select. The first rule whose predicates all hold serves its responses, the plain
`responses` list is the fallback, and with neither the request falls through to the default
spec-driven flow:

```json
{
  "GET /pets/{petId}": {
    "rules": [
      {
        "when": {
          "path":   {"petId":  {"equals": "42"}},
          "query":  {"limit":  {"gt": 10, "lte": 100}},
          "header": {"x-tier": {"in": ["gold", "silver"]}},
          "body":   {"/items/0/sku": {"matches": "^SKU-"}}
        },
        "responses": [{"status": 200, "body": {"id": "{{request.path.petId}}"}}]
      }
    ],
    "responses": [{"status": 404}]
  }
}
```

Predicate operators: `equals`, `notEquals`, `contains`, `matches` (bounded regex), `in`,
`exists`, `gt`/`gte`/`lt`/`lte`. `body` keys are RFC 6901 JSON Pointers into the JSON request
body. A response body or header value may embed bounded `{{ ... }}` **templates** over request
fields (`request.method`, `request.path.<name>`, `request.query.<name>`, `request.header.<name>`,
`request.body#/<pointer>`), seeded randomness (`random.int(1, 100)`, `random.float`,
`random.uuid()`, `random.hex(8)`, `random.bool()`, `random.choice('a', 'b')`), and fixture data
(`fixture.<name>#/<pointer>` — bundle fixture payloads or the `mock_settings.fixtures` map).

Random draws are seeded from the `__seed` query parameter, so the same request and seed always
render byte-identical output. Renders run under CPU and output budgets (`template-limits-exceeded`
problem on breach), and the language has no reachable host objects — network, filesystem, and
process access are not expressible. Predicates and templates are validated in apiome-rest when
scenarios are saved; the matched rule is echoed in `X-Mock-Scenario-Rule`.

## Fixture packs and data lifecycle (PMR-2.2)

A **fixture pack** is a named, versioned, digestible unit of deterministic seed data, stored in
`versions.mock_settings.fixturePacks` (and carried inside portable bundles). Its `data` section
feeds template fixtures (`{{fixture.<name>...}}`); its `collections` section seeds the stateful
CRUD session store:

```json
{
  "smoke": {
    "packFormat": "apiome.mock.fixture-pack/v1",
    "packFormatVersion": 1,
    "description": "Two pets.",
    "data": {"pets": [{"id": 1, "name": "Rex"}]},
    "collections": {"/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}]}
  }
}
```

Author packs with `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/fixture-packs`
(apiome-rest validates the schema and returns each pack's `sha256:<hex>` content digest). Every
mock version — hosted or portable — reserves the `__mock__` segment for the data lifecycle
control plane:

```bash
# discover packs and pin their digests
curl $MOCK/demo/petstore/1.0.0/__mock__/fixture-packs

# reset the calling session to a pack (deterministic seed), or to empty without a body
curl -X POST -H "X-Mock-Session: test-1" -H "Content-Type: application/json" \
  -d '{"pack": "smoke"}' $MOCK/demo/petstore/1.0.0/__mock__/session/reset
```

A reset atomically replaces the session's resources *and* scenario sequence counters; the
response echoes the pack name, digest, and seeded resource count. State is namespaced by
tenant + project + version + `X-Mock-Session` token, and a reset can only ever touch the
caller's own namespace — data never crosses tenant, version, or session boundaries. Control
routes bypass scenarios and chaos injection. Full guide:
[docs/guide/mock-fixture-packs.md](../docs/guide/mock-fixture-packs.md).

## Callbacks and webhooks (PMR-2.3)

A **callback definition** is the outbound half of a contract: what the mock sends, where it is
allowed to send it, what the payload must look like, and how it retries. Definitions live in
`versions.mock_settings.callbacks` (and travel inside portable bundles):

```json
{
  "order-created": {
    "callbackFormat": "apiome.mock.callback/v1",
    "trigger": {"operation": "POST /orders", "statuses": [201]},
    "destinations": ["https://hooks.example.com/orders"],
    "request": {"body": {"event": "order.created", "id": "{{request.body#/id}}"}},
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
    "retry": {"maxAttempts": 3, "backoffMs": 100, "retryOn": [503]}
  }
}
```

Author them with `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/callbacks`
(apiome-rest validates the trigger against the version's operations, the schema `$ref` against its
components, and every destination against the SSRF policy, then returns each definition's
`sha256:<hex>` digest).

Each delivery runs four gates and stops at the first failure: the payload **renders** from the
triggering request and fixture data, it is **validated** against `payloadSchema` (a payload that
does not match is never sent), the target is **authorized** against the destination allowlist *and*
the outbound network policy, and only then is it **delivered** on a retry schedule with no jitter
and no clock input — so replaying a fixture-driven event reproduces the attempt timeline exactly.

Outbound delivery is off by default in both runtimes; `--callbacks` (portable) or
`APIOME_MOCK_CALLBACKS_ENABLED` (hosted) turns it on, and `--callback-allow-private` permits a
loopback receiver in CI. The `__mock__` control plane grows three routes:

```bash
# discover the outbound contract and pin its digests
curl $MOCK/demo/orders/1.0.0/__mock__/callbacks

# deliver one now, without driving its triggering operation
curl -X POST -H "Content-Type: application/json" \
  -d '{"destination": "https://hooks.example.com/orders/tenant-a"}' \
  $MOCK/demo/orders/1.0.0/__mock__/callbacks/order-created/trigger

# read back every attempt and its outcome
curl $MOCK/demo/orders/1.0.0/__mock__/callbacks/deliveries
```

Every attempt also emits a `mock_callback_attempt` log line and every delivery a terminal
`mock_callback_delivery` line. Records and logs carry the destination's origin and path but never
its query string, header values, or payload. Full guide:
[docs/guide/mock-callbacks.md](../docs/guide/mock-callbacks.md).

## Guarded proxy capture (PMR-2.4)

**Hosted only.** A mock can forward a request to a *real* upstream, return the real answer, and
keep a redacted copy as a reviewable fixture candidate. Five gates stand between a request and a
stored record: the `X-Mock-Capture: on` opt-in, a live owner-issued grant plus a tenant API key,
the upstream allowlist (path-normalized, so traversal cannot escape an entry), the SSRF policy
(public addresses only, revalidated on every hop, redirects never followed), and redaction
followed by a credential re-scan that refuses storage outright if anything still looks like a
secret.

```bash
# record one exchange against an allowlisted upstream
curl -H 'X-Mock-Capture: on' -H 'X-Api-Key: ak_live_…' \
     -H 'Authorization: Bearer <upstream token>' \
     $MOCK/demo/petstore/1.0.0/pets/7
# -> the upstream's real answer, plus:
#    X-Mock-Capture: recorded | not-recorded
#    X-Mock-Capture-Id / -Upstream / -Redactions / -Reason
```

The upstream receives your `Authorization` header — it has to — and that header is exactly what
never reaches storage. Redaction removes rather than masks, and records every removal as a
pointer, a rule, and a reason.

Grant capture with `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/capture-policy`
(the authorization block is server-stamped and expires; the deployment flag
`APIOME_MOCK_CAPTURE_ENABLED` must also be on). Review recorded exchanges with
`GET .../mock/captures`, decide them with `POST .../mock/captures/review`, and convert approved
ones into a fixture pack with `POST .../mock/captures/publish`.

A published pack carries a `provenance` block (fixture pack format v2), so replay says where its
data came from: `__mock__/fixture-packs` reports each pack's `origin` and `redactionStatus`, and
`__mock__/session/reset` echoes the same facts plus `X-Mock-Fixture-Origin` /
`X-Mock-Fixture-Redaction` headers. Full guide:
[docs/guide/mock-proxy-capture.md](../docs/guide/mock-proxy-capture.md).

## Stored active scenario (MSC-2.1)

A version can nominate the scenario its mock serves by default, so switching a mock to
`server-error` changes what the hosted URL returns instead of only what a caller who knows to send
a header can ask for. It is the `activeScenario` key of `versions.mock_settings`, it travels inside
a portable bundle, and the precedence is:

1. the request's `X-Mock-Scenario` header — still an outright override;
2. the version's stored `activeScenario`;
3. no scenario, which is exactly today's behaviour.

Every response served while a scenario is in effect carries `X-Mock-Scenario` naming it, including
one for an operation the scenario does not override — a caller who sent no header can otherwise
not tell which scenario is answering them.

A stored `activeScenario` naming a scenario that no longer exists is **ignored with a warning**
(`mock_active_scenario_unknown`) and the request falls through to the default flow. A default that
cannot resolve must never take a serving mock down; the strict check lives at save time, where
apiome-rest rejects an `activeScenario` that is not one of the scenarios saved with it. A *header*
naming an unknown scenario stays a problem response — that one is the caller asking for something
specific.

## One mock engine (MSC-2.2)

Until #5532 there were **two** mock engines. This one served the hosted data plane and portable
bundles; a second, weaker one inside apiome-rest served the short-lived *sandbox* instances the
Mock Server and the Export Studio's test drive provision at `/v1/mock/{id}/…`. The two read
different scenario schemas and shared only three routing symbols, so every feature built here —
templates, match predicates, stateful CRUD, fixture packs, chaos, the non-HTTP transports — was
invisible on the other surface.

The second engine is deleted. A sandbox request now arrives here over one internal hop and is
answered by `serve_compiled_request`, exactly as every other mock request is:

```bash
curl -X POST $MOCK/__sandbox__ \
  -H 'X-Internal-Service-Token: <APIOME_MOCK_INTERNAL_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"sandbox": "<instance-id>", "bundle": {…}, "request": {"method": "GET", "path": "/pets/42"}}'
# -> { status, headers, mediaType, body, bodyEncoding, operation, scenario, schemaValid }
```

It is the same shape and the same fail-closed token gate as `/__preview__`, and differs in exactly
the three ways a real request differs from a dry run: **chaos applies** rather than being reported,
**session state persists** for the sandbox's life (in a store of its own, keyed by the `sandbox`
id, so two sandboxes frozen from the same version never see each other's stateful CRUD), and
outbound callbacks are still not dispatched — a sandbox serves anonymous callers from a frozen
artifact, and firing webhooks on their behalf has no owner.

apiome-rest keeps what a *sandbox* is (does the instance exist, has it expired, is the caller
inside its rate limit) and hands over what a *mock* is.

### Built-in scenarios

The retired engine shipped four scenario templates on every instance, and tenants wrote them into
client code by name, so all four are defined on **every** version here — merged into whatever the
version stores, which always wins on a name collision:

| Name | Behaviour |
| --- | --- |
| `happy-path` | No overrides: every operation answers as it would with no scenario. |
| `server-error` | Every operation returns `500` with `{"error": {"code": "internal_error", …}}`. |
| `not-found` | Every operation returns `404` with `{"error": {"code": "not_found", …}}`. |
| `slow` | Normal responses with 1500 ms of injected latency. |

Two vocabulary additions carry them, both usable in any authored scenario:

* the operation key `"*"`, which applies to every operation the scenario does not name explicitly;
* an override's `status`, which pins the status but leaves the **body to the spec**, resolved the
  same way `?__status=` resolves it. A canned response with no body would serve an empty one.

## Dry-run response preview (MSC-1.2)

**Hosted only, internal.** `POST /__preview__` answers "given this request, what does this mock
return?" without a request ever reaching the data plane. It takes a portable mock bundle plus a
synthetic request and renders it through `serve_compiled_request` — the *same* function the hosted
runtime and `apiome mock run` call — so a preview can never disagree with a served response.

```bash
curl -X POST $MOCK/__preview__ \
  -H 'X-Internal-Service-Token: <APIOME_MOCK_INTERNAL_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"bundle": {…}, "request": {"method": "GET", "path": "/pets/42"}}'
# -> { operation, pathParams, status, headers, mediaType, body, bodyEncoding, trace, chaos }
```

The `trace` names which layer produced the body — `scenario` (with where it came from and the
matched rule index), `stateful`, `correlation` (with the mode and the pointers it bound), `example`
or `synthesis` — which is most of the value of a preview.

The endpoint exists because the engine lives here while the control plane (version records, RBAC,
the editor, the CLI) lives in apiome-rest, which cannot import this package. apiome-rest
authenticates the caller, builds the bundle — from stored settings or an unsaved draft — and asks
for the render. It is **fail closed**: with no `APIOME_MOCK_INTERNAL_TOKEN` configured the endpoint
answers `503` and renders for nobody, and the token is compared in constant time.

A preview never writes (session state lives and dies inside the call, no callback is dispatched)
and never applies chaos — configured latency and error injection are *reported* in `chaos` instead,
so a preview does not sleep or randomly answer 500. Full guide:
[docs/guide/mock-response-preview.md](../docs/guide/mock-response-preview.md).

## Mock configuration as a file (MSC-1.4)

The settings that decide what a mock *returns* also travel as one reviewable document, so they can
be committed, diffed in a pull request, checked for drift in CI, and promoted from one version to
another. The CLI reads and writes it against the control plane; the shape is documented here
because it is the same settings a bundle carries.

```json
{
  "configFormat": "apiome.mock.config/v1",
  "configFormatVersion": 1,
  "activeScenario": "outage",
  "chaos": { "default": { "delayMs": 100, "jitterMs": 20, "errorRate": 0.5 }, "operations": {} },
  "correlation": {
    "mode": "inferred",
    "operations": { "GET /pets/{petId}": { "/id": "{{request.path.petId}}" } }
  },
  "fixturePacks": { "smoke": { "packFormat": "apiome.mock.fixture-pack/v1", "collections": {} } },
  "scenarios": { "outage": { "description": "Upstream is down", "operations": {} } }
}
```

| Key | What it configures |
| --- | --- |
| `correlation` | Response correlation (MSC-1.1) — how a default-path response is derived from the request. `null` when off. |
| `scenarios` | Named scenario definitions (SIM-4.2), keyed by scenario name. |
| `activeScenario` | The scenario served when a request sends no `X-Mock-Scenario` header (MSC-2.1). Must name one of `scenarios`. `null` when the version has none. |
| `chaos` | Version-level latency and error injection (SIM-4.3). `null` when unset. |
| `fixturePacks` | Fixture packs (PMR-2.2), keyed by pack name. |

Four properties are contracts rather than conveniences:

* **The document is whole.** A push replaces every section; a section the document omits is
  *cleared*, not left alone. `configFormat` is required precisely so no arbitrary JSON file can be
  pushed into a version by accident.
* **The document is the server's canonical form, verbatim** — not even the explicit `null`s the API
  reports for unset optional fields are pruned, because a canned response body is free-form JSON in
  which `null` is a value. Keys are sorted at every depth, so a pull is byte-stable and committing
  it produces no diff on the next pull.
* **The document carries no identity.** No tenant, project or version travels in it, so the same
  file can be pushed to a staging version and then to a production one.
* **Validation is the server's.** `push` checks the document through the very routes that would
  store it (`?dryRun=true`), all of them, before any of them writes — so a rejected document leaves
  the version untouched and reports every problem at once.

Callbacks (PMR-2.3) and the hosted-only knobs — the private-mock access mode, the proxy-capture
grant — are deliberately outside the document: the first carries delivery destinations, and the
others are access control rather than behaviour.

```bash
apiome mock config pull payments-api 1.0.0 --out mock-config.json
apiome mock config diff payments-api 1.0.0 --file mock-config.json   # exit 1 = drift
apiome mock config push payments-api 1.0.0 --file mock-config.json --dry-run
apiome mock config push payments-api 1.0.0 --file mock-config.json
```

### Offline preview (`apiome-mock preview`)

`preview` renders one synthetic request against a bundle and prints what the mock would serve, with
the decision trace — the offline half of `apiome mock preview`. It renders through
`apiome_mock.preview.render_preview`, the same function `/__preview__` calls, so an offline preview
and a hosted one answer identically for the same bundle and request.

```bash
echo '{"method": "GET", "path": "/pets/42"}' \
  | apiome-mock preview --bundle mock-bundle.json --json
# -> { operation, pathParams, status, headers, mediaType, body, bodyEncoding, trace, chaos }
```

The request document is read from `--request-file` (default `-`, standard input) and never from a
command line, so a header carrying a bearer token cannot leak into `ps` output or shell history. It
is validated by the same model `/__preview__` validates with, so the two paths cannot accept
different request shapes. Exit codes match the other portable commands: `2` configuration or
request-document error, `3` bundle verification failed, `4` bundle incompatible. The status the
*mock* would return is data, not an outcome — a previewed `404` exits `0`.

## Container image

One image, two runtimes — `serve` (hosted, the default) and `run` (portable):

```bash
docker run --rm -p 8775:8775 -v "$PWD/mock-bundle.json:/bundle/mock-bundle.json:ro" \
  ghcr.io/apiome/apiome-mock:latest run
docker run --rm ghcr.io/apiome/apiome-mock:latest selftest   # the image passes the corpus

scripts/build-image.sh --push ghcr.io/apiome/apiome-mock:0.7.0   # linux/amd64 + linux/arm64
```

## Development

```bash
cd apiome-mock
cp .env.example .env   # set APIOME_MOCK_DATABASE_URL
uv sync
uv run apiome-mock serve
```

## Tests

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy -p apiome_mock
uv run pytest
```
