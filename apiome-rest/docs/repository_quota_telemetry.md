# Quota & rate-limit telemetry

REPO-7.3 (#2801). The per-tenant polling quota (REPO-4.6) and the per-pass scan budget
(REPO-2.5) both do their work silently. Before this, the only evidence a workspace was parked
against its ceiling was a log line and an in-process counter that died with the process — and
was per replica, so no single machine ever held the real numbers. "Is this tenant permanently
throttled, or was that one bad afternoon?" had no answer.

`apiome.repository_quota_window` is the durable answer: one counter row per
(tenant, metric, window).

## The metrics

| Metric | Window | What it counts |
|---|---|---|
| `polls` | hour | Refresh jobs the sweep enqueued — the unit `repository_polls_per_hour` bounds |
| `polls_deferred` | hour | Due repositories skipped because the tenant was out of budget |
| `files_deferred` | hour | Stale files left unenqueued when the budget ran out mid-repository |
| `scans` | day | Repository branch scan passes, completed **or** budget-paused |
| `bytes_scanned` | day | Bytes of repository content those passes indexed (rendered as MB) |

Three rules shape the table, and each of them is load-bearing:

**A window boundary is the reset.** Nothing zeroes a counter. An increment lands on the bucket
its timestamp falls in, so crossing a boundary writes to a *different row* and the new window
begins at zero. That holds across restarts, across replicas, and across a tick that straddles
the boundary — none of which a "reset the counters" job would survive.

**Deferrals are separate metrics.** `polls` says how much refreshing happened. The deferral
metrics say how much the quota pushed into a later window. Summing them would erase exactly the
signal the dashboard exists to show: a throttled tenant would look like a quiet one.

**It is an aggregate, not an event log.** The sweep increments a bucket rather than inserting a
row per poll, so a tenant polling 600 times an hour costs one row an hour. Nothing here stores a
repository id — the quota is a property of the tenant, and per-repository attribution at this
cardinality would be an event log wearing an aggregate's name. The per-repository view already
exists in the `repository.polling.quota` log line.

## How a counter is written

```
sweep tick
  ├─ repo polled within quota ──► polls += jobs enqueued
  │                               files_deferred += files left stale (if any)
  └─ repo deferred (over quota) ─► polls_deferred += 1

scan pass (job path or sweep path, one choke point)
  └─ pass returned ─────────────► scans += 1
                                  bytes_scanned += bytes this pass indexed
```

The write is a single upsert on `(tenant_id, metric, window_start)`:

```sql
INSERT INTO apiome.repository_quota_window (tenant_id, metric, window_kind, window_start, amount)
VALUES (…)
ON CONFLICT (tenant_id, metric, window_start) DO UPDATE
  SET amount = apiome.repository_quota_window.amount + EXCLUDED.amount
```

Read-then-write would let two replicas in the same window each read 0 and each write 1, losing
half the tenant's traffic. The unique key is the arbiter that stops it.

The bucket is computed in Python (`repository_quota_window.floor_to_window`, always UTC) rather
than in SQL, so the writer and the reader derive window identity from one function.

### Failure behaviour

Recording is **best-effort by contract**. Every write error is logged and swallowed, because
every caller is a sweep tick doing real work: a telemetry write that can raise would let an
observability problem stop repositories refreshing.

A scan pass that *raised* records nothing — not even the pass. It consumed provider calls, but
reporting it as scan volume would make a failing repository look like a busy one.

An unknown metric name **does** raise. That is a programming error at the call site, not a
runtime condition, and swallowing it would leave a permanently blank series and no diagnostic.

## Retention

Counter rows are pruned by the existing async-job retention sweep (there is no second background
task; that tick is already the deployment's retention worker).

| Setting | Default | Meaning |
|---|---|---|
| `APIOME_REPOSITORY_QUOTA_WINDOW_RETENTION_DAYS` | `120` | Windows older than this are deleted. `0` or below keeps counters forever |

The default is deliberately longer than the 90-day maximum range the API will serve, so
retention can never truncate a supported read.

## API

### `GET /v1/tenants/{tenant}/repository-quota-telemetry?days=7`

Requires `imports:view`. Scoped by the authenticated token, not by the path slug. `days`
defaults to 7 and is capped at 90; a value outside `[1, 90]` is rejected with `422` rather than
silently shrunk — a caller that asked for a year and got a week without being told would draw
conclusions about a range it never saw.

```json
{
  "success": true,
  "quota": {
    "pollsPerHour": 600,
    "effectivePollsPerHour": 600,
    "windowSeconds": 3600,
    "usedThisWindow": 42,
    "remainingThisWindow": 558,
    "enforced": true
  },
  "telemetry": {
    "days": 7,
    "rangeStart": "2026-07-25T00:00:00+00:00",
    "rangeEnd": "2026-07-31T00:00:00+00:00",
    "available": true,
    "metrics": [
      {
        "metric": "polls",
        "label": "Polls",
        "description": "Refresh jobs the auto-refresh sweep enqueued for this tenant. …",
        "windowKind": "hour",
        "unit": "count",
        "deferral": false,
        "points": [{ "date": "2026-07-25", "value": 120 }, "… 7 in total"],
        "total": 840,
        "peak": 160,
        "currentWindow": 42
      }
    ]
  }
}
```

The quota position ships with the history deliberately: "42 of 600 this hour" and "here is the
week" are one question, and two requests to answer it would let a panel render them out of step.

Notes on the shape:

- **Every metric is always present**, zero-filled across the whole range. A workspace that has
  never been deferred should see a flat zero line — a real answer — rather than a missing panel
  that reads as "telemetry is broken". Likewise a quiet day inside the range is a `0` point, not
  an omitted one: a chart that drops missing days draws the same shape for "steady low traffic"
  and "nothing happened for three days".
- **Hourly metrics are summed into their days** for `points`, and separately reported at their
  live-bucket value in `currentWindow` — the number to compare against `pollsPerHour`. Daily
  metrics report today's bucket there.
- **`bytes_scanned` is raw bytes**, declared by `unit`. Rounding to MB server-side would make a
  400 KB day indistinguishable from an idle one, and no client could recover the difference.
- **`available: false` means the counters could not be read.** Every series is still present and
  zeroed. The flag is what stops "we could not read this" being reported as "nothing happened" —
  only one of those warrants a page.

## UI

`/ade/dashboard/repositories/telemetry` (Repositories → **Quota & limits**). The quota position
leads, with a meter that escalates at 80% of the ceiling — by the time `polls_deferred` moves,
work has already been postponed, so the warning has to arrive earlier than that. Below it, one
card per metric with a sparkline over the range; deferral metrics take the amber tone so a glance
separates work done from work postponed without reading a label.

## Operating notes

- **`polls` looks lower than the repositories you know were polled.** It counts refresh *jobs*,
  not repositories visited — a repository with nothing stale polls and enqueues zero. That is
  what makes the series directly comparable to `pollsPerHour`.
- **A manual "Refresh Now" does not move `polls`.** It bypasses the sweep and is never
  quota-limited (RAR-5.2), so counting it would put work into a series whose whole purpose is
  to be compared against `pollsPerHour`. Its *scan* does count — a manual refresh walks the
  tree like any other pass, and that cost is real.
- **`scans` moves without `bytes_scanned` moving.** A branch that walked to completion with no
  entries (an empty branch, or a fully filtered one) is a real pass with zero volume. A
  zero-valued counter row carries no information, so none is written.
- **A resumed monorepo walk counts several passes.** Each pass counts once, and its bytes are the
  bytes *that pass* indexed — the resumed pass does not re-report what earlier passes recorded.
- **The series is empty for a period the deployment was down.** These are aggregates of work that
  happened; there is nothing to backfill from.
