-- Saved schema test suites and regression tracking — IXH-5.7 (#5119).
--
-- Problem: a payload validated once (IXH-5.1) is worth keeping, but the Test Bench (IXH-5.3)
-- stores its saved payloads browser-local only. Every schema change means re-authoring the
-- payloads that proved it worked, and nobody can see that a revision broke a payload that
-- used to pass.
--
-- Solution: four tables. A *suite* names a set of payloads plus expected verdicts and is
-- attached to a stable, version-independent schema reference (`ref_kind`/`ref_artifact`
-- [/`ref_type`] — the IXH-5.1 grammar minus the version segment, so the attachment survives
-- revisions). A *payload* row carries the instance text and its corpus validity class, from
-- which the expected verdict is derived (`valid` => the payload must validate). A *run* pins
-- the suite (at a `suite_version`) against one resolved revision and records the aggregate
-- verdict; a *result* row records the per-payload verdict, the verdict from the previous
-- completed run (`previous_status`), and whether that pair is a regression
-- (previously `passed`, now `failed`).
--
--   * Registry refs (`registry/...`) are deliberately excluded: every acceptance criterion
--     of the ticket is revision-centric and registry types have no revisions. Lifting the
--     restriction later is an additive constraint change.
--   * `ref_artifact_id` is resolved best-effort at suite creation and has no FK because the
--     target is polymorphic (projects vs catalog items); the textual segments are the truth.
--   * `payload_name` is copied onto result rows so history survives payload rename/delete,
--     and it is the join key for regression comparison across runs.
--
-- Bounded growth (acceptance criterion 5): payloads are bounded per suite
-- (APIOME_SCHEMA_SUITE_MAX_PAYLOADS, default 50) and per payload (256 KiB CHECK below).
-- Runs are events and accrue with traffic; they are pruned two ways — on write beyond
-- APIOME_SCHEMA_SUITE_RUN_MAX_PER_SUITE (default 200, oldest first) and by age on the
-- IXH-6.3 retention tick (APIOME_SCHEMA_SUITE_RUN_RETENTION_DAYS, default 180, keeping at
-- least APIOME_SCHEMA_SUITE_RUN_KEEP_MIN newest per suite so the regression baseline is
-- never pruned away). Result rows follow their run via ON DELETE CASCADE.
--
-- Rollback notes (reverse carefully in shared environments; child-first order):
--   DROP TABLE IF EXISTS apiome.schema_test_suite_run_results;
--   DROP TABLE IF EXISTS apiome.schema_test_suite_runs;
--   DROP TABLE IF EXISTS apiome.schema_test_suite_payloads;
--   DROP TABLE IF EXISTS apiome.schema_test_suites;

SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS schema_test_suites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name TEXT NOT NULL
        CONSTRAINT schema_test_suites_name_length_check
            CHECK (char_length(name) BETWEEN 1 AND 200),
    description TEXT,

    -- Stable schema reference, version segment deliberately absent (survives revisions).
    ref_kind TEXT NOT NULL
        CONSTRAINT schema_test_suites_ref_kind_check
            CHECK (ref_kind IN ('project', 'catalog')),
    ref_artifact TEXT NOT NULL
        CONSTRAINT schema_test_suites_ref_artifact_check
            CHECK (char_length(ref_artifact) BETWEEN 1 AND 500),
    ref_artifact_id UUID,
    ref_type TEXT,

    -- Bumped on any payload mutation; runs record which version they executed.
    suite_version INTEGER NOT NULL DEFAULT 1
        CONSTRAINT schema_test_suites_suite_version_check CHECK (suite_version >= 1),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT schema_test_suites_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_schema_test_suites_tenant_ref
    ON schema_test_suites (tenant_id, ref_kind, ref_artifact);
CREATE INDEX IF NOT EXISTS idx_schema_test_suites_tenant_artifact_id
    ON schema_test_suites (tenant_id, ref_artifact_id);

CREATE TABLE IF NOT EXISTS schema_test_suite_payloads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    suite_id UUID NOT NULL REFERENCES schema_test_suites(id) ON DELETE CASCADE,
    -- Denormalized so payload queries scope by tenant without a join.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name TEXT NOT NULL
        CONSTRAINT schema_test_suite_payloads_name_length_check
            CHECK (char_length(name) BETWEEN 1 AND 200),
    payload_text TEXT NOT NULL
        CONSTRAINT schema_test_suite_payloads_size_check
            CHECK (octet_length(payload_text) <= 262144),
    media_type TEXT NOT NULL DEFAULT 'application/json'
        CONSTRAINT schema_test_suite_payloads_media_type_check
            CHECK (media_type IN ('application/json', 'application/xml')),

    -- IXH-1.1 corpus vocabulary; the expected verdict is derived (valid => must validate),
    -- mirroring the CLI's manifest loading so corpus export/import is lossless.
    validity_class TEXT NOT NULL DEFAULT 'valid'
        CONSTRAINT schema_test_suite_payloads_validity_class_check
            CHECK (validity_class IN ('valid', 'invalid', 'adversarial', 'scale')),
    synthetic BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    position INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_payloads_position_check CHECK (position >= 0),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT schema_test_suite_payloads_suite_name_unique UNIQUE (suite_id, name)
);

CREATE INDEX IF NOT EXISTS idx_schema_test_suite_payloads_suite_position
    ON schema_test_suite_payloads (suite_id, position);

CREATE TABLE IF NOT EXISTS schema_test_suite_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    suite_id UUID NOT NULL REFERENCES schema_test_suites(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- The suite content version this run executed.
    suite_version INTEGER NOT NULL
        CONSTRAINT schema_test_suite_runs_suite_version_check CHECK (suite_version >= 1),

    -- The concrete reference the caller asked for (e.g. catalog/orders/1.2.0) and what it
    -- resolved to. resolved_revision_id is NULL when resolution failed (status = 'error').
    requested_ref TEXT NOT NULL,
    resolved_revision_id UUID,
    resolved_version_label TEXT,

    trigger TEXT NOT NULL DEFAULT 'manual'
        CONSTRAINT schema_test_suite_runs_trigger_check
            CHECK (trigger IN ('manual', 'revision')),
    status TEXT NOT NULL
        CONSTRAINT schema_test_suite_runs_status_check
            CHECK (status IN ('completed', 'error')),

    total INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_runs_total_check CHECK (total >= 0),
    passed INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_runs_passed_check CHECK (passed >= 0),
    failed INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_runs_failed_check CHECK (failed >= 0),
    errored INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_runs_errored_check CHECK (errored >= 0),

    -- True when any result row is a regression (previously passed, now failed).
    regression BOOLEAN NOT NULL DEFAULT FALSE,
    -- The prior completed run the verdict diff was computed against; SET NULL if pruned.
    baseline_run_id UUID REFERENCES schema_test_suite_runs(id) ON DELETE SET NULL,

    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Read path: "this suite, newest first"; badge path: "this tenant, this revision";
-- prune path: "older than a cutoff / beyond a rank per suite".
CREATE INDEX IF NOT EXISTS idx_schema_test_suite_runs_suite_time
    ON schema_test_suite_runs (suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schema_test_suite_runs_tenant_revision
    ON schema_test_suite_runs (tenant_id, resolved_revision_id);
CREATE INDEX IF NOT EXISTS idx_schema_test_suite_runs_created_at
    ON schema_test_suite_runs (created_at);

CREATE TABLE IF NOT EXISTS schema_test_suite_run_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    run_id UUID NOT NULL REFERENCES schema_test_suite_runs(id) ON DELETE CASCADE,
    -- SET NULL: the result row must survive payload deletion; payload_name is the copy that
    -- keeps history readable and is the regression join key across runs.
    payload_id UUID REFERENCES schema_test_suite_payloads(id) ON DELETE SET NULL,
    payload_name TEXT NOT NULL,

    expected_valid BOOLEAN NOT NULL,
    -- Tri-state, mirroring IXH-5.1: TRUE/FALSE only when a validator ran; NULL when it did not.
    valid BOOLEAN,
    validated BOOLEAN NOT NULL DEFAULT FALSE,

    status TEXT NOT NULL
        CONSTRAINT schema_test_suite_run_results_status_check
            CHECK (status IN ('passed', 'failed', 'error')),
    -- Verdict of the same payload (by name) in the baseline run; NULL when it had none.
    previous_status TEXT
        CONSTRAINT schema_test_suite_run_results_previous_status_check
            CHECK (previous_status IS NULL OR previous_status IN ('passed', 'failed', 'error')),
    -- A regression is strictly the verdict flip passed -> failed. passed -> error is not a
    -- regression (no verdict was produced); it stays visible through previous_status.
    regression BOOLEAN NOT NULL DEFAULT FALSE,

    -- Capped copy of the IXH-5.1 findings (APIOME_SCHEMA_SUITE_RESULT_FINDINGS_CAP).
    findings JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT schema_test_suite_run_results_findings_array_check
            CHECK (jsonb_typeof(findings) = 'array'),
    message TEXT,
    position INTEGER NOT NULL DEFAULT 0
        CONSTRAINT schema_test_suite_run_results_position_check CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS idx_schema_test_suite_run_results_run_position
    ON schema_test_suite_run_results (run_id, position);

COMMENT ON TABLE schema_test_suites IS
    'Named, tenant-scoped schema test suites attached to a version-independent schema reference (IXH-5.7, #5119)';
COMMENT ON COLUMN schema_test_suites.id IS 'Unique identifier for the suite';
COMMENT ON COLUMN schema_test_suites.tenant_id IS 'Tenant the suite belongs to';
COMMENT ON COLUMN schema_test_suites.name IS 'Suite name, unique per tenant';
COMMENT ON COLUMN schema_test_suites.description IS 'Optional free-text description';
COMMENT ON COLUMN schema_test_suites.ref_kind IS 'project | catalog — registry refs are excluded because they have no revisions to regress against';
COMMENT ON COLUMN schema_test_suites.ref_artifact IS 'Artifact segment of the IXH-5.1 reference grammar (project or catalog item slug/id) exactly as given';
COMMENT ON COLUMN schema_test_suites.ref_artifact_id IS 'Best-effort resolved artifact id; no FK because the target is polymorphic';
COMMENT ON COLUMN schema_test_suites.ref_type IS 'Optional type segment (canonical stable key or source name); NULL = whole revision';
COMMENT ON COLUMN schema_test_suites.suite_version IS 'Content version, bumped on any payload mutation';
COMMENT ON COLUMN schema_test_suites.created_at IS 'When the suite was created';
COMMENT ON COLUMN schema_test_suites.updated_at IS 'When the suite or its payloads last changed';

COMMENT ON TABLE schema_test_suite_payloads IS
    'Instance payloads belonging to a schema test suite, with their corpus validity class (IXH-5.7, #5119)';
COMMENT ON COLUMN schema_test_suite_payloads.id IS 'Unique identifier for the payload';
COMMENT ON COLUMN schema_test_suite_payloads.suite_id IS 'Owning suite';
COMMENT ON COLUMN schema_test_suite_payloads.tenant_id IS 'Tenant, denormalized from the suite for scoped queries';
COMMENT ON COLUMN schema_test_suite_payloads.name IS 'Payload name, unique within the suite; the regression join key across runs';
COMMENT ON COLUMN schema_test_suite_payloads.payload_text IS 'The instance document text (bounded to 256 KiB)';
COMMENT ON COLUMN schema_test_suite_payloads.media_type IS 'application/json | application/xml — the IXH-5.1 request media types';
COMMENT ON COLUMN schema_test_suite_payloads.validity_class IS 'IXH-1.1 corpus class; expected verdict derives from it (valid => must validate)';
COMMENT ON COLUMN schema_test_suite_payloads.synthetic IS 'True when the payload was produced by IXH-5.2 synthesis rather than hand-authored';
COMMENT ON COLUMN schema_test_suite_payloads.notes IS 'Optional free-text notes carried to corpus export';
COMMENT ON COLUMN schema_test_suite_payloads.position IS 'Execution/display order within the suite';
COMMENT ON COLUMN schema_test_suite_payloads.created_at IS 'When the payload row was created';

COMMENT ON TABLE schema_test_suite_runs IS
    'One execution of a suite against one resolved schema revision, with aggregate verdicts (IXH-5.7, #5119)';
COMMENT ON COLUMN schema_test_suite_runs.id IS 'Unique identifier for the run';
COMMENT ON COLUMN schema_test_suite_runs.suite_id IS 'Suite that was executed';
COMMENT ON COLUMN schema_test_suite_runs.tenant_id IS 'Tenant, denormalized for scoped queries and the retention sweep';
COMMENT ON COLUMN schema_test_suite_runs.suite_version IS 'Suite content version that was executed';
COMMENT ON COLUMN schema_test_suite_runs.requested_ref IS 'Concrete reference the caller asked to run against';
COMMENT ON COLUMN schema_test_suite_runs.resolved_revision_id IS 'Revision the reference resolved to; NULL when resolution failed';
COMMENT ON COLUMN schema_test_suite_runs.resolved_version_label IS 'Human version label of the resolved revision, when known';
COMMENT ON COLUMN schema_test_suite_runs.trigger IS 'manual = user-initiated; revision = fired because a new revision appeared';
COMMENT ON COLUMN schema_test_suite_runs.status IS 'completed = every payload was judged; error = the run could not execute (e.g. unresolvable reference)';
COMMENT ON COLUMN schema_test_suite_runs.total IS 'Payloads in the run';
COMMENT ON COLUMN schema_test_suite_runs.passed IS 'Payloads whose verdict matched the expectation';
COMMENT ON COLUMN schema_test_suite_runs.failed IS 'Payloads whose verdict contradicted the expectation';
COMMENT ON COLUMN schema_test_suite_runs.errored IS 'Payloads for which no verdict was produced';
COMMENT ON COLUMN schema_test_suite_runs.regression IS 'True when any payload previously passed and now failed';
COMMENT ON COLUMN schema_test_suite_runs.baseline_run_id IS 'Prior completed run the verdict diff was computed against';
COMMENT ON COLUMN schema_test_suite_runs.message IS 'Run-level error message when status = error';
COMMENT ON COLUMN schema_test_suite_runs.created_at IS 'When the run executed (the history timestamp)';

COMMENT ON TABLE schema_test_suite_run_results IS
    'Per-payload verdicts of a suite run, including the verdict diff against the baseline run (IXH-5.7, #5119)';
COMMENT ON COLUMN schema_test_suite_run_results.id IS 'Unique identifier for the result row';
COMMENT ON COLUMN schema_test_suite_run_results.run_id IS 'Run the result belongs to';
COMMENT ON COLUMN schema_test_suite_run_results.payload_id IS 'Source payload; NULL after the payload is deleted (history survives)';
COMMENT ON COLUMN schema_test_suite_run_results.payload_name IS 'Payload name copied at run time; regression join key across runs';
COMMENT ON COLUMN schema_test_suite_run_results.expected_valid IS 'Expected verdict derived from validity_class at run time';
COMMENT ON COLUMN schema_test_suite_run_results.valid IS 'IXH-5.1 tri-state validation outcome; NULL when no validator ran';
COMMENT ON COLUMN schema_test_suite_run_results.validated IS 'Whether a validator actually ran';
COMMENT ON COLUMN schema_test_suite_run_results.status IS 'passed | failed | error — the judged verdict';
COMMENT ON COLUMN schema_test_suite_run_results.previous_status IS 'Verdict of the same payload in the baseline run; NULL when it had none';
COMMENT ON COLUMN schema_test_suite_run_results.regression IS 'True iff previous_status = passed AND status = failed';
COMMENT ON COLUMN schema_test_suite_run_results.findings IS 'Capped copy of the IXH-5.1 findings for the payload';
COMMENT ON COLUMN schema_test_suite_run_results.message IS 'Human-readable judgement or error message';
COMMENT ON COLUMN schema_test_suite_run_results.position IS 'Payload order within the run';
