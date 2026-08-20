# Consul service definitions — `consul`

Fixtures for the Consul sub-format of **FMT-7.5** ([#5459](https://github.com/apiome/apiome/issues/5459)).
A Consul catalog is a service registry, not a route table — which makes it the *thinnest* member of
the gateway family and the one whose fidelity claims must be most careful. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `{"service": {…}}` / `{"services": [...]}` (JSON) or `services { … }` (HCL) for
a definition; `Kind: service-router` / `service-resolver` / `service-splitter` / `ingress-gateway` for
a configuration entry; `Nodes[].Services` for a catalog export.

**Where the paths come from — and where they do not**

| Source | Carries a path? |
| --- | --- |
| `Kind: service-router` `Match.HTTP.Path*` | **yes** — exact / prefix / regex, plus methods, headers, query params |
| `Kind: ingress-gateway` listeners | host + port + protocol, no path |
| `urlprefix-…` tags (the Fabio convention) | by convention only — record as `inferred`, never as declared |
| service `meta` (`protocol`, `openapi_url`) | a pointer to a real spec, not a spec |
| plain service definitions | **no** — name, address, port, health checks and tags only |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-service.json` | minimal | Name, port, address. |
| `02-typical-service-with-checks.json` | typical | Tags including a `urlprefix-` convention tag, `meta` with a spec URL, two health checks, weights. |
| `03-service-set/` | multi-file | Two service definitions **plus** the `service-router` whose routes give them paths — the routes only exist across the set. |
| `04-stress-connect-and-resolvers.hcl` | stress | The **HCL** form: Connect sidecar with upstreams, gRPC and alias checks, and a `service-router` with prefix / exact / regex matches, header and query-param matches, subsets, retries and a prefix rewrite. |
| `05-real-world-catalog-export.json` | real-world | A `/v1/catalog` export: two nodes, four services, per-service meta and check status including a `warning`. |
| `06-typical-ingress-gateway.json` | typical | An `ingress-gateway` entry with HTTP, gRPC and TCP listeners. |
| `07-composition-resolver-and-splitter.hcl` | composition | The resolver → splitter → router chain: three entries that only mean anything together. |
| `negative/` | — | Trailing comma, a service with no port, truncation, a **Tyk** API definition (the neighbouring sub-format), UTF-16, and a router destination naming a service that is not registered. |
