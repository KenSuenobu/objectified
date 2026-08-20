# OWL / RDFS ontologies — `owl`

Fixtures for the OWL/RDFS third of **FMT-9.4** ([#5471](https://github.com/apiome/apiome/issues/5471)).
Class and property hierarchies import as canonical types with inheritance where expressible. The
sibling directories are `shacl/` (shapes) and `jsonld/` (contexts). Entries carry `adapter_key: null`
and the `pending-adapter` tag.

**Detection markers.** `owl:Ontology` / `owl:Class` / `owl:ObjectProperty` / `owl:DatatypeProperty`
in the `http://www.w3.org/2002/07/owl#` namespace — Turtle (`.ttl`) or RDF/XML (`.owl`).

**Mapping**

| OWL / RDFS | Canonical |
| --- | --- |
| `owl:Class` | type |
| `rdfs:subClassOf` (named superclass) | inheritance |
| `owl:DatatypeProperty` + `rdfs:domain`/`rdfs:range` | property with a scalar type |
| `owl:ObjectProperty` + `rdfs:domain`/`rdfs:range` | relationship |
| `owl:FunctionalProperty` | maxCount 1 |
| `owl:Restriction` cardinalities | minCount / maxCount |
| `owl:oneOf` over individuals | enum |
| `rdfs:label` / `rdfs:comment` | name and description |
| `owl:unionOf`, `owl:intersectionOf`, `owl:complementOf`, `someValuesFrom`/`allValuesFrom`, property chains, `owl:sameAs` | **declared limits** |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-ontology.ttl` | minimal | Ontology header, one class, one datatype property. |
| `02-typical-classes-and-properties.ttl` | typical | A class hierarchy, object and datatype properties with domain/range, `owl:inverseOf`, `owl:FunctionalProperty`, `owl:disjointWith`, named individuals as a code list. |
| `03-imports-set/` | multi-file | `owl:imports` — the importing ontology's classes only resolve once the imported one is present. |
| `04-stress-owl-constructs.ttl` | stress | Qualified cardinality restrictions, `owl:oneOf`, datatype restrictions with `withRestrictions` — then unions, intersections, complements, quantification, every property characteristic, a property chain, and `owl:sameAs`/`equivalentClass` as declared limits. |
| `05-real-world-domain-ontology.ttl` | real-world | A regulated-industry domain ontology: versioned and licensed, disjoint subclasses, cardinality-restricted case class, SKOS-backed code lists, language-tagged labels. |
| `06-typical-rdfxml.owl` | typical | The **RDF/XML** serialization — same model, the syntax OWL tools export. |
| `07-composition-class-hierarchy.ttl` | composition | A three-level class hierarchy where each level adds restrictions, plus `rdfs:subPropertyOf`. |
| `negative/` | — | Unterminated IRI, an ontology header with no vocabulary, truncation, a **SHACL shapes graph** (same syntax, different namespace), UTF-16, and an `owl:imports` that cannot be resolved. |

**Open-world boundary.** OWL is open-world and inference-driven; Apiome's model is closed-world.
FMT-9.4 requires that gap **declared explicitly** — an ontology's inferred consequences are not
imported, and pretending otherwise would be wrong.
