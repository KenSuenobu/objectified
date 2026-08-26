# apiome-mcp

Python [**FastMCP**](https://github.com/jlowin/fastmcp) service that exposes Apiome **published OpenAPI** specifications to MCP hosts (IDEs, Claude Desktop, automation, etc.) over **stdio** or **streamable HTTP**. The server is **read-only** for the MVP: it lists, searches, and returns documents and fragments from **PostgreSQL** using SQL views and scoped API keys—no Redis or other infrastructure.

---

## Architecture

MCP hosts talk to a single async Python process. That process keeps one shared **`psycopg`** async connection pool for all tools; authentication and visibility rules are enforced in SQL and Python helpers (`scope` ∩ revision visibility).

```
┌────────────┐   stdio / streamable HTTP   ┌─────────────────────────┐
│  MCP host  │ ──────────────────────────▶ │   apiome-mcp       │
│ (Claude,   │                             │   FastMCP service       │
│  IDE, …)   │ ◀────────────────────────── │   (Python, async)       │
└────────────┘                             └────────────┬────────────┘
                                                        │ psycopg async pool
                                                        ▼
                                            ┌─────────────────────────┐
                                            │       Postgres          │
                                            │  (Apiome schema +  │
                                            │   mcp_api_keys,         │
                                            │   mcp_access_audit,     │
                                            │   mcp_v_public_specs)   │
                                            └─────────────────────────┘
```

- **Datastore:** Postgres only (Apiome migrations applied). Pool opens at startup; failed `SELECT 1` probe logs a warning but the server still runs.
- **Public catalog:** Anonymous callers use SQL views over **published, public** revisions (e.g. `apiome.mcp_v_public_specs`).
- **Private revisions:** Valid **MCP API keys** (hashed in `apiome.mcp_api_keys`) unlock **in-scope** private published revisions for the key’s tenant; see [Authentication](#authentication).
- **Observability:** Structured JSON logs on stderr (`structlog`). HTTP exposes **`GET /health`** (liveness, no DB).

Canonical planning doc: [**Planned Roadmap — MCP Server**](../docs/PLANNED_ROADMAP_MCP.md).

---

## Transports

| Transport | Entry | Notes |
|-----------|--------|--------|
| **stdio** | `uv run apiome-mcp serve --transport stdio` | For local hosts (Claude Desktop, MCP Inspector). Credentials for tools can be passed via `tools/call` **`_meta`** (see [Authentication](#authentication)). |
| **Streamable HTTP** | `uv run apiome-mcp serve --transport http` | MCP endpoint at **`http://<host>:<port>/mcp`** (bind with **`APIOME_MCP_HTTP_HOST`** / **`APIOME_MCP_HTTP_PORT`** or **`--host`** / **`--port`**). Bearer tokens are read from **`Authorization`** per request. |

Running **`uv run apiome-mcp serve`** without **`--transport`** loads settings and exits—useful to validate **`.env`**.

---

## MCP tools

| Tool | Summary |
|------|---------|
| **`ping`** | Service id, package version, UTC timestamp, Postgres reachability (`db_ok` / `db_error`). |
| **`spec.list`** | Cursor-paginated list of published specs. Anonymous: public catalog only. With **`Authorization: Bearer`**, merges in-scope public rows and in-scope **private** revisions for the key’s tenant. Optional **`tenant_id`** / **`project_id`**, **`limit`** (default 50, max 100), **`cursor`** / **`next_cursor`**. |
| **`project.list`** | Cursor-paginated distinct projects (**`tenant_id`**, **`project_id`**, **`title`**, latest **`updated_at`**) visible to the caller; anonymous uses the public catalog only; with Bearer, same merge rules as **`spec.list`**. Optional filters and pagination match **`spec.list`**. |
| **`spec.list_my_specs`** | Same response shape as **`spec.list`**, but **requires** a valid API key; rejects anonymous callers. Optional audit logging for private reads. |
| **`spec.describe`** | Metadata for one revision UUID (`id`, `title`, `version`, `description`, `owner`, `tags`, `updated_at`). Anonymous: public only; with Bearer, includes in-scope private revisions. |
| **`spec.search`** | Postgres **full-text** search (`plainto_tsquery`) over **public** specs (title, description, version label, tags via `mcp_public_doc_tsv`). Requires non-empty **`q`**; ranked via `ts_rank_cd`; cursor pagination. |
| **`spec.search_semantic`** | Cosine similarity (`pgvector`) over **public** specs with **`mcp_public_embedding`** set. Embeds **`q`** via OpenAI-compatible **`APIOME_MCP_OPENAI_API_KEY`**; same pagination shape as **`spec.search`**. Rows without embeddings are skipped until backfilled. |
| **`spec.list_tags`** | Distinct public tag names with spec counts; sorted by count then tag; cursor pagination (**`limit`** default 50, max 100, **`next_cursor`**). |
| **`spec.get_openapi`** | Full generated OpenAPI **JSON** for a revision UUID (same visibility rules as describe). Size capped by **`APIOME_MCP_OPENAPI_MAX_JSON_BYTES`**. |
| **`spec.export_yaml`** | Same as **`spec.get_openapi`** but **YAML** text field; same cap semantics. |
| **`spec.list_operations`** | Compact index of HTTP operations (`path`, `method`, `operation_id`, summary, tags). |
| **`spec.describe_operation`** | Fragments for one operation: `parameters`, `requestBody`, `responses`, `security`; internal `$ref` expanded. |
| **`spec.list_components`** | Component keys grouped by kind (`schemas`, `parameters`, `responses`, `securitySchemes`). |
| **`spec.describe_component`** | Single component definition by **`kind`** + **`name`**; internal `$ref` expanded. |

**Tool & toolset registry (MTG-1.1):** Stable ids, descriptions, and toolset membership
(`health`, `catalog`, `search`, `document`, `structure`) live in
``apiome-rest`` ``app.mcp_tool_registry`` and are exposed as
``GET /api-keys/mcp-tools``. CI fails if a registered FastMCP tool is missing from
that catalog. Unknown tool names fail closed on ``tools/call`` until registered.
Capability ids ``spec.mcp`` / ``spec.catalog`` are catalog-only (governance toggles)
until implemented as handlers.

**Effective policy resolver (MTG-1.4):** Ceiling, defaults, and per-key grants resolve
to one boolean per tool via ``app.mcp_effective_policy`` (re-exported as
``apiome_mcp.effective_policy``). See **[docs/EFFECTIVE_POLICY.md](docs/EFFECTIVE_POLICY.md)**.

**Call gate (MTG-2.2):** Authenticated ``tools/call`` runs the MTG-1.4 resolver after
auth resolve; disabled tools raise a FastMCP ``ToolError`` whose message starts with
stable code ``capability_disabled`` (tool name + tenant-admin enable guidance; no key
secrets). Every authenticated denial also appends a row to ``mcp_capability_denials``
(MTG-2.4 / #4773; no tool arguments).

**Anonymous call policy (MTG-2.3):** When ``APIOME_MCP_ANONYMOUS_POLICY_TENANT_ID`` is
set, anonymous ``tools/call`` is gated by that host tenant's ``allow_anonymous_mcp`` +
anonymous enable-set (defaults preserve today's public behavior). When unset, anonymous
callers passthrough. ``tools/list`` stays full. See
**[docs/ANONYMOUS_CALL_POLICY.md](docs/ANONYMOUS_CALL_POLICY.md)**.

**Policy freshness (MTG-2.5):** Tenant policy and key grants are loaded from Postgres
on **every** authenticated ``tools/call`` (lag budget ``0``) — an admin disable takes
effect on the next call without restarting the MCP process. See
**[docs/POLICY_FRESHNESS.md](docs/POLICY_FRESHNESS.md)**.

**List-always (MTG-2.1):** ``tools/list`` always returns the full live registry —
never filtered by tenant/key enable-set (contrast AGX-3.1). See
**[docs/LIST_ALWAYS.md](docs/LIST_ALWAYS.md)**. Catalog vs agent-invocation contracts
and shared-code guards: **[docs/AGX_COORDINATION.md](docs/AGX_COORDINATION.md)**
(MTG-5.5 / #4789).

**Mock-target mode (AGX-2.4):** an agent toolset with ``target: mock`` routes its
``tools/call`` traffic to the hosted SIM mock for that version
(``{mock root}/{tenant}/{project}/{version}``) instead of the production upstream, with
the upstream credential vault skipped entirely and the invocation audit labelled
``mock``. Switching a toolset between ``mock`` and ``prod`` needs no recompile. Resolver:
``apiome_mcp.mock_target``; see **[docs/MOCK_TARGET.md](docs/MOCK_TARGET.md)** (#4536).

Tool implementations live in `src/apiome_mcp/server.py` and sibling `*_tool.py` modules.

---

## Authentication

- **HTTP:** **`Authorization: Bearer <secret>`** is parsed by ASGI middleware and attached to tool context. Missing or non-Bearer → **anonymous** for optional-auth tools.
- **stdio:** Hosts may supply secrets via **`tools/call`** **`params._meta`** (`authorization`, `apiome_authorization`, `apiome_api_key`, or `api_key`) as documented in `mcp_auth.py`.
- **Storage:** Keys live in **`apiome.mcp_api_keys`**; secrets are verified with **SHA-256 then bcrypt**. Scope is JSON (`tenants`, `projects` UUID lists) parsed into **`Scope`**; **`spec.list_my_specs`** uses **`Depends(require_mcp_auth)`**.
- **Scopes:** **`Scope.allows(tenant_id, project_id)`** combines with revision visibility (`authorize_spec` / SQL predicates). Details: [API key read scope](#api-key-read-scope) below and [**CONFIGURATION.md**](docs/CONFIGURATION.md).

---

## Deployment

### Local (uv)

Use **[uv](https://docs.astral.sh/uv/)** with **Python ≥ 3.11**. Env files are read from **`.env`** in the **current working directory**—run from **`apiome-mcp/`**.

**Database**

- **Option A — Docker from repo root** (Postgres + migrations only):

  ```bash
  docker compose up -d postgres && docker compose run --rm migrate
  ```

  With default compose credentials, set **`APIOME_MCP_DATABASE_URL`** to  
  `postgresql://postgres:apiome_local_dev@localhost:5432/apiome`

- **Option B:** Any Postgres URI that already has Apiome migrations applied.

**Install and run**

```bash
cd apiome-mcp
uv sync
cp .env.example .env
```

Edit **`.env`**: **`APIOME_MCP_DATABASE_URL`**, **`APIOME_MCP_INTERNAL_SECRET`** (minimum **16** characters). All **`APIOME_MCP_*`** variables are documented in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

```bash
uv run apiome-mcp serve --transport stdio
# or
uv run apiome-mcp serve --transport http
```

Stop with **Ctrl+C** or **`SIGTERM`** (HTTP shuts down gracefully).

### Docker Compose (Postgres + migrations + MCP image)

From the **repository root**, **`docker compose up --build --wait`** starts Postgres 16 (persistent volume), runs **`migrate`** once, then the MCP service on port **`8765`** by default. Overrides: [**`docker-compose.env.example`**](../docker-compose.env.example).

### Container image

Multi-stage **`Dockerfile`** in this directory: build from repo root with  
**`docker build -f apiome-mcp/Dockerfile .`**. Includes non-root user, **`GET /health`**, and **`HEALTHCHECK`**.

---

## Configuration

Full reference: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** (defaults, bounds, required variables)—aligned with **`apiome_mcp.settings.Settings`**.

---

## API key read scope

`apiome.mcp_api_keys.scope_json` stores **`{"tenants": [...], "projects": [...]}`** (UUID strings). The Python type is **`apiome_mcp.scope.Scope`**: empty **`tenants`** means any tenant; empty **`projects`** means any project within the tenant constraint; **`Scope.allows(tenant_id, project_id)`** gates reads. Parse payloads with **`parse_scope_json`**.

---

## Logging

Logs go to **stderr** as one JSON object per line (**structlog**): **`timestamp`** (UTC ISO-8601), **`level`**, **`event`**, **`request_id`**, **`tool_name`**. Verbosity: **`APIOME_MCP_LOG_LEVEL`** (`DEBUG` … `CRITICAL`).

---

## Roadmap documentation

Links below are relative to this directory (`apiome-mcp/`).

### MCP planning

- [Planned Roadmap — MCP Server (FastMCP + Postgres)](../docs/PLANNED_ROADMAP_MCP.md)
- [Model Context Protocol (MCP) Server Roadmap](../docs/PLANNED_FEATURE_ROADMAP_MCP.md)
- [Planned Feature Roadmap — AI](../docs/PLANNED_FEATURE_ROADMAP_AI.md)

### Product hubs

- [Current Roadmap](../docs/CURRENT_ROADMAP.md)
- [Feature Roadmap](../docs/FEATURE_ROADMAP.md)
- [Roadmap offerings inventory](../docs/ROADMAP_OFFERINGS_INVENTORY.md)
- [Planned features](../docs/PLANNED_FEATURES.md)

### Finished / archived roadmap

- [Planned Feature Roadmap — Versioning (finished)](../docs/finished/PLANNED_FEATURE_ROADMAP_VERSIONING.md)

### Package-specific

- [apiome-ui — Planned Feature Roadmap — Paths](../apiome-ui/docs/PLANNED_FEATURE_ROADMAP_PATHS.md)
- [apiome-browse — Feature Roadmap](../apiome-browse/FEATURE_ROADMAP.md)

### Future themed roadmaps (`docs/`)

- [Future — Academy](../docs/FUTURE_FEATURE_ROADMAP_ACADEMY.md)
- [Future — AI](../docs/FUTURE_FEATURE_ROADMAP_AI.md)
- [Future — Analytics](../docs/FUTURE_FEATURE_ROADMAP_ANALYTICS.md)
- [Future — API keys](../docs/FUTURE_FEATURE_ROADMAP_API_KEYS.md)
- [Future — Architect](../docs/FUTURE_FEATURE_ROADMAP_ARCHITECT.md)
- [Future — Automation](../docs/FUTURE_FEATURE_ROADMAP_AUTOMATION.md)
- [Future — Browser](../docs/FUTURE_FEATURE_ROADMAP_BROWSER.md)
- [Future — Canvas](../docs/FUTURE_FEATURE_ROADMAP_CANVAS.md)
- [Future — Code generation](../docs/FUTURE_FEATURE_ROADMAP_CODE_GENERATION.md)
- [Future — Collaboration](../docs/FUTURE_FEATURE_ROADMAP_COLLABORATION.md)
- [Future — Connect](../docs/FUTURE_FEATURE_ROADMAP_CONNECT.md)
- [Future — Contracts](../docs/FUTURE_FEATURE_ROADMAP_CONTRACTS.md)
- [Future — Copilot](../docs/FUTURE_FEATURE_ROADMAP_COPILOT.md)
- [Future — Dashboard](../docs/FUTURE_FEATURE_ROADMAP_DASHBOARD.md)
- [Future — Database](../docs/FUTURE_FEATURE_ROADMAP_DATABASE.md)
- [Future — Data transform](../docs/FUTURE_FEATURE_ROADMAP_DATA_TRANSFORM.md)
- [Future — Detective](../docs/FUTURE_FEATURE_ROADMAP_DETECTIVE.md)
- [Future — DevEx](../docs/FUTURE_FEATURE_ROADMAP_DEVEX.md)
- [Future — Diff](../docs/FUTURE_FEATURE_ROADMAP_DIFF.md)
- [Future — Enterprise hub](../docs/FUTURE_FEATURE_ROADMAP_ENTERPRISE_HUB.md)
- [Future — Gateway](../docs/FUTURE_FEATURE_ROADMAP_GATEWAY.md)
- [Future — Git-like](../docs/FUTURE_FEATURE_ROADMAP_GITLIKE.md)
- [Future — Git-like improvements](../docs/FUTURE_FEATURE_ROADMAP_GITLIKE_IMPROVEMENTS.md)
- [Future — Governance](../docs/FUTURE_FEATURE_ROADMAP_GOVERNANCE.md)
- [Future — Import](../docs/FUTURE_FEATURE_ROADMAP_IMPORT.md)
- [Future — Insights](../docs/FUTURE_FEATURE_ROADMAP_INSIGHTS.md)
- [Future — Integrations](../docs/FUTURE_FEATURE_ROADMAP_INTEGRATIONS.md)
- [Future — Linting](../docs/FUTURE_FEATURE_ROADMAP_LINTING.md)
- [Future — Localization](../docs/FUTURE_FEATURE_ROADMAP_LOCALIZATION.md)
- [Future — Mock server](../docs/FUTURE_FEATURE_ROADMAP_MOCK_SERVER.md)
- [Future — Monetization](../docs/FUTURE_FEATURE_ROADMAP_MONETIZATION.md)
- [Future — Monitoring](../docs/FUTURE_FEATURE_ROADMAP_MONITORING.md)
- [Future — Mobile SDK](../docs/FUTURE_FEATURE_ROADMAP_MOBILE_SDK.md)
- [Future — Multi-protocol](../docs/FUTURE_FEATURE_ROADMAP_MULTI_PROTOCOL.md)
- [Future — Nginx](../docs/FUTURE_FEATURE_ROADMAP_NGINX.md)
- [Future — Offline](../docs/FUTURE_FEATURE_ROADMAP_OFFLINE.md)
- [Future — Package manager](../docs/FUTURE_FEATURE_ROADMAP_PACKAGE_MANAGER.md)
- [Future — Paths first](../docs/FUTURE_FEATURE_ROADMAP_PATHS_FIRST.md)
- [Future — Paths second](../docs/FUTURE_FEATURE_ROADMAP_PATHS_SECOND.md)
- [Future — Playground](../docs/FUTURE_FEATURE_ROADMAP_PLAYGROUND.md)
- [Future — Portal](../docs/FUTURE_FEATURE_ROADMAP_PORTAL.md)
- [Future — Predict](../docs/FUTURE_FEATURE_ROADMAP_PREDICT.md)
- [Future — Profile](../docs/FUTURE_FEATURE_ROADMAP_PROFILE.md)
- [Future — Roles](../docs/FUTURE_FEATURE_ROADMAP_ROLES.md)
- [Future — Schema showcase](../docs/FUTURE_FEATURE_ROADMAP_SCHEMA_SHOWCASE.md)
- [Future — Security](../docs/FUTURE_FEATURE_ROADMAP_SECURITY.md)
- [Future — Shield](../docs/FUTURE_FEATURE_ROADMAP_SHIELD.md)
- [Future — Sync](../docs/FUTURE_FEATURE_ROADMAP_SYNC.md)
- [Future — Template marketplace](../docs/FUTURE_FEATURE_ROADMAP_TEMPLATE_MARKETPLACE.md)
- [Future — Templates](../docs/FUTURE_FEATURE_ROADMAP_TEMPLATES.md)
- [Future — Tenancy](../docs/FUTURE_FEATURE_ROADMAP_TENANCY.md)
- [Future — Test lab](../docs/FUTURE_FEATURE_ROADMAP_TEST_LAB.md)
- [Future — Testing](../docs/FUTURE_FEATURE_ROADMAP_TESTING.md)
- [Future — UI](../docs/FUTURE_FEATURE_ROADMAP_UI.md)
- [Future — Validation](../docs/FUTURE_FEATURE_ROADMAP_VALIDATION.md)
