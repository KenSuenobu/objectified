# DICOM — `dicom`

Fixtures for **FMT-6.7** ([#5451](https://github.com/apiome/apiome/issues/5451)). DICOM is the imaging
half of healthcare and sits beside FHIR in every hospital estate; its information model — SOP classes,
IODs, modules, attributes with tags and value representations — is a genuine schema that nothing in
the API-catalog market describes. Entries carry `adapter_key: null` and the `pending-adapter` tag.

> **Pixel data is never read, never stored, never analyzed.** This is a schema importer, not an image
> tool. `04-stress-part10-sequences-and-pixeldata.dcm` deliberately *contains* a `(7FE0,0010)` element
> — eight bytes of zeros — so the test suite can assert that the importer skips it and **states** the
> skip rather than implying the file had none.

**Two forms.**

| Form | Files | Detection marker |
| --- | --- | --- |
| Part 10 | `.dcm` | 128-byte preamble + `DICM` magic at offset 128, then the `(0002,xxxx)` file meta group |
| DICOM JSON (PS3.18 Annex F) | `.json` | object keys that are 8 hex digits, each value carrying `vr` and `Value`/`BulkDataURI` |

The `.dcm` fixtures here are **synthetic**: written byte by byte in explicit VR little endian
(`1.2.840.10008.1.2.1`) by the corpus authoring script, with no patient-identifying content and no
real image data. Every UID is under a documentation-only root.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-json.json` | minimal | Seven attributes: SOP class/instance, modality, patient, study, series. |
| `02-typical-ct-instance-json.json` | typical | A CT instance's module set — patient, study, series, image plane, image pixel (descriptors only), rescale. |
| `03-composition-structured-report-json.json` | composition | An SR **content tree**: `ContentSequence` nested three deep, `CONTAINER`/`CODE`/`TEXT`/`NUM` value types, coded concept names, measured value with units. |
| `04-stress-part10-sequences-and-pixeldata.dcm` | stress | Binary Part 10: file meta group, multi-valued `CS`, nested sequences, a private block (`0009,10xx` with `UN`), and pixel data that must be skipped. |
| `05-real-world-mr-series-json.json` | real-world | An MR instance as a scanner writes it: acquisition parameters, frame of reference, referenced performed procedure step, window centre/width. |
| `06-typical-part10-minimal.dcm` | typical | The smallest valid Part 10 file — preamble, meta group, eight dataset elements. |
| `07-study-set/` | multi-file | A study-level query result plus one instance from each of its two series. |
| `negative/` | — | Broken JSON, a dataset with no SOP Class UID, a `.dcm` truncated mid-element, a **FHIR `ImagingStudy`**, UTF-16, and a `.dcm` whose magic is not `DICM`. |

**Contract the adapter must meet.** Attributes normalize to canonical properties keyed by tag with the
VR as the type; nested sequences become nested types; no patient-identifying attribute value is stored
at the default value-visibility policy; and the capability panel states the pixel-data boundary
explicitly.
