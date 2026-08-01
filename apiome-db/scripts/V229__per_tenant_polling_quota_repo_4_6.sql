-- Per-tenant repository polling quotas (REPO-4.6, #2784).
--
-- The repository auto-refresh scheduler walks every due repository each tick and enqueues a
-- re-import job per stale file. Without a per-tenant bound, one noisy tenant — a thousand
-- repositories, or a handful on a very fast cadence — occupies the head of every tick and
-- starves the scheduler for everyone else.
--
-- RAR-3.5 (#3526) introduced the bound as a *process-wide* environment setting
-- (`APIOME_REFRESH_TENANT_QUOTA`), which is the right emergency brake but the wrong unit of
-- configuration: the quota is a property of the tenant's plan, not of the deployment. This
-- migration moves the limit onto the tenant row, where it can differ per tenant and survive a
-- restart:
--
--   `tenants.repository_polls_per_hour` — the maximum number of repository poll (refresh) jobs
--   a tenant may have enqueued inside one rolling quota window. Default 60; the elevated
--   ("enterprise") plan is backfilled to 600. `0` means *unlimited* for that tenant — the
--   explicit opt-out an operator sets when a tenant must never be deferred. Negative values are
--   rejected by the CHECK below.
--
-- Enforcement lives in the application (`app.repository_refresh_quota`), which reads these
-- values once per sweep tick, seeds them with the jobs each tenant already enqueued inside the
-- window, and *defers* the remaining due repositories of any tenant that is over its bound. A
-- deferral is a scheduling decision, not an error: the repository keeps its cadence anchor, its
-- consecutive-failure counter is untouched, and it is picked up by a later tick once the window
-- rolls. The environment setting remains as the fallback default for tenants with no explicit
-- value, and as the global kill switch (`<= 0` disables the bound everywhere).
--
-- Manual "Refresh Now" (RAR-5.2) does not run through the scheduler and is never quota-limited,
-- consistent with how the RAR-3.3 kill switch and the RAR-3.4 backoff treat the manual path.
SET search_path TO apiome, public;

-- 1. Per-tenant polling quota -------------------------------------------------

ALTER TABLE apiome.tenants
  ADD COLUMN IF NOT EXISTS repository_polls_per_hour INTEGER NOT NULL DEFAULT 60;

ALTER TABLE apiome.tenants
  DROP CONSTRAINT IF EXISTS ck_tenants_repository_polls_per_hour_non_negative;

ALTER TABLE apiome.tenants
  ADD CONSTRAINT ck_tenants_repository_polls_per_hour_non_negative
  CHECK (repository_polls_per_hour >= 0);

COMMENT ON COLUMN apiome.tenants.repository_polls_per_hour IS
  'Maximum repository poll (refresh) jobs this tenant may enqueue per rolling quota window (REPO-4.6, default 60; the elevated/enterprise plan is seeded at 600). 0 means unlimited for this tenant. Enforced by the auto-refresh scheduler before dispatch: a tenant over its quota has its remaining due repositories deferred to a later tick — logged, never counted as a refresh failure. The window length is APIOME_REFRESH_TENANT_QUOTA_WINDOW (default 3600s) and APIOME_REFRESH_TENANT_QUOTA is the fallback for tenants left at the default.';

-- 2. Backfill the elevated ("enterprise") plan to 600 -------------------------
--
-- The V097 catalog classifies plans as free / paid / sponsor. `sponsor` is the elevated tier
-- ("all features, elevated tenant and user limits") and is what the application's own tier
-- resolution (app.intake_resource_guard) already treats as enterprise-grade, so it is the tier
-- that receives the 600 polls/hour allowance. Everyone else keeps the 60 default.
--
-- Only rows still sitting at the default are touched, so re-running this migration (or running
-- it after an operator has tuned a tenant by hand) never clobbers a deliberate value.

UPDATE apiome.tenants t
SET    repository_polls_per_hour = 600,
       updated_at = CURRENT_TIMESTAMP
FROM   apiome.tenant_licenses tl
JOIN   apiome.licenses l ON l.id = tl.license_id
WHERE  tl.tenant_id = t.id
  AND  l.license_type = 'sponsor'
  AND  t.repository_polls_per_hour = 60;

-- 3. Scheduler lookup index ---------------------------------------------------
--
-- The sweep reads the quota for every live tenant once per tick. The partial index keeps that
-- read off a sequential scan of the full tenant table as the deployment grows.

CREATE INDEX IF NOT EXISTS idx_tenants_repository_polls_per_hour
  ON apiome.tenants (id, repository_polls_per_hour)
  WHERE deleted_at IS NULL;
