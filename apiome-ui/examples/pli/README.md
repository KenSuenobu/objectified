# PL/I structures — `pli`

Fixtures for **FMT-11.1** ([#5480](https://github.com/apiome/apiome/issues/5480)). PL/I structures sit
alongside COBOL copybooks in the same institutions, describing the same records with a different
declaration syntax. The PL/I **output** mode is filed (**#4141**); nothing reads one. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `DCL`/`DECLARE` followed by a level-numbered structure with PL/I attributes
(`CHAR(n)`, `FIXED DEC(p,s)`, `FIXED BIN(n)`, `BIT(n)`, `PIC'…'`), and `%INCLUDE name;` directives.

**Mapping**

| PL/I | Canonical |
| --- | --- |
| level-numbered structure | nested type |
| `CHAR(n)` / `CHAR(n) VARYING` | string, fixed or length-prefixed |
| `FIXED DEC(p,s)` | packed decimal with precision and scale |
| `FIXED BIN(n)` | integer of the corresponding width |
| `PIC'…'` | zoned/edited numeric or character picture |
| `BIT(n)` | flag set |
| `(n)` / `(l:u)` / `(n,m)` dimensions | arrays |
| `UNION` | shared storage — the presentation COBOL `REDEFINES` already uses |
| `LIKE other` | structure clone |
| `%INCLUDE` | fileset member |
| `REFER` | **declared limit** — the extent is a runtime value |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-structure.pli` | minimal | Two fields, one level. |
| `02-typical-customer-record.pli` | typical | Nested group, packed decimals, a bit flag set, a fixed array of sub-structures, filler. |
| `03-includes-set/` | multi-file | `%INCLUDE` of two members plus `LIKE` clones of them — the layout only closes across the set. |
| `04-stress-attribute-coverage.pli` | stress | Every character, numeric, picture, bit and pointer form, three array shapes, `UNION`, `LIKE`, `BASED`, explicit `ALIGNED`/`UNALIGNED` blocks, and a `REFER` self-defining extent. |
| `05-real-world-payment-record.pli` | real-world | A payment instruction record: header, two party blocks with address arrays, amount block, repeating charges table, status block, trailer. |
| `06-typical-union-record.pli` | typical | One physical record read three ways through `UNION`. |
| `07-composition-like-and-nesting.pli` | composition | Three blocks cloned by `LIKE` into three records, and a record built only from other records. |
| `negative/` | — | Missing semicolon, level numbers that do not form a tree, truncation, a **COBOL copybook**, UTF-16, and a `%INCLUDE` of a member that is not in the set. |

**Byte counts come with assumptions.** Alignment padding, character encoding and the `VARYING` length
prefix are not stated by the declaration. FMT-11.1 requires the same explicit "what these byte counts
assume" contract the copybook analyzer already publishes.
