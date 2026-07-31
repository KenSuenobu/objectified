'use server';

import type { Pool } from 'pg';

// db.ts is CommonJS (module.exports); keep parity with helper-database.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS pool singleton
const connectionPool = require('./db') as Pool;

export type RepositoryImportSourceInput = {
  repositoryId: string;
  branch: string;
  path: string;
  blobSha?: string | null;
};

/** Insert when the repository belongs to the tenant (guarded by subquery). */
export async function recordTenantRepositoryImport(params: {
  tenantId: string;
  repositorySource: RepositoryImportSourceInput;
  projectId: string;
  versionUuid: string;
  importedByUserId: string;
}): Promise<boolean> {
  const { tenantId, repositorySource, projectId, versionUuid, importedByUserId } = params;
  const repoId = repositorySource.repositoryId.trim();
  if (!repoId) return false;

  const res = await connectionPool.query(
    `INSERT INTO apiome.tenant_repository_imports (
       tenant_id, repository_id, branch, path, blob_sha, project_id, version_id, imported_by
     )
     SELECT $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid
     FROM apiome.tenant_repositories tr
     WHERE tr.id = $2::uuid AND tr.tenant_id = $1::uuid AND tr.deleted_at IS NULL
     RETURNING id`,
    [
      tenantId,
      repoId,
      repositorySource.branch,
      repositorySource.path,
      repositorySource.blobSha?.trim() || null,
      projectId,
      versionUuid,
      importedByUserId,
    ]
  );
  return res.rowCount === 1;
}

/**
 * Persist (insert or refresh) the import specification for a repository file so a
 * later auto-refresh can replay the user's original request instead of importer
 * defaults (RAR-1.2). Keyed on the imported-file lineage
 * `(repository_id, branch, path)`: a repeat import of the same file updates the
 * existing row in place rather than inserting a duplicate.
 *
 * The insert is guarded by a subquery so a row is written only when the
 * repository belongs to the given tenant. `options` is the full SpecImportOptions
 * payload and is stored verbatim in `options_json`.
 *
 * Freshness signals (RAR-2.1) — `last_imported_commit_sha`,
 * `last_imported_committed_at`, `last_imported_blob_sha` — are copied from the
 * matching indexed `tenant_repository_files` row via a LEFT JOIN, so the spec
 * records the repository's observed recency for the file at import time. A later
 * auto-refresh compares the repository's current state against these anchors to
 * gate "newer-than" re-imports (RAR-2.2). When no scan row matches the lineage the
 * anchors are stored as NULL and the comparator falls back to checksum-only gating.
 *
 * A genuine capture always writes `backfilled = FALSE`: when the lineage held a
 * spec seeded by the RAR-1.6 historical backfill, the first real import replaces
 * it and clears the flag, keeping "imported before spec capture" truthful.
 *
 * @returns true when a row was written (repository belonged to the tenant), false otherwise.
 */
export async function upsertRepositoryImportSpec(params: {
  tenantId: string;
  repositorySource: RepositoryImportSourceInput;
  projectId: string;
  sourceKind: string;
  options: Record<string, unknown>;
  formatOverride?: string | null;
  contentType?: string | null;
  specSchemaVersion?: number;
  createdByUserId?: string | null;
}): Promise<boolean> {
  const {
    tenantId,
    repositorySource,
    projectId,
    sourceKind,
    options,
    formatOverride,
    contentType,
    specSchemaVersion,
    createdByUserId,
  } = params;
  const repoId = repositorySource.repositoryId.trim();
  if (!repoId) return false;

  const res = await connectionPool.query(
    `INSERT INTO apiome.repository_import_spec (
       tenant_id, repository_id, branch, path, project_id,
       source_kind, format_override, content_type,
       options_json, spec_schema_version, created_by,
       last_imported_commit_sha, last_imported_committed_at, last_imported_blob_sha,
       backfilled
     )
     SELECT $1::uuid, $2::uuid, $3, $4, $5::uuid,
            $6, $7, $8,
            $9::jsonb, $10, $11::uuid,
            trf.commit_sha, trf.committed_at, trf.blob_sha,
            FALSE
     FROM apiome.tenant_repositories tr
     LEFT JOIN apiome.tenant_repository_files trf
       ON trf.repository_id = tr.id AND trf.branch = $3 AND trf.path = $4
     WHERE tr.id = $2::uuid AND tr.tenant_id = $1::uuid AND tr.deleted_at IS NULL
     ON CONFLICT ON CONSTRAINT uq_repository_import_spec_repo_branch_path
     DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       project_id = EXCLUDED.project_id,
       source_kind = EXCLUDED.source_kind,
       format_override = EXCLUDED.format_override,
       content_type = EXCLUDED.content_type,
       options_json = EXCLUDED.options_json,
       spec_schema_version = EXCLUDED.spec_schema_version,
       created_by = EXCLUDED.created_by,
       last_imported_commit_sha = EXCLUDED.last_imported_commit_sha,
       last_imported_committed_at = EXCLUDED.last_imported_committed_at,
       last_imported_blob_sha = EXCLUDED.last_imported_blob_sha,
       backfilled = FALSE,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [
      tenantId,
      repoId,
      repositorySource.branch,
      repositorySource.path,
      projectId,
      sourceKind,
      formatOverride ?? null,
      contentType ?? null,
      JSON.stringify(options ?? {}),
      specSchemaVersion ?? 1,
      createdByUserId ?? null,
    ]
  );
  return res.rowCount === 1;
}

export type TenantRepositoryImportRow = {
  id: string;
  path: string;
  branch: string;
  blob_sha: string | null;
  created_at: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  catalog_version_label: string;
  version_uuid: string;
  imported_by: string | null;
  imported_by_name: string | null;
  imported_by_email: string | null;
};

export async function tenantRepositoryBelongsToTenant(tenantId: string, repositoryId: string): Promise<boolean> {
  const r = await connectionPool.query(
    `SELECT 1 FROM apiome.tenant_repositories tr
     WHERE tr.id = $1::uuid AND tr.tenant_id = $2::uuid AND tr.deleted_at IS NULL
     LIMIT 1`,
    [repositoryId, tenantId]
  );
  return r.rowCount === 1;
}

export async function listTenantRepositoryImports(params: {
  tenantId: string;
  repositoryId: string;
  limit?: number;
}): Promise<TenantRepositoryImportRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
  const result = await connectionPool.query(
    `SELECT tri.id,
            tri.path,
            tri.branch,
            tri.blob_sha,
            tri.created_at::text AS created_at,
            tri.project_id,
            p.name AS project_name,
            p.slug AS project_slug,
            v.version_id AS catalog_version_label,
            v.id AS version_uuid,
            tri.imported_by,
            u.name AS imported_by_name,
            u.email AS imported_by_email
     FROM apiome.tenant_repository_imports tri
     JOIN apiome.projects p ON p.id = tri.project_id AND p.deleted_at IS NULL
     JOIN apiome.versions v ON v.id = tri.version_id AND v.deleted_at IS NULL
     LEFT JOIN apiome.users u ON u.id = tri.imported_by
     WHERE tri.tenant_id = $1::uuid AND tri.repository_id = $2::uuid
     ORDER BY tri.created_at DESC
     LIMIT $3`,
    [params.tenantId, params.repositoryId, limit]
  );
  return result.rows as TenantRepositoryImportRow[];
}

export async function tenantRepositoryImportStats30d(
  tenantId: string,
  repositoryId: string
): Promise<{ totalImports: number; distinctProjects: number }> {
  const result = await connectionPool.query(
    `SELECT COUNT(*)::int AS total_imports,
            COUNT(DISTINCT project_id)::int AS distinct_projects
     FROM apiome.tenant_repository_imports
     WHERE tenant_id = $1::uuid
       AND repository_id = $2::uuid
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [tenantId, repositoryId]
  );
  const row = result.rows[0] as { total_imports: number; distinct_projects: number } | undefined;
  return {
    totalImports: row?.total_imports ?? 0,
    distinctProjects: row?.distinct_projects ?? 0,
  };
}

/**
 * One per-file refresh-status row for the repository detail "Specs" tab (RAR-5.1).
 *
 * Each row is a single imported-file lineage (`repository_import_spec`, keyed
 * `(repository_id, branch, path)`) joined to the signals needed to derive its
 * refresh state on the client (see `repository-refresh-status.ts`):
 *  - the RAR-2.1 import anchors (`last_imported_*`) vs the current scanned remote
 *    recency (`remote_*` from `tenant_repository_files`) — the recency axis;
 *  - the operational flags from the RAR-3.2 refresh-job queue
 *    (`is_refreshing` / `last_refresh_failed`) — the operational axis;
 *  - the per-repo RAR-3.1 cadence (`refresh_interval_seconds`,
 *    `repo_last_refreshed_at`, `auto_refresh_enabled`) used to compute next-due;
 *  - `last_refreshed_at`, the most recent *successful* refresh of this file.
 *
 * The `diverged` axis (RAR-4.4) has no persisted column yet — the divergence
 * guard's hold flag is written by the not-yet-wired dispatcher — so it is not
 * sourced here; the UI defaults it to false and renders the diverged state when a
 * future signal supplies it.
 */
export type TenantRepositoryRefreshSpecRow = {
  id: string;
  path: string;
  branch: string;
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  /** Committed-at anchor captured at import time (RAR-2.1), ISO-8601 or null. */
  last_imported_committed_at: string | null;
  /** Blob SHA anchor captured at import time (RAR-2.1). */
  last_imported_blob_sha: string | null;
  /** Current scanned commit timestamp for the file, ISO-8601 or null. */
  remote_committed_at: string | null;
  /** Current scanned blob SHA for the file. */
  remote_blob_sha: string | null;
  /** True when a refresh job is queued/running for this lineage. */
  is_refreshing: boolean;
  /** True when the most recent finished refresh job for this lineage failed. */
  last_refresh_failed: boolean;
  /** Finished-at of the most recent successful refresh of this file, or null. */
  last_refreshed_at: string | null;
  /** When the stored import spec was last written (fallback "last refreshed"). */
  spec_updated_at: string | null;
  /** True when the spec was seeded by the RAR-1.6 backfill (imported before spec capture). */
  backfilled: boolean;
  /** Per-repo refresh cadence in seconds (RAR-3.1). */
  refresh_interval_seconds: number;
  /** Repository's last sweep tick timestamp (RAR-3.1), ISO-8601 or null. */
  repo_last_refreshed_at: string | null;
  /** Whether auto-refresh is enabled for the repository (RAR-3.3). */
  auto_refresh_enabled: boolean;
};

/**
 * List per-file refresh-status rows for a repository's Specs tab (RAR-5.1).
 *
 * Returns one row per stored import-spec lineage for the repository, enriched
 * with the recency, operational, and cadence signals described on
 * {@link TenantRepositoryRefreshSpecRow}. Scoped to the tenant via the
 * `repository_import_spec.tenant_id` predicate and the `tenant_repositories`
 * join, so specs under another tenant's repository are never returned. Ordered
 * most-recently-updated first and capped (1–200, default 100) like the import
 * history list.
 *
 * @param params.tenantId Owning tenant id (scopes the lookup).
 * @param params.repositoryId Source repository id.
 * @param params.limit Max rows to return (clamped to 1–200).
 * @returns The per-file refresh-status rows.
 */
export async function listTenantRepositoryRefreshSpecs(params: {
  tenantId: string;
  repositoryId: string;
  limit?: number;
}): Promise<TenantRepositoryRefreshSpecRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
  const result = await connectionPool.query(
    `SELECT s.id,
            s.path,
            s.branch,
            s.project_id,
            p.name AS project_name,
            p.slug AS project_slug,
            s.last_imported_committed_at::text AS last_imported_committed_at,
            s.last_imported_blob_sha,
            s.backfilled,
            s.updated_at::text AS spec_updated_at,
            trf.committed_at::text AS remote_committed_at,
            trf.blob_sha AS remote_blob_sha,
            tr.refresh_interval_seconds,
            tr.last_refreshed_at::text AS repo_last_refreshed_at,
            tr.auto_refresh_enabled,
            EXISTS (
              SELECT 1 FROM apiome.tenant_repository_refresh_jobs aj
              WHERE aj.repository_id = s.repository_id
                AND aj.branch = s.branch
                AND aj.path = s.path
                AND aj.status IN ('queued', 'running')
            ) AS is_refreshing,
            COALESCE(lf.failed, FALSE) AS last_refresh_failed,
            ls.last_refreshed_at::text AS last_refreshed_at
     FROM apiome.repository_import_spec s
     JOIN apiome.tenant_repositories tr
       ON tr.id = s.repository_id
      AND tr.tenant_id = s.tenant_id
      AND tr.deleted_at IS NULL
     LEFT JOIN apiome.projects p
       ON p.id = s.project_id AND p.deleted_at IS NULL
     LEFT JOIN apiome.tenant_repository_files trf
       ON trf.repository_id = s.repository_id
      AND trf.branch = s.branch
      AND trf.path = s.path
     LEFT JOIN LATERAL (
       SELECT (j.status = 'failed') AS failed
       FROM apiome.tenant_repository_refresh_jobs j
       WHERE j.repository_id = s.repository_id
         AND j.branch = s.branch
         AND j.path = s.path
         AND j.finished_at IS NOT NULL
       ORDER BY j.finished_at DESC
       LIMIT 1
     ) lf ON TRUE
     LEFT JOIN LATERAL (
       SELECT j.finished_at AS last_refreshed_at
       FROM apiome.tenant_repository_refresh_jobs j
       WHERE j.repository_id = s.repository_id
         AND j.branch = s.branch
         AND j.path = s.path
         AND j.status = 'succeeded'
         AND j.finished_at IS NOT NULL
       ORDER BY j.finished_at DESC
       LIMIT 1
     ) ls ON TRUE
     WHERE s.tenant_id = $1::uuid
       AND s.repository_id = $2::uuid
     ORDER BY s.updated_at DESC
     LIMIT $3`,
    [params.tenantId, params.repositoryId, limit]
  );
  return result.rows as TenantRepositoryRefreshSpecRow[];
}
