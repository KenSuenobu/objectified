-- Custom domain ownership verification and TLS certificate lifecycle — Slate 10.1
-- (private-suite#119).
--
-- Problem: V186 (APX-3.1) created `apiome.slate_domains` as an *inventory*. It records what a
-- lane's hosts are and reports a TLS status, but it records nothing about how either value was
-- arrived at: when the ownership challenge was last checked, what the check actually observed
-- when it failed, when the certificate was issued, or whether renewal is even enabled for the
-- host. A screen built on V186 alone can say "verification failed" but not why, and can say
-- "certificate active" without being able to say when anybody last looked.
--
-- Solution: this migration adds the lifecycle columns behind those two words. Nothing is
-- renamed and no existing column changes meaning, so V186 readers keep working:
--
--   verification_method / verification_checked_at / verification_error / verified_at
--     — the ownership challenge. `verification_method` is the record kind the tenant is asked to
--       publish; `verification_error` holds what the resolver actually saw ("resolves to
--       ghs.googlehosted.com"), which is the difference between a checklist a tenant can act on
--       and a red dot they can only re-click.
--
--   certificate_issued_at / certificate_serial / certificate_checked_at / tls_protocol /
--   tls_error / auto_renew
--     — the certificate. `certificate_expires_at` already existed; on its own it cannot
--       distinguish "expires in 87 days because we issued it this morning" from "expires in 87
--       days according to a probe nobody has re-run since". `certificate_checked_at` is what
--       makes the reported state falsifiable, and `tls_protocol` records the protocol actually
--       negotiated with the host rather than the protocol the edge is configured to prefer.
--
-- `tls_status` gains a fourth value, `pending`. V186's domain rows default to `provisioning`,
-- which asserts that issuance is underway — but a host whose CNAME has never resolved has no
-- order in flight and nothing is provisioning it. Reporting `provisioning` for an unverified
-- host is a spinner that never resolves, so unverified hosts now start at `pending` and only
-- move to `provisioning` once ownership is verified and the edge can legitimately be asked for
-- a certificate. Widening a CHECK is backward compatible: every existing row stays legal.
--
-- Who writes these columns. Certificates are obtained and renewed by the edge (`deploy/Caddyfile`
-- — Caddy's on-demand TLS, ACME/Let's Encrypt, automatic renewal), not by this service. The REST
-- control plane decides *whether a host is allowed to have a certificate* (the on-demand `ask`
-- endpoint answers from `verification_status`) and *reports what the live host is actually
-- serving* (a TLS probe fills `certificate_*` / `tls_*` from the peer certificate). So these
-- columns are observations and authorizations, never a private copy of the CA's state.
--
-- No new table: a domain has exactly one ownership challenge and one live certificate at a time,
-- so a second table would be a one-to-one join for no gain. Certificate *history* would be a
-- table, and is not in this ticket's scope.
--
-- Rollback notes (safe in any order; all additive):
--   ALTER TABLE apiome.slate_domains
--     DROP COLUMN IF EXISTS verification_method,
--     DROP COLUMN IF EXISTS verification_checked_at,
--     DROP COLUMN IF EXISTS verification_error,
--     DROP COLUMN IF EXISTS verified_at,
--     DROP COLUMN IF EXISTS certificate_issued_at,
--     DROP COLUMN IF EXISTS certificate_serial,
--     DROP COLUMN IF EXISTS certificate_checked_at,
--     DROP COLUMN IF EXISTS tls_protocol,
--     DROP COLUMN IF EXISTS tls_error,
--     DROP COLUMN IF EXISTS auto_renew,
--     DROP COLUMN IF EXISTS updated_at;
--   DROP INDEX IF EXISTS apiome.idx_slate_domains_renewal;
--   DROP INDEX IF EXISTS apiome.idx_slate_domains_verified_host;
--   (then restore the original tls_status CHECK without 'pending')

SET search_path TO apiome, public;

-- ─── 1. Ownership verification lifecycle ─────────────────────────────────────

ALTER TABLE apiome.slate_domains
    ADD COLUMN IF NOT EXISTS verification_method    TEXT NOT NULL DEFAULT 'cname',
    ADD COLUMN IF NOT EXISTS verification_checked_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS verification_error     TEXT,
    ADD COLUMN IF NOT EXISTS verified_at            TIMESTAMP WITH TIME ZONE;

-- The record kind the tenant publishes. A subdomain is delegated with CNAME; an apex cannot
-- carry a CNAME alongside its SOA/NS records, so an apex is verified with a TXT record and
-- pointed with the provider's ALIAS/ANAME (or A) record instead. Both are named here so a
-- reader of the row knows which instruction was given.
ALTER TABLE apiome.slate_domains
    DROP CONSTRAINT IF EXISTS slate_domains_verification_method_check;
ALTER TABLE apiome.slate_domains
    ADD CONSTRAINT slate_domains_verification_method_check
    CHECK (verification_method IN ('cname', 'txt'));

-- Backfill before the constraint below can be validated: a row V186 already marked verified is
-- genuinely verified, and the earliest defensible timestamp for it is when it was attached.
UPDATE apiome.slate_domains
   SET verified_at = created_at
 WHERE verification_status = 'verified'
   AND verified_at IS NULL;

-- A verified domain must record when it was verified, and an unverified one must not claim to
-- have been: the two are asserted together so no code path can set one without the other.
ALTER TABLE apiome.slate_domains
    DROP CONSTRAINT IF EXISTS slate_domains_verified_at_check;
ALTER TABLE apiome.slate_domains
    ADD CONSTRAINT slate_domains_verified_at_check
    CHECK (
        (verification_status = 'verified' AND verified_at IS NOT NULL)
        OR (verification_status <> 'verified' AND verified_at IS NULL)
    );

COMMENT ON COLUMN apiome.slate_domains.verification_method IS
    'Record kind the tenant publishes to prove ownership: cname (subdomain) or txt (apex, which cannot carry a CNAME). Slate 10.1.';
COMMENT ON COLUMN apiome.slate_domains.verification_checked_at IS
    'When the ownership check last ran. NULL means never checked, which is a different state from checked-and-failed.';
COMMENT ON COLUMN apiome.slate_domains.verification_error IS
    'What the resolver actually observed on the last failed check (e.g. the record it found instead). NULL when the last check succeeded or none has run.';
COMMENT ON COLUMN apiome.slate_domains.verified_at IS
    'When ownership was proven. Constrained to be non-NULL exactly when verification_status = verified.';

-- ─── 2. Certificate lifecycle ────────────────────────────────────────────────

ALTER TABLE apiome.slate_domains
    ADD COLUMN IF NOT EXISTS certificate_issued_at  TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS certificate_serial     TEXT,
    ADD COLUMN IF NOT EXISTS certificate_checked_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS tls_protocol           TEXT,
    ADD COLUMN IF NOT EXISTS tls_error              TEXT,
    ADD COLUMN IF NOT EXISTS auto_renew             BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMP WITH TIME ZONE NOT NULL
                                                    DEFAULT CURRENT_TIMESTAMP;

-- `pending` joins the domain: a host whose ownership has never been proven has no certificate
-- order in flight, so calling it `provisioning` would render a spinner that can never resolve.
ALTER TABLE apiome.slate_domains
    DROP CONSTRAINT IF EXISTS slate_domains_tls_status_check;
ALTER TABLE apiome.slate_domains
    ADD CONSTRAINT slate_domains_tls_status_check
    CHECK (tls_status IN ('pending', 'provisioning', 'active', 'error'));

ALTER TABLE apiome.slate_domains
    ALTER COLUMN tls_status SET DEFAULT 'pending';

-- Backfill for the constraint below: a pre-existing row claiming `active` with no expiry cannot
-- be renewed against anything, so it is demoted to `provisioning` rather than deleted — the next
-- probe will either observe a real certificate and promote it, or record why it could not.
UPDATE apiome.slate_domains
   SET tls_status = 'provisioning'
 WHERE tls_status = 'active'
   AND certificate_expires_at IS NULL;

-- An active certificate must have an expiry to renew against. Reporting `active` with no
-- known expiry is how a certificate lapses without anyone being warned.
ALTER TABLE apiome.slate_domains
    DROP CONSTRAINT IF EXISTS slate_domains_active_tls_expiry_check;
ALTER TABLE apiome.slate_domains
    ADD CONSTRAINT slate_domains_active_tls_expiry_check
    CHECK (tls_status <> 'active' OR certificate_expires_at IS NOT NULL);

COMMENT ON COLUMN apiome.slate_domains.certificate_issued_at IS
    'notBefore of the certificate the host is currently serving, as observed by the TLS probe. Slate 10.1.';
COMMENT ON COLUMN apiome.slate_domains.certificate_serial IS
    'Serial of the observed certificate. Changes on every renewal, so it is how a renewal is detected rather than assumed.';
COMMENT ON COLUMN apiome.slate_domains.certificate_checked_at IS
    'When the TLS probe last completed a handshake with the host. Without it, certificate_expires_at is an unfalsifiable claim.';
COMMENT ON COLUMN apiome.slate_domains.tls_protocol IS
    'Protocol actually negotiated with the host (e.g. TLSv1.3) — what is served, not what the edge prefers.';
COMMENT ON COLUMN apiome.slate_domains.tls_error IS
    'Why the last TLS probe failed. NULL when the last probe succeeded or none has run.';
COMMENT ON COLUMN apiome.slate_domains.auto_renew IS
    'Whether the edge is permitted to renew this host automatically. FALSE parks a domain without detaching it.';
COMMENT ON COLUMN apiome.slate_domains.updated_at IS
    'Last write to the row, so a stale lifecycle state is visible as stale.';
COMMENT ON COLUMN apiome.slate_domains.tls_status IS
    'Certificate state: pending (ownership unproven, nothing requested), provisioning (verified, issuance underway), active, or error.';

-- ─── 3. Indexes ──────────────────────────────────────────────────────────────

-- The edge asks "may this host have a certificate?" on every unrecognized SNI, so the
-- authorization lookup must not scan. UNIQUE (host) from V186 already answers by host; this
-- partial index answers the same question without touching unverified rows.
CREATE INDEX IF NOT EXISTS idx_slate_domains_verified_host
    ON apiome.slate_domains (host)
    WHERE verification_status = 'verified';

-- The renewal sweep asks for expiring certificates on auto-renewing hosts, oldest first.
CREATE INDEX IF NOT EXISTS idx_slate_domains_renewal
    ON apiome.slate_domains (certificate_expires_at)
    WHERE auto_renew AND certificate_expires_at IS NOT NULL;
