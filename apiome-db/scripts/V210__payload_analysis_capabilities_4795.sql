-- Analyzer capability data on a payload analysis — CPDO-1.2 (#4795).
--
-- Problem: V209 records what an analyzer *observed* (the tree), what it *could not do here* (the
-- warnings), and *who* it was (analyzer_key/version/tool_versions). It records nothing about what
-- that analyzer can describe in principle — so a construct missing from the tree is ambiguous. A
-- reader looking for an X12 functional group and not finding one cannot tell whether the source had
-- none or the analyzer has no word for one, and that is precisely the question the format-detail
-- surfaces (CPDO-2.1 – 2.4) have to answer.
--
-- Solution: one additive JSONB column, ``capabilities`` — the analyzer's own declaration, written
-- with the record it belongs to:
--
--   {
--     "supported":   ["x12.functional_group", "x12.transaction_set", ...],
--     "unsupported": ["x12.empty_elements", "x12.hl_hierarchy", ...],
--     "limits":      {"maxNodes": 5000, "maxDepth": 32, "valuePreviewChars": 120}
--   }
--
-- It is *per record*, not per format, on purpose. Analyses are immutable and long-lived, so the only
-- statement that stays true about a two-year-old record is the one its own analyzer made at the time.
-- A cross-format registry answering the same question ahead of an import is CPDO-2.4's job; this is
-- what makes each stored record self-describing.
--
-- Backwards compatible by construction. Existing V209 rows default to '{}'::jsonb, which
-- ``app.payload_analysis.document_from_row`` reads as empty capabilities — the truthful statement
-- that the analyzer that wrote them declared none (there were no analyzers when V209 shipped). The
-- app contract version moves 1.0.0 -> 1.1.0 to match, a minor bump because nothing already stored
-- becomes unreadable.
--
-- Note on immutability: ``payload_analysis`` rows are write-once (trigger
-- ``trigger_payload_analysis_immutable``, V209). ADD COLUMN is DDL, not a row UPDATE, so it does not
-- trip that trigger and existing rows keep their original content.
--
-- Rollback notes (reverse carefully in shared environments):
--   ALTER TABLE apiome.payload_analysis DROP CONSTRAINT IF EXISTS payload_analysis_capabilities_object_check;
--   ALTER TABLE apiome.payload_analysis DROP COLUMN IF EXISTS capabilities;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- capabilities — what the analyzer that wrote this record models, and what it knowingly does not.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE payload_analysis
    ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Same shape guard the other contract containers carry: a JSONB object cannot degrade into a scalar
-- in storage, so a reader never has to defend against `capabilities` being the string "none".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payload_analysis_capabilities_object_check'
          AND conrelid = 'apiome.payload_analysis'::regclass
    ) THEN
        ALTER TABLE apiome.payload_analysis
            ADD CONSTRAINT payload_analysis_capabilities_object_check
                CHECK (jsonb_typeof(capabilities) = 'object');
    END IF;
END
$$;

COMMENT ON COLUMN payload_analysis.capabilities IS
    'Analyzer capability declaration: {supported[], unsupported[], limits{}} — what this analyzer models and knowingly does not, so a construct missing from the tree is explainable rather than ambiguous (CPDO-1.2, #4795)';
