# Import/export observability (IXH-6.6, #5125)

Aggregate metrics for the two job pipelines — per-stage duration histograms and byte totals,
terminal job totals, and failure counters keyed by the IXH-6.4 taxonomy — plus a correlation
id threaded from the submitting request through the job to every event and log line.

## Deployment posture

Metrics live in-process (`app/import_export_metrics.py`), following the deployment's
established metrics plane (`/v1/ops/metrics`, `analysis_telemetry`): **per replica, reset on
restart, deliberately not a Prometheus deployment**. A DB-backed observation series (the
IXH-2.7 `quality_rank_observations` pattern) was considered and rejected: it needs a
migration outside this ticket's module scope, and durable per-job timing evidence already
exists independently — every stage emits a `PHASE_TIMING` job event that is mirrored, with
the whole status, into `apiome.async_job.status`, so per-job history survives restarts even
though the aggregates do not.

## Metric families

| Family | Keyed by | Values |
|---|---|---|
| `stages` | kind × stage × outcome | count, total_duration_ms, duration histogram, bytes_in_total, bytes_out_total |
| `jobs` | kind × adapter/target × format × outcome | count, total_duration_ms, bytes_in_total, bytes_out_total |
| `failures` | kind × taxonomy code × adapter/target | count |

Duration histogram bucket upper bounds (ms): 50, 100, 250, 500, 1000, 2500, 5000, 15000,
60000, then `inf`. Bucketing is upper-bound inclusive.

Each `record_*` call also emits exactly one structured log line — `import_export.stage`,
`import_export.job`, or `import_export.failure` — whose fields are the validated tag values
plus the numbers. The logging pipeline attaches the bound `request_id` to those lines, so
log-side aggregation can slice the same events by correlation id.

## The documented tag set (cardinality bounds)

Every tag value comes from a closed vocabulary; anything outside it is clamped to `other`,
never stored verbatim. **No per-tenant, per-job, per-user, or free-text tag exists** — the
recording API has no parameter through which one could arrive.

- **kind**: `import` | `export`.
- **outcome**: `completed` | `failed` | `canceled` (a `pending-approval` import counts as
  `completed` — the pipeline succeeded; approval is a user gate).
- **stage (import, in-process)**: `intake`, `remote-refs`, `parse`, `analyze`, `normalize`,
  `route`, `version`, `lint`, `persist`, `finalize`.
- **stage (import, tsx worker)**: `parse:normalize`, `phase:buildPropertyLibrary`,
  `phase:importPaths`, `phase:verify`, `phase:writeClasses`. A renamed/new worker phase
  clamps to `other` until added — never an error.
- **stage (export)**: `loading-source`, `analyzing-fidelity`, `emitting`, `validating`,
  `packaging` (exactly the engine's stage vocabulary).
- **adapter (import)**: the registered import-source keys (`available_import_sources()`).
- **target (export)**: the registered emit format keys (`available_emit_formats()`); a
  submitted alias (`openapi`) is normalized to its canonical key (`openapi-3.1`).
- **failure code**: the intake taxonomy (29 codes, `app/intake_error_taxonomy.py`) for
  imports; the delivery taxonomy (14 codes, `app/delivery_error_taxonomy.py`) for exports.

A defensive cap (`MAX_KEYS_PER_FAMILY = 512`) folds pathological growth into `other` even if
a registry were to misbehave. `GET /v1/ops/import-export` returns this whole tag set under
`documented_tags`, so operators never have to reverse-engineer it from code.

## Where the numbers come from

**Import.** The pipeline (`run_adapter_import_job`) emits one `PHASE_TIMING` event per stage
(`context = {phase, ms, outcome}` — the exact shape the tsx worker already emits), including
a `failed` outcome for the stage a failure interrupted. The engine ingests `PHASE_TIMING`
events into the stage metrics at its event-dedupe seam (`_log_import_events`), so the worker
path and the in-process path converge on the same aggregates with no double counting across
streamed snapshots. Job totals and failure counters are recorded by the `_drive_job` wrapper
when the job reaches its terminal state — one seam that sees worker faults, in-process
failures, engine faults, and cancels alike. `bytes_in` is the submitted document size,
captured at schedule time (base64 arithmetic for the JSON route, file size for uploads).

**Export.** `_publish` — the engine's single stage-transition funnel — closes the previous
stage's clock on each transition and closes the in-flight stage under `failed`/`canceled` on
terminal publishes. `_fail` increments the failure counter with the delivery-taxonomy code
and the submitted target. The `_drive_export_job` wrapper records the terminal job total,
with `bytes_out` summed from the packaged artifact manifest.

## The correlation id thread

1. `ObservabilityMiddleware` mints (or reuses) the request id and echoes it as
   `X-Request-ID` on the **202 acceptance response**.
2. `schedule_spec_import*` / `schedule_export_job` capture it from the structlog
   contextvars at schedule time and store it on the job record (falling back to the job id
   for non-HTTP callers).
3. The engine stamps it onto **every stored status** (`status.correlation_id`) — including
   worker-produced snapshots, which cannot know it — so any poll, on any instance (via the
   shared-store mirror), returns it.
4. On failure it is **structural on the error**: `status.error.correlation_id`, for both
   taxonomies (previously it appeared only inside internal-category message text).
5. The job drivers bind it into the logging contextvars (`request_id`), so every log line
   the job emits carries it — mandatory on the export engine's separate thread loop, where
   request context does not propagate implicitly.
6. Stage timings persist as `PHASE_TIMING` events inside the job status, which the shared
   store keeps per job.

So: `X-Request-ID` on the 202 == `correlation_id` on every subsequent poll == the
`request_id` field on every log line the job wrote. Quote it in bug reports.

## Operator surfaces

- `GET /v1/ops/import-export` (platform-admin): the full aggregate view —
  `{import_export: {stages, jobs, failures}, documented_tags, scope}`.
- `GET /v1/ops/metrics` and `GET /v1/ops/status` (platform-admin): carry the same snapshot
  under `import_export`, beside the request metrics.
- `GET /v1/ops/dashboard` (platform-admin): two cards — *Import/Export jobs* (counts by
  kind × outcome, byte totals) and *Import/Export failures* (top taxonomy codes) — polling
  `/v1/ops/status` every 5 s.

## Log grep recipes

```sh
# Everything one request did, across the API call and the whole job it started:
grep '"request_id": "<the X-Request-ID>"' rest.log

# Stage timings as structured events:
grep '"event": "import_export.stage"' rest.log | jq '{kind, stage, duration_ms, outcome}'

# Failure distribution by taxonomy code (log-side; the counters are the same numbers):
grep '"event": "import_export.failure"' rest.log | jq -r '.code' | sort | uniq -c
```
