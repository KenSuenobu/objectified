# How do I… export / download a spec?

Apiome reconstructs the full OpenAPI 3.1 document (or Arazzo workflow document, or JSON Schema)
for a **published** version on demand. You can download it from the CLI or fetch it directly over
REST in JSON or YAML.

Those three have dedicated endpoints, but they are not the whole export surface: Apiome emits
**37<!--format-count:exportable--> formats** — AsyncAPI, GraphQL, Proto3, Avro, Thrift, Smithy,
TypeSpec, WSDL, XSD, OData, EDI X12, HL7 v2, FHIR, COBOL copybooks and more —
through the export-target registry. The full list, and which formats round-trip (import *and*
export) versus export only, is generated at [supported-formats.md](supported-formats.md).

Run `apiome export targets` to see the same list for a specific version, and
`apiome export evidence --target <format>` to see what a given conversion preserves before you
generate it.

---

## With the CLI

```bash
# OpenAPI (default), JSON, to a file
apiome spec export --project <id-or-slug> --version <id-or-label> --output petstore.json

# YAML
apiome spec export --project <id-or-slug> --version <id-or-label> --yaml -o petstore.yaml

# Exporting to another format (AsyncAPI, GraphQL, Proto3, Avro, …)? Check what will be
# preserved — and why anything changes — before you generate:
apiome export targets  --project <id-or-slug> --version <id-or-label>
apiome export evidence --project <id-or-slug> --version <id-or-label> --target avro

# Arazzo workflow document instead of OpenAPI
apiome spec export --project <id-or-slug> --version <id-or-label> --format arazzo -o flows.json
```

Use `-o -` to stream to stdout. `--format` accepts `openapi` (default) or `arazzo`.

## With the REST API

```http
GET /v1/schema/{tenant_slug}/{project_slug}/{version_slug}
Accept: application/json          # default; use application/yaml for YAML
```

Other representations of the same version:

| Format | Route |
|---|---|
| OpenAPI | `GET /v1/schema/{tenant}/{project}/{version}` |
| Arazzo | `GET /v1/arazzo/{tenant}/{project}/{version}` |
| JSON Schema | `GET /v1/json/{tenant}/{project}/{version}` |

For private versions, pass an in-scope API key via the `X-API-Key` header (or the `api_key` query
parameter).

## Verify

The exported document is valid OpenAPI and contains the classes and paths you edited. The
[Golden Path](../GOLDEN_PATH.md) does exactly this — it exports via the real CLI and re-validates the
downloaded document with `openapi-spec-validator`.

## Related

- [supported-formats.md](supported-formats.md) — every format Apiome imports and exports,
  generated from the registries
- [export-fidelity.md](export-fidelity.md) — cross-format exports: what is preserved,
  what is lost and why, and the risk acknowledgement
- [browse-published-specs.md](browse-published-specs.md) — view the same spec rendered
- [cli-quickstart.md](cli-quickstart.md) — full CLI reference
