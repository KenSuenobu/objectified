-- Conversion evidence snapshots + per-conversion source digest — CPDO-3.3 (#4803).
--
-- Problem: V214 stores the *bounded summary* of the projection manifest a conversion was committed
-- under, on the reasoning that the full node/edge graph is reproducible from the source bytes and
-- the defaults. That reasoning holds only while the source bytes and the converter stay put. The
-- moment either changes, the graph the user actually reviewed and approved becomes unreproducible —
-- a rebuild describes the *new* conversion, not the approved one. A conversion-history view has to
-- show the exact approved evidence forever, so the graph itself must be persisted.
--
-- Solution: a content-addressed snapshot table, keyed (tenant_id, manifest_hash), holding the full
-- ConversionManifest (app.conversion_projection) exactly once per distinct graph.
--
--   Content addressing is the dedupe: the manifest hash is computed over {schema_version, source
--   and target format, conversion mode, tool versions, defaults, nodes, edges}, so re-converting an
--   unchanged source under unchanged defaults and tools produces the same hash and reuses the same
--   snapshot row. Each re-conversion still gets its own conversion_provenance row (linked to its
--   own target revision); the provenance row's V214 projection_manifest_hash is the join key. No
--   foreign key on purpose — rows written before this migration have no snapshot, and "snapshot
--   missing" is a first-class state the application reports truthfully, not a broken reference.
--
--   The stored manifest carries no raw source bytes (excluded by construction in the application)
--   and its source.project_id / source.version_record_id are nulled before storage: both ids are
--   excluded from the hash, so under dedupe they would otherwise record whichever catalog item
--   happened to write first. Readers take real coordinates from the provenance row.
--
--   conversion_provenance.source_hash records the sha256 digest of the exact source text each
--   conversion was run against. It lives on the ledger row, not the snapshot, because two
--   byte-different sources (a whitespace-only edit) can project to an identical graph and hence one
--   snapshot — a per-snapshot digest would silently record only the first writer's bytes. Comparing
--   a row's source_hash against the digest of the item's current source is how a reader tells
--   "historic evidence" from "the source has changed since".
--
-- Immutability and retention: snapshot rows are write-once — a BEFORE UPDATE trigger reuses the
-- shared V128 guard apiome.mcp_forbid_row_mutation(). DELETE is deliberately left open, for the
-- tenant FK cascade and for the purge below. A snapshot referenced by any conversion_provenance row
-- is effectively permanent: the ledger is append-only (V139 trigger), projects are only ever
-- soft-deleted, and only a tenant hard-delete removes provenance rows — which cascades this table
-- too. purge_conversion_evidence_snapshots() therefore only ever matches crash orphans: a snapshot
-- written by the commit path whose provenance insert then failed.
--
-- Backwards compatible by construction: pre-existing provenance rows keep source_hash = '' ("recorded
-- before CPDO-3.3") and have no snapshot row; both read as truthful degrade states.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP FUNCTION IF EXISTS apiome.purge_conversion_evidence_snapshots(INTEGER);
--   ALTER TABLE apiome.conversion_provenance DROP CONSTRAINT IF EXISTS conversion_provenance_source_hash_shape_check;
--   ALTER TABLE apiome.conversion_provenance DROP COLUMN IF EXISTS source_hash;
--   DROP TRIGGER IF EXISTS trigger_conversion_evidence_snapshot_immutable ON apiome.conversion_evidence_snapshot;
--   DROP INDEX IF EXISTS apiome.idx_conversion_evidence_snapshot_created_at;
--   DROP TABLE IF EXISTS apiome.conversion_evidence_snapshot;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- conversion_evidence_snapshot — one row per distinct committed projection graph, content-addressed
-- by the manifest hash. Everything on the row is a pure function of the hash.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_evidence_snapshot (
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    manifest_hash   TEXT NOT NULL,
    schema_version  TEXT NOT NULL,
    conversion_mode TEXT NOT NULL,
    source_format   VARCHAR(128),
    target_format   VARCHAR(128) NOT NULL,
    tool_versions   JSONB NOT NULL DEFAULT '{}'::jsonb,
    defaults        JSONB NOT NULL DEFAULT '{}'::jsonb,
    manifest        JSONB NOT NULL,
    node_count      INTEGER NOT NULL DEFAULT 0,
    edge_count      INTEGER NOT NULL DEFAULT 0,
    truncated       BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, manifest_hash),
    -- The manifest hash is the bare 64-hex sha256 the application computes over the canonical
    -- manifest JSON (app.conversion_projection._compute_manifest_hash) — no 'sha256:' prefix, unlike
    -- source_hash below, which follows the V209 payload-analysis shape. Keep the two distinct.
    CONSTRAINT conversion_evidence_snapshot_hash_shape_check
        CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT conversion_evidence_snapshot_manifest_object_check
        CHECK (jsonb_typeof(manifest) = 'object'),
    CONSTRAINT conversion_evidence_snapshot_tool_versions_object_check
        CHECK (jsonb_typeof(tool_versions) = 'object'),
    CONSTRAINT conversion_evidence_snapshot_defaults_object_check
        CHECK (jsonb_typeof(defaults) = 'object'),
    CONSTRAINT conversion_evidence_snapshot_counts_check
        CHECK (node_count >= 0 AND edge_count >= 0)
);

-- Write-once: UPDATE is rejected by the shared V128 guard. DELETE stays open — the tenant FK cascade
-- and the orphan purge below are the only deleters, and both are legitimate.
DROP TRIGGER IF EXISTS trigger_conversion_evidence_snapshot_immutable ON conversion_evidence_snapshot;
CREATE TRIGGER trigger_conversion_evidence_snapshot_immutable
    BEFORE UPDATE ON conversion_evidence_snapshot
    FOR EACH ROW EXECUTE FUNCTION mcp_forbid_row_mutation();

-- The purge scans by age; the primary key already serves every content-addressed lookup.
CREATE INDEX IF NOT EXISTS idx_conversion_evidence_snapshot_created_at
    ON apiome.conversion_evidence_snapshot(created_at);

-- ---------------------------------------------------------------------------------------------------
-- conversion_provenance.source_hash — digest of the exact source text this conversion ran against.
-- Empty string on rows written before CPDO-3.3, distinguishable from any real digest.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversion_provenance
    ADD COLUMN IF NOT EXISTS source_hash TEXT NOT NULL DEFAULT '';

-- Same conditional-constraint dance as V214: ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversion_provenance_source_hash_shape_check'
          AND conrelid = 'apiome.conversion_provenance'::regclass
    ) THEN
        ALTER TABLE apiome.conversion_provenance
            ADD CONSTRAINT conversion_provenance_source_hash_shape_check
                CHECK (source_hash = '' OR source_hash ~ '^sha256:[0-9a-f]{64}$');
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- Retention. Referenced snapshots are permanent (see header); this removes only aged snapshots no
-- provenance row names — which, because the ledger is append-only, can only be crash orphans left by
-- a commit whose provenance insert failed after the snapshot write. Normally purges nothing.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_conversion_evidence_snapshots(p_retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    v_purged INTEGER;
    v_cutoff TIMESTAMPTZ := CURRENT_TIMESTAMP - (GREATEST(p_retention_days, 0) * INTERVAL '1 day');
BEGIN
    DELETE FROM apiome.conversion_evidence_snapshot s
    WHERE s.created_at < v_cutoff
      AND NOT EXISTS (
            SELECT 1
            FROM apiome.conversion_provenance cp
            WHERE cp.tenant_id = s.tenant_id
              AND cp.projection_manifest_hash = s.manifest_hash
      );
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    RETURN v_purged;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE conversion_evidence_snapshot IS
    'Content-addressed, write-once store of full conversion projection manifests (CPDO-3.3, #4803): one row per distinct committed graph, shared by every conversion_provenance row naming its hash. Raw source bytes are never stored; source ids are nulled before storage.';

COMMENT ON COLUMN conversion_evidence_snapshot.tenant_id IS
    'Owning tenant; hard tenant deletion cascades snapshots along with the provenance ledger.';

COMMENT ON COLUMN conversion_evidence_snapshot.manifest_hash IS
    'Bare 64-hex sha256 of the canonical manifest JSON — the content address. Matches conversion_provenance.projection_manifest_hash (V214); no FK so a missing snapshot stays a reportable state rather than a broken reference.';

COMMENT ON COLUMN conversion_evidence_snapshot.schema_version IS
    'CONVERSION_MANIFEST_SCHEMA_VERSION the manifest was built under — the graph contract version a reader must understand to replay this snapshot.';

COMMENT ON COLUMN conversion_evidence_snapshot.conversion_mode IS
    'How the conversion produced its document: passthrough, typespec_native, or lossy (MFI-22.7).';

COMMENT ON COLUMN conversion_evidence_snapshot.source_format IS
    'Source format of the conversion (e.g. graphql); folded into the hash.';

COMMENT ON COLUMN conversion_evidence_snapshot.target_format IS
    'Conversion target format (only openapi today); folded into the hash.';

COMMENT ON COLUMN conversion_evidence_snapshot.tool_versions IS
    'Converter tool versions the manifest was built with; folded into the hash, hoisted for display without parsing the manifest.';

COMMENT ON COLUMN conversion_evidence_snapshot.defaults IS
    'Normalized gap-filling defaults applied to the conversion; folded into the hash, hoisted for display.';

COMMENT ON COLUMN conversion_evidence_snapshot.manifest IS
    'The full ConversionManifest (app.conversion_projection): nodes, edges, evidence references, statuses, reasons, remediations. source.project_id and source.version_record_id are nulled (hash-excluded; per-conversion coordinates live on the provenance row). Contains no raw source bytes.';

COMMENT ON COLUMN conversion_evidence_snapshot.node_count IS
    'len(manifest.nodes), hoisted so history listings can size a snapshot without loading it.';

COMMENT ON COLUMN conversion_evidence_snapshot.edge_count IS
    'len(manifest.edges), hoisted so history listings can size a snapshot without loading it.';

COMMENT ON COLUMN conversion_evidence_snapshot.truncated IS
    'True when the application clamped the graph at its edge budget while building the manifest; a replayed view must state the truncation.';

COMMENT ON COLUMN conversion_evidence_snapshot.created_by IS
    'User whose conversion first stored this snapshot; later deduped conversions do not overwrite it (write-once).';

COMMENT ON COLUMN conversion_evidence_snapshot.created_at IS
    'When this snapshot was first stored; the orphan purge scans this.';

COMMENT ON COLUMN conversion_provenance.source_hash IS
    'sha256:<64hex> digest of the exact source text this conversion ran against (V209 shape); empty on rows written before CPDO-3.3 (#4803). Differing from the item''s current source digest marks the row''s evidence as historic.';

COMMENT ON FUNCTION purge_conversion_evidence_snapshots(INTEGER) IS
    'Deletes conversion evidence snapshots older than p_retention_days that no conversion_provenance row references. Because the ledger is append-only, only crash orphans (snapshot written, provenance insert failed) ever match; referenced snapshots are permanent until tenant deletion cascades them.';
