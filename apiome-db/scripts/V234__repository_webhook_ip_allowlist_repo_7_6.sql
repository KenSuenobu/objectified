-- Source-IP allowlist for webhook ingestion (REPO-7.6, #2804).
--
-- `POST /v1/repositories/webhook/{provider}` is the one repository route that carries no
-- bearer token — a provider cannot hold one — so the HMAC signature over the raw body is its
-- only authentication (REPO-4.3, #2781). That check is sound, but it is reached by *anyone*
-- who can open a socket: every unsigned POST from every scanner on the internet gets a
-- constant-time comparison, a subscription lookup, and a ledger row. An IP filter in front of
-- it turns "we reject every forgery" into "we never look at one", which is what defense in
-- depth means here.
--
-- Four tables, because the allowlist has two independent halves and each half needs to
-- record how it got there:
--
--   apiome.webhook_provider_ip_range     The provider-published ranges, cached. Refreshed
--                                        daily from the provider's own endpoint (GitHub's
--                                        `meta`, Atlassian's `ip-ranges`), because these
--                                        ranges genuinely move and a hard-coded list is a
--                                        future outage with a long lead time.
--   apiome.webhook_provider_ip_refresh   One row per provider recording the last attempt and
--                                        the last *success* separately. "The cache is 40
--                                        minutes stale because the fetch has failed for two
--                                        days" and "the cache is fresh" must be
--                                        distinguishable, and a table that only stored
--                                        `refreshed_at` could not tell them apart.
--   apiome.tenant_webhook_ip_allowlist   Per-tenant additional CIDRs — a self-hosted GitLab
--                                        runner, a corporate egress gateway, a relay. The
--                                        provider list cannot know about these.
--   apiome.tenant_webhook_ip_policy      Per-tenant enforcement switch. Turning enforcement
--                                        off for a tenant is the documented escape hatch for
--                                        "our provider egresses from an address nobody
--                                        publishes", and the ticket puts it behind the
--                                        tenant-admin role — enforced in the API layer, with
--                                        `updated_by` here so the ledger can name who did it.
--
-- **Why the ranges are cached in the database rather than in each replica's memory.** The
-- fetch is an outbound call to a third party. Held per process, a ten-replica deployment
-- makes ten calls a day, each replica has its own idea of the truth for as long as its cache
-- lives, and a replica that starts during a GitHub outage has *no* ranges — which, for a
-- filter, means it either blocks everything or allows everything. One shared cache with an
-- explicit staleness record makes the failure visible instead of per-replica and invisible.
--
-- **Why CIDRs are TEXT and not the `cidr` type.** The matching runs in Python
-- (`ipaddress.ip_network`), not in SQL: the decision needs to be reachable from unit tests
-- with no database, and the whole point of the guard is that it runs before anything
-- expensive. Storing the type would let Postgres normalise on write behind the checker's
-- back, so writer and reader could disagree about what a row means. The application
-- normalises every value through one function before it is stored.

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------
-- Provider-published ranges (the daily-refreshed half)
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS apiome.webhook_provider_ip_range (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Constrained to the providers whose deliveries the endpoint can verify at all
    -- (repository_webhook_ingest.SUPPORTED_PROVIDERS). A range for a provider we cannot
    -- verify would be an allowlist entry protecting nothing.
    provider     VARCHAR(32) NOT NULL
                 CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
    -- Normalised CIDR in its `ipaddress`-canonical form, e.g. 192.30.252.0/22 or
    -- 2a0a:a440::/29. 43 characters covers the longest IPv6 CIDR text; 64 leaves room.
    cidr         VARCHAR(64) NOT NULL,
    -- 4 or 6. Denormalised from the CIDR so the guard can read only the family the client
    -- address actually belongs to instead of parsing every row on every request.
    family       SMALLINT NOT NULL CHECK (family IN (4, 6)),
    -- Where this row came from: `provider` for a live fetch, `configured` for a static list
    -- supplied by the deployment (the escape hatch for a provider that publishes no
    -- machine-readable ranges). An operator reading the table must be able to tell a range
    -- the provider vouches for from one we were told about.
    source       VARCHAR(16) NOT NULL DEFAULT 'provider'
                 CHECK (source IN ('provider', 'configured')),
    -- When this row was last confirmed present at the source. A refresh that returns the same
    -- ranges bumps this rather than rewriting the row, so `created_at` stays "first seen".
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The conflict target of the refresh upsert. Without it, a daily refresh would append a
    -- full copy of the provider's list every day and the guard would scan an ever-growing
    -- table of duplicates.
    CONSTRAINT uq_webhook_provider_ip_range_provider_cidr UNIQUE (provider, cidr)
);

COMMENT ON TABLE apiome.webhook_provider_ip_range IS
    'Cached provider-published webhook source ranges (REPO-7.6, #2804), refreshed daily. Shared across replicas so every process filters on the same list and a stale cache is visible rather than per-process.';
COMMENT ON COLUMN apiome.webhook_provider_ip_range.cidr IS
    'Normalised CIDR text. Matching happens in Python (ipaddress), so the value is stored exactly as the application canonicalised it rather than as Postgres would normalise the cidr type.';
COMMENT ON COLUMN apiome.webhook_provider_ip_range.family IS
    'IP version (4 or 6), denormalised so the guard reads only the family of the address in hand.';
COMMENT ON COLUMN apiome.webhook_provider_ip_range.source IS
    'provider = fetched from the provider''s published endpoint; configured = supplied by the deployment for a provider that publishes no machine-readable list.';
COMMENT ON COLUMN apiome.webhook_provider_ip_range.refreshed_at IS
    'Last time this range was confirmed present at the source. created_at stays "first seen"; a range that disappears upstream is deleted by the refresh, not left to age out.';

-- The guard's read: every range for one provider and one address family, on every delivery
-- that is not already served from the process cache.
CREATE INDEX IF NOT EXISTS idx_webhook_provider_ip_range_lookup
    ON apiome.webhook_provider_ip_range (provider, family);

COMMENT ON INDEX apiome.idx_webhook_provider_ip_range_lookup IS
    'Serves the REPO-7.6 ingestion guard: the ranges for one provider and one address family.';

CREATE TABLE IF NOT EXISTS apiome.webhook_provider_ip_refresh (
    provider        VARCHAR(32) PRIMARY KEY
                    CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
    -- Every attempt bumps this, successful or not.
    last_attempt_at TIMESTAMPTZ,
    -- Only a success bumps this. The gap between the two columns *is* the staleness signal:
    -- an attempt timestamp that keeps advancing while the success timestamp does not is a
    -- provider endpoint that has been failing, which a single `refreshed_at` would hide.
    last_success_at TIMESTAMPTZ,
    last_outcome    VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (last_outcome IN ('pending', 'success', 'failure', 'skipped')),
    -- Truncated failure detail for the admin panel. Not an error class: the operator's
    -- question is "why is this stale", and an HTTP status with a sentence answers it.
    last_error      TEXT,
    -- How many ranges the last successful refresh stored. Zero after a success is itself
    -- meaningful — the provider answered with an empty list — and is treated as a failed
    -- refresh by the writer rather than silently emptying the cache.
    range_count     INTEGER NOT NULL DEFAULT 0 CHECK (range_count >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE apiome.webhook_provider_ip_refresh IS
    'Per-provider refresh state for the cached webhook IP ranges (REPO-7.6, #2804). last_attempt_at and last_success_at are separate so "stale because the fetch is failing" is distinguishable from "fresh".';
COMMENT ON COLUMN apiome.webhook_provider_ip_refresh.last_success_at IS
    'Last refresh that actually stored ranges. The daily scheduler reads this column, not last_attempt_at, so a failing provider is retried on the next tick rather than once a day.';

-- ---------------------------------------------------------------------------------------
-- Per-tenant additional allowlist (the tenant-managed half)
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS apiome.tenant_webhook_ip_allowlist (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    cidr        VARCHAR(64) NOT NULL,
    family      SMALLINT NOT NULL CHECK (family IN (4, 6)),
    -- Why this entry exists. Required in the API (not in the schema, so an older row can
    -- never block a migration): an allowlist nobody can explain is an allowlist nobody dares
    -- prune, and it grows forever.
    description VARCHAR(255),
    -- Soft off-switch. An operator narrowing the filter during an incident wants the entry
    -- back afterwards with its description intact; deleting and re-typing loses both.
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    -- The tenant administrator who added it. ON DELETE SET NULL: the entry outlives the
    -- account, and losing the attribution is better than losing the filter.
    created_by  UUID REFERENCES apiome.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- One entry per CIDR per tenant. A duplicate would be two rows the operator has to
    -- disable in lockstep to actually close the hole.
    CONSTRAINT uq_tenant_webhook_ip_allowlist_tenant_cidr UNIQUE (tenant_id, cidr)
);

COMMENT ON TABLE apiome.tenant_webhook_ip_allowlist IS
    'Per-tenant additional source ranges for webhook ingestion (REPO-7.6, #2804) — self-hosted runners, egress gateways, relays. Additive to the provider ranges; managed by tenant administrators.';
COMMENT ON COLUMN apiome.tenant_webhook_ip_allowlist.enabled IS
    'Soft off-switch, so narrowing the filter during an incident does not destroy the entry and its description.';

-- The guard's read for a tenant that owns the repository a delivery names: its enabled
-- entries in the address family in hand.
CREATE INDEX IF NOT EXISTS idx_tenant_webhook_ip_allowlist_enabled
    ON apiome.tenant_webhook_ip_allowlist (tenant_id, family)
    WHERE enabled = TRUE;

COMMENT ON INDEX apiome.idx_tenant_webhook_ip_allowlist_enabled IS
    'Serves the REPO-7.6 guard''s per-tenant read. Partial on enabled = TRUE because a disabled entry is never consulted on the delivery path.';

CREATE TABLE IF NOT EXISTS apiome.tenant_webhook_ip_policy (
    tenant_id           UUID PRIMARY KEY REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    -- FALSE is the bypass: this tenant's repositories accept deliveries from any address,
    -- as they did before this feature. A row is only written when a tenant administrator
    -- changes something, so "no row" means "enforced with the deployment default" and the
    -- table stays proportional to the number of tenants that have opted out, not to the
    -- number of tenants.
    enforcement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Why enforcement was turned off. The ticket makes bypass an administrator action; a
    -- bypass with no stated reason is the audit finding this table exists to avoid.
    bypass_reason       VARCHAR(255),
    updated_by          UUID REFERENCES apiome.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE apiome.tenant_webhook_ip_policy IS
    'Per-tenant enforcement switch for the webhook source-IP allowlist (REPO-7.6, #2804). Absent row = enforced with the deployment default; enforcement_enabled = FALSE is the tenant-admin-only bypass.';
COMMENT ON COLUMN apiome.tenant_webhook_ip_policy.enforcement_enabled IS
    'FALSE bypasses the allowlist for this tenant''s repositories. Writable only by a tenant administrator (enforced in the API layer), and every change is written to workflow_audit.';
