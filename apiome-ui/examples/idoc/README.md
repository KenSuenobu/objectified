# SAP IDoc — `idoc`

Fixtures for **FMT-6.2** ([#5446](https://github.com/apiome/apiome/issues/5446)). IDoc is how SAP
systems exchange business documents, and every SAP integration vendor lists it first. Structurally it
is a control record plus hierarchical data segments with fixed-width fields — very close to the COBOL
copybook and X12 work already shipped. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Two forms, one canonical model.** Both must import to the same thing:

| Form | Shape | Detection marker |
| --- | --- | --- |
| Flat file | 524-byte `EDI_DC40` control record, then `EDI_DD40` data records: 63-byte header (`SEGNAM` 30, `MANDT` 3, `DOCNUM` 16, `SEGNUM` 6, `PSGNUM` 6, `HLEVEL` 2) + 1000-byte `SDATA` | a line starting `EDI_DC40` at offset 0 |
| XML | `<IDOCTYP>` root → `<IDOC>` → `<EDI_DC40>` + `E1…`/`Z1…` segments | root element named for the basic type with an `<EDI_DC40>` child |

**Hierarchy comes from the numbers, not the order.** In the flat form the parent of a segment is
`PSGNUM` (its parent's `SEGNUM`), with `HLEVEL` as the depth; `PSGNUM = 000000` means top level. The
XML form nests the same relationships. A reader that assumes a flat list is wrong — `04` and the
`E1EDKT1`/`E1EDKT2` chains in `03` exist to catch that.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-xml-orders05.xml` | minimal | Control record plus one header segment. |
| `02-typical-xml-orders05.xml` | typical | ORDERS05 with partners, dates, two items and their child segments, summary. |
| `03-composition-xml-nested-segments.xml` | composition | Three-level nesting (`E1EDK01` → `E1EDKA1` → `E1EDKA3`, `E1EDKT1` → `E1EDKT2`), an extension type (`CIMTYP`), repeated qualifier segments. |
| `04-stress-flat-multi-idoc.txt` | stress | **Two IDocs in one flat file**, deep `PSGNUM`/`HLEVEL` hierarchy, a test flag, EDI standard fields (`STD`/`STDVRS`), an item with quantity zero and an empty material number. |
| `05-real-world-xml-invoic02.xml` | real-world | INVOIC02 as an SAP estate emits it: VAT per line, payment terms, incoterms, three `E1EDS01` summary rows. |
| `06-typical-flat-orders05.txt` | typical | The flat twin of `02` — same document, byte-exact record layout. |
| `07-with-definition-set/` | multi-file | A custom `ZCUSTMAS01` flat IDoc plus the **segment definition** file that says where its `SDATA` fields start and end. |
| `negative/` | — | Unclosed segment, an IDoc with no `EDI_DC40`, truncation, an EDIFACT interchange, UTF-16, and a control record that is too short to cut. |

**Contract the adapter must meet.** Control-record metadata (message type, basic type, partner) is
recorded as **structure**, never as redactable payload value; field offsets are computed under stated
assumptions, mirroring the copybook analyzer's "what these byte counts assume" contract; and the
segment hierarchy is reconstructed from segment numbers rather than assumed flat.
