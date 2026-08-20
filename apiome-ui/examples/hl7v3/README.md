# HL7 v3 / CDA — `hl7v3`

Fixtures for **FMT-6.4** ([#5448](https://github.com/apiome/apiome/issues/5448)). Apiome supports HL7
v2 and FHIR but not HL7 v3 / Clinical Document Architecture — the XML document standard required by
several national health programmes and still the format of record for clinical documents (CCD,
C-CDA). Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** Root element `ClinicalDocument` in the `urn:hl7-org:v3` namespace, with a
`typeId` of `2.16.840.1.113883.1.3` / `POCD_HD000040`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-clinical-document.xml` | minimal | Header (`id`, `code`, `effectiveTime`, `recordTarget`, `author`, `custodian`) plus one narrative-only section. |
| `02-typical-ccd.xml` | typical | A CCD: three sections with `templateId`s, narrative tables, `entry` acts and a `substanceAdministration`. |
| `03-composition-nested-entries.xml` | composition | `organizer` → `observation` → `entryRelationship` → `observation`, with `translation` codes and `referenceRange`. |
| `04-stress-rim-datatypes.xml` | stress | RIM data types: `II`, `CD`/`CE` with translations, `IVL_TS`, `AD` with `useablePeriod`, `PN` with qualifiers, `TEL`, `PQ`, `IVL_PQ`, `RTO_PQ_PQ`, `ST`, `ED` with a reference, `nullFlavor` at three levels, an `sdtc:` extension, `relatedDocument`. |
| `05-real-world-discharge-summary.xml` | real-world | Full discharge summary: `componentOf`/`encompassingEncounter`, `informationRecipient`, four sections including coded diagnoses and a procedure. |
| `06-typical-unknown-template.xml` | typical | Three `templateId`s, two of which no published guide defines — the unknown-template case. |
| `07-transmission-set/` | multi-file | An HL7 v3 transmission wrapper plus the CDA payload it carries. |
| `negative/` | — | Unclosed section, a header with no `recordTarget`/`author`/`custodian`, truncation, a **FHIR** `Composition` (the modern twin), UTF-16, and an entry whose narrative `reference` points at an anchor that does not exist. |

**Template ids are claims, not verdicts.** A `templateId` is what the document *asserts* it conforms
to. FMT-6.4 requires them recorded as asserted conformance claims with an explicit **"not validated"**
statement in the capability panel — an unknown OID must not fail the import, and a known OID must
never be presented as verified.
