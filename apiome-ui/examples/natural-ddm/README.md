# Natural / ADABAS DDM — `natural-ddm`

Fixtures for **FMT-11.4** ([#5486](https://github.com/apiome/apiome/issues/5486)). Software AG's
Natural/ADABAS estates run core systems in insurance and government with no modernization tooling at
all. A **DDM** (Data Definition Module) describes a file's fields, levels, formats, lengths,
descriptors and periodic groups — a complete record schema. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection marker.** A `DDM Name ......` header with `DB`/`File` numbers, followed by the
`T L DB Name … F Leng S D Remark` column banner and fixed-column field lines.

**Reading a field line**

```
M 1 AH PHONE-NUMBER                     A    20     N Multiple-value field
│ │ │  │                                │    │      │
│ │ │  └ field name                     │    │      └ descriptor flag
│ │ └ two-character ADABAS short name   │    └ length (and decimals for N/P)
│ └ level                               └ format
└ type prefix
```

| Column | Values | Canonical meaning |
| --- | --- | --- |
| type prefix | `M` multiple-value, `P` periodic group, `S` super-, `H` hyper-, `Q` sub-descriptor | array, repeating group, or derived key |
| format | `A` alpha, `N` unpacked numeric, `P` packed, `B` binary, `F` float, `L` logical, `U` Unicode, `D` date, `T` time | scalar type |
| `Leng` | `n` or `n.d` | length, with decimal places for numeric formats |
| descriptor | `D` descriptor, `U` unique, `N` non-descriptor | index / key metadata |
| remark | free text, sometimes `NU` (null suppression) or `FI` (fixed storage) | documentation and storage hints |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-ddm.ddm` | minimal | Two fields, one descriptor. |
| `02-typical-customer-ddm.ddm` | typical | Alpha/numeric/packed formats, a unique descriptor, a multiple-value field, a superdescriptor over two sources. |
| `03-view-set/` | multi-file | The DDM **plus** a Natural `DEFINE DATA VIEW` over it — the program's projection, with occurrence bounds the DDM does not carry. |
| `04-stress-formats-and-descriptors.ddm` | stress | Every format, an MU inside a PE group, two periodic groups, null suppression, fixed storage, super/hyper/sub descriptors, a LOB field. |
| `05-real-world-policy-ddm.ddm` | real-world | An insurance policy file: coverage and claim periodic groups, packed money, joint-policy MU names, two access-path superdescriptors. |
| `06-typical-periodic-groups.ddm` | typical | Two periodic groups with an MU field inside one of them. |
| `07-composition-redefines-and-groups.ddm` | composition | A redefined group field, a group inside a periodic group, superdescriptors spanning three levels. |
| `negative/` | — | A garbled column layout, a DDM with no field lines, truncation, a **COBOL copybook**, UTF-16, and descriptors built from short names the DDM never defines. |

**Byte counts come with assumptions.** `Leng` is a character or digit count, not a byte count: packed
fields carry a sign nibble, `N` fields are zoned, and the record is EBCDIC. FMT-11.4 requires lengths
modelled **under stated assumptions**, the same contract the copybook analyzer publishes.
