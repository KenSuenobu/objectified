-- Verification evidence schema — ECA-1.3 (#4731).
--
-- Problem: a contract run currently ends as runner output — a log, a console scrollback, maybe a
-- JUnit file dropped in a CI artifact bucket. None of that can be queried, compared across runs, or
-- pointed at by a gate. "Did this version pass its contract against staging, when, and what
-- exactly failed" has no answer that survives the CI job's retention window.
--
-- Solution: four additive, **immutable**, tenant-scoped tables that normalize a run into records a
-- gate (ECA-3.1) can read and an auditor can trust:
--
--   * ``verification_run``            — one execution: the ECA-1.1 suite digest, the ECA-1.2 target
--                                       identity (snapshotted, not merely referenced), timing,
--                                       derived outcome, and case counts.
--   * ``verification_run_operation``  — one executed case: its operation, its outcome, and — when
--                                       it did not pass — the failure code and message that say
--                                       why. This is the "operation-level failure" record.
--   * ``verification_run_assertion``  — the individual checks inside a case (status code, response
--                                       schema, header, latency), each with expected vs actual.
--   * ``verification_run_artifact``   — **references** to redacted request/response/log artifacts.
--                                       A link and a content hash; never the bytes.
--
-- Four invariants shape the schema, each an acceptance criterion turned into a rule the database
-- enforces rather than a habit the application is trusted to keep:
--
--   1. **Evidence is immutable.** Every table carries a BEFORE UPDATE trigger that rejects any
--      in-place edit (the shared ``mcp_forbid_row_mutation()`` guard from V128). A run is written
--      once, complete, in one transaction. Nothing can quietly turn a red run green. DELETE stays
--      available to the FK cascades and to the retention sweep at the bottom of this file.
--
--   2. **Evidence is tenant-scoped.** ``tenant_id`` is on all four tables — not only on the run —
--      so every read is scoped by the same predicate and a child row can never be reached through
--      a mis-joined parent. A CHECK cannot express "child tenant = parent tenant" without a
--      subquery, so the composite foreign keys below do it: the child references the parent on
--      ``(id, tenant_id)``, which makes a cross-tenant child structurally impossible.
--
--   3. **A failure always says why.** ``verification_run_operation`` may not record a non-passing,
--      non-skipped outcome without a ``failure_code``; ``verification_run_assertion`` may not
--      record a failed assertion without one either. An outcome with no stated reason is exactly
--      the evidence that cannot drive a gate.
--
--   4. **Artifacts are linked, redacted, and verifiable.** ``uri`` may not be a ``data:`` URI (that
--      is embedding, not linking) and may not carry ``user:pass@`` credentials; ``redacted`` is
--      CHECKed to be TRUE, so the schema has no representation for an unredacted artifact; and
--      ``content_sha256`` lets a reader confirm the bytes they fetched are the bytes the evidence
--      names.
--
-- RBAC: adds the ``verification_evidence`` resource to the built-in role grids. Owner/Admin manage;
-- Editor may view **and create** (recording evidence is what a CI runner does, and a runner
-- authenticating with an API key resolves to the Editor grid); Viewer may view. Deleting evidence
-- is deliberately Owner/Admin-only — the only legitimate deletions are retention and erasure.
-- This follows the V175/V211 pattern: replace ``apiome.seed_builtin_roles`` wholesale and reseed
-- every tenant.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP FUNCTION IF EXISTS apiome.purge_verification_evidence(INTEGER);
--   DROP TABLE IF EXISTS apiome.verification_run_artifact;
--   DROP TABLE IF EXISTS apiome.verification_run_assertion;
--   DROP TABLE IF EXISTS apiome.verification_run_operation;
--   DROP TABLE IF EXISTS apiome.verification_run;
--   -- and re-apply the V211 body of apiome.seed_builtin_roles to drop the new resource.
-- (The V128 guard function apiome.mcp_forbid_row_mutation() is shared — do not drop it here.)

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- verification_run — one execution of a compiled suite against a target.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_run (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Scope. Evidence is never visible outside the tenant that produced it.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- What was run: the ECA-1.1 manifest digest. Two runs of the same digest executed the same
    -- cases, which is what makes runs comparable at all; a gate that requires "a passing run of
    -- digest X" resolves it from here.
    suite_digest TEXT NOT NULL,
    suite_schema_version INTEGER,
    suite_compiler_version INTEGER,
    suite_case_count INTEGER
        CONSTRAINT verification_run_suite_case_count_check
            CHECK (suite_case_count IS NULL OR suite_case_count >= 0),

    -- Where it ran. The target row may later be retired, renamed, or repointed, so the identity is
    -- *snapshotted* here as well as referenced: evidence must keep saying what it meant.
    target_id UUID REFERENCES verification_target(id) ON DELETE SET NULL,
    target_slug VARCHAR(128) NOT NULL,
    target_environment TEXT NOT NULL
        CONSTRAINT verification_run_target_environment_check
            CHECK (target_environment IN ('mock', 'development', 'test', 'staging', 'production')),
    target_network_class TEXT NOT NULL DEFAULT 'public'
        CONSTRAINT verification_run_target_network_class_check
            CHECK (target_network_class IN ('public', 'private')),
    target_base_url TEXT NOT NULL,

    -- Who executed it. A CI runner authenticating with an API key is distinguishable from a person,
    -- which is the same distinction the ECA-1.2 ledger draws.
    runner_name TEXT NOT NULL,
    runner_version TEXT,
    recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,
    actor_kind TEXT NOT NULL DEFAULT 'user'
        CONSTRAINT verification_run_actor_kind_check
            CHECK (actor_kind IN ('user', 'api_key', 'system')),

    -- Timing. Both ends are recorded rather than one plus a duration, so "was this evidence
    -- produced before or after the deploy" is answerable, and the duration is stored derived so a
    -- reader never has to recompute it.
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    finished_at TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_ms BIGINT NOT NULL
        CONSTRAINT verification_run_duration_check CHECK (duration_ms >= 0),

    -- The verdict, derived from the operation rows rather than asserted by the runner
    -- (``cancelled`` is the one outcome only the runner can know).
    outcome TEXT NOT NULL
        CONSTRAINT verification_run_outcome_check
            CHECK (outcome IN ('passed', 'failed', 'errored', 'cancelled')),

    -- Case counts, derived the same way. Stored so a list read needs no join.
    total_cases INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_total_cases_check CHECK (total_cases >= 0),
    passed_cases INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_passed_cases_check CHECK (passed_cases >= 0),
    failed_cases INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_failed_cases_check CHECK (failed_cases >= 0),
    errored_cases INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_errored_cases_check CHECK (errored_cases >= 0),
    skipped_cases INTEGER NOT NULL DEFAULT 0
        CONSTRAINT verification_run_skipped_cases_check CHECK (skipped_cases >= 0),

    -- Provenance of the compiled suite (artifact kind/reference/revision/version label), exactly as
    -- the ECA-1.1 manifest reports it. Context, not identity: the digest is the identity.
    source JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Non-secret CI context: commit sha, branch, workflow URL. Free-form because every CI system
    -- names these differently; never credential material.
    context JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Retry safety. A runner that uploads evidence and loses the response must be able to retry
    -- without minting a second run; the store returns the existing row for a repeated key.
    idempotency_key TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- ``sha256:<64 hex>`` — the ECA-1.1 digest form. A run that names anything else is not
    -- referring to a suite this platform compiled.
    CONSTRAINT verification_run_suite_digest_shape_check
        CHECK (suite_digest ~ '^sha256:[0-9a-f]{64}$'),

    -- A run cannot finish before it starts.
    CONSTRAINT verification_run_window_check CHECK (finished_at >= started_at),

    -- Counts must add up to the total. The store derives them from the operation rows, and this
    -- keeps a hand-written INSERT from storing a total that its parts contradict.
    CONSTRAINT verification_run_counts_sum_check
        CHECK (passed_cases + failed_cases + errored_cases + skipped_cases = total_cases),

    -- The verdict must agree with the counts: a run with a failed case is not ``passed``. A
    -- ``cancelled`` run is exempt — it stopped early, so its counts describe only what it reached.
    CONSTRAINT verification_run_outcome_agrees_check
        CHECK (
            outcome = 'cancelled'
            OR (outcome = 'errored' AND errored_cases > 0)
            OR (outcome = 'failed' AND errored_cases = 0 AND failed_cases > 0)
            OR (outcome = 'passed' AND errored_cases = 0 AND failed_cases = 0)
        ),

    CONSTRAINT verification_run_source_object_check CHECK (jsonb_typeof(source) = 'object'),
    CONSTRAINT verification_run_context_object_check CHECK (jsonb_typeof(context) = 'object'),

    -- Referenced by the composite foreign keys below, which is how a child row is pinned to its
    -- parent's tenant.
    CONSTRAINT verification_run_id_tenant_key UNIQUE (id, tenant_id)
);

COMMENT ON TABLE verification_run IS
    'Immutable, tenant-scoped record of one contract-suite execution: suite digest, target identity, timing, outcome, and counts (ECA-1.3, #4731)';
COMMENT ON COLUMN verification_run.tenant_id IS 'Tenant that owns the evidence; never readable outside it';
COMMENT ON COLUMN verification_run.suite_digest IS 'ECA-1.1 manifest digest (sha256:<hex>) — what was executed, and what makes two runs comparable';
COMMENT ON COLUMN verification_run.suite_schema_version IS 'Manifest envelope version the suite was compiled with';
COMMENT ON COLUMN verification_run.suite_compiler_version IS 'Compiler rules version the suite was compiled with';
COMMENT ON COLUMN verification_run.suite_case_count IS 'How many cases the manifest declared; a run that executed fewer is visibly partial';
COMMENT ON COLUMN verification_run.target_id IS 'Verification target used; NULL only if the target row was later purged';
COMMENT ON COLUMN verification_run.target_slug IS 'Target handle at run time (snapshot, so a rename cannot rewrite history)';
COMMENT ON COLUMN verification_run.target_environment IS 'Environment class at run time; makes "was this production" answerable from the evidence';
COMMENT ON COLUMN verification_run.target_network_class IS 'public | private, as it was at run time';
COMMENT ON COLUMN verification_run.target_base_url IS 'Base URL at run time (credential-free by ECA-1.2 construction)';
COMMENT ON COLUMN verification_run.runner_name IS 'Which runner produced the evidence (e.g. apiome-contract-runner)';
COMMENT ON COLUMN verification_run.runner_version IS 'Runner version, so a behaviour change is attributable';
COMMENT ON COLUMN verification_run.recorded_by IS 'User who recorded the evidence; NULL for an unattributable API-key call';
COMMENT ON COLUMN verification_run.actor_label IS 'Email or name of the recording actor at the time';
COMMENT ON COLUMN verification_run.actor_kind IS 'user | api_key (a CI runner) | system';
COMMENT ON COLUMN verification_run.started_at IS 'When the run began (runner clock)';
COMMENT ON COLUMN verification_run.finished_at IS 'When the run ended (runner clock)';
COMMENT ON COLUMN verification_run.duration_ms IS 'Wall-clock duration in milliseconds, stored derived';
COMMENT ON COLUMN verification_run.outcome IS 'passed | failed | errored | cancelled; derived from the operation rows except for cancelled';
COMMENT ON COLUMN verification_run.total_cases IS 'Executed cases recorded on this run';
COMMENT ON COLUMN verification_run.passed_cases IS 'Cases whose every assertion held';
COMMENT ON COLUMN verification_run.failed_cases IS 'Cases where the implementation contradicted the contract';
COMMENT ON COLUMN verification_run.errored_cases IS 'Cases the runner could not execute (transport, timeout)';
COMMENT ON COLUMN verification_run.skipped_cases IS 'Cases deliberately not executed (policy, filter)';
COMMENT ON COLUMN verification_run.source IS 'Provenance of the compiled suite: artifact kind, reference, revision id, version label';
COMMENT ON COLUMN verification_run.context IS 'Non-secret CI context (commit, branch, workflow URL); never credential material';
COMMENT ON COLUMN verification_run.idempotency_key IS 'Caller-supplied retry key, unique per tenant; a repeated upload returns the existing run';
COMMENT ON COLUMN verification_run.created_at IS 'When the evidence was recorded (server clock, insert-only)';

-- The list read: a tenant's runs, newest first.
CREATE INDEX IF NOT EXISTS idx_verification_run_tenant
    ON verification_run (tenant_id, created_at DESC);
-- "Is there recent passing evidence for this suite?" — the ECA-3.1 gate lookup.
CREATE INDEX IF NOT EXISTS idx_verification_run_tenant_digest
    ON verification_run (tenant_id, suite_digest, created_at DESC);
-- One target's history.
CREATE INDEX IF NOT EXISTS idx_verification_run_target
    ON verification_run (target_id, created_at DESC);
-- Retry safety: one run per (tenant, key). Partial, because most runs supply no key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_run_tenant_idempotency
    ON verification_run (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- verification_run_operation — one executed case, and why it did not pass.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_run_operation (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,

    -- Deterministic ordering. Exports must reproduce the stored result *in the stored order*, and
    -- ``created_at`` cannot promise that for rows written in the same transaction.
    sequence INTEGER NOT NULL
        CONSTRAINT verification_run_operation_sequence_check CHECK (sequence >= 0),

    -- What was executed, named exactly as the ECA-1.1 manifest names it, so a case in the evidence
    -- can be found in the suite it came from.
    case_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    operation_name TEXT,
    case_source TEXT,
    http_method TEXT NOT NULL,
    http_path TEXT NOT NULL,

    outcome TEXT NOT NULL
        CONSTRAINT verification_run_operation_outcome_check
            CHECK (outcome IN ('passed', 'failed', 'errored', 'skipped')),
    -- Stable machine code (status-mismatch, response-schema-invalid, transport-error, …). Required
    -- for anything that did not pass: an outcome with no stated reason cannot drive a gate.
    failure_code TEXT,
    failure_message TEXT,

    expected_status TEXT,
    actual_status INTEGER
        CONSTRAINT verification_run_operation_actual_status_check
            CHECK (actual_status IS NULL OR (actual_status >= 100 AND actual_status <= 599)),

    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    duration_ms BIGINT NOT NULL DEFAULT 0
        CONSTRAINT verification_run_operation_duration_check CHECK (duration_ms >= 0),
    -- Transport attempts. A contract failure is never retried (ECA-1.2 policy), so >1 here always
    -- means the transport was retried, never that a red result was re-rolled until it went green.
    attempts INTEGER NOT NULL DEFAULT 1
        CONSTRAINT verification_run_operation_attempts_check CHECK (attempts >= 1),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT verification_run_operation_window_check
        CHECK (started_at IS NULL OR finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT verification_run_operation_failure_reason_check
        CHECK (
            outcome IN ('passed', 'skipped')
            OR (failure_code IS NOT NULL AND length(btrim(failure_code)) > 0)
        ),
    -- A passing case has nothing to explain; a stray code on one would make the evidence lie.
    CONSTRAINT verification_run_operation_passed_is_clean_check
        CHECK (outcome <> 'passed' OR failure_code IS NULL),

    CONSTRAINT verification_run_operation_sequence_key UNIQUE (run_id, sequence),
    CONSTRAINT verification_run_operation_id_tenant_key UNIQUE (id, tenant_id),

    -- Composite FK: the child's tenant must be the parent's tenant. This is the structural form of
    -- "evidence is tenant-scoped" — no application code can produce a cross-tenant child.
    CONSTRAINT verification_run_operation_run_fk
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES verification_run (id, tenant_id) ON DELETE CASCADE
);

COMMENT ON TABLE verification_run_operation IS
    'Immutable per-case result within a run: what was executed, its outcome, and the failure code that explains a non-pass (ECA-1.3, #4731)';
COMMENT ON COLUMN verification_run_operation.run_id IS 'Owning run; the composite FK pins the row to the run''s tenant';
COMMENT ON COLUMN verification_run_operation.sequence IS 'Stored order within the run, so an export reproduces the result in the recorded order';
COMMENT ON COLUMN verification_run_operation.case_id IS 'ECA-1.1 case id, so an evidence row can be traced back to the compiled case';
COMMENT ON COLUMN verification_run_operation.operation_key IS 'Canonical operation key (GET /pets/{petId})';
COMMENT ON COLUMN verification_run_operation.operation_name IS 'Source operation name, when the suite carried one';
COMMENT ON COLUMN verification_run_operation.case_source IS 'Where the case came from: declared example, generated body, negative case';
COMMENT ON COLUMN verification_run_operation.http_method IS 'HTTP verb executed, upper-cased';
COMMENT ON COLUMN verification_run_operation.http_path IS 'Request path executed (relative to the target base URL)';
COMMENT ON COLUMN verification_run_operation.outcome IS 'passed | failed (contract contradicted) | errored (could not execute) | skipped';
COMMENT ON COLUMN verification_run_operation.failure_code IS 'Stable machine code for a non-pass; required by CHECK for failed/errored';
COMMENT ON COLUMN verification_run_operation.failure_message IS 'Redacted human explanation of the failure';
COMMENT ON COLUMN verification_run_operation.expected_status IS 'Status the contract declared (may be a range such as 2XX)';
COMMENT ON COLUMN verification_run_operation.actual_status IS 'Status the implementation returned; NULL when nothing was received';
COMMENT ON COLUMN verification_run_operation.started_at IS 'When the case started (runner clock)';
COMMENT ON COLUMN verification_run_operation.finished_at IS 'When the case finished (runner clock)';
COMMENT ON COLUMN verification_run_operation.duration_ms IS 'Case duration in milliseconds';
COMMENT ON COLUMN verification_run_operation.attempts IS 'Transport attempts; a contract failure is never retried, so >1 means transport only';
COMMENT ON COLUMN verification_run_operation.created_at IS 'When the row was written (insert-only)';

CREATE INDEX IF NOT EXISTS idx_verification_run_operation_run
    ON verification_run_operation (run_id, sequence);
-- "Which operations are failing, across runs" — the comparison read.
CREATE INDEX IF NOT EXISTS idx_verification_run_operation_failures
    ON verification_run_operation (tenant_id, operation_key, created_at DESC)
    WHERE outcome <> 'passed';

-- ---------------------------------------------------------------------------------------------------
-- verification_run_assertion — the individual checks inside one case.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_run_assertion (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    operation_id UUID NOT NULL,

    sequence INTEGER NOT NULL
        CONSTRAINT verification_run_assertion_sequence_check CHECK (sequence >= 0),

    kind TEXT NOT NULL
        CONSTRAINT verification_run_assertion_kind_check
            CHECK (kind IN (
                'status_code', 'response_schema', 'header', 'content_type', 'latency', 'custom'
            )),
    outcome TEXT NOT NULL
        CONSTRAINT verification_run_assertion_outcome_check
            CHECK (outcome IN ('passed', 'failed', 'skipped')),

    -- What was asserted on: a JSON Pointer into the response body, a header name, or a bare label.
    subject TEXT,
    -- Redacted, bounded renderings — enough to read the failure without re-fetching an artifact.
    expected TEXT,
    actual TEXT,
    code TEXT,
    message TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT verification_run_assertion_failure_reason_check
        CHECK (outcome <> 'failed' OR (code IS NOT NULL AND length(btrim(code)) > 0)),

    CONSTRAINT verification_run_assertion_sequence_key UNIQUE (operation_id, sequence),

    CONSTRAINT verification_run_assertion_run_fk
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES verification_run (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT verification_run_assertion_operation_fk
        FOREIGN KEY (operation_id, tenant_id)
        REFERENCES verification_run_operation (id, tenant_id) ON DELETE CASCADE
);

COMMENT ON TABLE verification_run_assertion IS
    'Immutable per-assertion detail within a case: what was checked, expected vs actual, and the code for a failure (ECA-1.3, #4731)';
COMMENT ON COLUMN verification_run_assertion.run_id IS 'Owning run, denormalized so a run''s assertions read without a join';
COMMENT ON COLUMN verification_run_assertion.operation_id IS 'Owning case; the composite FK pins the row to the case''s tenant';
COMMENT ON COLUMN verification_run_assertion.sequence IS 'Stored order within the case';
COMMENT ON COLUMN verification_run_assertion.kind IS 'status_code | response_schema | header | content_type | latency | custom';
COMMENT ON COLUMN verification_run_assertion.outcome IS 'passed | failed | skipped';
COMMENT ON COLUMN verification_run_assertion.subject IS 'What was asserted on: a JSON Pointer, a header name, or a label';
COMMENT ON COLUMN verification_run_assertion.expected IS 'Redacted rendering of what the contract required';
COMMENT ON COLUMN verification_run_assertion.actual IS 'Redacted rendering of what was observed';
COMMENT ON COLUMN verification_run_assertion.code IS 'Stable machine code; required by CHECK for a failed assertion';
COMMENT ON COLUMN verification_run_assertion.message IS 'Redacted human explanation';
COMMENT ON COLUMN verification_run_assertion.created_at IS 'When the row was written (insert-only)';

CREATE INDEX IF NOT EXISTS idx_verification_run_assertion_operation
    ON verification_run_assertion (operation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_verification_run_assertion_run
    ON verification_run_assertion (run_id, sequence);

-- ---------------------------------------------------------------------------------------------------
-- verification_run_artifact — redacted artifacts, linked and hashed, never embedded.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_run_artifact (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    -- NULL for a run-level artifact (the runner log); set for a per-case one (a captured exchange).
    operation_id UUID,

    kind TEXT NOT NULL
        CONSTRAINT verification_run_artifact_kind_check
            CHECK (kind IN ('request', 'response', 'log', 'har', 'report', 'diff', 'other')),
    label TEXT,
    media_type TEXT,

    -- The link. There is deliberately no column for content: evidence points at an artifact, it
    -- does not carry one. ``data:`` is refused below because a data URI *is* the content.
    uri TEXT NOT NULL,
    size_bytes BIGINT
        CONSTRAINT verification_run_artifact_size_check
            CHECK (size_bytes IS NULL OR size_bytes >= 0),
    -- Lets a reader confirm the bytes they fetched are the bytes this evidence names.
    content_sha256 TEXT,

    -- Not a flag the writer chooses: the CHECK below admits only TRUE, so the schema has no
    -- representation for an unredacted artifact reference.
    redacted BOOLEAN NOT NULL DEFAULT TRUE
        CONSTRAINT verification_run_artifact_redacted_check CHECK (redacted),
    -- What redaction removed, in counts (headers, body fields). Says the work happened without
    -- naming what was removed.
    redaction JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Linked, not embedded.
    CONSTRAINT verification_run_artifact_uri_not_inline_check
        CHECK (uri !~* '^data:'),
    -- No ``user:pass@`` in the authority — an artifact link is not a place to keep a credential.
    CONSTRAINT verification_run_artifact_uri_no_credentials_check
        CHECK (uri !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*@'),
    CONSTRAINT verification_run_artifact_sha_shape_check
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT verification_run_artifact_redaction_object_check
        CHECK (jsonb_typeof(redaction) = 'object'),

    CONSTRAINT verification_run_artifact_run_fk
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES verification_run (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT verification_run_artifact_operation_fk
        FOREIGN KEY (operation_id, tenant_id)
        REFERENCES verification_run_operation (id, tenant_id) ON DELETE CASCADE
);

COMMENT ON TABLE verification_run_artifact IS
    'Immutable reference to a redacted run artifact — a link and a content hash, never the bytes (ECA-1.3, #4731)';
COMMENT ON COLUMN verification_run_artifact.run_id IS 'Owning run; the composite FK pins the row to the run''s tenant';
COMMENT ON COLUMN verification_run_artifact.operation_id IS 'Owning case, or NULL for a run-level artifact such as the runner log';
COMMENT ON COLUMN verification_run_artifact.kind IS 'request | response | log | har | report | diff | other';
COMMENT ON COLUMN verification_run_artifact.label IS 'Short human label for the artifact';
COMMENT ON COLUMN verification_run_artifact.media_type IS 'Media type of the referenced artifact';
COMMENT ON COLUMN verification_run_artifact.uri IS 'Where the artifact lives; may not be a data: URI (that is embedding) and may not carry credentials';
COMMENT ON COLUMN verification_run_artifact.size_bytes IS 'Size of the referenced artifact in bytes, when known';
COMMENT ON COLUMN verification_run_artifact.content_sha256 IS 'SHA-256 of the referenced bytes, so a reader can verify what they fetched';
COMMENT ON COLUMN verification_run_artifact.redacted IS 'Always TRUE by CHECK — an unredacted artifact reference has no representation here';
COMMENT ON COLUMN verification_run_artifact.redaction IS 'Counts of what redaction removed (headers, body fields); never the removed values';
COMMENT ON COLUMN verification_run_artifact.created_at IS 'When the row was written (insert-only)';

CREATE INDEX IF NOT EXISTS idx_verification_run_artifact_run
    ON verification_run_artifact (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_run_artifact_operation
    ON verification_run_artifact (operation_id, created_at);

-- ---------------------------------------------------------------------------------------------------
-- Immutability: evidence is write-once on all four tables.
-- ---------------------------------------------------------------------------------------------------
-- A BEFORE UPDATE trigger rejects any in-place edit. DELETE stays available to the FK cascades and
-- to the retention sweep below, so bounded storage does not require mutable evidence.
DROP TRIGGER IF EXISTS trigger_verification_run_immutable ON verification_run;
CREATE TRIGGER trigger_verification_run_immutable
    BEFORE UPDATE ON verification_run
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

DROP TRIGGER IF EXISTS trigger_verification_run_operation_immutable ON verification_run_operation;
CREATE TRIGGER trigger_verification_run_operation_immutable
    BEFORE UPDATE ON verification_run_operation
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

DROP TRIGGER IF EXISTS trigger_verification_run_assertion_immutable ON verification_run_assertion;
CREATE TRIGGER trigger_verification_run_assertion_immutable
    BEFORE UPDATE ON verification_run_assertion
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

DROP TRIGGER IF EXISTS trigger_verification_run_artifact_immutable ON verification_run_artifact;
CREATE TRIGGER trigger_verification_run_artifact_immutable
    BEFORE UPDATE ON verification_run_artifact
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Retention: evidence is bounded by age, not by row count.
-- ---------------------------------------------------------------------------------------------------
-- Deleting the run cascades to its operations, assertions, and artifact references, so a purge can
-- never leave orphaned detail rows behind.
CREATE OR REPLACE FUNCTION purge_verification_evidence(p_retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
    v_purged INTEGER;
    v_cutoff TIMESTAMP WITH TIME ZONE := CURRENT_TIMESTAMP - (GREATEST(p_retention_days, 0) * INTERVAL '1 day');
BEGIN
    DELETE FROM apiome.verification_run WHERE created_at < v_cutoff;
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    RETURN v_purged;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_verification_evidence(INTEGER) IS
    'Hard-delete verification runs (and their cascaded operations, assertions, and artifact references) older than p_retention_days (default 365). Returns the number of purged runs (ECA-1.3, #4731).';

-- ---------------------------------------------------------------------------------------------------
-- RBAC: verification_evidence resource in the built-in role grids.
-- ---------------------------------------------------------------------------------------------------
-- Full replacement of the V211 function body with 'verification_evidence' added. The function
-- rewrites the built-in grids from scratch on every call and apiome-rest re-invokes it on demand, so
-- replacing it here and reseeding below is idempotent and self-healing for all tenants.
--
-- Grid rationale: recording evidence is what a CI runner does on every build, and a runner
-- authenticating with an API key resolves to the Editor grid — so Editor gets view + create.
-- Editing is meaningless (evidence is immutable) and deleting is a retention/erasure decision, so
-- both stay with Owner/Admin.
CREATE OR REPLACE FUNCTION apiome.seed_builtin_roles(p_tenant UUID)
RETURNS void AS $$
DECLARE
    v_owner UUID;
    v_admin UUID;
    v_editor UUID;
    v_viewer UUID;
    -- Resources that behave like editable content (full CRUD for Editor).
    content_resources TEXT[] := ARRAY['projects','versions','classes','properties','paths','imports','api_keys'];
    all_resources TEXT[] := ARRAY['projects','versions','classes','properties','paths','types','imports','members','api_keys','billing','lint_findings','verification_targets','verification_evidence'];
    r TEXT;
BEGIN
    -- Upsert the four built-in roles.
    INSERT INTO apiome.roles (tenant_id, slug, name, description, is_builtin) VALUES
        (p_tenant, 'owner',  'Owner',  'Full control of the tenant, including billing and members.', true),
        (p_tenant, 'admin',  'Admin',  'Manage members, roles, and all content; no billing administration.', true),
        (p_tenant, 'editor', 'Editor', 'Create and edit content, but cannot publish, manage members, or change settings.', true),
        (p_tenant, 'viewer', 'Viewer', 'Read-only access to the tenant.', true)
    ON CONFLICT (tenant_id, slug) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            is_builtin = true;

    SELECT id INTO v_owner  FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'owner';
    SELECT id INTO v_admin  FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'admin';
    SELECT id INTO v_editor FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'editor';
    SELECT id INTO v_viewer FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'viewer';

    -- Rewrite built-in grids from scratch (idempotent / self-healing).
    DELETE FROM apiome.role_permissions WHERE role_id IN (v_owner, v_admin, v_editor, v_viewer);

    -- Owner: every action on every resource, plus version publishing and waiver approval.
    FOREACH r IN ARRAY all_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action)
        SELECT v_owner, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_owner, 'versions', 'publish');
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_owner, 'lint_findings', 'publish');

    -- Admin: same as Owner but billing is view-only (billing administration is Owner-only).
    FOREACH r IN ARRAY all_resources LOOP
        IF r = 'billing' THEN
            INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'billing', 'view');
        ELSE
            INSERT INTO apiome.role_permissions (role_id, resource, action)
            SELECT v_admin, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
        END IF;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'versions', 'publish');
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'lint_findings', 'publish');

    -- Editor: full CRUD on content resources; view-only on governance resources; no publish.
    -- lint_findings: view + edit (assign, acknowledge, request waivers) but no approval.
    -- verification_targets: view only — enough to run verification, not to redefine where it points.
    -- verification_evidence: view + create — recording a run is what verification *is*, and evidence
    -- cannot be edited by anyone (it is immutable) or deleted by an Editor (that is retention).
    FOREACH r IN ARRAY content_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action)
        SELECT v_editor, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action)
    SELECT v_editor, res, 'view' FROM unnest(ARRAY['types','members','billing','verification_targets']) AS res;
    INSERT INTO apiome.role_permissions (role_id, resource, action)
    SELECT v_editor, 'lint_findings', a FROM unnest(ARRAY['view','edit']) AS a;
    INSERT INTO apiome.role_permissions (role_id, resource, action)
    SELECT v_editor, 'verification_evidence', a FROM unnest(ARRAY['view','create']) AS a;

    -- Viewer: view-only on every resource.
    FOREACH r IN ARRAY all_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_viewer, r, 'view');
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.seed_builtin_roles(UUID) IS
    'Idempotently (re)seed the four built-in roles and their canonical permission grids for a tenant (#3611; lint_findings added by #4859; verification_targets added by #4730; verification_evidence added by #4731)';

COMMENT ON COLUMN apiome.role_permissions.resource IS
    'One of: projects, versions, classes, properties, paths, types, imports, members, api_keys, billing, lint_findings, verification_targets, verification_evidence';

-- Reseed every existing tenant so the new resource lands in all built-in grids.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT id FROM apiome.tenants LOOP
        PERFORM apiome.seed_builtin_roles(t.id);
    END LOOP;
END;
$$;
