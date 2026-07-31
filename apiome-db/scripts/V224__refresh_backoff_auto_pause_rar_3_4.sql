-- Refresh backoff + auto-pause (RAR-3.4, #3525) — extends REPO-4.5 (#2783) to the
-- auto-refresh loop.
--
-- A repeatedly failing refresh (bad credentials, malformed spec, provider outage)
-- would hammer the provider and the importer every interval. Four columns let the
-- sweep back off exponentially on consecutive failures and pause the repository
-- entirely after a configurable threshold:
--
--   1. `refresh_consecutive_failures` — back-to-back failed refresh ticks. Reset to
--      0 on the first successful tick; drives the exponential backoff multiplier
--      (interval × 2^n, capped ×32 per REPO-4.5) and the auto-pause threshold
--      (`APIOME_REFRESH_AUTO_PAUSE_THRESHOLD`, default 8). The stored
--      `refresh_interval_seconds` is never mutated by backoff.
--   2. `refresh_backoff_until` — the earliest moment the repository may be selected
--      as due again; `list_due_repositories` skips rows whose anchor is in the
--      future. Stamped on each failure, cleared on success/resume.
--   3. `refresh_paused_at` — when the repo tripped the auto-pause threshold. A
--      paused repository is excluded from due-selection until a manual resume
--      (POST .../refresh/resume) clears it. Manual "Refresh Now" (RAR-5.2) is
--      unaffected, mirroring the RAR-3.3 gates.
--   4. `refresh_pause_reason` — diagnostic text (last error) recorded at the moment
--      the pause tripped, surfaced to the dashboard and the RAR-5.4 notification.
SET search_path TO apiome, public;

ALTER TABLE apiome.tenant_repositories
  ADD COLUMN IF NOT EXISTS refresh_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refresh_backoff_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_pause_reason TEXT;

-- The counter can never go negative; success/resume reset it to exactly 0.
ALTER TABLE apiome.tenant_repositories
  DROP CONSTRAINT IF EXISTS ck_tenant_repositories_refresh_failures_nonnegative;
ALTER TABLE apiome.tenant_repositories
  ADD CONSTRAINT ck_tenant_repositories_refresh_failures_nonnegative
  CHECK (refresh_consecutive_failures >= 0);

COMMENT ON COLUMN apiome.tenant_repositories.refresh_consecutive_failures IS
  'Back-to-back failed auto-refresh ticks (RAR-3.4). Drives the exponential backoff multiplier and the auto-pause threshold; reset to 0 on the first successful tick or a manual resume.';

COMMENT ON COLUMN apiome.tenant_repositories.refresh_backoff_until IS
  'Earliest moment the auto-refresh sweep may pick this repository again (RAR-3.4). Stamped now() + backoff on each failed tick; NULL (no deferral) after success or resume.';

COMMENT ON COLUMN apiome.tenant_repositories.refresh_paused_at IS
  'When the repository auto-paused after APIOME_REFRESH_AUTO_PAUSE_THRESHOLD consecutive refresh failures (RAR-3.4). Non-NULL excludes it from due-selection until a manual resume clears it; manual Refresh Now is unaffected.';

COMMENT ON COLUMN apiome.tenant_repositories.refresh_pause_reason IS
  'Diagnostic text (last refresh error) captured when the auto-pause tripped (RAR-3.4); cleared on manual resume.';
