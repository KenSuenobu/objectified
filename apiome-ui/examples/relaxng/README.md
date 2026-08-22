# RELAX NG — `relaxng`

Fixtures for **FMT-4.1** ([#5434](https://github.com/apiome/apiome/issues/5434)) — the other half of
XML schema. Apiome reads XSD and claims XML schema support; RELAX NG is the schema language of
DocBook, TEI, OpenDocument and a large body of publishing and government document standards, in two
interchangeable syntaxes: XML (`.rng`) and compact (`.rnc`). **Live** — the `relaxng` adapter reads
both, and every entry here is exercised by the corpus suites.

**Detection markers.** `.rng` detects as `relaxng`: root `grammar` or `element` in the
`http://relaxng.org/ns/structure/1.0` namespace. `.rnc` detects as `relaxng-compact`: a `start = …`
assignment or a line-leading `element … { … }` / `attribute … { … }` production, with no XML markup.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-note.rng` | minimal | Element-only pattern (no `grammar` wrapper), one attribute, `text`. |
| `02-typical-catalogue.rng` | typical | `grammar`/`start`/`define`/`ref`, `optional`, `zeroOrMore`, `choice` of values, `data` with `param`. |
| `03-modular-set/` | multi-file | `include` **with an override** plus `externalRef` — the two composition mechanisms, resolvable only across the set. |
| `04-stress-interleave-and-datatypes.rng` | stress | `interleave`, `mixed`, `list`, `data`/`except`, `anyName`/`nsName` wildcards, `empty`, recursion. |
| `05-real-world-article-grammar.rng` | real-world | Publishing house grammar: metadata header with `interleave`, recursive sections, mixed-content inline model, ID/IDREF citations. |
| `06-compact-catalogue.rnc` | typical | The compact syntax of `02` — both must produce the **same** canonical model. |
| `07-composition-named-pattern-reuse.rng` | composition | Named patterns combined by `ref`, a pattern assembled with `combine="choice"`, a shared attribute set. |
| `negative/` | — | Unclosed `define`, a grammar with no `start`, truncation, an XSD, UTF-16, and a `ref` to an undefined pattern. |

**Declared limits the capability registry carries.** `interleave` has no unordered-any-order
analogue in JSON Schema, and `except`/`anyName` wildcards and external datatype libraries are
partially representable at best. These are *declared* parsing limits, never silent omissions:
`relaxng.interleave`, `relaxng.name_class_wildcard`, `relaxng.datatype_except`,
`relaxng.external_datatype_library`, `relaxng.list`, `relaxng.mixed` and `relaxng.remote_href` are
published by `GET /v1/import/format-capabilities` and rendered per document as partially-mapped
coverage-ledger rows. RELAX NG **output** is a separate ticket (**#4134**), so the format is
import-only today.

`negative/03-truncated-mid-pattern.rng` is grounded at `INPUT_MALFORMED`, matching every other XML
adapter's truncated fixture: a document cut mid-attribute is rejected by the XML parser before any
RELAX NG semantics are reached. The intent is kept in its `failure_class`.
