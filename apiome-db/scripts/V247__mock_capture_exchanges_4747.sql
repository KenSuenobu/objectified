-- Guarded proxy capture — PMR-2.4 (#4747).
--
-- Problem: the fastest way to get realistic mock fixtures is to record real traffic, and the
-- fastest way to get a breach is to do that without rules. Two risks, both real:
--
--   * SSRF — "record whatever upstream I name" turns the hosted mock into a confused deputy that
--     will fetch a cloud metadata endpoint or an internal service on a caller's behalf; and
--   * secret and personal-data retention — a captured exchange carries bearer tokens, cookies,
--     API keys in query strings, and whatever customer data the response happened to contain.
--
-- The policy half of the answer lives in ``versions.mock_settings`` under ``proxyCapture``
-- (``app.mock_capture``): who authorized capture, until when, which upstreams are allowlisted, and
-- what to redact. It needs no schema of its own — it is configuration on a version, like scenarios
-- and chaos, and it deliberately never travels inside a portable bundle.
--
-- The *recorded traffic* does need a schema, and this migration adds exactly one table for it:
--
--   mock_capture_exchange — one recorded, already-redacted request/response pair, awaiting review.
--
-- Four invariants shape it, each an acceptance criterion turned into a rule the database keeps
-- rather than a habit the application is trusted to remember:
--
--   1. **Nothing is published implicitly.** ``review_state`` starts at ``pending``. An owner moves
--      it to ``approved`` or ``rejected``; only publishing an approved capture into a fixture pack
--      marks it ``published``, stamping ``published_pack``. There is no state a capture can reach
--      that serves traffic without a person having said so — the "review before publish" boundary.
--
--   2. **Only redacted content is storable.** ``exchange`` holds the ``apiome.mock.capture/v1``
--      document *after* redaction, and ``redactions`` holds the decision list that says what was
--      removed and why. ``redaction_count`` is CHECKed non-negative and stored so a reviewer can
--      sort by "most redacted" without opening every document. The runtime additionally re-scans
--      each finished record and refuses to insert one that still looks credential-bearing; the
--      column comments below record that contract so nobody relaxes it by accident.
--
--   3. **Provenance survives.** ``upstream``, ``allowlist_entry``, ``policy_digest``, ``captured_by``
--      and ``captured_at`` are columns, not merely fields inside the JSON document, so "which system
--      said this, under whose grant, under which policy" is queryable and indexable. ``policy_digest``
--      in particular distinguishes captures taken under one authorization from captures taken after
--      the redaction rules changed.
--
--   4. **Captures expire.** ``expires_at`` is NOT NULL and a retention sweep removes anything past
--      it. Unreviewed recorded traffic is the one thing here that should never accumulate quietly;
--      a capture that nobody has looked at within its window is deleted rather than kept.
--
-- Rollback notes:
--   DROP FUNCTION IF EXISTS apiome.purge_mock_capture_exchanges();
--   DROP TABLE IF EXISTS apiome.mock_capture_exchange;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- mock_capture_exchange — one redacted recorded exchange awaiting review.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_capture_exchange (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Scope. A capture is never visible outside the tenant that recorded it, and it belongs to the
    -- exact version whose mock recorded it: a capture taken against 1.0.0 is not evidence about
    -- 2.0.0, and deleting the version takes its captures with it.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,

    -- Provenance (acceptance: "redaction decisions and source provenance are retained").
    -- ``upstream`` is stored with its query string already dropped — an upstream query routinely
    -- carries a token, and this column is read in review UIs and support tickets.
    upstream TEXT NOT NULL,
    allowlist_entry TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    captured_by UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    -- What was recorded, in queryable form. The full document lives in ``exchange``; these are the
    -- facts a reviewer filters and sorts by, so a list read needs no JSON traversal.
    operation_key TEXT,
    request_method VARCHAR(16) NOT NULL,
    request_path TEXT NOT NULL,
    status_code INTEGER NOT NULL
        CONSTRAINT mock_capture_exchange_status_check
            CHECK (status_code >= 100 AND status_code < 600),

    -- The redacted ``apiome.mock.capture/v1`` document, and its content digest. The digest is the
    -- capture's stable identity: two recordings of the same exchange under the same policy digest
    -- identically, which is what lets a reviewer spot duplicates.
    exchange JSONB NOT NULL,
    exchange_digest TEXT NOT NULL,

    -- The redaction decision list: one entry per removal, each with an RFC 6901 pointer, the rule
    -- that fired, and a human-readable reason. This is the audit trail; it is never empty for a
    -- capture whose ``redaction_count`` is non-zero.
    redactions JSONB NOT NULL DEFAULT '[]'::jsonb,
    redaction_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT mock_capture_exchange_redaction_count_check CHECK (redaction_count >= 0),

    -- Whether the captured response matched the version's declared contract. A capture that does
    -- not validate is still recorded — that a real upstream disagrees with the spec is exactly the
    -- kind of thing a reviewer wants to see — but it is flagged rather than silently published.
    schema_valid BOOLEAN,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Review lifecycle. Nothing serves traffic from ``pending``.
    review_state TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT mock_capture_exchange_review_state_check
            CHECK (review_state IN ('pending', 'approved', 'rejected', 'published')),
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_note TEXT,
    published_pack VARCHAR(64),

    -- Retention. Unreviewed recorded traffic must not accumulate.
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- A published capture must say which pack it went into; nothing else may claim one.
    CONSTRAINT mock_capture_exchange_published_pack_check
        CHECK (
            (review_state = 'published' AND published_pack IS NOT NULL)
            OR (review_state <> 'published' AND published_pack IS NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_mock_capture_exchange_version
    ON mock_capture_exchange (version_id, review_state, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_mock_capture_exchange_tenant
    ON mock_capture_exchange (tenant_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_mock_capture_exchange_expires
    ON mock_capture_exchange (expires_at);

COMMENT ON TABLE mock_capture_exchange IS
  'Redacted proxy-captured request/response pairs awaiting owner review (#4747, PMR-2.4)';
COMMENT ON COLUMN mock_capture_exchange.upstream IS
  'Fetched upstream URL with its query string removed (a query routinely carries a token)';
COMMENT ON COLUMN mock_capture_exchange.allowlist_entry IS
  'The capture policy allowlist entry that authorized the fetch';
COMMENT ON COLUMN mock_capture_exchange.policy_digest IS
  'sha256 digest of the capture policy in force when this exchange was recorded';
COMMENT ON COLUMN mock_capture_exchange.exchange IS
  'apiome.mock.capture/v1 document, ALREADY REDACTED. The runtime re-scans every record for '
  'credential-shaped content and refuses to insert one that still carries any; raw credentials '
  'are never written to this column.';
COMMENT ON COLUMN mock_capture_exchange.redactions IS
  'One entry per removal: {pointer, rule, reason}. The retained record of every redaction decision.';
COMMENT ON COLUMN mock_capture_exchange.review_state IS
  'pending on arrival; an owner approves or rejects; publishing into a fixture pack marks published';
COMMENT ON COLUMN mock_capture_exchange.expires_at IS
  'Retention horizon; apiome.purge_mock_capture_exchanges() deletes rows past this instant';

-- ---------------------------------------------------------------------------------------------------
-- Retention sweep. Captures are recorded traffic: the default is that they go away.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apiome.purge_mock_capture_exchanges()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    removed INTEGER;
BEGIN
    DELETE FROM apiome.mock_capture_exchange
    WHERE expires_at <= CURRENT_TIMESTAMP;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

COMMENT ON FUNCTION apiome.purge_mock_capture_exchanges() IS
  'Delete expired mock capture exchanges; returns the number removed (#4747, PMR-2.4)';
