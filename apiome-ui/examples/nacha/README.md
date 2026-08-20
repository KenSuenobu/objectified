# NACHA ACH — `nacha`

Fixtures for the ACH half of **FMT-6.6** ([#5450](https://github.com/apiome/apiome/issues/5450)). An
ACH file is fixed-width: **every record is exactly 94 characters**, and the file is blocked at ten
records with `9`-filler. The SEPA half of the same ticket lives in `sepa/`, because it routes to the
shipped ISO 20022 adapter rather than to a new parser. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection marker.** A first line of exactly 94 characters beginning `1` with `094` at columns 34-36
and `10` (blocking factor) at 37-38, followed by `5`/`6`/`8`/`9` record types.

**Record types**

| Code | Record | Key fields |
| --- | --- | --- |
| `1` | File header | immediate destination/origin, file creation date/time, record size `094` |
| `5` | Batch header | service class (200/220/225), company name and id, **SEC code**, entry description, effective date |
| `6` | Entry detail | transaction code, RDFI routing + check digit, DFI account, amount, individual id/name, addenda indicator, trace |
| `7` | Addenda | addenda type (`05`), 80 characters of payment-related information |
| `8` | Batch control | entry/addenda count, entry hash, total debit, total credit |
| `9` | File control | batch count, block count, entry/addenda count, entry hash, totals |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-ppd-credit.ach` | minimal | One PPD credit, one batch, correct block padding. |
| `02-typical-ppd-batch.ach` | typical | Four entries including a prenote/return transaction code, mixed routing numbers. |
| `03-composition-ccd-with-addenda.ach` | composition | CCD entries each carrying an `05` addenda record with an `RMR` remittance segment. |
| `04-stress-multi-batch-sec-codes.ach` | stress | Four batches — PPD, CCD, WEB, TEL — two service classes, savings-account transaction codes, addenda, file-id modifier and reference code. |
| `05-real-world-payroll-and-tax.ach` | real-world | Eight-employee payroll credit batch plus a `TXP` tax-payment debit batch in one file. |
| `06-stress-control-total-mismatch.ach` | stress | Batch and file control records that declare the wrong count, hash and totals. This must **import with warnings** showing declared *and* observed values — not reject. |
| `07-return-set/` | multi-file | A forward PPD file plus the return file that sends one of its entries back with an R03 addenda. |
| `negative/` | — | A record that is not 94 characters, a batch with no entries, truncation, a **SEPA `pain.001`** (which must route to `iso20022`, not here), UTF-16, and an addenda record that precedes any entry. |

**The honesty contract this corpus assumes.** Following the X12 control-total contract exactly:
declared-versus-observed batch and file totals, both shown; the entry hash recomputed rather than
trusted; and account numbers governed by the same value-visibility policy as every other payment
format.
