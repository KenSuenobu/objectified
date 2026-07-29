# Catalog analysis guardrails (CPDO-4.2, #4805)

Operational budgets, authorization/redaction policy, audit trail, privacy-safe
telemetry, retention, and release gates for the catalog payload-detail surface:
the analysis read (CPDO-1.1), the raw-source read, the conversion projection
graph (CPDO-1.3), and the stored evidence snapshots (CPDO-3.3). The export-side
twin of this document is
[projection_evidence_guardrails.md](./projection_evidence_guardrails.md).

## Budgets

| Budget | Constant | Value |
|--------|----------|-------|
| Stored analysis tree nodes | `MAX_TREE_NODES` | 5000 |
| Stored analysis tree depth | `MAX_TREE_DEPTH` | 32 |
| Analyzer node-visit budget | `MAX_VISITED_NODES` | 10 × `MAX_TREE_NODES` |
| Retained value preview | `MAX_VALUE_PREVIEW_CHARS` | 120 chars |
| Soft read-time bound+redact wall clock (CI) | `READ_BOUND_SOFT_BUDGET_SECONDS` | 2.0 s |
| Projection manifest construct edges | `MAX_CONSTRUCT_EDGES` | 2000 |
| Projection manifest analysis edges | `MAX_ANALYSIS_EDGES` | 200 |
| Projection/evidence page size | `DEFAULT_EVIDENCE_PAGE_SIZE` / `MAX_EVIDENCE_PAGE_SIZE` | 50 / 500 |
| Large-graph telemetry flag | `LARGE_GRAPH_EDGE_THRESHOLD` | 1000 edges |
| UI page size per projection request | `CONVERSION_PROJECTION_PAGE_LIMIT` | 200 |
| UI pages per auto-load window | `PROJECTION_PAGES_PER_WINDOW` | 5 |
| UI analysis-tree windowing | `ANALYSIS_TREE_VIRTUALIZE_ABOVE` | 50 rows |

Constants live in:

* `apiome-rest/src/app/payload_analysis.py` / `payload_analyzer.py`
* `apiome-rest/src/app/conversion_projection.py`
* `apiome-rest/src/app/analysis_telemetry.py`
* `apiome-ui/src/app/utils/preview-budgets.ts` (the documented UI registry)

## Truncation and lazy reads

Bounding is **declared, never silent**: a tree the write-time budget clipped is
stored `partial` with reason `bounds_exceeded` and its `metrics` state
`truncated` / `droppedNodeCount`.

The analysis endpoint is additionally **lazy on request**
(`?maxNodes=&maxDepth=`): a client may fetch only the breadth-first top of an
oversized stored tree. `bound_document` applies the same admission the write
path uses, adds read-time drops to the stored drop count, and demotes an
`available` record to `partial`/`bounds_exceeded` — the served record always
satisfies the storage contract's truthfulness invariants. Like
`valueVisibility`, the parameters can only narrow the record; a budget wider
than the stored tree is a no-op. The UI keeps its own guarantees: nothing is
fetched until the Format details tab is selected, and mounted rows are windowed
above `ANALYSIS_TREE_VIRTUALIZE_ABOVE`.

## Authorization and redaction

* **Value redaction** happens on write (`store_analysis` applies the
  value-visibility policy before the insert, default `structural`) and can only
  be *further* narrowed on read — values the store never held cannot be
  re-materialised.
* **`imports:view`** gates every read that carries payload-derived material:
  the analysis tree, the projection graph, historical evidence snapshots, and —
  from CPDO-4.2 — the raw source itself (`GET …/{item_id}/source`). The item
  lookup happens *before* the permission check, so a cross-tenant id 404s
  rather than confirming its existence with a 403.
* The tree-free analysis **summary** and the conversion **history metadata**
  stay readable by anyone who can read the catalog item; they carry counts and
  statuses only.

## Audit trail

Each successful serve of the two payload-exposing reads writes a best-effort
row to the append-only, hash-chained `apiome.access_audit` ledger (V120):

| Action | Target | Detail |
|--------|--------|--------|
| `catalog.analysis.view` | `catalog:{item_id}:analysis` | `status`, `nodeCount`, `valueVisibility` |
| `catalog.source.view` | `catalog:{item_id}:source` | `mode` (`inline` / `redirect`) |

Detail fields are counts, statuses, and modes only — never payload content. A
failed audit insert never turns a successful read into an error (the same rule
as the `permission.denied` entries the RBAC layer writes).

## Privacy-safe telemetry

Structured events (`event=catalog.analysis`) and in-process counters via
`app.analysis_telemetry`. Allowed kinds:

* `analysis_completed` — import-time analysis produced a record (+ `status`,
  `latency_ms`, `node_count`, `payload_bytes`)
* `analysis_failure` — an analyzer did not complete (+ `reason_category`, one
  of the payload-analysis reason codes)
* `analysis_read` — the tree was served (+ `status`, `node_count`, `latency_ms`)
* `source_access` — the raw source was served (+ `access_mode`)
* `projection_page` — a projection page was served (+ `page_total`,
  `latency_ms`, `status_counts` — the conversion status distribution —
  `large_tree`)
* `evidence_page` — a stored snapshot page was served
* `ui_latency` — a UI surface reported its latency (controlled `surface`
  vocabulary; UI → `POST /v1/catalog/{tenant}/analysis-metrics`, the only kind
  that endpoint accepts)

Never: node names or values, source text or locations, item names, free-form
reason text. Non-allowlisted categories are dropped, not logged. Counters are
exposed to platform admins as the `catalog_analysis` block of
`GET /v1/ops/metrics` (and `/v1/ops/status` behind the ops dashboard), so
analyzer failures are visible without any payload content.

## Retention

* **Analysis records**: `apiome.purge_payload_analysis(p_retention_days
  DEFAULT 90)` hard-deletes superseded analyses and analyses of revisions
  soft-deleted beyond the window; the current analysis of a live revision is
  never purged (see [payload_analysis.md](./payload_analysis.md)).
* **Evidence snapshots** (V215) are content-addressed and append-only; a
  history entry whose snapshot is absent degrades to a declared HTTP 200 state.
* **Audit rows** are append-only and hash-chained; they carry no payload
  content, so they are safe to retain on the platform's audit schedule.
* **Telemetry counters** are in-process only (reset on restart); structured log
  lines follow the deployment's log retention and contain no payload content by
  construction.

## Release gates (CI)

Run as part of the existing package CI workflows:

1. **apiome-rest** — `pytest` including `tests/test_analysis_telemetry.py`
   (whitelists, privacy) and `tests/test_catalog_analysis_guardrails.py`
   (read-time bounding, soft wall-clock budget, source authorization, audit
   rows, metric-ingest whitelist, ops exposure).
2. **apiome-ui** — `yarn test` including
   `tests/catalogAnalysisGuardrails.test.ts` (metric whitelist, tracker
   resilience, budget registry) and `tests/preview-budgets.test.ts` (registry ↔
   constant consistency for the CPDO budgets).

Load testing for this surface is the soft wall-clock pytest budget above, not
an external load-tool harness.
