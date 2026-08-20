# TypeScript type declarations — `typescript-types`

Fixtures for **FMT-8.1** ([#5462](https://github.com/apiome/apiome/issues/5462)) — the largest
population of hand-written schemas in the world, and none of them are in any catalog. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `.ts` / `.d.ts` files whose top level is `export interface` / `export type` /
`export enum` declarations. A module that imports `zod` belongs to `zod/`, not here — see
`negative/04`.

**Subset boundary.** FMT-8.1 models primitives, literals, unions, intersections, arrays, tuples,
index signatures, optional/readonly modifiers, enums, and generics **resolved at their instantiation**.
Conditional types, mapped types, template-literal types, declaration merging and unresolved generics
are explicitly out of scope and must be **declared parsing limits — never silently flattened to
`any`**. `04-stress-type-system.ts` is organised around exactly that divider.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-model.d.ts` | minimal | One interface, two primitive fields. |
| `02-typical-order-model.ts` | typical | Literal union, optional and nullable fields, arrays of interfaces, `readonly`, `Pick`/`Omit`. |
| `03-modules-set/` | multi-file | Three modules with `import type` across them and a re-exporting index — the type graph only closes across the set. |
| `04-stress-type-system.ts` | stress | Everything in the subset, then everything outside it, in labelled halves. |
| `05-real-world-api-client-types.d.ts` | real-world | A published client package's `.d.ts`: money, addresses, request/response pairs, a generic `Paginated<T>` instantiated twice, a discriminated error union. |
| `06-typical-discriminated-unions.ts` | typical | A webhook event union discriminated on `type`, with a shared envelope interface and an indexed access type. |
| `07-composition-inheritance.ts` | composition | Extension from two interfaces, an intersection alias, a locally instantiated generic. |
| `negative/` | — | Missing brace, a module that exports no types, truncation, a **Zod** module (which belongs to the `zod` adapter), UTF-16, and an `import type` from a module that is not in the set. |

**Toolchain rule.** The extractor runs the TypeScript compiler API in the Node toolchain sandbox — the
same runner as `asyncapi-parse.mjs` — and must follow the **FMT-1.3 packaging rule**: no runtime
`available: false`.
