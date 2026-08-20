# TRADACOMS — `tradacoms`

Fixtures for **FMT-6.5** ([#5449](https://github.com/apiome/apiome/issues/5449)) — the UK retail
dialect. TRADACOMS is a *profile on the EDIFACT engine* only in the sense that it shares the
segment/element idea; its envelope is entirely its own (`STX` … `END`, `MHD`/`MTR` message brackets,
`=` after the segment code), which is why it lives in its own directory rather than inside `edifact/`.
The EANCOM and ODETTE dialect samples the same ticket needs are in `edifact/`. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** An `STX=` transmission header and a closing `END=` — never `UNB`/`UNZ`.

**Envelope shape.** `STX` transmission → repeated *files*, each a header message (`ORDHDR`, `INVFIL`,
`DELHDR`), one or more detail messages (`ORDERS`, `INVOIC`, `DELIVR`), and a trailer message
(`ORDTLR`, `INVTLR`, `DELTLR`). Every message is bracketed by `MHD` (with its sequence number and
message type) and `MTR` (its segment count); `END` carries the number of messages in the transmission.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-order-file.edi` | minimal | ORDHDR + one ORDERS + ORDTLR, one line. |
| `02-typical-order-file.edi` | typical | Trading-party codes in `SDT`/`CDT`, a delivery window in `DIN`, three `OLD` lines with unit prices. |
| `03-typical-invoice-file.edi` | typical | INVFIL/INVOIC/VATTLR/INVTLR with VAT rate lines and settlement totals. |
| `04-stress-multi-message-file.edi` | stress | Three ORDERS messages in one file to three different stores, an uncoded line, and a populated `STX` password/application-reference. |
| `05-real-world-grocery-order-file.edi` | real-world | UK grocery depot order: GTIN-coded lines in cases, two depots, timed delivery windows. |
| `06-typical-delivery-file.edi` | typical | DELHDR/DELIVR/DELTLR with ordered-versus-delivered quantities. |
| `07-composition-nested-files.edi` | composition | Two files in one transmission — an order file and a delivery file — with nested message structure. |
| `08-transmission-set/` | multi-file | An order transmission plus the acknowledgment transmission that answers it. |
| `negative/` | — | A segment missing its `=`, a transmission with no `END`, truncation, an **EDIFACT** interchange, UTF-16, and `MHD`/`END` sequence numbers that do not agree with the messages present. |

**The honesty contract this corpus assumes.** As with X12 and EDIFACT: declared-versus-observed
counts (`MTR` segment counts, `END` message count), the same value-visibility policy, and an explicit
statement that **no implementation guide was consulted** — the analysis records the profile it
applied and its boundaries, never a compliance claim.
