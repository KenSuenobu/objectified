# Envoy xDS route configuration — `envoy-xds`

Fixtures for the Envoy half of **FMT-7.4** ([#5458](https://github.com/apiome/apiome/issues/5458)). In
mesh-based platforms the routing truth lives in Envoy xDS resources — often the only machine-readable
description of what paths exist. The Istio half lives in `istio/`. Entries carry `adapter_key: null`
and the `pending-adapter` tag.

**Detection markers.** A `static_resources.listeners[].filter_chains[].filters[].typed_config` whose
`@type` is an `HttpConnectionManager`; a bare `RouteConfiguration` (`name` + `virtual_hosts[]`); or a
`DiscoveryResponse` whose `type_url` names a route configuration.

**Match normalization — the shared table.** FMT-7.4 requires these to map *identically* to the
Gateway API path types the shipped `gateway-api` adapter already uses:

| Envoy | Gateway API path type |
| --- | --- |
| `path` | `Exact` |
| `prefix` | `PathPrefix` (string prefix) |
| `path_separated_prefix` | `PathPrefix` (segment-aware) |
| `safe_regex` | `RegularExpression` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-route-config.yaml` | minimal | One virtual host, one prefix route. |
| `02-typical-bootstrap.yaml` | typical | A full static bootstrap: listener, HCM with an inline route config, four routes, three clusters. |
| `03-composition-multi-virtualhost.yaml` | composition | Three virtual hosts with different domain sets (including a wildcard), `require_tls`, a header-gated route, a direct response and a redirect. |
| `04-stress-matchers.yaml` | stress | Every matcher (`path`, `prefix`, `path_separated_prefix`, `safe_regex`, headers with `invert_match`, query parameters, `runtime_fraction`, `grpc`, `connect_matcher`), weighted clusters, retries, regex rewrite, per-route filter config, virtual-host CORS and rate limits. |
| `05-real-world-mesh-bootstrap.yaml` | real-world | A sidecar bootstrap: node metadata, ADS dynamic resources, an inbound listener with JWT authentication, mesh-shaped cluster names. |
| `06-typical-discovery-response.json` | typical | An xDS `DiscoveryResponse` carrying a `RouteConfiguration` — the wire form, not the config file. |
| `07-filesystem-xds-set/` | multi-file | A bootstrap that loads its routes and clusters from sibling files through filesystem xDS. |
| `negative/` | — | Bad YAML, a route config with no virtual hosts, truncation, an **Istio `VirtualService`** (the sibling format), UTF-16, and a route naming a cluster that is not defined. |

**Fidelity boundary.** Everything here is `inferred`, partial fidelity: routes, hosts, methods and
timeouts, and **no request or response schemas at all**. The adapter must declare that loss rather
than implying the model is complete.
