-- Projection manifest snapshot on a conversion-provenance row — CPDO-1.3 (#4800).
--
-- Problem: V139 records *how good* a conversion was — the fidelity report, its score/grade/tier,
-- the lint score, the converter tool versions. It records nothing about *what became what*. Two
-- conversions of the same catalog item can carry an identical `fidelity_score` and still differ in
-- which operations were dropped and which pointers were synthesized, and nothing stored today can
-- tell them apart. That is precisely the comparison a conversion-history view (CPDO-3.3) has to
-- make, and precisely the question the projection manifest answers.
--
-- Solution: two additive columns carrying the *bounded summary* of the manifest a conversion was
-- committed under — never the full node/edge graph.
--
--   projection_manifest_hash  the content-addressed snapshot id, hoisted into its own column so
--                             "did anything about this conversion change?" is one indexed equality
--                             test rather than a JSONB comparison. Two rows with the same hash
--                             projected identically: same statuses, same reasons, same pointers,
--                             same converter versions, same gap-filling defaults.
--
--   projection_manifest       the `ConversionManifestSummary` (app.conversion_projection): the
--                             schema version, source/target coordinates, tool versions, normalized
--                             defaults, and the per-status / per-reason / per-scope tallies.
--
-- Why the summary and not the graph. A manifest's graph is bounded at 2000 construct edges by the
-- application, which is small enough to build on demand and much too large to want on every row of
-- a history listing. The graph is deterministic in the source bytes and the defaults — both of
-- which this row already names — so it is *reproducible* rather than needing storage, while the
-- hash makes an old row's graph verifiable against a rebuild: if a rebuild hashes differently, the
-- converter changed, and that is a fact worth surfacing rather than hiding.
--
-- Backwards compatible by construction. Existing V139 rows default to `''` / `'{}'::jsonb`, which
-- the application reads as "committed before manifests existed" — the truthful statement about
-- them. Nothing already stored becomes unreadable, and no existing read path changes shape.
--
-- Note on immutability: `conversion_provenance` rows are append-only (trigger
-- `trigger_conversion_provenance_immutable`, V139). ADD COLUMN is DDL, not a row UPDATE, so it does
-- not trip that trigger and existing rows keep their original content.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP INDEX IF EXISTS apiome.idx_conversion_provenance_manifest_hash;
--   ALTER TABLE apiome.conversion_provenance DROP CONSTRAINT IF EXISTS conversion_provenance_projection_manifest_object_check;
--   ALTER TABLE apiome.conversion_provenance DROP COLUMN IF EXISTS projection_manifest;
--   ALTER TABLE apiome.conversion_provenance DROP COLUMN IF EXISTS projection_manifest_hash;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- projection_manifest_hash — the content-addressed snapshot id of the manifest this row was
-- committed under. Empty string on rows written before CPDO-1.3, which is distinguishable from any
-- real hash (always 64 hex characters) without needing a nullable column.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversion_provenance
    ADD COLUMN IF NOT EXISTS projection_manifest_hash TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------------------------------
-- projection_manifest — the bounded ConversionManifestSummary for that snapshot.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversion_provenance
    ADD COLUMN IF NOT EXISTS projection_manifest JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Same shape guard the other contract containers on this table carry: a JSONB object cannot degrade
-- into a scalar in storage, so a reader never has to defend against `projection_manifest` being the
-- string "none".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversion_provenance_projection_manifest_object_check'
          AND conrelid = 'apiome.conversion_provenance'::regclass
    ) THEN
        ALTER TABLE apiome.conversion_provenance
            ADD CONSTRAINT conversion_provenance_projection_manifest_object_check
                CHECK (jsonb_typeof(projection_manifest) = 'object');
    END IF;
END
$$;

-- "Which conversions of this tenant share a projection snapshot?" — the lookup a re-convert
-- comparison and a provenance history (CPDO-3.3) make. Partial, because the pre-CPDO-1.3 rows all
-- carry the same empty hash and indexing them together would be one large useless bucket.
CREATE INDEX IF NOT EXISTS idx_conversion_provenance_manifest_hash
  ON apiome.conversion_provenance(tenant_id, projection_manifest_hash)
  WHERE projection_manifest_hash <> '';

COMMENT ON COLUMN conversion_provenance.projection_manifest_hash IS
    'Content-addressed id of the conversion projection manifest this row was committed under; empty on rows written before CPDO-1.3 (#4800). Equal hashes mean identical projections.';

COMMENT ON COLUMN conversion_provenance.projection_manifest IS
    'Bounded ConversionManifestSummary for the snapshot: schema version, source/target coordinates, converter tool versions, normalized defaults, and per-status/reason/scope tallies. The node/edge graph is reproducible from the source revision and is not stored (CPDO-1.3, #4800).';
