'use server';

import { unstable_noStore as noStore } from 'next/cache';
import connectionPool from './db';
import { mcpSortOrderSql, type McpSortMode } from '../mcpSort';
import type {
  McpPublicEndpoint,
  McpPublicHostGroup,
  McpPublicCollection,
  McpPublicCatalogBucket,
  McpPublicCatalogInsight,
  McpCapabilityItem,
  McpPublicEndpointDetail,
  McpPublicSearchHit,
} from '../types';
import type {
  ChangelogPayload,
  ChangelogStatus,
  PublicVersionChangelogRow,
  Severity,
} from '../changelog/types';

interface PgError {
  message?: string;
  code?: string;
}

function logError(scope: string, err: unknown) {
  const e = err as PgError;
  console.error(`[db] ${scope}:`, e?.message ?? err);
}

/**
 * Protocol / source-format roll-up for the browse facets (MFI-6.1).
 *
 * Both columns live on `apiome.versions` (MFI-7.1) and are recorded by the import adapters, so an
 * entry's facet values are the distinct values across the published public versions it owns. They
 * are lower-cased and blank-folded here so a chip, a stored row, and a filter all compare in one
 * form — the same normalization `app/browse_facets.py` applies on the API side. Versions imported
 * before the columns existed carry NULL and simply contribute no chip.
 */
const FACET_ROLLUP_SQL = `COALESCE(
           array_agg(DISTINCT NULLIF(LOWER(TRIM(COALESCE(v.protocol, ''))), ''))
             FILTER (WHERE NULLIF(TRIM(COALESCE(v.protocol, '')), '') IS NOT NULL),
           ARRAY[]::text[]
         ) AS protocols,
         COALESCE(
           array_agg(DISTINCT NULLIF(LOWER(TRIM(COALESCE(v.source_format, ''))), ''))
             FILTER (WHERE NULLIF(TRIM(COALESCE(v.source_format, '')), '') IS NOT NULL),
           ARRAY[]::text[]
         ) AS formats`;

/**
 * Get all tenants that have at least one published public version.
 *
 * Each row also carries the distinct protocols/formats the organization publishes, so the
 * directory can be filtered by facet without a second round trip.
 */
export async function getPublicTenants() {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT t.id, t.name, t.slug, t.description, t.created_at,
              ${FACET_ROLLUP_SQL}
       FROM apiome.tenants t
       JOIN apiome.projects p ON t.id = p.tenant_id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       GROUP BY t.id, t.name, t.slug, t.description, t.created_at
       ORDER BY t.name ASC`
    );
    return result.rows;
  } catch (err) {
    logError('getPublicTenants', err);
    return [];
  }
}

/**
 * Get all projects for a tenant that have at least one published public version.
 *
 * Each row also carries the distinct protocols/formats across its published public versions, which
 * is what the tenant page's protocol/format facets count and filter on (MFI-6.1).
 */
export async function getPublicProjectsForTenant(tenantSlug: string) {
  try {
    const result = await connectionPool.query(
      `SELECT p.id, p.name, p.slug, p.description, p.created_at,
              ${FACET_ROLLUP_SQL}
       FROM apiome.projects p
       JOIN apiome.tenants t ON p.tenant_id = t.id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE t.slug = $1
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       GROUP BY p.id, p.name, p.slug, p.description, p.created_at
       ORDER BY p.name ASC`,
      [tenantSlug]
    );
    return result.rows;
  } catch (err) {
    logError('getPublicProjectsForTenant', err);
    return [];
  }
}

/**
 * Get all published public versions for a project.
 */
export async function getPublicVersionsForProject(tenantSlug: string, projectSlug: string) {
  try {
    const result = await connectionPool.query(
      `SELECT v.id, v.version_id, v.description, v.change_log, v.published, v.visibility,
              v.created_at, v.updated_at, v.published_at
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY v.created_at DESC`,
      [tenantSlug, projectSlug]
    );
    return result.rows;
  } catch (err) {
    logError('getPublicVersionsForProject', err);
    return [];
  }
}

/**
 * Get version details by tenant, project, and version slugs.
 */
export async function getPublicVersionDetails(
  tenantSlug: string,
  projectSlug: string,
  versionSlug: string
) {
  try {
    const result = await connectionPool.query(
      `SELECT v.id, v.version_id, v.description, v.change_log, v.published, v.visibility,
              v.created_at, v.updated_at, v.published_at, v.mock_enabled,
              p.name as project_name, p.slug as project_slug, p.description as project_description,
              t.name as tenant_name, t.slug as tenant_slug, t.description as tenant_description
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.version_id = $3
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL`,
      [tenantSlug, projectSlug, versionSlug]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    logError('getPublicVersionDetails', err);
    return null;
  }
}

/**
 * Columns shared by the two changelog reads (CTG-3.2, #4476): the version's identity plus its
 * (optional) classification row and baseline label. The private `error` column is deliberately
 * never selected — a failed row surfaces publicly only as `status = 'failed'`.
 */
const VERSION_CHANGELOG_SELECT = `
       SELECT v.id AS published_revision_id, v.version_id AS version_label, v.published_at,
              bl.version_id AS baseline_version_label,
              vc.max_severity, vc.status, vc.changelog_json
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       LEFT JOIN apiome.version_changelogs vc ON vc.published_revision_id = v.id
       LEFT JOIN apiome.versions bl ON bl.id = vc.baseline_revision_id`;

/** Map one snake_case changelog query row to the camelCase public shape. */
function mapChangelogRow(row: {
  published_revision_id: string;
  version_label: string;
  published_at: string | Date | null;
  baseline_version_label: string | null;
  max_severity: string | null;
  status: string | null;
  changelog_json: unknown;
}): PublicVersionChangelogRow {
  return {
    publishedRevisionId: row.published_revision_id,
    versionLabel: row.version_label,
    publishedAt: row.published_at,
    baselineVersionLabel: row.baseline_version_label,
    maxSeverity: (row.max_severity as Severity | null) ?? null,
    status: (row.status as ChangelogStatus | null) ?? null,
    changelog: (row.changelog_json as ChangelogPayload | null) ?? null,
  };
}

/**
 * The stored publish changelog for one published public version (CTG-3.2, #4476).
 *
 * Returns null when the version itself is not publicly visible (same gates as
 * `getPublicVersionDetails`); a visible version with no classification row yet returns a row with
 * null `status`/`changelog` so the caller can render a "pending" state.
 */
export async function getPublicVersionChangelog(
  tenantSlug: string,
  projectSlug: string,
  versionSlug: string
): Promise<PublicVersionChangelogRow | null> {
  noStore();
  try {
    const result = await connectionPool.query(
      `${VERSION_CHANGELOG_SELECT}
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.version_id = $3
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL`,
      [tenantSlug, projectSlug, versionSlug]
    );
    return result.rows.length > 0 ? mapChangelogRow(result.rows[0]) : null;
  } catch (err) {
    logError('getPublicVersionChangelog', err);
    return null;
  }
}

/**
 * Stored publish changelogs for every published public version of a project, newest
 * `published_at` first (one row per version via LEFT JOIN, so versions without a classification
 * row still appear as "pending"). Powers the changelog feeds, the project timeline severity
 * pills, and the compare page's severity chips (CTG-3.2, #4476).
 */
export async function getPublicChangelogsForProject(
  tenantSlug: string,
  projectSlug: string,
  limit = 50
): Promise<PublicVersionChangelogRow[]> {
  noStore();
  try {
    const result = await connectionPool.query(
      `${VERSION_CHANGELOG_SELECT}
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
       LIMIT $3`,
      [tenantSlug, projectSlug, limit]
    );
    return result.rows.map(mapChangelogRow);
  } catch (err) {
    logError('getPublicChangelogsForProject', err);
    return [];
  }
}

/**
 * Get the declared OpenAPI `servers[]` rows for a published public version (SIM-3.2, #4448).
 *
 * Powers the Try It relay's server-side host allow-policy: only origins declared by the
 * version's own spec may be targeted with `target.kind === 'spec'`. Returns an empty list when
 * the version is unknown, not public, or the query fails — the relay then refuses (fail closed).
 */
export async function getPublicVersionServers(
  tenantSlug: string,
  projectSlug: string,
  versionSlug: string
): Promise<{ url: string; variables: unknown }[]> {
  try {
    const result = await connectionPool.query(
      `SELECT vs.url, vs.variables
       FROM apiome.version_server vs
       JOIN apiome.versions v ON vs.version_id = v.id
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.version_id = $3
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY vs.sort_order, vs.url`,
      [tenantSlug, projectSlug, versionSlug]
    );
    return result.rows as { url: string; variables: unknown }[];
  } catch (err) {
    logError('getPublicVersionServers', err);
    return [];
  }
}

export type PublishedCatalogSearchHit = {
  hit_id: string;
  hit_type: string;
  tenant_slug: string;
  tenant_name: string;
  project_slug: string;
  project_name: string;
  version_slug: string;
  published_at: string | null;
  title: string;
  snippet: string;
  subtitle: string | null;
};

function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Full plain-text search across published **public** versions only: organizations, projects,
 * version notes, OpenAPI paths/operations, schemas, parameters, and request/response documentation.
 * Private or unpublished versions never appear.
 */
export async function searchPublishedPublicCatalog(query: string): Promise<PublishedCatalogSearchHit[]> {
  noStore();
  const q = query.trim();
  if (!q) return [];

  const pattern = `%${escapeLikePattern(q)}%`;

  try {
    const result = await connectionPool.query(
      `SELECT * FROM (
        (
          SELECT DISTINCT ON (p.id)
            ('project:' || p.id::text) AS hit_id,
            'project' AS hit_type,
            t.slug AS tenant_slug,
            t.name AS tenant_name,
            p.slug AS project_slug,
            p.name AS project_name,
            v.version_id AS version_slug,
            v.published_at::text AS published_at,
            p.name AS title,
            LEFT(COALESCE(NULLIF(TRIM(p.description), ''), 'Project in ' || t.name), 400) AS snippet,
            ('Organization · ' || t.slug) AS subtitle
          FROM apiome.tenants t
          JOIN apiome.projects p ON p.tenant_id = t.id
          JOIN apiome.versions v ON v.project_id = p.id
          WHERE v.published = true
            AND v.visibility = 'public'
            AND t.deleted_at IS NULL
            AND p.deleted_at IS NULL
            AND v.deleted_at IS NULL
            AND (
              t.name ILIKE $1 ESCAPE '\\'
              OR t.slug ILIKE $1 ESCAPE '\\'
              OR p.name ILIKE $1 ESCAPE '\\'
              OR p.slug ILIKE $1 ESCAPE '\\'
              OR COALESCE(p.description, '') ILIKE $1 ESCAPE '\\'
            )
          ORDER BY p.id, v.published_at DESC NULLS LAST, v.created_at DESC
        )

        UNION ALL

        SELECT
          ('version:' || v.id::text) AS hit_id,
          'version' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Version notes · v' || v.version_id) AS title,
          LEFT(COALESCE(NULLIF(TRIM(v.description), ''), NULLIF(TRIM(v.change_log), ''), ''), 400) AS snippet,
          ('Published specification') AS subtitle
        FROM apiome.versions v
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            COALESCE(v.description, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(v.change_log, '') ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('path:' || po.id::text) AS hit_id,
          'path' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          COALESCE(NULLIF(TRIM(pod.summary), ''), po.operation || ' ' || vp.pathname) AS title,
          LEFT(COALESCE(NULLIF(TRIM(pod.description), ''), po.operation || ' ' || vp.pathname), 400) AS snippet,
          (LOWER(po.operation) || ' · path') AS subtitle
        FROM apiome.path_operation po
        JOIN apiome.version_path vp ON po.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        LEFT JOIN apiome.path_operation_description pod ON pod.path_operation_id = po.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            vp.pathname ILIKE $1 ESCAPE '\\'
            OR po.operation ILIKE $1 ESCAPE '\\'
            OR COALESCE(pod.summary, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(pod.description, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(pod.operation_id, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(pod.metadata::text, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(po.metadata::text, '') ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('class:' || c.id::text) AS hit_id,
          'schema' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Schema · ' || c.name) AS title,
          LEFT(COALESCE(NULLIF(TRIM(c.description), ''), c.schema::text), 400) AS snippet,
          ('components.schemas') AS subtitle
        FROM apiome.classes c
        JOIN apiome.versions v ON c.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND c.deleted_at IS NULL
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            c.name ILIKE $1 ESCAPE '\\'
            OR COALESCE(c.description, '') ILIKE $1 ESCAPE '\\'
            OR c.schema::text ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('prop:' || cp.id::text) AS hit_id,
          'property' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Property · ' || c.name || '.' || cp.name) AS title,
          LEFT(COALESCE(NULLIF(TRIM(cp.description), ''), cp.data::text), 400) AS snippet,
          ('model property') AS subtitle
        FROM apiome.class_properties cp
        JOIN apiome.classes c ON cp.class_id = c.id
        JOIN apiome.versions v ON c.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND c.deleted_at IS NULL
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            cp.name ILIKE $1 ESCAPE '\\'
            OR COALESCE(cp.description, '') ILIKE $1 ESCAPE '\\'
            OR cp.data::text ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('sparam:' || spp.id::text) AS hit_id,
          'parameter' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Parameter · ' || spp.in_location || ' · ' || spp.name) AS title,
          LEFT(COALESCE(NULLIF(TRIM(spp.summary), ''), NULLIF(TRIM(spp.description), ''), spp.data::text), 400) AS snippet,
          ('operation parameter') AS subtitle
        FROM apiome.shared_path_parameter spp
        JOIN apiome.version_path vp ON spp.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            spp.name ILIKE $1 ESCAPE '\\'
            OR COALESCE(spp.summary, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(spp.description, '') ILIKE $1 ESCAPE '\\'
            OR spp.data::text ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('body:' || sprb.id::text) AS hit_id,
          'request_body' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Request body · ' || sprb.name) AS title,
          LEFT(COALESCE(NULLIF(TRIM(sprb.description), ''), ''), 400) AS snippet,
          ('requestBody') AS subtitle
        FROM apiome.shared_path_request_body sprb
        JOIN apiome.version_path vp ON sprb.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            sprb.name ILIKE $1 ESCAPE '\\'
            OR COALESCE(sprb.description, '') ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('bodyc:' || sprbc.id::text) AS hit_id,
          'request_body' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Request body schema · ' || sprbc.media_type) AS title,
          LEFT(COALESCE(sprbc.inline_schema::text, sprbc.examples::text, ''), 400) AS snippet,
          ('inline schema') AS subtitle
        FROM apiome.shared_path_request_body_content sprbc
        JOIN apiome.shared_path_request_body sprb ON sprbc.shared_path_request_body_id = sprb.id
        JOIN apiome.version_path vp ON sprb.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            COALESCE(sprbc.inline_schema::text, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(sprbc.examples::text, '') ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('resp:' || spr.id::text) AS hit_id,
          'response' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Response · HTTP ' || spr.status_code) AS title,
          LEFT(COALESCE(NULLIF(TRIM(spr.description), ''), spr.inline_schema::text, spr.data::text, ''), 400) AS snippet,
          ('response') AS subtitle
        FROM apiome.shared_path_response spr
        JOIN apiome.version_path vp ON spr.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            COALESCE(spr.description, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(spr.inline_schema::text, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(spr.data::text, '') ILIKE $1 ESCAPE '\\'
          )

        UNION ALL

        SELECT
          ('respc:' || sprc.id::text) AS hit_id,
          'response' AS hit_type,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          p.slug AS project_slug,
          p.name AS project_name,
          v.version_id AS version_slug,
          v.published_at::text AS published_at,
          ('Response content · ' || sprc.media_type) AS title,
          LEFT(COALESCE(sprc.inline_schema::text, sprc.examples::text, ''), 400) AS snippet,
          ('response body') AS subtitle
        FROM apiome.shared_path_response_content sprc
        JOIN apiome.shared_path_response spr ON sprc.shared_path_response_id = spr.id
        JOIN apiome.version_path vp ON spr.version_path_id = vp.id
        JOIN apiome.versions v ON vp.version_id = v.id
        JOIN apiome.projects p ON v.project_id = p.id
        JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.published = true
          AND v.visibility = 'public'
          AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.deleted_at IS NULL
          AND (
            COALESCE(sprc.inline_schema::text, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(sprc.examples::text, '') ILIKE $1 ESCAPE '\\'
          )
      ) hits
      ORDER BY published_at DESC NULLS LAST, hit_type ASC, title ASC
      LIMIT 150`,
      [pattern]
    );
    return result.rows as PublishedCatalogSearchHit[];
  } catch (err) {
    logError('searchPublishedPublicCatalog', err);
    return [];
  }
}

/**
 * Get tenant details by slug.
 */
export async function getPublicTenantBySlug(tenantSlug: string) {
  try {
    const result = await connectionPool.query(
      `SELECT DISTINCT t.id, t.name, t.slug, t.description, t.created_at
       FROM apiome.tenants t
       JOIN apiome.projects p ON t.id = p.tenant_id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE t.slug = $1
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL`,
      [tenantSlug]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    logError('getPublicTenantBySlug', err);
    return null;
  }
}

/**
 * Get project details by tenant and project slugs.
 */
export async function getPublicProjectBySlug(tenantSlug: string, projectSlug: string) {
  try {
    const result = await connectionPool.query(
      `SELECT DISTINCT p.id, p.name, p.slug, p.description, p.created_at,
              t.name as tenant_name, t.slug as tenant_slug, t.description as tenant_description
       FROM apiome.projects p
       JOIN apiome.tenants t ON p.tenant_id = t.id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE t.slug = $1
         AND p.slug = $2
         AND v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL`,
      [tenantSlug, projectSlug]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    logError('getPublicProjectBySlug', err);
    return null;
  }
}

/**
 * Recently published public versions across all tenants/projects.
 * Used by the discovery home page.
 */
export async function getRecentlyPublishedVersions(limit = 8) {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT v.id, v.version_id, v.description, v.published_at,
              p.name as project_name, p.slug as project_slug, p.description as project_description,
              t.name as tenant_name, t.slug as tenant_slug
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       WHERE v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    logError('getRecentlyPublishedVersions', err);
    return [];
  }
}

/**
 * Most-versioned public projects (a proxy for "active" projects).
 */
export async function getMostVersionedProjects(limit = 8) {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT p.id, p.name, p.slug, p.description,
              t.name as tenant_name, t.slug as tenant_slug,
              COUNT(v.id)::int as version_count,
              MAX(v.published_at) as latest_published_at
       FROM apiome.projects p
       JOIN apiome.tenants t ON p.tenant_id = t.id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       GROUP BY p.id, p.name, p.slug, p.description, t.name, t.slug
       ORDER BY version_count DESC, latest_published_at DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    logError('getMostVersionedProjects', err);
    return [];
  }
}

/**
 * Newest public organizations (those with at least one published public version).
 */
export async function getNewestTenants(limit = 8) {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT DISTINCT t.id, t.name, t.slug, t.description, t.created_at
       FROM apiome.tenants t
       JOIN apiome.projects p ON t.id = p.tenant_id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    logError('getNewestTenants', err);
    return [];
  }
}

/**
 * Aggregate counts for the home hero strip.
 */
export async function getDirectoryStats() {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT
         COUNT(DISTINCT t.id)::int as tenant_count,
         COUNT(DISTINCT p.id)::int as project_count,
         COUNT(DISTINCT v.id)::int as version_count
       FROM apiome.tenants t
       JOIN apiome.projects p ON t.id = p.tenant_id
       JOIN apiome.versions v ON p.id = v.project_id
       WHERE v.published = true
         AND v.visibility = 'public'
         AND t.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL`
    );
    return result.rows[0] ?? { tenant_count: 0, project_count: 0, version_count: 0 };
  } catch (err) {
    logError('getDirectoryStats', err);
    return { tenant_count: 0, project_count: 0, version_count: 0 };
  }
}

// ---------------------------------------------------------------------------------------------------
// Public MCP catalog (V2-MCP-23.6 / 23.7 — MCAT-9.6 / 9.7)
//
// All MCP browse/search reads go through the `apiome.mcp_v_public_endpoints` view (V134), which already
// filters to enabled + published + public-visible endpoints and never exposes the raw endpoint_url.
// Because these helpers only ever touch that view, private endpoints can never surface here.
// ---------------------------------------------------------------------------------------------------

/**
 * The exact tsvector expression the V127 GIN index (`idx_mcp_capability_items_fts`) is built on, so
 * the index backs the public capability search rather than a sequential scan.
 */
const MCP_CAPABILITY_FTS =
  "to_tsvector('english', coalesce(ci.name, '') || ' ' || coalesce(ci.description, ''))";

/** Per-snapshot capability counts, shared by the browse list and grouping query. */
const MCP_CAPABILITY_COUNTS = `
  COUNT(ci.id) FILTER (WHERE ci.item_type = 'tool')::int AS tool_count,
  COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource')::int AS resource_count,
  COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource_template')::int AS resource_template_count,
  COUNT(ci.id) FILTER (WHERE ci.item_type = 'prompt')::int AS prompt_count`;

/**
 * Every published public MCP endpoint, grouped by host (alphabetically) and grade-led within each
 * host group (grade ascending A→F, ungraded last, then score, then name). Each endpoint carries its
 * current snapshot's capability counts. Powers the idle public browse index (MCAT-9.6).
 */
export async function getPublicMcpEndpointsByHost(): Promise<McpPublicHostGroup[]> {
  noStore();
  try {
    const result = await connectionPool.query(
      `SELECT e.id, e.tenant_id, t.slug AS tenant_slug, e.name, e.slug, e.category, e.transport,
              e.description, e.current_version_id, e.host, e.score, e.grade, e.scored_at,
              e.last_discovered_at, e.updated_at,
              ${MCP_CAPABILITY_COUNTS}
       FROM apiome.mcp_v_public_endpoints e
       JOIN apiome.tenants t ON t.id = e.tenant_id AND t.deleted_at IS NULL
       LEFT JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
       GROUP BY e.id, e.tenant_id, t.slug, e.name, e.slug, e.category, e.transport, e.description,
                e.current_version_id, e.host, e.score, e.grade, e.scored_at,
                e.last_discovered_at, e.updated_at
       ORDER BY e.host ASC NULLS LAST, ${mcpSortOrderSql('top_graded')}`
    );

    const groups: McpPublicHostGroup[] = [];
    let current: McpPublicHostGroup | null = null;
    for (const row of result.rows as McpPublicEndpoint[]) {
      const host = row.host ?? 'Unknown host';
      if (!current || current.host !== host) {
        current = { host, endpoints: [] };
        groups.push(current);
      }
      current.endpoints.push(row);
    }
    return groups;
  } catch (err) {
    logError('getPublicMcpEndpointsByHost', err);
    return [];
  }
}

/**
 * The public catalog analytics roll-up (V2-MCP-32.1 / MCAT-18.1) — a reduced, credential-free variant
 * of the private dashboard. Aggregates only over `apiome.mcp_v_public_endpoints`, so it inherently
 * respects published-only + public visibility (the acceptance criterion) and can only ever expose the
 * view's own columns: the endpoint count, the average score, and the category / transport / grade
 * mixes. NULL categories fold into "Uncategorized"; each mix is ordered busiest-first with a stable
 * label tiebreak. An empty catalog returns zeroes and empty mixes (never throws); any query failure
 * logs and returns the same safe empty shape so the page renders its empty state, not a 500.
 */
export async function getPublicCatalogInsight(): Promise<McpPublicCatalogInsight> {
  noStore();
  const empty: McpPublicCatalogInsight = {
    endpoint_count: 0,
    average_score: null,
    category_distribution: [],
    transport_distribution: [],
    grade_distribution: [],
  };
  try {
    // A single round trip: the scalar summary and the three mixes as JSON aggregates, all scoped to
    // the public view so private / unpublished endpoints can never move a tile.
    const result = await connectionPool.query(
      `WITH pub AS (
         SELECT category, transport, grade, score FROM apiome.mcp_v_public_endpoints
       ),
       cats AS (
         SELECT COALESCE(category, 'Uncategorized') AS label, COUNT(*)::int AS count
         FROM pub GROUP BY COALESCE(category, 'Uncategorized')
         ORDER BY count DESC, label ASC
       ),
       transports AS (
         SELECT transport AS label, COUNT(*)::int AS count
         FROM pub GROUP BY transport
         ORDER BY count DESC, label ASC
       ),
       grades AS (
         SELECT grade AS label, COUNT(*)::int AS count
         FROM pub WHERE grade IS NOT NULL GROUP BY grade
         ORDER BY grade ASC
       )
       SELECT
         (SELECT COUNT(*)::int FROM pub) AS endpoint_count,
         (SELECT AVG(score) FROM pub) AS average_score,
         COALESCE((SELECT json_agg(json_build_object('label', label, 'count', count)) FROM cats), '[]') AS category_distribution,
         COALESCE((SELECT json_agg(json_build_object('label', label, 'count', count)) FROM transports), '[]') AS transport_distribution,
         COALESCE((SELECT json_agg(json_build_object('label', label, 'count', count)) FROM grades), '[]') AS grade_distribution`
    );
    const row = result.rows[0];
    if (!row) return empty;
    const avg = row.average_score;
    return {
      endpoint_count: Number(row.endpoint_count) || 0,
      average_score: avg === null || avg === undefined ? null : Math.round(Number(avg) * 10) / 10,
      category_distribution: (row.category_distribution as McpPublicCatalogBucket[]) ?? [],
      transport_distribution: (row.transport_distribution as McpPublicCatalogBucket[]) ?? [],
      grade_distribution: (row.grade_distribution as McpPublicCatalogBucket[]) ?? [],
    };
  } catch (err) {
    logError('getPublicCatalogInsight', err);
    return empty;
  }
}

/**
 * A single published public endpoint addressed by tenant + endpoint slug, with its current
 * snapshot's capability items (tools/resources/resource templates/prompts) in declared order.
 * Returns null when no such public endpoint exists (→ notFound). Powers endpoint detail (MCAT-9.6).
 */
export async function getPublicMcpEndpointDetail(
  tenantSlug: string,
  endpointSlug: string
): Promise<McpPublicEndpointDetail | null> {
  noStore();
  try {
    const endpointResult = await connectionPool.query(
      `SELECT e.id, e.tenant_id, t.slug AS tenant_slug, e.name, e.slug, e.category, e.transport,
              e.description, e.current_version_id, e.host, e.score, e.grade, e.scored_at,
              e.last_discovered_at, e.updated_at,
              ${MCP_CAPABILITY_COUNTS}
       FROM apiome.mcp_v_public_endpoints e
       JOIN apiome.tenants t ON t.id = e.tenant_id
       LEFT JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
       WHERE t.slug = $1 AND e.slug = $2 AND t.deleted_at IS NULL
       GROUP BY e.id, e.tenant_id, t.slug, e.name, e.slug, e.category, e.transport, e.description,
                e.current_version_id, e.host, e.score, e.grade, e.scored_at,
                e.last_discovered_at, e.updated_at`,
      [tenantSlug, endpointSlug]
    );
    if (endpointResult.rows.length === 0) return null;
    const endpoint = endpointResult.rows[0] as McpPublicEndpoint;

    const itemsResult = endpoint.current_version_id
      ? await connectionPool.query(
          `SELECT ci.id, ci.item_type, ci.name, ci.title, ci.description,
                  ci.uri, ci.uri_template, ci.ordinal
           FROM apiome.mcp_capability_items ci
           WHERE ci.version_id = $1
           ORDER BY ci.item_type ASC, ci.ordinal ASC, ci.name ASC`,
          [endpoint.current_version_id]
        )
      : { rows: [] as McpCapabilityItem[] };

    return { endpoint, items: itemsResult.rows as McpCapabilityItem[] };
  } catch (err) {
    logError('getPublicMcpEndpointDetail', err);
    return null;
  }
}

/**
 * One published curated collection for a tenant, listing only endpoints that pass the public
 * visibility gate (`mcp_v_public_endpoints`). Private or unpublished endpoints in the collection are
 * omitted rather than leaking into anonymous browse (MCAT-22.4).
 */
export async function getPublicMcpCollection(
  tenantSlug: string,
  collectionSlug: string
): Promise<McpPublicCollection | null> {
  noStore();
  try {
    const collectionResult = await connectionPool.query(
      `SELECT c.id, c.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
              c.name, c.slug, c.description
       FROM apiome.mcp_collections c
       JOIN apiome.tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
       WHERE t.slug = $1 AND c.slug = $2 AND c.is_published IS TRUE
       LIMIT 1`,
      [tenantSlug, collectionSlug]
    );
    if (collectionResult.rows.length === 0) return null;
    const collection = collectionResult.rows[0] as {
      id: string;
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      name: string;
      slug: string;
      description: string | null;
    };

    const endpointsResult = await connectionPool.query(
      `SELECT e.id, e.tenant_id, t.slug AS tenant_slug, e.name, e.slug, e.category, e.transport,
              e.description, e.current_version_id, e.host, e.score, e.grade, e.scored_at,
              e.last_discovered_at, e.updated_at,
              ${MCP_CAPABILITY_COUNTS}
       FROM apiome.mcp_collection_members m
       JOIN apiome.mcp_collections c ON c.id = m.collection_id
       JOIN apiome.tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
       JOIN apiome.mcp_v_public_endpoints e ON e.id = m.endpoint_id AND e.tenant_id = m.tenant_id
       LEFT JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
       WHERE c.id = $1::uuid
       GROUP BY e.id, e.tenant_id, t.slug, e.name, e.slug, e.category, e.transport, e.description,
                e.current_version_id, e.host, e.score, e.grade, e.scored_at,
                e.last_discovered_at, e.updated_at, m.position, m.added_at
       ORDER BY m.position ASC, m.added_at ASC, e.name ASC`,
      [collection.id]
    );

    return {
      ...collection,
      endpoints: endpointsResult.rows as McpPublicEndpoint[],
    };
  } catch (err) {
    logError('getPublicMcpCollection', err);
    return null;
  }
}

/**
 * Full-text capability search over the public MCP catalog. Reuses the V127 tsvector GIN index
 * (via {@link MCP_CAPABILITY_FTS}) and `websearch_to_tsquery`, which tolerates messy user input.
 *
 * Ordering (MCAT-9.7): relevance-first while a query is present, grade-led when idle, with the
 * caller able to override the mode. The mode is resolved/validated upstream and passed in; an empty
 * query short-circuits to no results (the browse index handles idle browsing).
 */
export async function searchPublicMcpCatalog(
  query: string,
  sortMode: McpSortMode
): Promise<McpPublicSearchHit[]> {
  noStore();
  const q = query.trim();
  if (!q) return [];
  try {
    const result = await connectionPool.query(
      `SELECT e.id AS endpoint_id, e.tenant_id, t.slug AS tenant_slug,
              e.name AS endpoint_name, e.slug AS endpoint_slug,
              e.host, e.category, e.transport, e.score, e.grade,
              ci.item_type, ci.id AS item_id, ci.name AS item_name, ci.title AS item_title,
              ci.description,
              ts_rank(${MCP_CAPABILITY_FTS}, websearch_to_tsquery('english', $1)) AS relevance
       FROM apiome.mcp_v_public_endpoints e
       JOIN apiome.tenants t ON t.id = e.tenant_id AND t.deleted_at IS NULL
       JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
       WHERE ${MCP_CAPABILITY_FTS} @@ websearch_to_tsquery('english', $1)
       ORDER BY ${mcpSortOrderSql(sortMode, 'endpoint_name')}, ci.ordinal ASC
       LIMIT 200`,
      [q]
    );
    return result.rows as McpPublicSearchHit[];
  } catch (err) {
    logError('searchPublicMcpCatalog', err);
    return [];
  }
}
