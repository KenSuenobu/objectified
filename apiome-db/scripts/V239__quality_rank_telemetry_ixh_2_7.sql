-- Quality-rank telemetry and grade drift over revisions — IXH-2.7 (#5102).
--
-- Problem: grades are captured *per revision* (``versions.quality_score``, V124) and evaluated
-- per gate (the IXH-2.1/2.4 pre-flights and the IXH-2.3/2.5 policy gates), but nothing aggregates
-- them across intake. Nobody can see that a team's imports have been trending downward, or that
-- one format's adapter consistently yields low grades — which is as likely to be an adapter gap
-- as a spec problem, and the two are indistinguishable from a per-revision score alone.
--
-- Solution: one additive, append-only observation table. Every time a grade is produced —
-- an import pre-flight, a committed import, an export pre-flight ranking, a delivery gate — one
-- row records *what was graded*, *what graded it*, and *what the gate decided*, keyed by the four
-- dimensions the ticket asks for: tenant, format, adapter, and style-guide version.
--
--   * ``scope``     — ``import`` | ``export``: which half of the pipeline produced the grade.
--   * ``stage``     — ``preflight`` | ``committed``: a prediction versus a thing that happened.
--   * ``format_key``/``adapter_key`` — the source format and the adapter (import) or the target
--     format and its emitter registry key (export), so a per-format split can separate an adapter
--     gap from a spec problem.
--   * ``style_guide_id``/``style_guide_fingerprint`` — the style-guide *version* the grade was
--     produced under, so a grade drop caused by a stricter guide is not read as a quality drop.
--   * ``outcome``   — what the gate decided (pass / warn / block / error).
--
-- Attribution (acceptance criterion 3) is stored pre-computed, because it is derived from the
-- lint report which is not itself retained here: ``adapter_finding_count`` /
-- ``spec_finding_count`` split the findings, ``attribution`` names the per-class breakdown, and
-- ``declared_parser_limits`` carries the adapter's *declared* "our parser does not read this yet"
-- count (a declaration, deliberately never mixed into the finding tallies).
--
-- Export readiness ranks (acceptance criterion 1's last clause) ride the same rows:
-- ``readiness``, ``rank`` and ``band`` are populated for export observations and NULL for
-- imports, so one series answers both halves rather than two tables answering one each.
--
-- Bounded growth (acceptance criterion 4): rows are events, so they accrue with traffic. The
-- IXH-6.3 retention sweep prunes them by age (``APIOME_QUALITY_RANK_RETENTION_DAYS``, default
-- 180 days) on the tick that is already the deployment's retention worker, and the read API caps
-- its window. The ``occurred_at`` index is what makes both cheap.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP TABLE IF EXISTS apiome.quality_rank_observations;

SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS quality_rank_observations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Owning artifact/project when the graded subject had one (a candidate document being
    -- pre-flighted does not yet). SET NULL keeps the series intact when a project is deleted.
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

    -- The graded revision, for committed imports and every export. NULL for import pre-flights,
    -- whose subject is a candidate document rather than a stored revision.
    version_record_id UUID REFERENCES versions(id) ON DELETE SET NULL,

    scope TEXT NOT NULL
        CONSTRAINT quality_rank_observations_scope_check
            CHECK (scope IN ('import', 'export')),
    stage TEXT NOT NULL
        CONSTRAINT quality_rank_observations_stage_check
            CHECK (stage IN ('preflight', 'committed')),

    -- Source format (import) or target format (export), e.g. 'openapi-3.1'.
    format_key TEXT,
    -- Adapter registry key (import) or emitter/target registry key (export), e.g. 'openapi'.
    adapter_key TEXT,

    -- The style-guide version in force. The fingerprint is the guide's content hash (GOV-1.4),
    -- which is what actually changes a score, so it is the comparison key; the id is kept for
    -- drill-down and is NULL for the in-code fallback guide.
    style_guide_id UUID,
    style_guide_fingerprint TEXT,
    style_guide_source TEXT,

    -- The quality policy version in force at the time (IXH-2.3); NULL for the built-in default.
    policy_version_id UUID,
    policy_content_fingerprint TEXT,

    -- The policy verdict, when one was evaluated, and the gate outcome that followed.
    verdict TEXT
        CONSTRAINT quality_rank_observations_verdict_check
            CHECK (verdict IS NULL OR verdict IN ('pass', 'warn', 'block')),
    blocking BOOLEAN NOT NULL DEFAULT FALSE,
    outcome TEXT NOT NULL
        CONSTRAINT quality_rank_observations_outcome_check
            CHECK (outcome IN ('pass', 'warn', 'block', 'error')),

    -- The grade itself. NULL score/grade means "not gradable", which is a distinct fact from a
    -- low grade and must never be rendered as zero.
    score INTEGER
        CONSTRAINT quality_rank_observations_score_check
            CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    grade TEXT
        CONSTRAINT quality_rank_observations_grade_check
            CHECK (grade IS NULL OR grade IN ('A', 'B', 'C', 'D', 'F')),
    report_fingerprint TEXT,

    error_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_error_count_check CHECK (error_count >= 0),
    warning_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_warning_count_check CHECK (warning_count >= 0),
    info_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_info_count_check CHECK (info_count >= 0),

    -- Attribution split (acceptance criterion 3), pre-computed from the lint report's rule hits.
    adapter_finding_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_adapter_findings_check
            CHECK (adapter_finding_count >= 0),
    spec_finding_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_spec_findings_check
            CHECK (spec_finding_count >= 0),
    attribution JSONB NOT NULL DEFAULT '{}'::jsonb
        CONSTRAINT quality_rank_observations_attribution_object_check
            CHECK (jsonb_typeof(attribution) = 'object'),
    declared_parser_limits INTEGER NOT NULL DEFAULT 0
        CONSTRAINT quality_rank_observations_parser_limits_check
            CHECK (declared_parser_limits >= 0),

    -- Export readiness rank (IXH-2.4). NULL on every import observation.
    readiness INTEGER
        CONSTRAINT quality_rank_observations_readiness_check
            CHECK (readiness IS NULL OR (readiness >= 0 AND readiness <= 100)),
    rank INTEGER
        CONSTRAINT quality_rank_observations_rank_check
            CHECK (rank IS NULL OR rank >= 1),
    band TEXT
        CONSTRAINT quality_rank_observations_band_check
            CHECK (band IS NULL OR band IN ('ready', 'caution', 'blocked', 'unavailable')),
    preserved_percent INTEGER
        CONSTRAINT quality_rank_observations_preserved_check
            CHECK (preserved_percent IS NULL
                   OR (preserved_percent >= 0 AND preserved_percent <= 100)),

    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The read path is always "this tenant, this window, newest first", optionally narrowed by
-- scope/format; the prune path is "everything older than a cutoff" across tenants.
CREATE INDEX IF NOT EXISTS idx_quality_rank_observations_tenant_time
    ON quality_rank_observations (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_rank_observations_tenant_scope_format
    ON quality_rank_observations (tenant_id, scope, format_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_rank_observations_occurred_at
    ON quality_rank_observations (occurred_at);

COMMENT ON TABLE quality_rank_observations IS
    'Append-only time series of import/export quality grades and export readiness ranks, keyed by tenant, format, adapter and style-guide version (IXH-2.7, #5102)';
COMMENT ON COLUMN quality_rank_observations.id IS 'Unique identifier for the observation';
COMMENT ON COLUMN quality_rank_observations.tenant_id IS 'Tenant the observation belongs to';
COMMENT ON COLUMN quality_rank_observations.project_id IS 'Owning artifact/project when the graded subject had one; NULL for a candidate document';
COMMENT ON COLUMN quality_rank_observations.version_record_id IS 'Graded revision for committed imports and exports; NULL for import pre-flights';
COMMENT ON COLUMN quality_rank_observations.scope IS 'import = intake grade; export = delivery grade / readiness rank';
COMMENT ON COLUMN quality_rank_observations.stage IS 'preflight = predicted before the work; committed = recorded for work that happened';
COMMENT ON COLUMN quality_rank_observations.format_key IS 'Source format (import) or target format (export) the grade applies to';
COMMENT ON COLUMN quality_rank_observations.adapter_key IS 'Adapter registry key (import) or emitter/target registry key (export)';
COMMENT ON COLUMN quality_rank_observations.style_guide_id IS 'Style guide that scored the report; NULL for the in-code fallback guide';
COMMENT ON COLUMN quality_rank_observations.style_guide_fingerprint IS 'Content hash of the style guide version in force — the value that changes a score';
COMMENT ON COLUMN quality_rank_observations.style_guide_source IS 'builtin | custom | fallback — where the scoring guide came from';
COMMENT ON COLUMN quality_rank_observations.policy_version_id IS 'Import/export quality policy version in force; NULL for the built-in default policy';
COMMENT ON COLUMN quality_rank_observations.policy_content_fingerprint IS 'Content fingerprint of that policy version';
COMMENT ON COLUMN quality_rank_observations.verdict IS 'Policy verdict (pass/warn/block) when a policy was evaluated';
COMMENT ON COLUMN quality_rank_observations.blocking IS 'Whether the verdict actually refused the operation';
COMMENT ON COLUMN quality_rank_observations.outcome IS 'What the gate decided: pass | warn | block | error (error = never became gradable)';
COMMENT ON COLUMN quality_rank_observations.score IS 'Weighted 0-100 lint score; NULL when the candidate was not gradable';
COMMENT ON COLUMN quality_rank_observations.grade IS 'A-F lint grade; NULL when the candidate was not gradable';
COMMENT ON COLUMN quality_rank_observations.report_fingerprint IS 'Fingerprint of the lint report the grade came from, for drill-down';
COMMENT ON COLUMN quality_rank_observations.error_count IS 'Error-severity findings in the graded report';
COMMENT ON COLUMN quality_rank_observations.warning_count IS 'Warning-severity findings in the graded report';
COMMENT ON COLUMN quality_rank_observations.info_count IS 'Info-severity findings in the graded report';
COMMENT ON COLUMN quality_rank_observations.adapter_finding_count IS 'Findings attributable to the adapter (intake could not read/resolve part of the source)';
COMMENT ON COLUMN quality_rank_observations.spec_finding_count IS 'Findings attributable to the specification itself';
COMMENT ON COLUMN quality_rank_observations.attribution IS 'Per-class breakdown {"adapter": {class: count}, "spec": {class: count}} of the finding split';
COMMENT ON COLUMN quality_rank_observations.declared_parser_limits IS 'Count of the adapter''s declared parser limits — a declaration, never mixed into finding counts';
COMMENT ON COLUMN quality_rank_observations.readiness IS 'Export readiness composite (0-100) for the ranked target; NULL for imports';
COMMENT ON COLUMN quality_rank_observations.rank IS '1-based position of the target in the export pre-flight ranking; NULL for imports';
COMMENT ON COLUMN quality_rank_observations.band IS 'Export readiness band: ready | caution | blocked | unavailable; NULL for imports';
COMMENT ON COLUMN quality_rank_observations.preserved_percent IS 'Projected preserved-construct percentage for the delivery; NULL when unmeasured';
COMMENT ON COLUMN quality_rank_observations.occurred_at IS 'When the grade was produced (the series timestamp)';
