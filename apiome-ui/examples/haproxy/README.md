# HAProxy configuration — `haproxy`

Fixtures for the HAProxy sub-format of **FMT-7.5** ([#5459](https://github.com/apiome/apiome/issues/5459)).
Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** Section keywords at column 0 — `global`, `defaults`, `frontend`, `backend`,
`listen` — with indented directives (`bind`, `acl`, `use_backend`, `server`).

**Where the routes are.** An HAProxy config expresses routing as **ACL + `use_backend`**:

| Directive | Canonical target |
| --- | --- |
| `bind :443 ssl crt …` | server / scheme |
| `acl … path`/`path_beg`/`path_end`/`path_reg` | operation path (exact / prefix / suffix / regex) |
| `acl … method` | operation method |
| `acl … hdr(host)` | server host |
| `use_backend X if <acls>` | route → backend |
| `default_backend X` | catch-all route |
| `server name host:port` | backend endpoint |
| `acl … src`/`ssl_*`/`sc_http_req_rate` | **declared condition** (no HTTP analogue) |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal.cfg` | minimal | One frontend, one backend, no ACLs. |
| `02-typical-path-acls.cfg` | typical | Path ACLs to three backends, an inline `http-request return`, a source-restricted deny, health checks, `replace-path`. |
| `03-composition-multi-frontend.cfg` | composition | Three frontends sharing backends, a `listen` section, mTLS on one bind, and a **map-file-driven** `use_backend` whose target is computed at runtime. |
| `04-stress-acl-vocabulary.cfg` | stress | The full ACL fetch/match vocabulary — path (five forms), method, header, query, body size, source, SSL, stick-table rate, and a **Lua-backed ACL** the parser must decline to interpret. |
| `05-real-world-edge.cfg` | real-world | Production edge: HTTP/2 + TLS, rate limiting by source, maintenance switch, five backends including a websocket tunnel and mTLS to payments. |
| `06-typical-tcp-mode.cfg` | typical | `mode tcp` SNI routing and a `pgsql-check` database backend — no HTTP semantics at all. |
| `07-composition-defaults-inheritance.cfg` | composition | Two named `defaults` sections inherited by the sections that follow, plus a shared backend. |
| `08-map-file-set/` | multi-file | A config whose backend choice and Host allowlist are both resolved through sibling `.map` files. |
| `negative/` | — | A misspelled section keyword, a config with no frontend, truncation, a **Traefik** dynamic config (the neighbouring sub-format), UTF-16, and `use_backend`/`default_backend` naming sections that do not exist. |
