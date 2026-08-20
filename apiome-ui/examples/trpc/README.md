# tRPC routers — `trpc`

Fixtures for **FMT-8.3** ([#5464](https://github.com/apiome/apiome/issues/5464)). tRPC is type-safe RPC
with **no IDL whatsoever** — the contract exists only as TypeScript types across a router definition.
Its users have literally nothing to hand a catalog, and no competitor reads it. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `initTRPC` from `@trpc/server`, plus an exported `t.router({ … })` whose values
are `t.procedure…query/mutation/subscription` chains.

**Normalization contract**

| tRPC | Canonical |
| --- | --- |
| procedure key path (`invoice.list`) | operation id / group + name |
| `.query()` | `QUERY` operation kind |
| `.mutation()` | `MUTATION` operation kind |
| `.subscription()` | `SUBSCRIPTION` operation kind |
| `.input(zodSchema)` | request schema, resolved through the **FMT-8.2 Zod path** |
| `.output(zodSchema)` | response schema |
| nested `t.router({...})` | operation group hierarchy |
| `.input(fn)` (non-Zod) | **declared limit** — no schema to extract |
| `.use(middleware)`-derived context | not a request field; must not be modelled as one |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-router.ts` | minimal | One query with a Zod input. |
| `02-typical-order-router.ts` | typical | Four procedures across query and mutation, inputs and outputs, shared schemas, typed context. |
| `03-routers-set/` | multi-file | A root router merging two feature routers whose schemas live in a third module. |
| `04-stress-procedure-forms.ts` | stress | No-input query, `.meta()`, middleware-protected builder, **chained `.input()`**, a subscription, a **non-Zod validator**, an inline nested router. |
| `05-real-world-app-router.ts` | real-world | A production app router: session middleware, shared pagination input, three feature routers, consistent output schemas, `TRPCError` codes. |
| `06-typical-nested-routers.ts` | typical | Three-level nesting plus a top-level procedure — the grouping an importer must flatten into paths. |
| `07-composition-shared-builders.ts` | composition | Shared schemas and middleware-composed procedure builders, two feature routers merged. |
| `negative/` | — | Unclosed router, a router with no procedures, truncation, a plain **Zod** module (no router), UTF-16, and a router whose inputs are all hand-written functions. |
