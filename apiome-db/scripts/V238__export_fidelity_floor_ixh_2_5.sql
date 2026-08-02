-- Export fidelity floor for the delivery gate — IXH-2.5 (#5100).
--
-- Problem: V205 gave the tenant quality policy three floors (grade, score, severity) evaluated
-- against a *lint* report. The delivery gate (IXH-2.5) has to combine those with a fourth,
-- export-only dimension the lint report cannot express: how much of the source actually survives
-- the conversion. A tenant that will not ship an artifact below, say, 80% preserved constructs
-- had nowhere to say so, and the export gate blocked only on a provably invalid artifact.
--
-- Solution: one additive, nullable column on the existing append-only policy table.
--
--   * ``export_min_fidelity`` — the lowest acceptable projected preserved-construct percentage
--     (0-100) for a delivery. NULL (the default, and the value every existing row takes) means
--     "no fidelity floor", so the shipped behaviour of every tenant is unchanged.
--
-- The floor is export-only by construction: an import has no target and therefore no projected
-- fidelity, so there is deliberately no ``import_min_fidelity`` twin. Per-format overrides need
-- no schema change — they live in the existing ``format_overrides`` JSONB as ``minFidelity``.
--
-- Policy rows are immutable (a write-once trigger guards them), so this is a column add only:
-- existing versions keep their exact recorded content and stay reproducible.
--
-- Rollback notes (reverse carefully in shared environments):
--   ALTER TABLE apiome.import_export_quality_policies DROP COLUMN IF EXISTS export_min_fidelity;

SET search_path TO apiome, public;

ALTER TABLE import_export_quality_policies
    ADD COLUMN IF NOT EXISTS export_min_fidelity INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'import_export_quality_policies_export_fidelity_check'
    ) THEN
        ALTER TABLE import_export_quality_policies
            ADD CONSTRAINT import_export_quality_policies_export_fidelity_check
            CHECK (export_min_fidelity IS NULL
                   OR (export_min_fidelity >= 0 AND export_min_fidelity <= 100));
    END IF;
END
$$;

COMMENT ON COLUMN import_export_quality_policies.export_min_fidelity IS
    'Lowest acceptable projected preserved-construct percentage (0-100) for a delivery; NULL = no fidelity floor (IXH-2.5, #5100)';
