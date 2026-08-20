# Azure API Management — `azure-apim`

Fixtures for **FMT-7.2** ([#5456](https://github.com/apiome/apiome/issues/5456)). APIM carries an API
definition **plus** a separate XML **policy** document per API and per operation, expressing rate
limits, IP filters, JWT validation, rewrites and backend selection — semantics that exist nowhere else
and that Apiome could normalize and govern. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection markers.** `<policies>` root with `inbound`/`backend`/`outbound`/`on-error` sections for a
policy document; ARM resources of type `Microsoft.ApiManagement/service/apis` (and
`…/operations`, `…/policies`, `…/backends`, `…/products`) for a definition export.

**Policy → canonical mapping the adapter owes**

| Policy | Canonical target |
| --- | --- |
| `validate-jwt`, `check-header`, `authentication-certificate` | security |
| `rate-limit`, `rate-limit-by-key`, `quota`, `quota-by-key` | rate-limit metadata |
| `set-backend-service` | servers / backend |
| `rewrite-uri`, `set-method`, `set-query-parameter` | path & operation provenance |
| `cors` | CORS metadata |
| `ip-filter` | access posture |
| anything unmapped (`cache-*`, `send-request`, `json-to-xml`, vendor policies) | extras, verbatim, visible in the detail view |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-policy.xml` | minimal | The four pipeline sections and one backend override. |
| `02-typical-arm-api.json` | typical | ARM export: API resource with `path`/`serviceUrl`/subscription keys, two operations with parameters and responses, an API-level and an operation-level policy carried as escaped XML strings. |
| `03-api-with-policy-set/` | multi-file | The realistic shape: an OpenAPI definition **plus** its policy XML. Neither half is the whole API. |
| `04-stress-policy-vocabulary.xml` | stress | Security, throttling, routing, transformation, `choose`/`when`/`otherwise`, `retry`, caching, `send-request` — **and a vendor policy that is not APIM's**, which must be preserved verbatim. |
| `05-real-world-soap-passthrough-arm.json` | real-world | A WSDL-derived SOAP pass-through API: `apiType: soap`, `SOAPAction` headers, a `backends` resource, a product with approval requirements, `xml-to-json` on the way out. |
| `06-typical-arm-api-versionset.json` | typical | An `apiVersionSets` resource with two API versions sharing one path — the versioning shape APIM estates use. |
| `07-composition-policy-inheritance.xml` | composition | All four policy scopes in evaluation order — `<base />` is the composition operator. |
| `negative/` | — | Unclosed policy, a `policies` document with no sections, truncation, a **Kong declarative config** (the neighbouring gateway), UTF-16, and a policy referencing a backend id and a named value that do not exist. |

**Provenance split.** Facts from the definition are `declared` by the API; facts from the policy are
`declared` by the *gateway*. FMT-7.2 requires the detail view to distinguish definition-derived from
policy-derived, so both halves of `03-api-with-policy-set/` must be attributable after import.
