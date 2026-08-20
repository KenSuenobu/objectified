# CICS BMS maps — `cics-bms`

Fixtures for the BMS half of **FMT-11.3** ([#5484](https://github.com/apiome/apiome/issues/5484)). A
BMS mapset defines the 3270 screen field layout that is, in practice, **the API of a green-screen
transaction**. The VSAM half lives in `vsam-idcams/`. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection marker.** Assembler macro source with `DFHMSD` / `DFHMDI` / `DFHMDF` in the operation
field, a label in columns 1-8, and `X` continuations in column 72.

**Mapping**

| BMS | Canonical |
| --- | --- |
| `DFHMSD` | mapset — the container, plus `LANG` and `MODE` (`IN`, `OUT`, `INOUT`) |
| `DFHMDI` | map — one screen; `SIZE=(rows,cols)` is its geometry |
| `DFHMDF` with a label | field/property; unlabelled `DFHMDF` is a **literal**, not data |
| `POS=(row,col)` | field position, from which the record offset follows |
| `LENGTH` | field length |
| `PICIN` / `PICOUT` | input and output pictures — the type, per direction |
| `ATTRB=(PROT/UNPROT, NUM, BRT/NORM/DRK, ASKIP, IC, FSET)` | **declared metadata**: writability, numeric-only, visibility, initial cursor |
| `OCCURS=n` | repeating field → array |
| `GRPNAME` | field group |
| `COLOR`, `HILIGHT`, `VALIDN` | extended attributes, declared metadata |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-mapset.bms` | minimal | One map, one literal, one input field. |
| `02-typical-enquiry-map.bms` | typical | Labelled input and output fields, `PICIN`/`PICOUT`, an edited numeric picture, a message line, colour. |
| `03-mapset-and-copybook-set/` | multi-file | The mapset **plus** its generated symbolic map copybook — screen positions in one file, the record layout the program uses in the other. |
| `04-stress-field-attributes.bms` | stress | Every `ATTRB` combination, extended colour/highlight/validation, `OCCURS`, `GRPNAME`, unnamed literal fields, and a second map at a different size and origin. |
| `05-real-world-order-entry-mapset.bms` | real-world | Three maps of one transaction: customer header, a repeating eight-line detail table, and a confirmation pop-up. |
| `06-typical-dsect-copybook.cpy` | typical | A standalone BMS-generated symbolic map: the `L`/`F`/`A`/`I` field triples and the `-I`/`-O` redefinition pair. |
| `07-composition-map-inheritance.bms` | composition | Shared screen chrome repeated across two derived maps, mapset defaults, and a field group. |
| `negative/` | — | A continuation with no `X`, a map with no fields, truncation, an **IDCAMS** cluster definition (the sibling format), UTF-16, and fields that overlap or fall outside the declared screen. |

**The screen is not the schema.** A map gives field names, lengths, positions and pictures — and says
nothing about validation rules, business meaning or what the transaction does with them. FMT-11.3
requires field attributes carried as **declared metadata**, not inferred semantics.
