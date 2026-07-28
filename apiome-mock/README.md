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
editing its spec:

```bash
uv run python scripts/build_conformance_bundle.py           # rewrite
uv run python scripts/build_conformance_bundle.py --check   # verify it is current
```

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

## Container image

One image, two runtimes — `serve` (hosted, the default) and `run` (portable):

```bash
docker run --rm -p 8775:8775 -v "$PWD/mock-bundle.json:/bundle/mock-bundle.json:ro" \
  ghcr.io/apiome/apiome-mock:latest run
docker run --rm ghcr.io/apiome/apiome-mock:latest selftest   # the image passes the corpus

scripts/build-image.sh --push ghcr.io/apiome/apiome-mock:0.3.0   # linux/amd64 + linux/arm64
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
