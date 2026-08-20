# SEPA payment files — `sepa`

Fixtures for the European half of **FMT-6.6** ([#5450](https://github.com/apiome/apiome/issues/5450)).
SEPA rides ISO 20022, which Apiome **already reads**, so the ticket's scope here is *recognition and
routing*: a `pain.001` / `pain.008` / `pacs.008` document must route to the `iso20022` adapter with
its **message identifier recorded**, rather than to a new parser.

These entries therefore carry `adapter_key: null` today — they are the evidence the routing rule needs,
not a claim that a separate SEPA adapter should exist. When FMT-6.6 lands, the expected move is to
re-point them at `iso20022` (or fold the directory into `iso20022/`) rather than to register `sepa`.

**Detection marker.** `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:<msgid>">`, where `<msgid>` is
the identifier that must be recorded: `pain.001.001.09`, `pain.008.001.08`, `pacs.008.001.08`,
`camt.053.001.08`.

| File | Rung | Message | What it exercises |
| --- | --- | --- | --- |
| `01-minimal-pain001.xml` | minimal | pain.001 | One payment instruction, one transaction. |
| `02-typical-pain001-batch.xml` | typical | pain.001 | Salary batch: `PmtTpInf` service level and category purpose, batch booking, postal addresses, three transactions. |
| `03-composition-pain001-multi-pmtinf.xml` | composition | pain.001 | **Two** `PmtInf` blocks with different debtor accounts, priorities and local instruments, plus structured `RmtInf` referencing an invoice. |
| `04-stress-pain008-direct-debit.xml` | stress | pain.008 | Direct debits: `CORE` and `B2B` local instruments, `FRST`/`RCUR` sequence types, mandate information **with an amendment**, creditor scheme id, `NOTPROVIDED` agent. |
| `05-real-world-pacs008-interbank.xml` | real-world | pacs.008 | Interbank settlement with clearing system, UETR, intermediary and previous instructing agents, regulatory reporting, `InstrForCdtrAgt`. |
| `06-typical-camt053-statement.xml` | typical | camt.053 | Bank statement: balances (`OPBD`/`CLBD`), entries with bank transaction codes and `NtryDtls`. |
| `07-status-set/` | multi-file | A `pain.001` initiation plus the `pain.002` status report that accepts one transaction and rejects the other. |
| `negative/` | — | — | Unclosed element, a payment instruction with no transactions, truncation, a **NACHA ACH** file (the US twin, which must route to `nacha`), UTF-16, and an unpublished `.99` message version. |

**Privacy note.** Every IBAN here is either a published test value or synthetic, every name is
`Sample`/`Example`, and no fixture carries a real creditor identifier.
