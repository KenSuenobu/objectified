# Traefik dynamic configuration — `traefik`

Fixtures for the Traefik sub-format of **FMT-7.5** ([#5459](https://github.com/apiome/apiome/issues/5459)).
The reverse-proxy config is the only spec many teams have. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection markers.** `http.routers` + `http.services` in YAML or TOML; or
`apiVersion: traefik.io/v1alpha1` with `kind: IngressRoute` for the CRD form.

**Rule grammar → canonical operations.** `Path` → exact, `PathPrefix` → prefix, `PathRegexp` →
regular expression, `Host`/`HostRegexp` → server host, `Method` → operation method, `Header`/`Query`
→ declared match conditions. Boolean composition (`&&`, `||`, `!`, parentheses) is the hard part: a
rule that does not reduce to a path plus a method is a **declared condition**, not a dropped one.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-router.yml` | minimal | One router, one service. |
| `02-typical-dynamic.yml` | typical | Three routers with entry points and TLS, load-balanced servers with a health check, sticky cookies, rate-limit / strip-prefix / redirect middlewares. |
| `03-composition-middleware-chains.yml` | composition | A `chain` middleware composing five others, a `weighted` service over two backends, a `mirroring` service, `serversTransports`, TLS options. |
| `04-stress-rule-grammar.yml` | stress | Every matcher including `ClientIP`, negation and grouping; `addPrefix`, `replacePathRegex`, `retry`, `buffering`, `errors`, `forwardAuth`; **plus TCP and UDP routers**, which have no HTTP-operation analogue. |
| `05-real-world-dynamic.toml` | real-world | The **TOML** form: canonical-host redirect, per-route certificate domains, metrics endpoint restricted by source range, priorities. |
| `06-typical-ingressroute-crd.yaml` | typical | The Kubernetes CRD form: `IngressRoute` + `Middleware` in one stream. |
| `07-provider-directory-set/` | multi-file | The file provider watching a directory: routers, services and middlewares in three files. |
| `negative/` | — | Bad YAML, routers with no rule and services with no servers, truncation, an **nginx** config (the neighbouring sub-format), UTF-16, and a router naming a service and middleware that do not exist. |
