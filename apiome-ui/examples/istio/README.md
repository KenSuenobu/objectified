# Istio traffic resources — `istio`

Fixtures for the Istio half of **FMT-7.4** ([#5458](https://github.com/apiome/apiome/issues/5458)).
`VirtualService` `http` rules are the only machine-readable description of what paths exist in many
mesh platforms; `DestinationRule` supplies the subsets those rules name, and `Gateway` supplies the
hosts and TLS. The Envoy half lives in `envoy-xds/`. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection marker.** `apiVersion: networking.istio.io/*` with `kind: VirtualService` (or
`DestinationRule`, `Gateway`, `ServiceEntry`, `Sidecar`). **Multi-document YAML streams are the norm**
and must be supported.

**Match normalization — the shared table.** Identical to the Gateway API mapping the shipped adapter
uses, so `envoy-xds`, `istio` and `gateway-api` agree:

| Istio `uri` | Gateway API path type |
| --- | --- |
| `exact` | `Exact` |
| `prefix` | `PathPrefix` |
| `regex` | `RegularExpression` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-virtualservice.yaml` | minimal | One host, one unconditional route. |
| `02-typical-virtualservice.yaml` | typical | Named rules, method matches, `directResponse`, `rewrite`, timeout and retries, an unmatched default route. |
| `03-composition-multidoc.yaml` | composition | `Gateway` + `VirtualService` + `DestinationRule` in **one stream**, with subsets, weights and a header-pinned canary. |
| `04-stress-match-and-traffic-policy.yaml` | stress | Every match field (`headers`, `withoutHeaders`, `queryParams`, `method`, `scheme`, `authority`, `port`, `sourceLabels`, `gateways`), CORS, fault injection, mirroring, `delegate`, header mutation, plus `tls` and `tcp` route blocks. |
| `05-real-world-canary-rollout.yaml` | real-world | A production canary: employee-pinned canary, 95/5 split, sticky-session consistent hash, outlier ejection, a `410 Gone` for the withdrawn version. |
| `06-typical-serviceentry-and-sidecar.yaml` | typical | Egress: `ServiceEntry` for an external API, a `VirtualService` routing to it, and a `Sidecar` scoping the namespace. |
| `07-gitops-set/` | multi-file | The GitOps layout: VirtualService, Gateway and DestinationRule in three files. |
| `negative/` | — | Bad YAML, a `VirtualService` with no route blocks, truncation, an **Envoy route config** (the sibling format), UTF-16, and a route naming a subset the `DestinationRule` does not define. |

**Fidelity boundary.** Inferred, partial fidelity: routes, hosts, methods, weights, timeouts — and no
schemas. `delegate`, `tls`/`tcp` routing and `sourceLabels` have no canonical HTTP-operation analogue
and must be declared limits, not silently flattened.
