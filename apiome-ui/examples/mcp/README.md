# MCP static server manifest — `mcp`

Fixtures for **FMT-1.7** ([#5418](https://github.com/apiome/apiome/issues/5418)) — cataloging an
MCP server from a static descriptor instead of a live probe. The `mcp` adapter
(`app.mcp_import_source`) claims every entry here.

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

**The contract the adapter meets.** Paradigm `agent`. The declared surface is built by
`app.mcp_manifest_parser.manifest_surface`, which hands the manifest's verbatim wire entries to the
*same* `DiscoverySurface` constructor live discovery uses — so a manifest and a probe of one server
produce one fingerprint rather than two that happen to agree. Manifest facts are stamped `declared`
and probe facts `observed`; `app.mcp_surface_provenance` attributes each fact to one, the other, or
both, and reports a disagreement as a conflict rather than picking a winner.

**Two normalization rules the fixtures pin down.** Document-level `$defs` (03) and cross-file `$ref`s
(06) are **inlined**, because a live server returns each `inputSchema` self-contained and nothing on
the wire carries a document-level definition map. And the manifest is parsed as **JSON only** — no
YAML fallback — because YAML accepts the trailing comma in `negative/01`, which no MCP client would.
