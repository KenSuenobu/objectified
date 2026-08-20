# Apigee proxy bundles — `apigee`

Fixtures for **FMT-7.3** ([#5457](https://github.com/apiome/apiome/issues/5457)). An Apigee proxy
bundle is a **zip** of `apiproxy/` XML — proxy endpoints, target endpoints, flows, conditions and
policies — and it describes Google-estate APIs. Gravitee already federates from Apigee; Apiome cannot
read one at all. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** For the archive: a zip whose members are under `apiproxy/` with an
`apiproxy/<name>.xml` manifest whose root is `APIProxy`. For loose files: a `ProxyEndpoint` or
`TargetEndpoint` root element.

**Bundle layout** (inside every `.zip` here)

```
apiproxy/<name>.xml            APIProxy manifest: base paths, policy/endpoint inventory
apiproxy/proxies/default.xml   ProxyEndpoint: HTTPProxyConnection base path, Flows, RouteRules
apiproxy/targets/*.xml         TargetEndpoint: HTTPTargetConnection URL or LoadBalancer
apiproxy/policies/*.xml        one file per policy
apiproxy/resources/jsc/*.js    script resources (stress bundle only)
```

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-proxy-endpoint.xml` | minimal | A loose `ProxyEndpoint`: base path, one conditioned flow, one route rule. |
| `02-typical-proxy-bundle.zip` | typical | Full bundle: three flows, `VerifyAPIKey`, `SpikeArrest`, `Quota`, a CORS `AssignMessage`, one target. |
| `03-composition-multi-target-bundle.zip` | composition | **Ordered route rules** to three targets, including a conditioned rule, a rule with *no* target (a deliberate dead end) and the unconditioned default. |
| `04-stress-policy-coverage-bundle.zip` | stress | OAuthV2, SpikeArrest, Quota, JSONThreatProtection, JSON↔XML, ExtractVariables, ServiceCallout, Javascript with a `jsc` resource, ResponseCache, FaultRules and a DefaultFaultRule, a load-balanced target, and a flow with **no condition**. |
| `05-real-world-payments-bundle.zip` | real-world | Public payments edge: OAuth scope enforcement, per-app quota, HMAC webhook verification, idempotency-key gate, environment-routed sandbox target, mTLS to the core. |
| `06-typical-target-endpoint.xml` | typical | A loose `TargetEndpoint` with a load balancer, timeouts, success codes and `SSLInfo`. |
| `07-shared-flow-set/` | multi-file | A proxy whose security and quota steps live in a shared flow, bound by a FlowCallout policy. |
| `negative/` | — | Unclosed flow, a bundle with **no** `ProxyEndpoint`, a truncated zip, a Gateway API `HTTPRoute` (the neighbouring gateway format), UTF-16, and a route rule pointing at a target endpoint the bundle does not contain. |

**Conditions are the hard part.** A `Flow`/`RouteRule` `Condition` is a boolean expression, not a
path match. Where it reduces to a path plus a verb it becomes a canonical operation; where it does
not — header tests, variable comparisons, `NOT (...)` — FMT-7.3 requires it recorded as a **declared
condition** rather than dropped. `03` and `04` both carry conditions that cannot be reduced.
