-- Per-tenant repository quota & rate-limit telemetry (REPO-7.3, #2801).
--
-- REPO-4.6 (#2784) gave the auto-refresh sweep a per-tenant polling quota, and REPO-2.5
-- (#2766) gave each scan pass a wall-clock budget. Both work. Neither is *visible*: the only
-- record of a deferral is a log line and a process-local counter (`app.repository_polling_
-- telemetry`) that resets on every restart and is per replica. An operator asking "is this
-- tenant permanently parked against its ceiling, or was that one bad afternoon?" has had no
-- way to answer.
--
-- `apiome.repository_quota_window` is that answer: one durable counter row per
-- (tenant, metric, window). It is a rolling-window aggregate, not an event log — the sweep
-- increments a bucket rather than inserting a row per poll, so a tenant polling 600 times an
-- hour costs 1 row an hour, not 600.
--
-- **Windows are the reset.** There is no scheduled job that zeroes anything: crossing a
-- window boundary means the next increment lands on a *different* `window_start`, so the new
-- window starts at zero by construction and the previous one is frozen as history. That is
-- what makes "counters reset on the quota window boundary" true even when a replica restarts,
-- two replicas sweep concurrently, or a tick straddles the boundary.
--
-- **Deferrals are their own metrics.** `polls_deferred` and `files_deferred` are counted
-- separately from `polls` rather than folded into it, because they answer a different
-- question: `polls` is "how much work did we do", the deferral metrics are "how much work did
-- the quota push into a later window". Summing them would hide exactly the signal the
-- dashboard exists to show.
--
-- **Granularity is per metric.** Polling is bounded per hour (REPO-4.6's window), so poll
-- metrics bucket hourly; scan volume is a daily shape, so scan metrics bucket daily. The
-- `window_kind` column records which, so a reader never has to infer a bucket's width from
-- the spacing of the rows it happens to find.
--
-- Nothing here stores a repository id. The quota is a property of the *tenant* (REPO-4.6),
-- and per-repository attribution at this cardinality would be an event log wearing an
-- aggregate's name. The per-repository view already exists in the structured
-- `repository.polling.quota` log line.

SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS apiome.repository_quota_window (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    -- The counter this row accumulates. CHECK-constrained rather than free text: a typo in a
    -- metric name would silently create a parallel counter nobody reads, and the dashboard
    -- would show a flat line for a metric that is in fact being recorded.
    metric        VARCHAR(32) NOT NULL
                  CHECK (metric IN (
                      'polls',
                      'polls_deferred',
                      'files_deferred',
                      'scans',
                      'bytes_scanned'
                  )),
    -- The bucket width `window_start` was truncated to. Stored, not inferred: a metric with
    -- no activity for six hours leaves no rows to infer spacing from.
    window_kind   VARCHAR(8) NOT NULL CHECK (window_kind IN ('hour', 'day')),
    -- Start of the bucket, truncated to `window_kind` in UTC by the writer. This is the
    -- column that makes the reset implicit: a new window is a new row.
    window_start  TIMESTAMPTZ NOT NULL,
    -- What has accumulated in this window. BIGINT because `bytes_scanned` on a monorepo
    -- tenant passes 2^31 in a single day.
    amount        BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The conflict target of the writer's `INSERT ... ON CONFLICT DO UPDATE SET amount =
    -- amount + EXCLUDED.amount`. Without it two replicas sweeping the same tenant in the same
    -- window would each create a row and every read would be half the truth.
    CONSTRAINT uq_repository_quota_window_tenant_metric_start
        UNIQUE (tenant_id, metric, window_start)
);

COMMENT ON TABLE apiome.repository_quota_window IS
    'Rolling-window per-tenant counters for repository polling quota and scan volume (REPO-7.3, #2801). One row per (tenant, metric, window); crossing a window boundary is what resets a counter, so no scheduled zeroing job exists.';
COMMENT ON COLUMN apiome.repository_quota_window.metric IS
    'Which counter: polls / polls_deferred / files_deferred (hourly, REPO-4.6 quota) or scans / bytes_scanned (daily, REPO-2.5 scan volume). Deferrals are separate metrics, never folded into polls.';
COMMENT ON COLUMN apiome.repository_quota_window.window_kind IS
    'Bucket width of window_start (hour or day). Stored rather than inferred, because a quiet metric leaves no rows to infer spacing from.';
COMMENT ON COLUMN apiome.repository_quota_window.window_start IS
    'Start of the bucket, truncated to window_kind in UTC. A new window_start is a fresh counter — this is the reset.';
COMMENT ON COLUMN apiome.repository_quota_window.amount IS
    'Accumulated value for the window: a count for every metric except bytes_scanned, which is raw bytes (the dashboard renders MB).';

-- The dashboard read: "every metric for this tenant over the last 7 days", newest first.
CREATE INDEX IF NOT EXISTS idx_repository_quota_window_tenant_recent
    ON apiome.repository_quota_window (tenant_id, window_start DESC);

COMMENT ON INDEX apiome.idx_repository_quota_window_tenant_recent IS
    'Answers the REPO-7.3 dashboard read: one tenant''s counters over a trailing window, newest first.';

-- The retention prune walks by age across all tenants, which the tenant-leading index above
-- cannot serve.
CREATE INDEX IF NOT EXISTS idx_repository_quota_window_start
    ON apiome.repository_quota_window (window_start);

COMMENT ON INDEX apiome.idx_repository_quota_window_start IS
    'Serves the retention prune (REPO-7.3), which selects by age across all tenants rather than within one.';
