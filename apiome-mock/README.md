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
