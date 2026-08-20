# SWIFT MT — `swift-mt`

Fixtures for **FMT-6.3** ([#5447](https://github.com/apiome/apiome/issues/5447)). Apiome reads ISO
20022 (MX) but not SWIFT MT, the legacy message set still in production through the CBPR+ coexistence
period. Owning both sides makes Apiome the workbench for the MT→MX migration every correspondent bank
is running. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** A `{1:` basic header block followed by `{2:` and a `{4:` text block terminated
by `-}`.

**Block structure**

| Block | Contents |
| --- | --- |
| `{1:}` | basic header — application id, service id, sender LT address, session/sequence |
| `{2:}` | application header — `I`/`O` direction, message type, receiver, priority |
| `{3:}` | user header — `{108:}` reference, `{111:}`/`{121:}` UETR, `{119:}` validation flag (e.g. `COV`) |
| `{4:}` | text — `:nn[a]:` tag fields, terminated by `-}` |
| `{5:}` | trailer — `{CHK:}`, `{MAC:}`, `{TNG:}` |

**Option letters matter.** `:50K:` (name and address) and `:50F:` (structured, numbered lines) are the
*same field* in different options, and `:57A:` (BIC) differs from `:57D:` (name/address). FMT-6.3
requires option letters and qualifiers to be modelled, not flattened to strings — that is what
`03` and `05` are for.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-mt103.txt` | minimal | Blocks 1, 2, 4 only; six fields. |
| `02-typical-mt103.txt` | typical | Full five-block message with user header, UETR, `:70:` remittance codes, `:72:` sender-to-receiver information. |
| `03-composition-mt202cov.txt` | composition | An **MT202 COV**: two `{4:}` sequences in one message — the cover payment plus the underlying customer credit transfer, with `50F`/`59F` structured parties. |
| `04-stress-mt940-statement.txt` | stress | Statement message: six `:61:` lines with different transaction type codes (`NTRF`, `NMSC`, `NCHG`, `NDDT`, `NSTO`, `NRTI` reversal), supplementary `/OCMT//CHGS/` subfields, multi-line `:86:` narratives, opening/closing/available balances. |
| `05-real-world-mt103-charges-chain.txt` | real-world | Cross-currency payment with an exchange rate (`:36:`), a full correspondent chain (`51A`/`52A`/`53B`/`54A`/`56A`/`57A`), itemized `71F`/`71G` charges, and regulatory reporting (`:77B:`). |
| `06-typical-mt942-interim.txt` | typical | Interim transaction report with a floor limit (`:34F:`) and debit/credit summary counts. |
| `07-cover-set/` | multi-file | An MT103 plus the MT202COV that covers it, linked only by field 21. |
| `negative/` | — | Unterminated block 4, a message with no `:20:`, truncation, an **ISO 20022 pacs.008** (the MX twin), UTF-16, and an unsupported MT type. |

**MT↔MX is a note, never a conversion.** FMT-6.3 records the correspondence between an MT message and
its MX counterpart as a *documented note* with a clear disclaimer. Nothing in this corpus asserts a
validated transformation, and the adapter must not claim one.
