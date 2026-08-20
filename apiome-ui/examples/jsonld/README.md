# JSON-LD contexts — `jsonld`

Fixtures for the JSON-LD third of **FMT-9.4** ([#5471](https://github.com/apiome/apiome/issues/5471)).
A context is the mapping layer between JSON property names and IRIs: it names terms, gives them types
and containers, and is what makes a JSON document linked data. The sibling directories are `shacl/`
and `owl/`. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** A top-level `@context` object (or array), whose values are IRIs or term
definitions with `@id` / `@type` / `@container`.

**What the adapter takes from it.** Terms → property names; `@id` → the IRI kept as **provenance**;
`@type` → property type (`@id` for references, an `xsd:` datatype for scalars, `@json` for embedded
JSON); `@container` → cardinality and shape (`@set`/`@list` → arrays, `@language` → language maps,
`@index`/`@id`/`@type` → keyed maps); scoped contexts → nested type definitions.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-context.jsonld` | minimal | `@vocab`, two aliased keywords, one term. |
| `02-typical-context.jsonld` | typical | Typed terms (`@id`, `xsd:date`, `xsd:integer`), `@set` and `@list` containers, a language map, one scoped context. |
| `03-contexts-set/` | multi-file | A context **array** whose first entry is a sibling file — the terms only resolve across the set. |
| `04-stress-keyword-coverage.jsonld` | stress | Every container form (including a compound `["@index","@set"]`), `@reverse`, nested scoped contexts, `@protected`, `@prefix`, `@nest`, `@index` on a term, `@direction`, and `@base`/`@language` defaults. |
| `05-real-world-catalog-context.jsonld` | real-world | A data-catalogue context over DCAT/Dublin Core/SKOS/vCard: language-mapped titles, typed dates, `@set` collections, a scoped contact-point context. |
| `06-typical-document-with-context.jsonld` | typical | A context **plus** the `@graph` it describes — instance data, not only vocabulary. |
| `07-composition-context-array.jsonld` | composition | A three-element context array with nested scoped contexts and `@type: @vocab` value mapping. |
| `negative/` | — | Trailing comma, a document with no `@context`, truncation, a **JSON Schema**, UTF-16, and a context array whose remote and relative entries cannot be fetched. |

**Network boundary.** `negative/06` is the important one: remote contexts must be resolved under the
same SSRF guard as every other remote reference, and an unreachable context is a **named unresolved
reference**, never a silently empty term map.
