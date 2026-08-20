# NCPDP SCRIPT and Telecommunication — `ncpdp`

Fixtures for **FMT-6.8** ([#5452](https://github.com/apiome/apiome/issues/5452)). NCPDP SCRIPT
(e-prescribing, XML) and NCPDP Telecommunication (pharmacy claims, a delimited/positional format) are
mandated in US pharmacy workflows. Narrow, but there is no competitor in our category. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Two sub-formats, one adapter.**

| Sub-format | Files | Detection marker |
| --- | --- | --- |
| SCRIPT | `.xml` | `Message`/`Messages` root in `http://www.ncpdp.org/schema/SCRIPT` with `Header` + `Body` |
| Telecom D.0 | `.dat` | a 56-character fixed transaction header (BIN, `D0`, transaction code) followed by `0x1D`-separated segments whose ids are `AM01`…`AM11`, fields introduced by `0x1C` |

> The `.dat` fixtures contain **real control characters** (`0x1C` field separator, `0x1D` group
> separator) because that is the format; they are ASCII otherwise and safe to read with `cat -v`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-newrx.xml` | minimal | A `NewRx` with the four required participants and one medication. |
| `02-typical-newrx.xml` | typical | Full `NewRx`: coded drug with strength and DB code, quantity with unit code, diagnosis, sig, substitutions, sender software. |
| `03-composition-rxchangerequest.xml` | composition | `RxChangeRequest` carrying **both** `MedicationPrescribed` and `MedicationRequested`, plus prior authorization and benefits coordination. |
| `04-stress-multiple-transactions.xml` | stress | Five transaction types in one document — `RxFill`, `RxRenewalRequest`, `CancelRx`, `Status`, `Error` — so transaction-type detection is exercised per message, not per file. |
| `05-real-world-telecom-b1-claim.dat` | real-world | A **B1 billing claim**: transaction header plus insurance, patient, claim, pricing and prescriber segments with their two-character field ids. |
| `06-typical-telecom-b2-reversal.dat` | typical | A **B2 reversal** — the same header shape with only the claim segment. |
| `07-transaction-set/` | multi-file | A `NewRx` plus the `Status` response tied to it by `RelatesToMessageID`. |
| `negative/` | — | Unclosed body, an empty `Body`, truncation, an **HL7 v2 `RDE^O11`** (the pharmacy-order neighbour the shipped `hl7v2` adapter owns), UTF-16, and a Telecom header whose version is not `D0`. |

**The honesty contract this corpus assumes.** As with every other vertical format: the transaction
type is detected and recorded, the capability panel names the supported versions, and it states
plainly that **no implementation guide was consulted** — a green import is not a compliance verdict.
