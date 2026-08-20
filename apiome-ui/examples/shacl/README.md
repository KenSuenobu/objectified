# SHACL shapes — `shacl`

Fixtures for the SHACL third of **FMT-9.4** ([#5471](https://github.com/apiome/apiome/issues/5471)).
SHACL is a constraint language directly comparable to JSON Schema, and it is how linked-data estates in
publishing, pharmaceuticals and government describe their data. The sibling directories are `jsonld/`
(contexts) and `owl/` (ontologies). Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `sh:NodeShape` / `sh:PropertyShape` with the `http://www.w3.org/ns/shacl#`
namespace, in Turtle (`.ttl`) or JSON-LD (`.jsonld`).

**Constraint mapping**

| SHACL | Canonical |
| --- | --- |
| `sh:NodeShape` + `sh:targetClass` | type |
| `sh:property` + `sh:path` | property |
| `sh:datatype` / `sh:class` / `sh:nodeKind` | property type |
| `sh:minCount` / `sh:maxCount` | required, cardinality |
| `sh:minInclusive` … `sh:maxExclusive` | numeric range |
| `sh:minLength` / `sh:maxLength` / `sh:pattern` | string constraints |
| `sh:in` | enum |
| `sh:node` | nested type reference |
| `sh:severity` / `sh:message` | lint severity and message |
| `sh:sparql`, `sh:zeroOrMorePath`, open-world targets | **declared limits** |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-shape.ttl` | minimal | One node shape, one property. |
| `02-typical-person-shapes.ttl` | typical | Two node shapes, cardinality, pattern, `sh:in`, severity and message, `sh:class` reference. |
| `03-composition-node-shapes.ttl` | composition | Reusable node shapes by `sh:node`, `sh:and`/`sh:or`/`sh:xone`, a sequence path and an inverse path. |
| `04-stress-constraint-components.ttl` | stress | Every core constraint component, all four target forms, `sh:closed`, qualified value shapes, property groups — then a **SPARQL constraint** and `sh:zeroOrMorePath` as declared limits. |
| `05-real-world-dataset-shapes.ttl` | real-world | A data-catalogue publication profile over DCAT/Dublin Core with ordered properties and per-rule messages. |
| `06-typical-shapes.jsonld` | typical | The **JSON-LD** serialization of a shapes graph — same model, different syntax. |
| `07-stress-cyclic-shape-graph.ttl` | stress | Three cycles (mutual `sh:node`, mutual `sh:or`, self-reference). SHACL leaves recursion undefined, so the reader must terminate and **say so**. |
| `08-imported-shapes-set/` | multi-file | A shapes graph that pulls a shared module in with `owl:imports` and constrains through it. |
| `negative/` | — | Missing final `.`, a Turtle file with no shapes, truncation, an **OWL ontology**, UTF-16, and `sh:node` pointing at a shape that does not exist. |

**Open-world boundary.** Apiome's model is closed-world. SHACL targets (`sh:targetSubjectsOf`,
`sh:targetObjectsOf`) select nodes by graph shape rather than by declaration, and FMT-9.4 requires that
gap declared explicitly — pretending otherwise would be wrong.
