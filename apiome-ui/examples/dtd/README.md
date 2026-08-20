# DTD — `dtd`

Fixtures for **FMT-4.2** ([#5435](https://github.com/apiome/apiome/issues/5435)) — a small parser with
a large legacy reach: older EDI-XML profiles, publishing pipelines, and configuration formats. Entries
carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** A `.dtd` file of `<!ELEMENT …>` / `<!ATTLIST …>` / `<!ENTITY …>` declarations,
or an XML document whose `<!DOCTYPE …[ … ]>` carries an internal subset.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-note.dtd` | minimal | One `#PCDATA` element and one `ID` attribute. |
| `02-typical-catalogue.dtd` | typical | Sequence and occurrence indicators, enumerated attributes, `#REQUIRED`/`#IMPLIED`/`#FIXED`/default values. |
| `03-modular-set/` | multi-file | An external subset assembled from two modules through parameter entities — how DocBook, JATS and TEI are actually organized. |
| `04-stress-content-models-and-entities.dtd` | stress | `ANY`, `EMPTY`, mixed content, choice groups, parameter entities as model fragments, a bounded three-level general-entity chain, `NOTATION` + unparsed `ENTITY`, `NMTOKENS`, `ENTITY` attribute type. |
| `05-real-world-rss-2.0-subset.dtd` | real-world | A syndication feed DTD: optional-heavy channel, repeated items, `#FIXED` version attribute. |
| `06-internal-subset-invoice.xml` | typical | The DTD carried *inside* an instance document, with a general entity used in content. |
| `07-composition-parameter-entities.dtd` | composition | Parameter entities as reusable attribute sets and content-model fragments, one built from three others. |
| `negative/` | — | Unterminated declaration, an undeclared element referenced in a content model, truncation, a RELAX NG grammar, UTF-16, and a parameter entity pointing at a file that is not in the set. |

**Security boundary.** This parser is a direct billion-laughs target. The entity chains here are
deliberately **bounded and non-recursive** (three levels, fixed fan-out) so they exercise expansion
without being bombs; the unbounded cases belong in the generated adversarial corpus
(`scripts/generate_adversarial_corpus.py`, guard `xml-entity-expansion`), not in a committed fixture.
FMT-4.2 requires expansion to be bounded and never recursive, and external subsets to be resolved
under the same SSRF guard as the XSD path.
