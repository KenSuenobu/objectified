# IMS DBD and PSB — `ims`

Fixtures for **FMT-11.2** ([#5482](https://github.com/apiome/apiome/issues/5482)). IMS remains in
production at large financial and government institutions. A **DBD** defines segments, fields and
hierarchy; a **PSB** defines a program's view and access intent. Together they are the schema and the
access contract, and nothing reads them. Entries carry `adapter_key: null` and the `pending-adapter`
tag.

**Detection markers.** Assembler-style macro source in columns 10+: `DBD NAME=…,ACCESS=(…)` with
`DATASET`/`SEGM`/`FIELD` and a closing `DBDGEN`/`END`; or `PCB TYPE=DB,DBDNAME=…` with `SENSEG` and a
closing `PSBGEN`/`END`. Continuations are marked by a non-blank in column 72 (the `X`).

**Mapping**

| IMS | Canonical |
| --- | --- |
| `SEGM NAME=…,BYTES=n,PARENT=p` | type; `PARENT` builds the nesting, **not** the file order |
| `BYTES=(max,min)` | variable-length segment |
| `FIELD NAME=(f,SEQ,U/M)` | key field, unique or non-unique |
| `FIELD … BYTES/START/TYPE` | property with byte offset, length and type (`C`, `P`, `X`, `H`, `F`) |
| `LCHILD` / `XDFLD` | secondary index → declared relationship and search field |
| `PCB` / `SENSEG` / `SENFLD` | program view: the subset of segments and fields a program sees |
| `PROCOPT` | **declared access profile**, carried in extras (`G` get, `I` insert, `R` replace, `D` delete, `A` all, `P` path) |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-dbd.dbd` | minimal | One root segment, two fields. |
| `02-typical-hdam-dbd.dbd` | typical | HDAM root with two dependent segments, packed fields, a randomizer clause, continuation lines. |
| `03-dbd-psb-set/` | multi-file | A DBD **plus** the PSB that references its segments — the access profile only exists across the set. |
| `04-stress-secondary-indexes.dbd` | stress | HIDAM with `LCHILD`/`XDFLD` secondary indexes (including a two-source search field with `SUBSEQ`/`DDATA`/`NULLVAL`), a non-unique sequence field, a variable-length segment, a logical child pairing to another database. |
| `05-real-world-policy-dbd.dbd` | real-world | A four-level insurance hierarchy with packed money fields, a broker secondary index and a variable-length note segment. |
| `06-typical-psb.psb` | typical | Three PCBs — two database views with different `PROCOPT`s and field-level sensitivity, plus a TP PCB. |
| `07-composition-logical-database.dbd` | composition | A LOGICAL DBD whose segments are `SOURCE=` projections of two physical databases. |
| `negative/` | — | A continuation that leads nowhere, a DBD with no segments, truncation, a **COBOL copybook**, UTF-16, and a `PARENT=` naming a segment that does not exist. |

**Byte counts come with assumptions.** `START`/`BYTES` are 1-based byte positions in an EBCDIC record;
packed (`TYPE=P`) fields carry a sign nibble. FMT-11.2 requires the same explicit assumptions
statement the copybook analyzer publishes.
