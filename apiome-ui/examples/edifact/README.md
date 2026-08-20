# UN/EDIFACT — `edifact`

Fixtures for **FMT-6.1** ([#5445](https://github.com/apiome/apiome/issues/5445)), with the EANCOM and
ODETTE dialect samples **FMT-6.5** ([#5449](https://github.com/apiome/apiome/issues/5449)) needs.
Apiome reads ANSI X12; EDIFACT is its rest-of-world twin, and every EDI platform in the market
documents both. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** A `UNB` interchange header (optionally preceded by `UNA` service string advice)
followed by `UNH` message headers.

**Delimiters.** Default `+` (element), `:` (component), `'` (segment terminator), `?` (release),
`.` (decimal). `UNA` overrides them, and two fixtures here declare a **comma decimal mark**
(`UNA:+,? '`) to prove the parser reads the advice rather than assuming.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-orders-d96a.edi` | minimal | One ORDERS message, no `UNA`, defaults apply. |
| `02-typical-invoic-d96a.edi` | typical | INVOIC with `UNA`, addresses, taxes, currencies, summary totals. |
| `03-typical-desadv-d01b.edi` | typical | DESADV D.01B: despatch advice with packaging (`PAC`/`MEA`/`GIN`) and transport (`TDT`). |
| `04-stress-multi-message-group.edi` | stress | Two `UNG`/`UNE` functional groups, three messages, comma decimal mark, a release character (`?,`), an empty `LIN` element set. |
| `05-real-world-eancom-orders.edi` | real-world | EANCOM-flavoured ORDERS: GS1 GLNs as party ids, `PIA`/`IMD`/`LOC`, association code `EAN008` in `UNH`. |
| `06-typical-odette-delfor.edi` | typical | ODETTE-flavoured DELFOR delivery schedule: `SCC`/`QTY 113` schedule lines per delivery date. |
| `07-stress-control-count-mismatch.edi` | stress | `UNT` claims 99 segments and `UNZ` claims 7 interchanges; both are wrong. This must **import with warnings**, showing declared *and* observed counts — not reject. |
| `08-composition-nested-segment-groups.edi` | composition | Nested segment groups: party → contact → communication, line → tax → allowance/charge. |
| `09-interchange-set/` | multi-file | An ORDERS interchange plus the CONTRL acknowledgment that refers to it by control reference. |
| `negative/` | — | Missing segment terminator, an interchange with no message, truncation mid-segment, an **X12** interchange, and UTF-16. Plus a `UNH` with no `UNT`. |

**The honesty contract this corpus assumes.** Mirroring the X12 analyzer exactly: declared-versus-
observed control counts on `UNT`/`UNE`/`UNZ`, the five-way element presence vocabulary (has value /
present-empty / withheld / not present / not recorded), the same value-visibility policy, the
canonical model derived from the **first** group's first message with a warning when the interchange
carried more — and an explicit statement that **no implementation guide (D.96A, D.01B, EANCOM…) was
consulted**.
