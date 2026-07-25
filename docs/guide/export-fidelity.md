# How do I… understand export fidelity? (projection map, reasons, acknowledgement)

When you export a version or catalog item to another format (OpenAPI 3.1, AsyncAPI 3,
GraphQL SDL, Proto3, Avro, …), apiome predicts **before generation** what will be
preserved, what will change, and what will be lost — and shows you *why*, per construct,
with a link to the destination format's official documentation when the limitation is
the format's own. This page explains how to read that evidence and how the risk
acknowledgement works.

> **Rule of thumb:** the one-word tier is a triage badge, not a guarantee. Always check
> the projection map (or the `export evidence` table) before relying on a lossy or
> types-only export — and even a `lossless` badge only covers the constructs apiome
> could analyze (see [Unavailable evidence](#unavailable-evidence)).

---

## Quality tiers

Every target card shows a coarse fidelity tier plus a preserved-% estimate:

| Tier | Meaning |
|---|---|
| `lossless` | Every analyzed source construct is carried faithfully. |
| `lossy` | Some constructs are approximated, reframed, or dropped. |
| `types-only` | A schema-only target keeps type definitions and drops all operations/channels. |

**A tier alone never proves full preservation.** It is computed from construct
*categories*, so two `lossy` exports can differ enormously, and constructs apiome could
not inspect (`unavailable`) are not "preserved" — they are unknown. Use the
per-construct evidence below to see exactly what happens to your API.

## Target readiness (the pre-flight ranking)

The target grid does not just badge each target — it **ranks** them by expected outcome,
before any job runs. The ranking comes from the export pre-flight
(`POST /v1/tenants/{tenant}/export/preflight`), which lints the **source** under your
tenant's style guide and then, per target, mixes three things into one score:

| Input | What it answers |
|---|---|
| Projected fidelity (preserved %) | How much of this source survives the trip? |
| Source lint score | How good is the thing you are exporting in the first place? |
| Capability fit | Can the target carry the *kinds* of construct this source is made of? |

Each card then falls into a band, and the grid sorts by band first:

| Band | Meaning |
|---|---|
| `ready` | Go. Good fidelity, no policy shortfall. |
| `check first` | Usable — read the rationale before you commit. |
| `blocked` | Your tenant's export quality policy refuses this delivery. The card stays visible with the reason; it cannot be selected until the shortfall is fixed or waived. |
| `unavailable` | The emitter's toolchain is not installed in this runtime. |

Every card carries a one-line **rationale** ("Type shapes only: 50% preserved, 5
constructs dropped. Source grade B. Apache Avro cannot carry operations.") and the grid
prints the source's own grade above it. Prefer another order? The **Sorted by
readiness / Sorted by name** toggle restores the original registry ordering.

The ranking is deterministic for a fixed source revision, style guide, and policy — the
report's `ranking_fingerprint` is a stable hash of it — and the pre-flight emits nothing:
no job, no artifact. The fidelity numbers it shows are the same ones the eventual job
attaches to its result.

Quality floors and waivers are configured per tenant in **Governance → Style guides →
Quality policy**; see [import-a-spec.md](import-a-spec.md) for how the same policy gates
intake.

## The projection map (graph + table)

The quick **Export** dialog (Fidelity step) and **Export Studio → Verify**
(`/ade/dashboard/export/studio`) both render a **Projection map**: a three-column
diagram from **source/native construct → canonical model → destination location**,
banded into *in-destination*, *omitted*, and *unavailable* lanes, with a synchronized
table underneath. Graph and table are rendered from the same server evidence, so their
counts always agree — if you prefer the table (or use a screen reader), you lose
nothing.

- **Select any node or row** (pointer, or keyboard: arrow keys / Home / End, Enter or
  Space to open, Escape to reset the view) to open the **evidence drawer**: the
  construct, its status and severity, the cause category, the reviewed explanation, the
  destination location when one exists, and a documentation link when applicable.
- **Status is readable without color** — every outcome carries a text label and symbol.
- **Large exports aggregate**: above a documented threshold, clean (`retained`,
  info-severity) rows collapse into expandable groups. Dropped, unavailable,
  approximated, synthesized, and warning/critical rows are **never** aggregated away.
  Use **Load more evidence** to page in the rest; the summary chips always show the
  full status counts from the manifest, even before every page is loaded.

## Statuses: the fate of each construct

| Status | Meaning | Example |
|---|---|---|
| `retained` | Meaning represented without material change. | An object schema becomes an Avro record. |
| `transformed` | Meaning survives a documented target transformation. | A REST operation becomes a GraphQL mutation. |
| `approximated` | A related construct exists, but not all semantics are kept. | A validation constraint emitted as documentation text. |
| `synthesized` | apiome invented content the target's conventions require. | A Proto3 field number assigned to a field that never had one. |
| `dropped` | The construct is not emitted at all. | HTTP paths in a format with no path concept. |
| `unavailable` | apiome could not reliably inspect the source data. | A detail the parser did not capture. |
| `not-applicable` | The construct does not apply to this target or source. | "No event channels exist in this source." |

## Reasons: *why* it happened, and what to do

Every non-preserved status carries exactly one cause category. The wording is reviewed
so a destination-format limit is never blamed for an apiome-side gap (and vice versa):

| Reason code | Category label | Whose limitation | What you can do |
|---|---|---|---|
| `destination_unsupported` | Destination limit | The target format's specification | Choose a destination that supports the construct, or accept the loss. This is the **only** category that shows a destination-format documentation link. |
| `emitter_unsupported` | Not yet emitted | apiome's emitter (the format could carry it) | Track emitter support; not a format limit. |
| `source_incomplete` | Source incomplete | Your source definition | Complete the source and re-export. |
| `source_parse_limit` | Parser limit | apiome's parser | The source data itself may be intact; apiome cannot determine its fate. |
| `option_excluded` | Option excluded | An export option you selected | Change the option and preview again. |
| `security_redacted` | Redacted | A security/privacy policy | Adjust the redaction policy if the construct should export. |
| `target_tool_unavailable` | Toolchain unavailable | The runtime's missing external tool | Install/enable the destination's toolchain and re-export. |
| `not_applicable` | Not applicable | Nobody | No action needed. |

## Destination documentation links

When (and only when) the cause is a genuine `destination_unsupported` specification
limit, the evidence drawer and table rows offer a link to the destination format's
**authoritative technical documentation** — e.g. the
[OpenAPI Specification](https://spec.openapis.org/oas/latest.html), the
[AsyncAPI Specification](https://www.asyncapi.com/docs/reference/specification/latest),
the [GraphQL Specification](https://spec.graphql.org/), the
[Protocol Buffers language guide](https://protobuf.dev/programming-guides/proto3/), or
the [Apache Avro Specification](https://avro.apache.org/docs/current/specification/).

These links come from a versioned, reviewed server-side registry, not ad-hoc UI text:

- Only `https` links to an **allowlisted set of authoritative hosts** can ever appear.
- Links disclose the specification name and version and are anchored to the relevant
  section where the format's documentation supports it.
- When no authoritative link applies, the UI says so plainly
  (*documentation unavailable*) rather than inventing one.

The registry version and the emitter version that produced the evidence are shown in
the drawer, so the evidence is attributable to an exact contract. (Governance of these
links — review and version-update ownership — is documented for contributors in
[`apiome-rest/docs/export_projection_author_guide.md`](../../apiome-rest/docs/export_projection_author_guide.md).)

## Unavailable evidence

`unavailable` means **apiome does not know** — usually `source_parse_limit` (the parser
could not fully capture the construct) or `source_incomplete`. Unavailable constructs:

- appear in their own lane in the projection map and are never hidden by aggregation;
- are **not** counted as preserved, and do not lower a target's tier dishonestly —
  the evidence marks them explicitly instead of guessing;
- mean the emitted artifact may carry *more or less* than the evidence claims for
  those constructs. If they matter to you, fix the source (or re-import with a fuller
  parser) before trusting the export.

Evidence rows also always redact source-native identifiers and text (shown as
`[redacted]`) — construct keys, statuses, reasons, and target locations remain, but
captured source values never leave the server.

## Options change the snapshot

Per-target export options (e.g. OpenAPI's `include_paths`) are folded into the
projection snapshot: **different options are a different preview**. Changing the target
or any option in the UI immediately clears the old graph, report, and acknowledgement
and requests a fresh preview — you can never acknowledge one configuration and ship
another. Constructs excluded by an option show as `option_excluded`, so an
"unsupported-looking" loss may just be a switch you can flip.

## Snapshots and the risk acknowledgement

Every preview computes a **snapshot hash** over the exact source revision, target,
normalized options, emitter version, and registry version. The hash appears in the
preview, the projection evidence, the CLI JSON, and the completed job's result — they
all describe the same snapshot, by construction.

For a lossy or types-only export you must acknowledge the loss (the *Export anyway*
gate; a types-only export requires the typed confirmation). That acknowledgement is
bound to the snapshot hash, not to the moment in time:

- **Generate uses the acknowledged snapshot or refuses.** If the source revision,
  options, emitter, or registry changed since you previewed, the job fails with a
  structured `STALE_PREVIEW` error naming the acknowledged and current hashes — re-run
  the preview and acknowledge what you actually see now.
- **Completed jobs record their provenance**: the snapshot hash and submitted options
  are stored with the result, so an artifact is always attributable to the evidence
  that was accepted for it.

## From the CLI

```bash
# 1. What targets exist for this version, and how faithful would each be?
apiome export targets --project payments-api --version 1.0.0

# 2. Why exactly — page the per-construct projection evidence (status, reason, explanation):
apiome export evidence --project payments-api --version 1.0.0 --target avro

# Machine-readable page for automation (summary + rows + next_cursor):
apiome --json export evidence --project payments-api --target avro --limit 25

# Options are part of the snapshot — evidence for a different option set is a different snapshot:
apiome export evidence --project payments-api --target openapi --option include_paths=false

# 3. Export. A lossy/types-only export exits non-zero unless you --force (or confirm at a TTY):
apiome export avro --project payments-api --version 1.0.0 --output User.avsc --force
```

The `--json` evidence payload contains the `summary` (snapshot hash, emitter/registry
versions, status and reason counts) and a bounded `page` of rows with `next_cursor` for
paging — the machine-readable twin of what the projection map shows. In CI, treat the
snapshot hash as the identity of what you approved: a job submitted with an
acknowledged snapshot that no longer matches fails with `STALE_PREVIEW` (exit code 1)
rather than silently exporting something different. See the
[CLI README](../../apiome-cli/README.md#export-a-version-to-a-target-format) for the
full flag reference.

## Worked examples

Four situations you will actually meet, one per kind of outcome:

1. **Lossless mapping** — an AsyncAPI-imported event source exported back to
   **AsyncAPI 3**: channels, operations, messages, and schemas are `retained`; the
   tier is `lossless` and no acknowledgement is asked.
2. **Approximation** — a REST source exported to **AsyncAPI 3**: each request/response
   operation is *reframed* as an `action: send` with a `reply`, so it shows
   `approximated` with the honest explanation that the HTTP method, path, and response
   status are not represented (`destination_unsupported`, with the AsyncAPI
   specification link).
3. **Source-incomplete evidence** — a construct whose detail the parser could not
   capture shows `unavailable` / `source_parse_limit`: *"apiome's parser could not
   fully capture this construct from the source, so its export cannot be determined."*
   No destination link is shown, because the format is not at fault.
4. **Unavoidable destination limit** — a REST source exported to **Avro**: HTTP paths
   and operations show `dropped` / `destination_unsupported` (*"the format you chose
   does not support HTTP paths"*) with a link to the Avro specification; the record
   types themselves are `retained` and the tier is `types-only`.

## Canvas annotations (`x-apiome-note` / `x-apiome-canvas`)

Sticky notes and callouts drawn on the Studio schema canvas are part of the design
record, so the Studio generators serialize them into exported specs as vendor
extensions and restore them on import (Designer DUX-2.1,
[apiome/private-suite#2394](https://github.com/apiome/private-suite/issues/2394)):

- **`x-apiome-note`** — schema-level. An **array** of notes attached to that class;
  attachment is implicit from the location (no IDs), so it survives systems that assign
  new class identifiers.
- **`x-apiome-canvas`** — document-level. `{ formatVersion, notes: [...] }` carrying
  freeform notes (and, as a fallback, notes attached to classes that were not part of
  the export, with their `attachedTo` class name preserved).

Each note object:

```json
{
  "id": "note-1721117493-h2k9x4q1a",
  "kind": "sticky",            // "sticky" | "callout"
  "text": "Confirm rounding rules with billing",
  "color": "amber",            // preset name or "#RRGGBB"
  "position": { "x": 120, "y": 240 },
  "dimensions": { "width": 220, "height": 140 },
  "attachedTo": "Invoice"      // document-level fallback only; omitted when schema-level
}
```

The round trip is **lossless** for position, size, color, text, kind, and attachment.

**Where it applies:**

| Destination | Behavior |
|---|---|
| OpenAPI 3.x, JSON Schema | Extensions emitted and re-imported (`retained`). |
| AsyncAPI 3 | Extension-capable; emitter support tracked (`emitter_unsupported` until it lands). |
| GraphQL SDL, SQL DDL, Proto3, Avro, Thrift | No vendor-extension mechanism — annotations are skipped (`dropped` / `destination_unsupported`). |
| Diagram/code exports (Mermaid, PlantUML, GraphML, DOT) | No extension slot — skipped (`destination_unsupported`). |
| PNG / JPEG / SVG / PDF canvas images | Notes render as drawn; the Export Wizard's **Include notes** overlay toggle includes or excludes them. |

## REST endpoints

| Purpose | Route |
|---|---|
| Target list + per-source tier | `GET /v1/export/{tenant}/targets?artifact={id}&version={v}` |
| Pre-flight: source lint + target-readiness ranking (no job, no artifact) | `POST /v1/tenants/{tenant}/export/preflight` |
| Preview (fidelity + projection summary + snapshot hash) | `POST /v1/export/{tenant}/preview` |
| Bounded, cursor-paginated projection evidence | `POST /v1/export/{tenant}/projection-evidence` |
| Reviewed reason explanations + destination documentation | `GET /v1/export/{tenant}/capability-registry` |
| Export job (accepts `acknowledged_snapshot`; fails `STALE_PREVIEW` on mismatch) | `POST /v1/export/{tenant}/jobs` |

All routes are tenant-scoped and require an in-scope API key (`X-API-Key`).

## Related

- [export-a-spec.md](export-a-spec.md) — downloading the reconstructed document
- [cli-quickstart.md](cli-quickstart.md) — CLI setup and command groups
- [`apiome-cli/README.md`](../../apiome-cli/README.md) — full `export` flag reference
- [`apiome-rest/docs/export_projection_author_guide.md`](../../apiome-rest/docs/export_projection_author_guide.md)
  — the contract emitter authors must satisfy for this evidence to stay truthful
