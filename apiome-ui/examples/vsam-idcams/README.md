# VSAM cluster definitions (IDCAMS) — `vsam-idcams`

Fixtures for the VSAM half of **FMT-11.3** ([#5484](https://github.com/apiome/apiome/issues/5484)).
VSAM cluster definitions carry key positions, record lengths and organisation — record metadata that
is a schema in everything but name. The CICS BMS half lives in `cics-bms/`. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** `DEFINE CLUSTER`/`DEFINE AIX`/`DEFINE PATH`/`DEFINE GDG` commands with
parenthesised parameters and `-` continuations, optionally wrapped in JCL (`//STEP EXEC PGM=IDCAMS`,
`//SYSIN DD *`); or `LISTCAT` output beginning `CLUSTER ------- <name>`.

**Mapping**

| IDCAMS | Canonical |
| --- | --- |
| `NAME(...)` | type name |
| `INDEXED` / `NONINDEXED` / `NUMBERED` / `LINEAR` | KSDS / ESDS / RRDS / LDS organisation |
| `KEYS(length offset)` | **primary key**: length and 0-based offset into the record |
| `RECORDSIZE(avg max)` | record length, fixed when equal |
| `DEFINE AIX … RELATE(...) KEYS(len off)` | alternate key on the related cluster |
| `UNIQUEKEY` / `NONUNIQUEKEY` | key uniqueness |
| `SHAREOPTIONS`, `FREESPACE`, `CISIZE`, volumes, space | storage metadata, not structure |
| `LINEAR` | **declared limit** — no record structure exists to model |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-define-cluster.idcams` | minimal | One KSDS: name, keys, record size. |
| `02-typical-ksds.idcams` | typical | The JCL wrapper, `DATA`/`INDEX` sub-definitions, free space, share options, an `IF LASTCC` guard. |
| `03-cluster-and-index-set/` | multi-file | Base cluster in one file, its `AIX`/`PATH`/`BLDINDEX` in another — the alternate key's offset is a fact about the *base* record. |
| `04-stress-cluster-forms.idcams` | stress | KSDS, ESDS, RRDS, VRRDS and **LDS**, every space form (`CYLINDERS`/`TRACKS`/`RECORDS`/`MEGABYTES`), SMS classes, an alternate index with `SUBSEQ`-style offsets, a path, and a GDG. |
| `05-real-world-account-cluster.idcams` | real-world | The job an operations team ships: delete-and-define, two alternate indexes (unique and non-unique), two paths, a two-target `BLDINDEX`. |
| `06-typical-listcat-output.idcams` | typical | `LISTCAT ALL` output — often the only surviving description of a file. |
| `07-composition-alternate-index-family.idcams` | composition | One base cluster and the family defined in terms of it: two AIXes, two paths, REPRO and BLDINDEX. |
| `negative/` | — | Unbalanced parentheses, an `INDEXED` cluster with no `KEYS`, truncation, a **BMS mapset** (the sibling format), UTF-16, and an `AIX` whose `RELATE` target does not exist. |

**What this format does *not* give you.** A cluster definition describes the record's *envelope* —
length, key position, organisation — and never its fields. Field-level structure comes from the COBOL
copybook or PL/I declaration that the application uses; FMT-11.3 must say so rather than implying a
complete schema.
