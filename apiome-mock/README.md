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
