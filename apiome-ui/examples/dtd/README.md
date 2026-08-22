# DTD — `dtd`

Fixtures for **FMT-4.2** ([#5435](https://github.com/apiome/apiome/issues/5435)) — a small parser with
a large legacy reach: older EDI-XML profiles, publishing pipelines, and configuration formats.
**Live** — the `dtd` adapter reads external subsets, internal subsets and modular sets, and every
entry here is exercised by the corpus suites.

**Detection markers.** A `.dtd` file whose first construct is a markup declaration (`<!ELEMENT …>` /
`<!ATTLIST …>` / `<!ENTITY …>` / `<!NOTATION …>`), or an XML document whose `<!DOCTYPE …[ … ]>`
internal subset declares at least one element. An *entity-only* `DOCTYPE` — the shape a hostile XSD,
WSDL or ISO 20022 message uses to smuggle an expansion bomb — is deliberately **not** claimed: those
documents belong to their own adapters, whose hardened XML readers reject them.

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
without being bombs; the unbounded cases live in the generated adversarial corpus
(`scripts/generate_adversarial_corpus.py` — `dtd-billion-laughs.dtd` and
`dtd-parameter-entity-bomb.dtd` under guard `xml-entity-expansion`, `dtd-recursive-entity.dtd` under
`reference-recursion`), not in a committed fixture. Expansion is charged against one budget in three
dimensions — reference count, produced bytes and nesting depth — by *both* the parameter-entity input
stack and general-entity value expansion, so a document cannot move work between the two mechanisms
to spend past a guard; an entity that re-enters its own expansion chain is refused as an unsafe
construct rather than unrolled. External subsets resolve only inside the uploaded set, under the same
SSRF guard as the XSD and RELAX NG paths: an absolute URL is vetted for shape and then *recorded*,
never fetched.

**Declared limits the capability registry carries.** Mixed content, `ANY`, an occurrence indicator on
a group, the tokenized attribute types, `ID`/`IDREF` identity, an unparsed entity, an `<!ATTLIST>` for
an element that is never declared, and an unfetched system identifier are *declared* parsing limits,
never silent omissions: `dtd.mixed_content`, `dtd.any_content`, `dtd.repeated_group`,
`dtd.tokenized_attribute`, `dtd.id_uniqueness`, `dtd.unparsed_entity`, `dtd.orphan_attlist` and
`dtd.remote_system_id` are published by `GET /v1/import/format-capabilities` and rendered per document
as partially-mapped coverage-ledger rows. Mixed content is *both* modelled — its children become
repeated members beside a `#text` member — and declared, because only the interleaving is
inexpressible. DTD **output** is not implemented, so the format is import-only today.
