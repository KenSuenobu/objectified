# RELAX NG — `relaxng`

Fixtures for **FMT-4.1** ([#5434](https://github.com/apiome/apiome/issues/5434)) — the other half of
XML schema. Apiome reads XSD and claims XML schema support; RELAX NG is the schema language of
DocBook, TEI, OpenDocument and a large body of publishing and government document standards, in two
interchangeable syntaxes: XML (`.rng`) and compact (`.rnc`). Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection markers.** `.rng`: root `grammar` or `element` in the `http://relaxng.org/ns/structure/1.0`
namespace. `.rnc`: a `start = …` / `element … { … }` grammar with optional `datatypes` and `namespace`
declarations.

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

**Declared limits the capability registry must carry.** `interleave` has no unordered-any-order
analogue in JSON Schema, and `except`/`anyName` wildcards and external datatype libraries are
partially representable at best. FMT-4.1 requires these to be *declared* parsing limits, never silent
omissions. RELAX NG **output** is a separate ticket (**#4134**).
