-- Async job retention + slim audit history (IXH-6.3, #5122).
--
-- V158 shared the job status store across instances but never deleted rows, so
-- apiome.async_job (and list endpoints) grew without bound. V206 added export
-- artifacts with ON DELETE CASCADE and a SKIP LOCKED reap helper; this migration
-- adds the audit ledger the retention sweep writes before deleting job rows, plus
-- a partial index so the scheduled sweeper can find expired terminal jobs without
-- a long table rewrite or exclusive lock on async_job.
SET search_path TO apiome, public;

-- Slim history kept after the live job (and its artifact) are deleted. The sweep
-- inserts one row per reaped job, then prunes history older than the configured
-- history retention window (default 90 days).
CREATE TABLE IF NOT EXISTS apiome.async_job_history (
    job_id        text PRIMARY KEY,
    kind          text NOT NULL,                 -- 'spec_import' | 'export'
    tenant_slug   text NOT NULL,
    state         text NOT NULL,                 -- terminal state at reap time
    created_at    timestamptz NOT NULL,           -- original job created_at
    finished_at   timestamptz NOT NULL,           -- job updated_at when reaped
    summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE apiome.async_job_history IS
    'Slim audit ledger for reaped async jobs (IXH-6.3, #5122). Written before DELETE of apiome.async_job; pruned by the same scheduled sweep.';
COMMENT ON COLUMN apiome.async_job_history.job_id IS
    'Original async_job primary key (stable across instances).';
COMMENT ON COLUMN apiome.async_job_history.kind IS
    'Job kind: spec_import or export.';
COMMENT ON COLUMN apiome.async_job_history.tenant_slug IS
    'Owning tenant slug at reap time.';
COMMENT ON COLUMN apiome.async_job_history.state IS
    'Terminal state when the live row was deleted (completed | failed | canceled).';
COMMENT ON COLUMN apiome.async_job_history.created_at IS
    'Original async_job.created_at.';
COMMENT ON COLUMN apiome.async_job_history.finished_at IS
    'async_job.updated_at at reap time (retention clock).';
COMMENT ON COLUMN apiome.async_job_history.summary IS
    'Bounded JSON summary (percent, artifact/target or import result keys, error code) — not the full status event log.';
COMMENT ON COLUMN apiome.async_job_history.recorded_at IS
    'When the history row was inserted by the retention sweep.';

CREATE INDEX IF NOT EXISTS async_job_history_tenant_kind_idx
    ON apiome.async_job_history (tenant_slug, kind, finished_at DESC);

CREATE INDEX IF NOT EXISTS async_job_history_finished_at_idx
    ON apiome.async_job_history (finished_at);

-- Speeds the retention claim: only terminal rows, ordered by retention clock.
CREATE INDEX IF NOT EXISTS async_job_terminal_updated_at_idx
    ON apiome.async_job (updated_at)
    WHERE state IN ('completed', 'failed', 'canceled');

COMMENT ON INDEX apiome.async_job_updated_at_idx IS
    'General updated_at index (V158). Terminal retention uses async_job_terminal_updated_at_idx (V207 / IXH-6.3).';
COMMENT ON INDEX apiome.async_job_terminal_updated_at_idx IS
    'IXH-6.3 retention sweep: claim terminal jobs whose updated_at is past the per-(kind,state) retention window (FOR UPDATE SKIP LOCKED).';
