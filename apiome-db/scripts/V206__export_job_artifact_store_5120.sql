-- Shared export artifact store (IXH-6.1, #5120).
--
-- V158 moved export *status* to apiome.async_job so any instance can answer polls, but the
-- download path still read emitted bytes from the owning process's in-memory _jobs map.
-- Under round-robin, GET …/jobs/{id}/download on a non-owner 404'd even when status (and
-- download_path) were visible.
--
-- This table holds the delivery payload (single-file UTF-8 bytes or multi-file zip) keyed by
-- job, scoped by tenant, with a content hash and retention deadline. Small artifacts live in
-- BYTEA (backend = 'db'); larger ones are intended for an object-store backend
-- (storage_uri + backend = 'object_store') behind the same driver interface. IXH-6.3 sweeps
-- expired rows via expires_at / reaped_at; reads already return 410 when the window has elapsed.
SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS apiome.export_job_artifact (
    job_id            text PRIMARY KEY
                          REFERENCES apiome.async_job(job_id) ON DELETE CASCADE,
    tenant_slug       text NOT NULL,
    content_sha256    text NOT NULL
                          CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    size_bytes        bigint NOT NULL CHECK (size_bytes >= 0),
    media_type        text NOT NULL,
    filename          text NOT NULL,
    backend           text NOT NULL DEFAULT 'db'
                          CHECK (backend IN ('db', 'object_store')),
    -- Delivery bytes for the DB backend. NULL when object_store, or after retention reaped the
    -- payload (row may remain until IXH-6.3 deletes the job + cascade).
    content           bytea,
    storage_uri       text,
    expires_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    reaped_at         timestamptz,
    CONSTRAINT export_job_artifact_db_has_content CHECK (
        backend <> 'db' OR content IS NOT NULL OR reaped_at IS NOT NULL
    ),
    CONSTRAINT export_job_artifact_object_has_uri CHECK (
        backend <> 'object_store' OR storage_uri IS NOT NULL OR reaped_at IS NOT NULL
    )
);

COMMENT ON TABLE apiome.export_job_artifact IS
    'Shared export download payload (IXH-6.1, #5120). Any instance serves GET …/download from here; the owning process may keep an in-memory EmitResult as a fast path only.';
COMMENT ON COLUMN apiome.export_job_artifact.job_id IS
    'Export async_job id; cascades when IXH-6.3 deletes the job row.';
COMMENT ON COLUMN apiome.export_job_artifact.tenant_slug IS
    'Owning tenant slug; every read must match this (cross-tenant → not found).';
COMMENT ON COLUMN apiome.export_job_artifact.content_sha256 IS
    'sha256:<hex> over the exact download body bytes; exposed on the download response for integrity.';
COMMENT ON COLUMN apiome.export_job_artifact.size_bytes IS
    'Length of the delivery payload in bytes (enforced against the emit-time size cap).';
COMMENT ON COLUMN apiome.export_job_artifact.backend IS
    'Storage driver that holds the bytes: db (BYTEA) or object_store (storage_uri).';
COMMENT ON COLUMN apiome.export_job_artifact.content IS
    'Delivery bytes when backend = db; cleared when reaped.';
COMMENT ON COLUMN apiome.export_job_artifact.storage_uri IS
    'Object-store locator when backend = object_store; NULL for DB backend.';
COMMENT ON COLUMN apiome.export_job_artifact.expires_at IS
    'Retention deadline (MFX-4.3 / IXH-6.1). Past this, downloads are 410; IXH-6.3 sweeps rows.';
COMMENT ON COLUMN apiome.export_job_artifact.reaped_at IS
    'When content/storage_uri were cleared by retention; NULL while the artifact is still downloadable.';

-- IXH-6.3 retention sweep: find unreaped artifacts whose window has elapsed.
CREATE INDEX IF NOT EXISTS export_job_artifact_expires_at_idx
    ON apiome.export_job_artifact (expires_at)
    WHERE reaped_at IS NULL;

CREATE INDEX IF NOT EXISTS export_job_artifact_tenant_idx
    ON apiome.export_job_artifact (tenant_slug, created_at DESC);
