# Per-tenant repository polling quotas

REPO-4.6 (#2784). The auto-refresh scheduler walks every *due* repository on each tick and
enqueues a re-import job per stale file. Without a bound, one tenant with a thousand
repositories — or a handful on a very fast cadence — occupies the head of every tick and
starves the scheduler for everyone else.

A polling quota puts a ceiling on how many poll (refresh) jobs a **tenant** may enqueue per
rolling window. Repositories beyond the ceiling are **deferred**, not failed: they keep their
place in the queue and are picked up by a later tick once the window rolls.

## Where the number lives

| | |
|---|---|
| Column | `apiome.tenants.repository_polls_per_hour` |
| Default | `60` |
| Elevated ("enterprise") plan | `600` — backfilled by migration V229 for tenants holding a `sponsor` license |
| `0` | **Unlimited** for that tenant — the explicit opt-out |
| Negative | Rejected by `ck_tenants_repository_polls_per_hour_non_negative` |

Two environment settings act on the *deployment*, not on a tenant:

| Setting | Default | Meaning |
|---|---|---|
| `APIOME_REFRESH_TENANT_QUOTA` | `60` | Fallback for tenants whose row cannot be read, **and** the kill switch: `<= 0` disables quota enforcement everywhere (fairness interleaving still applies) |
| `APIOME_REFRESH_TENANT_QUOTA_WINDOW` | `3600` | Rolling window length in seconds — the "per hour" in polls-per-hour |

## How a tick enforces it

```
list_due_repositories()                    oldest-first, globally
  └─► interleave_due_rows_by_tenant()      round-robin, one repo per tenant per round
        └─► for each due repo:
              tenant over quota? ──► DEFER  (no lock, no anchor advance, no failure)
              otherwise         ──► poll, bounded by the tenant's remaining budget
                                     └─► budget runs out mid-repo? the remaining stale
                                         files stay stale for a later tick
```

The tracker is seeded once per tick with the jobs each tenant already enqueued inside the
window (a database count over `tenant_repository_refresh_jobs.created_at`), then decremented
in memory as the tick enqueues more. That is what makes the bound hold across ticks, across
workers restarting mid-window, and across a tenant's many repositories in one tick.

Fairness and the quota are separate tools solving the same problem from two directions:
interleaving stops one tenant *dominating the order*, the quota stops one tenant *consuming
the volume*.

## Deferral is not a failure

This is the rule that matters most, and it is enforced in three places:

- the repository's **cadence anchor is not advanced**, so it stays due;
- **no lock is taken**, so it costs nothing and blocks nobody;
- the **RAR-3.4 backoff / auto-pause bookkeeping is not touched** — a deferred repository's
  consecutive-failure counter is untouched, it cannot back off, and it cannot auto-pause.

A tenant permanently parked against its ceiling therefore polls slower, and never degrades.

## Not quota-limited

Manual **"Refresh Now"** (RAR-5.2) does not run through the sweep and is never bounded — the
same treatment the global kill switch and the backoff give the manual path. A webhook delivery
(REPO-4.3) marks a repository due immediately, but the resulting poll goes through the sweep
and *is* bounded.

## Telemetry

Every tick records into `app.repository_polling_telemetry` (per-process counters, surfaced by
REPO-7.3):

| Counter | Meaning |
|---|---|
| `poll_dispatched` / `poll_dispatched_jobs` | Repositories polled within quota, and the jobs they enqueued |
| `repository_deferred` | Due repositories skipped because their tenant was out of budget |
| `files_deferred` / `files_deferred_jobs` | Repositories that ran out of budget part-way, and the stale files left unenqueued |

Each counter is kept in aggregate and per tenant. The per-tenant breakdown is bounded at 1000
tenants; beyond that, tenants aggregate into an `__overflow__` bucket. Aggregate totals are
always exact.

Every record also emits one structured log line, `repository.polling.quota`, at INFO — quota
pressure is a routine scheduling outcome, and an operator watching for errors must not see it
as one.

## API

Both endpoints are scoped by the authenticated token, not by the path slug.

### `GET /v1/tenants/{tenant}/repository-polling-quota`

Requires `imports:view`.

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
  }
}
```

`pollsPerHour` is what is stored; `effectivePollsPerHour` is what the scheduler actually
applies right now. They differ when the tenant is unlimited (`0`) or when quotas are disabled
deployment-wide — in both cases `effectivePollsPerHour` and `remainingThisWindow` are `null`
and `enforced` is `false`.

A window-usage count that fails reports `usedThisWindow: 0` rather than failing the read: an
operator asking "what is my quota?" should still get an answer.

### `PUT /v1/tenants/{tenant}/repository-polling-quota`

Requires `imports:edit`.

```json
{ "pollsPerHour": 600 }
```

`0` means unlimited. Values above `100000` are rejected (`422`) — unlimited is spelled `0`, so
a five-figure quota is far more likely a typo than an intent. A negative value is rejected the
same way. The response is the same projection as the read.

The change takes effect on the **next sweep tick**. It does not retroactively release
repositories already deferred in the current one, and it never touches any repository's
failure bookkeeping.

## Operating notes

- **A tenant reports `enforced: false` but you did not set `0`.** Check
  `APIOME_REFRESH_TENANT_QUOTA` — a deployment-wide `<= 0` disables enforcement while leaving
  every stored value intact.
- **Deferrals with plenty of budget showing.** The budget is per *window*, not per tick; the
  count includes jobs enqueued by earlier ticks inside the same window.
- **Raising a quota does not clear a backlog immediately.** The backlog drains a tick at a
  time, still round-robined against every other tenant.
