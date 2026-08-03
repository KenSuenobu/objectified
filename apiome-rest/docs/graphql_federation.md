# GraphQL Federation import (IXH-7.6)

The GraphQL adapter understands **Apollo Federation** artifacts in both shapes a
federated deployment produces, and carries subgraph ownership through the
canonical model so diff and lint can answer *"which subgraph broke the
supergraph?"*. The implementation lives in `app/graphql_federation.py`, wired
into the existing MFI-10.x parser → normalizer → emitter chain.

## What imports

| Input | How it is recognized | Ownership source |
| --- | --- | --- |
| **Supergraph SDL** (one file) | Apollo `join`-spec machinery: the `join__Graph` enum, `@join__type` / `@join__field` applications | `@join__type(graph:)` per type, `@join__field(graph:)` per field (a field with no `@join__field` inherits its type's owners; `external: true` entries are references, not ownership) |
| **Subgraph set** (fileset) | Federation directives (`@key`, `@external`, `@shareable`, …) or a federation `@link` on any member | File boundaries: a type is owned by every file that defines/extends it, a field by the file(s) that declare it (`@external` stubs excluded) |
| **Single subgraph SDL** | same markers | The one file (named from its label/file stem) |

Hand-written subgraph SDL applies `@key` et al. *without defining them* (the
Apollo build injects the definitions). The parser now folds in exactly the
missing Federation v2 definitions (`federation_prelude_document`) before
`validate_sdl`, so real-world subgraph files build cleanly; author-written
definitions are never overridden, and plain/supergraph SDL is untouched.

## Canonical model shape

* `CanonicalApi.extras["federation"]` — `{"role": "supergraph"|"subgraph",
  "subgraphs": [{"name", "url"?}, …]}`.
* `Type` / `CanonicalField` / `Service` / `Operation` `extras["subgraphs"]` —
  sorted owning subgraph names (only on owned entities; join/link machinery
  types carry none).
* `CanonicalApi.extras["directives"]` — schema-level applied directives
  (`@link(...)`), mirroring the per-entity `extras["directives"]` convention.
* `CanonicalApi.raw` (fingerprint-excluded) — `"sdl"` now keeps applied
  directives (see below); a subgraph set adds `"subgraphs"` (name → original
  SDL) and, when the bundled `rover` produced a verdict, `"composition"`.

Ownership extras participate in the fingerprint, so a field moving between
subgraphs is a semantic change.

## Directive preservation

`graphql.print_schema` prints directive *definitions* but silently drops
*applications* — which used to strip `@key` / `@join__type` / `@link` from
every stored SDL and every GraphQL export:

* **import side** — `print_schema_with_directives(schema)` re-prints a built
  schema with applications restored from its AST nodes; the parser uses it for
  `GraphQlParseResult.sdl` and the normalizer for `raw["sdl"]`.
* **emit side** — the emitter rebuilds custom directive definitions from
  `extras["directive_definitions"]` as real `GraphQLDirective`s and re-attaches
  the per-entity `extras["directives"]` strings onto the printed SDL
  (`attach_directive_applications`), validating the result and falling back
  (with a recorded `Loss`) rather than ever emitting unbuildable SDL.

A GraphQL→GraphQL round-trip of a supergraph is canonical-diff clean.

## Diff attribution

`GraphQlDiffLabeler` (in `app/graphql_diff.py`, the first provider on the
`DiffLabeler` SPI) labels every change with its owning subgraph(s), read from
the change payload's `extras["subgraphs"]`:

* `owned by subgraph 'reviews'` for additions/removals/modifications;
* `subgraph ownership: products → reviews` when ownership itself moved;
* no label for non-federated schemas.

## Composition validation (`composition` lint dimension)

Four rules in the GraphQL rule pack, all severity `error`, category
`composition`, each finding naming the offending subgraph:

| Rule | Check |
| --- | --- |
| `graphql.composition-invalid-key` | `@key(fields:)` selects a field the type does not declare in that subgraph (or does not parse) |
| `graphql.composition-non-shareable-field` | a field resolved by >1 subgraph without `@shareable` everywhere (key fields, `@external` stubs, and root types exempt) |
| `graphql.composition-unresolvable-selection` | `@requires`/`@provides` selects fields no subgraph declares |
| `graphql.composition-error` | errors reported by `rover supergraph compose` at import time |

The first three are pure Python over `raw["subgraphs"]` (they no-op for
non-federated models and `include_raw=False`). The `rover` rule surfaces the
verdict captured by `GraphQlImportSource.parse_fileset`, which runs the bundled
`rover` (MFI-5.2, key `rover`, override `APIOME_ROVER_BIN`) on the gRPC-style
worker-loop bridge (`compose_subgraphs_sync`) — degrading to "no verdict" when
the tool or its composition plugin is unavailable (the sandbox has no network),
never failing the import.

Federation spec-machinery names (`join__Graph`, `link__Purpose`, …) are exempt
from the GraphQL naming rules so a supergraph does not import with deterministic
naming noise.

## Corpus

`apiome-ui/examples/graphql/13-federation-set/` (products / reviews / inventory,
`multi-file` rung, composition-clean) and
`14-federation-supergraph.graphql` (`composition` rung). The supergraph's
manifest entry notes the pre-existing greedy-sniffer ranking upset (flatbuffers
claims the `join__Graph` enum block at 0.96); the graphql adapter itself claims
both shapes at 0.9.

Tests: `tests/test_graphql_federation.py`.
