# nginx configuration — `nginx`

Fixtures for the nginx sub-format of **FMT-7.5** ([#5459](https://github.com/apiome/apiome/issues/5459)).
Entries carry `adapter_key: null` and the `pending-adapter` tag.

> **A bounded subset, by design.** nginx configuration is Turing-adjacent — `map`, `geo`, `if`,
> variables, named locations, `try_files`, Lua/njs modules. FMT-7.5 explicitly scopes the parser to a
> documented subset, and requires everything outside it to be a **declared parsing limit, never a
> silent omission**. `04-stress-location-modifiers.conf` exists to be the boundary marker: it is full
> of directives a subset parser must *decline* to model out loud.

**Detection marker.** `server { … listen … location … }` blocks with `proxy_pass`/`return`/`root`
directives; `upstream <name> { server … }` blocks.

**Location modifiers → canonical path match**

| nginx | Meaning |
| --- | --- |
| `location = /path` | exact |
| `location /path` | prefix |
| `location ^~ /path` | prefix, stops regex evaluation |
| `location ~ re` | regular expression, case-sensitive |
| `location ~* re` | regular expression, case-insensitive |
| `location @name` | named, not externally reachable |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-server.conf` | minimal | One server, one location, one `proxy_pass`. |
| `02-typical-reverse-proxy.conf` | typical | Two upstreams with health parameters, TLS, exact/prefix locations, `alias`, a `return 301` redirect server. |
| `03-includes-set/` | multi-file | `nginx.conf` + `upstreams.conf` + a site file: the routes and the upstreams they name are in **different** files. |
| `04-stress-location-modifiers.conf` | stress | Every location modifier, named captures in regex locations, `map`/`geo` variables, `limit_req`/`limit_conn`, `if` inside `location`, `internal`, `try_files` with a named location, nested locations, websocket upgrade. |
| `05-real-world-edge.conf` | real-world | Production edge: canonical-host redirects, cache zones, gzip, security headers, a source-restricted `/metrics`, a `410 Gone` for a withdrawn version. |
| `06-typical-grpc-and-stream.conf` | typical | `grpc_pass` locations and a `stream {}` TCP server — the second has no HTTP operation at all. |
| `07-composition-shared-snippets.conf` | composition | http → server → location directive inheritance, a shared `map` and two shared upstreams. |
| `negative/` | — | Missing brace, a config with no `server` block, truncation, an **HAProxy** config (the neighbouring sub-format), UTF-16, and a `proxy_pass` to an upstream that is never declared. |
