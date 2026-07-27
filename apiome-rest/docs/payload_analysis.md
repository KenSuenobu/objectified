# Revision-Scoped Payload Analysis (CPDO-1.1)

> apiome#4794 — the analysis and evidence foundation of CPDO-EPIC-1 (#4790).
> Blocks CPDO-1.3 (projection manifest) and the format-detail work in
> CPDO-EPIC-2. The extractors that fill these records landed in CPDO-1.2
> (#4795) — see [payload_analyzers.md](./payload_analyzers.md).

## Why

A catalog read reconstructs the imported source on every request and reduces it
to generic entity/field rows. The structures that make a mainframe or EDI
payload worth cataloguing at all — X12 interchange and functional-group
envelopes, delimiters, segment positions, copybook level numbers, PICTURE
clauses, OCCURS bounds, 88-level conditions — are derived, rendered, and
discarded. Nothing can cite them afterwards, and nothing notices when a parser
upgrade silently changes them.

A **payload analysis** is one immutable record of what an analyzer observed in
one source revision. It names the bytes it analysed, the contract it was
written against, and the analyzer that wrote it, so a reader can always tell
whether what it is looking at still describes the source in front of it.

## Modules

| Module | Role |
|---|---|
| `app/payload_analysis.py` | The pure contract: models, vocabulary, bounds, redaction, fingerprinting, summary projection, published JSON Schema. No I/O. |
| `app/payload_analysis_store.py` | The only door to the store: redacts on write, validates against the contract, reads back a declared record, restricts on read. |
| `app/catalog_routes.py` | `GET /v1/catalog/{tenant}/{item}` (summary) and `GET /v1/catalog/{tenant}/{item}/analysis` (record). |
| `database.py` | `insert_payload_analysis`, `get_payload_analysis_for_version`, `get_payload_analysis_summary_row_for_version`, `get_payload_analysis_by_id`, `list_payload_analyses_for_version`, `purge_payload_analysis`. |
| apiome-db `V209__payload_analysis_4794.sql` | `payload_analysis`, its write-once trigger, and `purge_payload_analysis(retention_days)`. |
| apiome-db `V210__payload_analysis_capabilities_4795.sql` | The additive `capabilities` column (CPDO-1.2). |

## The three properties the contract is built around

### It is revision-scoped and immutable

The analysis of a revision never changes underneath a reader. A re-import mints
a new revision and therefore a new analysis; an analyzer upgrade **appends** a
new `analysis_sequence` to the same revision rather than rewriting the old row,
so an evidence reference stays resolvable. A `BEFORE UPDATE` trigger
(`mcp_forbid_row_mutation`, shared since V128) rejects any in-place edit.

Writes are idempotent by content: `insert_payload_analysis` returns the existing
row when the revision's current analysis already carries the same
`content_fingerprint`, so an analyzer sweep is safe to re-run.

### It never fabricates

Absence has a vocabulary, and it is a schema guarantee rather than a habit.

| Status | Meaning |
|---|---|
| `available` | The analyzer described the whole source within budget. |
| `partial` | It described some of it and said which parts it could not. |
| `unavailable` | Nothing was analysed — legacy revision, no captured source, no analyzer for the format. |
| `failed` | The analyzer ran and errored. |

| Reason code | Meaning |
|---|---|
| `not_analyzed` | The revision predates payload analysis, or no analyzer has run for it yet. |
| `no_source_captured` | No source material was captured, so there is nothing to analyse. |
| `unsupported_format` | The format has no native analyzer. A capability boundary, **not** a parse failure. |
| `bounds_exceeded` | The tree exceeded the node/depth budget and was bounded. The record is real, and partial. |
| `analyzer_failed` | The analyzer raised, or its record could not be read. |

Three invariants are enforced twice — as `CHECK` constraints in V209, and as
`PayloadAnalysisDocument.contract_violations()` at the API boundary, so a record
the database would reject never reaches it:

1. An `available`/`partial` record must name the bytes it analysed (`source_hash`,
   shaped `sha256:<64 hex>`).
2. An `unavailable`/`failed` record must carry an **empty tree**.
3. Anything other than `available` must name a reason.

`contract_violations()` adds three the database cannot see: the status must be
in the vocabulary; a bounded record cannot claim to be `available`; and a record
must not carry payload values its own declared `value_visibility` forbids. That
last one is what stops a raw analyzer document — values still in it, redaction
block still at its default — from being stored as though a policy had run.

### It is not a second copy of the payload

The analysis stores *structure*. Whether a node may carry the value it observed
is governed by a value-visibility policy, recorded on the record itself, so
"no values here" is always a stated policy rather than something a reader has to
infer.

| Level | What a node carries |
|---|---|
| `none` | Nothing about the value — not even whether there was one. |
| `structural` *(default)* | Whether a value was present, and how long it was. Enough to distinguish an empty X12 element from an absent one, without carrying what it said. |
| `full` | The observed value, truncated to 120 characters. Only for material explicitly decided to be safe to store; never a default. |

Redaction is applied **twice, deliberately**: once before the record is written,
so the store never holds more than policy allows, and once on read, so a stored
record can only ever be *further* restricted by a request. Restriction is
monotonic — asking for `full` over a record stored at `structural` returns the
structural record, because the values are not there to return.

Raw source material stays where it already lives
(`GET /v1/catalog/{tenant}/{item}/source`). A node points at it with a
`SourceLocation` (file/line/column/offset/length/ordinal/path) rather than
duplicating it.

## Bounds

A native tree is unbounded in principle — a large X12 interchange has hundreds
of thousands of elements. `bound_tree` applies a 5000-node / 32-level budget by
**breadth-first admission**, so what survives is the top of the structure
(envelopes, groups, transaction sets) rather than an arbitrary deep slice of one
branch. Bounding is reported, never silent: `metrics.truncated` and
`metrics.dropped_node_count` say what happened, and the record must then be
`partial` with reason `bounds_exceeded`.

## API

### `GET /v1/catalog/{tenant_slug}/{item_id}` → `analysis`

The detail read embeds the **summary**: status, reason, analyzer identity,
`nodeCount` / `maxDepth` / `truncated` / `warningCount` / `kindCounts`, and the
stored `valueVisibility`. It carries no payload material, so it is readable by
anyone who can read the catalog item. It is built from the row's scalar columns
and its `metrics` blob — the `tree` column is never read — so the detail
endpoint's cost is independent of how large the analysed payload was.

A store fault degrades this one field to `status: "failed"` rather than failing
the whole catalog item: "we could not read the analysis" and "there is no
analysis" are different facts, and the user gets the one that is true.

### `GET /v1/catalog/{tenant_slug}/{item_id}/analysis` → `PayloadAnalysisRecord`

The record itself: the native tree in the analyzer's own vocabulary, its source
locations, analyzer warnings, and redaction metadata, alongside the identity
(`analysisId`, `analysisSequence`, `contentFingerprint`) that makes it citable
by a later projection manifest.

**Authorization** — gated on `imports:view`, the permission governing imported
source material, because a native tree is a structural description of the
payload itself. The item's existence is checked *before* the permission, so an
id in another tenant 404s rather than 403ing in a way that confirms it exists.

**`?valueVisibility=none|structural|full`** — an optional read-time restriction.
It can only narrow what the stored record carries; an unrecognised level is a
`422` rather than a silently-ignored parameter.

A revision imported before this contract existed returns
`status: "unavailable"`, an empty tree, and a reason code. It never returns a
fabricated tree.

## Analyzer capabilities (CPDO-1.2)

A record's **warnings** say what went wrong in *this* source. Its
**capabilities** say what would go wrong in any source — what the analyzer
models, what it knowingly does not, and the numeric bounds it ran under:

```json
{
  "supported":   ["x12.functional_group", "x12.transaction_set", "x12.composite_elements"],
  "unsupported": ["x12.empty_elements", "x12.hl_hierarchy", "x12.ta1_acknowledgement"],
  "limits":      { "maxNodes": 5000, "maxDepth": 32, "valuePreviewChars": 120 }
}
```

Both lists are sorted and de-duplicated by `analyzer_capabilities()`, because
the block is part of the canonicalized document that `content_fingerprint`
hashes — an unsorted declaration would make an otherwise identical re-analysis
look like new work and append a redundant sequence.

It is recorded **per record**, not per format. Analyses are immutable and
long-lived, so the only statement that stays true about a two-year-old record is
the one its own analyzer made at the time. The cross-format registry that
answers the same question *ahead of* an import is CPDO-2.4's.

The block is also carried on the detail-read summary, so a format-detail screen
can explain a missing construct without fetching the tree. A record written
under contract `1.0.0` reads back with empty capabilities, which is the truthful
statement about it: the analyzers that would have filled it did not exist yet.

## Published JSON Schema

`document_json_schema()` returns the JSON Schema of `PayloadAnalysisDocument` in
the camelCase names the API serializes, generated from the model rather than
hand-maintained so it cannot drift from what the API validates. It is the
contract for anyone who is not a Pydantic caller — the CLI, the CPDO-4.1 fixture
corpus, and this document.

## Retention

`apiome.purge_payload_analysis(p_retention_days DEFAULT 90)` hard-deletes
analyses older than the window that are **either** superseded by a newer
analysis of the same revision **or** attached to a revision soft-deleted beyond
the window. Age alone is never sufficient: the current analysis of a live
revision is the catalog record and is never purged. Intended for the same
scheduled maintenance job as `purge_preservation_claims` (V184).

## Where the records come from

Producing analyses is CPDO-1.2's job, and it is done: the analyzer SPI and the
X12/copybook extractors that fill these records are documented in
[payload_analyzers.md](./payload_analyzers.md). A revision imported before they
existed still reads back as a declared `unavailable`/`not_analyzed` record —
exactly the behaviour the contract promises for a source nothing has analysed.
