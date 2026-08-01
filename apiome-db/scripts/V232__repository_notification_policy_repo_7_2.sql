-- Repository scan/sync notification policy — opt-out + throttle (REPO-7.2, #2800).
--
-- RAR-5.4 (#3535) gave the auto-refresh loop a voice: an auto-pause, a divergence hold or a
-- failed cycle fans out over the tenant's existing push-webhook channels. What it did not
-- give anyone is a way to *stop listening*, or a guarantee that a repository stuck in a
-- failure loop cannot page the same on-call every sweep tick. REPO-7.2 adds both, as policy
-- the dispatcher consults before it resolves a single channel:
--
--   1. `apiome.repository_notification_preference` — the per-repository, per-event-type
--      opt-out. Rows are **exceptions**, not enrolments: a repository with no row at all is
--      subscribed to everything, which is what a freshly registered repository should be.
--      Only an explicit `enabled = FALSE` mutes an event, so a partially-written preference
--      set fails *open* (the operator keeps the notifications they never asked to lose)
--      rather than silently going dark.
--
--   2. `apiome.repository_notification_throttle` — one row per (repository, event type)
--      holding when that pair last notified. The dispatcher claims a slot with a conditional
--      upsert (`ON CONFLICT ... DO UPDATE ... WHERE last_notified_at <= now() - window`), so
--      the throttle decision and the timestamp write are the same atomic statement: two
--      sweep workers racing on the same repository cannot both win. A claim that loses bumps
--      `suppressed_count` instead, which is how an operator later distinguishes "quiet
--      because nothing happened" from "quiet because we muffled 400 of them".
--
-- Both tables are keyed on `(repository_id, event_type)` and cascade with the repository, so
-- deregistering a repository takes its preferences and its throttle state with it. Neither
-- table stores any part of a notification payload: they are policy state, not a message log
-- (deliveries already live in `push_webhook_delivery_events`, #2588).
--
-- `event_type` is CHECK-constrained to the three events REPO-7.2 defines, all inside the
-- `repository.refresh.*` namespace RAR-5.4 established so subscribers keep routing on one
-- prefix. Adding a fourth event is a migration, deliberately: an event type nobody can
-- opt out of is a paging channel with no off switch.

SET search_path TO apiome, public;

-- ─── 1. Per-repository, per-event-type opt-out ───────────────────────────────

CREATE TABLE IF NOT EXISTS apiome.repository_notification_preference (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    repository_id   UUID NOT NULL REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
    -- The push-webhook event type this preference governs. Constrained rather than free
    -- text: a typo in an opt-out silently fails to mute anything, which is the one failure
    -- mode an operator would not notice until the pager went off.
    event_type      VARCHAR(64) NOT NULL
                    CHECK (event_type IN (
                        'repository.refresh.auto_paused',
                        'repository.refresh.breaking_change',
                        'repository.refresh.repeated_failures'
                    )),
    -- FALSE mutes the event for this repository. TRUE is the default and is stored only
    -- when an operator explicitly re-enables something they had muted.
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_repository_notification_preference_repo_event
        UNIQUE (repository_id, event_type)
);

COMMENT ON TABLE apiome.repository_notification_preference IS
    'Per-repository, per-event-type notification opt-out (REPO-7.2, #2800). Absence of a row means subscribed: only an explicit enabled = FALSE mutes an event, so a partial preference set fails open.';
COMMENT ON COLUMN apiome.repository_notification_preference.event_type IS
    'One of the REPO-7.2 repository.refresh.* events. CHECK-constrained so an opt-out cannot be written against an event type that does not exist.';
COMMENT ON COLUMN apiome.repository_notification_preference.enabled IS
    'FALSE mutes this event for this repository. The dispatcher reads only the muted rows; every other event is delivered.';

-- The dispatcher's only read: "which events are muted for this repository". Partial, because
-- the mutes are the rare rows — on a healthy deployment this index is nearly empty.
CREATE INDEX IF NOT EXISTS idx_repository_notification_preference_muted
    ON apiome.repository_notification_preference (repository_id)
    WHERE enabled = FALSE;

COMMENT ON INDEX apiome.idx_repository_notification_preference_muted IS
    'Answers the dispatcher gate (REPO-7.2): the muted event types for one repository. Partial on enabled = FALSE because opt-outs are the exception, not the rule.';

CREATE INDEX IF NOT EXISTS idx_repository_notification_preference_tenant
    ON apiome.repository_notification_preference (tenant_id);

COMMENT ON INDEX apiome.idx_repository_notification_preference_tenant IS
    'Tenant-scoped sweep of notification opt-outs (REPO-7.2), for support and audit reads.';

-- ─── 2. Per-repository, per-event-type hourly throttle ───────────────────────

CREATE TABLE IF NOT EXISTS apiome.repository_notification_throttle (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    repository_id    UUID NOT NULL REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
    event_type       VARCHAR(64) NOT NULL
                     CHECK (event_type IN (
                         'repository.refresh.auto_paused',
                         'repository.refresh.breaking_change',
                         'repository.refresh.repeated_failures'
                     )),
    -- When this (repository, event type) pair last won a slot. The conditional upsert
    -- compares against this and rewrites it in the same statement, so the window cannot be
    -- read stale by a concurrent sweep worker.
    last_notified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- How many notifications this pair has swallowed since it was created. Never reset:
    -- it is the running answer to "how loud would this repository have been".
    suppressed_count BIGINT NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_repository_notification_throttle_repo_event
        UNIQUE (repository_id, event_type)
);

COMMENT ON TABLE apiome.repository_notification_throttle IS
    'Per-repository, per-event-type notification throttle state (REPO-7.2, #2800): when the pair last notified, and how many notifications have been suppressed since. The unique (repository_id, event_type) key is the conflict target of the dispatcher''s atomic slot claim.';
COMMENT ON COLUMN apiome.repository_notification_throttle.last_notified_at IS
    'When this pair last won a throttle slot. Rewritten only by a winning claim, so a losing claim cannot extend the quiet window.';
COMMENT ON COLUMN apiome.repository_notification_throttle.suppressed_count IS
    'Running count of notifications suppressed by the throttle for this pair. Distinguishes "nothing happened" from "we muffled it".';

CREATE INDEX IF NOT EXISTS idx_repository_notification_throttle_tenant
    ON apiome.repository_notification_throttle (tenant_id, last_notified_at DESC);

COMMENT ON INDEX apiome.idx_repository_notification_throttle_tenant IS
    'Tenant-scoped "what has been notifying recently / what are we suppressing" read (REPO-7.2).';
