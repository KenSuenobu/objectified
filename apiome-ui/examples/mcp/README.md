# MCP static server manifest — `mcp`

Fixtures for **FMT-1.7** ([#5418](https://github.com/apiome/apiome/issues/5418)) — cataloging an
MCP server from a static descriptor instead of a live probe. No adapter is registered yet, so every
entry carries `adapter_key: null` and the `pending-adapter` feature tag.

**Shape.** A manifest is the paginated discovery result flattened into one document: server identity,
declared `capabilities`, and the `tools` / `resources` / `resourceTemplates` / `prompts` arrays with
their JSON Schemas. `transport` records how the same server would be reached live.

**Detection marker.** Top-level `mcpVersion` (or `protocolVersion`) beside a `tools` array whose
members carry `name` + `inputSchema`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-echo-tool.json` | minimal | One tool, one required string argument. |
| `02-typical-tickets-server.json` | typical | Tools + resources + resource templates + prompts, with annotations. |
| `03-composition-shared-schemas.json` | composition | `$defs` reused by `$ref` across tool input and output schemas. |
| `04-stress-grammar-corners.json` | stress | `oneOf`/`anyOf` arguments, `outputSchema`, `_meta`, experimental capabilities, RFC 6570 URI template. |
| `05-real-world-filesystem-server.json` | real-world | Reconstruction of the reference filesystem server's nine-tool surface. |
| `06-split-set/` | multi-file | Manifest whose schemas live in a sibling file, reached by relative `$ref`. |
| `negative/` | — | Trailing comma, tools with no `inputSchema`, truncation, an OpenAPI document, UTF-16. |

**Contract the adapter must meet.** Paradigm `agent`; a manifest and a live probe of the same server
must produce the *same* surface fingerprint, with manifest facts recorded as `declared` provenance
and probe facts as `observed`.
