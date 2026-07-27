-- Revision-scoped payload analysis — CPDO-1.1 (#4794).
--
-- Problem: a catalog detail read reconstructs the source on every request and reduces it to
-- generic entity/field rows. The structures that make a mainframe or EDI payload worth cataloguing
-- at all — X12 interchange/group/transaction-set envelopes, delimiters, segment positions, copybook
-- level numbers, PICTURE clauses, OCCURS bounds and 88-level conditions — survive nowhere. They are
-- derived, shown, and thrown away, so nothing can cite them later and nothing notices when a parser
-- upgrade silently changes them.
--
-- Solution: one additive table, ``payload_analysis`` — an immutable, append-only record of what an
-- analyzer observed in ONE source revision. The record names the bytes it analysed (``source_hash``),
-- the contract it was written against (``schema_version``), and the analyzer that wrote it
-- (``analyzer_key`` / ``analyzer_version`` / ``tool_versions``), so a reader can always tell whether
-- what it is looking at still describes the source in front of it.
--
--   * ``version_id``        — the source revision (``apiome.versions``). This is the scope: a
--                             re-import mints a new revision and therefore a new analysis. The
--                             analysis of a revision never changes underneath a reader.
--   * ``analysis_sequence`` — monotonic per revision; the highest is the current analysis. Rows are
--                             write-once, so an analyzer upgrade *appends* rather than rewrites, and
--                             an evidence reference to an older row stays resolvable.
--   * ``status``            — ``available`` / ``partial`` / ``unavailable`` / ``failed``. A legacy or
--                             unparseable source gets a declared ``unavailable`` row with an empty
--                             tree and a reason code. It never gets a fabricated one; the CHECK
--                             constraints below make that a schema guarantee rather than a habit.
--   * ``tree``              — the native structure, as the analyzer observed it, in the shape the
--                             ``app.payload_analysis`` Pydantic contract validates.
--   * ``redaction``         — what was withheld and under which policy. The analysis stores
--                             *structure*; payload values are governed by the value-visibility
--                             policy recorded here, so the record is not a second copy of the
--                             source. Raw source material stays where it already lives.
--
-- Retention: ``apiome.purge_payload_analysis`` hard-deletes superseded rows (any analysis that is no
-- longer the newest for its revision) and analyses belonging to soft-deleted revisions, once both are
-- older than a retention window. The current analysis of a live revision is never purged — it is the
-- catalog record. Intended for the same scheduled maintenance job as
-- ``apiome.purge_preservation_claims`` (V184).
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP FUNCTION IF EXISTS apiome.purge_payload_analysis(INTEGER);
--   DROP TABLE IF EXISTS apiome.payload_analysis;
-- (The V128 guard function apiome.mcp_forbid_row_mutation() is shared — do not drop it here.)

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- payload_analysis — immutable, revision-scoped native analysis (newest sequence is current).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payload_analysis (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Scope. tenant_id and project_id are denormalized off the revision so every read, retention
    -- sweep, and future RLS policy filters by tenant without walking versions -> projects.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,

    -- Monotonic per revision; application assigns next = max(analysis_sequence) + 1. The highest is
    -- the analysis in force; older rows stay readable for the evidence references that named them.
    analysis_sequence INTEGER NOT NULL,

    -- Version of the app.payload_analysis contract this row was written against, so a reader can
    -- refuse (rather than misread) a record from a future contract.
    schema_version TEXT NOT NULL,

    -- SHA-256 over the canonicalized analysis document: identifies the analysis content itself, and
    -- lets a re-analysis that produced identical output be recognised instead of appended.
    content_fingerprint TEXT NOT NULL,

    -- What was analysed: the adapter key (matching apiome.versions.source_format) and an
    -- algorithm-prefixed digest of the exact bytes. The digest is what proves the analysis still
    -- describes the source; without it a record is only a claim.
    source_format VARCHAR(128),
    source_hash TEXT,

    -- Who analysed it. analyzer_key is the extractor SPI key (CPDO-1.2), analyzer_version its
    -- contract-relevant version, and tool_versions the underlying parsers/libraries it leaned on.
    analyzer_key TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    tool_versions JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- available = the analyzer described the whole source; partial = it described some of it and
    -- said which parts it could not (bounds, unsupported grammar); unavailable = nothing was
    -- analysed (legacy revision, no captured source, unsupported format); failed = the analyzer
    -- errored. Only 'available' may omit a reason code.
    status TEXT NOT NULL
        CONSTRAINT payload_analysis_status_check
            CHECK (status IN ('available', 'partial', 'unavailable', 'failed')),
    status_reason TEXT,

    -- The native tree, as an array of root nodes in the app.payload_analysis contract shape.
    tree JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Derived counts and bounds (node_count, max_depth, truncated, per-kind tallies).
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Analyzer warnings: unsupported constructs, applied bounds, ambiguous layouts. An empty array
    -- means the analyzer had nothing to say, not that nothing was checked.
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Redaction metadata: the value-visibility policy in force and how much it withheld. Present on
    -- every row, so "no values here" is always a stated policy rather than an inference.
    redaction JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT payload_analysis_sequence_positive_check
        CHECK (analysis_sequence >= 1),
    CONSTRAINT payload_analysis_version_sequence_uq
        UNIQUE (version_id, analysis_sequence),

    -- JSONB shape guards: the contract's containers cannot degrade into scalars in storage.
    CONSTRAINT payload_analysis_tree_array_check
        CHECK (jsonb_typeof(tree) = 'array'),
    CONSTRAINT payload_analysis_warnings_array_check
        CHECK (jsonb_typeof(warnings) = 'array'),
    CONSTRAINT payload_analysis_metrics_object_check
        CHECK (jsonb_typeof(metrics) = 'object'),
    CONSTRAINT payload_analysis_redaction_object_check
        CHECK (jsonb_typeof(redaction) = 'object'),
    CONSTRAINT payload_analysis_tool_versions_object_check
        CHECK (jsonb_typeof(tool_versions) = 'object'),

    -- Truthfulness guards (the AC "never fabricated data", enforced by the schema):
    --   1. A record that claims to describe source bytes must name them.
    --   2. A record that describes nothing must contain nothing.
    --   3. A record that is not fully available must say why.
    CONSTRAINT payload_analysis_source_hash_required_check
        CHECK (status NOT IN ('available', 'partial') OR source_hash IS NOT NULL),
    CONSTRAINT payload_analysis_empty_tree_when_absent_check
        CHECK (status NOT IN ('unavailable', 'failed') OR jsonb_array_length(tree) = 0),
    CONSTRAINT payload_analysis_reason_required_check
        CHECK (status = 'available' OR (status_reason IS NOT NULL AND status_reason <> '')),

    -- Algorithm-prefixed digest, matching the apiome.version_preservation_claims convention (V184).
    CONSTRAINT payload_analysis_source_hash_shape_check
        CHECK (source_hash IS NULL OR source_hash ~ '^sha256:[0-9a-f]{64}$')
);

COMMENT ON TABLE payload_analysis IS
    'Immutable, revision-scoped native payload analysis; highest analysis_sequence per version_id is in force, and a legacy/unparseable source gets a declared unavailable row rather than a fabricated tree (CPDO-1.1, #4794)';
COMMENT ON COLUMN payload_analysis.id IS 'Unique identifier for the analysis record';
COMMENT ON COLUMN payload_analysis.tenant_id IS 'Tenant that owns the analysed revision (denormalized for tenant-scoped reads)';
COMMENT ON COLUMN payload_analysis.project_id IS 'Catalog project the analysed revision belongs to (denormalized for item-scoped reads)';
COMMENT ON COLUMN payload_analysis.version_id IS 'Source revision the analysis describes; the scope of immutability';
COMMENT ON COLUMN payload_analysis.analysis_sequence IS 'Monotonic sequence per revision (starts at 1); highest is the analysis in force';
COMMENT ON COLUMN payload_analysis.schema_version IS 'Version of the app.payload_analysis contract this record was written against';
COMMENT ON COLUMN payload_analysis.content_fingerprint IS 'SHA-256 over the canonicalized analysis document; identical re-analysis is recognised rather than appended';
COMMENT ON COLUMN payload_analysis.source_format IS 'Adapter key of the analysed source (same vocabulary as apiome.versions.source_format)';
COMMENT ON COLUMN payload_analysis.source_hash IS 'Algorithm-prefixed digest (sha256:<hex>) of the exact bytes analysed; required for available/partial records';
COMMENT ON COLUMN payload_analysis.analyzer_key IS 'Key of the analyzer that produced the record';
COMMENT ON COLUMN payload_analysis.analyzer_version IS 'Version of that analyzer, so a contract-relevant upgrade is visible to readers';
COMMENT ON COLUMN payload_analysis.tool_versions IS 'Underlying parser/library versions the analyzer used, e.g. {"edix12": "1.4.0"}';
COMMENT ON COLUMN payload_analysis.status IS 'available | partial | unavailable | failed; only available may omit status_reason';
COMMENT ON COLUMN payload_analysis.status_reason IS 'Reason code explaining a partial/unavailable/failed analysis (e.g. no_source_captured, unsupported_format, bounds_exceeded)';
COMMENT ON COLUMN payload_analysis.tree IS 'Native structure as observed, as an array of root nodes in the app.payload_analysis contract shape; empty for unavailable/failed';
COMMENT ON COLUMN payload_analysis.metrics IS 'Derived metrics: node_count, max_depth, truncated, per-kind tallies';
COMMENT ON COLUMN payload_analysis.warnings IS 'Analyzer warnings: unsupported constructs, applied bounds, ambiguous layouts';
COMMENT ON COLUMN payload_analysis.redaction IS 'Value-visibility policy in force and how much it withheld; present on every row so absent values are always a stated policy';
COMMENT ON COLUMN payload_analysis.created_by IS 'User whose action produced the analysis; NULL if later deleted or system-produced';
COMMENT ON COLUMN payload_analysis.created_at IS 'When the analysis was recorded (insert-only)';

-- Current-analysis lookup: the detail read is "newest row for this revision".
CREATE INDEX IF NOT EXISTS idx_payload_analysis_version
    ON payload_analysis (version_id, analysis_sequence DESC);

-- Item-scoped history: every analysis recorded for a catalog project, newest first.
CREATE INDEX IF NOT EXISTS idx_payload_analysis_tenant_project
    ON payload_analysis (tenant_id, project_id, created_at DESC);

-- Retention sweeps scan by age.
CREATE INDEX IF NOT EXISTS idx_payload_analysis_created_at
    ON payload_analysis (created_at);

-- ---------------------------------------------------------------------------------------------------
-- Immutability: analysis rows are write-once. A BEFORE UPDATE trigger rejects any in-place edit;
-- DELETE stays available to the FK cascades and to the retention purge below.
-- ---------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_payload_analysis_immutable ON payload_analysis;
CREATE TRIGGER trigger_payload_analysis_immutable
    BEFORE UPDATE ON payload_analysis
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Retention: drop what is no longer evidence for anything live.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_payload_analysis(p_retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    v_purged INTEGER;
    v_cutoff TIMESTAMP WITH TIME ZONE := CURRENT_TIMESTAMP - (GREATEST(p_retention_days, 0) * INTERVAL '1 day');
BEGIN
    DELETE FROM apiome.payload_analysis pa
    WHERE pa.created_at < v_cutoff
      AND (
            -- Superseded: a newer analysis exists for the same revision.
            EXISTS (
                SELECT 1
                FROM apiome.payload_analysis newer
                WHERE newer.version_id = pa.version_id
                  AND newer.analysis_sequence > pa.analysis_sequence
            )
            -- Or the revision it describes has been soft-deleted for longer than the window.
            OR EXISTS (
                SELECT 1
                FROM apiome.versions v
                WHERE v.id = pa.version_id
                  AND v.deleted_at IS NOT NULL
                  AND v.deleted_at < v_cutoff
            )
      );
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    RETURN v_purged;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_payload_analysis(INTEGER) IS
    'Hard-delete payload analyses older than p_retention_days (default 90) that are either superseded by a newer analysis of the same revision or attached to a revision soft-deleted beyond the window. The current analysis of a live revision is never purged. Returns the number of purged rows (CPDO-1.1, #4794).';
