-- Repository webhook subscriptions — push / PR ingestion (REPO-4.3, #2781).
--
-- Polling has a floor. `APIOME_REFRESH_MIN_INTERVAL` bounds how often the RAR-3.2 sweep
-- can even look at a repository, and the per-repo `refresh_interval_seconds` is usually
-- measured in minutes or hours. For a branch a team is actively pushing to, that is the
-- difference between "the catalog matched the repository a moment ago" and "the catalog
-- matched the repository some time this afternoon". REPO-4.3 removes the floor for the
-- pushes we are told about: the provider calls us, and the repository becomes due
-- immediately.
--
-- Two tables, with deliberately different rules:
--
--   1. `apiome.repository_webhook_subscription` — one row per registered repository. Holds
--      the HMAC signing secret, Fernet-encrypted at rest (`push_webhook_crypto`), plus the
--      provider-side hook id when we were able to create one. The secret is **write-once**:
--      the immutability trigger below refuses any UPDATE that would change `secret_enc`
--      once it is set. A secret that can be silently rewritten is a secret an attacker with
--      one write primitive can replace with their own, after which every forged delivery
--      verifies. Rotation is delete-and-recreate, which is visible in the ledger.
--
--   2. `apiome.repository_webhook_event` — one row per delivery, append-only. This is the
--      answer to "why did this repository re-import at 03:14" and to "who has been sending
--      us deliveries that do not verify". UPDATE and DELETE are refused by trigger, the
--      same discipline as `slate_preview_audit` and `workflow_audit`.
--
-- The secret never leaves the database. `secret_enc` is not selected into any API model —
-- the REST projection (`repository_webhook_subscriptions.describe_subscription`) returns
-- the state, the provider hook id and a short non-reversible fingerprint, and nothing else.
-- The event ledger deliberately carries no secret column at all: an append-only table that
-- held key material would be a key-history table that cannot be redacted.
--
-- Redelivery is a no-op, not a duplicate poll. Providers redeliver freely (GitHub does so
-- on any 5xx, and on demand from the UI). `uq_repository_webhook_event_delivery` makes a
-- second delivery of the same provider delivery id collide on insert, so the ingestion path
-- records it as `duplicate` and enqueues nothing rather than fanning out a second scan.
--
-- What a delivery actually triggers lives in the application (`repository_webhook_dispatch`):
-- a push on a *tracked* branch (one with a stored RAR-1.2 import spec) enqueues a branch scan
-- job and clears the repository's cadence anchor so the refresh sweep picks it up on its next
-- tick; a pull-request event optionally enqueues a scan of the PR head branch. Nothing here
-- imports anything by itself — the existing scan and refresh workers do that, under all the
-- gates they already enforce.

SET search_path TO apiome, public;

-- ─── 1. Subscription (one per repository; holds the write-once secret) ────────

CREATE TABLE IF NOT EXISTS apiome.repository_webhook_subscription (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    -- One subscription per repository: the ingestion path resolves a delivery to a
    -- repository, and two live secrets for one repository would make "which secret is
    -- authoritative" a question with no answer.
    repository_id       UUID NOT NULL UNIQUE
                        REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
    provider            VARCHAR(32) NOT NULL
                        CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
    -- Lowercased "owner/name". The ingestion path has only the delivery payload, not a
    -- tenant, so it resolves the subscription by (provider, repo_full_name) and then
    -- verifies the signature with this row's secret.
    repo_full_name      TEXT NOT NULL,
    -- Fernet ciphertext of the HMAC signing secret (push_webhook_crypto.encrypt_signing_secret).
    -- NULL when the deployment has no encryption key configured, in which case verification
    -- fails closed: an unverifiable delivery is rejected, never accepted on trust.
    secret_enc          BYTEA,
    -- Truncated SHA-256 of the plaintext secret. Lets an operator confirm that the secret
    -- configured at the provider is the one we hold without either side revealing it.
    secret_fingerprint  VARCHAR(32),
    -- Whether pull-request events may enqueue a preview scan of the PR head branch.
    pr_preview_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    -- The provider's own hook identifier, when we were able to create the hook for the
    -- tenant. NULL when the hook must be configured by hand (see registration_state).
    provider_hook_id    TEXT,
    -- How far registration actually got. `registered` means the provider confirmed a hook;
    -- `local` means we hold a secret and will honour deliveries, but nobody has pointed the
    -- provider at us yet; `failed` means the provider refused (recorded, with the reason, so
    -- the UI can tell an operator to finish the job by hand rather than silently polling).
    registration_state  VARCHAR(16) NOT NULL DEFAULT 'local'
                        CHECK (registration_state IN ('local', 'registered', 'failed')),
    registration_error  TEXT,
    last_event_at       TIMESTAMPTZ,
    last_delivery_id    TEXT,
    event_count         BIGINT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE apiome.repository_webhook_subscription IS
    'One provider webhook subscription per registered repository (REPO-4.3, #2781). Holds the Fernet-encrypted HMAC signing secret, which is write-once (see repository_webhook_secret_guard) and is never projected into an API response.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.repo_full_name IS
    'Lowercased owner/name — the key the unauthenticated ingestion endpoint resolves a delivery against before it can verify anything.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.secret_enc IS
    'Fernet ciphertext of the HMAC signing secret. Write-once: once set it cannot be changed by UPDATE. NULL disables verification, which fails closed (every delivery is rejected).';
COMMENT ON COLUMN apiome.repository_webhook_subscription.secret_fingerprint IS
    'Truncated SHA-256 of the plaintext secret, safe to display: it identifies the secret without revealing it.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.pr_preview_enabled IS
    'Whether pull-request events may enqueue a preview scan of the PR head branch. The global APIOME_REPOSITORY_WEBHOOK_PR_PREVIEW kill switch overrides it.';
COMMENT ON COLUMN apiome.repository_webhook_subscription.registration_state IS
    'local = secret held, provider not yet pointed at us; registered = the provider confirmed a hook; failed = the provider refused (registration_error says why).';

CREATE INDEX IF NOT EXISTS idx_repository_webhook_subscription_tenant
    ON apiome.repository_webhook_subscription (tenant_id);
-- The ingestion path's only lookup: it has a provider and a repository full name.
CREATE INDEX IF NOT EXISTS idx_repository_webhook_subscription_repo
    ON apiome.repository_webhook_subscription (provider, repo_full_name);

-- Write-once secret + stable identity. A subscription whose secret could be rewritten in
-- place would let anyone with a single UPDATE primitive install their own signing key and
-- have every forged delivery verify from then on; a subscription that could be repointed at
-- another repository would let one tenant's deliveries drive another tenant's imports.
CREATE OR REPLACE FUNCTION apiome.repository_webhook_secret_guard()
RETURNS trigger AS $$
DECLARE
    v_changed TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NEW.id            IS DISTINCT FROM OLD.id            THEN v_changed := array_append(v_changed, 'id');            END IF;
    IF NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id     THEN v_changed := array_append(v_changed, 'tenant_id');     END IF;
    IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN v_changed := array_append(v_changed, 'repository_id'); END IF;
    IF NEW.created_at    IS DISTINCT FROM OLD.created_at    THEN v_changed := array_append(v_changed, 'created_at');    END IF;
    -- The secret is write-once only once it exists: a row created before the deployment had
    -- an encryption key (secret_enc NULL) may still be given one, but never a different one.
    IF OLD.secret_enc IS NOT NULL AND NEW.secret_enc IS DISTINCT FROM OLD.secret_enc THEN
        v_changed := array_append(v_changed, 'secret_enc');
    END IF;

    IF array_length(v_changed, 1) > 0 THEN
        RAISE EXCEPTION
            'repository_webhook_subscription is write-once: % cannot change after the subscription is created',
            array_to_string(v_changed, ', ')
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.repository_webhook_secret_guard() IS
    'Refuses any UPDATE that would rewrite a repository webhook signing secret or repoint a subscription at another repository/tenant (REPO-4.3). Rotation is delete-and-recreate.';

DROP TRIGGER IF EXISTS trg_repository_webhook_secret_guard ON apiome.repository_webhook_subscription;
CREATE TRIGGER trg_repository_webhook_secret_guard
    BEFORE UPDATE ON apiome.repository_webhook_subscription
    FOR EACH ROW EXECUTE FUNCTION apiome.repository_webhook_secret_guard();

-- ─── 2. Delivery ledger (append-only) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apiome.repository_webhook_event (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- NULL for a delivery naming a repository nobody here has registered: there is no tenant
    -- to attribute it to, and the row exists precisely so that traffic is not invisible.
    tenant_id         UUID REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    subscription_id   UUID REFERENCES apiome.repository_webhook_subscription(id) ON DELETE CASCADE,
    repository_id     UUID REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
    provider          VARCHAR(32) NOT NULL,
    -- The provider's delivery identifier (X-GitHub-Delivery and friends). The idempotency
    -- key: a redelivery collides rather than enqueuing a second scan.
    delivery_id       TEXT,
    event_type        VARCHAR(64),
    action            VARCHAR(64),
    repo_full_name    TEXT,
    branch            TEXT,
    head_sha          VARCHAR(64),
    pr_number         INTEGER,
    -- What we did about it. `enqueued` = a scan was queued; `preview-scan` = a PR head scan
    -- was queued; `ignored` = understood and deliberately not acted on (untracked branch,
    -- tag push, unknown repository); `duplicate` = a redelivery of a delivery id we have
    -- already processed; `rejected` = the signature did not verify (a 401 to the caller).
    outcome           VARCHAR(24) NOT NULL
                      CHECK (outcome IN ('enqueued', 'preview-scan', 'ignored', 'duplicate', 'rejected')),
    -- Stable machine-readable code explaining the outcome (e.g. branch-not-tracked).
    reason            VARCHAR(64),
    jobs_enqueued     INTEGER NOT NULL DEFAULT 0 CHECK (jobs_enqueued >= 0),
    received_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE apiome.repository_webhook_event IS
    'Append-only ledger of repository webhook deliveries (REPO-4.3, #2781): what arrived, whether it verified, and what it triggered. Carries no secret material — the signing secret lives only in repository_webhook_subscription.';
COMMENT ON COLUMN apiome.repository_webhook_event.tenant_id IS
    'NULL when the delivery named a repository that is not registered here; the row still exists so unattributed traffic is visible.';
COMMENT ON COLUMN apiome.repository_webhook_event.delivery_id IS
    'Provider delivery identifier. Unique per subscription: a redelivery collides and is recorded as duplicate instead of enqueuing a second scan.';
COMMENT ON COLUMN apiome.repository_webhook_event.outcome IS
    'enqueued | preview-scan | ignored | duplicate | rejected. rejected is the 401 path and is always accompanied by a workflow_audit row.';

CREATE INDEX IF NOT EXISTS idx_repository_webhook_event_repository
    ON apiome.repository_webhook_event (repository_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_webhook_event_tenant
    ON apiome.repository_webhook_event (tenant_id, received_at DESC);
-- "Show me deliveries that did not verify" — the query an operator runs during an incident.
CREATE INDEX IF NOT EXISTS idx_repository_webhook_event_rejected
    ON apiome.repository_webhook_event (received_at DESC)
    WHERE outcome = 'rejected';

-- Redelivery idempotency. Scoped to the subscription so two repositories cannot collide on a
-- provider that reuses delivery identifiers, and partial so a provider that sends no delivery
-- id at all still gets its events recorded (it simply gets no idempotency from this index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_webhook_event_delivery
    ON apiome.repository_webhook_event (subscription_id, delivery_id)
    WHERE subscription_id IS NOT NULL AND delivery_id IS NOT NULL;

CREATE OR REPLACE FUNCTION apiome.repository_webhook_event_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'repository_webhook_event is append-only: % is not permitted', TG_OP
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.repository_webhook_event_append_only() IS
    'Refuses UPDATE and DELETE on repository_webhook_event (REPO-4.3). Delivery history only ever grows.';

DROP TRIGGER IF EXISTS trg_repository_webhook_event_append_only ON apiome.repository_webhook_event;
CREATE TRIGGER trg_repository_webhook_event_append_only
    BEFORE UPDATE OR DELETE ON apiome.repository_webhook_event
    FOR EACH ROW EXECUTE FUNCTION apiome.repository_webhook_event_append_only();
